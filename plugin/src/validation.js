import { z } from 'zod';
import {
    ASSET_SCHEMAS,
    DEFAULT_CLASS,
    DEFAULT_RULES,
    GAME_PACKAGE_SCHEMA,
    normalizeZodIssues,
    sceneSchema,
} from './schemas.js';
import { DEFAULT_FORMULAS, validateFormula } from './formula.js';
import { clone } from './util.js';

function issue(list, severity, code, path, message) {
    list.push({ severity, code, path, message });
}

function duplicates(values) {
    const seen = new Set();
    const dupes = new Set();
    for (const value of values) {
        if (seen.has(value)) dupes.add(value);
        seen.add(value);
    }
    return [...dupes];
}

function checkConditionReferences(condition, path, context, errors, warnings) {
    if (!condition || typeof condition !== 'object') return;
    if (condition.questKey && !context.questKeys.has(condition.questKey)) {
        issue(errors, 'error', 'CONDITION_QUEST_UNKNOWN', `${path}.questKey`, `Unknown quest '${condition.questKey}'`);
    }
    if (condition.itemKey && !context.itemKeys.has(condition.itemKey)) {
        issue(errors, 'error', 'CONDITION_ITEM_UNKNOWN', `${path}.itemKey`, `Unknown item '${condition.itemKey}'`);
    }
    if (condition.locationKey && !context.locationKeys.has(condition.locationKey)) {
        issue(errors, 'error', 'CONDITION_LOCATION_UNKNOWN', `${path}.locationKey`, `Unknown location '${condition.locationKey}'`);
    }
    if (condition.storyNodeKey && !context.storyNodeKeys.has(condition.storyNodeKey)) {
        issue(errors, 'error', 'CONDITION_STORY_UNKNOWN', `${path}.storyNodeKey`, `Unknown story node '${condition.storyNodeKey}'`);
    }
    if (Array.isArray(condition.all)) {
        condition.all.forEach((child, index) => checkConditionReferences(child, `${path}.all.${index}`, context, errors, warnings));
    }
    if (Array.isArray(condition.any)) {
        condition.any.forEach((child, index) => checkConditionReferences(child, `${path}.any.${index}`, context, errors, warnings));
    }
    if (condition.not) checkConditionReferences(condition.not, `${path}.not`, context, errors, warnings);
}

export function validateContentAsset(kind, rawData) {
    const errors = [];
    const warnings = [];
    const schema = ASSET_SCHEMAS[kind];
    if (!schema) {
        issue(errors, 'error', 'UNKNOWN_ASSET_KIND', 'kind', `Unknown content kind '${kind}'`);
        return { valid: false, errors, warnings, data: null };
    }
    const parsed = schema.safeParse(rawData);
    if (!parsed.success) {
        for (const detail of normalizeZodIssues(parsed.error)) {
            issue(errors, 'error', 'SCHEMA', detail.path, detail.message);
        }
        return { valid: false, errors, warnings, data: null };
    }
    const data = parsed.data;

    if (kind === 'scene') {
        const targets = data.connections.map((connection) => connection.toKey);
        for (const target of duplicates(targets)) {
            issue(errors, 'error', 'DUPLICATE_CONNECTION', 'connections', `Location '${data.key}' has duplicate connection to '${target}'`);
        }
        if (targets.includes(data.key)) issue(errors, 'error', 'SELF_CONNECTION', 'connections', 'A location cannot connect to itself');
    }
    if (kind === 'story') {
        const nodeKeys = data.nodes.map((node) => node.key);
        for (const duplicate of duplicates(nodeKeys)) {
            issue(errors, 'error', 'DUPLICATE_NODE', 'nodes', `Duplicate story node key '${duplicate}'`);
        }
        if (!nodeKeys.includes(data.startNodeKey)) {
            issue(errors, 'error', 'STORY_START_MISSING', 'startNodeKey', `Start node '${data.startNodeKey}' does not exist`);
        }
        for (const ending of data.endings) {
            if (!nodeKeys.includes(ending)) issue(errors, 'error', 'STORY_ENDING_MISSING', 'endings', `Ending '${ending}' does not exist`);
        }
        const edgeKeys = new Set();
        for (const [index, edge] of data.edges.entries()) {
            if (edgeKeys.has(edge.key)) issue(errors, 'error', 'DUPLICATE_EDGE', `edges.${index}.key`, `Duplicate edge key '${edge.key}'`);
            edgeKeys.add(edge.key);
            if (!nodeKeys.includes(edge.from)) issue(errors, 'error', 'EDGE_FROM_MISSING', `edges.${index}.from`, `Unknown source node '${edge.from}'`);
            if (!nodeKeys.includes(edge.to)) issue(errors, 'error', 'EDGE_TO_MISSING', `edges.${index}.to`, `Unknown target node '${edge.to}'`);
        }
        const reached = reachableNodes(data.startNodeKey, data.nodes, data.edges);
        for (const node of data.nodes) {
            if (!reached.has(node.key)) issue(errors, 'error', 'STORY_NODE_UNREACHABLE', 'nodes', `Story node '${node.key}' is unreachable from '${data.startNodeKey}'`);
        }
        const outgoing = new Set(data.edges.map((edge) => edge.from));
        for (const node of data.nodes) {
            if (!outgoing.has(node.key) && node.type !== 'ending' && !data.endings.includes(node.key)) {
                issue(errors, 'error', 'STORY_DEAD_END', 'nodes', `Story node '${node.key}' has no outgoing edge and is not an ending`);
            }
        }
        if (data.endings.length && !data.endings.some((ending) => reached.has(ending))) {
            issue(errors, 'error', 'STORY_ENDING_UNREACHABLE', 'endings', 'No declared ending is reachable from the start node');
        }
    }
    if (kind === 'quest') {
        const stageKeys = data.stages.map((stage) => stage.key);
        for (const duplicate of duplicates(stageKeys)) {
            issue(errors, 'error', 'DUPLICATE_STAGE', 'stages', `Duplicate quest stage '${duplicate}'`);
        }
        for (const [stageIndex, stage] of data.stages.entries()) {
            const objectiveKeys = stage.objectives.map((objective) => objective.key);
            for (const duplicate of duplicates(objectiveKeys)) {
                issue(errors, 'error', 'DUPLICATE_OBJECTIVE', `stages.${stageIndex}.objectives`, `Duplicate objective '${duplicate}'`);
            }
        }
        if (data.completion === 'turn_in' && !data.turnIn?.npcKey) {
            issue(errors, 'error', 'QUEST_TURNIN_NPC_MISSING', 'turnIn.npcKey', 'A turn-in quest must define turnIn.npcKey');
        }
    }
    if (kind === 'rules') {
        for (const [name, formula] of Object.entries({ ...DEFAULT_FORMULAS, ...data.formulas })) {
            const result = validateFormula(formula);
            if (!result.valid) issue(errors, 'error', 'INVALID_FORMULA', `formulas.${name}`, result.message);
        }
    }
    return { valid: errors.length === 0, errors, warnings, data };
}

/**
 * Assemble a normalized game package from the latest published asset rows.
 * @param {{ project: any, assets: any[], version?: number }} input
 */
export function assembleGamePackage({ project, assets, version = 1 }) {
    const byKind = (kind) => assets.filter((asset) => asset.kind === kind).map((asset) => asset.data);
    const worlds = byKind('world');
    const stories = byKind('story');
    if (worlds.length !== 1) throw new Error(`A build requires exactly one published world asset, found ${worlds.length}`);
    if (stories.length !== 1) throw new Error(`A build requires exactly one published story asset, found ${stories.length}`);
    const locations = byKind('scene');
    if (!locations.length) throw new Error('A build requires at least one published scene/location asset');
    const classes = byKind('class');
    const rules = byKind('rules')[0] ?? clone(DEFAULT_RULES);
    const effects = byKind('status_effect');

    return {
        schema: 'strpg.game-package',
        schemaVersion: 1,
        meta: {
            id: project.id,
            name: project.name,
            title: project.name,
            version: String(version),
            author: project.metadata?.author ?? 'STRPG Studio',
            description: project.description,
            createdAt: new Date().toISOString(),
        },
        world: worlds[0],
        locations,
        events: byKind('event'),
        classes: classes.length ? classes : [clone(DEFAULT_CLASS)],
        npcs: byKind('npc'),
        monsters: byKind('monster'),
        items: byKind('equipment'),
        skills: byKind('skill'),
        effects,
        quests: byKind('quest'),
        story: stories[0],
        rules: { ...clone(DEFAULT_RULES), ...rules, formulas: { ...DEFAULT_FORMULAS, ...(rules.formulas ?? {}) } },
        start: {
            locationKey: worlds[0].startLocationKey,
            storyNodeKey: stories[0].startNodeKey,
        },
        integrations: project.metadata?.integrations ?? {},
    };
}

function reachableNodes(start, nodes, edges) {
    const adjacency = new Map(nodes.map((node) => [node.key, []]));
    for (const edge of edges) {
        if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
    }
    const reached = new Set();
    const queue = [start];
    while (queue.length) {
        const key = queue.shift();
        if (!key || reached.has(key) || !adjacency.has(key)) continue;
        reached.add(key);
        queue.push(...adjacency.get(key));
    }
    return reached;
}

function detectDependencyCycles(quests) {
    const graph = new Map(quests.map((quest) => [quest.key, quest.prerequisites ?? []]));
    const state = new Map();
    const cycles = [];
    const stack = [];
    const visit = (key) => {
        if (state.get(key) === 'done') return;
        if (state.get(key) === 'visiting') {
            const index = stack.indexOf(key);
            cycles.push([...stack.slice(index), key]);
            return;
        }
        state.set(key, 'visiting');
        stack.push(key);
        for (const dependency of graph.get(key) ?? []) visit(dependency);
        stack.pop();
        state.set(key, 'done');
    };
    for (const key of graph.keys()) visit(key);
    return cycles;
}

function checkQuestGraph(quest, context, errors, warnings) {
    if (!Array.isArray(quest.nodes) || quest.nodes.length === 0) return;
    const nodeKeys = new Set();
    for (const [index, node] of quest.nodes.entries()) {
        const key = node.key ?? node.id;
        if (!key) {
            issue(errors, 'error', 'QUEST_NODE_KEY_MISSING', `quests.${quest.key}.nodes.${index}`, 'Quest graph node needs a key');
            continue;
        }
        if (nodeKeys.has(key)) issue(errors, 'error', 'QUEST_NODE_DUPLICATE', `quests.${quest.key}.nodes.${index}`, `Duplicate quest node '${key}'`);
        nodeKeys.add(key);
    }
    const edges = Array.isArray(quest.edges) ? quest.edges : [];
    for (const [index, edge] of edges.entries()) {
        if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) {
            issue(errors, 'error', 'QUEST_EDGE_REFERENCE', `quests.${quest.key}.edges.${index}`, 'Quest graph edge references an unknown node');
        }
    }
    const start = quest.nodes[0]?.key ?? quest.nodes[0]?.id;
    const reached = reachableNodes(start, [...nodeKeys].map((key) => ({ key })), edges);
    for (const key of nodeKeys) {
        if (!reached.has(key)) issue(warnings, 'warning', 'QUEST_NODE_UNREACHABLE', `quests.${quest.key}.nodes`, `Quest graph node '${key}' is unreachable`);
    }
}

function inferredSiteType(location) {
    if (['indoor', 'town', 'wilderness', 'dungeon'].includes(location.siteType)) return location.siteType;
    const type = String(location.type ?? '').toLowerCase();
    if (['dungeon', 'crypt', 'ruin', 'ruins'].includes(type) || ['dungeon', 'floor'].includes(location.layer)) return 'dungeon';
    if (['town', 'city', 'village', 'settlement'].includes(type) || location.layer === 'settlement') return 'town';
    if (['building', 'shop', 'inn', 'temple', 'house'].includes(type) || ['interior', 'room'].includes(location.layer)) return 'indoor';
    return 'wilderness';
}

export function validateGamePackage(rawPackage) {
    const errors = [];
    const warnings = [];
    const parsed = GAME_PACKAGE_SCHEMA.safeParse(rawPackage);
    if (!parsed.success) {
        for (const detail of normalizeZodIssues(parsed.error)) {
            issue(errors, 'error', 'SCHEMA', detail.path, detail.message);
        }
        return { valid: false, errors, warnings, stats: null, data: null };
    }
    const pkg = parsed.data;
    const locationKeys = new Set(pkg.locations.map((location) => location.key));
    const npcKeys = new Set(pkg.npcs.map((npc) => npc.key));
    const monsterKeys = new Set(pkg.monsters.map((monster) => monster.key));
    const itemKeys = new Set(pkg.items.map((item) => item.key));
    const skillKeys = new Set(pkg.skills.map((skill) => skill.key));
    const questKeys = new Set(pkg.quests.map((quest) => quest.key));
    const classKeys = new Set(pkg.classes.map((klass) => klass.key));
    const effectKeys = new Set(pkg.effects.map((effect) => effect.key));
    const eventKeys = new Set(pkg.events.map((event) => event.key));
    const storyNodeKeys = new Set(pkg.story.nodes.map((node) => node.key));
    const context = { locationKeys, npcKeys, monsterKeys, itemKeys, skillKeys, questKeys, classKeys, effectKeys, storyNodeKeys };

    for (const [label, keys] of Object.entries({
        locations: pkg.locations.map((x) => x.key),
        npcs: pkg.npcs.map((x) => x.key),
        monsters: pkg.monsters.map((x) => x.key),
        items: pkg.items.map((x) => x.key),
        skills: pkg.skills.map((x) => x.key),
        quests: pkg.quests.map((x) => x.key),
        classes: pkg.classes.map((x) => x.key),
        effects: pkg.effects.map((x) => x.key),
        events: pkg.events.map((x) => x.key),
        storyNodes: pkg.story.nodes.map((x) => x.key),
    })) {
        for (const key of duplicates(keys)) issue(errors, 'error', 'DUPLICATE_KEY', label, `Duplicate key '${key}' in ${label}`);
    }

    if (!locationKeys.has(pkg.world.startLocationKey)) {
        issue(errors, 'error', 'START_LOCATION_MISSING', 'world.startLocationKey', `Start location '${pkg.world.startLocationKey}' does not exist`);
    }
    if (pkg.start?.locationKey && !locationKeys.has(pkg.start.locationKey)) {
        issue(errors, 'error', 'START_LOCATION_MISSING', 'start.locationKey', `Start location '${pkg.start.locationKey}' does not exist`);
    }

    const locationByKey = new Map(pkg.locations.map((location) => [location.key, location]));
    const roadLayers = new Set(['world', 'region', 'settlement', 'dungeon']);
    const parentLayers = {
        world: [], region: ['world', 'region'], settlement: ['world', 'region', 'settlement'],
        interior: ['settlement', 'interior'], room: ['interior', 'room'],
        dungeon: ['region', 'dungeon'], floor: ['dungeon', 'floor'],
    };
    for (const [index, location] of pkg.locations.entries()) {
        const spawnKeys = (location.spawnPoints ?? []).map((point) => point.key);
        for (const duplicate of duplicates(spawnKeys)) {
            issue(errors, 'error', 'DUPLICATE_SPAWN_POINT', `locations.${index}.spawnPoints`, `Duplicate spawn point '${duplicate}'`);
        }
        if (location.parentKey) {
            if (location.parentKey === location.key) {
                issue(errors, 'error', 'PARENT_SELF', `locations.${index}.parentKey`, `Scene '${location.key}' cannot be its own parent`);
            } else {
                const parent = locationByKey.get(location.parentKey);
                if (!parent) {
                    issue(errors, 'error', 'PARENT_LOCATION_MISSING', `locations.${index}.parentKey`, `Scene '${location.key}' references unknown parent '${location.parentKey}'`);
                } else if (!(parentLayers[location.layer] ?? []).includes(parent.layer)) {
                    issue(errors, 'error', 'PARENT_LAYER_INVALID', `locations.${index}.parentKey`, `A ${location.layer} scene cannot have a ${parent.layer} parent`);
                }
            }
        } else if (['interior', 'room', 'floor'].includes(location.layer)) {
            issue(errors, 'error', 'PARENT_REQUIRED', `locations.${index}.parentKey`, `A ${location.layer} scene requires parentKey`);
        }
        const seen = new Set();
        let cursor = location;
        while (cursor?.parentKey) {
            if (seen.has(cursor.key)) {
                issue(errors, 'error', 'PARENT_CYCLE', `locations.${index}.parentKey`, `Parent hierarchy contains a cycle at '${cursor.key}'`);
                break;
            }
            seen.add(cursor.key);
            cursor = locationByKey.get(cursor.parentKey);
        }
        for (const [encounterIndex, encounter] of (location.encounters ?? []).entries()) {
            if (!encounter.key) issue(errors, 'error', 'ENCOUNTER_KEY_MISSING', `locations.${index}.encounters.${encounterIndex}.key`, 'Encounter key is required');
            for (const monster of encounter.monsters ?? []) {
                if (!monsterKeys.has(monster.monsterKey)) {
                    issue(errors, 'error', 'ENCOUNTER_MONSTER_UNKNOWN', `locations.${index}.encounters.${encounterIndex}.monsters`, `Unknown monster '${monster.monsterKey}'`);
                }
            }
        }
        if (location.randomEncounter?.enabled) {
            if (!(location.randomEncounter.monsters ?? []).length) {
                issue(errors, 'error', 'RANDOM_ENCOUNTER_EMPTY', `locations.${index}.randomEncounter.monsters`, `Random encounter on '${location.key}' has no monsters`);
            }
            const siteType = inferredSiteType(location);
            if (!['wilderness', 'dungeon'].includes(siteType)) {
                issue(errors, 'error', 'RANDOM_ENCOUNTER_SITE_INVALID', `locations.${index}.randomEncounter.enabled`, `Random encounters are allowed only in wilderness or dungeon sites; '${location.key}' is ${siteType}`);
            }
            for (const monster of location.randomEncounter.monsters ?? []) {
                if (!monsterKeys.has(monster.monsterKey)) {
                    issue(errors, 'error', 'RANDOM_MONSTER_UNKNOWN', `locations.${index}.randomEncounter.monsters`, `Unknown monster '${monster.monsterKey}'`);
                }
            }
        }
    }

    const spawnsByLayer = new Map();
    for (const [index, location] of pkg.locations.entries()) {
        if (!location.isSpawn) continue;
        const list = spawnsByLayer.get(location.layer) ?? [];
        list.push(location.key);
        spawnsByLayer.set(location.layer, list);
        if (list.length > 1) {
            issue(errors, 'error', 'SPAWN_POINT_DUPLICATE', `locations.${index}.isSpawn`, `Layer '${location.layer}' has multiple spawn points: ${list.join(', ')}`);
        }
    }

    const adjacency = new Map(pkg.locations.map((location) => [location.key, []]));
    for (const [index, location] of pkg.locations.entries()) {
        for (const [connectionIndex, connection] of location.connections.entries()) {
            if (!locationKeys.has(connection.toKey)) {
                issue(errors, 'error', 'CONNECTION_TARGET_MISSING', `locations.${index}.connections.${connectionIndex}.toKey`, `Unknown location '${connection.toKey}'`);
                continue;
            }
            const target = locationByKey.get(connection.toKey);
            if (connection.entryKey && target && !(target.spawnPoints ?? []).some((point) => point.key === connection.entryKey)) {
                issue(errors, 'error', 'ENTRY_POINT_UNKNOWN', `locations.${index}.connections.${connectionIndex}.entryKey`, `Unknown entry point '${connection.entryKey}' on '${target.key}'`);
            }
            const mode = connection.mode ?? 'walk';
            let transitionValid = true;
            if (mode === 'road' || mode === 'trail') {
                transitionValid = roadLayers.has(location.layer) && roadLayers.has(target?.layer);
            } else if (mode === 'walk') {
                transitionValid = location.layer === target?.layer && (location.parentKey ?? null) === (target?.parentKey ?? null);
            } else if (mode === 'door') {
                transitionValid = target?.parentKey === location.key || location.parentKey === target?.key;
            } else if (mode === 'stairs') {
                transitionValid = ['dungeon', 'floor'].includes(location.layer) && ['dungeon', 'floor'].includes(target?.layer);
            }
            if (!transitionValid) {
                issue(errors, 'error', 'TRANSITION_INVALID', `locations.${index}.connections.${connectionIndex}.mode`, `Mode '${mode}' is invalid from ${location.layer} '${location.key}' to ${target?.layer} '${target?.key}'`);
            }
            adjacency.get(location.key).push(connection.toKey);
            if (connection.bidirectional) adjacency.get(connection.toKey)?.push(location.key);
            checkConditionReferences(connection.condition, `locations.${index}.connections.${connectionIndex}.condition`, context, errors, warnings);
        }
        for (const [eventIndex, action] of (location.events ?? []).entries()) {
            if (action.type === 'accept_quest' && !questKeys.has(action.questKey)) {
                issue(errors, 'error', 'EVENT_QUEST_UNKNOWN', `locations.${index}.events.${eventIndex}.questKey`, `Unknown quest '${action.questKey}'`);
            }
        }
        for (const [eventIndex, eventKey] of (location.eventKeys ?? []).entries()) {
            if (!eventKeys.has(eventKey)) {
                issue(errors, 'error', 'EVENT_KEY_UNKNOWN', `locations.${index}.eventKeys.${eventIndex}`, `Scene '${location.key}' references unknown event '${eventKey}'`);
            }
        }
    }
    const reachedLocations = reachableNodes(pkg.world.startLocationKey, [...locationKeys].map((key) => ({ key })), [...adjacency.entries()].flatMap(([from, targets]) => targets.map((to) => ({ from, to }))));
    for (const key of locationKeys) {
        if (!reachedLocations.has(key)) issue(warnings, 'warning', 'LOCATION_UNREACHABLE', 'locations', `Location '${key}' cannot be reached from the start location`);
    }

    for (const [index, event] of pkg.events.entries()) {
        if (event.scope === 'scene' && !event.sceneKey) {
            issue(errors, 'error', 'EVENT_SCENE_REQUIRED', `events.${index}.sceneKey`, `Scene event '${event.key}' requires sceneKey`);
        }
        if (event.sceneKey && !locationKeys.has(event.sceneKey)) {
            issue(errors, 'error', 'EVENT_SCENE_UNKNOWN', `events.${index}.sceneKey`, `Event '${event.key}' references unknown scene '${event.sceneKey}'`);
        }
        if (event.trigger === 'interact' && event.targetKey && !npcKeys.has(event.targetKey)) {
            issue(errors, 'error', 'EVENT_TARGET_UNKNOWN', `events.${index}.targetKey`, `Event '${event.key}' targets unknown NPC '${event.targetKey}'`);
        }
        checkConditionReferences(event.condition, `events.${index}.condition`, context, errors, warnings);
        for (const [actionIndex, action] of (event.actions ?? []).entries()) {
            const path = `events.${index}.actions.${actionIndex}`;
            if (action.type === 'accept_quest' && !questKeys.has(action.questKey)) issue(errors, 'error', 'EVENT_QUEST_UNKNOWN', path, `Unknown quest '${action.questKey}'`);
            if (action.type === 'give_item' && !itemKeys.has(action.itemKey)) issue(errors, 'error', 'EVENT_ITEM_UNKNOWN', path, `Unknown item '${action.itemKey}'`);
            if (action.type === 'teleport' && !locationKeys.has(action.locationKey)) issue(errors, 'error', 'EVENT_LOCATION_UNKNOWN', path, `Unknown location '${action.locationKey}'`);
        }
    }

    for (const [index, npc] of pkg.npcs.entries()) {
        if (!locationKeys.has(npc.locationKey)) issue(errors, 'error', 'NPC_LOCATION_MISSING', `npcs.${index}.locationKey`, `NPC '${npc.key}' references unknown location '${npc.locationKey}'`);
        for (const questKey of npc.questsOffered ?? []) {
            if (!questKeys.has(questKey)) issue(errors, 'error', 'NPC_QUEST_UNKNOWN', `npcs.${index}.questsOffered`, `NPC '${npc.key}' offers unknown quest '${questKey}'`);
        }
        for (const [itemIndex, shopItem] of (npc.shop?.items ?? []).entries()) {
            if (!itemKeys.has(shopItem.itemKey)) issue(errors, 'error', 'SHOP_ITEM_UNKNOWN', `npcs.${index}.shop.items.${itemIndex}`, `Unknown item '${shopItem.itemKey}'`);
        }
        for (const [interactionIndex, interaction] of (npc.interactions ?? []).entries()) {
            if (interaction.questKey && !questKeys.has(interaction.questKey)) {
                issue(errors, 'error', 'INTERACTION_QUEST_UNKNOWN', `npcs.${index}.interactions.${interactionIndex}.questKey`, `Unknown quest '${interaction.questKey}'`);
            }
            checkConditionReferences(interaction.condition, `npcs.${index}.interactions.${interactionIndex}.condition`, context, errors, warnings);
        }
        for (const skillKey of npc.combat?.skills ?? []) {
            if (!skillKeys.has(skillKey)) issue(errors, 'error', 'NPC_SKILL_UNKNOWN', `npcs.${index}.combat.skills`, `Unknown skill '${skillKey}'`);
        }
    }

    for (const [index, monster] of pkg.monsters.entries()) {
        for (const skillKey of monster.skills ?? []) {
            if (!skillKeys.has(skillKey)) issue(errors, 'error', 'MONSTER_SKILL_UNKNOWN', `monsters.${index}.skills`, `Unknown skill '${skillKey}'`);
        }
        for (const [dropIndex, drop] of (monster.drops ?? []).entries()) {
            if (!itemKeys.has(drop.itemKey)) issue(errors, 'error', 'DROP_ITEM_UNKNOWN', `monsters.${index}.drops.${dropIndex}.itemKey`, `Unknown item '${drop.itemKey}'`);
            if (drop.max < drop.min) issue(errors, 'error', 'DROP_RANGE', `monsters.${index}.drops.${dropIndex}`, 'Drop max is less than min');
        }
    }

    for (const [index, skill] of pkg.skills.entries()) {
        for (const classKey of skill.classes ?? []) {
            if (!classKeys.has(classKey)) issue(warnings, 'warning', 'SKILL_CLASS_UNKNOWN', `skills.${index}.classes`, `Skill '${skill.key}' references unknown class '${classKey}'`);
        }
        if (skill.effects?.applyStatus && !effectKeys.has(skill.effects.applyStatus.effectKey)) {
            issue(warnings, 'warning', 'SKILL_EFFECT_UNKNOWN', `skills.${index}.effects.applyStatus`, `Unknown status effect '${skill.effects.applyStatus.effectKey}'`);
        }
        if (skill.formula) {
            const report = validateFormula(skill.formula);
            if (!report.valid) issue(errors, 'error', 'INVALID_FORMULA', `skills.${index}.formula`, report.message);
        }
    }

    for (const [index, klass] of pkg.classes.entries()) {
        for (const starting of klass.startingItems ?? []) {
            if (!itemKeys.has(starting.itemKey)) issue(errors, 'error', 'CLASS_ITEM_UNKNOWN', `classes.${index}.startingItems`, `Unknown item '${starting.itemKey}'`);
        }
        for (const skillKey of klass.startingSkills ?? []) {
            if (!skillKeys.has(skillKey)) issue(errors, 'error', 'CLASS_SKILL_UNKNOWN', `classes.${index}.startingSkills`, `Unknown skill '${skillKey}'`);
        }
        for (const node of klass.skillTree ?? []) {
            if (!skillKeys.has(node.skillKey)) issue(warnings, 'warning', 'SKILL_TREE_UNKNOWN', `classes.${index}.skillTree`, `Unknown skill '${node.skillKey}'`);
        }
    }

    for (const [index, quest] of pkg.quests.entries()) {
        for (const prerequisite of quest.prerequisites ?? []) {
            if (!questKeys.has(prerequisite)) issue(errors, 'error', 'QUEST_PREREQUISITE_UNKNOWN', `quests.${index}.prerequisites`, `Unknown prerequisite quest '${prerequisite}'`);
        }
        if (quest.start?.npcKey && !npcKeys.has(quest.start.npcKey)) issue(errors, 'error', 'QUEST_START_NPC_UNKNOWN', `quests.${index}.start.npcKey`, `Unknown NPC '${quest.start.npcKey}'`);
        if (quest.start?.locationKey && !locationKeys.has(quest.start.locationKey)) issue(errors, 'error', 'QUEST_START_LOCATION_UNKNOWN', `quests.${index}.start.locationKey`, `Unknown location '${quest.start.locationKey}'`);
        if (quest.turnIn?.npcKey && !npcKeys.has(quest.turnIn.npcKey)) issue(errors, 'error', 'QUEST_TURNIN_NPC_UNKNOWN', `quests.${index}.turnIn.npcKey`, `Unknown NPC '${quest.turnIn.npcKey}'`);
        for (const [stageIndex, stage] of quest.stages.entries()) {
            for (const [objectiveIndex, objective] of stage.objectives.entries()) {
                if (objective.type === 'kill' && objective.targetKey && !monsterKeys.has(objective.targetKey)) {
                    issue(errors, 'error', 'OBJECTIVE_MONSTER_UNKNOWN', `quests.${index}.stages.${stageIndex}.objectives.${objectiveIndex}`, `Unknown monster '${objective.targetKey}'`);
                }
                if (objective.type === 'collect' && objective.targetKey && !itemKeys.has(objective.targetKey)) {
                    issue(errors, 'error', 'OBJECTIVE_ITEM_UNKNOWN', `quests.${index}.stages.${stageIndex}.objectives.${objectiveIndex}`, `Unknown item '${objective.targetKey}'`);
                }
                if (objective.type === 'visit' && objective.targetKey && !locationKeys.has(objective.targetKey)) {
                    issue(errors, 'error', 'OBJECTIVE_LOCATION_UNKNOWN', `quests.${index}.stages.${stageIndex}.objectives.${objectiveIndex}`, `Unknown location '${objective.targetKey}'`);
                }
                if (objective.type === 'talk' && objective.targetKey && !npcKeys.has(objective.targetKey)) {
                    issue(errors, 'error', 'OBJECTIVE_NPC_UNKNOWN', `quests.${index}.stages.${stageIndex}.objectives.${objectiveIndex}`, `Unknown NPC '${objective.targetKey}'`);
                }
            }
        }
        for (const [itemIndex, reward] of (quest.rewards?.items ?? []).entries()) {
            if (!itemKeys.has(reward.itemKey)) issue(errors, 'error', 'QUEST_REWARD_ITEM_UNKNOWN', `quests.${index}.rewards.items.${itemIndex}`, `Unknown item '${reward.itemKey}'`);
        }
        for (const skillKey of quest.rewards?.skills ?? []) {
            if (!skillKeys.has(skillKey)) issue(errors, 'error', 'QUEST_REWARD_SKILL_UNKNOWN', `quests.${index}.rewards.skills`, `Unknown skill '${skillKey}'`);
        }
        checkQuestGraph(quest, context, errors, warnings);
    }
    for (const cycle of detectDependencyCycles(pkg.quests)) {
        issue(errors, 'error', 'QUEST_DEPENDENCY_CYCLE', 'quests', `Quest dependency cycle: ${cycle.join(' -> ')}`);
    }

    if (!storyNodeKeys.has(pkg.story.startNodeKey)) {
        issue(errors, 'error', 'STORY_START_MISSING', 'story.startNodeKey', `Start story node '${pkg.story.startNodeKey}' does not exist`);
    }
    for (const ending of pkg.story.endings) {
        if (!storyNodeKeys.has(ending)) issue(errors, 'error', 'STORY_ENDING_MISSING', 'story.endings', `Ending node '${ending}' does not exist`);
    }
    for (const [index, node] of pkg.story.nodes.entries()) {
        if (node.sceneKey && !locationKeys.has(node.sceneKey)) {
            issue(errors, 'error', 'STORY_SCENE_UNKNOWN', `story.nodes.${index}.sceneKey`, `Unknown scene '${node.sceneKey}'`);
        }
        checkConditionReferences(node.conditions, `story.nodes.${index}.conditions`, context, errors, warnings);
    }
    for (const [index, edge] of pkg.story.edges.entries()) {
        if (!storyNodeKeys.has(edge.from)) issue(errors, 'error', 'STORY_EDGE_FROM_UNKNOWN', `story.edges.${index}.from`, `Unknown node '${edge.from}'`);
        if (!storyNodeKeys.has(edge.to)) issue(errors, 'error', 'STORY_EDGE_TO_UNKNOWN', `story.edges.${index}.to`, `Unknown node '${edge.to}'`);
        checkConditionReferences(edge.condition, `story.edges.${index}.condition`, context, errors, warnings);
    }
    const reachedStory = reachableNodes(pkg.story.startNodeKey, pkg.story.nodes, pkg.story.edges);
    for (const node of pkg.story.nodes) {
        if (!reachedStory.has(node.key)) {
            issue(errors, 'error', 'STORY_NODE_UNREACHABLE', 'story.nodes', `Story node '${node.key}' is unreachable from '${pkg.story.startNodeKey}'`);
        }
    }
    const endingSet = new Set(pkg.story.endings);
    const outgoing = new Set(pkg.story.edges.map((edge) => edge.from));
    for (const node of pkg.story.nodes) {
        if (!outgoing.has(node.key) && !endingSet.has(node.key) && !['ending'].includes(node.type)) {
            issue(errors, 'error', 'STORY_DEAD_END', 'story.nodes', `Story node '${node.key}' has no outgoing edge and is not an ending`);
        }
    }
    if (!pkg.story.endings.length) {
        issue(errors, 'error', 'STORY_NO_ENDING', 'story.endings', 'The story must declare at least one ending');
    } else {
        const reachableEnding = pkg.story.endings.some((ending) => reachedStory.has(ending));
        if (!reachableEnding) issue(errors, 'error', 'STORY_ENDING_UNREACHABLE', 'story.endings', 'No declared ending is reachable from the start node');
    }

    for (const [name, formula] of Object.entries(pkg.rules.formulas ?? {})) {
        const report = validateFormula(formula);
        if (!report.valid) issue(errors, 'error', 'INVALID_FORMULA', `rules.formulas.${name}`, report.message);
    }
    for (const [stat, cap] of Object.entries(pkg.rules.statCaps ?? {})) {
        if (!Number.isFinite(cap) || cap <= 0) issue(errors, 'error', 'STAT_CAP_INVALID', `rules.statCaps.${stat}`, 'Stat cap must be a positive number');
    }

    const stats = {
        locations: pkg.locations.length,
        npcs: pkg.npcs.length,
        monsters: pkg.monsters.length,
        items: pkg.items.length,
        skills: pkg.skills.length,
        quests: pkg.quests.length,
        events: pkg.events.length,
        storyNodes: pkg.story.nodes.length,
        storyEdges: pkg.story.edges.length,
        classes: pkg.classes.length,
        endings: pkg.story.endings.length,
        reachableLocations: reachedLocations.size,
        reachableStoryNodes: reachedStory.size,
    };
    return { valid: errors.length === 0, errors, warnings, stats, data: parsed.data };
}

export function normalizeConnections(pkg) {
    const edges = [];
    const seen = new Set();
    for (const location of pkg.locations) {
        for (const connection of location.connections ?? []) {
            const push = (from, to) => {
                const signature = `${from}->${to}`;
                if (seen.has(signature)) return;
                seen.add(signature);
                edges.push({
                    from,
                    to,
                    travelCost: connection.travelCost ?? 0,
                    mode: connection.mode ?? 'walk',
                    entryKey: connection.entryKey ?? null,
                    condition: connection.condition ?? {},
                    label: connection.label ?? '',
                });
            };
            push(location.key, connection.toKey);
            if (connection.bidirectional) push(connection.toKey, location.key);
        }
    }
    return edges;
}
