import { describe, expect, it } from 'vitest';
import { body, createCampaign, fightUntilOver, makeTestApp, move } from './helpers.js';

const API = '/api/plugins/strpg';

describe('campaign acceptance flow', () => {
    it('runs campaign creation, NPC quest, combat, settlement, ending, save and chat recovery', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id);
            const cid = campaign.id;

            let response = await app.api.get(`${API}/campaigns/${cid}/dashboard`);
            expect(response.status).toBe(200);
            expect(body(response).location.key).toBe('mistfall_town');
            expect(body(response).story.current.key).toBe('town_arrival');

            response = await app.api.get(`${API}/campaigns/${cid}/interactions`);
            expect(response.status).toBe(200);
            const elder = body(response).find((entry) => entry.npc.key === 'elder_mira');
            expect(elder).toBeTruthy();
            expect(elder.interactions.find((entry) => entry.key === 'accept_main').available).toBe(true);

            response = await app.api.post(`${API}/campaigns/${cid}/interactions/elder_mira/accept_main`).send({});
            expect(response.status).toBe(200);
            expect(body(response).quest.status).toBe('active');

            await move(app.api, cid, 'greenwood_edge');
            response = await app.api.get(`${API}/campaigns/${cid}/story`);
            expect(body(response).current.key).toBe('forest_discovery');

            // Keep this flow deterministic: the test is about settlement and
            // progression, not about a level-1 party losing to RNG.
            const playerRow = app.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND is_player = 1').get(cid);
            app.db.prepare("UPDATE entity_stats SET base_value = 1000 WHERE entity_id = ? AND stat_key = 'maxHp'").run(playerRow.id);
            app.db.prepare("UPDATE entity_stats SET base_value = 100 WHERE entity_id = ? AND stat_key = 'atk'").run(playerRow.id);
            app.db.prepare('UPDATE entities SET hp = 1000 WHERE id = ?').run(playerRow.id);

            response = await app.api.post(`${API}/campaigns/${cid}/encounters/propose`).send({
                encounterKey: 'acceptance_goblins',
                monsters: [{ monsterKey: 'forest_goblin', count: 2 }],
            });
            expect(response.status).toBe(201);
            const combatId = body(response).id;

            const finished = await fightUntilOver(app.api, cid, combatId);
            expect(finished.status).toBe('victory');
            expect(finished.result.exp).toBeGreaterThan(0);
            expect(finished.result.gold).toBeGreaterThan(0);
            expect(finished.participants.filter((participant) => participant.side === 'enemy').every((participant) => !participant.alive)).toBe(true);

            response = await app.api.get(`${API}/campaigns/${cid}/quests/main_sigil`);
            expect(body(response).stageKey).toBe('report');
            const investigate = body(response).stages.find((stage) => stage.key === 'investigate');
            expect(investigate.objectives.find((objective) => objective.key === 'kill_goblins').current).toBe(2);

            await move(app.api, cid, 'mistfall_town');
            response = await app.api.post(`${API}/campaigns/${cid}/interactions/elder_mira/talk`).send({});
            expect(response.status).toBe(200);
            response = await app.api.get(`${API}/campaigns/${cid}/quests/main_sigil`);
            expect(body(response).status).toBe('ready_to_turn_in');

            response = await app.api.post(`${API}/campaigns/${cid}/interactions/elder_mira/turn_in_main`).send({});
            expect(response.status).toBe(200);
            expect(body(response).quest.status).toBe('turned_in');
            expect(body(response).quest.rewards.exp).toBe(120);

            response = await app.api.get(`${API}/campaigns/${cid}/story`);
            expect(body(response).state.ending).toBe('ending_ember');
            expect(body(response).ending.title).toBe('Ember Everlasting');

            response = await app.api.get(`${API}/campaigns/${cid}/dashboard`);
            const before = body(response);
            expect(before.player.level).toBeGreaterThan(1);
            expect(before.player.gold).toBeGreaterThan(0);

            response = await app.api.post(`${API}/campaigns/${cid}/saves`).send({ label: 'before move' });
            expect(response.status).toBe(201);
            const saveId = body(response).id;

            await move(app.api, cid, 'greenwood_edge');
            response = await app.api.post(`${API}/campaigns/${cid}/saves/${saveId}/restore`).send({});
            expect(response.status).toBe(200);
            expect(body(response).dashboard.location.key).toBe('mistfall_town');
            expect(body(response).dashboard.story.state.ending).toBe('ending_ember');

            response = await app.api.post(`${API}/campaigns/${cid}/bind-chat`).send({ chatKey: 'aria/chat-a', characterName: 'Aria' });
            expect(response.status).toBe(200);
            response = await app.api.get(`${API}/chat-bindings/${encodeURIComponent('aria/chat-a')}`);
            expect(response.status).toBe(200);
            expect(body(response).campaign.id).toBe(cid);

            response = await app.api.post(`${API}/campaigns/${cid}/bind-chat`).send({ chatKey: 'aria/chat-b', characterName: 'Aria' });
            expect(response.status).toBe(200);
            response = await app.api.get(`${API}/chat-bindings/${encodeURIComponent('aria/chat-b')}`);
            expect(body(response).campaign.id).toBe(cid);
            expect(body(response).campaign.gameState.story.ending).toBe('ending_ember');

            response = await app.api.get(`${API}/campaigns/${cid}/events?limit=100`);
            expect(body(response).length).toBeGreaterThan(8);
            expect(body(response).some((event) => event.type === 'combat.victory')).toBe(true);
            expect(body(response).some((event) => event.type === 'player.moved')).toBe(true);
            expect(body(response).some((event) => event.type === 'npc.interaction')).toBe(true);
            expect(body(response).some((event) => event.type === 'quest.turned_in')).toBe(true);
            expect(body(response).some((event) => event.type === 'story.ending')).toBe(true);

            response = await app.api.get(`${API}/campaigns/${cid}/inventory`);
            expect(body(response).equipment.find((entry) => entry.itemKey === 'iron_sword').slot).toBe('weapon');
            expect(body(response).items.find((entry) => entry.itemKey === 'iron_sword').equippedSlot).toBe('weapon');
        } finally {
            await app.close();
        }
    }, 30000);

    it('returns the same result for repeated movement idempotency keys', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Idempotent');
            const request = () => app.api.post(`${API}/campaigns/${campaign.id}/move`)
                .set('Idempotency-Key', `move-${campaign.id}-one`)
                .send({ location: 'greenwood_edge' });
            const first = await request();
            const second = await request();
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(body(second).location.key).toBe('greenwood_edge');
            const events = app.db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE campaign_id = ? AND type = 'combat.action'").get(campaign.id);
            expect(events.count).toBe(0);
        } finally {
            await app.close();
        }
    });

    it('deduplicates shop purchases with the same idempotency key', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Shop Idempotency');
            const before = body(await app.api.get(`${API}/campaigns/${campaign.id}/inventory`));
            const key = `shop-${campaign.id}-one`;
            const buy = () => app.api.post(`${API}/campaigns/${campaign.id}/shop/herbalist_lina/buy`)
                .set('Idempotency-Key', key)
                .send({ itemKey: 'herb', quantity: 1 });
            const first = await buy();
            const second = await buy();
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            const after = body(await app.api.get(`${API}/campaigns/${campaign.id}/inventory`));
            expect(after.gold).toBe(before.gold - first.body.data.total);
            const herb = after.items.find((item) => item.itemKey === 'herb');
            expect(herb.quantity).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('rejects a second active encounter and duplicate combat action settlement', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Combat Idempotency');
            await move(app.api, campaign.id, 'greenwood_edge');
            const proposed = await app.api.post(`${API}/campaigns/${campaign.id}/encounters/propose`).send({
                encounterKey: 'goblins', monsters: [{ monsterKey: 'forest_goblin', count: 2 }],
            });
            const combatId = body(proposed).id;
            const duplicateProposal = await app.api.post(`${API}/campaigns/${campaign.id}/encounters/propose`).send({
                encounterKey: 'goblins2', monsters: [{ monsterKey: 'forest_goblin', count: 1 }],
            });
            expect(duplicateProposal.status).toBe(409);

            const start = await app.api.post(`${API}/combat/${combatId}/start`).send({});
            const state = body(start);
            const target = state.participants.find((participant) => participant.side === 'enemy' && participant.alive);
            const key = `action-${campaign.id}-one`;
            const first = await app.api.post(`${API}/combat/${combatId}/action`).set('Idempotency-Key', key).send({ type: 'attack', targetId: target.id });
            const countAfterFirst = app.db.prepare('SELECT COUNT(*) AS count FROM combat_actions WHERE combat_session_id = ?').get(combatId).count;
            const second = await app.api.post(`${API}/combat/${combatId}/action`).set('Idempotency-Key', key).send({ type: 'attack', targetId: target.id });
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(body(second).lastAction.log[0].text).toBe(body(first).lastAction.log[0].text);
            const countAfterSecond = app.db.prepare('SELECT COUNT(*) AS count FROM combat_actions WHERE combat_session_id = ?').get(combatId).count;
            expect(countAfterSecond).toBe(countAfterFirst);
            expect(app.db.prepare('SELECT COUNT(*) AS count FROM api_idempotency WHERE key = ?').get(key).count).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('rolls joint dice, triggers a random encounter and refreshes the spawn after cooldown', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Joint Dice');
            await move(app.api, campaign.id, 'greenwood_edge');

            let state = await app.api.get(`${API}/campaigns/${campaign.id}/encounter-spawns`);
            expect(state.status).toBe(200);
            expect(body(state).some((entry) => entry.random && entry.ready)).toBe(true);

            const explored = await app.api.post(`${API}/campaigns/${campaign.id}/explore`).send({});
            expect(explored.status).toBe(200);
            const result = body(explored);
            expect(result.status).toBe('encounter');
            expect(result.roll.party.dice.length).toBe(2);
            expect(result.roll.danger.dice.length).toBe(2);
            expect(result.combat.status).toBe('pending');

            await fightUntilOver(app.api, campaign.id, result.combat.id);
            state = await app.api.get(`${API}/campaigns/${campaign.id}/encounter-spawns`);
            const random = body(state).find((entry) => entry.random);
            expect(random.status).toBe('defeated');
            expect(random.respawnAt).toBeTruthy();

            app.db.prepare("UPDATE encounter_spawns SET respawn_at = '2000-01-01T00:00:00.000Z' WHERE campaign_id = ? AND encounter_key = '__random__'").run(campaign.id);
            state = await app.api.get(`${API}/campaigns/${campaign.id}/encounter-spawns`);
            expect(body(state).find((entry) => entry.random).ready).toBe(true);
        } finally {
            await app.close();
        }
    }, 30000);

    it('runs a separate event asset on scene entry exactly once', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Event Separation');
            await move(app.api, campaign.id, 'greenwood_edge');
            await move(app.api, campaign.id, 'greenwood_deep');
            const firstEntry = await move(app.api, campaign.id, 'old_shrine');
            expect(firstEntry.worldEvents.map((entry) => entry.key)).toContain('shrine_discovery');
            const flag = app.db.prepare("SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = 'flag:shrine_found'").get(campaign.id);
            expect(flag?.value_json).toBe('true');
            const fired = app.db.prepare("SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = 'event:shrine_discovery:fired'").get(campaign.id);
            expect(fired?.value_json).toBe('true');

            await move(app.api, campaign.id, 'greenwood_deep');
            const secondEntry = await move(app.api, campaign.id, 'old_shrine');
            expect(secondEntry.worldEvents).toEqual([]);
            const log = app.db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE campaign_id = ? AND type = 'world.event'").get(campaign.id);
            expect(log.count).toBe(1);
        } finally {
            await app.close();
        }
    });
});
