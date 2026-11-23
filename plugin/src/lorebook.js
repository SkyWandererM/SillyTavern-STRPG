import { getCampaignVariable } from './conditions.js';
import { getCampaignPackage, getEntityView, getPlayer } from './stats.js';
import { nowIso, parseJson } from './util.js';

/**
 * Incremental world book builder for the Chat <-> RPG bridge.
 *
 * Only entries owned by STRPG are ever replaced. Every owned entry carries a
 * stable logical id in its comment (`[STRPG] npc:aevial — Aevial`), so pushes
 * can upsert and prune without touching entries a user or another extension
 * wrote into the same book.
 */

export const OWNED_PREFIX = '[STRPG]';
export const BOOK_PREFIX = 'STRPG - ';
const UID_BASE = 100000;
const UID_SPAN = 800000;

function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export function bookNameFor(campaignName) {
    return `${BOOK_PREFIX}${campaignName}`;
}

function makeEntry({ id, name, keys, content, order = 100, sticky = 0, cooldown = 0, constant = false, position = 0 }) {
    return {
        id,
        name,
        comment: `${OWNED_PREFIX} ${id} — ${name}`,
        keys: [...new Set([name, ...keys].filter(Boolean).map(String))],
        content,
        order,
        sticky,
        cooldown,
        constant,
        position,
    };
}

function relationLabel(value) {
    const level = Number(value ?? 0);
    if (!Number.isFinite(level)) return 'unknown';
    if (level >= 20) return 'devoted';
    if (level >= 8) return 'friendly';
    if (level >= 1) return 'warm';
    if (level <= -8) return 'hostile';
    if (level <= -1) return 'cold';
    return 'neutral';
}

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new Error(`Campaign '${campaignId}' not found`);
    return row;
}

function recentEvents(db, campaignId, limit = 6) {
    return db.prepare('SELECT type, payload_json, created_at FROM game_events WHERE campaign_id = ? ORDER BY seq DESC LIMIT ?')
        .all(campaignId, limit)
        .map((row) => {
            const payload = parseJson(row.payload_json, {});
            const summary = typeof payload.summary === 'string' ? payload.summary : JSON.stringify(payload);
            return `- ${row.type}: ${summary.slice(0, 180)}`;
        })
        .reverse();
}

/**
 * Build the canonical list of STRPG-owned lorebook entries for a campaign.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} campaignId
 * @returns {Array<object>} logical entries (id, name, keys, content, order, sticky, cooldown, constant, position)
 */
export function logicalEntries(db, campaignId) {
    const campaign = campaignRow(db, campaignId);
    const pkg = getCampaignPackage(db, campaignId);
    const player = getEntityView(db, getPlayer(db, campaignId).id);
    const location = campaign.current_location_id
        ? db.prepare('SELECT * FROM locations WHERE id = ?').get(campaign.current_location_id)
        : null;
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const worldData = parseJson(world?.data_json, {});
    const story = parseJson(campaign.game_state_json, {}).story ?? {};
    const quests = db.prepare('SELECT quest_key, status, stage_key FROM quest_instances WHERE campaign_id = ?').all(campaignId);
    const entries = [];

    entries.push(makeEntry({
        id: 'world',
        name: pkg.world?.name ?? world?.name ?? 'World',
        keys: [pkg.world?.key, worldData.key, 'world', 'setting', 'lore'],
        content: [pkg.world?.lore, pkg.world?.description].filter(Boolean).join('\n\n') || 'No world lore recorded.',
        order: 150,
    }));

    for (const scene of pkg.locations ?? []) {
        const links = (scene.connections ?? []).map((connection) => connection.toKey).join(', ');
        entries.push(makeEntry({
            id: `scene:${scene.key}`,
            name: scene.name,
            keys: [scene.key, scene.type, scene.layer],
            content: [
                scene.description,
                `Layer: ${scene.layer}. Site type: ${scene.siteType ?? scene.type}.`,
                links ? `Connections: ${links}.` : '',
            ].filter(Boolean).join('\n'),
            order: 100,
        }));
    }

    for (const npc of pkg.npcs ?? []) {
        const relation = getCampaignVariable(db, campaignId, `npc:${npc.key}:relation`);
        const promises = getCampaignVariable(db, campaignId, `npc:${npc.key}:promises`);
        const lastInteraction = getCampaignVariable(db, campaignId, `npc:${npc.key}:lastInteraction`);
        const dynamic = [
            relation != null ? `Relationship: ${Number(relation)} (${relationLabel(relation)}).` : '',
            Array.isArray(promises) && promises.length
                ? `Promises: ${promises.map((promise) => (typeof promise === 'string' ? promise : promise?.text)).filter(Boolean).join('; ')}.`
                : '',
            lastInteraction ? `Last interaction: ${String(lastInteraction).slice(0, 240)}` : '',
        ].filter(Boolean).join('\n');
        entries.push(makeEntry({
            id: `npc:${npc.key}`,
            name: npc.name,
            keys: [npc.key, npc.title, ...(npc.tags ?? [])],
            content: [npc.title, npc.description, npc.personality, npc.motivation, dynamic].filter(Boolean).join('\n'),
            order: 110,
            sticky: dynamic ? 2 : 0,
        }));

        const debts = getCampaignVariable(db, campaignId, `npc:${npc.key}:debts`);
        if (Array.isArray(debts) && debts.length) {
            const open = debts.filter((debt) => debt && debt.status !== 'settled');
            if (open.length) {
                entries.push(makeEntry({
                    id: `debt:${npc.key}`,
                    name: `${npc.name} — 债务`,
                    keys: [npc.name, 'debt', 'owed', '欠', '抵账', ...open.map((debt) => debt.itemKey)],
                    content: [
                        `${npc.name} is owed by the player:`,
                        ...open.map((debt) => `- ${debt.reason ?? 'service'} → ${debt.itemKey ?? 'unspecified reward'} (${debt.status ?? 'open'})`),
                        'The debt is settled only when the STRPG quest is turned in.',
                    ].join('\n'),
                    order: 120,
                }));
            }
        }
    }

    for (const quest of pkg.quests ?? []) {
        const instance = quests.find((row) => row.quest_key === quest.key);
        if (!instance) continue;
        const stage = (quest.stages ?? []).find((entry) => entry.key === instance.stage_key);
        entries.push(makeEntry({
            id: `quest:${quest.key}`,
            name: quest.name,
            keys: [quest.key, 'quest', 'task'],
            content: [
                `Status: ${instance.status}.`,
                quest.description,
                stage ? `Current stage: ${stage.name} — ${(stage.objectives ?? []).map((objective) => objective.label || objective.key).join('; ')}` : '',
            ].filter(Boolean).join('\n'),
            order: 90,
        }));
    }

    entries.push(makeEntry({
        id: 'player',
        name: player.name,
        keys: [player.name, 'player', 'party', 'me'],
        content: [
            `Level ${player.level ?? 1}, HP ${player.hp}/${player.stats?.maxHp ?? "?"}, MP ${player.mp}/${player.stats?.maxMp ?? "?"}, Gold ${player.gold}.`,
            `Skills: ${(player.skills ?? []).map((skill) => skill.name).join(', ') || 'none'}.`,
        ].join('\n'),
        order: 180,
    }));

    entries.push(makeEntry({
        id: 'current',
        name: 'Current Situation',
        keys: ['current', 'campaign', campaign.name, 'now'],
        content: [
            `Campaign: ${campaign.name}`,
            `Location: ${location?.name ?? 'unknown'} (${location?.location_key ?? 'unknown'})`,
            `Story node: ${story.currentNodeKey ?? 'not started'}${story.ending ? ` (ENDING: ${story.ending})` : ''}`,
            `Active quests: ${quests.filter((row) => ['active', 'ready_to_turn_in'].includes(row.status)).map((row) => row.quest_key).join(', ') || 'none'}`,
            recentEvents(db, campaignId).length ? 'Recent events:' : '',
            ...recentEvents(db, campaignId),
        ].filter(Boolean).join('\n'),
        order: 190,
        sticky: 3,
    }));

    entries.push(makeEntry({
        id: 'rules',
        name: 'STRPG Rules',
        keys: ['strpg', 'rules', 'system'],
        content: 'STRPG owns HP, MP, EXP, gold, items, skills, quests, combat and world state. The LLM narrates only; never invent or change numbers. A proposal is not an action until the player confirms it.',
        order: 200,
    }));

    return entries;
}

function assignUids(entries) {
    const used = new Set();
    const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of ordered) {
        let uid = UID_BASE + (fnv1a(entry.id) % UID_SPAN);
        while (used.has(uid)) uid = UID_BASE + (((uid - UID_BASE + 1) % UID_SPAN));
        used.add(uid);
        entry.uid = uid;
    }
    return ordered;
}

function toWorldInfoEntry(entry) {
    return {
        uid: entry.uid,
        key: entry.keys,
        keysecondary: [],
        comment: entry.comment,
        content: entry.content,
        constant: Boolean(entry.constant),
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: entry.order,
        position: entry.position ?? 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: entry.sticky ?? 0,
        cooldown: entry.cooldown ?? 0,
        delay: 0,
        displayIndex: entry.uid,
    };
}

/**
 * Build the full entry map STRPG would like to own (uid -> world info entry).
 * @returns {Record<string, object>}
 */
export function buildEntries(db, campaignId) {
    const entries = logicalEntries(db, campaignId);
    const assigned = assignUids(entries);
    return Object.fromEntries(assigned.map((entry) => [String(entry.uid), toWorldInfoEntry(entry)]));
}

export function ownerIdOf(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const comment = String(entry.comment ?? '');
    if (!comment.startsWith(OWNED_PREFIX)) return null;
    const rest = comment.slice(OWNED_PREFIX.length).trim();
    const separator = rest.indexOf('—');
    return (separator === -1 ? rest : rest.slice(0, separator)).trim() || null;
}

/**
 * Merge STRPG entries into an existing book.
 * - entries owned by STRPG are upserted by logical id, and removed when no longer generated
 * - every other entry is kept byte-for-byte
 * @returns {{entries: Record<string, object>, stats: {added: number, updated: number, removed: number, kept: number}}}
 */
export function mergeEntries(existing = {}, generated = {}, options = {}) {
    const kept = {};
    const ownedByExistingId = new Map();
    const generatedNameToEntry = new Map();
    for (const entry of Object.values(generated ?? {})) {
        const comment = String(entry.comment ?? '');
        const marker = comment.lastIndexOf('—');
        const name = (marker === -1 ? comment : comment.slice(marker + 1)).trim();
        if (name) generatedNameToEntry.set(name, entry);
    }
    const adoptLegacy = options.adoptLegacy === true;
    const stats = { added: 0, updated: 0, removed: 0, kept: 0, adoptedLegacy: 0 };
    for (const [uid, entry] of Object.entries(existing ?? {})) {
        const ownerId = ownerIdOf(entry);
        if (!ownerId) {
            // Books written before 1.4.0 had no owner marker. Inside an STRPG-owned
            // book, an unmarked entry whose memo matches a generated name is legacy.
            const legacyName = String(entry?.comment ?? '').trim();
            if (adoptLegacy && generatedNameToEntry.has(legacyName)) {
                stats.adoptedLegacy += 1;
                continue;
            }
            kept[uid] = entry;
            continue;
        }
        ownedByExistingId.set(ownerId, entry);
    }
    stats.kept = Object.keys(kept).length;
    const reserved = new Set(Object.keys(kept).map((uid) => Number(uid)));
    const generatedById = new Map();
    for (const [uid, entry] of Object.entries(generated ?? {})) {
        generatedById.set(ownerIdOf(entry) ?? String(uid), { uid: Number(uid), entry });
    }

    for (const [id, item] of generatedById) {
        const previous = ownedByExistingId.get(id);
        let uid = item.uid;
        if (previous) {
            // Keep the existing uid so SillyTavern's per-entry state (timed effects) survives.
            uid = Number(previous.uid ?? uid);
            reserved.delete(uid);
        }
        while (reserved.has(uid)) uid = UID_BASE + (((uid - UID_BASE + 1) % UID_SPAN));
        reserved.add(uid);
        const next = { ...item.entry, uid, displayIndex: uid };
        if (previous) {
            stats.updated += 1;
            next.sticky = previous.sticky ?? next.sticky;
            next.cooldown = previous.cooldown ?? next.cooldown;
        } else {
            stats.added += 1;
        }
        kept[String(uid)] = next;
    }
    for (const id of ownedByExistingId.keys()) {
        if (!generatedById.has(id)) stats.removed += 1;
    }
    return { entries: kept, stats };
}

function npcFilteredEntries(db, campaignId, entries, npcKey) {
    if (!npcKey) return entries;
    const pkg = getCampaignPackage(db, campaignId);
    const npc = (pkg.npcs ?? []).find((entry) => entry.key === npcKey);
    if (!npc) throw new Error(`Unknown NPC '${npcKey}'`);
    const allowed = new Set([`npc:${npcKey}`, `debt:${npcKey}`, 'player', 'current', 'rules']);
    return Object.fromEntries(Object.entries(entries).filter(([, entry]) => allowed.has(ownerIdOf(entry))));
}

function bookNameWithNpc(db, campaignId, campaignName, npcKey) {
    if (!npcKey) return bookNameFor(campaignName);
    const pkg = getCampaignPackage(db, campaignId);
    const npc = (pkg.npcs ?? []).find((entry) => entry.key === npcKey);
    return `${bookNameFor(campaignName)} - ${npc?.name ?? npcKey}`;
}

export function previewBook(db, campaignId, options = {}) {
    const campaign = campaignRow(db, campaignId);
    const generated = npcFilteredEntries(db, campaignId, buildEntries(db, campaignId), options.npcKey);
    return {
        name: bookNameWithNpc(db, campaignId, campaign.name, options.npcKey),
        entries: generated,
        stats: { generated: Object.keys(generated).length },
        generatedAt: nowIso(),
    };
}

function upstreamHeaders(request) {
    const headers = { 'content-type': 'application/json' };
    if (request.headers?.cookie) headers.cookie = request.headers.cookie;
    const csrf = request.headers?.['x-csrf-token'];
    if (csrf) headers['x-csrf-token'] = String(csrf);
    return headers;
}

function baseUrl(request) {
    const protocol = request.protocol || 'http';
    return `${protocol}://${request.get('host')}`;
}

async function readWorldBook(request, name) {
    const response = await fetch(`${baseUrl(request)}/api/worldinfo/get`, {
        method: 'POST',
        headers: upstreamHeaders(request),
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        return { entries: {}, warning: `world info read failed (HTTP ${response.status})` };
    }
    const payload = await response.json();
    return { entries: payload?.entries ?? {}, warning: null };
}

async function writeWorldBook(request, name, data) {
    const response = await fetch(`${baseUrl(request)}/api/worldinfo/edit`, {
        method: 'POST',
        headers: upstreamHeaders(request),
        body: JSON.stringify({ name, data }),
    });
    if (!response.ok) throw new Error(`world info write failed (HTTP ${response.status})`);
}

/**
 * Merge STRPG-owned entries into the SillyTavern world book and write it back.
 * @returns {Promise<{name: string, stats: object, total: number, warning: string|null}>}
 */
export async function pushLorebook(db, campaignId, request, options = {}) {
    const campaign = campaignRow(db, campaignId);
    const name = bookNameWithNpc(db, campaignId, campaign.name, options.npcKey);
    const generated = npcFilteredEntries(db, campaignId, buildEntries(db, campaignId), options.npcKey);
    let existing = {};
    let warning = null;
    if (options.replace === true) {
        existing = {};
    } else {
        const read = await readWorldBook(request, name);
        existing = read.entries;
        warning = read.warning;
    }
    const merged = mergeEntries(existing, generated, { adoptLegacy: options.adoptLegacy !== false });
    if (options.dryRun !== true) {
        await writeWorldBook(request, name, { entries: merged.entries });
    }
    return {
        name,
        stats: merged.stats,
        total: Object.keys(merged.entries).length,
        warning,
        dryRun: options.dryRun === true,
    };
}
