import { nowIso } from './util.js';
import { normalizeConnections } from './validation.js';

function worldId(versionId) {
    return `world:${versionId}`;
}

export function locationId(versionId, key) {
    return `loc:${versionId}:${key}`;
}

export function templateId(versionId, kind, key) {
    return `tpl:${versionId}:${kind}:${key}`;
}

export function itemDefinitionId(versionId, key) {
    return `item:${versionId}:${key}`;
}

export function skillDefinitionId(versionId, key) {
    return `skill:${versionId}:${key}`;
}

export function effectDefinitionId(versionId, key) {
    return `effect:${versionId}:${key}`;
}

export function storyNodeId(versionId, key) {
    return `story:${versionId}:${key}`;
}

export function questDefinitionId(versionId, key) {
    return `quest:${versionId}:${key}`;
}

export function eventDefinitionId(versionId, key) {
    return `event:${versionId}:${key}`;
}

export function materializeGameVersion(db, { projectId, versionId, pkg }) {
    const timestamp = nowIso();
    const wid = worldId(versionId);
    const locationIds = new Map();

    db.prepare(`
        INSERT INTO worlds (id, project_id, game_version_id, world_key, name, description, start_location_id, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wid, projectId, versionId, pkg.world.key, pkg.world.name, pkg.world.description ?? '', null, JSON.stringify(pkg.world));

    for (const location of pkg.locations) {
        const id = locationId(versionId, location.key);
        locationIds.set(location.key, id);
        db.prepare(`
            INSERT INTO locations (
                id, world_id, location_key, name, type, layer, description, parent_id, parent_key, spawn_points_json,
                map_x, map_y, region, image, discovered_by_default, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, wid, location.key, location.name, location.type ?? 'town', location.layer ?? 'region',
            location.description ?? '', location.parentKey ?? null, JSON.stringify(location.spawnPoints ?? []),
            Number(location.map?.x ?? 0), Number(location.map?.y ?? 0),
            location.region ?? '', location.image ?? null, location.discoveredByDefault ? 1 : 0, JSON.stringify(location),
        );
    }
    for (const location of pkg.locations) {
        if (!location.parentKey) continue;
        const parentId = locationIds.get(location.parentKey);
        if (parentId) db.prepare('UPDATE locations SET parent_id = ? WHERE id = ?').run(parentId, locationIds.get(location.key));
    }
    db.prepare('UPDATE worlds SET start_location_id = ? WHERE id = ?')
        .run(locationIds.get(pkg.world.startLocationKey) ?? null, wid);

    for (const [index, edge] of normalizeConnections(pkg).entries()) {
        const fromId = locationIds.get(edge.from);
        const toId = locationIds.get(edge.to);
        if (!fromId || !toId) continue;
        db.prepare(`
            INSERT INTO location_connections (
                id, world_id, from_location_id, to_location_id, travel_cost, mode, entry_key, condition_json, bidirectional, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`conn:${versionId}:${index}`, wid, fromId, toId, edge.travelCost, edge.mode ?? 'walk', edge.entryKey ?? null, JSON.stringify(edge.condition), 0, JSON.stringify(edge));
    }

    for (const event of pkg.events ?? []) {
        db.prepare(`
            INSERT INTO event_definitions (
                id, game_version_id, event_key, name, scope, scene_key, trigger, target_key,
                priority, once, condition_json, actions_json, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            eventDefinitionId(versionId, event.key), versionId, event.key, event.name,
            event.scope ?? 'scene', event.sceneKey ?? null, event.trigger ?? 'enter',
            event.targetKey ?? null, Number(event.priority ?? 0), event.once === false ? 0 : 1,
            JSON.stringify(event.condition ?? {}), JSON.stringify(event.actions ?? []), JSON.stringify(event),
        );
    }

    for (const klass of pkg.classes) {
        db.prepare(`
            INSERT INTO entity_templates (id, game_version_id, template_key, kind, name, level, data_json)
            VALUES (?, ?, ?, 'class', ?, 1, ?)
        `).run(templateId(versionId, 'class', klass.key), versionId, klass.key, klass.name, JSON.stringify(klass));
    }
    for (const npc of pkg.npcs) {
        db.prepare(`
            INSERT INTO entity_templates (id, game_version_id, template_key, kind, name, level, data_json)
            VALUES (?, ?, ?, 'npc', ?, 1, ?)
        `).run(templateId(versionId, 'npc', npc.key), versionId, npc.key, npc.name, JSON.stringify(npc));
    }
    for (const monster of pkg.monsters) {
        db.prepare(`
            INSERT INTO entity_templates (id, game_version_id, template_key, kind, name, level, data_json)
            VALUES (?, ?, ?, 'monster', ?, ?, ?)
        `).run(templateId(versionId, 'monster', monster.key), versionId, monster.key, monster.name, monster.level ?? 1, JSON.stringify(monster));
    }

    for (const item of pkg.items) {
        db.prepare(`
            INSERT INTO item_definitions (
                id, game_version_id, item_key, name, kind, rarity, description, price,
                stackable, max_stack, slot, data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            itemDefinitionId(versionId, item.key), versionId, item.key, item.name, item.kind, item.rarity ?? 'common',
            item.description ?? '', item.price ?? 0, item.stackable ? 1 : 0, item.maxStack ?? 99,
            item.slot ?? null, JSON.stringify(item),
        );
    }
    for (const skill of pkg.skills) {
        db.prepare(`
            INSERT INTO skill_definitions (id, game_version_id, skill_key, name, category, mp_cost, cooldown, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            skillDefinitionId(versionId, skill.key), versionId, skill.key, skill.name,
            skill.category ?? 'active', skill.mpCost ?? 0, skill.cooldown ?? 0, JSON.stringify(skill),
        );
    }
    for (const effect of pkg.effects) {
        db.prepare(`
            INSERT INTO status_effect_definitions (id, game_version_id, effect_key, name, kind, data_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(effectDefinitionId(versionId, effect.key), versionId, effect.key, effect.name, effect.kind ?? 'debuff', JSON.stringify(effect));
    }

    const storyKey = pkg.story.key;
    for (const node of pkg.story.nodes) {
        db.prepare(`
            INSERT INTO story_nodes (id, game_version_id, node_key, story_key, title, type, text, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(storyNodeId(versionId, node.key), versionId, node.key, storyKey, node.title, node.type ?? 'scene', node.text ?? '', JSON.stringify(node));
    }
    for (const [index, edge] of pkg.story.edges.entries()) {
        db.prepare(`
            INSERT INTO story_edges (
                id, game_version_id, edge_key, story_key, from_node_key, to_node_key,
                label, condition_json, actions_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            `sedge:${versionId}:${edge.key ?? index}`, versionId, edge.key ?? `edge_${index}`, storyKey,
            edge.from, edge.to, edge.label ?? '', JSON.stringify(edge.condition ?? {}), JSON.stringify(edge.actions ?? []),
        );
    }

    for (const quest of pkg.quests) {
        const qid = questDefinitionId(versionId, quest.key);
        db.prepare(`
            INSERT INTO quest_definitions (id, game_version_id, quest_key, name, type, description, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(qid, versionId, quest.key, quest.name, quest.type ?? 'side', quest.description ?? '', JSON.stringify(quest));
        for (const node of quest.nodes ?? []) {
            const nodeKey = node.key ?? node.id;
            db.prepare(`
                INSERT INTO quest_nodes (id, quest_definition_id, node_key, title, type, data_json)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(`qnode:${versionId}:${quest.key}:${nodeKey}`, qid, nodeKey, node.title ?? nodeKey, node.type ?? 'stage', JSON.stringify(node));
        }
        for (const [index, edge] of (quest.edges ?? []).entries()) {
            db.prepare(`
                INSERT INTO quest_edges (id, quest_definition_id, edge_key, from_node_key, to_node_key, condition_json)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                `qedge:${versionId}:${quest.key}:${edge.key ?? index}`, qid, edge.key ?? `edge_${index}`,
                edge.from, edge.to, JSON.stringify(edge.condition ?? {}),
            );
        }
    }

    return {
        worldId: wid,
        locationIds,
        counts: {
            locations: pkg.locations.length,
            connections: normalizeConnections(pkg).length,
            npcs: pkg.npcs.length,
            monsters: pkg.monsters.length,
            items: pkg.items.length,
            skills: pkg.skills.length,
            quests: pkg.quests.length,
            storyNodes: pkg.story.nodes.length,
            createdAt: timestamp,
        },
    };
}
