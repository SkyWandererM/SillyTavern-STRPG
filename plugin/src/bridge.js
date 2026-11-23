import { getCampaignVariable } from './conditions.js';
import { TRACKER_WHITELIST } from './integrations.js';
import { getCampaignPackage, getEntityView, getPlayer } from './stats.js';
import {
    asJson, clamp, hashObject, insertEvent, nowIso, parseJson, uuid, withTransaction,
} from './util.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Chat <-> RPG bridge (M1).
 *
 * Direction rules:
 * - STRPG stays authoritative for every number. Tracker/Memory Books input becomes
 *   a candidate first, and only an explicit approve writes state.
 * - The mirror is a read-only projection of STRPG state for external extensions.
 */

export const RELATION_MIN = -100;
export const RELATION_MAX = 100;
export const RELATION_MAX_STEP = 2;
export const CANDIDATE_KINDS = ['relation', 'narrative', 'flag', 'trade', 'recruit', 'tuition', 'recovery'];
const SOCIAL_KINDS = new Set(['trade', 'recruit', 'tuition', 'recovery']);

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

function npcIndex(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const byKey = new Map();
    const byName = new Map();
    for (const npc of pkg.npcs ?? []) {
        byKey.set(npc.key, npc);
        if (npc.name) byName.set(String(npc.name).toLowerCase(), npc);
    }
    return { pkg, byKey, byName };
}

function relationOf(db, campaignId, npcKey) {
    const value = getCampaignVariable(db, campaignId, `npc:${npcKey}:relation`);
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function setCampaignVariable(db, campaignId, key, value) {
    db.prepare(`
        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(campaignId, key, JSON.stringify(value ?? null), nowIso());
}

function candidateView(row) {
    if (!row) return null;
    return {
        id: row.id,
        campaignId: row.campaign_id,
        kind: row.kind,
        source: row.source,
        payload: parseJson(row.payload_json, {}),
        evidence: parseJson(row.evidence_json, {}),
        confidence: row.confidence == null ? null : Number(row.confidence),
        status: row.status,
        note: row.note,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
        appliedAt: row.applied_at,
    };
}

/**
 * Read-only projection of STRPG state for RPG Tracker / other extensions.
 */
export function trackerMirror(db, campaignId) {
    const campaign = campaignRow(db, campaignId);
    const player = getEntityView(db, getPlayer(db, campaignId).id);
    const location = campaign.current_location_id
        ? db.prepare('SELECT * FROM locations WHERE id = ?').get(campaign.current_location_id)
        : null;
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const storyState = parseJson(campaign.game_state_json, {}).story ?? {};
    const quests = db.prepare('SELECT quest_key, status FROM quest_instances WHERE campaign_id = ?').all(campaignId);
    const relations = db.prepare(`
        SELECT var_key, value_json FROM campaign_variables
        WHERE campaign_id = ? AND var_key LIKE 'npc:%:relation'
    `).all(campaignId).map((row) => {
        const npcKey = row.var_key.slice('npc:'.length, -':relation'.length);
        return { npcKey, relation: Number(parseJson(row.value_json, 0)) || 0 };
    });
    const narrative = db.prepare('SELECT state_json FROM narrative_state WHERE campaign_id = ?').get(campaignId);
    const recent = db.prepare('SELECT type, payload_json, created_at FROM game_events WHERE campaign_id = ? ORDER BY seq DESC LIMIT 8')
        .all(campaignId)
        .map((row) => {
            const payload = parseJson(row.payload_json, {});
            return {
                type: row.type,
                at: row.created_at,
                summary: typeof payload.summary === 'string' ? payload.summary : undefined,
            };
        })
        .reverse();

    return {
        provider: 'rpg-tracker',
        mode: 'read-only-mirror',
        campaignId,
        generatedAt: nowIso(),
        world: {
            name: world?.name ?? campaign.name,
            location: location?.name ?? null,
            locationKey: location?.location_key ?? null,
            storyNode: storyState.currentNodeKey ?? null,
            ending: storyState.ending ?? null,
        },
        characters: [{
            name: player.name,
            role: 'player',
            level: Number(player.level ?? 1),
            hp: Number(player.hp ?? 0),
            maxHp: Number(player.stats?.maxHp ?? 0),
            mp: Number(player.mp ?? 0),
            maxMp: Number(player.stats?.maxMp ?? 0),
            gold: Number(player.gold ?? 0),
        }],
        quests: quests.map((quest) => ({ key: quest.quest_key, status: quest.status })),
        narrative: {
            relations,
            trackerState: narrative ? parseJson(narrative.state_json, {}) : {},
            recentEvents: recent,
        },
        whitelist: TRACKER_WHITELIST,
        authority: 'STRPG Core owns HP, MP, EXP, gold, items, skills, quests and combat.',
    };
}

function dedupeHash(kind, payload) {
    return hashObject({ kind, payload });
}

/**
 * Queue a candidate for human review. PENDING duplicates are returned instead of inserted twice.
 */
export function queueCandidate(db, campaignId, input = {}) {
    campaignRow(db, campaignId);
    const kind = String(input.kind ?? '');
    if (!CANDIDATE_KINDS.includes(kind)) {
        throw new ValidationError(`Unknown candidate kind '${kind}'`, { allowed: CANDIDATE_KINDS });
    }
    const payload = input.payload ?? {};
    const hash = dedupeHash(kind, payload);
    const existing = db.prepare(
        "SELECT * FROM bridge_candidates WHERE campaign_id = ? AND dedupe_hash = ? AND status = 'PENDING'",
    ).get(campaignId, hash);
    if (existing) return { candidate: candidateView(existing), duplicate: true };

    const id = uuid('cand_');
    db.prepare(`
        INSERT INTO bridge_candidates (id, campaign_id, kind, source, payload_json, evidence_json, confidence, dedupe_hash, status, created_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(
        id,
        campaignId,
        kind,
        String(input.source ?? 'manual').slice(0, 40),
        asJson(payload),
        asJson(input.evidence ?? {}),
        input.confidence == null ? null : clamp(Number(input.confidence), 0, 1),
        hash,
        nowIso(),
        String(input.note ?? '').slice(0, 500),
    );
    return { candidate: candidateView(db.prepare('SELECT * FROM bridge_candidates WHERE id = ?').get(id)), duplicate: false };
}

/**
 * LLM/UI relation proposal. Values are clamped and single-step limited here, not trusted.
 */
export function proposeRelation(db, campaignId, input = {}) {
    const { byKey, byName } = npcIndex(db, campaignId);
    const npcKey = String(input.npcKey ?? '').trim();
    const npc = byKey.get(npcKey) ?? byName.get(npcKey.toLowerCase());
    if (!npc) throw new NotFoundError(`Unknown NPC '${npcKey}'`, 'NPC_NOT_FOUND');
    const delta = Number(input.delta);
    if (!Number.isFinite(delta) || delta === 0) throw new ValidationError('delta must be a non-zero number');
    if (Math.abs(delta) > RELATION_MAX_STEP) {
        throw new ValidationError(`A single relation proposal cannot change more than ${RELATION_MAX_STEP} points`, {
            maxStep: RELATION_MAX_STEP,
        });
    }
    const reason = String(input.reason ?? '').trim();
    if (!reason) throw new ValidationError('reason is required');
    if (reason.length > 500) throw new ValidationError('reason is too long');
    const evidence = input.evidence ?? {};
    if (JSON.stringify(evidence).length > 4000) throw new ValidationError('evidence is too large');

    const before = relationOf(db, campaignId, npc.key);
    const after = clamp(before + Math.round(delta * 10) / 10, RELATION_MIN, RELATION_MAX);
    return queueCandidate(db, campaignId, {
        kind: 'relation',
        source: input.source ?? 'llm',
        payload: { npcKey: npc.key, npcName: npc.name, delta: Math.round(delta * 10) / 10, before, after, reason },
        evidence,
        confidence: input.confidence,
        note: input.note,
    });
}

/**
 * Accept a RPG Tracker narrative payload and turn it into review candidates.
 * @param {{characters?: Array<object>, world?: object}} payload
 */
export function pullTrackerNarrative(db, campaignId, payload = {}) {
    campaignRow(db, campaignId);
    const { byName } = npcIndex(db, campaignId);
    const queued = [];
    const duplicates = [];
    const skipped = [];

    const whitelistFields = (source) => {
        const fields = {};
        for (const key of TRACKER_WHITELIST) {
            if (source?.[key] == null || String(source[key]).trim() === '') continue;
            fields[key] = typeof source[key] === 'string' ? source[key].slice(0, 4000) : source[key];
        }
        return fields;
    };

    const handle = (npc, fields, evidence) => {
        if (!Object.keys(fields).length) {
            skipped.push({ reason: 'no whitelisted fields', evidence });
            return;
        }
        const result = queueCandidate(db, campaignId, {
            kind: 'narrative',
            source: 'rpg-tracker',
            payload: { npcKey: npc?.key ?? null, fields },
            evidence,
        });
        (result.duplicate ? duplicates : queued).push(result.candidate);
    };

    if (Array.isArray(payload.characters)) {
        for (const character of payload.characters) {
            const name = String(character?.name ?? '').trim();
            const npc = byName.get(name.toLowerCase());
            const fields = whitelistFields(character);
            if (!npc) {
                skipped.push({ reason: 'character is not an NPC of this campaign', name });
                continue;
            }
            handle(npc, fields, { characterName: name, npcKey: npc.key, source: 'rpg-tracker' });
        }
    }
    if (payload.world && typeof payload.world === 'object') {
        handle(null, whitelistFields(payload.world), { scope: 'world', source: 'rpg-tracker' });
    }

    db.prepare(`
        INSERT INTO tracker_sync_log (id, campaign_id, provider, direction, payload_json, status, message, created_at)
        VALUES (?, ?, 'rpg-tracker', 'inbound', ?, 'queued', ?, ?)
    `).run(
        uuid('sync_'),
        campaignId,
        asJson(payload).slice(0, 20000),
        `queued=${queued.length} duplicates=${duplicates.length} skipped=${skipped.length}`,
        nowIso(),
    );

    return { queued: queued.length, duplicates: duplicates.length, skipped, candidates: queued };
}

export function listCandidates(db, campaignId, options = {}) {
    campaignRow(db, campaignId);
    const status = options.status ? String(options.status).toUpperCase() : null;
    const limit = clamp(Number(options.limit ?? 50), 1, 200);
    const rows = status
        ? db.prepare('SELECT * FROM bridge_candidates WHERE campaign_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(campaignId, status, limit)
        : db.prepare('SELECT * FROM bridge_candidates WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?').all(campaignId, limit);
    return {
        status: status ?? 'ALL',
        candidates: rows.map(candidateView),
        counts: candidateCounts(db, campaignId),
    };
}

function candidateCounts(db, campaignId) {
    const rows = db.prepare('SELECT status, COUNT(*) AS count FROM bridge_candidates WHERE campaign_id = ? GROUP BY status').all(campaignId);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function applyRelation(db, campaignId, candidate) {
    const { byKey } = npcIndex(db, campaignId);
    const npc = byKey.get(candidate.payload.npcKey);
    if (!npc) throw new NotFoundError(`Unknown NPC '${candidate.payload.npcKey}'`, 'NPC_NOT_FOUND');
    const before = relationOf(db, campaignId, npc.key);
    const delta = clamp(Number(candidate.payload.delta ?? 0), -RELATION_MAX_STEP, RELATION_MAX_STEP);
    const after = clamp(before + delta, RELATION_MIN, RELATION_MAX);
    setCampaignVariable(db, campaignId, `npc:${npc.key}:relation`, after);
    if (candidate.payload.reason) {
        setCampaignVariable(db, campaignId, `npc:${npc.key}:lastInteraction`, String(candidate.payload.reason).slice(0, 500));
    }
    insertEvent(db, campaignId, 'npc.relation', {
        npcKey: npc.key,
        npcName: npc.name,
        before,
        after,
        delta,
        reason: candidate.payload.reason ?? '',
        source: candidate.source,
        candidateId: candidate.id,
    }, `bridge-relation:${candidate.id}`);
    return { target: 'npc.relation', npcKey: npc.key, before, after };
}

function applyNarrative(db, campaignId, candidate) {
    const { byKey } = npcIndex(db, campaignId);
    const npcKey = candidate.payload.npcKey ?? null;
    if (npcKey && !byKey.has(npcKey)) throw new NotFoundError(`Unknown NPC '${npcKey}'`, 'NPC_NOT_FOUND');
    const row = db.prepare('SELECT state_json FROM narrative_state WHERE campaign_id = ?').get(campaignId);
    const before = row ? parseJson(row.state_json, {}) : {};
    const fields = candidate.payload.fields ?? {};
    const next = { ...before, updatedAt: nowIso() };
    if (npcKey) {
        next.byNpc = {
            ...(before.byNpc ?? {}),
            [npcKey]: { ...(before.byNpc?.[npcKey] ?? {}), ...fields, updatedAt: nowIso() },
        };
        if (fields.lastInteraction) {
            setCampaignVariable(db, campaignId, `npc:${npcKey}:lastInteraction`, String(fields.lastInteraction).slice(0, 500));
        }
    } else {
        next.world = { ...(before.world ?? {}), ...fields, updatedAt: nowIso() };
    }
    db.prepare(`
        INSERT INTO narrative_state (campaign_id, provider, state_json, updated_at) VALUES (?, 'rpg-tracker', ?, ?)
        ON CONFLICT(campaign_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(campaignId, asJson(next), nowIso());
    insertEvent(db, campaignId, 'narrative.updated', { npcKey, fields, candidateId: candidate.id }, `bridge-narrative:${candidate.id}`);
    return { target: 'narrative_state', npcKey, keys: Object.keys(fields) };
}

function applyFlag(db, campaignId, candidate) {
    const flag = String(candidate.payload.flag ?? '').trim();
    if (!flag) throw new ValidationError('flag is required');
    setCampaignVariable(db, campaignId, `flag:${flag}`, true);
    const campaign = campaignRow(db, campaignId);
    const state = parseJson(campaign.game_state_json, {});
    state.flags = [...new Set([...(state.flags ?? []), flag])];
    db.prepare('UPDATE campaigns SET game_state_json = ?, updated_at = ? WHERE id = ?').run(asJson(state), nowIso(), campaignId);
    insertEvent(db, campaignId, 'flag.set', { flag, candidateId: candidate.id }, `bridge-flag:${candidate.id}`);
    return { target: 'flag', flag };
}

/**
 * Approve one candidate and apply it inside a transaction. This is the only write path
 * for external narrative input.
 */
export async function approveCandidate(db, campaignId, candidateId, options = {}) {
    campaignRow(db, campaignId);
    const row = db.prepare('SELECT * FROM bridge_candidates WHERE id = ? AND campaign_id = ?').get(candidateId, campaignId);
    if (!row) throw new NotFoundError(`Candidate '${candidateId}' not found`, 'CANDIDATE_NOT_FOUND');
    if (row.status !== 'PENDING') throw new ConflictError(`Candidate is already ${row.status}`, 'CANDIDATE_NOT_PENDING');
    const candidate = candidateView(row);
    // Social handlers live in social.js; load them lazily so the bridge module has no cycle.
    const social = SOCIAL_KINDS.has(candidate.kind) ? await import('./social.js') : null;

    const applied = withTransaction(db, () => {
        let result;
        if (candidate.kind === 'relation') result = applyRelation(db, campaignId, candidate);
        else if (candidate.kind === 'narrative') result = applyNarrative(db, campaignId, candidate);
        else if (candidate.kind === 'flag') result = applyFlag(db, campaignId, candidate);
        else if (social) result = social.applySocialCandidate(db, campaignId, candidate);
        else throw new ValidationError(`Unsupported candidate kind '${candidate.kind}'`);

        db.prepare("UPDATE bridge_candidates SET status = 'APPLIED', reviewed_at = ?, applied_at = ? WHERE id = ?")
            .run(nowIso(), nowIso(), candidateId);
        db.prepare(`
            INSERT INTO bridge_apply_log (id, campaign_id, candidate_id, target, before_json, after_json, applied_by, applied_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            uuid('apply_'),
            campaignId,
            candidateId,
            result.target,
            asJson({ before: candidate.payload.before ?? null }),
            asJson({ after: result }),
            String(options.appliedBy ?? 'server').slice(0, 80),
            nowIso(),
        );
        return result;
    });

    return {
        candidate: candidateView(db.prepare('SELECT * FROM bridge_candidates WHERE id = ?').get(candidateId)),
        applied,
        authority: 'STRPG Core',
    };
}

export function rejectCandidate(db, campaignId, candidateId, options = {}) {
    campaignRow(db, campaignId);
    const row = db.prepare('SELECT * FROM bridge_candidates WHERE id = ? AND campaign_id = ?').get(candidateId, campaignId);
    if (!row) throw new NotFoundError(`Candidate '${candidateId}' not found`, 'CANDIDATE_NOT_FOUND');
    if (row.status !== 'PENDING') throw new ConflictError(`Candidate is already ${row.status}`, 'CANDIDATE_NOT_PENDING');
    db.prepare("UPDATE bridge_candidates SET status = 'REJECTED', reviewed_at = ?, note = ? WHERE id = ?")
        .run(nowIso(), String(options.note ?? '').slice(0, 500), candidateId);
    return { candidate: candidateView(db.prepare('SELECT * FROM bridge_candidates WHERE id = ?').get(candidateId)) };
}

export function bridgeStatus(db, campaignId) {
    campaignRow(db, campaignId);
    const lastApply = db.prepare('SELECT * FROM bridge_apply_log WHERE campaign_id = ? ORDER BY applied_at DESC LIMIT 1').get(campaignId);
    return {
        counts: candidateCounts(db, campaignId),
        lastApply: lastApply
            ? { target: lastApply.target, appliedAt: lastApply.applied_at, candidateId: lastApply.candidate_id }
            : null,
        relationBounds: { min: RELATION_MIN, max: RELATION_MAX, maxStep: RELATION_MAX_STEP },
        kinds: CANDIDATE_KINDS,
    };
}
