import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';
import { countItem } from '../plugin/src/inventory.js';

const API = '/api/plugins/strpg';

async function boot(name = 'Scopes') {
    const app = makeTestApp();
    const campaign = await createCampaign(app.api, app.seeded.version.id, name);
    return { app, campaign, cid: campaign.id };
}

function playerRow(app, cid) {
    return app.db.prepare('SELECT e.* FROM campaigns c JOIN entities e ON e.id = c.player_entity_id WHERE c.id = ?').get(cid);
}

function relationOf(app, cid, npcKey) {
    const row = app.db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?')
        .get(cid, `npc:${npcKey}:relation`);
    return row ? JSON.parse(row.value_json) : null;
}

describe('memory scopes (M3)', () => {
    it('creates starter scopes and lists them', async () => {
        const { app, cid } = await boot('Scope Defaults');
        try {
            const created = await app.api.post(`${API}/campaigns/${cid}/scopes/defaults`).send({});
            expect(created.status).toBe(200);
            expect(body(created).scopes).toHaveLength(2);
            const list = await app.api.get(`${API}/campaigns/${cid}/scopes`);
            expect(body(list).scopes.map((scope) => scope.key).sort()).toEqual(['npc_state', 'relationship_changes']);
            expect(body(list).kinds).toContain('performance');
        } finally {
            await app.close();
        }
    });

    it('builds an extraction prompt from a chat window and skips when filters fail', async () => {
        const { app, cid } = await boot('Scope Prompt');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'npc_state', name: 'NPC state',
                config: { extract: { kind: 'narrative' }, source: { type: 'chat', lastN: 4 }, filter: { requiresKey: ['sigil'] } },
            });
            const prepared = await app.api.post(`${API}/campaigns/${cid}/scopes/npc_state/prepare`).send({
                messages: [
                    { speaker: 'Aria', text: 'I found the ember sigil in the shrine.' },
                    { speaker: 'Elder Mira', text: 'Then the pact remembers us.' },
                ],
            });
            expect(prepared.status).toBe(200);
            expect(body(prepared).skipped).toBe(false);
            expect(body(prepared).prompt).toContain('Elder Mira: Then the pact remembers us.');
            expect(body(prepared).prompt).toContain('Allowed field keys');
            expect(body(prepared).messageCount).toBe(2);

            const skipped = await app.api.post(`${API}/campaigns/${cid}/scopes/npc_state/prepare`).send({
                messages: [{ speaker: 'Aria', text: 'Good morning.' }],
            });
            expect(body(skipped).skipped).toBe(true);
            expect(body(skipped).reason).toContain('sigil');
        } finally {
            await app.close();
        }
    });

    it('ingests narrative items into the review queue with scope provenance and dedupe', async () => {
        const { app, cid } = await boot('Scope Ingest');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'npc_state', name: 'NPC state', config: { extract: { kind: 'narrative' } },
            });
            const payload = {
                items: [{ npcKey: 'elder_mira', fields: { mood: 'warm', trust: 4, hp: 9999, summary: 'She finally trusts the player.' } }],
                source: 'manual',
                messageCount: 3,
            };
            const first = await app.api.post(`${API}/campaigns/${cid}/scopes/npc_state/scan`).send(payload);
            expect(first.status).toBe(200);
            expect(body(first).queued).toBe(1);
            const candidate = body(first).candidates[0];
            expect(candidate.scopeKey).toBe('npc_state');
            expect(candidate.payload.fields.hp).toBeUndefined();
            expect(candidate.payload.fields.mood).toBe('warm');

            const second = await app.api.post(`${API}/campaigns/${cid}/scopes/npc_state/scan`).send(payload);
            expect(body(second).queued).toBe(0);
            expect(body(second).duplicates).toBe(1);
            const lastRun = app.db.prepare('SELECT last_run_at FROM memory_scopes WHERE campaign_id = ? AND scope_key = ?').get(cid, 'npc_state');
            expect(lastRun.last_run_at).toBeTruthy();
        } finally {
            await app.close();
        }
    });

    it('accepts a single manual note as a narrative memory', async () => {
        const { app, cid } = await boot('Scope Note');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'npc_state', name: 'NPC state', config: { extract: { kind: 'narrative' } },
            });
            const result = await app.api.post(`${API}/campaigns/${cid}/scopes/npc_state/scan`).send({
                note: 'Mira agreed to teach fireball after the shrine is cleansed.',
            });
            expect(result.status).toBe(200);
            expect(body(result).queued).toBe(1);
            expect(body(result).candidates[0].payload.fields.summary).toContain('teach fireball');
        } finally {
            await app.close();
        }
    });

    it('rejects a manual note on a non-narrative scope', async () => {
        const { app, cid } = await boot('Scope Note Guard');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'relationship_changes', name: 'Relations', config: { extract: { kind: 'relation' } },
            });
            const result = await app.api.post(`${API}/campaigns/${cid}/scopes/relationship_changes/scan`).send({ note: 'she likes me' });
            expect(result.status).toBe(422);
            expect(result.body.error.message).toContain('narrative scopes');
        } finally {
            await app.close();
        }
    });

    it('parses raw model answers wrapped in prose and skips invalid items', async () => {
        const { app, cid } = await boot('Scope Raw');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'relationship_changes', name: 'Relations', config: { extract: { kind: 'relation' } },
            });
            const raw = 'Here you go:\n```json\n{"items":[{"npcKey":"elder_mira","delta":1,"reason":"Returned the sigil"},{"npcKey":"elder_mira","delta":9,"reason":"too much"}]}\n```';
            const result = await app.api.post(`${API}/campaigns/${cid}/scopes/relationship_changes/scan`).send({ raw, source: 'llm' });
            expect(result.status).toBe(200);
            expect(body(result).queued).toBe(1);
            expect(body(result).skipped).toHaveLength(1);
            expect(body(result).skipped[0].reason).toContain('cannot change more than');
            expect(body(result).candidates[0].kind).toBe('relation');
        } finally {
            await app.close();
        }
    });

    it('updates and deletes a scope', async () => {
        const { app, cid } = await boot('Scope Lifecycle');
        try {
            await app.api.post(`${API}/campaigns/${cid}/scopes`).send({ key: 'npc_state', name: 'NPC state' });
            const updated = await app.api.post(`${API}/campaigns/${cid}/scopes`).send({
                key: 'npc_state', name: 'NPC state v2', enabled: false, config: { extract: { kind: 'flag' } },
            });
            expect(body(updated).name).toBe('NPC state v2');
            expect(body(updated).enabled).toBe(false);
            expect(body(updated).config.extract.kind).toBe('flag');
            const deleted = await app.api.delete(`${API}/campaigns/${cid}/scopes/npc_state`);
            expect(body(deleted).deleted).toBe('npc_state');
            const list = await app.api.get(`${API}/campaigns/${cid}/scopes`);
            expect(body(list).scopes).toHaveLength(0);
        } finally {
            await app.close();
        }
    });
});

describe('service barter (M3)', () => {
    it('fronts the item, starts the quest, and settles the debt on turn-in', async () => {
        const { app, cid } = await boot('Barter Flow');
        try {
            const player = playerRow(app, cid);
            const swordsBefore = countItem(app.db, cid, player.id, 'iron_sword');
            const relationBefore = relationOf(app, cid, 'smith_borin') ?? 0;

            const propose = await app.api.post(`${API}/tools/strpg_propose_barter`).send({
                campaignId: cid, npcKey: 'smith_borin', itemKey: 'iron_sword',
            });
            expect(propose.status).toBe(200);
            const candidate = body(propose).result.candidate;
            expect(candidate.kind).toBe('barter');
            expect(candidate.payload.questKey).toBe('wolf_hunt');

            const approve = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'barter.started', questKey: 'wolf_hunt', debt: true });
            expect(countItem(app.db, cid, player.id, 'iron_sword')).toBe(swordsBefore + 1);
            const quest = app.db.prepare('SELECT status FROM quest_instances WHERE campaign_id = ? AND quest_key = ?').get(cid, 'wolf_hunt');
            expect(quest.status).toBe('active');
            const debt = app.db.prepare("SELECT COUNT(*) AS count FROM campaign_variables WHERE campaign_id = ? AND var_key LIKE 'barter:%'").get(cid).count;
            expect(debt).toBe(1);

            app.db.prepare("UPDATE quest_instances SET status = 'ready_to_turn_in' WHERE campaign_id = ? AND quest_key = ?").run(cid, 'wolf_hunt');
            const turnIn = await app.api.post(`${API}/campaigns/${cid}/quests/wolf_hunt/turn-in`).send({});
            expect(turnIn.status).toBe(200);
            expect(body(turnIn).quest.barters).toHaveLength(1);
            expect(relationOf(app, cid, 'smith_borin')).toBe(relationBefore + 1);
            const remaining = app.db.prepare("SELECT COUNT(*) AS count FROM campaign_variables WHERE campaign_id = ? AND var_key LIKE 'barter:%'").get(cid).count;
            expect(remaining).toBe(0);
        } finally {
            await app.close();
        }
    });

    it('requires an override to settle a barter whose quest is already finished', async () => {
        const { app, cid } = await boot('Barter Manual');
        try {
            const player = playerRow(app, cid);
            const swordsBefore = countItem(app.db, cid, player.id, 'iron_sword');
            app.db.prepare("UPDATE quest_instances SET status = 'turned_in' WHERE campaign_id = ? AND quest_key = ?").run(cid, 'wolf_hunt');
            const propose = await app.api.post(`${API}/tools/strpg_propose_barter`).send({
                campaignId: cid, npcKey: 'smith_borin', itemKey: 'iron_sword',
            });
            expect(propose.status).toBe(200);
            const candidate = body(propose).result.candidate;

            const blocked = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`).send({});
            expect(blocked.status).toBe(409);
            expect(blocked.body.error.code).toBe('BARTER_ALREADY_DONE');

            const released = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`)
                .send({ overrideReason: 'The service was completed earlier in the campaign.' });
            expect(released.status).toBe(200);
            expect(body(released).applied).toMatchObject({ target: 'barter.settled', manual: true });
            expect(countItem(app.db, cid, player.id, 'iron_sword')).toBe(swordsBefore + 1);
        } finally {
            await app.close();
        }
    });
});
