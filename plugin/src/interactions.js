import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { evaluateCondition, getCampaignVariable } from './conditions.js';
import { acceptQuest, listQuests, questsReadyForTurnIn, turnInQuest, updateQuestProgress } from './quests.js';
import { advanceStory } from './story.js';
import { getPlayer, healEntity, unlockSkill } from './stats.js';
import { insertEvent, nowIso, parseJson, withTransaction } from './util.js';
import { buyItem, itemView, listInventory, sellItem } from './inventory.js';
import { runEventDefinitions } from './world.js';

export function getNpcByKey(db, campaignId, npcKey) {
    const row = db.prepare("SELECT * FROM entities WHERE campaign_id = ? AND kind = 'npc' AND entity_key = ?")
        .get(campaignId, `npc:${npcKey}`);
    if (!row) throw new NotFoundError(`NPC '${npcKey}' is not present in this campaign`, 'NPC_NOT_FOUND');
    return row;
}

export function npcData(db, campaignId, npcKey) {
    const npc = getNpcByKey(db, campaignId, npcKey);
    const data = parseJson(npc.data_json, {});
    const template = db.prepare(`
        SELECT t.* FROM entity_templates t JOIN campaigns c ON c.game_version_id = t.game_version_id
        WHERE c.id = ? AND t.kind = 'npc' AND t.template_key = ?
    `).get(campaignId, npcKey);
    return { entity: npc, runtime: data, definition: template ? parseJson(template.data_json, {}) : {} };
}

function relation(db, campaignId, npcKey) {
    return Number(getCampaignVariable(db, campaignId, `npc:${npcKey}:relation`) ?? 0);
}

function setRelation(db, campaignId, npcKey, value) {
    db.prepare(`
        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(campaignId, `npc:${npcKey}:relation`, JSON.stringify(value), nowIso());
}

export function getNpcInteractions(db, campaignId, npcKey) {
    const { entity, runtime, definition } = npcData(db, campaignId, npcKey);
    const campaign = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId);
    if (entity.location_id !== campaign.current_location_id) {
        return { npc: npcProfile(db, campaignId, npcKey), present: false, interactions: [] };
    }
    const interactions = (definition.interactions ?? []).map((interaction) => {
        const available = evaluateCondition(db, campaignId, interaction.condition ?? {}, { type: 'interaction', targetKey: npcKey });
        return {
            ...interaction,
            available,
            reason: available ? null : 'Condition not met',
        };
    });
    return {
        npc: npcProfile(db, campaignId, npcKey),
        present: true,
        interactions,
        shop: definition.shop ?? runtime.shop ?? null,
        questsReady: questsReadyForTurnIn(db, campaignId, npcKey),
    };
}

export function npcProfile(db, campaignId, npcKey) {
    const { entity, runtime, definition } = npcData(db, campaignId, npcKey);
    return {
        id: entity.id,
        key: npcKey,
        name: definition.name,
        title: definition.title ?? '',
        description: definition.description ?? '',
        personality: definition.personality ?? '',
        motivation: definition.motivation ?? '',
        locationKey: definition.locationKey,
        portrait: definition.portrait ?? null,
        joinable: Boolean(definition.joinable),
        inParty: Boolean(runtime.party),
        relation: relation(db, campaignId, npcKey),
        shop: definition.shop ?? runtime.shop ?? null,
    };
}

function sceneAt(db, campaignId, npcKey) {
    const { entity } = npcData(db, campaignId, npcKey);
    const campaign = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId);
    if (entity.location_id !== campaign.current_location_id) throw new ConflictError('NPC is not at the player location', 'NPC_NOT_PRESENT');
}

export function interactWithNpc(db, campaignId, npcKey, interactionKey, options = {}) {
    return withTransaction(db, () => {
        sceneAt(db, campaignId, npcKey);
        const { definition } = npcData(db, campaignId, npcKey);
        const interaction = (definition.interactions ?? []).find((entry) => entry.key === interactionKey);
        if (!interaction) throw new NotFoundError(`Interaction '${interactionKey}' not found`, 'INTERACTION_NOT_FOUND');
        if (!evaluateCondition(db, campaignId, interaction.condition ?? {}, { type: 'interaction', targetKey: npcKey })) {
            throw new ConflictError('Interaction conditions are not met', 'INTERACTION_LOCKED');
        }
        let result = { type: interaction.type, interactionKey, npcKey };
        if (interaction.type === 'talk' || interaction.type === 'custom') {
            setRelation(db, campaignId, npcKey, relation(db, campaignId, npcKey) + 1);
            const questResult = updateQuestProgress(db, campaignId, { type: 'talk', targetKey: npcKey, amount: 1 });
            result = {
                ...result,
                dialogue: interaction.dialogue ?? [],
                questChanges: questResult.changes,
                questEvents: questResult.events,
                narrative: {
                    npc: npcProfile(db, campaignId, npcKey),
                    instruction: 'Role-play this NPC in character. Do not invent numeric changes; use only the action results returned by STRPG.',
                },
            };
            const story = advanceStory(db, campaignId, { type: 'npc.talk', targetKey: npcKey });
            const location = db.prepare('SELECT location_key FROM locations WHERE id = ?').get(npcData(db, campaignId, npcKey).entity.location_id);
            result.worldEvents = runEventDefinitions(db, campaignId, { trigger: 'interact', sceneKey: location?.location_key, targetKey: npcKey });
            result.story = story;
        } else if (interaction.type === 'accept_quest') {
            const available = listQuests(db, campaignId).filter((quest) => quest.status === 'available'
                && (definition.questsOffered ?? []).includes(quest.key));
            const questKey = interaction.questKey ?? options.questKey ?? available[0]?.key;
            if (!questKey) throw new ConflictError('No quest is available from this NPC', 'NO_QUEST_AVAILABLE');
            if (!(definition.questsOffered ?? []).includes(questKey)) throw new ConflictError('NPC does not offer this quest', 'QUEST_NOT_OFFERED');
            if (!available.some((quest) => quest.key === questKey)) throw new ConflictError('Quest is not currently available', 'QUEST_NOT_AVAILABLE');
            const accepted = acceptQuest(db, campaignId, questKey);
            result = { ...result, quest: accepted, story: advanceStory(db, campaignId, { type: 'quest.accepted', targetKey: questKey }) };
        } else if (interaction.type === 'turn_in_quest') {
            const ready = questsReadyForTurnIn(db, campaignId, npcKey);
            const questKey = interaction.questKey ?? options.questKey ?? ready[0]?.key;
            if (!questKey) throw new ConflictError('No quest is ready to turn in', 'NO_QUEST_READY');
            if (!ready.some((quest) => quest.key === questKey)) throw new ConflictError('This quest cannot be turned in here', 'QUEST_NOT_READY_HERE');
            const turnedIn = turnInQuest(db, campaignId, questKey, { npcKey });
            result = { ...result, quest: turnedIn, story: advanceStory(db, campaignId, { type: 'quest.turned_in', targetKey: questKey }) };
        } else if (interaction.type === 'shop') {
            result = { ...result, shop: definition.shop ?? null, message: 'Use the shop transaction endpoints to buy or sell.' };
        } else if (interaction.type === 'join_party') {
            if (!definition.joinable) throw new ConflictError('This NPC cannot join the party', 'NPC_NOT_JOINABLE');
            if (!evaluateCondition(db, campaignId, definition.joinCondition ?? {}, { type: 'join', targetKey: npcKey })) {
                throw new ConflictError('The NPC refuses to join yet', 'JOIN_CONDITION_FAILED');
            }
            const partyCount = db.prepare(`
                SELECT COUNT(*) AS count FROM entities WHERE campaign_id = ? AND kind = 'npc' AND json_extract(data_json, '$.party') = 1
            `).get(campaignId).count;
            if (partyCount >= 3) throw new ConflictError('Party is full', 'PARTY_FULL');
            const npcEntity = getNpcByKey(db, campaignId, npcKey);
            const runtime = parseJson(npcEntity.data_json, {});
            runtime.party = true;
            db.prepare('UPDATE entities SET data_json = ?, updated_at = ? WHERE campaign_id = ? AND entity_key = ?')
                .run(JSON.stringify(runtime), nowIso(), campaignId, `npc:${npcKey}`);
            for (const skillKey of definition.combat?.skills ?? []) {
                unlockSkill(db, npcEntity.id, skillKey, campaignId);
            }
            result = { ...result, party: true, message: `${definition.name} joined the party.` };
        } else if (interaction.type === 'heal') {
            const player = getPlayer(db, campaignId);
            const cost = Number(interaction.cost ?? 0);
            if (Number(player.gold) < cost) throw new ConflictError('Not enough gold for healing', 'INSUFFICIENT_GOLD');
            if (cost > 0) db.prepare('UPDATE entities SET gold = gold - ?, updated_at = ? WHERE id = ?').run(cost, nowIso(), player.id);
            const healed = healEntity(db, player.id, Number(interaction.amount ?? 9999), Number(interaction.mp ?? 9999));
            result = { ...result, healed: true, cost, ...healed };
        } else if (interaction.type === 'story') {
            const story = advanceStory(db, campaignId, { type: 'npc.story', targetKey: npcKey });
            result = { ...result, story };
        } else {
            throw new ValidationError(`Unsupported interaction type '${interaction.type}'`);
        }
        insertEvent(db, campaignId, 'npc.interaction', {
            npcKey,
            interactionKey,
            type: interaction.type,
            summary: result.quest ? { questKey: result.quest.key, status: result.quest.status } : result.party ? { party: true } : {},
        });
        return result;
    });
}

export function shopForNpc(db, campaignId, npcKey) {
    const { definition } = npcData(db, campaignId, npcKey);
    if (!definition.shop) throw new NotFoundError('NPC has no shop', 'SHOP_NOT_FOUND');
    return definition.shop;
}

export function shopView(db, campaignId, npcKey) {
    const shop = shopForNpc(db, campaignId, npcKey);
    const player = getPlayer(db, campaignId);
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    const rows = db.prepare('SELECT * FROM item_definitions WHERE game_version_id = ?').all(campaign.game_version_id);
    const definitions = new Map(rows.map((row) => [row.item_key, itemView(row)]));
    return {
        npcKey,
        gold: player.gold,
        buyRate: shop.buyRate ?? 1,
        sellRate: shop.sellRate ?? 0.5,
        items: (shop.items ?? []).map((entry) => {
            const item = definitions.get(entry.itemKey);
            return item ? {
                ...item,
                buyPrice: Math.max(0, Math.round(Number(entry.price ?? item.price) * Number(shop.buyRate ?? 1))),
                stock: entry.stock ?? null,
            } : { itemKey: entry.itemKey, name: entry.itemKey, missing: true };
        }),
        sellable: listInventory(db, campaignId, player.id).filter((item) => item.kind !== 'quest'),
    };
}

export function npcBuy(db, campaignId, npcKey, itemKey, quantity) {
    const shop = shopForNpc(db, campaignId, npcKey);
    const player = getPlayer(db, campaignId);
    return buyItem(db, campaignId, player.id, itemKey, quantity, shop);
}

export function npcSell(db, campaignId, npcKey, itemKey, quantity) {
    const shop = shopForNpc(db, campaignId, npcKey);
    const player = getPlayer(db, campaignId);
    return sellItem(db, campaignId, player.id, itemKey, quantity, Number(shop.sellRate ?? 0.5));
}

export function availableInteractionsAtCurrentLocation(db, campaignId) {
    const campaign = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId);
    const npcs = db.prepare("SELECT entity_key FROM entities WHERE campaign_id = ? AND kind = 'npc' AND location_id = ?")
        .all(campaignId, campaign.current_location_id);
    return npcs.map((row) => getNpcInteractions(db, campaignId, row.entity_key.replace(/^npc:/, '')));
}

