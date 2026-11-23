import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp, move } from './helpers.js';

const API = '/api/plugins/strpg';

async function lifecycle(api, assetId) {
    const validated = await api.post(`${API}/assets/${assetId}/validate`).send({});
    if (validated.status !== 200) throw new Error(`validate failed: ${JSON.stringify(validated.body)}`);
    const reviewed = await api.post(`${API}/assets/${assetId}/review`).send({
        reviewer: 'Upgrade QA', decision: 'approve', note: 'module test',
    });
    if (reviewed.status !== 200) throw new Error(`review failed: ${JSON.stringify(reviewed.body)}`);
    const published = await api.post(`${API}/assets/${assetId}/publish`).send({});
    if (published.status !== 200) throw new Error(`publish failed: ${JSON.stringify(published.body)}`);
    return body(published);
}

async function createAsset(api, projectId, kind, data) {
    const response = await api.post(`${API}/projects/${projectId}/assets`).send({ kind, data, name: data.name });
    if (response.status !== 201) throw new Error(`create ${kind} failed: ${JSON.stringify(response.body)}`);
    const asset = body(response);
    if (!asset.validation?.valid) throw new Error(`invalid ${kind}: ${JSON.stringify(asset.validation)}`);
    return asset;
}

describe('campaign content upgrade', () => {
    it('inserts new locations, connections, events and NPCs while preserving campaign progress', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.get(`${API}/projects`))[0];
            const currentVersion = app.seeded.version;

            const glade = await createAsset(app.api, project.id, 'scene', {
                key: 'moonlit_glade', name: 'Moonlit Glade', type: 'forest', layer: 'region', region: 'Mistwood',
                description: 'A silver clearing beneath the firs.',
                map: { x: 520, y: 430 }, discoveredByDefault: false,
                connections: [{ toKey: 'mistfall_town', travelCost: 0, bidirectional: true, mode: 'road', label: 'Hidden trail' }],
                eventKeys: ['glade_awakening'], interactions: [], tags: ['module'],
            });
            const event = await createAsset(app.api, project.id, 'event', {
                key: 'glade_awakening', name: 'The Glade Answers', description: 'The clearing remembers the old wardens.',
                scope: 'scene', sceneKey: 'moonlit_glade', trigger: 'enter', once: true,
                condition: {}, actions: [{ type: 'set_flag', key: 'glade_awakened' }], tags: ['module'],
            });
            const keeper = await createAsset(app.api, project.id, 'npc', {
                key: 'glade_keeper', name: 'The Glade Keeper', kind: 'npc', title: 'Warden Echo',
                description: 'A silent figure of bark and moonlight.', personality: 'Still', motivation: 'Guard the glade.',
                locationKey: 'moonlit_glade', interactions: [{ key: 'talk', label: 'Listen', type: 'talk', dialogue: ['The roots remember.'] }],
                shop: null, questsOffered: [], joinable: false,
            });

            const assets = body(await app.api.get(`${API}/projects/${project.id}/assets`));
            const town = assets.find((asset) => asset.kind === 'scene' && asset.asset_key === 'mistfall_town');
            const revision = await app.api.post(`${API}/assets/${town.id}/new-revision`).send({});
            expect(revision.status).toBe(201);
            const townDraft = body(revision);
            const patched = await app.api.patch(`${API}/assets/${townDraft.id}`).send({
                data: {
                    ...townDraft.data,
                    connections: [
                        ...(townDraft.data.connections ?? []),
                        { toKey: 'moonlit_glade', travelCost: 0, bidirectional: true, mode: 'road', label: 'Hidden trail' },
                    ],
                },
            });
            expect(patched.status).toBe(200);
            await lifecycle(app.api, townDraft.id);
            await lifecycle(app.api, glade.id);
            await lifecycle(app.api, event.id);
            await lifecycle(app.api, keeper.id);

            const build = await app.api.post(`${API}/projects/${project.id}/build`).send({ notes: 'Moonlit Glade module' });
            expect(build.status).toBe(201);
            const built = body(build);
            expect(built.report.valid).toBe(true);
            expect(built.report.stats.locations).toBe(5);
            expect(built.report.stats.events).toBe(3);
            await app.api.post(`${API}/versions/${built.id}/publish`).send({});

            const campaign = await createCampaign(app.api, currentVersion.id);
            await app.api.post(`${API}/campaigns/${campaign.id}/interactions/elder_mira/accept_main`).send({});
            await move(app.api, campaign.id, 'greenwood_edge');
            app.db.prepare('UPDATE entities SET gold = 321, level = 4 WHERE id = ?').run(campaign.playerEntityId);
            const inventoryBefore = app.db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE campaign_id = ?').get(campaign.id).count;

            const options = body(await app.api.get(`${API}/campaigns/${campaign.id}/upgrades`));
            expect(options.available.length).toBeGreaterThanOrEqual(1);
            expect(options.available[0].canUpgrade).toBe(true);
            expect(options.available[0].diff.locations.added.map((entry) => entry.key)).toContain('moonlit_glade');
            expect(options.available[0].diff.events.added.map((entry) => entry.key)).toContain('glade_awakening');

            const upgraded = await app.api.post(`${API}/campaigns/${campaign.id}/upgrade`).send({ versionId: built.id });
            expect(upgraded.status).toBe(200);
            const result = body(upgraded);
            expect(result.toVersion.version).toBe(2);
            expect(result.campaign.gameVersion.version).toBe(2);

            const player = app.db.prepare('SELECT * FROM entities WHERE id = ?').get(campaign.playerEntityId);
            expect(player.level).toBe(4);
            expect(player.gold).toBe(321);
            const inventoryAfter = app.db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE campaign_id = ?').get(campaign.id).count;
            expect(inventoryAfter).toBe(inventoryBefore);
            const quest = app.db.prepare("SELECT status FROM quest_instances WHERE campaign_id = ? AND quest_key = 'main_sigil'").get(campaign.id);
            expect(quest.status).toBe('active');
            const keeperRow = app.db.prepare("SELECT * FROM entities WHERE campaign_id = ? AND entity_key = 'npc:glade_keeper'").get(campaign.id);
            expect(keeperRow).toBeTruthy();
            expect(keeperRow.location_id).toBe(app.db.prepare("SELECT id FROM locations WHERE location_key = 'moonlit_glade'").get().id);

            await move(app.api, campaign.id, 'mistfall_town');
            const entered = await move(app.api, campaign.id, 'moonlit_glade');
            expect(entered.worldEvents.map((entry) => entry.key)).toContain('glade_awakening');
            const flag = app.db.prepare("SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = 'flag:glade_awakened'").get(campaign.id);
            expect(flag?.value_json).toBe('true');
            const upgradeEvent = app.db.prepare("SELECT * FROM game_events WHERE campaign_id = ? AND type = 'campaign.upgraded' ORDER BY seq DESC LIMIT 1").get(campaign.id);
            expect(upgradeEvent).toBeTruthy();

            const saves = body(await app.api.get(`${API}/campaigns/${campaign.id}/saves`));
            const before = saves.find((save) => save.label.startsWith('Before upgrade'));
            expect(before).toBeTruthy();
            const restored = await app.api.post(`${API}/campaigns/${campaign.id}/saves/${before.id}/restore`).send({});
            expect(restored.status).toBe(200);
            const afterRestore = body(await app.api.get(`${API}/campaigns/${campaign.id}`));
            expect(afterRestore.campaign.gameVersion.version).toBe(1);
            expect(app.db.prepare('SELECT gold FROM entities WHERE id = ?').get(campaign.playerEntityId).gold).toBe(321);
        } finally {
            await app.close();
        }
    }, 40000);
});
