import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';
// This package lives at <SillyTavern>/data/<user>/extensions/strpg, so SillyTavern's
// own server source is five levels up. Run the suite from inside a SillyTavern checkout.
import { read as readPngCard } from '../../../../../src/character-card-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = '/api/plugins/strpg';

describe('character cards and card-output game package', () => {
    it('generates six Character Card V2 JSON + PNG cards with embedded ST metadata', () => {
        const cardsDir = path.resolve(__dirname, '..', 'cards');
        const manifest = JSON.parse(fs.readFileSync(path.join(cardsDir, 'manifest.json'), 'utf8'));
        expect(manifest.cards).toHaveLength(6);
        for (const entry of manifest.cards) {
            const json = JSON.parse(fs.readFileSync(path.join(cardsDir, entry.json), 'utf8'));
            expect(json.spec).toBe('chara_card_v2');
            expect(json.spec_version).toBe('2.0');
            expect(json.data.name).toContain('STRPG Card');
            expect(json.data.system_prompt.length).toBeGreaterThan(1500);
            expect(json.data.mes_example).toContain('"kind"');
            const pngPath = path.join(cardsDir, entry.png);
            const fromPng = JSON.parse(readPngCard(fs.readFileSync(pngPath)));
            expect(fromPng.spec).toBe('chara_card_v2');
            expect(fromPng.data.name).toBe(json.data.name);
            expect(fromPng.data.system_prompt).toBe(json.data.system_prompt);
        }
    });

    it('imports six card outputs plus base assets, reviews, publishes, builds and plays the result', async () => {
        const app = makeTestApp();
        try {
            const project = body(await app.api.post(`${API}/projects`).send({ name: 'Card Output Game' }));
            const cardsDir = path.resolve(__dirname, '..', 'examples', 'card-outputs');
            const files = [
                '01-npc.json', '02-equipment.json', '03-skill.json', '04-scene.json', '05-story.json', '06-quest.json',
                path.join('base', 'world.json'), path.join('base', 'class.json'), path.join('base', 'rules.json'),
            ];
            const assetIds = [];
            for (const file of files) {
                const payload = JSON.parse(fs.readFileSync(path.join(cardsDir, file), 'utf8'));
                const created = await app.api.post(`${API}/projects/${project.id}/assets`).send({
                    kind: payload.kind, data: payload.asset, name: payload.asset.name,
                });
                expect(created.status).toBe(201);
                expect(body(created).validation.valid).toBe(true);
                assetIds.push(body(created).id);
            }
            for (const assetId of assetIds) {
                const validated = await app.api.post(`${API}/assets/${assetId}/validate`).send({});
                expect(body(validated).validation.valid).toBe(true);
                const reviewed = await app.api.post(`${API}/assets/${assetId}/review`).send({ reviewer: 'card-test', decision: 'approve' });
                expect(body(reviewed).status).toBe('REVIEWED');
                const published = await app.api.post(`${API}/assets/${assetId}/publish`).send({});
                expect(body(published).status).toBe('PUBLISHED');
            }
            const build = await app.api.post(`${API}/projects/${project.id}/build`).send({});
            expect(build.status).toBe(201);
            expect(body(build).report.valid).toBe(true);
            expect(body(build).report.stats.npcs).toBe(1);
            expect(body(build).report.stats.items).toBe(1);
            expect(body(build).report.stats.skills).toBe(1);
            expect(body(build).report.stats.endings).toBe(1);
            const publishedVersion = await app.api.post(`${API}/versions/${body(build).id}/publish`).send({});
            expect(body(publishedVersion).status).toBe('published');

            const campaign = await createCampaign(app.api, body(build).id, 'Card Output Campaign');
            const interaction = await app.api.get(`${API}/campaigns/${campaign.id}/interactions/archivist_sela`);
            expect(interaction.status).toBe(200);
            const accept = body(interaction).interactions.find((entry) => entry.key === 'accept_relic');
            expect(accept.available).toBe(true);
            const accepted = await app.api.post(`${API}/campaigns/${campaign.id}/interactions/archivist_sela/accept_relic`).send({});
            expect(accepted.status).toBe(200);
            const story = await app.api.get(`${API}/campaigns/${campaign.id}/story`);
            expect(body(story).state.ending).toBe('ending_moon');
        } finally {
            await app.close();
        }
    }, 30000);
});

