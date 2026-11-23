import { asJson, nowIso, uuid, withTransaction } from './util.js';
import { createAsset, createProject, buildGameVersion, publishGameVersion, getProject } from './studio.js';

export const EXAMPLE_PROJECT_ID = 'prj_example_emberfall';

const world = {
    key: 'emberfall',
    name: 'Emberfall Frontier',
    description: 'Mistfall, a frontier town surrounded by the Mistwood. The lost Ember Sigil is stirring in an ancient shrine deep in the forest.',
    startLocationKey: 'mistfall_town',
    lore: 'The Ember Sigil is an ancient pact that protects the frontier. Since the flame went out, monsters have begun to crawl out of the mist.',
    tags: ['jrpg', 'demo', 'frontier'],
};

const locations = [
    {
        key: 'mistfall_town', name: 'Mistfall Town', type: 'town', layer: 'settlement', region: 'Frontier',
        description: 'A small town of stone walls and timber roofs. An extinguished Ember Lamp stands in the central square.',
        map: { x: 120, y: 260 }, discoveredByDefault: true,
        tags: ['safe', 'shop'],
        connections: [
            { toKey: 'greenwood_edge', travelCost: 0, bidirectional: true, mode: 'road', label: 'Westwood road' },
        ],
        eventKeys: [],
    },
    {
        key: 'greenwood_edge', name: 'Greenwood Edge', type: 'forest', layer: 'region', region: 'Mistwood',
        description: 'Tall firs swallow the sky. Fresh goblin tracks cross the mud between the roots.',
        map: { x: 360, y: 250 }, discoveredByDefault: false,
        tags: ['wilderness', 'encounter'],
        connections: [
            { toKey: 'mistfall_town', travelCost: 0, bidirectional: true, mode: 'road', label: 'Road back to town' },
            { toKey: 'greenwood_deep', travelCost: 0, bidirectional: true, mode: 'trail', label: 'Deeper into the woods' },
        ],
        encounters: [
            {
                key: 'goblin_patrol', name: 'Goblin Patrol',
                monsters: [{ monsterKey: 'forest_goblin', count: 2 }],
                respawnSeconds: 60,
                description: 'Two goblins block the narrow forest road.',
            },
        ],
        randomEncounter: {
            enabled: true, name: 'Goblin Ambush', chance: 1, difficulty: 30,
            dice: { count: 2, sides: 6 }, cooldownSeconds: 60,
            monsters: [{ monsterKey: 'forest_goblin', count: 1 }],
            description: 'Goblins rush from the undergrowth.',
        },
        eventKeys: [],
    },
    {
        key: 'greenwood_deep', name: 'Greenwood Deep', type: 'forest', layer: 'region', region: 'Mistwood',
        description: 'The mist thickens and wolf howls draw closer. A stone stairway lies hidden beneath vines to the east.',
        map: { x: 590, y: 280 }, discoveredByDefault: false,
        tags: ['wilderness', 'encounter'],
        connections: [
            { toKey: 'greenwood_edge', travelCost: 0, bidirectional: true, mode: 'trail', label: 'Back to the forest edge' },
            { toKey: 'old_shrine', travelCost: 0, bidirectional: true, mode: 'trail', label: 'Vine-covered stairs' },
        ],
        encounters: [
            {
                key: 'dire_wolf_pack', name: 'Mistwolf Pack',
                monsters: [{ monsterKey: 'dire_wolf', count: 1 }, { monsterKey: 'forest_goblin', count: 1 }],
                description: 'A mistwolf and its goblin follower emerge from the fog.',
            },
        ],
        eventKeys: [],
    },
    {
        key: 'old_shrine', name: 'Old Ember Shrine', type: 'dungeon', layer: 'dungeon', region: 'Mistwood',
        description: 'At the center of a half-collapsed stone shrine, a dark red sigil flickers on a stone altar.',
        map: { x: 800, y: 190 }, discoveredByDefault: false,
        tags: ['dungeon', 'story'],
        connections: [
            { toKey: 'greenwood_deep', travelCost: 0, bidirectional: true, mode: 'trail', label: 'Back to the woods' },
        ],
        eventKeys: ['shrine_discovery', 'defeat_at_shrine'],
    },
];

const events = [
    {
        key: 'shrine_discovery', name: 'The Shrine Wakes', description: 'The Ember Sigil answers the player arrival with a pulse of old heat.',
        scope: 'scene', sceneKey: 'old_shrine', trigger: 'enter', once: true,
        condition: {}, actions: [
            { type: 'set_flag', key: 'shrine_found' },
            { type: 'notice', text: 'The dark red sigil on the altar pulses once, as if recognizing you.' },
        ], tags: ['story', 'discovery'],
    },
    {
        key: 'defeat_at_shrine', name: 'The Shrine Takes Its Due', description: 'Losing at the shrine has a price and a witness.',
        scope: 'scene', sceneKey: 'old_shrine', trigger: 'combat_defeat', once: true,
        condition: {}, actions: [
            { type: 'adjust_relation', npcKey: 'elder_mira', delta: -1 },
            { type: 'add_memory', npcKey: 'elder_mira', text: 'The player was carried back from the Old Ember Shrine after losing to its guardian.' },
            { type: 'notice', text: 'Elder Mira hears how you fell at the shrine. Her jaw tightens.' },
            { type: 'dialogue', npcKey: 'elder_mira', npcName: 'Elder Mira', text: 'Elder Mira is waiting at the shrine steps when you limp back. "You went in without the sigil light," she says quietly. "Tell me what it showed you."' },
        ], tags: ['defeat', 'consequence'],
    },
];

const npcs = [
    {
        key: 'elder_mira', name: 'Elder Mira', title: 'Ember Warden', locationKey: 'mistfall_town',
        description: 'A silver-haired elder wrapped in a deep red mantle embroidered with the Ember crest.',
        personality: 'Composed and restrained. Her voice grows heavy whenever the old pact is mentioned.',
        motivation: 'Find out why the Ember Sigil went dark and protect the townsfolk.',
        interactions: [
            {
                key: 'talk', label: 'Talk to the elder', type: 'talk',
                dialogue: ['What news did you bring back from the forest?', 'The Ember Sigil is not decoration. It is our pact with this land.'],
            },
            {
                key: 'accept_main', label: 'Accept quest: The Ember Sigil', type: 'accept_quest', questKey: 'main_sigil',
                condition: { questKey: 'main_sigil', questStatus: 'available' },
            },
            {
                key: 'turn_in_main', label: 'Report: The Ember Sigil', type: 'turn_in_quest', questKey: 'main_sigil',
                condition: { questKey: 'main_sigil', questStatus: 'ready_to_turn_in' },
            },
        ],
        questsOffered: ['main_sigil'],
        recruit: {
            enabled: true,
            cost: { gold: 60, items: [] },
            relationRequired: 0,
        },
        teaching: [
            { skillKey: 'fireball', tuition: { signal: 'mira_favor_paid' }, relationRequired: 0 },
        ],
    },
    {
        key: 'herbalist_lina', name: 'Lina the Herbalist', title: 'Herbalist', locationKey: 'mistfall_town',
        description: 'A young herbalist with grass stains on her apron and glass vials rattling at her belt.',
        personality: 'Cheerful and practical, with an almost stubborn fascination for rare herbs.',
        motivation: 'Keep the town apothecary stocked and study the forest flora.',
        interactions: [
            { key: 'talk', label: 'Chat', type: 'talk', dialogue: ['Calming herbs have become hard to find near the forest edge.', 'Goblins pull them up by the roots. It is maddening.'] },
            {
                key: 'accept_herbs', label: 'Accept quest: Three Calming Herbs', type: 'accept_quest', questKey: 'herb_gathering',
                condition: { questKey: 'herb_gathering', questStatus: 'available' },
            },
            {
                key: 'turn_in_herbs', label: 'Deliver calming herbs', type: 'turn_in_quest', questKey: 'herb_gathering',
                condition: { questKey: 'herb_gathering', questStatus: 'ready_to_turn_in' },
            },
            { key: 'shop', label: 'Buy medicine', type: 'shop' },
        ],
        shop: {
            buyRate: 1, sellRate: 0.5,
            items: [
                { itemKey: 'healing_herb' }, { itemKey: 'herb' }, { itemKey: 'oak_staff' },
            ],
        },
        questsOffered: ['herb_gathering'],
        recruit: {
            enabled: true,
            cost: { gold: 30, items: [{ itemKey: 'herb', quantity: 2 }] },
            relationRequired: 0,
        },
        recovery: {
            enabled: true,
            hpThreshold: 0.4,
            methods: [
                { key: 'tend', label: 'Help her sort the herb crates', restoreHp: 0.5, restoreMp: 0.5, relationDelta: 1 },
            ],
        },
    },
    {
        key: 'smith_borin', name: 'Borin the Smith', title: 'Forge Master', locationKey: 'mistfall_town',
        description: 'A broad-shouldered smith with an old wolf bite scar across his right forearm.',
        personality: 'Blunt and competitive. He is fiercely proud of every blade he forges.',
        motivation: 'Clear the wolves from the mining road so his apprentice can travel safely.',
        interactions: [
            { key: 'talk', label: 'Talk about equipment', type: 'talk', dialogue: ['Good steel is folded in fire again and again.', 'Those wolves in the woods will have to be dealt with eventually.'] },
            {
                key: 'accept_wolves', label: 'Accept quest: The Wolf Menace', type: 'accept_quest', questKey: 'wolf_hunt',
                condition: { questKey: 'wolf_hunt', questStatus: 'available' },
            },
            {
                key: 'turn_in_wolves', label: 'Deliver wolf fangs', type: 'turn_in_quest', questKey: 'wolf_hunt',
                condition: { questKey: 'wolf_hunt', questStatus: 'ready_to_turn_in' },
            },
            { key: 'shop', label: 'Browse the forge', type: 'shop' },
            {
                key: 'join', label: 'Ask Borin to join you', type: 'join_party',
                condition: { questKey: 'wolf_hunt', questStatus: 'turned_in' },
            },
        ],
        shop: {
            buyRate: 1, sellRate: 0.5,
            items: [
                { itemKey: 'iron_sword' }, { itemKey: 'leather_armor' }, { itemKey: 'moonstone_charm' }, { itemKey: 'scout_boots' },
            ],
            haggle: { enabled: true, maxDiscount: 0.3 },
        },
        teaching: [
            { skillKey: 'quick_slash', tuition: { gold: 40, items: [] }, relationRequired: 0 },
        ],
        questsOffered: ['wolf_hunt'],
        joinable: true,
        combat: {
            stats: { maxHp: 120, maxMp: 20, str: 16, agi: 8, int: 6, vit: 14, luck: 6, atk: 28, def: 12 },
            skills: ['power_strike'],
        },
    },
];

const monsters = [
    {
        key: 'forest_goblin', name: 'Forest Goblin', level: 2,
        description: 'A woodland goblin in ragged cloth, clutching a rusted short blade.',
        stats: { maxHp: 50, maxMp: 5, str: 9, agi: 8, int: 4, vit: 6, luck: 4, atk: 9, def: 4, res: 2, hit: 85, evade: 6, crit: 5 },
        skills: ['power_strike'], resistances: { fire: -0.2 },
        exp: 35, gold: 18,
        drops: [
            { itemKey: 'herb', chance: 0.9, min: 1, max: 2 },
            { itemKey: 'healing_herb', chance: 0.25, min: 1, max: 1 },
        ],
        ai: 'aggressive', tags: ['goblin', 'forest'],
    },
    {
        key: 'dire_wolf', name: 'Mistwolf', level: 3,
        description: 'A huge grey wolf whose eyes glow faint green in the fog.',
        stats: { maxHp: 90, maxMp: 0, str: 13, agi: 12, int: 4, vit: 8, luck: 5, atk: 14, def: 6, res: 3, hit: 90, evade: 12, crit: 8 },
        skills: ['quick_slash'], resistances: { ice: 0.25 },
        exp: 55, gold: 26,
        drops: [
            { itemKey: 'wolf_fang', chance: 1, min: 1, max: 2 },
            { itemKey: 'herb', chance: 0.3, min: 1, max: 1 },
        ],
        ai: 'aggressive', tags: ['beast', 'forest'],
    },
];

const items = [
    {
        key: 'iron_sword', name: 'Iron Sword', kind: 'weapon', rarity: 'common', price: 120,
        description: 'A dependable sword forged by Borin. Plain, sharp, and well balanced.', stackable: false, slot: 'weapon',
        stats: { atk: 8, hit: 5 }, classRestrictions: ['adventurer'],
    },
    {
        key: 'leather_armor', name: 'Hardened Leather Armor', kind: 'armor', rarity: 'uncommon', price: 110,
        description: 'Cured hide armor tough enough to turn most claws.', stackable: false, slot: 'armor',
        stats: { def: 6, maxHp: 18 }, classRestrictions: ['adventurer'],
    },
    {
        key: 'oak_staff', name: 'Oak Staff', kind: 'weapon', rarity: 'uncommon', price: 140,
        description: 'An oak staff carved with fine runes that channel a faint elemental current.', stackable: false, slot: 'weapon',
        stats: { atk: 2, mag: 7, maxMp: 8 }, classRestrictions: ['adventurer'],
    },
    {
        key: 'moonstone_charm', name: 'Moonstone Charm', kind: 'accessory', rarity: 'rare', price: 180,
        description: 'A charm of moon-pale stone that grows warm near ember magic.', stackable: false, slot: 'accessory',
        stats: { luck: 4, maxMp: 12, res: 3 }, classRestrictions: ['adventurer'],
    },
    {
        key: 'scout_boots', name: 'Scout Boots', kind: 'accessory', rarity: 'uncommon', price: 90,
        description: 'Light boots with deerskin soles stitched for silent movement.', stackable: false, slot: 'accessory',
        stats: { agi: 2, evade: 3 }, classRestrictions: ['adventurer'],
    },
    {
        key: 'healing_herb', name: 'Healing Herb', kind: 'consumable', rarity: 'common', price: 20,
        description: 'Chewed and pressed to a wound, it stops bleeding quickly.', stackable: true, maxStack: 99,
        consumable: { healHp: 35 },
    },
    {
        key: 'herb', name: 'Calming Herb', kind: 'material', rarity: 'common', price: 10,
        description: 'A pale blue herb with a cool scent. Lina needs it for her remedies.', stackable: true, maxStack: 99,
    },
    {
        key: 'wolf_fang', name: 'Mistwolf Fang', kind: 'material', rarity: 'uncommon', price: 14,
        description: 'A curved wolf fang. Borin says it would make an excellent dagger.', stackable: true, maxStack: 99,
    },
];

const skills = [
    {
        key: 'power_strike', name: 'Power Strike', category: 'active', type: 'attack', target: 'single',
        mpCost: 3, cooldown: 0, element: 'physical', power: 9, unlockLevel: 1, classes: ['adventurer'],
        description: 'A heavy strike delivered after a short wind-up.', formula: 'max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult))',
    },
    {
        key: 'heal', name: 'Heal', category: 'active', type: 'heal', target: 'ally',
        mpCost: 6, cooldown: 1, element: 'holy', power: 18, unlockLevel: 1, classes: ['adventurer'],
        description: 'A soft holy light that closes the wounds of one ally.',
    },
    {
        key: 'fireball', name: 'Fireball', category: 'active', type: 'attack', target: 'single',
        mpCost: 8, cooldown: 2, element: 'fire', power: 16, unlockLevel: 3, classes: ['adventurer'],
        description: 'Condense ember magic into a searing projectile with a chance to burn.',
        effects: { applyStatus: { effectKey: 'burn', chance: 0.45, duration: 2 } },
    },
    {
        key: 'quick_slash', name: 'Quick Slash', category: 'active', type: 'attack', target: 'single',
        mpCost: 4, cooldown: 2, element: 'physical', power: 6, unlockLevel: 2, classes: ['adventurer'],
        description: 'Strike before the enemy can react.',
    },
    {
        key: 'iron_will', name: 'Iron Will', category: 'passive', type: 'buff', target: 'self',
        mpCost: 0, cooldown: 0, element: 'none', power: 0, unlockLevel: 5, classes: ['adventurer'],
        description: 'Years of heavy training have hardened body and resolve.',
        passive: { modifiers: { def: 3, maxHp: 10 } },
    },
];

const effects = [
    {
        key: 'burn', name: 'Burn', kind: 'dot',
        description: 'Ember magic clings to the wound, dealing 5% maximum HP damage each turn.',
        duration: 2, modifiers: {}, tick: { type: 'damage_percent', value: 0.05 }, skipTurn: false,
    },
];

const classData = {
    key: 'adventurer', name: 'Frontier Adventurer',
    description: 'A young adventurer raised on the Emberfall frontier, balanced in attack and defense.',
    baseStats: { maxHp: 120, maxMp: 40, str: 14, agi: 10, int: 10, vit: 12, luck: 8 },
    growth: { maxHp: 18, maxMp: 6, str: 2.2, agi: 1.6, int: 1.5, vit: 2, luck: 1.1 },
    startingItems: [{ itemKey: 'iron_sword', quantity: 1 }, { itemKey: 'healing_herb', quantity: 2 }],
    startingSkills: ['power_strike', 'heal'],
    skillTree: [
        { level: 2, skillKey: 'quick_slash' },
        { level: 3, skillKey: 'fireball' },
        { level: 5, skillKey: 'iron_will' },
    ],
};

const rules = {
    key: 'emberfall_rules',
    name: 'Emberfall Rules',
    levelCap: 30,
    startingGold: 80,
    statCaps: { maxHp: 9999, maxMp: 999, str: 999, agi: 999, int: 999, vit: 999, luck: 999 },
    formulas: {},
    expTable: [],
    enemyScaling: { hp: 1, atk: 1 },
    saveEveryCombatAction: true,
};

const quests = [
    {
        key: 'main_sigil', name: 'The Ember Sigil', type: 'main',
        description: 'Elder Mira wants someone to investigate the extinguished Ember Sigil in the Mistwood.',
        level: 1,
        prerequisites: [],
        start: { type: 'npc', npcKey: 'elder_mira' },
        turnIn: { npcKey: 'elder_mira' },
        completion: 'turn_in',
        stages: [
            {
                key: 'investigate', name: 'Investigate the Forest Edge',
                description: 'Travel to Greenwood Edge and clear the goblins from the road.',
                mode: 'all',
                objectives: [
                    { key: 'reach_edge', type: 'visit', targetKey: 'greenwood_edge', count: 1, label: 'Reach Greenwood Edge' },
                    { key: 'kill_goblins', type: 'kill', targetKey: 'forest_goblin', count: 2, label: 'Defeat forest goblins' },
                ],
            },
            {
                key: 'report', name: 'Report to the Elder',
                description: 'Return to Mistfall Town with what you found in the forest.',
                objectives: [
                    { key: 'talk_elder', type: 'talk', targetKey: 'elder_mira', count: 1, label: 'Talk to Elder Mira' },
                ],
            },
        ],
        rewards: {
            exp: 120, gold: 100,
            items: [{ itemKey: 'moonstone_charm', quantity: 1 }],
            skills: [], flags: ['sigil_restored'],
        },
        nodes: [
            { key: 'start', title: 'Accept', type: 'start' },
            { key: 'investigate', title: 'Investigate', type: 'stage' },
            { key: 'report', title: 'Report', type: 'stage' },
            { key: 'done', title: 'Complete', type: 'end' },
        ],
        edges: [
            { key: 'e1', from: 'start', to: 'investigate' },
            { key: 'e2', from: 'investigate', to: 'report' },
            { key: 'e3', from: 'report', to: 'done' },
        ],
    },
    {
        key: 'herb_gathering', name: 'Three Calming Herbs', type: 'side',
        description: 'Lina needs three calming herbs. Goblins carry them, and her shop sells a few.',
        level: 1, prerequisites: [],
        start: { type: 'npc', npcKey: 'herbalist_lina' },
        turnIn: { npcKey: 'herbalist_lina' },
        completion: 'turn_in',
        stages: [{
            key: 'collect', name: 'Gather Calming Herbs',
            objectives: [{ key: 'herb_count', type: 'collect', targetKey: 'herb', count: 3, label: 'Collect calming herbs' }],
        }],
        rewards: { exp: 40, gold: 45, items: [{ itemKey: 'healing_herb', quantity: 3 }], skills: [], flags: [] },
    },
    {
        key: 'wolf_hunt', name: 'The Wolf Menace', type: 'side',
        description: 'Borin wants the mistwolves cleared from the deep woods so his apprentice can travel safely.',
        level: 2, prerequisites: [],
        start: { type: 'npc', npcKey: 'smith_borin' },
        turnIn: { npcKey: 'smith_borin' },
        completion: 'turn_in',
        stages: [{
            key: 'hunt', name: 'Hunt the Mistwolves',
            objectives: [{ key: 'wolf_kills', type: 'kill', targetKey: 'dire_wolf', count: 2, label: 'Defeat mistwolves' }],
        }],
        rewards: { exp: 80, gold: 70, items: [{ itemKey: 'leather_armor', quantity: 1 }], skills: [], flags: ['wolves_cleared'] },
    },
];

const story = {
    key: 'ember_sigil_story',
    name: 'The Ember Road',
    description: 'Set out from the extinguished Ember Lamp, cross the Mistwood, and rekindle the sigil in the old shrine.',
    startNodeKey: 'prologue',
    endings: ['ending_ember'],
    variables: { sigil_restored: false },
    nodes: [
        {
            key: 'prologue', title: 'A Frontier Morning', type: 'scene', sceneKey: 'mistfall_town',
            text: 'Morning fog crawls over the rooftops of Mistfall. The Ember Lamp in the square is cold as stone.',
            map: { x: 80, y: 100 },
        },
        {
            key: 'town_arrival', title: 'Beneath the Ember Lamp', type: 'scene', sceneKey: 'mistfall_town',
            text: 'Elder Mira stands beneath the dead Ember Lamp, her gaze fixed on the Mistwood beyond your shoulder.',
            map: { x: 300, y: 100 },
        },
        {
            key: 'forest_discovery', title: 'Tracks in the Wood', type: 'scene', sceneKey: 'greenwood_edge',
            text: 'Goblin tracks lead deeper into the trees. Fine red ember dust is mixed into the mud.',
            actions: [{ type: 'set_flag', key: 'forest_seen' }],
            map: { x: 520, y: 100 },
        },
        {
            key: 'shrine_vision', title: 'Echoes in the Shrine', type: 'scene', sceneKey: 'old_shrine',
            text: 'The sigil on the altar flares. A memory not your own flashes through your mind: ancient wardens sealing fire into the earth.',
            map: { x: 740, y: 100 },
        },
        {
            key: 'sigil_restored', title: 'The Sigil Rekindled', type: 'branch', sceneKey: 'mistfall_town',
            text: 'The news you brought home sets the Ember Lamp burning again. Mira presses a hand to the pedestal, firelight catching the tears at her eyes.',
            map: { x: 740, y: 260 },
        },
        {
            key: 'ending_ember', title: 'Ember Everlasting', type: 'ending', sceneKey: 'mistfall_town',
            text: 'The frontier night has firelight again. More secrets wait deeper in the mist, but tonight the town can sleep.',
            map: { x: 960, y: 260 },
        },
    ],
    edges: [
        { key: 'p_to_town', from: 'prologue', to: 'town_arrival', label: 'Walk to the square' },
        {
            key: 'town_to_forest', from: 'town_arrival', to: 'forest_discovery', label: 'Head to the forest edge',
            condition: { locationKey: 'greenwood_edge' },
        },
        {
            key: 'town_to_restored', from: 'town_arrival', to: 'sigil_restored', label: 'Complete the main quest',
            condition: { questKey: 'main_sigil', questStatus: 'turned_in' },
        },
        {
            key: 'forest_to_shrine', from: 'forest_discovery', to: 'shrine_vision', label: 'Enter the old shrine',
            condition: { locationKey: 'old_shrine' },
        },
        {
            key: 'forest_to_town', from: 'forest_discovery', to: 'town_arrival', label: 'Return to town',
            condition: { locationKey: 'mistfall_town' },
        },
        {
            key: 'shrine_to_town', from: 'shrine_vision', to: 'town_arrival', label: 'Return to town',
            condition: { locationKey: 'mistfall_town' },
        },
        { key: 'restored_to_ending', from: 'sigil_restored', to: 'ending_ember', label: 'Ember Everlasting' },
    ],
};

function seedAssets() {
    return [
        ['world', world],
        ...locations.map((data) => ['scene', data]),
        ...events.map((data) => ['event', data]),
        ...npcs.map((data) => ['npc', data]),
        ...monsters.map((data) => ['monster', data]),
        ...items.map((data) => ['equipment', data]),
        ...skills.map((data) => ['skill', data]),
        ...effects.map((data) => ['status_effect', data]),
        ...quests.map((data) => ['quest', data]),
        ['story', story],
        ['class', classData],
        ['rules', rules],
    ];
}

export function examplePackageSummary() {
    return {
        world: world.name,
        locations: locations.length,
        npcs: npcs.length,
        monsters: monsters.length,
        events: events.length,
        items: items.length,
        skills: skills.length,
        quests: quests.map((quest) => ({ key: quest.key, name: quest.name, type: quest.type })),
        storyNodes: story.nodes.length,
        ending: story.endings[0],
    };
}

export function seedExampleProject(db, options = {}) {
    const existing = db.prepare('SELECT id FROM game_projects WHERE id = ?').get(EXAMPLE_PROJECT_ID);
    if (existing && !options.force) {
        const project = getProject(db, EXAMPLE_PROJECT_ID);
        const version = project.versions.find((entry) => entry.status === 'published') ?? null;
        return { created: false, projectId: EXAMPLE_PROJECT_ID, version, summary: examplePackageSummary() };
    }
    if (existing && options.force) {
        db.prepare('DELETE FROM game_projects WHERE id = ?').run(EXAMPLE_PROJECT_ID);
    }
    const project = createProject(db, {
        id: EXAMPLE_PROJECT_ID,
        name: 'Emberfall Frontier: Example JRPG',
        description: 'The official STRPG example game: one town, one forest, three NPCs, two monsters, three quests, and a reachable ending.',
        metadata: {
            author: 'STRPG',
            example: true,
            integrations: { memoryBooks: true, mapRegions: true, rpgTracker: true },
        },
    });
    const now = nowIso();
    for (const [kind, data] of seedAssets()) {
        const asset = createAsset(db, project.id, {
            kind,
            data,
            name: data.name ?? data.key,
            createdBy: 'seed',
            note: 'Official STRPG example content',
        });
        withTransaction(db, () => {
            db.prepare(`
                UPDATE content_assets SET status = 'PUBLISHED', validated_at = ?, reviewed_at = ?, reviewed_by = 'example-reviewer',
                    published_at = ? WHERE id = ?
            `).run(now, now, now, asset.id);
            db.prepare(`
                INSERT INTO content_reviews (id, asset_id, validation_json, reviewer, decision, note, created_at)
                VALUES (?, ?, ?, 'example-reviewer', 'approve', 'Seeded example content', ?)
            `).run(uuid('rev_'), asset.id, asJson({ seed: true, errors: [], warnings: [] }), now);
            db.prepare(`
                INSERT INTO content_versions (id, asset_id, project_id, revision, status, data_json, note, created_by, created_at)
                VALUES (?, ?, ?, 1, 'PUBLISHED', ?, 'Seeded example content', 'seed', ?)
            `).run(uuid('cver_'), asset.id, project.id, JSON.stringify(data), now);
        });
    }
    const built = buildGameVersion(db, project.id, { notes: 'STRPG official example v1' });
    const published = publishGameVersion(db, built.id);
    return {
        created: true,
        projectId: project.id,
        version: published,
        report: built.report,
        summary: examplePackageSummary(),
    };
}
