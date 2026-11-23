import { describe, expect, it } from 'vitest';
import {
    DIRECTOR_ROLE_MAP, DIRECTOR_ROLES, buildBatchPlanPrompt, buildRolePrompt, createMemoryEntry,
    findSpoilerTerms, normalizeDirectorState, parseBatchPlan, parseRoleOutput, redactSpoilerTerms,
    referenceKeysForKind, roleAssetKind,
} from '../frontend/src/directorRoles.js';

describe('director room roles', () => {
    it('normalizes a director state without losing roles, memory or spoiler terms', () => {
        const state = normalizeDirectorState({
            memory: [
                { text: 'The player found the sigil ash.', visibility: 'player', source: 'narrator', type: 'event' },
                { text: 'Mira hid the truth.', visibility: 'secret', source: 'narrator', type: 'secret' },
            ],
            blackboard: { facts: [{ text: 'The lamp is cold.', visibility: 'player' }], handoffs: [{ from: 'narrator', to: 'quest-designer', text: 'Build the missing sigil quest.' }] },
            spoilers: { terms: ['Sixth Warden'] },
            roles: { narrator: { prompt: 'Custom narrator guidance.' } },
        });
        expect(state.memory).toHaveLength(2);
        expect(state.memory[1].visibility).toBe('secret');
        expect(state.blackboard.handoffs[0].to).toBe('quest-designer');
        expect(state.spoilers.terms).toEqual(['Sixth Warden']);
        expect(state.roles.narrator.prompt).toBe('Custom narrator guidance.');
        expect(state.roles['quest-designer'].assetKind).toBe('quest');
        expect(roleAssetKind(DIRECTOR_ROLE_MAP['skill-wright'], state)).toBe('skill');
    });

    it('filters secret memory in player-safe mode and includes it in director mode', () => {
        const state = normalizeDirectorState({
            memory: [
                { text: 'The player knows the road is closed.', visibility: 'player' },
                { text: 'The Sixth Warden is the missing heir.', visibility: 'secret' },
            ],
            blackboard: { facts: [{ text: 'Mistfall has no lamp oil.', visibility: 'player' }, { text: 'The mayor is the Warden.', visibility: 'secret' }] },
        });
        const role = DIRECTOR_ROLE_MAP['quest-designer'];
        const safe = buildRolePrompt({ role, state, question: 'What next?', includeSecrets: false, knownKeys: ['mistfall_town'] });
        expect(safe).toContain('The player knows the road is closed.');
        expect(safe).not.toContain('Sixth Warden');
        expect(safe).not.toContain('mayor is the Warden');
        expect(safe).toContain('PLAYER-SAFE');
        expect(safe).toContain('mistfall_town');

        const full = buildRolePrompt({ role, state, question: 'What next?', includeSecrets: true });
        expect(full).toContain('The Sixth Warden is the missing heir.');
        expect(full).toContain('The mayor is the Warden.');
    });

    it('parses the three-section authoring reply and handles unstructured replies', () => {
        const parsed = parseRoleOutput(`### PLAYER-SAFE BRIEF
A merchant is asking about the cold lamp.
### DIRECTOR NOTES
The merchant is the Warden's cousin.
### HANDOFF
Casting Director: make the merchant evasive.`);
        expect(parsed.structured).toBe(true);
        expect(parsed.brief).toContain('cold lamp');
        expect(parsed.notes).toContain('cousin');
        expect(parsed.handoff).toContain('Casting Director');

        const plain = parseRoleOutput('A plain reply without headings.');
        expect(plain.structured).toBe(false);
        expect(plain.brief).toBe('A plain reply without headings.');
        expect(plain.notes).toBe('');
    });

    it('finds and redacts protected spoiler terms', () => {
        const terms = ['Sixth Warden', 'the missing heir'];
        expect(findSpoilerTerms('The Sixth Warden returns, and the missing heir is named.', terms)).toEqual(['Sixth Warden', 'the missing heir']);
        expect(findSpoilerTerms('Nothing hidden here.', terms)).toEqual([]);
        expect(redactSpoilerTerms('The Sixth Warden watches.', terms)).toBe('The [hidden] watches.');
    });

    it('suggests only relevant existing project keys for a role kind', () => {
        const assets = [
            { kind: 'scene', asset_key: 'mistfall_town' },
            { kind: 'npc', asset_key: 'elder_mira' },
            { kind: 'monster', asset_key: 'forest_goblin' },
            { kind: 'equipment', asset_key: 'moonstone_charm' },
            { kind: 'skill', asset_key: 'ember_bolt' },
            { kind: 'class', asset_key: 'warden' },
        ];
        expect(referenceKeysForKind('quest', assets)).toEqual(expect.arrayContaining(['mistfall_town', 'elder_mira', 'forest_goblin', 'moonstone_charm']));
        expect(referenceKeysForKind('npc', assets)).toEqual(expect.arrayContaining(['mistfall_town', 'ember_bolt']));
        expect(referenceKeysForKind('equipment', assets)).toEqual(['warden']);
        expect(referenceKeysForKind('rules', assets)).toEqual([]);
    });

    it('plans a batch as key | title | brief lines and keeps it in director state', () => {
        const state = normalizeDirectorState({ memory: [{ text: 'The sigil is missing.', visibility: 'player' }] });
        const prompt = buildBatchPlanPrompt({
            role: DIRECTOR_ROLE_MAP['quest-designer'],
            state,
            kind: 'quest',
            count: 3,
            theme: 'missing sigil',
            knownKeys: ['mistfall_town'],
        });
        expect(prompt).toContain('Plan exactly 3 distinct quest entries');
        expect(prompt).toContain('key | Title | one-sentence brief');
        expect(prompt).toContain('mistfall_town');
        expect(prompt).toContain('missing sigil');

        const plan = parseBatchPlan('```text\nkey | Title | brief\nsigil_search | Search the Shrine | Find the missing sigil.\nwarden_talk | Warden Talk | Ask Mira what she hides.\nsigil_search | Duplicate Key | This key is repeated.\n```', 'quest', 12);
        expect(plan).toHaveLength(3);
        expect(plan[0].key).toBe('sigil_search');
        expect(plan[1].title).toBe('Warden Talk');
        expect(plan[2].key).toBe('sigil_search_2');

        const withBatch = normalizeDirectorState({
            batches: [{
                id: 'batch_1', name: 'Quest batch', kind: 'quest', roleId: 'quest-designer', autoAdvance: true,
                items: [
                    { id: 'i1', key: 'sigil_search', title: 'Search the Shrine', brief: 'Find it.', status: 'reserved', assetId: 'ast_1' },
                    { id: 'i2', key: 'warden_talk', title: 'Warden Talk', brief: 'Ask Mira.', status: 'planned' },
                ],
            }],
        });
        expect(withBatch.batches[0].autoAdvance).toBe(true);
        expect(withBatch.batches[0].items[0].status).toBe('reserved');
        expect(withBatch.batches[0].items[1].status).toBe('planned');
    });

    it('keeps all director roles with a next role and a valid asset kind', () => {
        expect(DIRECTOR_ROLES.length).toBeGreaterThanOrEqual(8);
        for (const role of DIRECTOR_ROLES) {
            expect(DIRECTOR_ROLE_MAP[role.nextRole]).toBeTruthy();
            for (const kind of role.allowedKinds) expect(typeof kind).toBe('string');
        }
        expect(createMemoryEntry({ text: 'x' }).visibility).toBe('director');
    });
});
