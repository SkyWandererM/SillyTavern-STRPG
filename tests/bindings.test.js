import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';

const API = '/api/plugins/strpg';

async function boot(name = 'Bindings') {
    const app = makeTestApp();
    const campaign = await createCampaign(app.api, app.seeded.version.id, name);
    return { app, campaign, cid: campaign.id };
}

describe('character card import and bindings (M3.1 / M4)', () => {
    it('imports a SillyTavern card as a DRAFT NPC asset with a unique key', async () => {
        const { app, cid } = await boot('Card Import');
        try {
            const first = await app.api.post(`${API}/campaigns/${cid}/npcs/import-card`).send({
                name: 'Seraphine the Bard',
                description: 'A wandering bard with a silver harp.',
                personality: 'Flirtatious and sharp.',
                scenario: 'She is playing for coins in the square.',
                firstMessage: 'Care for a song, traveler?',
                avatar: 'Seraphine.png',
                tags: ['bard'],
            });
            expect(first.status).toBe(201);
            expect(body(first).asset).toMatchObject({ key: 'seraphine_the_bard', status: 'DRAFT', revision: 1 });
            const asset = app.db.prepare('SELECT * FROM content_assets WHERE id = ?').get(body(first).asset.id);
            expect(asset.kind).toBe('npc');
            const data = JSON.parse(asset.data_json);
            expect(data.tavern.avatar).toBe('Seraphine.png');
            expect(data.interactions[0].dialogue[0]).toContain('song');
            expect(data.sourceCard.tags).toContain('bard');

            const second = await app.api.post(`${API}/campaigns/${cid}/npcs/import-card`).send({ name: 'Seraphine the Bard' });
            expect(second.status).toBe(201);
            expect(body(second).asset.key).toBe('seraphine_the_bard_2');
        } finally {
            await app.close();
        }
    });

    it('binds, re-binds and removes a character binding', async () => {
        const { app, cid } = await boot('Binding CRUD');
        try {
            const created = await app.api.post(`${API}/campaigns/${cid}/bindings`).send({
                npcKey: 'elder_mira', stAvatar: 'Aria.png', stCharacterName: 'Aria', direction: 'chat2rpg',
            });
            expect(created.status).toBe(201);
            expect(body(created)).toMatchObject({ npcKey: 'elder_mira', npcName: 'Elder Mira', stAvatar: 'Aria.png' });

            const list = await app.api.get(`${API}/campaigns/${cid}/bindings`);
            expect(body(list).bindings).toHaveLength(1);

            const resolved = await app.api.get(`${API}/campaigns/${cid}/bindings/resolve?avatar=Aria.png`);
            expect(body(resolved).found).toBe(true);
            expect(body(resolved).npc.name).toBe('Elder Mira');

            const rebound = await app.api.post(`${API}/campaigns/${cid}/bindings`).send({
                npcKey: 'smith_borin', stAvatar: 'Aria.png', stCharacterName: 'Aria',
            });
            expect(body(rebound).npcKey).toBe('smith_borin');
            const after = await app.api.get(`${API}/campaigns/${cid}/bindings`);
            expect(body(after).bindings).toHaveLength(1);

            const removed = await app.api.delete(`${API}/campaigns/${cid}/bindings/${body(rebound).id}`);
            expect(removed.status).toBe(200);
            const missing = await app.api.get(`${API}/campaigns/${cid}/bindings/resolve?avatar=Aria.png`);
            expect(body(missing).found).toBe(false);
        } finally {
            await app.close();
        }
    });

    it('rejects a binding to an unknown NPC', async () => {
        const { app, cid } = await boot('Binding Guard');
        try {
            const response = await app.api.post(`${API}/campaigns/${cid}/bindings`).send({ npcKey: 'nobody', stAvatar: 'x.png' });
            expect(response.status).toBe(404);
            expect(response.body.error.code).toBe('NPC_NOT_FOUND');
        } finally {
            await app.close();
        }
    });

    it('gives the active bound NPC its relationship in the chat context line', async () => {
        const { app, cid } = await boot('Binding Context');
        try {
            app.db.prepare(`
                INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json
            `).run(cid, 'npc:elder_mira:relation', '3', new Date().toISOString());
            await app.api.post(`${API}/campaigns/${cid}/bindings`).send({
                npcKey: 'elder_mira', stAvatar: 'Mira.png', stCharacterName: 'Mira',
            });
            const context = await app.api.get(`${API}/campaigns/${cid}/bindings/context?avatar=Mira.png`);
            expect(body(context).context.line).toContain('Elder Mira');
            expect(body(context).context.line).toContain('relationship 3');

            await app.api.post(`${API}/campaigns/${cid}/bindings`).send({
                npcKey: null, stAvatar: 'Player.png', stCharacterName: 'Aria', direction: 'chat2rpg',
            });
            const player = await app.api.get(`${API}/campaigns/${cid}/bindings/context?avatar=Player.png`);
            expect(body(player).context.line).toContain('player identity');
        } finally {
            await app.close();
        }
    });

    it('publishes a per-NPC world book containing only that NPC context', async () => {
        const { app, cid } = await boot('NPC Book');
        try {
            const preview = await app.api.get(`${API}/campaigns/${cid}/memory-book?npcKey=elder_mira`);
            expect(preview.status).toBe(200);
            expect(body(preview).name).toBe('STRPG - NPC Book - Elder Mira');
            const comments = Object.values(body(preview).data.entries).map((entry) => entry.comment);
            expect(comments.some((comment) => comment.includes('npc:elder_mira'))).toBe(true);
            expect(comments.some((comment) => comment.includes('npc:smith_borin'))).toBe(false);
            expect(comments.some((comment) => comment.includes('scene:'))).toBe(false);
            expect(comments.some((comment) => comment.includes('current'))).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('keeps a valid auto-scan schedule on a scope', async () => {
        const { app, cid } = await boot('Scope Schedule');
        try {
            const scheduled = await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'npc_state', name: 'NPC state',
                config: { extract: { kind: 'narrative' }, schedule: 'every_n_messages:5' },
            });
            expect(body(scheduled).config.schedule).toBe('every_n_messages:5');
            const invalid = await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'relationship_changes', name: 'Relations',
                config: { extract: { kind: 'relation' }, schedule: 'whenever' },
            });
            expect(body(invalid).config.schedule).toBe('manual');
        } finally {
            await app.close();
        }
    });
});
