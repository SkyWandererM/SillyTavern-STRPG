export const ASSET_KINDS = [
    ['npc', 'NPC'], ['monster', 'Monster'], ['equipment', 'Item'], ['skill', 'Skill'],
    ['scene', 'Scene'], ['event', 'Event'], ['story', 'Story'], ['quest', 'Quest'], ['world', 'World'],
    ['class', 'Class'], ['rules', 'Rules'], ['status_effect', 'Effect'],
];

export const KIND_LABELS = Object.fromEntries(ASSET_KINDS);

export function assetTemplate(kind) {
    const stamp = Date.now().toString(36).slice(-5);
    const templates = {
        npc: {
            key: `npc_${stamp}`, name: 'New NPC', kind: 'npc', title: '', description: '', personality: '', motivation: '',
            locationKey: 'REPLACE_WITH_LOCATION', portrait: null,
            interactions: [{ key: 'talk', label: 'Talk', type: 'talk', description: '', condition: {}, dialogue: ['...'] }],
            shop: null, questsOffered: [], joinable: false, relations: { player: 0 },
        },
        monster: {
            key: `monster_${stamp}`, name: 'New Monster', description: '', level: 1,
            stats: { maxHp: 60, maxMp: 10, str: 8, agi: 6, int: 4, vit: 6, luck: 4, atk: 12, def: 4, res: 2, hit: 85, evade: 5, crit: 5 },
            skills: [], resistances: {}, exp: 20, gold: 10, drops: [], ai: 'aggressive', tags: [],
        },
        equipment: {
            key: `item_${stamp}`, name: 'New Item', kind: 'weapon', description: '', rarity: 'common', price: 50,
            stackable: false, maxStack: 1, slot: 'weapon', stats: { atk: 3 }, effects: {}, classRestrictions: [], tags: [],
        },
        skill: {
            key: `skill_${stamp}`, name: 'New Skill', category: 'active', type: 'attack', description: '',
            mpCost: 4, cooldown: 0, target: 'single', element: 'physical', power: 5,
            effects: {}, unlockLevel: 1, classes: [],
        },
        scene: {
            key: `location_${stamp}`, name: 'New Location', type: 'town', region: '', description: '',
            map: { x: 200, y: 200 }, discoveredByDefault: false, connections: [], eventKeys: [], interactions: [], tags: [],
        },
        event: {
            key: `event_${stamp}`, name: 'New Event', description: '', scope: 'scene', sceneKey: 'REPLACE_WITH_LOCATION', trigger: 'enter', targetKey: null, priority: 0, once: true,
            condition: {}, actions: [{ type: 'set_flag', key: 'REPLACE_WITH_FLAG' }], tags: [],
        },        story: {
            key: `story_${stamp}`, name: 'New Story', description: '', startNodeKey: 'start', endings: ['ending'],
            variables: {},
            nodes: [
                { key: 'start', title: 'Start', type: 'scene', text: '', map: { x: 100, y: 100 } },
                { key: 'ending', title: 'Ending', type: 'ending', text: '', map: { x: 420, y: 100 } },
            ],
            edges: [{ key: 'start_to_ending', from: 'start', to: 'ending', label: 'Finish', condition: {} }],
        },
        quest: {
            key: `quest_${stamp}`, name: 'New Quest', type: 'side', description: '', level: 1, prerequisites: [],
            start: { type: 'npc', npcKey: 'REPLACE_WITH_NPC' }, completion: 'auto',
            stages: [{ key: 'stage_1', name: 'Stage One', description: '', objectives: [{ key: 'obj_1', type: 'talk', targetKey: 'REPLACE_WITH_NPC', count: 1, label: '' }] }],
            rewards: { exp: 20, gold: 10, items: [], skills: [], flags: [] },
            nodes: [{ key: 'start', title: 'Start', type: 'start' }], edges: [],
        },
        world: {
            key: `world_${stamp}`, name: 'New World', description: '', startLocationKey: 'REPLACE_WITH_LOCATION', lore: '', tags: [],
        },
        class: {
            key: `class_${stamp}`, name: 'New Class', description: '',
            baseStats: { maxHp: 100, maxMp: 30, str: 12, agi: 10, int: 8, vit: 10, luck: 6 },
            growth: { maxHp: 15, maxMp: 5, str: 2, agi: 1.5, int: 1.2, vit: 1.6, luck: 1 },
            startingItems: [], startingSkills: [], skillTree: [],
        },
        rules: {
            key: `rules_${stamp}`, name: 'New Rules', levelCap: 30, startingGold: 50, statCaps: {},
            formulas: {}, expTable: [], enemyScaling: { hp: 1, atk: 1 }, saveEveryCombatAction: true,
        },
        status_effect: {
            key: `effect_${stamp}`, name: 'New Status Effect', kind: 'debuff', description: '', duration: 2,
            modifiers: {}, tick: { type: 'none', value: 0 }, skipTurn: false,
        },
    };
    return templates[kind] ?? { key: `asset_${stamp}`, name: 'New Content' };
}

function toImportItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.kind && entry.asset) return { kind: entry.kind, data: entry.asset, name: entry.asset.name };
    if (entry.kind && entry.data) return { kind: entry.kind, data: entry.data, name: entry.data.name };
    if (entry.kind && entry.key) return { kind: entry.kind, data: entry, name: entry.name };
    if (entry.asset?.kind) return { kind: entry.asset.kind, data: entry.asset, name: entry.asset.name };
    return null;
}

export function parseJsonDocuments(text) {
    let source = String(text ?? '').trim();
    if (!source) throw new Error('JSON input is empty');
    source = source.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '');
    const documents = [];
    let cursor = 0;
    while (cursor < source.length) {
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (cursor >= source.length) break;
        const opener = source[cursor];
        if (opener !== '{' && opener !== '[') {
            throw new Error(`Expected a JSON object or array at character ${cursor}, found '${opener}'`);
        }
        const start = cursor;
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (; cursor < source.length; cursor += 1) {
            const char = source[cursor];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') { inString = true; continue; }
            if (char === '{' || char === '[') depth += 1;
            else if (char === '}' || char === ']') {
                depth -= 1;
                if (depth === 0) { end = cursor + 1; break; }
                if (depth < 0) throw new Error(`Unexpected closing '${char}' at character ${cursor}`);
            }
        }
        if (end < 0) throw new Error(`Unterminated JSON document starting at character ${start}`);
        const raw = source.slice(start, end);
        try {
            documents.push(JSON.parse(raw));
        } catch (error) {
            throw new Error(`Invalid JSON document at character ${start}: ${error.message}`);
        }
        cursor = end;
    }
    if (!documents.length) throw new Error('JSON input contains no document');
    return documents;
}

export function normalizeImportJson(text) {
    const documents = parseJsonDocuments(text);
    const items = [];
    for (const document of documents) {
        if (Array.isArray(document)) {
            for (const entry of document) {
                const item = toImportItem(entry);
                if (item) items.push(item);
            }
            continue;
        }
        if (document?.schema === 'strpg.game-package' || document?.package?.schema === 'strpg.game-package') {
            if (documents.length > 1 || items.length) throw new Error('A Game Package cannot be mixed with other JSON documents');
            return { package: document.package ?? document };
        }
        if (document?.format === 'strpg.game-package-export' && document.package) {
            if (documents.length > 1 || items.length) throw new Error('A Game Package cannot be mixed with other JSON documents');
            return { package: document.package };
        }
        if (Array.isArray(document?.items) || Array.isArray(document?.assets)) {
            for (const entry of document.items ?? document.assets) {
                const item = toImportItem(entry);
                if (item) items.push(item);
            }
            continue;
        }
        const item = toImportItem(document);
        if (!item) throw new Error('Unrecognized JSON: expected {kind,asset}, a keyed asset with kind, an array of assets, or strpg.game-package');
        items.push(item);
    }
    if (!items.length) throw new Error('No recognisable content assets were found');
    return { items };
}
