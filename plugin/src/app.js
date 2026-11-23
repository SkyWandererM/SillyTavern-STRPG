import express from 'express';
import { AppError, ConflictError, NotFoundError, PermissionError, ValidationError } from './errors.js';
import { ASSET_KINDS } from './schemas.js';
import {
    buildGameVersion, cloneProject, createAsset, createAssetRevision, createProject, deleteAsset, deleteProject, renameAssetKey,
    exportGameVersion, getAsset, getGameVersion, getProject, importAssetBundle, importAssetItems,
    importGamePackage, integrityCheck, listAssets, listGameVersions, listProjects, publishAsset,
    publishGameVersion, reviewAsset, rollbackGameVersion, updateAsset, updateProject, validateAsset,
    contentStats,
} from './studio.js';
import {
    bindCampaignToChat, campaignForChat, campaignSnapshot, campaignView, createCampaign, exportCampaign,
    fullCampaignView, getDashboard, listCampaigns, listChatCampaigns, listSaves, restoreSnapshot,
    unbindChat, updateCampaign,
} from './campaigns.js';
import {
    getCampaignLocation, getLocations, locationDetail, mapView, movePlayer, proposeMovement, triggerManualEvent,
} from './world.js';
import { listCampaignUpgrades, previewCampaignUpgrade, upgradeCampaign } from './upgrades.js';
import { encounterState, tryRandomEncounter } from './encounters.js';
import { getNpcInteractions, interactWithNpc, npcBuy, npcSell, availableInteractionsAtCurrentLocation, shopView } from './interactions.js';
import { acceptQuest, failQuest, listQuests, turnInQuest, questView } from './quests.js';
import { advanceStory, chooseStoryEdge, storyView } from './story.js';
import { buildInventoryView, buyItem, equipItem, listInventory, sellItem, unequipItem, useItem } from './inventory.js';
import { addExperience, getEntityView, getPlayer } from './stats.js';
import {
    applyCombatAction, combatView, getCombatContextForLLM, getCombatForCampaign, getPendingCombat,
    proposeEncounter, saveCombat, startCombat,
} from './combat.js';
import { callTool, TOOL_DEFINITIONS } from './tools.js';
import {
    exportMapRegions, importMapRegions, integrationStatus, memoryBooksPayload, trackerState, trackerSync,
} from './integrations.js';
import { createBackup, deleteBackup, listBackups, restoreBackup } from './backups.js';
import { importNpcToTavern } from './tavern.js';
import { buildMemoryBook, pushMemoryBook } from './memorybook.js';
import {
    approveCandidate, bridgeStatus, listCandidates, pullTrackerNarrative, receiveSignal, rejectCandidate, trackerMirror,
} from './bridge.js';
import { socialOptions } from './social.js';
import { deleteScope, ensureStarterScopes, ingestScope, ingestScopeRaw, listScopes, scopePrompt, upsertScope } from './scopes.js';
import { databaseInfo, readSetting, verifySchema, writeSetting } from './db.js';
import { seedExampleProject } from './seed.js';
import { idempotent, nowIso, parseJson, uuid, withTransaction } from './util.js';

export const PLUGIN_VERSION = '1.7.0';

function wrap(handler) {
    return (req, res, next) => {
        try {
            const value = handler(req, res, next);
            if (value && typeof value.then === 'function') value.catch(next);
        } catch (error) {
            next(error);
        }
    };
}

function send(res, data, status = 200) {
    res.status(status).json({ ok: true, data });
}

function idempotencyKey(req) {
    return req.get('Idempotency-Key') || req.body?.idempotencyKey || null;
}

function campaignId(req) {
    return req.params.campaignId ?? req.params.id;
}

function requireStudio(req, res, next) {
    const expected = process.env.STRPG_STUDIO_TOKEN;
    if (expected && req.get('x-strpg-studio-token') !== expected) {
        return next(new PermissionError('Studio token required'));
    }
    next();
}

function requireToolToken(req, res, next) {
    const expected = process.env.STRPG_TOOL_TOKEN;
    if (expected && req.get('x-strpg-tool-token') !== expected) {
        return next(new PermissionError('Tool token required'));
    }
    next();
}

function mutate(db, campaignIdValue, fn, label = 'campaign mutation') {
    const result = fn();
    const snapshot = campaignSnapshot(db, campaignIdValue, label, true);
    return { ...result, snapshot };
}

export function createRouter(db) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });
    router.use(express.json({ limit: '25mb' }));

    router.get('/health', wrap((req, res) => {
        send(res, {
            ok: true,
            plugin: 'STRPG',
            version: PLUGIN_VERSION,
            schemaVersion: verifySchema(db).schemaVersion,
            database: databaseInfo(db),
            time: nowIso(),
            studioTokenRequired: Boolean(process.env.STRPG_STUDIO_TOKEN),
            toolTokenRequired: Boolean(process.env.STRPG_TOOL_TOKEN),
        });
    }));

    router.get('/meta', wrap((req, res) => {
        send(res, {
            name: 'STRPG — SillyTavern RPG Framework',
            version: PLUGIN_VERSION,
            apiBase: '/api/plugins/strpg',
            contentStatuses: ['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'],
            assetKinds: ASSET_KINDS,
            tools: TOOL_DEFINITIONS,
            contentStats: contentStats(db),
            features: {
                combat: true,
                studio: true,
                maps: true,
                saves: true,
                integrations: true,
                characterCards: true,
            },
        });
    }));

    router.get('/projects', requireStudio, wrap((req, res) => send(res, listProjects(db))));
    router.post('/projects', requireStudio, wrap((req, res) => send(res, createProject(db, req.body), 201)));
    router.get('/projects/:id', requireStudio, wrap((req, res) => send(res, getProject(db, req.params.id))));
    router.patch('/projects/:id', requireStudio, wrap((req, res) => send(res, updateProject(db, req.params.id, req.body))));
    router.post('/projects/:id/clone', requireStudio, wrap((req, res) => send(res, cloneProject(db, req.params.id, req.body), 201)));
    router.delete('/projects/:id', requireStudio, wrap((req, res) => send(res, deleteProject(db, req.params.id))));
    router.get('/projects/:id/integrity', requireStudio, wrap((req, res) => send(res, integrityCheck(db, req.params.id))));

    router.get('/projects/:id/assets', requireStudio, wrap((req, res) => {
        send(res, listAssets(db, req.params.id, {
            kind: req.query.kind,
            status: req.query.status,
            includeRevisions: req.query.revisions === '1',
        }));
    }));
    router.post('/projects/:id/assets', requireStudio, wrap((req, res) => {
        if (Array.isArray(req.body?.items)) {
            send(res, importAssetItems(db, req.params.id, req.body.items, { createdBy: req.body.createdBy ?? 'studio' }), 201);
            return;
        }
        send(res, importAssetBundle(db, req.params.id, req.body, { createdBy: req.body?.createdBy ?? 'studio' }), 201);
    }));
    router.get('/assets/:id', requireStudio, wrap((req, res) => send(res, getAsset(db, req.params.id))));
    router.patch('/assets/:id', requireStudio, wrap((req, res) => send(res, updateAsset(db, req.params.id, req.body))));
    router.delete('/assets/:id', requireStudio, wrap((req, res) => send(res, deleteAsset(db, req.params.id))));
    router.post('/assets/:id/rename', requireStudio, wrap((req, res) => send(res, renameAssetKey(db, req.params.id, req.body?.key))));
    router.post('/assets/:id/tavern-import', requireStudio, wrap(async (req, res) => send(res, await importNpcToTavern(db, req.params.id, req))));
    router.post('/assets/:id/new-revision', requireStudio, wrap((req, res) => send(res, createAssetRevision(db, req.params.id, req.body), 201)));
    router.post('/assets/:id/validate', requireStudio, wrap((req, res) => send(res, validateAsset(db, req.params.id))));
    router.post('/assets/:id/review', requireStudio, wrap((req, res) => send(res, reviewAsset(db, req.params.id, req.body))));
    router.post('/assets/:id/publish', requireStudio, wrap((req, res) => send(res, publishAsset(db, req.params.id))));

    router.get('/projects/:id/versions', requireStudio, wrap((req, res) => send(res, listGameVersions(db, req.params.id))));
    router.post('/projects/:id/build', requireStudio, wrap((req, res) => send(res, buildGameVersion(db, req.params.id, req.body), 201)));
    router.post('/projects/:id/import-package', requireStudio, wrap((req, res) => send(res, importGamePackage(db, req.body, { createdBy: 'studio' }), 201)));
    router.get('/versions/:id', requireStudio, wrap((req, res) => send(res, getGameVersion(db, req.params.id, { includePackage: req.query.package === '1' }))));
    router.post('/versions/:id/publish', requireStudio, wrap((req, res) => send(res, publishGameVersion(db, req.params.id))));
    router.post('/versions/:id/rollback', requireStudio, wrap((req, res) => send(res, rollbackGameVersion(db, req.params.id, req.body), 201)));
    router.get('/versions/:id/export', requireStudio, wrap((req, res) => {
        const exported = exportGameVersion(db, req.params.id);
        res.setHeader('Content-Disposition', `attachment; filename="strpg-game-v${exported.version}.json"`);
        res.json(exported);
    }));

    router.get('/published-games', wrap((req, res) => {
        const rows = db.prepare(`
            SELECT v.id, v.version, v.published_at, v.package_json, p.id AS project_id, p.name AS project_name
            FROM game_versions v JOIN game_projects p ON p.id = v.project_id
            WHERE v.status = 'published' ORDER BY v.published_at DESC
        `).all();
        send(res, rows.map((row) => {
            const pkg = parseJson(row.package_json, {});
            return {
                versionId: row.id,
                version: row.version,
                projectId: row.project_id,
                name: pkg.meta?.title ?? row.project_name,
                description: pkg.meta?.description ?? '',
                worldName: pkg.world?.name ?? '',
                startLocation: pkg.locations?.find((location) => location.key === pkg.world?.startLocationKey)?.name ?? '',
                classes: (pkg.classes ?? []).map((klass) => ({ key: klass.key, name: klass.name, description: klass.description })),
                counts: {
                    locations: pkg.locations?.length ?? 0,
                    npcs: pkg.npcs?.length ?? 0,
                    monsters: pkg.monsters?.length ?? 0,
                    quests: pkg.quests?.length ?? 0,
                },
                publishedAt: row.published_at,
            };
        }));
    }));
    router.get('/campaigns', wrap((req, res) => send(res, listCampaigns(db))));
    router.post('/campaigns', wrap((req, res) => send(res, createCampaign(db, req.body), 201)));
    router.get('/campaigns/:id', wrap((req, res) => send(res, fullCampaignView(db, req.params.id))));
    router.patch('/campaigns/:id', wrap((req, res) => send(res, updateCampaign(db, req.params.id, req.body))));
    router.get('/campaigns/:id/memory-book', wrap((req, res) => send(res, buildMemoryBook(db, req.params.id))));
    router.post('/campaigns/:id/memory-book/push', wrap(async (req, res) => {
        send(res, await pushMemoryBook(db, req.params.id, req, {
            dryRun: req.body?.dryRun === true,
            replace: req.body?.replace === true,
            adoptLegacy: req.body?.adoptLegacy !== false,
        }));
    }));
    router.get('/campaigns/:id/dashboard', wrap((req, res) => send(res, getDashboard(db, req.params.id))));
    router.get('/campaigns/:id/upgrades', wrap((req, res) => send(res, listCampaignUpgrades(db, req.params.id))));
    router.get('/campaigns/:id/upgrades/:versionId/preview', wrap((req, res) => {
        send(res, previewCampaignUpgrade(db, req.params.id, req.params.versionId));
    }));
    router.post('/campaigns/:id/upgrade', wrap((req, res) => {
        const versionId = req.body?.versionId ?? req.body?.gameVersionId;
        if (!versionId) throw new ValidationError('versionId is required');
        send(res, upgradeCampaign(db, req.params.id, versionId));
    }));
    router.get('/campaigns/:id/map', wrap((req, res) => send(res, mapView(db, req.params.id, { region: req.query.region }))));
    router.get('/campaigns/:id/location', wrap((req, res) => send(res, getCampaignLocation(db, req.params.id))));
    router.get('/campaigns/:id/locations', wrap((req, res) => send(res, getLocations(db, req.params.id))));
    router.get('/campaigns/:id/locations/:key', wrap((req, res) => send(res, locationDetail(db, req.params.id, req.params.key))));
    router.get('/campaigns/:id/characters', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const playerView = getEntityView(db, player.id);
        const party = db.prepare(`
            SELECT id FROM entities WHERE campaign_id = ? AND kind = 'npc' AND json_extract(data_json, '$.party') = 1
        `).all(req.params.id).map((row) => getEntityView(db, row.id));
        const npcs = db.prepare("SELECT id FROM entities WHERE campaign_id = ? AND kind = 'npc'").all(req.params.id)
            .map((row) => getEntityView(db, row.id));
        send(res, { player: playerView, party, npcs });
    }));
    router.get('/campaigns/:id/inventory', wrap((req, res) => send(res, buildInventoryView(db, req.params.id))));
    router.get('/campaigns/:id/skills', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const view = getEntityView(db, player.id);
        const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(req.params.id);
        const all = db.prepare('SELECT * FROM skill_definitions WHERE game_version_id = ? ORDER BY skill_key').all(campaign.game_version_id)
            .map((row) => ({ ...parseJson(row.data_json, {}), key: row.skill_key, name: row.name, unlocked: view.skills.some((skill) => skill.skill_key === row.skill_key) }));
        send(res, { playerId: player.id, classKey: view.data.classKey ?? null, unlocked: view.skills, all });
    }));
    router.get('/campaigns/:id/quests', wrap((req, res) => send(res, listQuests(db, req.params.id))));
    router.get('/campaigns/:id/quests/:questKey', wrap((req, res) => send(res, questView(db, req.params.id, req.params.questKey))));
    router.get('/campaigns/:id/story', wrap((req, res) => send(res, storyView(db, req.params.id))));
    router.get('/campaigns/:id/events', wrap((req, res) => {
        const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
        send(res, db.prepare('SELECT * FROM game_events WHERE campaign_id = ? ORDER BY seq DESC LIMIT ?').all(req.params.id, limit)
            .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }))
            .reverse());
    }));

    router.post('/campaigns/:id/bind-chat', wrap((req, res) => {
        if (!req.body.chatKey) throw new ValidationError('chatKey is required');
        send(res, bindCampaignToChat(db, req.params.id, req.body.chatKey, req.body.characterName ?? ''));
    }));
    router.get('/chat-campaigns', wrap((req, res) => send(res, listChatCampaigns(db))));
    router.get('/chat-bindings/:chatKey', wrap((req, res) => {
        const binding = campaignForChat(db, decodeURIComponent(req.params.chatKey));
        if (!binding) throw new NotFoundError('No campaign is bound to this chat', 'CHAT_NOT_BOUND');
        send(res, binding);
    }));
    router.delete('/chat-bindings/:chatKey', wrap((req, res) => send(res, unbindChat(db, decodeURIComponent(req.params.chatKey)))));

    router.post('/campaigns/:id/move', wrap((req, res) => {
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `move:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => movePlayer(db, req.params.id, req.body.location ?? req.body.locationKey ?? req.body.targetLocationId), 'Player moved'));
        send(res, result);
    }));
    router.post('/campaigns/:id/move/propose', wrap((req, res) => {
        send(res, proposeMovement(db, req.params.id, req.body.location ?? req.body.locationKey));
    }));
    router.post('/campaigns/:id/events/:eventKey/trigger', wrap((req, res) => {
        const result = mutate(db, req.params.id, () => triggerManualEvent(db, req.params.id, req.params.eventKey, req.body ?? {}), `Event triggered: ${req.params.eventKey}`);
        send(res, result);
    }));

    router.get('/campaigns/:id/interactions', wrap((req, res) => send(res, availableInteractionsAtCurrentLocation(db, req.params.id))));
    router.get('/campaigns/:id/interactions/:npcKey', wrap((req, res) => send(res, getNpcInteractions(db, req.params.id, req.params.npcKey))));
    router.post('/campaigns/:id/interactions/:npcKey/:interactionKey', wrap((req, res) => {
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `interact:${req.params.id}:${req.params.npcKey}:${req.params.interactionKey}`, request: req.body,
        }, () => mutate(db, req.params.id, () => interactWithNpc(db, req.params.id, req.params.npcKey, req.params.interactionKey, req.body), 'NPC interaction'));
        send(res, result);
    }));
    router.get('/campaigns/:id/shop/:npcKey', wrap((req, res) => send(res, shopView(db, req.params.id, req.params.npcKey))));
    router.post('/campaigns/:id/shop/:npcKey/buy', wrap((req, res) => {
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `shop-buy:${req.params.id}:${req.params.npcKey}`, request: req.body,
        }, () => mutate(db, req.params.id, () => npcBuy(db, req.params.id, req.params.npcKey, req.body.itemKey, req.body.quantity ?? 1), 'Shop purchase'));
        send(res, result);
    }));
    router.post('/campaigns/:id/shop/:npcKey/sell', wrap((req, res) => {
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `shop-sell:${req.params.id}:${req.params.npcKey}`, request: req.body,
        }, () => mutate(db, req.params.id, () => npcSell(db, req.params.id, req.params.npcKey, req.body.itemKey, req.body.quantity ?? 1), 'Shop sale'));
        send(res, result);
    }));

    router.post('/campaigns/:id/quests/:questKey/accept', wrap((req, res) => {
        const result = mutate(db, req.params.id, () => {
            const quest = acceptQuest(db, req.params.id, req.params.questKey);
            const story = advanceStory(db, req.params.id, { type: 'quest.accepted', targetKey: req.params.questKey });
            return { quest, story };
        }, 'Quest accepted');
        send(res, result);
    }));
    router.post('/campaigns/:id/quests/:questKey/turn-in', wrap((req, res) => {
        const result = mutate(db, req.params.id, () => {
            const quest = turnInQuest(db, req.params.id, req.params.questKey, req.body);
            const story = advanceStory(db, req.params.id, { type: 'quest.turned_in', targetKey: req.params.questKey });
            return { quest, story };
        }, 'Quest turned in');
        send(res, result);
    }));
    router.post('/campaigns/:id/quests/:questKey/fail', wrap((req, res) => {
        send(res, mutate(db, req.params.id, () => failQuest(db, req.params.id, req.params.questKey, req.body.reason), 'Quest failed'));
    }));

    router.post('/campaigns/:id/inventory/equip', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `equip:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => equipItem(db, req.params.id, player.id, req.body.inventoryId), 'Item equipped'));
        send(res, result);
    }));
    router.post('/campaigns/:id/inventory/unequip', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `unequip:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => unequipItem(db, player.id, req.body.slot), 'Item unequipped'));
        send(res, result);
    }));
    router.post('/campaigns/:id/inventory/use', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `use-item:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => useItem(db, req.params.id, player.id, req.body.itemKey), 'Item used'));
        send(res, result);
    }));
    router.post('/campaigns/:id/inventory/buy', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `buy-item:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => buyItem(db, req.params.id, player.id, req.body.itemKey, req.body.quantity ?? 1), 'Item bought'));
        send(res, result);
    }));
    router.post('/campaigns/:id/inventory/sell', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `sell-item:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => sellItem(db, req.params.id, player.id, req.body.itemKey, req.body.quantity ?? 1), 'Item sold'));
        send(res, result);
    }));
    router.post('/campaigns/:id/experience', wrap((req, res) => {
        const player = getPlayer(db, req.params.id);
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `grant-exp:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => addExperience(db, req.params.id, player.id, Number(req.body.amount ?? 0), { source: 'manual' }), 'Experience granted'));
        send(res, result);
    }));

    router.post('/campaigns/:id/story/choose', wrap((req, res) => {
        if (!req.body.edgeKey) throw new ValidationError('edgeKey is required');
        send(res, mutate(db, req.params.id, () => chooseStoryEdge(db, req.params.id, req.body.edgeKey), 'Story choice'));
    }));

    router.get('/campaigns/:id/saves', wrap((req, res) => send(res, listSaves(db, req.params.id))));
    router.post('/campaigns/:id/saves', wrap((req, res) => send(res, campaignSnapshot(db, req.params.id, req.body.label ?? 'Manual save', false), 201)));
    router.post('/campaigns/:id/saves/:saveId/restore', wrap((req, res) => send(res, restoreSnapshot(db, req.params.id, req.params.saveId))));
    router.get('/campaigns/:id/export', wrap((req, res) => {
        const exportData = exportCampaign(db, req.params.id);
        res.setHeader('Content-Disposition', `attachment; filename="strpg-campaign-${req.params.id}.json"`);
        res.json(exportData);
    }));

    router.post('/campaigns/:id/encounters/propose', wrap((req, res) => {
        const result = idempotent(db, {
            key: idempotencyKey(req), scope: `encounter:${req.params.id}`, request: req.body,
        }, () => mutate(db, req.params.id, () => proposeEncounter(db, req.params.id, req.body), 'Encounter proposed'));
        send(res, result, 201);
    }));
    router.get('/campaigns/:id/encounter-spawns', wrap((req, res) => send(res, encounterState(db, req.params.id, req.query.locationId ?? null))));
    router.post('/campaigns/:id/explore', wrap((req, res) => {
        const result = mutate(db, req.params.id, () => tryRandomEncounter(db, req.params.id, proposeEncounter, req.body?.locationId ?? null), 'Random encounter check');
        send(res, result);
    }));

    router.get('/campaigns/:id/combat', wrap((req, res) => send(res, getCombatForCampaign(db, req.params.id))));
    router.get('/campaigns/:id/combat/pending', wrap((req, res) => send(res, getPendingCombat(db, req.params.id))));
    router.get('/campaigns/:id/combat/context', wrap((req, res) => send(res, getCombatContextForLLM(db, req.params.id))));
    router.get('/combat/:id', wrap((req, res) => send(res, combatView(db, req.params.id))));
    router.post('/combat/:id/start', wrap((req, res) => send(res, startCombat(db, req.params.id))));
    router.post('/combat/:id/action', wrap((req, res) => {
        const key = idempotencyKey(req);
        const result = idempotent(db, {
            key, scope: `combat-action:${req.params.id}`, request: req.body,
        }, () => applyCombatAction(db, req.params.id, { ...req.body, idempotencyKey: key }));
        send(res, result);
    }));
    router.post('/combat/:id/save', wrap((req, res) => send(res, saveCombat(db, req.params.id))));

    router.get('/integrations', wrap((req, res) => send(res, integrationStatus(db))));
    router.get('/campaigns/:id/integrations/tracker', wrap((req, res) => send(res, trackerState(db, req.params.id))));
    router.post('/campaigns/:id/integrations/tracker/sync', wrap((req, res) => {
        send(res, trackerSync(db, req.params.id, req.body.state ?? req.body, { direction: req.body.direction ?? 'inbound', available: req.body.available }));
    }));
    router.get('/campaigns/:id/integrations/memory-books', wrap((req, res) => send(res, memoryBooksPayload(db, req.params.id))));
    router.get('/campaigns/:id/integrations/map-regions/export', wrap((req, res) => send(res, exportMapRegions(db, req.params.id))));
    router.post('/campaigns/:id/integrations/map-regions/import', wrap((req, res) => send(res, importMapRegions(db, req.params.id, req.body))));

    // Chat <-> RPG bridge (state mirror, reviewed memory candidates, incremental lorebook)
    router.get('/campaigns/:id/bridge', wrap((req, res) => send(res, bridgeStatus(db, req.params.id))));
    router.get('/campaigns/:id/social/:npcKey', wrap((req, res) => send(res, socialOptions(db, req.params.id, req.params.npcKey))));

    // Memory scopes (M3): server-built extraction prompts + reviewed ingest
    router.get('/campaigns/:id/scopes', wrap((req, res) => send(res, listScopes(db, req.params.id))));
    router.post('/campaigns/:id/scopes', wrap((req, res) => send(res, upsertScope(db, req.params.id, req.body ?? {}))));
    router.post('/campaigns/:id/scopes/defaults', wrap((req, res) => send(res, ensureStarterScopes(db, req.params.id))));
    router.post('/campaigns/:id/scopes/:scopeKey/prepare', wrap((req, res) => send(res, scopePrompt(db, req.params.id, req.params.scopeKey, req.body ?? {}))));
    router.post('/campaigns/:id/scopes/:scopeKey/scan', wrap((req, res) => send(res, req.body?.raw
        ? ingestScopeRaw(db, req.params.id, req.params.scopeKey, req.body ?? {})
        : ingestScope(db, req.params.id, req.params.scopeKey, req.body ?? {}))));
    router.delete('/campaigns/:id/scopes/:scopeKey', wrap((req, res) => send(res, deleteScope(db, req.params.id, req.params.scopeKey))));
    router.post('/campaigns/:id/bridge/signals/:name', wrap(async (req, res) => {
        send(res, await receiveSignal(db, req.params.id, req.params.name, { note: req.body?.note }));
    }));
    router.get('/campaigns/:id/bridge/mirror', wrap((req, res) => send(res, trackerMirror(db, req.params.id))));
    router.post('/campaigns/:id/bridge/tracker/pull', wrap((req, res) => {
        send(res, pullTrackerNarrative(db, req.params.id, req.body ?? {}));
    }));
    router.get('/campaigns/:id/bridge/candidates', wrap((req, res) => {
        send(res, listCandidates(db, req.params.id, { status: req.query.status, limit: req.query.limit }));
    }));
    router.post('/campaigns/:id/bridge/candidates/:candidateId/approve', wrap(async (req, res) => {
        send(res, await approveCandidate(db, req.params.id, req.params.candidateId, {
            appliedBy: req.body?.appliedBy ?? 'ui',
            overrideReason: req.body?.overrideReason,
        }));
    }));
    router.post('/campaigns/:id/bridge/candidates/:candidateId/reject', wrap((req, res) => {
        send(res, rejectCandidate(db, req.params.id, req.params.candidateId, { note: req.body?.note }));
    }));

    router.get('/tools', wrap((req, res) => send(res, TOOL_DEFINITIONS)));
    router.post('/tools/:name', requireToolToken, wrap(async (req, res) => {
        send(res, { tool: req.params.name, result: await callTool(db, req.params.name, req.body) });
    }));

    router.get('/settings', requireStudio, wrap((req, res) => send(res, {
        autoSeed: readSetting(db, 'auto_seed', true),
        studioTokenRequired: Boolean(process.env.STRPG_STUDIO_TOKEN),
        database: databaseInfo(db),
    })));
    router.patch('/settings', requireStudio, wrap((req, res) => {
        if (req.body.autoSeed !== undefined) writeSetting(db, 'auto_seed', Boolean(req.body.autoSeed));
        send(res, { autoSeed: readSetting(db, 'auto_seed', true) });
    }));

    router.get('/admin/backups', requireStudio, wrap((req, res) => send(res, listBackups(db))));
    router.post('/admin/backups', requireStudio, wrap((req, res) => send(res, createBackup(db, req.body.label ?? ''), 201)));
    router.post('/admin/backups/:name/restore', requireStudio, wrap((req, res) => send(res, restoreBackup(db, req.params.name))));
    router.delete('/admin/backups/:name', requireStudio, wrap((req, res) => send(res, deleteBackup(db, req.params.name))));
    router.get('/admin/database', requireStudio, wrap((req, res) => send(res, databaseInfo(db))));
    router.post('/admin/seed', requireStudio, wrap((req, res) => {
        if (!req.body.force) throw new ConflictError('Set force=true to seed the example project', 'SEED_CONFIRMATION_REQUIRED');
        send(res, seedExampleProject(db, { force: true }), 201);
    }));

    router.use((req, res) => {
        res.status(404).json({ ok: false, error: { code: 'ROUTE_NOT_FOUND', message: `No STRPG route for ${req.method} ${req.path}` } });
    });

    router.use((error, req, res, next) => {
        void next;
        const status = error.status ?? 500;
        if (status >= 500) console.error('[STRPG]', error);
        res.status(status).json({
            ok: false,
            error: {
                code: error.code ?? 'STRPG_INTERNAL_ERROR',
                message: error.message ?? 'Internal STRPG error',
                details: error.details ?? undefined,
                requestId: req.get('x-request-id') ?? undefined,
            },
        });
    });

    return router;
}


