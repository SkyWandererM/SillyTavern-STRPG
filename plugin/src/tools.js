import { ValidationError } from './errors.js';
import { getDashboard } from './campaigns.js';
import { getCampaignLocation, getLocations, proposeMovement } from './world.js';
import { proposeEncounter, getCombatContextForLLM } from './combat.js';
import { listQuests } from './quests.js';
import { availableInteractionsAtCurrentLocation } from './interactions.js';
import { nowIso, uuid } from './util.js';
import { proposeRelation, receiveSignal, trackerMirror } from './bridge.js';
import { proposeRecovery, proposeRecruit, proposeTrade, proposeTuition, socialOptions } from './social.js';

const REACTION_FIELDS = new Set(['npcKey', 'emotion', 'attitude', 'thought', 'gesture', 'summary']);

export const TOOL_DEFINITIONS = [
    { name: 'strpg_get_status', description: 'Get authoritative campaign, player, location and quest status.', input: { campaignId: 'string' } },
    { name: 'strpg_get_location', description: 'Get current location and nearby connections.', input: { campaignId: 'string' } },
    { name: 'strpg_propose_movement', description: 'Validate a movement proposal without applying it.', input: { campaignId: 'string', location: 'string' } },
    { name: 'strpg_propose_encounter', description: 'Validate and create a pending turn-based encounter.', input: { campaignId: 'string', monsters: 'array' } },
    { name: 'strpg_get_combat_context', description: 'Read authoritative combat state for narration.', input: { campaignId: 'string' } },
    { name: 'strpg_propose_character_reaction', description: 'Record a narrative-only NPC reaction proposal. Cannot change stats.', input: { campaignId: 'string', npcKey: 'string', reaction: 'object' } },
    { name: 'strpg_get_quest_status', description: 'List quests and objective progress.', input: { campaignId: 'string' } },
    { name: 'strpg_get_available_interactions', description: 'List NPC interactions at the current location.', input: { campaignId: 'string' } },
    { name: 'strpg_get_bridge_mirror', description: 'Read the read-only STRPG state mirror used for tracker and lorebook sync.', input: { campaignId: 'string' } },
    { name: 'strpg_propose_relation', description: 'Propose an NPC relationship change for human review. Cannot change stats directly.', input: { campaignId: 'string', npcKey: 'string', delta: 'number', reason: 'string', evidence: 'object' } },
    { name: 'strpg_get_social_options', description: 'Read shop prices, teachable skills, recruit cost and recovery needs for an NPC.', input: { campaignId: 'string', npcKey: 'string' } },
    { name: 'strpg_propose_trade', description: 'Quote and queue a haggled purchase for approval. The server decides the price floor.', input: { campaignId: 'string', npcKey: 'string', itemKey: 'string', quantity: 'number', offerPrice: 'number' } },
    { name: 'strpg_propose_recruit', description: 'Queue recruiting an NPC into the party with its configured cost.', input: { campaignId: 'string', npcKey: 'string' } },
    { name: 'strpg_propose_tuition', description: 'Queue learning a skill from an NPC with its configured tuition.', input: { campaignId: 'string', npcKey: 'string', skillKey: 'string' } },
    { name: 'strpg_propose_recovery', description: 'Queue an interaction that helps a low-state NPC recover.', input: { campaignId: 'string', npcKey: 'string', method: 'string' } },
    { name: 'strpg_receive_signal', description: 'Record a favour signal when the player actually completed a non-cash payment in the scene.', input: { campaignId: 'string', name: 'string', note: 'string' } },
];

export async function callTool(db, name, args = {}) {
    const campaignId = args.campaignId;
    if (!campaignId) throw new ValidationError('campaignId is required');
    if (name === 'strpg_get_status') {
        const dashboard = getDashboard(db, campaignId);
        return {
            campaign: { id: dashboard.campaign.id, name: dashboard.campaign.name, status: dashboard.campaign.status },
            player: {
                name: dashboard.player.name, level: dashboard.player.level, hp: dashboard.player.hp, maxHp: dashboard.player.stats.maxHp,
                mp: dashboard.player.mp, maxMp: dashboard.player.stats.maxMp, xp: dashboard.player.xp, xpToNext: dashboard.player.xpToNext,
                gold: dashboard.player.gold, equipment: dashboard.player.equipment.map((entry) => entry.name), skills: dashboard.player.skills.map((entry) => entry.name),
            },
            location: { key: dashboard.location.key, name: dashboard.location.name },
            activeQuests: dashboard.activeQuests.map((quest) => ({ key: quest.key, name: quest.name, status: quest.status, stageKey: quest.stageKey })),
            pendingCombat: dashboard.pendingCombat ? { id: dashboard.pendingCombat.id, status: dashboard.pendingCombat.status, round: dashboard.pendingCombat.round } : null,
            story: { currentNode: dashboard.story.current?.key ?? null, ending: dashboard.story.ending?.key ?? null },
        };
    }
    if (name === 'strpg_get_location') {
        const current = getCampaignLocation(db, campaignId);
        const map = getLocations(db, campaignId);
        return {
            current,
            discovered: map.filter((location) => location.discovered).map((location) => ({ key: location.location_key, name: location.name, type: location.type })),
        };
    }
    if (name === 'strpg_propose_movement') {
        return proposeMovement(db, campaignId, args.location ?? args.locationKey ?? args.targetLocationId);
    }
    if (name === 'strpg_propose_encounter') {
        return proposeEncounter(db, campaignId, args);
    }
    if (name === 'strpg_get_combat_context') {
        return getCombatContextForLLM(db, campaignId);
    }
    if (name === 'strpg_get_quest_status') {
        return { quests: listQuests(db, campaignId) };
    }
    if (name === 'strpg_get_available_interactions') {
        return { interactions: availableInteractionsAtCurrentLocation(db, campaignId) };
    }
    if (name === 'strpg_get_bridge_mirror') {
        return trackerMirror(db, campaignId);
    }
    if (name === 'strpg_propose_relation') {
        const result = proposeRelation(db, campaignId, {
            npcKey: args.npcKey,
            delta: args.delta,
            reason: args.reason,
            evidence: args.evidence ?? { source: 'llm-tool' },
            source: 'llm',
        });
        return {
            accepted: true,
            authoritative: false,
            duplicate: result.duplicate,
            candidate: result.candidate,
            note: 'Queued for review. The relationship changes only after approval.',
        };
    }
    if (name === 'strpg_receive_signal') {
        const result = await receiveSignal(db, campaignId, args.name ?? args.signal, { note: args.note });
        return { ...result, note: 'Signal recorded; released proposals were settled where affordable.' };
    }
    if (name === 'strpg_get_social_options') {
        return socialOptions(db, campaignId, String(args.npcKey ?? ''));
    }
    if (name === 'strpg_propose_trade') {
        const result = proposeTrade(db, campaignId, args);
        return {
            accepted: true, authoritative: false, duplicate: result.duplicate,
            quote: result.quote, candidate: result.candidate,
            note: 'Queued for review. The player must approve before gold or items move.',
        };
    }
    if (name === 'strpg_propose_recruit') {
        const result = proposeRecruit(db, campaignId, args);
        return { accepted: true, authoritative: false, duplicate: result.duplicate, cost: result.cost, candidate: result.candidate, note: 'Recruiting requires player approval.' };
    }
    if (name === 'strpg_propose_tuition') {
        const result = proposeTuition(db, campaignId, args);
        return { accepted: true, authoritative: false, duplicate: result.duplicate, tuition: result.tuition, candidate: result.candidate, note: 'Tuition requires player approval.' };
    }
    if (name === 'strpg_propose_recovery') {
        const result = proposeRecovery(db, campaignId, args);
        return { accepted: true, authoritative: false, duplicate: result.duplicate, hpRatio: result.hpRatio, candidate: result.candidate, note: 'Recovery requires player approval.' };
    }
    if (name === 'strpg_propose_character_reaction') {
        const reaction = args.reaction ?? {};
        const unknown = Object.keys(reaction).filter((key) => !REACTION_FIELDS.has(key));
        if (unknown.length) throw new ValidationError(`Reaction contains non-whitelisted fields: ${unknown.join(', ')}`);
        if (String(reaction.summary ?? '').length > 2000) throw new ValidationError('Reaction summary is too long');
        const payload = { ...reaction, npcKey: args.npcKey ?? reaction.npcKey, proposedAt: nowIso(), authoritative: false };
        db.prepare('INSERT INTO tracker_sync_log (id, campaign_id, provider, direction, payload_json, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(uuid('sync_'), campaignId, 'llm-reaction', 'proposal', JSON.stringify(payload), 'accepted', 'Narrative-only proposal; no numeric state changed', nowIso());
        return { accepted: true, authoritative: false, reaction: payload, note: 'This reaction is narrative only. STRPG HP/EXP/items were not modified.' };
    }
    throw new ValidationError(`Unknown STRPG tool '${name}'`);
}
