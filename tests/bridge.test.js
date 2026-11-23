import { describe, expect, it, vi } from 'vitest';
import { body, createCampaign, makeTestApp } from './helpers.js';
import { pushMemoryBook } from '../plugin/src/memorybook.js';
import { buildEntries, mergeEntries, ownerIdOf, previewBook } from '../plugin/src/lorebook.js';
import { TRACKER_WHITELIST } from '../plugin/src/integrations.js';

const API = '/api/plugins/strpg';

function relationValue(app, campaignId, npcKey) {
    const row = app.db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?')
        .get(campaignId, `npc:${npcKey}:relation`);
    return row ? JSON.parse(row.value_json) : null;
}

describe('chat <-> RPG bridge (M1)', () => {
    it('builds stable STRPG-owned lorebook entries', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Book');
            const first = buildEntries(app.db, campaign.id);
            const second = buildEntries(app.db, campaign.id);
            expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());

            const ids = Object.values(first).map(ownerIdOf);
            expect(ids).toContain('world');
            expect(ids).toContain('player');
            expect(ids).toContain('current');
            expect(ids).toContain('rules');
            expect(ids).toContain('npc:elder_mira');
            expect(ids).toContain('npc:smith_borin');
            for (const entry of Object.values(first)) {
                expect(entry.comment.startsWith('[STRPG]')).toBe(true);
                expect(Array.isArray(entry.key)).toBe(true);
                expect(entry.content.length).toBeGreaterThan(0);
            }
        } finally {
            await app.close();
        }
    });

    it('merges incrementally: keeps foreign entries, prunes stale STRPG entries and keeps uids', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Merge');
            const generated = buildEntries(app.db, campaign.id);
            const generatedNpc = Object.values(generated).find((entry) => ownerIdOf(entry) === 'npc:elder_mira');
            expect(generatedNpc).toBeTruthy();

            const existing = {
                '7': { uid: 7, comment: 'Hand written lore', key: ['custom'], content: 'keep me', sticky: 0 },
                [String(generatedNpc.uid)]: { ...generatedNpc, content: 'old text', sticky: 4 },
                '999': { uid: 999, comment: '[STRPG] npc:deleted_npc — Deleted', key: ['gone'], content: 'stale' },
            };
            const merged = mergeEntries(existing, generated);
            expect(merged.entries['7'].content).toBe('keep me');
            const npc = Object.values(merged.entries).find((entry) => ownerIdOf(entry) === 'npc:elder_mira');
            expect(npc.content).not.toBe('old text');
            expect(npc.sticky).toBe(4);
            expect(merged.stats.removed).toBe(1);
            expect(merged.stats.kept).toBe(1);
            expect(Object.values(merged.entries).some((entry) => ownerIdOf(entry) === 'npc:deleted_npc')).toBe(false);
        } finally {
            await app.close();
        }
    });

    it('adopts legacy unmarked entries inside the STRPG book', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Legacy');
            const generated = buildEntries(app.db, campaign.id);
            const npc = Object.values(generated).find((entry) => ownerIdOf(entry) === 'npc:elder_mira');
            const legacyName = npc.comment.split('—').pop().trim();
            const existing = {
                '1': { uid: 1, comment: legacyName, key: ['Elder Mira'], content: 'legacy text' },
                '2': { uid: 2, comment: 'My own note', key: ['note'], content: 'keep' },
            };
            const without = mergeEntries(existing, generated, { adoptLegacy: false });
            expect(Object.values(without.entries).filter((entry) => entry.comment === legacyName)).toHaveLength(1);
            const merged = mergeEntries(existing, generated, { adoptLegacy: true });
            expect(merged.stats.adoptedLegacy).toBe(1);
            expect(merged.entries['2'].content).toBe('keep');
            const npcEntry = Object.values(merged.entries).find((entry) => ownerIdOf(entry) === 'npc:elder_mira');
            expect(npcEntry.content).not.toBe('legacy text');
        } finally {
            await app.close();
        }
    });
    it('push merges into the SillyTavern world book instead of replacing it', async () => {
        const app = makeTestApp();
        const calls = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url, options) => {
            const payload = JSON.parse(options.body);
            calls.push({ url: String(url), payload });
            if (String(url).endsWith('/api/worldinfo/get')) {
                return new Response(JSON.stringify({
                    entries: { '42': { uid: 42, comment: 'User entry', key: ['keep'], content: 'do not touch' } },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Push');
            const request = {
                headers: { cookie: 'session=test', 'x-csrf-token': 'token' },
                protocol: 'http',
                get: () => '127.0.0.1:8000',
            };
            const result = await pushMemoryBook(app.db, campaign.id, request);
            expect(result.name).toBe('STRPG - Bridge Push');
            expect(result.entries).toBeGreaterThan(5);
            expect(calls).toHaveLength(2);
            const written = calls[1].payload.data.entries;
            expect(written['42'].content).toBe('do not touch');
            expect(Object.values(written).some((entry) => ownerIdOf(entry) === 'npc:elder_mira')).toBe(true);
            expect(Object.values(written).filter((entry) => ownerIdOf(entry)).length).toBe(result.entries - 1);
        } finally {
            globalThis.fetch = originalFetch;
            await app.close();
        }
    });

    it('queues relation proposals, dedupes pending copies and applies them only after approval', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Relation');
            const proposal = {
                campaignId: campaign.id,
                npcKey: 'elder_mira',
                delta: 1,
                reason: 'The player recovered the ember sigil.',
                evidence: { messageIndex: 12, quote: 'You found it.' },
            };
            const first = await app.api.post(`${API}/tools/strpg_propose_relation`).send(proposal);
            expect(first.status).toBe(200);
            expect(body(first).result.candidate.status).toBe('PENDING');
            expect(body(first).result.candidate.kind).toBe('relation');

            const duplicate = await app.api.post(`${API}/tools/strpg_propose_relation`).send(proposal);
            expect(body(duplicate).result.duplicate).toBe(true);
            expect(body(duplicate).result.candidate.id).toBe(body(first).result.candidate.id);

            expect(relationValue(app, campaign.id, 'elder_mira')).toBeNull();

            const approve = await app.api.post(`${API}/campaigns/${campaign.id}/bridge/candidates/${body(first).result.candidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            expect(body(approve).applied).toMatchObject({ target: 'npc.relation', npcKey: 'elder_mira', after: 1 });
            expect(relationValue(app, campaign.id, 'elder_mira')).toBe(1);

            const events = app.db.prepare("SELECT * FROM game_events WHERE campaign_id = ? AND type = 'npc.relation'").all(campaign.id);
            expect(events).toHaveLength(1);

            const again = await app.api.post(`${API}/campaigns/${campaign.id}/bridge/candidates/${body(first).result.candidate.id}/approve`).send({});
            expect(again.status).toBe(409);
        } finally {
            await app.close();
        }
    });

    it('rejects unsafe relation proposals', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Guard');
            const tooBig = await app.api.post(`${API}/tools/strpg_propose_relation`).send({
                campaignId: campaign.id, npcKey: 'elder_mira', delta: 25, reason: 'instant friendship',
            });
            expect(tooBig.status).toBe(422);
            expect(tooBig.body.error.message).toContain('cannot change more than');

            const unknownNpc = await app.api.post(`${API}/tools/strpg_propose_relation`).send({
                campaignId: campaign.id, npcKey: 'nobody', delta: 1, reason: 'x',
            });
            expect(unknownNpc.status).toBe(404);

            const noReason = await app.api.post(`${API}/tools/strpg_propose_relation`).send({
                campaignId: campaign.id, npcKey: 'elder_mira', delta: 1,
            });
            expect(noReason.status).toBe(422);
        } finally {
            await app.close();
        }
    });

    it('pulls RPG Tracker narrative fields into the review queue', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Tracker');
            const pull = await app.api.post(`${API}/campaigns/${campaign.id}/bridge/tracker/pull`).send({
                characters: [
                    { name: 'Elder Mira', mood: 'warm', trust: 4, summary: 'She finally trusts the player.', hp: 9999 },
                    { name: 'A stranger', mood: 'cold' },
                ],
                world: { summary: 'The frontier is quiet again.' },
            });
            expect(pull.status).toBe(200);
            expect(body(pull).queued).toBe(2);
            expect(body(pull).skipped.some((entry) => entry.name === 'A stranger')).toBe(true);

            const listed = await app.api.get(`${API}/campaigns/${campaign.id}/bridge/candidates?status=PENDING`);
            const npcCandidate = body(listed).candidates.find((entry) => entry.payload.npcKey === 'elder_mira');
            expect(npcCandidate).toBeTruthy();
            expect(npcCandidate.payload.fields.hp).toBeUndefined();
            expect(npcCandidate.payload.fields.mood).toBe('warm');

            const approve = await app.api.post(`${API}/campaigns/${campaign.id}/bridge/candidates/${npcCandidate.id}/approve`).send({});
            expect(approve.status).toBe(200);
            const narrative = app.db.prepare('SELECT state_json FROM narrative_state WHERE campaign_id = ?').get(campaign.id);
            const state = JSON.parse(narrative.state_json);
            expect(state.byNpc.elder_mira.mood).toBe('warm');
            expect(state.byNpc.elder_mira.hp).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('exposes a read-only mirror and rejects unknown candidates', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Mirror');
            const mirror = await app.api.get(`${API}/campaigns/${campaign.id}/bridge/mirror`);
            expect(mirror.status).toBe(200);
            expect(body(mirror).provider).toBe('rpg-tracker');
            expect(body(mirror).mode).toBe('read-only-mirror');
            expect(body(mirror).characters[0].name).toBe('Aria');
            expect(body(mirror).whitelist).toEqual(TRACKER_WHITELIST);
            expect(body(mirror).world.locationKey).toBe('mistfall_town');

            const reject = await app.api.post(`${API}/campaigns/${campaign.id}/bridge/candidates/cand_missing/reject`).send({});
            expect(reject.status).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('previews the generated book without touching SillyTavern', async () => {
        const app = makeTestApp();
        try {
            const campaign = await createCampaign(app.api, app.seeded.version.id, 'Bridge Preview');
            const preview = previewBook(app.db, campaign.id);
            expect(preview.name).toBe('STRPG - Bridge Preview');
            expect(preview.stats.generated).toBeGreaterThan(5);
            const entries = Object.values(preview.entries);
            expect(entries.some((entry) => ownerIdOf(entry) === 'npc:elder_mira')).toBe(true);
        } finally {
            await app.close();
        }
    });
});
