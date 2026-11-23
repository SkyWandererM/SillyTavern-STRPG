import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { campaignSnapshot, campaignView } from './campaigns.js';
import { ensureQuestInstances } from './quests.js';
import { createNpcEntity, unlockEligibleSkills } from './stats.js';
import { ensureEncounterSpawns } from './encounters.js';
import { insertEvent, nowIso, parseJson, withTransaction } from './util.js';

function versionRow(db, versionId) {
    return db.prepare('SELECT * FROM game_versions WHERE id = ?').get(versionId);
}

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

function keySet(items) {
    return new Set((items ?? []).map((item) => item.key));
}

function keyName(items) {
    return new Map((items ?? []).map((item) => [item.key, item.name ?? item.title ?? item.key]));
}

function diffList(oldItems, newItems) {
    const oldMap = keyName(oldItems);
    const newMap = keyName(newItems);
    const added = [...newMap.entries()].filter(([key]) => !oldMap.has(key)).map(([key, name]) => ({ key, name }));
    const removed = [...oldMap.entries()].filter(([key]) => !newMap.has(key)).map(([key, name]) => ({ key, name }));
    return { added, removed };
}

function activeCombat(db, campaignId) {
    return db.prepare("SELECT id, status FROM combat_sessions WHERE campaign_id = ? AND status IN ('pending', 'active') ORDER BY updated_at DESC").all(campaignId);
}

function collectBlockers(db, campaign, currentPkg, targetPkg, currentVersion, targetVersion) {
    const blockers = [];
    const add = (code, message, path = '') => blockers.push({ code, message, path });
    const currentWorld = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const targetWorld = db.prepare('SELECT * FROM worlds WHERE game_version_id = ?').get(targetVersion.id);
    if (!targetWorld) add('TARGET_WORLD_MISSING', 'Target version has no materialized world');
    if (currentVersion.project_id !== targetVersion.project_id) add('PROJECT_MISMATCH', 'A campaign can only upgrade within the same Studio project');
    if (currentWorld && targetWorld && currentWorld.world_key !== targetWorld.world_key) add('WORLD_KEY_MISMATCH', 'Target version uses a different world key');
    if (Number(targetVersion.version) <= Number(currentVersion.version)) add('VERSION_NOT_NEWER', 'Target version must be newer than the current campaign version');
    if (!targetWorld) return blockers;

    const active = activeCombat(db, campaign.id);
    if (active.length) add('ACTIVE_COMBAT', 'Finish or leave the current combat before upgrading', 'combat');

    const targetLocationKeys = new Set(targetPkg.locations.map((location) => location.key));
    const targetStoryNodes = keySet(targetPkg.story.nodes);
    const currentLocation = db.prepare('SELECT location_key FROM locations WHERE id = ?').get(campaign.current_location_id);
    if (currentLocation && !targetLocationKeys.has(currentLocation.location_key)) {
        add('CURRENT_LOCATION_MISSING', `Current location '${currentLocation.location_key}' no longer exists in the target version`, 'location');
    }

    const player = db.prepare('SELECT * FROM entities WHERE id = ?').get(campaign.player_entity_id);
    const playerData = parseJson(player?.data_json, {});
    const targetClassKeys = new Set(targetPkg.classes.map((klass) => klass.key));
    if (!player) add('PLAYER_MISSING', 'Campaign has no player entity');
    else if (!targetClassKeys.has(playerData.classKey)) add('PLAYER_CLASS_MISSING', `Player class '${playerData.classKey}' no longer exists in the target version`);

    const entityRows = db.prepare(`
        SELECT e.id, e.entity_key, e.kind, l.location_key FROM entities e
        LEFT JOIN locations l ON l.id = e.location_id WHERE e.campaign_id = ?
    `).all(campaign.id);
    for (const entity of entityRows) {
        if (entity.location_key && !targetLocationKeys.has(entity.location_key)) {
            add('ENTITY_LOCATION_MISSING', `Entity '${entity.entity_key}' is at a location missing from the target version`, 'entities');
        }
    }

    const targetItemKeys = new Set(targetPkg.items.map((item) => item.key));
    const inventory = db.prepare('SELECT DISTINCT item_key FROM inventory WHERE campaign_id = ?').all(campaign.id);
    for (const row of inventory) {
        if (!targetItemKeys.has(row.item_key)) add('ITEM_MISSING', `Inventory item '${row.item_key}' was removed in the target version`, 'inventory');
    }

    const targetSkillKeys = new Set(targetPkg.skills.map((skill) => skill.key));
    const skills = db.prepare(`
        SELECT DISTINCT s.skill_key FROM entity_skills s JOIN entities e ON e.id = s.entity_id WHERE e.campaign_id = ?
    `).all(campaign.id);
    for (const row of skills) {
        if (!targetSkillKeys.has(row.skill_key)) add('SKILL_MISSING', `Unlocked skill '${row.skill_key}' was removed in the target version`, 'skills');
    }

    const targetEffectKeys = new Set((targetPkg.effects ?? []).map((effect) => effect.key));
    const effects = db.prepare(`
        SELECT DISTINCT i.effect_key FROM status_effect_instances i WHERE i.campaign_id = ?
    `).all(campaign.id);
    for (const row of effects) {
        if (!targetEffectKeys.has(row.effect_key)) add('EFFECT_MISSING', `Active effect '${row.effect_key}' was removed in the target version`, 'effects');
    }

    const targetQuests = new Map(targetPkg.quests.map((quest) => [quest.key, quest]));
    const questInstances = db.prepare('SELECT * FROM quest_instances WHERE campaign_id = ?').all(campaign.id);
    for (const instance of questInstances) {
        const target = targetQuests.get(instance.quest_key);
        if (!target) {
            add('QUEST_MISSING', `Quest '${instance.quest_key}' was removed in the target version`, 'quests');
            continue;
        }
        if (instance.stage_key && !target.stages.some((stage) => stage.key === instance.stage_key)) {
            add('QUEST_STAGE_MISSING', `Quest '${instance.quest_key}' stage '${instance.stage_key}' no longer exists`, 'quests');
        }
        const progress = parseJson(instance.progress_json, {});
        for (const [stageKey, stageProgress] of Object.entries(progress.stages ?? {})) {
            const targetStage = target.stages.find((stage) => stage.key === stageKey);
            if (!targetStage) continue;
            const objectiveKeys = new Set((targetStage.objectives ?? []).map((objective) => objective.key));
            for (const objectiveKey of Object.keys(stageProgress.objectives ?? {})) {
                if (!objectiveKeys.has(objectiveKey)) {
                    add('QUEST_OBJECTIVE_MISSING', `Quest '${instance.quest_key}' objective '${stageKey}/${objectiveKey}' no longer exists`, 'quests');
                }
            }
        }
        if (instance.status === 'turned_in' && target.completion === 'turn_in' && !target.turnIn?.npcKey) {
            add('QUEST_TURNIN_MISSING', `Turned-in quest '${instance.quest_key}' no longer has a turn-in NPC`, 'quests');
        }
    }

    const storyState = parseJson(campaign.game_state_json, {}).story;
    if (storyState?.currentNodeKey && !targetStoryNodes.has(storyState.currentNodeKey)) {
        add('STORY_NODE_MISSING', `Current story node '${storyState.currentNodeKey}' no longer exists in the target version`, 'story');
    }
    for (const nodeKey of storyState?.visited ?? []) {
        if (!targetStoryNodes.has(nodeKey)) add('STORY_VISITED_NODE_MISSING', `Visited story node '${nodeKey}' was removed in the target version`, 'story');
    }

    const discovered = db.prepare(`
        SELECT l.location_key FROM location_discoveries d JOIN locations l ON l.id = d.location_id
        WHERE d.campaign_id = ?
    `).all(campaign.id);
    for (const row of discovered) {
        if (!targetLocationKeys.has(row.location_key)) add('DISCOVERED_LOCATION_MISSING', `Discovered location '${row.location_key}' was removed in the target version`, 'locations');
    }

    const targetNpcKeys = new Set(targetPkg.npcs.map((npc) => npc.key));
    for (const entity of entityRows) {
        if (entity.kind !== 'npc') continue;
        const key = String(entity.entity_key).replace(/^npc:/, '');
        if (!targetNpcKeys.has(key)) add('NPC_MISSING', `NPC '${key}' was removed in the target version`, 'npcs');
    }

    return blockers;
}

function previewForVersion(db, campaign, currentVersion, targetVersion) {
    const currentPkg = parseJson(currentVersion.package_json, {});
    const targetPkg = parseJson(targetVersion.package_json, {});
    const blockers = collectBlockers(db, campaign, currentPkg, targetPkg, currentVersion, targetVersion);
    const currentWorld = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const targetWorld = db.prepare('SELECT * FROM worlds WHERE game_version_id = ?').get(targetVersion.id);
    const diff = {
        worldChanged: Boolean(currentWorld && targetWorld && currentWorld.world_key !== targetWorld.world_key),
        locations: diffList(currentPkg.locations, targetPkg.locations),
        events: diffList(currentPkg.events ?? [], targetPkg.events ?? []),
        npcs: diffList(currentPkg.npcs, targetPkg.npcs),
        monsters: diffList(currentPkg.monsters, targetPkg.monsters),
        items: diffList(currentPkg.items, targetPkg.items),
        skills: diffList(currentPkg.skills, targetPkg.skills),
        quests: diffList(currentPkg.quests, targetPkg.quests),
        storyNodes: diffList(currentPkg.story?.nodes ?? [], targetPkg.story?.nodes ?? []),
    };
    return {
        currentVersion: { id: currentVersion.id, version: currentVersion.version, publishedAt: currentVersion.published_at },
        targetVersion: {
            id: targetVersion.id, version: targetVersion.version, notes: targetVersion.notes ?? '',
            publishedAt: targetVersion.published_at,
        },
        diff,
        blockers,
        canUpgrade: blockers.length === 0,
        activeCombat: activeCombat(db, campaign.id),
    };
}

export function listCampaignUpgrades(db, campaignId) {
    const campaign = campaignRow(db, campaignId);
    const currentVersion = versionRow(db, campaign.game_version_id);
    if (!currentVersion) throw new NotFoundError('Campaign game version not found', 'VERSION_NOT_FOUND');
    const versions = db.prepare(`
        SELECT * FROM game_versions
        WHERE project_id = ? AND status = 'published' AND version > ?
        ORDER BY version
    `).all(currentVersion.project_id, currentVersion.version);
    return {
        campaignId,
        currentVersion: { id: currentVersion.id, version: currentVersion.version, publishedAt: currentVersion.published_at },
        available: versions.map((version) => previewForVersion(db, campaign, currentVersion, version)),
    };
}

export function previewCampaignUpgrade(db, campaignId, targetVersionId) {
    const campaign = campaignRow(db, campaignId);
    const currentVersion = versionRow(db, campaign.game_version_id);
    const targetVersion = versionRow(db, targetVersionId);
    if (!currentVersion) throw new NotFoundError('Campaign game version not found', 'VERSION_NOT_FOUND');
    if (!targetVersion) throw new NotFoundError('Target game version not found', 'VERSION_NOT_FOUND');
    if (targetVersion.status !== 'published') throw new ValidationError('Target version must be published');
    return previewForVersion(db, campaign, currentVersion, targetVersion);
}

function targetTemplates(db, versionId, kind) {
    return db.prepare('SELECT * FROM entity_templates WHERE game_version_id = ? AND kind = ?').all(versionId, kind)
        .map((row) => ({ ...row, data: parseJson(row.data_json, {}) }));
}

export function upgradeCampaign(db, campaignId, targetVersionId) {
    const preview = previewCampaignUpgrade(db, campaignId, targetVersionId);
    if (!preview.canUpgrade) {
        throw new ConflictError('Campaign upgrade is blocked', 'UPGRADE_BLOCKED', { preview });
    }
    return withTransaction(db, () => {
        const campaign = campaignRow(db, campaignId);
        const fromVersion = versionRow(db, campaign.game_version_id);
        const targetVersion = versionRow(db, targetVersionId);
        const fromPkg = parseJson(fromVersion.package_json, {});
        const targetPkg = parseJson(targetVersion.package_json, {});
        const targetWorld = db.prepare('SELECT * FROM worlds WHERE game_version_id = ?').get(targetVersion.id);
        if (!targetWorld) throw new NotFoundError('Target world missing', 'WORLD_NOT_FOUND');

        const beforeSnapshot = campaignSnapshot(db, campaignId, `Before upgrade v${fromVersion.version} -> v${targetVersion.version}`, true);

        const oldLocations = db.prepare(`
            SELECT l.* FROM locations l JOIN campaigns c ON c.world_id = l.world_id WHERE c.id = ?
        `).all(campaignId);
        const oldLocationById = new Map(oldLocations.map((row) => [row.id, row]));
        const oldLocationByKey = new Map(oldLocations.map((row) => [row.location_key, row]));
        const targetLocations = db.prepare('SELECT * FROM locations WHERE world_id = ?').all(targetWorld.id);
        const targetLocationByKey = new Map(targetLocations.map((row) => [row.location_key, row]));

        const oldDiscovered = db.prepare('SELECT location_id FROM location_discoveries WHERE campaign_id = ?').all(campaignId)
            .map((row) => oldLocationById.get(row.location_id)?.location_key).filter(Boolean);

        const currentLocationKey = oldLocationById.get(campaign.current_location_id)?.location_key;
        const player = db.prepare('SELECT * FROM entities WHERE id = ?').get(campaign.player_entity_id);
        const playerData = parseJson(player?.data_json, {});
        const classKey = playerData.classKey;
        const targetClass = targetTemplates(db, targetVersion.id, 'class').find((entry) => entry.template_key === classKey);
        const targetNpcs = new Map(targetTemplates(db, targetVersion.id, 'npc').map((entry) => [entry.template_key, entry]));

        const gameState = parseJson(campaign.game_state_json, {});
        gameState.story = gameState.story ?? {
            currentNodeKey: targetPkg.story.startNodeKey,
            visited: [],
            variables: targetPkg.story.variables ?? {},
            ending: null,
            enteredAt: nowIso(),
        };
        gameState.story.variables = { ...(targetPkg.story.variables ?? {}), ...(gameState.story.variables ?? {}) };
        gameState.upgrades = [...(gameState.upgrades ?? []), {
            from: { id: fromVersion.id, version: fromVersion.version },
            to: { id: targetVersion.id, version: targetVersion.version },
            at: nowIso(),
            added: preview.diff,
        }];

        db.prepare(`
            UPDATE campaigns
            SET world_id = ?, game_version_id = ?, current_location_id = ?, version = version + 1,
                game_state_json = ?, updated_at = ?, last_played_at = ?
            WHERE id = ?
        `).run(
            targetWorld.id, targetVersion.id, targetLocationByKey.get(currentLocationKey)?.id ?? null,
            JSON.stringify(gameState), nowIso(), nowIso(), campaignId,
        );

        if (player) {
            const targetLocation = targetLocationByKey.get(oldLocationById.get(player.location_id)?.location_key);
            db.prepare('UPDATE entities SET template_id = ?, location_id = ?, updated_at = ? WHERE id = ?')
                .run(targetClass?.id ?? null, targetLocation?.id ?? null, nowIso(), player.id);
        }

        const existingNpcKeys = new Set();
        const entityRows = db.prepare('SELECT * FROM entities WHERE campaign_id = ?').all(campaignId);
        for (const entity of entityRows) {
            if (entity.kind !== 'npc') continue;
            const key = String(entity.entity_key).replace(/^npc:/, '');
            existingNpcKeys.add(key);
            const template = targetNpcs.get(key);
            const oldLocationKey = oldLocationById.get(entity.location_id)?.location_key;
            const targetLocation = targetLocationByKey.get(oldLocationKey);
            const runtime = parseJson(entity.data_json, {});
            if (template) {
                runtime.npcKey = key;
                runtime.title = template.data.title ?? runtime.title ?? '';
                runtime.joinable = Boolean(template.data.joinable);
                runtime.combat = template.data.combat ?? runtime.combat ?? null;
                runtime.shop = template.data.shop ?? runtime.shop ?? null;
            }
            db.prepare(`
                UPDATE entities SET template_id = ?, name = ?, location_id = ?, data_json = ?, updated_at = ? WHERE id = ?
            `).run(
                template?.id ?? entity.template_id,
                template?.data.name ?? entity.name,
                targetLocation?.id ?? entity.location_id,
                JSON.stringify(runtime), nowIso(), entity.id,
            );
        }

        for (const [key, template] of targetNpcs) {
            if (existingNpcKeys.has(key)) continue;
            const location = targetLocationByKey.get(template.data.locationKey);
            if (!location) continue;
            createNpcEntity(db, { campaignId, template, locationId: location.id });
        }

        const targetItems = new Map(targetPkg.items.map((item) => [item.key, db.prepare('SELECT * FROM item_definitions WHERE game_version_id = ? AND item_key = ?').get(targetVersion.id, item.key)]));
        for (const row of db.prepare('SELECT * FROM inventory WHERE campaign_id = ?').all(campaignId)) {
            const definition = targetItems.get(row.item_key);
            if (definition) db.prepare('UPDATE inventory SET item_definition_id = ?, updated_at = ? WHERE id = ?').run(definition.id, nowIso(), row.id);
        }

        const targetSkills = new Map(targetPkg.skills.map((skill) => [skill.key, db.prepare('SELECT * FROM skill_definitions WHERE game_version_id = ? AND skill_key = ?').get(targetVersion.id, skill.key)]));
        for (const row of db.prepare(`
            SELECT s.* FROM entity_skills s JOIN entities e ON e.id = s.entity_id WHERE e.campaign_id = ?
        `).all(campaignId)) {
            const definition = targetSkills.get(row.skill_key);
            if (definition) db.prepare('UPDATE entity_skills SET skill_definition_id = ? WHERE id = ?').run(definition.id, row.id);
        }

        const targetQuestIds = new Map(targetPkg.quests.map((quest) => [quest.key, db.prepare('SELECT * FROM quest_definitions WHERE game_version_id = ? AND quest_key = ?').get(targetVersion.id, quest.key)]));
        for (const row of db.prepare('SELECT * FROM quest_instances WHERE campaign_id = ?').all(campaignId)) {
            const definition = targetQuestIds.get(row.quest_key);
            if (definition) db.prepare('UPDATE quest_instances SET quest_definition_id = ?, updated_at = ? WHERE id = ?').run(definition.id, nowIso(), row.id);
        }
        ensureQuestInstances(db, campaignId);

        const targetEffects = new Map((targetPkg.effects ?? []).map((effect) => [effect.key, db.prepare('SELECT * FROM status_effect_definitions WHERE game_version_id = ? AND effect_key = ?').get(targetVersion.id, effect.key)]));
        for (const row of db.prepare('SELECT * FROM status_effect_instances WHERE campaign_id = ?').all(campaignId)) {
            const definition = targetEffects.get(row.effect_key);
            if (definition) db.prepare('UPDATE status_effect_instances SET effect_definition_id = ? WHERE id = ?').run(definition.id, row.id);
        }

        db.prepare('DELETE FROM location_discoveries WHERE campaign_id = ?').run(campaignId);
        for (const key of new Set(oldDiscovered)) {
            const location = targetLocationByKey.get(key);
            if (location) db.prepare('INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?)').run(campaignId, location.id, nowIso());
        }
        for (const location of targetLocations) {
            if (!location.discovered_by_default) continue;
            db.prepare('INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id, location_id) DO NOTHING')
                .run(campaignId, location.id, nowIso());
        }

        for (const spawn of db.prepare('SELECT * FROM encounter_spawns WHERE campaign_id = ?').all(campaignId)) {
            const key = oldLocationById.get(spawn.location_id)?.location_key;
            const location = targetLocationByKey.get(key);
            if (location) db.prepare('UPDATE encounter_spawns SET location_id = ?, updated_at = ? WHERE id = ?').run(location.id, nowIso(), spawn.id);
            else db.prepare('DELETE FROM encounter_spawns WHERE id = ?').run(spawn.id);
        }
        ensureEncounterSpawns(db, campaignId);

        for (const session of db.prepare('SELECT * FROM combat_sessions WHERE campaign_id = ?').all(campaignId)) {
            const key = oldLocationById.get(session.location_id)?.location_key;
            const location = targetLocationByKey.get(key);
            if (location) db.prepare('UPDATE combat_sessions SET location_id = ? WHERE id = ?').run(location.id, session.id);
        }

        if (player) unlockEligibleSkills(db, player.id, campaignId);

        const afterSnapshot = campaignSnapshot(db, campaignId, `Upgraded to v${targetVersion.version}`, true);
        insertEvent(db, campaignId, 'campaign.upgraded', {
            from: { id: fromVersion.id, version: fromVersion.version },
            to: { id: targetVersion.id, version: targetVersion.version },
            notes: targetVersion.notes ?? '',
            diff: preview.diff,
        });
        return {
            campaign: campaignView(db, campaignId),
            fromVersion: { id: fromVersion.id, version: fromVersion.version },
            toVersion: { id: targetVersion.id, version: targetVersion.version, notes: targetVersion.notes ?? '' },
            diff: preview.diff,
            snapshots: { before: beforeSnapshot, after: afterSnapshot },
        };
    });
}

