import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';

const API = '/api/plugins/strpg';

describe('dashboard game state', () => {
    it('aggregates party, nearby NPCs, routes, inventory, journal and combat for the HUD', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'HUD Campaign');
            const cid = campaign.id;

            let response = await app.api.get(`${API}/campaigns/${cid}/dashboard`);
            expect(response.status).toBe(200);
            const dashboard = body(response);

            expect(Array.isArray(dashboard.party)).toBe(true);
            expect(dashboard.party).toHaveLength(0);
            expect(Array.isArray(dashboard.effects)).toBe(true);
            expect(dashboard.inventory.gold).toBe(dashboard.player.gold);
            expect(dashboard.inventory.stacks).toBeGreaterThanOrEqual(0);
            expect(Array.isArray(dashboard.journal)).toBe(true);
            expect(dashboard.journal.length).toBeGreaterThan(0);
            expect(dashboard.combat).toBeNull();

            const nearbyKeys = dashboard.nearbyNpcs.map((npc) => npc.npcKey);
            expect(nearbyKeys).toContain('elder_mira');
            expect(nearbyKeys).toContain('herbalist_lina');
            expect(dashboard.nearbyNpcs.every((npc) => typeof npc.hp === 'number' && npc.maxHp > 0)).toBe(true);

            expect(dashboard.exits.length).toBeGreaterThan(0);
            const edge = dashboard.exits.find((exit) => exit.key === 'greenwood_edge');
            expect(edge).toBeTruthy();
            expect(edge.available).toBe(true);

            // Promote a seeded NPC into the party and confirm it moves from
            // "nearby" to the party roster without duplicating.
            const npc = app.db.prepare("SELECT id FROM entities WHERE campaign_id = ? AND entity_key LIKE 'npc:%' ORDER BY name LIMIT 1").get(cid);
            app.db.prepare("UPDATE entities SET data_json = json_set(data_json, '$.party', 1) WHERE id = ?").run(npc.id);

            response = await app.api.get(`${API}/campaigns/${cid}/dashboard`);
            const withParty = body(response);
            expect(withParty.party).toHaveLength(1);
            expect(withParty.party[0].maxHp).toBeGreaterThan(0);
            expect(withParty.nearbyNpcs.find((entry) => entry.id === npc.id)).toBeUndefined();

            response = await app.api.post(`${API}/campaigns/${cid}/encounters/propose`).send({
                encounterKey: 'hud_check',
                monsters: [{ monsterKey: 'forest_goblin', count: 1 }],
            });
            expect(response.status).toBe(201);

            response = await app.api.get(`${API}/campaigns/${cid}/dashboard`);
            const withCombat = body(response);
            expect(withCombat.pendingCombat).toBeTruthy();
            expect(withCombat.combat).toBeTruthy();
            expect(withCombat.combat.status).toBe('pending');
            expect(withCombat.combat.enemies.length).toBeGreaterThan(0);
            expect(withCombat.combat.participants.length).toBeGreaterThan(1);
        } finally {
            await app.close();
        }
    });
});
