import { parseJson } from './util.js';

export function getCampaignRow(db, campaignId) {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
}

export function getCampaignState(db, campaignId) {
    const row = getCampaignRow(db, campaignId);
    return row ? parseJson(row.game_state_json, {}) : {};
}

export function getCampaignFlag(db, campaignId, flag) {
    const variable = db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?')
        .get(campaignId, `flag:${flag}`);
    if (variable) return parseJson(variable.value_json, false);
    const state = getCampaignState(db, campaignId);
    return Array.isArray(state.flags) && state.flags.includes(flag);
}

export function getCampaignVariable(db, campaignId, key) {
    const row = db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?').get(campaignId, key);
    return row ? parseJson(row.value_json, null) : null;
}

export function getQuestStatus(db, campaignId, questKey) {
    const row = db.prepare('SELECT status FROM quest_instances WHERE campaign_id = ? AND quest_key = ?').get(campaignId, questKey);
    return row?.status ?? 'unavailable';
}

export function getItemCount(db, campaignId, entityId, itemKey) {
    const rows = db.prepare(`
        SELECT quantity FROM inventory WHERE campaign_id = ? AND entity_id = ? AND item_key = ?
    `).all(campaignId, entityId, itemKey);
    return rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
}

/**
 * Evaluate a structured STRPG condition. Unknown condition forms are false, never truthy.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} campaignId
 * @param {object} condition
 * @param {{ type?: string, targetKey?: string, actorKey?: string }} [event]
 */
export function evaluateCondition(db, campaignId, condition, event = {}) {
    if (condition == null) return true;
    if (typeof condition !== 'object' || Array.isArray(condition)) return false;
    if (Array.isArray(condition.all) && !condition.all.every((child) => evaluateCondition(db, campaignId, child, event))) return false;
    if (Array.isArray(condition.any) && condition.any.length && !condition.any.some((child) => evaluateCondition(db, campaignId, child, event))) return false;
    if (condition.not != null && evaluateCondition(db, campaignId, condition.not, event)) return false;

    const campaign = getCampaignRow(db, campaignId);
    if (!campaign) return false;
    const state = parseJson(campaign.game_state_json, {});
    const player = campaign.player_entity_id
        ? db.prepare('SELECT * FROM entities WHERE id = ?').get(campaign.player_entity_id)
        : null;

    if (condition.flag && !getCampaignFlag(db, campaignId, condition.flag)) return false;
    if (condition.questKey) {
        if (condition.questStatus) {
            if (getQuestStatus(db, campaignId, condition.questKey) !== condition.questStatus) return false;
        } else if (getQuestStatus(db, campaignId, condition.questKey) === 'unavailable') {
            return false;
        }
    }
    if (condition.itemKey) {
        const count = getItemCount(db, campaignId, campaign.player_entity_id, condition.itemKey);
        if (count < Number(condition.itemCount ?? 1)) return false;
    }
    if (condition.level != null && Number(player?.level ?? 1) < Number(condition.level)) return false;
    if (condition.locationKey) {
        const location = db.prepare('SELECT location_key FROM locations WHERE id = ?').get(campaign.current_location_id);
        if (location?.location_key !== condition.locationKey) return false;
    }
    if (condition.variable?.key) {
        const actual = getCampaignVariable(db, campaignId, condition.variable.key);
        const expected = condition.variable.value;
        const op = condition.variable.op ?? 'eq';
        if (op === 'eq' && actual !== expected) return false;
        if (op === 'neq' && actual === expected) return false;
        if (op === 'gte' && Number(actual) < Number(expected)) return false;
        if (op === 'lte' && Number(actual) > Number(expected)) return false;
        if (op === 'gt' && Number(actual) <= Number(expected)) return false;
        if (op === 'lt' && Number(actual) >= Number(expected)) return false;
    }
    if (condition.storyNodeKey) {
        if (state.story?.currentNodeKey !== condition.storyNodeKey) return false;
    }
    if (condition.eventType && event.type !== condition.eventType) return false;
    if (condition.eventTargetKey && event.targetKey !== condition.eventTargetKey) return false;
    return true;
}

export function describeCondition(condition) {
    if (!condition || !Object.keys(condition).length) return 'No condition';
    const parts = [];
    if (condition.questKey) parts.push(`quest ${condition.questKey} = ${condition.questStatus ?? 'known'}`);
    if (condition.flag) parts.push(`flag ${condition.flag}`);
    if (condition.itemKey) parts.push(`owns ${condition.itemKey} x ${condition.itemCount ?? 1}`);
    if (condition.level) parts.push(`level >= ${condition.level}`);
    if (condition.locationKey) parts.push(`at ${condition.locationKey}`);
    if (condition.variable?.key) parts.push(`variable ${condition.variable.key} ${condition.variable.op ?? 'eq'} ${condition.variable.value}`);
    if (Array.isArray(condition.all)) parts.push(`all(${condition.all.length})`);
    if (Array.isArray(condition.any)) parts.push(`any(${condition.any.length})`);
    return parts.join(' AND ') || 'Structured condition';
}

