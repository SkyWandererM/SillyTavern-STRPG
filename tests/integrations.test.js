import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';

const API = '/api/plugins/strpg';

describe('adapters, backups and security', () => {
    it('accepts only narrative whitelist fields from the tracker bridge', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Integrations');
            const ok = await app.api.post(`${API}/campaigns/${campaign.id}/integrations/tracker/sync`).send({
                state: { mood: 'wary', trust: 3, summary: 'The elder is hiding something.' },
            });
            expect(ok.status).toBe(200);
            expect(body(ok).authoritativeFields).toEqual([]);

            const rejected = await app.api.post(`${API}/campaigns/${campaign.id}/integrations/tracker/sync`).send({
                state: { mood: 'wary', hp: 9999, exp: 99999 },
            });
            expect(rejected.status).toBe(422);
            expect(rejected.body.error.message).toContain('hp');

            const state = await app.api.get(`${API}/campaigns/${campaign.id}/integrations/tracker`);
            expect(body(state).state.mood).toBe('wary');
            expect(body(state).state.hp).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('exports Memory Books text without mutating external databases', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Memory');
            const response = await app.api.get(`${API}/campaigns/${campaign.id}/integrations/memory-books`);
            expect(response.status).toBe(200);
            expect(body(response).markdown).toContain('STRPG Story Memory');
            expect(body(response).note).toContain('does not write Memory Books');
        } finally {
            await app.close();
        }
    });

    it('imports and exports map region metadata without changing connections', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Regions');
            const before = body(await app.api.get(`${API}/campaigns/${campaign.id}/map`));
            const imported = await app.api.post(`${API}/campaigns/${campaign.id}/integrations/map-regions/import`).send({
                regions: [{
                    locationKey: 'greenwood_edge', regionId: 'forest_edge', label: 'Forest Edge Region',
                    polygon: [[300, 200], [400, 200], [400, 300], [300, 300]],
                }],
            });
            expect(imported.status).toBe(200);
            const after = body(await app.api.get(`${API}/campaigns/${campaign.id}/map`));
            expect(after.connections.length).toBe(before.connections.length);
            const exported = await app.api.get(`${API}/campaigns/${campaign.id}/integrations/map-regions/export`);
            expect(body(exported).regions[0].regionId).toBe('forest_edge');
        } finally {
            await app.close();
        }
    });

    it('creates and restores a transactional JSON database backup', async () => {
        const app = makeTestApp();
        try {
            const backup = await app.api.post(`${API}/admin/backups`).send({ label: 'test backup' });
            expect(backup.status).toBe(201);
            const name = body(backup).name;
            const countBefore = app.db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count;
            app.db.prepare('DELETE FROM game_projects').run();
            expect(app.db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count).toBe(0);
            const restore = await app.api.post(`${API}/admin/backups/${encodeURIComponent(name)}/restore`).send({});
            expect(restore.status).toBe(200);
            expect(app.db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count).toBe(countBefore);
            const listed = await app.api.get(`${API}/admin/backups`);
            expect(body(listed).some((entry) => entry.name === name)).toBe(true);
        } finally {
            await app.close();
        }
    }, 30000);

    it('validates unknown content kinds and missing project ids', async () => {
        const app = makeTestApp();
        try {
            const badKind = await app.api.post(`${API}/projects/${app.seeded.projectId}/assets`).send({ kind: 'spaceship', data: { key: 'x' } });
            expect(badKind.status).toBe(422);
            const missing = await app.api.get(`${API}/projects/prj_missing`);
            expect(missing.status).toBe(404);
            const tool = await app.api.post(`${API}/tools/strpg_get_status`).send({ campaignId: 'cmp_missing' });
            expect(tool.status).toBe(404);
        } finally {
            await app.close();
        }
    });
});
