import { describe, expect, it } from 'vitest';
import { body, makeTestApp } from './helpers.js';

const API = '/api/plugins/strpg';

describe('studio content lifecycle', () => {
    it('enforces DRAFT → VALIDATION → REVIEWED → PUBLISHED and immutability', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.get(`${API}/projects`))[0];
            const created = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                kind: 'npc',
                data: {
                    key: 'test_scholar', name: 'Test Scholar', kind: 'npc', title: 'Scholar', description: 'A test scholar.',
                    personality: 'Precise', motivation: 'Verify the workflow', locationKey: 'mistfall_town',
                    interactions: [{ key: 'talk', label: 'Talk', type: 'talk', dialogue: ['Hello.'] }],
                    shop: null, questsOffered: [], joinable: false, relations: {},
                },
            });
            expect(created.status).toBe(201);
            const asset = body(created);
            expect(asset.status).toBe('DRAFT');
            expect(asset.validation.valid).toBe(true);

            const prematurePublish = await app.api.post(`${API}/assets/${asset.id}/publish`).send({});
            expect(prematurePublish.status).toBe(409);

            const validated = await app.api.post(`${API}/assets/${asset.id}/validate`).send({});
            expect(body(validated).status).toBe('VALIDATION');

            const review = await app.api.post(`${API}/assets/${asset.id}/review`).send({ reviewer: 'QA', decision: 'approve', note: 'ok' });
            expect(body(review).status).toBe('REVIEWED');

            const published = await app.api.post(`${API}/assets/${asset.id}/publish`).send({});
            expect(body(published).status).toBe('PUBLISHED');

            const edit = await app.api.patch(`${API}/assets/${asset.id}`).send({ data: { ...published.data, name: 'Changed' } });
            expect(edit.status).toBe(409);

            const revision = await app.api.post(`${API}/assets/${asset.id}/new-revision`).send({});
            expect(revision.status).toBe(201);
            expect(body(revision).status).toBe('DRAFT');
            expect(body(revision).revision).toBe(2);
        } finally {
            await app.close();
        }
    }, 20000);

    it('normalizes designer kind aliases and expands a world_map into world + scene assets', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.post(`${API}/projects`).send({ name: 'Alias Import' }));
            const worldMap = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                kind: 'world_map',
                data: {
                    key: 'moon_map', name: 'Moon Map', description: 'A map of the moonlit glade.',
                    startLocationKey: 'glade',
                    locations: [
                        { key: 'glade', name: 'Moonlit Glade', type: 'forest', region: 'Moon', description: 'A quiet glade.', map: { x: 10, y: 20 }, connections: [] },
                        { key: 'shrine', name: 'Moon Shrine', type: 'dungeon', region: 'Moon', description: 'A ruined shrine.', map: { x: 40, y: 20 }, connections: [] },
                    ],
                    connections: [{ from: 'glade', to: 'shrine', bidirectional: true, label: 'Stone path' }],
                },
            });
            expect(worldMap.status).toBe(201);
            const worldResult = body(worldMap);
            expect(worldResult.kind).toBe('world');
            expect(worldResult.normalization.originalKind).toBe('world_map');
            expect(worldResult.normalization.canonicalKind).toBe('world');
            expect(worldResult.createdAssets).toHaveLength(3);
            const assets = body(await app.api.get(`${API}/projects/${project.id}/assets`));
            expect(assets.filter((asset) => asset.kind === 'scene')).toHaveLength(2);
            expect(assets.find((asset) => asset.asset_key === 'glade').data.connections[0].toKey).toBe('shrine');

            const batch = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                items: [
                    {
                        kind: 'character',
                        asset: {
                            key: 'moon_archivist', name: 'Moon Archivist', kind: 'npc', locationKey: 'glade',
                            description: 'Keeper of the lunar archive.', personality: 'Calm', motivation: 'Remember names.',
                            interactions: [{ key: 'talk', label: 'Talk', type: 'talk', dialogue: ['The moon remembers.'] }],
                            shop: null, questsOffered: [], joinable: false,
                        },
                    },
                    {
                        kind: 'item',
                        asset: { key: 'moon_ring', name: 'Moon Ring', kind: 'accessory', slot: 'accessory', stackable: false, maxStack: 1, price: 40, stats: { luck: 1 }, description: 'A silver ring.' },
                    },
                ],
            });
            expect(batch.status).toBe(201);
            expect(body(batch).summary.items).toBe(2);
            expect(body(batch).summary.mappedKinds).toEqual(expect.arrayContaining([
                { from: 'character', to: 'npc' },
                { from: 'item', to: 'equipment' },
            ]));
            expect(body(batch).created.every((entry) => entry.status === 'DRAFT')).toBe(true);

            const mixedWorld = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                kind: 'world',
                data: {
                    key: 'mixed_world', name: 'Mixed World', description: 'Invalid mixed asset.', startLocationKey: 'glade',
                    locations: [{ key: 'glade', name: 'Glade', type: 'forest', connections: [] }],
                },
            });
            expect(mixedWorld.status).toBe(201);
            expect(body(mixedWorld).validation.valid).toBe(false);
            expect(JSON.stringify(mixedWorld.body)).toMatch(/world asset holds setting metadata only/i);
        } finally {
            await app.close();
        }
    }, 20000);

    it('reports unreachable story nodes and blocks an invalid build', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.post(`${API}/projects`).send({ name: 'Validation Project' }));
            const created = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                kind: 'story',
                data: {
                    key: 'bad_story', name: 'Bad Story', description: '', startNodeKey: 'a', endings: ['c'], variables: {},
                    nodes: [
                        { key: 'a', title: 'A', type: 'scene', map: { x: 0, y: 0 } },
                        { key: 'b', title: 'B', type: 'scene', map: { x: 100, y: 0 } },
                        { key: 'c', title: 'C', type: 'ending', map: { x: 200, y: 0 } },
                    ],
                    edges: [{ key: 'a_c', from: 'a', to: 'c' }],
                },
            });
            const asset = body(created);
            const validation = await app.api.post(`${API}/assets/${asset.id}/validate`).send({});
            expect(body(validation).validation.valid).toBe(false);
            expect(body(validation).validation.errors.some((entry) => entry.code === 'STORY_NODE_UNREACHABLE')).toBe(true);
            expect(body(validation).validation.errors.some((entry) => entry.code === 'STORY_DEAD_END')).toBe(true);
            const build = await app.api.post(`${API}/projects/${project.id}/build`).send({});
            expect(build.status).toBe(422);
        } finally {
            await app.close();
        }
    }, 20000);

    it('builds and publishes another version from published assets', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.get(`${API}/projects/${app.seeded.projectId}`));
            const build = await app.api.post(`${API}/projects/${project.id}/build`).send({ notes: 'second build' });
            expect(build.status).toBe(201);
            expect(body(build).report.valid).toBe(true);
            expect(body(build).version).toBe(2);
            const publish = await app.api.post(`${API}/versions/${body(build).id}/publish`).send({});
            expect(body(publish).status).toBe('published');
            const exported = await app.api.get(`${API}/versions/${body(build).id}/export`);
            expect(exported.status).toBe(200);
            expect(exported.body.package.schema).toBe('strpg.game-package');
        } finally {
            await app.close();
        }
    }, 20000);

    it('imports an exported game package as new DRAFT content', async () => {
        const app = makeTestApp();
        try {
            const exported = await app.api.get(`${API}/versions/${app.seeded.version.id}/export`);
            const response = await app.api.post(`${API}/projects/${app.seeded.projectId}/import-package`).send({ package: exported.body.package });
            expect(response.status).toBe(201);
            const result = body(response);
            expect(result.importedAssets).toBeGreaterThan(10);
            expect(result.note).toContain('DRAFT');
            const imported = await app.api.get(`${API}/projects/${result.project.id}/assets`);
            expect(body(imported).every((asset) => asset.status === 'DRAFT')).toBe(true);
        } finally {
            await app.close();
        }
    }, 30000);
});
