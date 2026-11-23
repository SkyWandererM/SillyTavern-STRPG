import { getCampaignVariable } from './conditions.js';
import { getCampaignPackage } from './stats.js';
import { NotFoundError, ValidationError } from './errors.js';
import { nowIso, parseJson, uuid } from './util.js';

/**
 * M4 character bindings.
 *
 * A binding ties a SillyTavern character avatar to an STRPG NPC (or to the player persona
 * when npcKey is null). It is what lets a chat character carry RPG memory into the chat and
 * lets an RPG NPC open as a normal SillyTavern conversation.
 */

export const BINDING_DIRECTIONS = ['chat2rpg', 'rpg2chat'];
const AVATAR_MAX = 300;

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

function npcMap(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    return new Map((pkg.npcs ?? []).map((npc) => [npc.key, npc]));
}

function bindingView(row, npcs) {
    const npc = row.npc_key ? npcs.get(row.npc_key) : null;
    return {
        id: row.id,
        campaignId: row.campaign_id,
        npcKey: row.npc_key ?? null,
        npcName: npc?.name ?? null,
        stAvatar: row.st_avatar,
        stCharacterName: row.st_character_name,
        direction: row.direction,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
    };
}

export function listBindings(db, campaignId) {
    campaignRow(db, campaignId);
    const npcs = npcMap(db, campaignId);
    const rows = db.prepare('SELECT * FROM character_bindings WHERE campaign_id = ? ORDER BY created_at').all(campaignId);
    return { bindings: rows.map((row) => bindingView(row, npcs)), directions: BINDING_DIRECTIONS };
}

export function upsertBinding(db, campaignId, input = {}) {
    campaignRow(db, campaignId);
    const stAvatar = String(input.stAvatar ?? '').trim();
    if (!stAvatar || stAvatar.length > AVATAR_MAX) throw new ValidationError('stAvatar is required');
    const npcKey = input.npcKey ? String(input.npcKey).trim() : null;
    if (npcKey && !npcMap(db, campaignId).has(npcKey)) throw new NotFoundError(`Unknown NPC '${npcKey}'`, 'NPC_NOT_FOUND');
    const direction = BINDING_DIRECTIONS.includes(input.direction) ? input.direction : (npcKey ? 'rpg2chat' : 'chat2rpg');
    const now = nowIso();
    const existing = db.prepare('SELECT id FROM character_bindings WHERE campaign_id = ? AND st_avatar = ?').get(campaignId, stAvatar);
    if (existing) {
        db.prepare('UPDATE character_bindings SET npc_key = ?, st_character_name = ?, direction = ?, last_seen_at = ? WHERE id = ?')
            .run(npcKey, String(input.stCharacterName ?? '').slice(0, 200), direction, now, existing.id);
    } else {
        db.prepare(`
            INSERT INTO character_bindings (id, campaign_id, npc_key, st_avatar, st_character_name, direction, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(uuid('bind_'), campaignId, npcKey, stAvatar, String(input.stCharacterName ?? '').slice(0, 200), direction, now, now);
    }
    const row = db.prepare('SELECT * FROM character_bindings WHERE campaign_id = ? AND st_avatar = ?').get(campaignId, stAvatar);
    return bindingView(row, npcMap(db, campaignId));
}

export function deleteBinding(db, campaignId, bindingId) {
    campaignRow(db, campaignId);
    const result = db.prepare('DELETE FROM character_bindings WHERE campaign_id = ? AND id = ?').run(campaignId, bindingId);
    if (!result.changes) throw new NotFoundError(`Binding '${bindingId}' not found`, 'BINDING_NOT_FOUND');
    return { deleted: bindingId };
}

export function resolveBinding(db, campaignId, query = {}) {
    campaignRow(db, campaignId);
    const npcs = npcMap(db, campaignId);
    const avatar = String(query.avatar ?? '').trim();
    const npcKey = String(query.npcKey ?? '').trim();
    let row = null;
    if (avatar) row = db.prepare('SELECT * FROM character_bindings WHERE campaign_id = ? AND st_avatar = ?').get(campaignId, avatar);
    if (!row && npcKey) row = db.prepare('SELECT * FROM character_bindings WHERE campaign_id = ? AND npc_key = ? ORDER BY created_at DESC LIMIT 1').get(campaignId, npcKey);
    if (!row) return { found: false, binding: null, npc: null };
    const binding = bindingView(row, npcs);
    const npc = binding.npcKey ? npcs.get(binding.npcKey) : null;
    return {
        found: true,
        binding,
        npc: npc ? { key: npc.key, name: npc.name, title: npc.title ?? '', locationKey: npc.locationKey ?? null } : null,
    };
}

/**
 * Compact NPC context for the injected prompt when the active chat is a bound NPC.
 */
export function bindingContext(db, campaignId, avatar) {
    const resolved = resolveBinding(db, campaignId, { avatar });
    if (!resolved.found) return null;
    const binding = resolved.binding;
    if (!binding.npcKey) {
        return { line: `Bound persona: ${binding.stCharacterName || binding.stAvatar} is the player identity for this campaign.` };
    }
    const relation = getCampaignVariable(db, campaignId, `npc:${binding.npcKey}:relation`);
    const last = getCampaignVariable(db, campaignId, `npc:${binding.npcKey}:lastInteraction`);
    const debts = getCampaignVariable(db, campaignId, `npc:${binding.npcKey}:debts`);
    const parts = [
        `Bound NPC: ${binding.npcName ?? binding.npcKey} (${binding.npcKey})`,
        relation != null ? `relationship ${Number(relation)}` : '',
        last ? `last interaction: ${String(last).slice(0, 240)}` : '',
        Array.isArray(debts) && debts.length ? `open debts: ${debts.filter((debt) => debt?.status !== 'settled').map((debt) => debt.itemKey).join(', ')}` : '',
    ].filter(Boolean);
    return {
        npcKey: binding.npcKey,
        npcName: binding.npcName,
        line: `${parts.join(' | ')}. Stay in character; numbers only change through STRPG proposals.`,
    };
}
