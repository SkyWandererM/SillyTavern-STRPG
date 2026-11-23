import { describe, expect, it } from 'vitest';
import {
    AI_PRESETS, FIELD_GUIDES, buildGenerationPrompt, extractJsonObject, generatedContentWarnings,
    normalizeGeneratedAsset, summarizeGeneratedAsset,
} from '../frontend/src/aiPresets.js';

describe('workbench AI content interface', () => {
    it('builds a strict JSON prompt with kind, preset, world context and existing draft', () => {
        const prompt = buildGenerationPrompt({
            kind: 'npc',
            preset: AI_PRESETS.npc[0],
            prompt: 'A retired ferryman who knows the river.',
            context: {
                tone: 'grim',
                level: 4,
                locationKey: 'mistfall_town',
                worldName: 'Emberfall Frontier',
                sceneKeys: ['mistfall_town', 'greenwood_edge'],
                existing: { key: 'old_ferryman' },
            },
        });
        expect(prompt).toContain('exactly one NPC');
        expect(prompt).toContain('OUTPUT: JSON only');
        expect(prompt).toContain('grim, grounded, low fantasy');
        expect(prompt).toContain('mistfall_town');
        expect(prompt).toContain('Emberfall Frontier');
        expect(prompt).toContain('old_ferryman');
        expect(prompt).toContain('A retired ferryman');
        expect(prompt).toContain('REPLACE_WITH_LOCATION');
        expect(prompt).toContain('JSON object now');
    });

    it('extracts JSON from a fenced model reply and ignores surrounding prose', () => {
        const reply = 'Here is the entry:\n```json\n{"key":"mira","name":"Mira"}\n```\nHope this helps.';
        expect(extractJsonObject(reply)).toEqual({ key: 'mira', name: 'Mira' });
        expect(extractJsonObject('prefix {"key":"a","name":"A","nested":{"x":1}} suffix')).toEqual({
            key: 'a', name: 'A', nested: { x: 1 },
        });
        expect(() => extractJsonObject('no json here')).toThrow(/JSON object/);
    });

    it('normalizes generated NPC content onto template fields with context and unique keys', () => {
        const existing = [{ kind: 'npc', asset_key: 'mira' }, { kind: 'npc', asset_key: 'mira_2' }];
        const result = normalizeGeneratedAsset('npc', {
            key: 'mira',
            name: 'Mira the Ferryman',
            description: 'She knows every bend of the river.',
            interactions: [{ label: 'Talk', dialogue: 'The river remembers.' }],
        }, {
            context: { locationKey: 'mistfall_town' },
            assets: existing,
        });
        expect(result.kind).toBe('npc');
        expect(result.data.key).toBe('mira_3');
        expect(result.data.locationKey).toBe('mistfall_town');
        expect(result.data.kind).toBe('npc');
        expect(result.data.interactions[0].key).toBeTruthy();
        expect(result.data.interactions[0].dialogue).toEqual(['The river remembers.']);
        expect(result.name).toBe('Mira the Ferryman');
    });

    it('normalizes scenes, quests and events with sensible defaults and warnings', () => {
        const scene = normalizeGeneratedAsset('scene', {
            key: 'mossy_hollow', name: 'Mossy Hollow', siteType: 'wilderness',
        }, { context: { parentKey: 'greenwood_edge' } });
        expect(scene.data.layer).toBe('region');
        expect(scene.data.parentKey).toBe('greenwood_edge');
        expect(scene.data.map.x).toBe(240);
        expect(generatedContentWarnings('scene', scene.data).join(' ')).toContain('no connections');

        const quest = normalizeGeneratedAsset('quest', {
            key: 'ferry_debt', name: 'Ferry Debt', type: 'side',
        }, { context: { locationKey: 'mistfall_town' } });
        expect(quest.data.stages.length).toBeGreaterThan(0);
        expect(quest.data.rewards).toMatchObject({ exp: 20, gold: 10 });

        const event = normalizeGeneratedAsset('event', {
            key: 'hollow_warning', name: 'Hollow Warning', actions: [{ type: 'set_flag', flag: 'warned' }],
        }, { context: { locationKey: 'mossy_hollow' } });
        expect(event.data.scope).toBe('scene');
        expect(event.data.sceneKey).toBe('mossy_hollow');
        expect(event.data.actions).toHaveLength(1);
    });

    it('normalizes story arcs: choice becomes branch, endings are inferred, dangling edges warn', () => {
        const story = normalizeGeneratedAsset('story', {
            key: 'ashes_under_lamp',
            name: 'Ashes Under the Lamp',
            startNodeKey: 'lamp_unlit',
            nodes: [
                { key: 'lamp_unlit', title: 'The Cold Lamp', type: 'scene', sceneKey: 'mistfall_town' },
                { key: 'trust_or_trail', title: 'Trust or Trail', type: 'choice' },
                { key: 'mira_confession', title: 'What Mira Knew', type: 'scene' },
                { key: 'ash_trail', title: 'Ash at the Altar', type: 'scene' },
                { key: 'ending_ash', title: 'Ashes Under the Lamp', type: 'ending' },
            ],
            edges: [
                { from: 'lamp_unlit', to: 'trust_or_trail' },
                { from: 'trust_or_trail', to: 'mira_confession' },
                { from: 'trust_or_trail', to: 'ash_trail' },
                { from: 'mira_confession', to: 'ending_ash' },
                { from: 'ash_trail', to: 'ending_ash' },
                { from: 'missing_node', to: 'ending_ash' },
            ],
        });
        expect(story.data.nodes).toHaveLength(5);
        expect(story.data.nodes.find((node) => node.key === 'trust_or_trail').type).toBe('branch');
        expect(story.data.startNodeKey).toBe('lamp_unlit');
        expect(story.data.endings).toEqual(['ending_ash']);
        const warnings = generatedContentWarnings('story', story.data);
        expect(warnings.join(' ')).toContain('not declared in this story');
    });

    it('locks a reserved batch key and title during generation', () => {
        const reserved = normalizeGeneratedAsset('quest', {
            key: 'model_invented_key', name: 'Model Invented Name', type: 'side',
        }, {
            assets: [{ kind: 'quest', asset_key: 'reserved_key' }],
            lockedKey: 'reserved_key',
            lockedName: 'Reserved Title',
        });
        expect(reserved.data.key).toBe('reserved_key');
        expect(reserved.data.name).toBe('Reserved Title');
    });

    it('repairs common cross-reference mistakes before the preview', () => {
        const npc = normalizeGeneratedAsset('npc', {
            key: 'warden_mira', name: 'Warden Mira',
            interactions: [
                { key: 'talk', label: 'Talk', type: 'talk', dialogue: ['...'] },
                { key: 'accept', label: 'Accept', type: 'accept_quest' },
            ],
            questsOffered: ['missing_sigil'],
        }, { context: { locationKey: 'mistfall_town' } });
        expect(npc.data.interactions[1].questKey).toBe('missing_sigil');
        expect(npc.data.locationKey).toBe('mistfall_town');

        const quest = normalizeGeneratedAsset('quest', {
            key: 'missing_sigil', name: 'The Missing Sigil',
            completion: 'turn_in',
            start: { type: 'npc', npcKey: 'warden_mira' },
            stages: [{ key: 'stage_1', name: 'Ask', objectives: [{ key: 'obj_1', type: 'talk', targetKey: 'warden_mira' }] }],
        });
        expect(quest.data.turnIn).toEqual({ npcKey: 'warden_mira' });

        const armor = normalizeGeneratedAsset('equipment', {
            key: 'ash_mail', name: 'Ash Mail', kind: 'armor', slot: null,
        });
        expect(armor.data.slot).toBe('armor');

        const world = normalizeGeneratedAsset('world', {
            key: 'emberfall', name: 'Emberfall', startLocationKey: 'REPLACE_WITH_LOCATION',
        }, { context: { locationKey: 'mistfall_town' } });
        expect(world.data.startLocationKey).toBe('mistfall_town');

        const scene = normalizeGeneratedAsset('scene', {
            key: 'ash_hollow', name: 'Ash Hollow', siteType: 'town',
            randomEncounter: { enabled: true, monsters: [] },
        });
        const warnings = generatedContentWarnings('scene', scene.data).join(' ');
        expect(warnings).toContain('no monsters');
        expect(warnings).toContain('only allowed in wilderness or dungeon');
    });

    it('keeps the built-in prompt guides aligned with the content schema', () => {
        expect(AI_PRESETS.story[0].prompt).toContain('branch');
        expect(AI_PRESETS.story[0].prompt).toContain('never "choice"');
        expect(FIELD_GUIDES.quest).toContain('turnIn');
        expect(FIELD_GUIDES.quest).toContain('mode: all|any');
        expect(FIELD_GUIDES.npc).toContain('questKey');
        expect(FIELD_GUIDES.skill).toContain('applyStatus');
        expect(FIELD_GUIDES.equipment).not.toContain('resistances');
        expect(FIELD_GUIDES.scene).toContain('mode: road|trail|walk|door|stairs|gate|portal|secret');
        expect(AI_PRESETS.monster[2].prompt).toContain('no phase field');
        expect(AI_PRESETS.skill[1].prompt).toContain('no cleanse field');
    });

    it('summarizes generated content for the preview panel', () => {
        const rows = summarizeGeneratedAsset('monster', {
            key: 'bog_lurker', name: 'Bog Lurker', level: 3, stats: { maxHp: 80 }, exp: 30, gold: 12, drops: [{ itemKey: 'bog_scale' }],
        });
        const labels = rows.map((row) => row.label);
        expect(labels).toContain('Name');
        expect(labels).toContain('HP');
        expect(labels).toContain('Drops');
        expect(rows.find((row) => row.label === 'Drops').value).toBe('bog_scale');
    });
});
