import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import {
    addExperience, createNpcEntity, createPlayerEntity, expToNext, getEntityView, getPlayer,
    unlockEligibleSkills, unlockSkill,
} from './stats.js';
import { addItem, equipItem, listInventory } from './inventory.js';
import { ensureQuestInstances, activeQuestSummary, listQuests } from './quests.js';
import { startStory, storyView } from './story.js';
import { getCampaignLocation, getConnections, mapView } from './world.js';
import { evaluateCondition } from './conditions.js';
import { ensureEncounterSpawns } from './encounters.js';
import { templateId } from './materializer.js';
import {
    asJson, hashObject, insertEvent, nowIso, parseJson, uuid, withTransaction,
} from './util.js';

const SNAPSHOT_TABLES = [
    'entities', 'entity_stats', 'inventory', 'equipment_slots', 'entity_skills',
    'quest_instances', 'location_discoveries', 'encounter_spawns', 'campaign_variables',
    'status_effect_instances', 'combat_sessions', 'combat_participants', 'combat_actions',
    'narrative_state',
];

const SNAPSHOT_QUERIES = {
    entities: 'SELECT * FROM entities WHERE campaign_id = ?',
    entity_stats: 'SELECT s.* FROM entity_stats s JOIN entities e ON e.id = s.entity_id WHERE e.campaign_id = ?',
    inventory: 'SELECT * FROM inventory WHERE campaign_id = ?',
    equipment_slots: 'SELECT s.* FROM equipment_slots s JOIN entities e ON e.id = s.entity_id WHERE e.campaign_id = ?',
    entity_skills: 'SELECT s.* FROM entity_skills s JOIN entities e ON e.id = s.entity_id WHERE e.campaign_id = ?',
    quest_instances: 'SELECT * FROM quest_instances WHERE campaign_id = ?',
    location_discoveries: 'SELECT * FROM location_discoveries WHERE campaign_id = ?',
    encounter_spawns: 'SELECT * FROM encounter_spawns WHERE campaign_id = ?',
    campaign_variables: 'SELECT * FROM campaign_variables WHERE campaign_id = ?',
    status_effect_instances: 'SELECT * FROM status_effect_instances WHERE campaign_id = ?',
    combat_sessions: 'SELECT * FROM combat_sessions WHERE campaign_id = ?',
    combat_participants: 'SELECT p.* FROM combat_participants p JOIN combat_sessions s ON s.id = p.combat_session_id WHERE s.campaign_id = ?',
    combat_actions: 'SELECT a.* FROM combat_actions a JOIN combat_sessions s ON s.id = a.combat_session_id WHERE s.campaign_id = ?',
    narrative_state: 'SELECT * FROM narrative_state WHERE campaign_id = ?',
};

const RESTORE_DELETE_ORDER = [
    'status_effect_instances', 'combat_actions', 'combat_participants', 'combat_sessions',
    'equipment_slots', 'inventory', 'entity_skills', 'quest_instances',
    'location_discoveries', 'encounter_spawns', 'campaign_variables', 'narrative_state', 'entities',
];

const DELETE_QUERIES = {
    entities: 'DELETE FROM entities WHERE campaign_id = ?',
    entity_stats: 'DELETE FROM entity_stats WHERE entity_id IN (SELECT id FROM entities WHERE campaign_id = ?)',
    equipment_slots: 'DELETE FROM equipment_slots WHERE entity_id IN (SELECT id FROM entities WHERE campaign_id = ?)',
    entity_skills: 'DELETE FROM entity_skills WHERE entity_id IN (SELECT id FROM entities WHERE campaign_id = ?)',
    combat_participants: 'DELETE FROM combat_participants WHERE combat_session_id IN (SELECT id FROM combat_sessions WHERE campaign_id = ?)',
    combat_actions: 'DELETE FROM combat_actions WHERE combat_session_id IN (SELECT id FROM combat_sessions WHERE campaign_id = ?)',
};

const columnCache = new Map();
function tableColumns(db, table) {
    if (!columnCache.has(table)) {
        columnCache.set(table, db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
    }
    return columnCache.get(table);
}

function insertRow(db, table, row) {
    const allowed = new Set(tableColumns(db, table));
    const columns = Object.keys(row).filter((column) => allowed.has(column));
    if (!columns.length) return;
    db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => row[column]));
}

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

export function campaignView(db, campaignId) {
    const campaign = campaignRow(db, campaignId);
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const version = db.prepare('SELECT id, version, status, published_at FROM game_versions WHERE id = ?').get(campaign.game_version_id);
    const bindings = db.prepare('SELECT * FROM chat_bindings WHERE campaign_id = ? ORDER BY last_seen_at DESC').all(campaignId);
    return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        version: campaign.version,
        createdAt: campaign.created_at,
        updatedAt: campaign.updated_at,
        lastPlayedAt: campaign.last_played_at,
        world: world ? { id: world.id, key: world.world_key, name: world.name, description: world.description } : null,
        gameVersion: version ?? null,
        playerEntityId: campaign.player_entity_id,
        currentLocationId: campaign.current_location_id,
        gameState: parseJson(campaign.game_state_json, {}),
        bindings: bindings.map((binding) => ({
            id: binding.id, chatKey: binding.chat_key, characterName: binding.character_name, lastSeenAt: binding.last_seen_at,
        })),
    };
}

export function createCampaign(db, input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('Campaign name is required');
    let version;
    if (input.gameVersionId) {
        version = db.prepare('SELECT * FROM game_versions WHERE id = ?').get(input.gameVersionId);
    } else {
        version = db.prepare("SELECT * FROM game_versions WHERE status = 'published' ORDER BY published_at DESC LIMIT 1").get();
    }
    if (!version) throw new NotFoundError('No published game version is available. Build and publish a game in Studio first.', 'NO_PUBLISHED_VERSION');
    if (version.status !== 'published') throw new ConflictError('Campaigns can only be created from a published game version', 'VERSION_NOT_PUBLISHED');
    const pkg = parseJson(version.package_json, null);
    if (!pkg) throw new ValidationError('Game version package is corrupt');

    const world = db.prepare('SELECT * FROM worlds WHERE game_version_id = ?').get(version.id);
    if (!world) throw new NotFoundError('World for this game version is missing', 'WORLD_NOT_FOUND');
    const startLocation = db.prepare('SELECT * FROM locations WHERE world_id = ? AND location_key = ?')
        .get(world.id, pkg.world.startLocationKey);
    if (!startLocation) throw new NotFoundError('Start location is missing from the materialized game version', 'START_LOCATION_MISSING');

    const classKey = String(input.classKey ?? pkg.classes[0]?.key ?? 'adventurer');
    const classAsset = (pkg.classes ?? []).find((klass) => klass.key === classKey);
    if (!classAsset) throw new ValidationError(`Unknown class '${classKey}'`);
    const classTemplate = db.prepare('SELECT * FROM entity_templates WHERE id = ?')
        .get(templateId(version.id, 'class', classKey));

    const campaignId = uuid('cmp_');
    const timestamp = nowIso();
    return withTransaction(db, () => {
        db.prepare(`
            INSERT INTO campaigns (
                id, world_id, game_version_id, name, status, player_entity_id, current_location_id,
                game_state_json, version, created_at, updated_at, last_played_at
            ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, 1, ?, ?, ?)
        `).run(campaignId, world.id, version.id, name, startLocation.id, asJson({
            flags: [],
            story: null,
            counters: {},
            integrations: {},
        }), timestamp, timestamp, timestamp);

        const playerId = createPlayerEntity(db, {
            campaignId,
            name: input.playerName ?? input.player?.name ?? 'Hero',
            classKey,
            classData: classAsset,
            templateId: classTemplate?.id ?? null,
            locationId: startLocation.id,
        });
        db.prepare('UPDATE campaigns SET player_entity_id = ? WHERE id = ?').run(playerId, campaignId);
        const startingGold = Number(pkg.rules?.startingGold ?? 50) + Number(input.startingGold ?? 0);
        db.prepare('UPDATE entities SET gold = ? WHERE id = ?').run(startingGold, playerId);

        for (const starting of classAsset.startingItems ?? []) {
            addItem(db, campaignId, playerId, starting.itemKey, starting.quantity ?? 1);
        }
        const firstWeapon = listInventory(db, campaignId, playerId).find((item) => item.kind === 'weapon');
        if (firstWeapon) equipItem(db, campaignId, playerId, firstWeapon.inventoryId);
        for (const skillKey of classAsset.startingSkills ?? []) {
            unlockSkill(db, playerId, skillKey, campaignId);
        }
        unlockEligibleSkills(db, playerId, campaignId);

        const npcTemplates = db.prepare("SELECT * FROM entity_templates WHERE game_version_id = ? AND kind = 'npc'").all(version.id);
        for (const template of npcTemplates) {
            const definition = parseJson(template.data_json, {});
            const location = db.prepare('SELECT id FROM locations WHERE world_id = ? AND location_key = ?')
                .get(world.id, definition.locationKey);
            if (!location) continue;
            createNpcEntity(db, { campaignId, template: { ...template, data: definition }, locationId: location.id });
        }

        db.prepare('INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?)')
            .run(campaignId, startLocation.id, timestamp);
        const defaults = db.prepare('SELECT id FROM locations WHERE world_id = ? AND discovered_by_default = 1').all(world.id);
        for (const location of defaults) {
            db.prepare(`
                INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?)
                ON CONFLICT(campaign_id, location_id) DO NOTHING
            `).run(campaignId, location.id, timestamp);
        }

        ensureEncounterSpawns(db, campaignId);
        ensureQuestInstances(db, campaignId);
        const story = startStory(db, campaignId);
        const player = getPlayer(db, campaignId);
        const computed = getEntityView(db, player.id);
        const snapshot = saveSnapshotInternal(db, campaignId, 'Campaign created', true);
        insertEvent(db, campaignId, 'campaign.created', { name, gameVersionId: version.id, classKey, playerId });
        return {
            ...campaignView(db, campaignId),
            player: computed,
            location: getCampaignLocation(db, campaignId),
            story: story.view,
            snapshot,
            nextExp: expToNext(pkg.rules, computed.level),
        };
    });
}

export function listCampaigns(db) {
    return db.prepare('SELECT * FROM campaigns ORDER BY last_played_at DESC, created_at DESC').all().map((row) => {
        const player = row.player_entity_id ? db.prepare('SELECT name, level, hp, mp FROM entities WHERE id = ?').get(row.player_entity_id) : null;
        const world = db.prepare('SELECT name FROM worlds WHERE id = ?').get(row.world_id);
        const location = row.current_location_id ? db.prepare('SELECT name FROM locations WHERE id = ?').get(row.current_location_id) : null;
        const bindings = db.prepare('SELECT COUNT(*) AS count FROM chat_bindings WHERE campaign_id = ?').get(row.id).count;
        return {
            id: row.id,
            name: row.name,
            status: row.status,
            worldName: world?.name,
            locationName: location?.name,
            player,
            bindings,
            createdAt: row.created_at,
            lastPlayedAt: row.last_played_at,
        };
    });
}

export function listChatCampaigns(db) {
    return db.prepare(`
        SELECT b.chat_key, b.character_name, b.last_seen_at, c.id AS campaign_id, c.name AS campaign_name
        FROM chat_bindings b JOIN campaigns c ON c.id = b.campaign_id
        ORDER BY b.last_seen_at DESC
    `).all();
}

export function bindCampaignToChat(db, campaignId, chatKey, characterName = '') {
    if (!chatKey || String(chatKey).length > 500) throw new ValidationError('A valid chat key is required');
    campaignRow(db, campaignId);
    const now = nowIso();
    return withTransaction(db, () => {
        const existing = db.prepare('SELECT * FROM chat_bindings WHERE chat_key = ?').get(chatKey);
        if (existing) {
            db.prepare('UPDATE chat_bindings SET campaign_id = ?, character_name = ?, last_seen_at = ? WHERE id = ?')
                .run(campaignId, characterName, now, existing.id);
            return { id: existing.id, campaignId, chatKey, characterName, rebound: true };
        }
        const id = uuid('bind_');
        db.prepare(`
            INSERT INTO chat_bindings (id, campaign_id, chat_key, character_name, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, campaignId, chatKey, characterName, now, now);
        return { id, campaignId, chatKey, characterName, rebound: false };
    });
}

export function unbindChat(db, chatKey) {
    const result = db.prepare('DELETE FROM chat_bindings WHERE chat_key = ?').run(chatKey);
    return { ok: result.changes > 0, chatKey };
}

export function campaignForChat(db, chatKey) {
    const row = db.prepare(`
        SELECT c.*, b.character_name, b.last_seen_at FROM chat_bindings b
        JOIN campaigns c ON c.id = b.campaign_id WHERE b.chat_key = ?
    `).get(chatKey);
    if (!row) return null;
    db.prepare('UPDATE chat_bindings SET last_seen_at = ? WHERE chat_key = ?').run(nowIso(), chatKey);
    return { campaign: campaignView(db, row.id), characterName: row.character_name };
}

function dashboardEntity(db, id) {
    const view = getEntityView(db, id);
    return {
        id: view.id,
        key: view.key,
        name: view.name,
        kind: view.kind,
        level: view.level,
        hp: view.hp,
        mp: view.mp,
        xp: view.xp,
        xpToNext: view.xpToNext,
        gold: view.gold,
        alive: view.alive,
        maxHp: view.stats.maxHp,
        maxMp: view.stats.maxMp,
        portrait: view.data?.portrait ?? null,
        classKey: view.data?.classKey ?? null,
        npcKey: view.data?.npcKey ?? String(view.key ?? '').replace(/^npc:/, ''),
        title: view.data?.title ?? '',
        joinable: Boolean(view.data?.joinable),
        party: Boolean(view.data?.party),
        shop: Boolean(view.data?.shop),
        questsOffered: Array.isArray(view.data?.questsOffered) ? view.data.questsOffered : [],
        relation: Number(view.data?.relations?.player ?? 0),
    };
}

function dashboardEffects(db, campaignId, entityId) {
    return db.prepare(`
        SELECT s.effect_key, s.duration, s.stacks, COALESCE(d.name, s.effect_key) AS name
        FROM status_effect_instances s
        LEFT JOIN status_effect_definitions d ON d.id = s.effect_definition_id
        WHERE s.campaign_id = ? AND s.entity_id = ? ORDER BY s.effect_key
    `).all(campaignId, entityId).map((row) => ({
        key: row.effect_key, name: row.name, duration: Number(row.duration), stacks: Number(row.stacks),
    }));
}

function dashboardCombat(db, session) {
    if (!session) return null;
    const participants = db.prepare(`
        SELECT id, name, side, hp, max_hp, mp, max_mp, alive, is_player, statuses_json
        FROM combat_participants WHERE combat_session_id = ? ORDER BY order_index, initiative DESC
    `).all(session.id).map((row) => ({
        id: row.id,
        name: row.name,
        side: row.side,
        hp: Number(row.hp),
        maxHp: Number(row.max_hp),
        mp: Number(row.mp),
        maxMp: Number(row.max_mp),
        alive: Boolean(row.alive),
        isPlayer: Boolean(row.is_player),
        statuses: parseJson(row.statuses_json, []).map((entry) => entry.name ?? entry.key ?? 'status'),
    }));
    const current = participants.find((entry) => entry.id === session.current_actor_id) ?? null;
    return {
        id: session.id,
        status: session.status,
        round: Number(session.round),
        encounterKey: session.encounter_key,
        locationId: session.location_id ?? null,
        currentActor: current ? current.name : null,
        isPlayerTurn: Boolean(current?.isPlayer && session.status === 'active'),
        participants,
        enemies: participants.filter((entry) => entry.side === 'enemy' && entry.alive),
        allies: participants.filter((entry) => entry.side === 'party' && entry.alive),
    };
}

export function getDashboard(db, campaignId) {
    const campaign = campaignView(db, campaignId);
    const player = getPlayer(db, campaignId);
    const playerView = getEntityView(db, player.id);
    const pkg = parseJson(db.prepare('SELECT package_json FROM game_versions WHERE id = ?').get(campaign.gameVersion.id).package_json, {});
    const pendingCombat = db.prepare(`
        SELECT id, status, round, encounter_key, location_id, current_actor_id, started_at, updated_at FROM combat_sessions
        WHERE campaign_id = ? AND status IN ('pending', 'active') ORDER BY updated_at DESC LIMIT 1
    `).get(campaignId);
    const recentSave = db.prepare(`
        SELECT id, label, automatic, created_at, hash FROM save_snapshots WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(campaignId);
    const activeQuests = activeQuestSummary(db, campaignId);
    const location = getCampaignLocation(db, campaignId);

    const partyIds = db.prepare(`
        SELECT id FROM entities WHERE campaign_id = ? AND kind = 'npc'
        AND json_extract(data_json, '$.party') = 1 ORDER BY level DESC, name
    `).all(campaignId).map((row) => row.id);
    const party = partyIds.map((id) => dashboardEntity(db, id));
    const partyIdSet = new Set(partyIds);
    const nearbyNpcs = db.prepare(`
        SELECT id FROM entities WHERE campaign_id = ? AND kind = 'npc' AND location_id = ? ORDER BY name
    `).all(campaignId, location.id).filter((row) => !partyIdSet.has(row.id))
        .map((row) => dashboardEntity(db, row.id));

    const exits = getConnections(db, campaignId).filter((connection) => connection.fromId === location.id).map((connection) => {
        const target = db.prepare('SELECT layer, type FROM locations WHERE world_id = (SELECT world_id FROM campaigns WHERE id = ?) AND location_key = ?')
            .get(campaignId, connection.toKey);
        const conditionPassed = evaluateCondition(db, campaignId, connection.condition, { type: 'movement', targetKey: connection.toKey });
        const affordable = Number(playerView.gold) >= Number(connection.travelCost ?? 0);
        return {
            key: connection.toKey,
            name: connection.toName,
            mode: connection.mode ?? 'walk',
            travelCost: Number(connection.travelCost ?? 0),
            layer: target?.layer ?? null,
            type: target?.type ?? null,
            discovered: Boolean(connection.toDiscovered),
            available: conditionPassed && affordable,
            lockedReason: !conditionPassed ? 'condition' : (!affordable ? 'gold' : null),
        };
    });

    const inventory = db.prepare(`
        SELECT COUNT(*) AS stacks, COALESCE(SUM(quantity), 0) AS items FROM inventory WHERE campaign_id = ?
    `).get(campaignId);
    const journal = db.prepare(`
        SELECT type, payload_json, created_at FROM game_events
        WHERE campaign_id = ?
        AND type NOT IN ('combat.action', 'encounter.random_roll', 'encounter.respawn_scheduled')
        ORDER BY seq DESC LIMIT 8
    `).all(campaignId).reverse().map((row) => ({
        type: row.type, at: row.created_at, payload: parseJson(row.payload_json, {}),
    }));

    return {
        campaign,
        player: playerView,
        location,
        world: campaign.world,
        activeQuests,
        quests: activeQuests.length,
        pendingCombat: pendingCombat ?? null,
        combat: dashboardCombat(db, pendingCombat),
        party,
        nearbyNpcs,
        exits,
        effects: dashboardEffects(db, campaignId, player.id),
        inventory: {
            stacks: Number(inventory?.stacks ?? 0),
            items: Number(inventory?.items ?? 0),
            gold: Number(playerView.gold ?? 0),
        },
        journal,
        story: storyView(db, campaignId),
        save: recentSave ?? null,
        rules: {
            levelCap: pkg.rules?.levelCap ?? 30,
            nextExp: expToNext(pkg.rules, playerView.level),
        },
        integrations: {
            memoryBooks: Boolean(pkg.integrations?.memoryBooks),
            mapRegions: Boolean(pkg.integrations?.mapRegions),
            tracker: Boolean(pkg.integrations?.rpgTracker),
        },
    };
}

export function fullCampaignView(db, campaignId) {
    const dashboard = getDashboard(db, campaignId);
    return {
        ...dashboard,
        map: mapView(db, campaignId),
        quests: listQuests(db, campaignId),
        bindings: campaignView(db, campaignId).bindings,
    };
}

export function updateCampaign(db, campaignId, patch) {
    campaignRow(db, campaignId);
    if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (!name) throw new ValidationError('Campaign name cannot be empty');
        db.prepare('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), campaignId);
    }
    if (patch.status !== undefined) {
        if (!['active', 'archived', 'completed'].includes(patch.status)) throw new ValidationError('Invalid campaign status');
        db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, nowIso(), campaignId);
    }
    return campaignView(db, campaignId);
}

export function campaignSnapshot(db, campaignId, label = '', automatic = false) {
    campaignRow(db, campaignId);
    return saveSnapshotInternal(db, campaignId, label, automatic);
}

function saveSnapshotInternal(db, campaignId, label, automatic) {
    const campaign = campaignRow(db, campaignId);
    const snapshot = {
        version: 1,
        campaign: { ...campaign },
        tables: {},
        savedAt: nowIso(),
    };
    for (const table of SNAPSHOT_TABLES) {
        snapshot.tables[table] = db.prepare(SNAPSHOT_QUERIES[table]).all(campaignId);
    }
    const hash = hashObject(snapshot);
    const id = uuid('save_');
    const createdAt = nowIso();
    db.prepare(`
        INSERT INTO save_snapshots (id, campaign_id, label, automatic, snapshot_json, hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, campaignId, String(label ?? ''), automatic ? 1 : 0, asJson(snapshot), hash, createdAt);
    const obsolete = db.prepare(`
        SELECT id FROM save_snapshots WHERE campaign_id = ? AND automatic = 1 ORDER BY created_at DESC LIMIT -1 OFFSET 60
    `).all(campaignId);
    for (const row of obsolete) db.prepare('DELETE FROM save_snapshots WHERE id = ?').run(row.id);
    return { id, label, automatic, hash, createdAt };
}

export function listSaves(db, campaignId) {
    campaignRow(db, campaignId);
    return db.prepare('SELECT id, label, automatic, hash, created_at FROM save_snapshots WHERE campaign_id = ? ORDER BY created_at DESC')
        .all(campaignId).map((row) => ({ ...row, automatic: Boolean(row.automatic) }));
}

export function restoreSnapshot(db, campaignId, saveId) {
    const save = db.prepare('SELECT * FROM save_snapshots WHERE id = ? AND campaign_id = ?').get(saveId, campaignId);
    if (!save) throw new NotFoundError('Save snapshot not found', 'SAVE_NOT_FOUND');
    const snapshot = parseJson(save.snapshot_json, null);
    if (!snapshot?.campaign || !snapshot?.tables) throw new ValidationError('Save snapshot is corrupt');
    return withTransaction(db, () => {
        for (const table of RESTORE_DELETE_ORDER) {
            db.prepare(DELETE_QUERIES[table] ?? `DELETE FROM "${table}" WHERE campaign_id = ?`).run(campaignId);
        }
        for (const table of SNAPSHOT_TABLES) {
            for (const row of snapshot.tables[table] ?? []) insertRow(db, table, row);
        }
        const restored = snapshot.campaign;
        db.prepare(`
            UPDATE campaigns SET name = ?, status = ?, world_id = ?, game_version_id = ?,
                player_entity_id = ?, current_location_id = ?,
                game_state_json = ?, version = version + 1, updated_at = ?, last_played_at = ?
            WHERE id = ?
        `).run(
            restored.name, restored.status, restored.world_id, restored.game_version_id,
            restored.player_entity_id, restored.current_location_id,
            restored.game_state_json, nowIso(), nowIso(), campaignId,
        );
        const player = db.prepare('SELECT id FROM entities WHERE id = ?').get(restored.player_entity_id);
        if (!player) throw new ValidationError('Restored snapshot has no player entity');
        insertEvent(db, campaignId, 'save.restored', { saveId, label: save.label });
        return { ok: true, restoredSaveId: saveId, restoredAt: nowIso(), dashboard: getDashboard(db, campaignId) };
    });
}

export function exportCampaign(db, campaignId) {
    const campaign = campaignView(db, campaignId);
    const snapshot = {
        format: 'strpg.campaign-export',
        formatVersion: 1,
        exportedAt: nowIso(),
        campaign,
        tables: {},
    };
    for (const table of SNAPSHOT_TABLES) {
        snapshot.tables[table] = db.prepare(SNAPSHOT_QUERIES[table]).all(campaignId);
    }
    return snapshot;
}



