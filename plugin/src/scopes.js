import { queueCandidate, proposeRelation } from './bridge.js';
import { getCampaignPackage } from './stats.js';
import { insertEvent, nowIso, parseJson, uuid } from './util.js';
import { NotFoundError, ValidationError } from './errors.js';
import { TRACKER_WHITELIST } from './integrations.js';

/**
 * M3 memory scopes.
 *
 * A scope defines "where to look" (chat window + filters) and "what to extract"
 * (narrative fields / relationship deltas / flags / dialogue lines). The server never
 * reads the chat itself: the extension collects the window, asks the model with a
 * server-built prompt, and posts the structured items back here. Items always become
 * review candidates — and a manual path (hand-written items or a single note) uses the
 * same endpoint, so it works without any model at all.
 */

export const SCOPE_KINDS = ['narrative', 'relation', 'flag', 'performance'];

const DEFAULT_CONFIG = {
    source: { type: 'chat', lastN: 12 },
    filter: { speakers: [], requiresKey: [] },
    extract: { kind: 'narrative' },
    apply: { targets: ['narrative_state', 'lorebook'] },
    review: 'required',
    schedule: 'manual',
};

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

function scopeView(row) {
    if (!row) return null;
    return {
        id: row.id,
        key: row.scope_key,
        name: row.name,
        config: parseJson(row.config_json, {}),
        enabled: Boolean(row.enabled),
        lastRunAt: row.last_run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function npcKeys(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    return {
        byKey: new Map((pkg.npcs ?? []).map((npc) => [npc.key, npc])),
        names: (pkg.npcs ?? []).map((npc) => `${npc.key} (${npc.name})`),
    };
}

function normalizeConfig(db, campaignId, config = {}) {
    const kind = String(config?.extract?.kind ?? DEFAULT_CONFIG.extract.kind);
    if (!SCOPE_KINDS.includes(kind)) throw new ValidationError(`Unknown scope kind '${kind}'`, { allowed: SCOPE_KINDS });
    const lastN = Math.max(1, Math.min(200, Math.round(Number(config?.source?.lastN ?? DEFAULT_CONFIG.source.lastN))));
    const speakers = Array.isArray(config?.filter?.speakers)
        ? config.filter.speakers.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, 10)
        : [];
    const requiresKey = Array.isArray(config?.filter?.requiresKey)
        ? config.filter.requiresKey.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, 10)
        : [];
    return {
        source: { type: 'chat', lastN },
        filter: { speakers, requiresKey },
        extract: { kind },
        apply: { targets: Array.isArray(config?.apply?.targets) ? config.apply.targets.map(String).slice(0, 6) : ['narrative_state', 'lorebook'] },
        review: 'required',
        schedule: /^every_n_messages:\d{1,3}$/.test(String(config?.schedule ?? '')) ? String(config.schedule) : 'manual',
    };
}

export function listScopes(db, campaignId) {
    campaignRow(db, campaignId);
    const rows = db.prepare('SELECT * FROM memory_scopes WHERE campaign_id = ? ORDER BY created_at').all(campaignId);
    return { scopes: rows.map(scopeView), kinds: SCOPE_KINDS };
}

export function getScope(db, campaignId, scopeKey) {
    campaignRow(db, campaignId);
    const row = db.prepare('SELECT * FROM memory_scopes WHERE campaign_id = ? AND scope_key = ?').get(campaignId, scopeKey);
    if (!row) throw new NotFoundError(`Scope '${scopeKey}' not found`, 'SCOPE_NOT_FOUND');
    return row;
}

export function upsertScope(db, campaignId, input = {}) {
    campaignRow(db, campaignId);
    const key = String(input.key ?? input.scopeKey ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(key)) {
        throw new ValidationError('Scope key must use ASCII letters, digits, dot, colon, underscore or hyphen');
    }
    const name = String(input.name ?? key).slice(0, 200);
    const config = normalizeConfig(db, campaignId, input.config ?? {});
    const enabled = input.enabled === false ? 0 : 1;
    const now = nowIso();
    const existing = db.prepare('SELECT id FROM memory_scopes WHERE campaign_id = ? AND scope_key = ?').get(campaignId, key);
    if (existing) {
        db.prepare('UPDATE memory_scopes SET name = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?')
            .run(name, JSON.stringify(config), enabled, now, existing.id);
    } else {
        db.prepare(`
            INSERT INTO memory_scopes (id, campaign_id, scope_key, name, config_json, enabled, last_run_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(uuid('scope_'), campaignId, key, name, JSON.stringify(config), enabled, now, now);
    }
    return scopeView(getScope(db, campaignId, key));
}

export function deleteScope(db, campaignId, scopeKey) {
    campaignRow(db, campaignId);
    const result = db.prepare('DELETE FROM memory_scopes WHERE campaign_id = ? AND scope_key = ?').run(campaignId, scopeKey);
    if (!result.changes) throw new NotFoundError(`Scope '${scopeKey}' not found`, 'SCOPE_NOT_FOUND');
    return { deleted: scopeKey };
}

export function ensureStarterScopes(db, campaignId) {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM memory_scopes WHERE campaign_id = ?').get(campaignId).count;
    if (existing) return listScopes(db, campaignId);
    upsertScope(db, campaignId, {
        key: 'npc_state', name: 'NPC state after this scene', config: { extract: { kind: 'narrative' }, source: { type: 'chat', lastN: 12 } },
    });
    upsertScope(db, campaignId, {
        key: 'relationship_changes', name: 'Relationship changes', config: { extract: { kind: 'relation' }, source: { type: 'chat', lastN: 8 } },
    });
    return listScopes(db, campaignId);
}

function shapeFor(kind) {
    if (kind === 'relation') return '{"npcKey":"npc_key","delta":1,"reason":"short evidence from the messages"}';
    if (kind === 'flag') return '{"flag":"short_flag_name"}';
    if (kind === 'performance') return '{"npcKey":"optional_npc_key","npcName":"optional display name","text":"the line(s) to perform"}';
    return '{"npcKey":"optional_npc_key","fields":{"mood":"...","attitude":"...","trust":number,"summary":"..."}}';
}

/**
 * Build the extraction prompt for a chat window. The model must answer with JSON only.
 */
export function scopePrompt(db, campaignId, scopeKey, input = {}) {
    const scope = scopeView(getScope(db, campaignId, scopeKey));
    const kind = scope.config?.extract?.kind ?? 'narrative';
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const limit = scope.config?.source?.lastN ?? 12;
    const window = messages.slice(-limit)
        .map((message) => ({ speaker: String(message.speaker ?? message.name ?? 'Unknown').slice(0, 80), text: String(message.text ?? message.mes ?? '').slice(0, 1200) }))
        .filter((message) => message.text);
    const requiresKey = scope.config?.filter?.requiresKey ?? [];
    if (requiresKey.length) {
        const haystack = window.map((message) => message.text).join('\n').toLowerCase();
        if (!requiresKey.some((key) => haystack.includes(String(key).toLowerCase()))) {
            return { scope, skipped: true, reason: `none of the required keywords appeared: ${requiresKey.join(', ')}`, prompt: null, messageCount: window.length };
        }
    }
    const { names } = npcKeys(db, campaignId);
    const transcript = window.map((message) => `${message.speaker}: ${message.text}`).join('\n').slice(0, 12000);
    const prompt = [
        'You extract structured RPG memory from a roleplay transcript.',
        `Scope: ${scope.name} (${kind}).`,
        `Known NPC keys: ${names.join(', ') || 'none'}. Use only these keys; use null when no NPC fits.`,
        `Return JSON only: {"items":[${shapeFor(kind)}]}.`,
        kind === 'narrative'
            ? `Allowed field keys: ${TRACKER_WHITELIST.join(', ')}. Keep summary under 600 characters. Omit fields you cannot support.`
            : 'Every item must be supported by the transcript. If nothing qualifies, return {"items":[]}.',
        'Never invent events, numbers, items or quests. Do not write prose outside the JSON.',
        '',
        'TRANSCRIPT:',
        transcript || '(empty)',
    ].join('\n');
    return { scope, skipped: false, prompt, messageCount: window.length, transcript };
}

function ingestNarrative(db, campaignId, item, evidence) {
    const fields = {};
    for (const key of TRACKER_WHITELIST) {
        const value = item?.fields?.[key];
        if (value == null || String(value).trim() === '') continue;
        fields[key] = typeof value === 'string' ? value.slice(0, 4000) : value;
    }
    if (!Object.keys(fields).length) return { skipped: 'no whitelisted fields' };
    const npcKey = item?.npcKey ? String(item.npcKey) : null;
    if (npcKey && !npcKeys(db, campaignId).byKey.has(npcKey)) return { skipped: `unknown NPC '${npcKey}'` };
    return queueCandidate(db, campaignId, { kind: 'narrative', source: 'scope', payload: { npcKey, fields }, evidence, scopeKey: evidence.scopeKey });
}

function ingestItem(db, campaignId, kind, item, evidence) {
    if (kind === 'narrative') return ingestNarrative(db, campaignId, item, evidence);
    if (kind === 'relation') {
        if (!item?.npcKey) return { skipped: 'relation item needs npcKey' };
        return proposeRelation(db, campaignId, {
            npcKey: item.npcKey, delta: item.delta, reason: item.reason ?? 'scope extraction', evidence, source: 'scope', scopeKey: evidence.scopeKey,
        });
    }
    if (kind === 'flag') {
        const flag = String(item?.flag ?? '').trim();
        if (!flag) return { skipped: 'flag item needs flag' };
        return queueCandidate(db, campaignId, { kind: 'flag', source: 'scope', payload: { flag }, evidence, scopeKey: evidence.scopeKey });
    }
    if (kind === 'performance') {
        const text = String(item?.text ?? '').trim();
        if (!text) return { skipped: 'performance item needs text' };
        return queueCandidate(db, campaignId, {
            kind: 'performance', source: 'scope',
            payload: {
                npcKey: item.npcKey ? String(item.npcKey) : null,
                npcName: item.npcName ? String(item.npcName) : null,
                text: text.slice(0, 4000),
                lines: Array.isArray(item.lines) ? item.lines.map(String).slice(0, 12) : [],
            },
            evidence, scopeKey: evidence.scopeKey,
        });
    }
    return { skipped: `unsupported kind '${kind}'` };
}

/**
 * Ingest extracted items (or a single manual note) into the review queue.
 * This is the manual fallback path: `{note: "..."}` works without any model.
 */
export function ingestScope(db, campaignId, scopeKey, input = {}) {
    const scope = scopeView(getScope(db, campaignId, scopeKey));
    const kind = scope.config?.extract?.kind ?? 'narrative';
    const evidence = {
        scopeKey,
        source: String(input.source ?? 'manual').slice(0, 40),
        messageCount: Number(input.messageCount ?? 0),
        ...(input.evidence && typeof input.evidence === 'object' ? input.evidence : {}),
    };
    let items = Array.isArray(input.items) ? input.items : [];
    if (!items.length && input.note) {
        if (kind !== 'narrative') throw new ValidationError('A manual note is only valid for narrative scopes; pass structured items instead');
        items = [{ fields: { summary: String(input.note).slice(0, 2000) } }];
    }
    if (!items.length) throw new ValidationError('No items to ingest. Pass `items` or a `note`.');
    if (items.length > 20) throw new ValidationError('At most 20 items per ingest');

    const queued = [];
    const duplicates = [];
    const skipped = [];
    for (const item of items) {
        try {
            const result = ingestItem(db, campaignId, kind, item, evidence);
            if (result?.candidate) (result.duplicate ? duplicates : queued).push(result.candidate);
            else if (result?.skipped) skipped.push({ item, reason: result.skipped });
        } catch (error) {
            skipped.push({ item, reason: error.message, code: error.code ?? null });
        }
    }
    const now = nowIso();
    db.prepare('UPDATE memory_scopes SET last_run_at = ?, updated_at = ? WHERE campaign_id = ? AND scope_key = ?')
        .run(now, now, campaignId, scopeKey);
    insertEvent(db, campaignId, 'scope.ingested', {
        scopeKey, kind, queued: queued.length, duplicates: duplicates.length, skipped: skipped.length, source: evidence.source,
    });
    return {
        scopeKey,
        kind,
        queued: queued.length,
        duplicates: duplicates.length,
        skipped,
        candidates: queued,
        lastRunAt: now,
        note: 'Items are in the review queue; approve them in Integrations -> State & Memory Bridge.',
    };
}

/**
 * Accept a raw model answer (JSON, possibly wrapped in prose/fences) and ingest it.
 */
export function ingestScopeRaw(db, campaignId, scopeKey, input = {}) {
    const raw = String(input.raw ?? '').trim();
    if (!raw) throw new ValidationError('raw answer is empty');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new ValidationError('The answer contains no JSON object');
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
        throw new ValidationError(`The answer is not valid JSON: ${error.message}`);
    }
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    return ingestScope(db, campaignId, scopeKey, { ...input, items });
}
