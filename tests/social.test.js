import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';
import { addItem, countItem } from '../plugin/src/inventory.js';
import { runEventDefinitions } from '../plugin/src/world.js';

const API = '/api/plugins/strpg';

async function boot(name = 'Social') {
    const app = makeTestApp();
    const campaign = await createCampaign(app.api, app.seeded.version.id, name);
    return { app, campaign, cid: campaign.id };
}

function playerRow(app, cid) {
    return app.db.prepare('SELECT e.* FROM campaigns c JOIN entities e ON e.id = c.player_entity_id WHERE c.id = ?').get(cid);
}

function goldOf(app, cid) {
    return Number(playerRow(app, cid).gold);
}

function relationOf(app, cid, npcKey) {
    const row = app.db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?')
        .get(cid, `npc:${npcKey}:relation`);
    return row ? JSON.parse(row.value_json) : null;
}

function npcEntity(app, cid, npcKey) {
    return app.db.prepare('SELECT * FROM entities WHERE campaign_id = ? AND entity_key = ?').get(cid, `npc:${npcKey}`);
}

describe('NPC social services (M2)', () => {
    it('exposes shop prices, tuition and party state for an NPC', async () => {
        const { app, cid } = await boot('Social Options');
        try {
            const response = await app.api.get(`${API}/campaigns/${cid}/social/smith_borin`);
            expect(response.status).toBe(200);
            const options = body(response);
            expect(options.shop.haggle.enabled).toBe(true);
            expect(options.shop.items.find((entry) => entry.itemKey === 'iron_sword').unitList).toBe(120);
            expect(options.teaching).toHaveLength(1);
            expect(options.teaching[0]).toMatchObject({ skillKey: 'quick_slash', known: false });
            expect(options.recruit).toMatchObject({ enabled: true, relationRequired: 0 });
            expect(options.partyCount).toBe(0);
        } finally {
            await app.close();
        }
    });

    it('counter-offers instead of granting a lowball price, then charges the agreed price', async () => {
        const { app, cid } = await boot('Social Trade');
        try {
            app.db.prepare('UPDATE entities SET gold = 500 WHERE id = ?').run(playerRow(app, cid).id);
            const before = goldOf(app, cid);
            const swordsBefore = countItem(app.db, cid, playerRow(app, cid).id, 'iron_sword');
            const response = await app.api.post(`${API}/tools/strpg_propose_trade`).send({
                campaignId: cid, npcKey: 'smith_borin', itemKey: 'iron_sword', quantity: 1, offerPrice: 100,
            });
            expect(response.status).toBe(200);
            const result = body(response).result;
            expect(result.quote.unitList).toBe(120);
            expect(result.quote.accepted).toBe(false);
            expect(result.quote.countered).toBe(true);
            expect(result.quote.unitFinal).toBeGreaterThan(100);
            expect(result.quote.unitFinal).toBeLessThan(120);

            const price = result.candidate.payload.unitPrice;
            const approve = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${result.candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'trade', itemKey: 'iron_sword', quantity: 1 });
            expect(goldOf(app, cid)).toBe(before - price);
            expect(countItem(app.db, cid, playerRow(app, cid).id, 'iron_sword')).toBe(swordsBefore + 1);
        } finally {
            await app.close();
        }
    });

    it('refuses an insulting offer', async () => {
        const { app, cid } = await boot('Social Insult');
        try {
            const response = await app.api.post(`${API}/tools/strpg_propose_trade`).send({
                campaignId: cid, npcKey: 'smith_borin', itemKey: 'iron_sword', quantity: 1, offerPrice: 10,
            });
            expect(response.status).toBe(409);
            expect(response.body.error.code).toBe('OFFER_TOO_LOW');
        } finally {
            await app.close();
        }
    });

    it('recruits an NPC only after approval and charges the configured cost', async () => {
        const { app, cid } = await boot('Social Recruit');
        try {
            const before = goldOf(app, cid);
            const propose = await app.api.post(`${API}/tools/strpg_propose_recruit`).send({ campaignId: cid, npcKey: 'elder_mira' });
            expect(propose.status).toBe(200);
            const candidate = body(propose).result.candidate;
            expect(candidate.payload.cost).toEqual({ gold: 60, items: [] });
            expect(npcEntity(app, cid, 'elder_mira').data_json).not.toContain('"party":true');

            const approve = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'party.join', npcKey: 'elder_mira' });
            expect(JSON.parse(npcEntity(app, cid, 'elder_mira').data_json).party).toBe(true);
            expect(goldOf(app, cid)).toBe(before - 60);

            const again = await app.api.post(`${API}/tools/strpg_propose_recruit`).send({ campaignId: cid, npcKey: 'elder_mira' });
            expect(again.status).toBe(409);
            expect(again.body.error.code).toBe('ALREADY_IN_PARTY');
        } finally {
            await app.close();
        }
    });

    it('blocks recruiting when the item part of the cost is missing', async () => {
        const { app, cid } = await boot('Social Recruit Cost');
        try {
            const response = await app.api.post(`${API}/tools/strpg_propose_recruit`).send({ campaignId: cid, npcKey: 'herbalist_lina' });
            expect(response.status).toBe(409);
            expect(response.body.error.code).toBe('INSUFFICIENT_PAYMENT');
            expect(response.body.error.details.missing.some((entry) => entry.itemKey === 'herb')).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('teaches a skill for tuition, then refuses a duplicate purchase', async () => {
        const { app, cid } = await boot('Social Tuition');
        try {
            const before = goldOf(app, cid);
            const propose = await app.api.post(`${API}/tools/strpg_propose_tuition`).send({
                campaignId: cid, npcKey: 'smith_borin', skillKey: 'quick_slash',
            });
            expect(propose.status).toBe(200);
            const candidate = body(propose).result.candidate;
            expect(candidate.payload.tuition).toEqual({ gold: 40, items: [] });

            const approve = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'skill.unlocked', skillKey: 'quick_slash' });
            expect(goldOf(app, cid)).toBe(before - 40);
            const known = app.db.prepare(`
                SELECT COUNT(*) AS count FROM entity_skills es
                JOIN skill_definitions s ON s.id = es.skill_definition_id
                WHERE es.entity_id = ? AND s.skill_key = 'quick_slash'
            `).get(playerRow(app, cid).id).count;
            expect(known).toBe(1);

            const again = await app.api.post(`${API}/tools/strpg_propose_tuition`).send({
                campaignId: cid, npcKey: 'smith_borin', skillKey: 'quick_slash',
            });
            expect(again.status).toBe(409);
            expect(again.body.error.code).toBe('ALREADY_KNOWN');
        } finally {
            await app.close();
        }
    });

    it('lets a recruited NPC ask for help and rewards the interaction', async () => {
        const { app, cid } = await boot('Social Recovery');
        try {
            const player = playerRow(app, cid);
            addItem(app.db, cid, player.id, 'herb', 2);
            const recruit = await app.api.post(`${API}/tools/strpg_propose_recruit`).send({ campaignId: cid, npcKey: 'herbalist_lina' });
            expect(recruit.status).toBe(200);
            const c1 = body(recruit).result.candidate;
            const r1 = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${c1.id}/approve`).send({});
            expect(r1.status).toBe(200);

            const lina = npcEntity(app, cid, 'herbalist_lina');
            const maxHp = Number(app.db.prepare('SELECT base_value FROM entity_stats WHERE entity_id = ? AND stat_key = ?').get(lina.id, 'maxHp')?.base_value ?? 60);
            app.db.prepare('UPDATE entities SET hp = ? WHERE id = ?').run(Math.max(1, Math.floor(maxHp * 0.1)), lina.id);

            const propose = await app.api.post(`${API}/tools/strpg_propose_recovery`).send({
                campaignId: cid, npcKey: 'herbalist_lina', method: 'tend',
            });
            expect(propose.status).toBe(200);
            const candidate = body(propose).result.candidate;
            const hpBefore = Number(npcEntity(app, cid, 'herbalist_lina').hp);
            const relationBefore = relationOf(app, cid, 'herbalist_lina') ?? 0;

            const approve = await app.api.post(`${API}/campaigns/${cid}/bridge/candidates/${candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'npc.recovery', npcKey: 'herbalist_lina' });
            expect(Number(npcEntity(app, cid, 'herbalist_lina').hp)).toBeGreaterThan(hpBefore);
            expect(relationOf(app, cid, 'herbalist_lina')).toBe(relationBefore + 1);

            const healthy = await app.api.post(`${API}/tools/strpg_propose_recovery`).send({
                campaignId: cid, npcKey: 'herbalist_lina', method: 'tend',
            });
            expect(healthy.status).toBe(409);
            expect(healthy.body.error.code).toBe('RECOVERY_NOT_NEEDED');
        } finally {
            await app.close();
        }
    });

    it('runs the configured defeat event: relation drop, memory candidate, notice', async () => {
        const { app, cid } = await boot('Social Defeat');
        try {
            const before = relationOf(app, cid, 'elder_mira') ?? 0;
            const fired = runEventDefinitions(app.db, cid, {
                trigger: 'combat_defeat', sceneKey: 'old_shrine', targetKey: 'goblin_patrol',
            });
            expect(fired).toHaveLength(1);
            expect(fired[0].applied.some((entry) => entry.type === 'relation' && entry.after === before - 1)).toBe(true);
            expect(fired[0].applied.some((entry) => entry.type === 'memory' && entry.candidateId)).toBe(true);
            expect(fired[0].applied.some((entry) => entry.type === 'notice')).toBe(true);
            expect(relationOf(app, cid, 'elder_mira')).toBe(before - 1);
            const queued = app.db.prepare("SELECT COUNT(*) AS count FROM bridge_candidates WHERE campaign_id = ? AND kind = 'narrative'").get(cid).count;
            expect(queued).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('supports taking items from event actions', async () => {
        const { app, cid } = await boot('Social Defeat Item');
        try {
            const gameVersionId = app.db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(cid).game_version_id;
            app.db.prepare(`
                INSERT INTO event_definitions (id, game_version_id, event_key, name, scope, scene_key, trigger, target_key, priority, once, condition_json, actions_json, data_json)
                VALUES (?, ?, 'defeat_toll', 'Defeat Toll', 'world', NULL, 'combat_defeat', NULL, 0, 1, '{}', ?, '{}')
            `).run(
                crypto.randomUUID(),
                gameVersionId,
                JSON.stringify([{ type: 'take_item', itemKey: 'healing_herb', amount: 1 }]),
            );
            const player = playerRow(app, cid);
            const before = countItem(app.db, cid, player.id, 'healing_herb');
            const fired = runEventDefinitions(app.db, cid, { trigger: 'combat_defeat' });
            expect(fired.some((event) => event.key === 'defeat_toll')).toBe(true);
            expect(countItem(app.db, cid, player.id, 'healing_herb')).toBe(before - 1);
        } finally {
            await app.close();
        }
    });
});
