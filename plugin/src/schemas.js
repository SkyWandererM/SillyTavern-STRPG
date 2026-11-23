import { z } from 'zod';

export const ASSET_KINDS = ['world', 'scene', 'event', 'npc', 'monster', 'equipment', 'skill', 'quest', 'story', 'class', 'rules', 'status_effect'];

export const ASSET_KIND_LABELS = {
    world: 'World',
    scene: 'Scene / Location',
    event: 'Event',
    npc: 'NPC',
    monster: 'Monster',
    equipment: 'Equipment / Item',
    skill: 'Skill',
    quest: 'Quest',
    story: 'Story',
    class: 'Class',
    rules: 'Rules',
    status_effect: 'Status Effect',
};

const keySchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Key must use ASCII letters, digits, dot, colon, underscore or hyphen');
const nameSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().max(20000).default('');
const numberSchema = z.number().finite();

const statsSchema = z.record(z.union([z.number(), z.string()])).default({});

/**
 * Payment for an NPC service. Numeric parts are deducted; signal/flag/quest/manual are
 * non-cash receipts checked at approval, so a favour ("help me with the crates") can be
 * the tuition instead of gold or an item.
 */
const costSchema = z.object({
    gold: z.number().int().min(0).default(0),
    items: z.array(z.object({ itemKey: z.string(), quantity: z.number().int().min(1).max(10).default(1) })).default([]),
    signal: z.string().trim().min(1).max(80).optional(),
    flag: z.string().trim().min(1).max(80).optional(),
    questKey: z.string().trim().min(1).max(120).optional(),
    manual: z.boolean().default(false),
    autoApprove: z.boolean().default(true),
}).default({});

const conditionSchema = z.object({
    all: z.array(z.any()).optional(),
    any: z.array(z.any()).optional(),
    not: z.any().optional(),
    flag: z.string().optional(),
    questKey: z.string().optional(),
    questStatus: z.string().optional(),
    itemKey: z.string().optional(),
    itemCount: z.number().optional(),
    level: z.number().optional(),
    locationKey: z.string().optional(),
    variable: z.object({ key: z.string(), op: z.enum(['eq', 'neq', 'gte', 'lte', 'gt', 'lt']).default('eq'), value: z.any() }).optional(),
    storyNodeKey: z.string().optional(),
}).passthrough().default({});

const actionSchema = z.object({
    type: z.string(),
    key: z.string().optional(),
    value: z.any().optional(),
    amount: z.number().optional(),
    questKey: z.string().optional(),
    itemKey: z.string().optional(),
    skillKey: z.string().optional(),
    locationKey: z.string().optional(),
    flag: z.string().optional(),
    text: z.string().optional(),
}).passthrough();

export const sceneSchema = z.object({
    key: keySchema,
    name: nameSchema,
    type: z.string().default('town'),
    layer: z.enum(['world', 'region', 'settlement', 'interior', 'room', 'dungeon', 'floor']).default('region'),
    siteType: z.enum(['indoor', 'town', 'wilderness', 'dungeon']).optional(),
    isSpawn: z.boolean().default(false),
    region: z.string().default(''),
    description: descriptionSchema,
    map: z.object({ x: numberSchema.default(0), y: numberSchema.default(0) }).passthrough().default({ x: 0, y: 0 }),
    parentKey: z.string().nullable().optional(),
    spawnPoints: z.array(z.object({
        key: z.string(), x: numberSchema.default(0), y: numberSchema.default(0), label: z.string().default(''),
    }).passthrough()).default([]),
    image: z.string().nullable().optional(),
    discoveredByDefault: z.boolean().default(false),
    connections: z.array(z.object({
        toKey: z.string(),
        travelCost: z.number().int().min(0).default(0),
        bidirectional: z.boolean().default(true),
        mode: z.enum(['road', 'trail', 'walk', 'door', 'stairs', 'gate', 'portal', 'secret']).default('walk'),
        entryKey: z.string().nullable().optional(),
        condition: conditionSchema.optional(),
        label: z.string().optional(),
    }).passthrough()).default([]),
    interactions: z.array(actionSchema).default([]),
    events: z.array(actionSchema).default([]),
    eventKeys: z.array(z.string()).default([]),
    encounters: z.array(z.object({
        key: z.string(),
        name: z.string().optional(),
        description: z.string().default(''),
        respawnSeconds: z.number().int().min(0).max(86400 * 30).default(90),
        monsters: z.array(z.object({ monsterKey: z.string(), count: z.number().int().min(1).max(8).default(1) }).passthrough()).default([]),
    }).passthrough()).default([]),
    randomEncounter: z.object({
        enabled: z.boolean().default(false),
        name: z.string().default('Random Encounter'),
        chance: z.number().min(0).max(1).default(0.35),
        dice: z.object({ count: z.number().int().min(1).max(6).default(2), sides: z.number().int().min(2).max(100).default(6) }).default({ count: 2, sides: 6 }),
        difficulty: z.number().int().min(1).max(30).default(8),
        cooldownSeconds: z.number().int().min(0).max(86400).default(90),
        monsters: z.array(z.object({ monsterKey: z.string(), count: z.number().int().min(1).max(8).default(1) }).passthrough()).default([]),
        description: z.string().default(''),
    }).passthrough().optional(),
    tags: z.array(z.string()).default([]),
}).passthrough().superRefine((data, ctx) => {
    if (Array.isArray(data.nodes) || data.startNodeKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: 'Story nodes belong in a story asset. A scene describes one place only.' });
    }
    if (data.randomEncounter?.enabled && !(data.randomEncounter.monsters ?? []).length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['randomEncounter', 'monsters'], message: 'An enabled random encounter requires at least one monster.' });
    }
    for (const [index, encounter] of (data.encounters ?? []).entries()) {
        if (!(encounter.monsters ?? []).length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['encounters', index, 'monsters'], message: 'A fixed encounter requires at least one monster.' });
        }
    }
});

export const eventSchema = z.object({
    key: keySchema,
    name: nameSchema,
    description: descriptionSchema,
    scope: z.enum(['world', 'scene', 'story']).default('scene'),
    sceneKey: z.string().nullable().optional(),
    trigger: z.enum(['enter', 'interact', 'flag', 'quest', 'combat_victory', 'combat_defeat', 'manual']).default('enter'),
    targetKey: z.string().nullable().optional(),
    priority: z.number().int().default(0),
    once: z.boolean().default(true),
    condition: conditionSchema.default({}),
    actions: z.array(actionSchema).default([]),
    tags: z.array(z.string()).default([]),
}).passthrough().superRefine((data, ctx) => {
    if (data.scope === 'scene' && !data.sceneKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sceneKey'], message: 'A scene event requires sceneKey.' });
    }
});

export const npcSchema = z.object({
    key: keySchema,
    name: nameSchema,
    kind: z.literal('npc').default('npc'),
    title: z.string().default(''),
    description: descriptionSchema,
    personality: z.string().default(''),
    motivation: z.string().default(''),
    locationKey: z.string(),
    portrait: z.string().nullable().optional(),
    interactions: z.array(z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(['talk', 'shop', 'accept_quest', 'turn_in_quest', 'join_party', 'heal', 'story', 'custom']).default('talk'),
        description: z.string().default(''),
        condition: conditionSchema.optional(),
        actions: z.array(actionSchema).default([]),
        questKey: z.string().optional(),
        dialogue: z.array(z.string()).default([]),
    }).passthrough()).default([]),
    shop: z.object({
        buyRate: z.number().default(1),
        sellRate: z.number().default(0.5),
        items: z.array(z.object({
            itemKey: z.string(),
            price: z.number().int().min(0).optional(),
            stock: z.number().int().min(0).nullable().optional(),
        })).default([]),
        haggle: z.object({
            enabled: z.boolean().default(false),
            maxDiscount: z.number().min(0).max(0.5).default(0.3),
        }).optional(),
    }).nullable().optional(),
    questsOffered: z.array(z.string()).default([]),
    important: z.boolean().default(false),
    tavern: z.object({ avatar: z.string(), importedAt: z.string() }).passthrough().optional(),
    joinable: z.boolean().default(false),
    recruit: z.object({
        enabled: z.boolean().default(false),
        cost: costSchema,
        relationRequired: z.number().default(0),
        condition: conditionSchema.optional(),
        maxParty: z.number().int().min(1).max(4).optional(),
    }).optional(),
    barter: z.array(z.object({
        key: z.string(),
        label: z.string().default(''),
        itemKey: z.string(),
        questKey: z.string(),
        relationDelta: z.number().int().min(0).max(2).default(1),
    })).default([]),
    teaching: z.array(z.object({
        skillKey: z.string(),
        tuition: costSchema,
        relationRequired: z.number().default(0),
        condition: conditionSchema.optional(),
    })).default([]),
    recovery: z.object({
        enabled: z.boolean().default(false),
        hpThreshold: z.number().min(0).max(1).default(0.4),
        methods: z.array(z.object({
            key: z.string(),
            label: z.string().default(''),
            restoreHp: z.number().min(0).max(1).default(0.3),
            restoreMp: z.number().min(0).max(1).default(0.2),
            relationDelta: z.number().int().min(0).max(2).default(1),
            cost: costSchema.optional(),
        })).min(1),
    }).optional(),
    joinCondition: conditionSchema.optional(),
    combat: z.object({
        stats: statsSchema,
        skills: z.array(z.string()).default([]),
        growth: statsSchema.default({}),
    }).optional(),
    relations: z.record(z.number()).default({}),
}).passthrough();

export const monsterSchema = z.object({
    key: keySchema,
    name: nameSchema,
    description: descriptionSchema,
    level: z.number().int().min(1).max(999).default(1),
    stats: statsSchema,
    skills: z.array(z.string()).default([]),
    resistances: z.record(z.number()).default({}),
    exp: z.number().int().min(0).default(10),
    gold: z.number().int().min(0).default(5),
    drops: z.array(z.object({
        itemKey: z.string(),
        chance: z.number().min(0).max(1).default(0.5),
        min: z.number().int().min(1).default(1),
        max: z.number().int().min(1).default(1),
    })).default([]),
    ai: z.enum(['aggressive', 'defensive', 'random']).default('aggressive'),
    tags: z.array(z.string()).default([]),
}).passthrough();

export const equipmentSchema = z.object({
    key: keySchema,
    name: nameSchema,
    kind: z.enum(['weapon', 'armor', 'accessory', 'consumable', 'quest', 'material']).default('weapon'),
    description: descriptionSchema,
    rarity: z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary']).default('common'),
    price: z.number().int().min(0).default(0),
    stackable: z.boolean().default(true),
    maxStack: z.number().int().min(1).max(9999).default(99),
    slot: z.enum(['weapon', 'armor', 'accessory']).nullable().optional(),
    stats: statsSchema.default({}),
    effects: z.record(z.any()).default({}),
    classRestrictions: z.array(z.string()).default([]),
    consumable: z.object({
        healHp: z.number().optional(),
        healMp: z.number().optional(),
        cure: z.array(z.string()).default([]),
        buff: z.object({
            stat: z.string(),
            amount: z.number(),
            duration: z.number().int().min(1).default(3),
        }).optional(),
    }).optional(),
    tags: z.array(z.string()).default([]),
}).passthrough();

export const skillSchema = z.object({
    key: keySchema,
    name: nameSchema,
    category: z.enum(['active', 'passive']).default('active'),
    type: z.enum(['attack', 'heal', 'buff', 'debuff', 'status', 'utility']).default('attack'),
    description: descriptionSchema,
    mpCost: z.number().int().min(0).default(0),
    cooldown: z.number().int().min(0).default(0),
    target: z.enum(['single', 'all_enemies', 'self', 'ally', 'all_allies']).default('single'),
    element: z.enum(['physical', 'fire', 'ice', 'lightning', 'holy', 'dark', 'none']).default('physical'),
    power: z.number().default(0),
    formula: z.string().optional(),
    effects: z.object({
        applyStatus: z.object({
            effectKey: z.string(),
            chance: z.number().min(0).max(1).default(1),
            duration: z.number().int().min(1).default(2),
        }).optional(),
        buff: z.object({ stat: z.string(), amount: z.number(), duration: z.number().int().min(1).default(3) }).optional(),
        drain: z.number().min(0).max(1).optional(),
    }).default({}),
    unlockLevel: z.number().int().min(1).default(1),
    classes: z.array(z.string()).default([]),
    passive: z.object({ modifiers: z.record(z.number()).default({}) }).optional(),
}).passthrough();

export const questSchema = z.object({
    key: keySchema,
    name: nameSchema,
    type: z.enum(['main', 'side', 'hidden']).default('side'),
    description: descriptionSchema,
    level: z.number().int().min(1).default(1),
    prerequisites: z.array(z.string()).default([]),
    start: z.object({
        type: z.enum(['npc', 'location', 'story', 'auto']).default('npc'),
        npcKey: z.string().optional(),
        locationKey: z.string().optional(),
        storyNodeKey: z.string().optional(),
    }).default({ type: 'npc' }),
    turnIn: z.object({ npcKey: z.string() }).nullable().optional(),
    completion: z.enum(['auto', 'turn_in']).default('auto'),
    stages: z.array(z.object({
        key: z.string(),
        name: z.string(),
        description: z.string().default(''),
        mode: z.enum(['all', 'any']).default('all'),
        objectives: z.array(z.object({
            key: z.string(),
            type: z.enum(['kill', 'collect', 'talk', 'visit', 'flag', 'level', 'combat_win']),
            targetKey: z.string().optional(),
            count: z.number().int().min(1).default(1),
            label: z.string().default(''),
        })).min(1),
    })).min(1),
    rewards: z.object({
        exp: z.number().int().min(0).default(0),
        gold: z.number().int().min(0).default(0),
        items: z.array(z.object({ itemKey: z.string(), quantity: z.number().int().min(1).default(1) })).default([]),
        skills: z.array(z.string()).default([]),
        flags: z.array(z.string()).default([]),
        storyKey: z.string().optional(),
    }).default({ exp: 0, gold: 0, items: [], skills: [], flags: [] }),
    failure: z.object({
        type: z.enum(['time', 'flag', 'combat']).optional(),
        targetKey: z.string().optional(),
    }).nullable().optional(),
    nodes: z.array(z.any()).default([]),
    edges: z.array(z.any()).default([]),
}).passthrough();

export const storySchema = z.object({
    key: keySchema,
    name: nameSchema,
    description: descriptionSchema,
    startNodeKey: z.string(),
    endings: z.array(z.string()).default([]),
    variables: z.record(z.any()).default({}),
    nodes: z.array(z.object({
        key: z.string(),
        title: z.string(),
        type: z.enum(['scene', 'branch', 'ending', 'event']).default('scene'),
        sceneKey: z.string().optional(),
        text: z.string().default(''),
        conditions: conditionSchema.optional(),
        actions: z.array(actionSchema).default([]),
        map: z.object({ x: numberSchema.default(0), y: numberSchema.default(0) }).default({ x: 0, y: 0 }),
    }).passthrough()).min(1),
    edges: z.array(z.object({
        key: z.string(),
        from: z.string(),
        to: z.string(),
        label: z.string().default(''),
        condition: conditionSchema.optional(),
        actions: z.array(actionSchema).default([]),
    }).passthrough()).default([]),
}).passthrough();

export const worldSchema = z.object({
    key: keySchema,
    name: nameSchema,
    description: descriptionSchema,
    startLocationKey: z.string(),
    mapImage: z.string().nullable().optional(),
    lore: z.string().default(''),
    tags: z.array(z.string()).default([]),
}).passthrough().superRefine((data, ctx) => {
    if (Array.isArray(data.locations) || Array.isArray(data.connections)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['locations'],
            message: 'A world asset holds setting metadata only. Put locations in scene assets and connections in each scene.',
        });
    }
});

export const classSchema = z.object({
    key: keySchema,
    name: nameSchema,
    description: descriptionSchema,
    baseStats: statsSchema,
    growth: statsSchema,
    startingItems: z.array(z.object({ itemKey: z.string(), quantity: z.number().int().min(1).default(1) })).default([]),
    startingSkills: z.array(z.string()).default([]),
    skillTree: z.array(z.object({ level: z.number().int().min(1), skillKey: z.string() })).default([]),
}).passthrough();

export const rulesSchema = z.object({
    levelCap: z.number().int().min(2).max(999).default(30),
    startingGold: z.number().int().min(0).default(50),
    statCaps: z.record(z.number()).default({}),
    formulas: z.record(z.string()).default({}),
    expTable: z.array(z.object({ level: z.number().int(), exp: z.number().int() })).default([]),
    enemyScaling: z.object({ hp: z.number().default(1), atk: z.number().default(1) }).default({ hp: 1, atk: 1 }),
    saveEveryCombatAction: z.boolean().default(true),
}).passthrough();

export const statusEffectSchema = z.object({
    key: keySchema,
    name: nameSchema,
    kind: z.enum(['buff', 'debuff', 'dot', 'control']).default('debuff'),
    description: descriptionSchema,
    duration: z.number().int().min(1).default(2),
    modifiers: z.record(z.number()).default({}),
    tick: z.object({
        type: z.enum(['damage_percent', 'heal_percent', 'none']).default('none'),
        value: z.number().default(0),
    }).default({ type: 'none', value: 0 }),
    skipTurn: z.boolean().default(false),
}).passthrough();

export const ASSET_SCHEMAS = {
    world: worldSchema,
    scene: sceneSchema,
    event: eventSchema,
    npc: npcSchema,
    monster: monsterSchema,
    equipment: equipmentSchema,
    skill: skillSchema,
    quest: questSchema,
    story: storySchema,
    class: classSchema,
    rules: rulesSchema,
    status_effect: statusEffectSchema,
};

export const DEFAULT_RULES = {
    levelCap: 30,
    startingGold: 50,
    statCaps: { maxHp: 9999, maxMp: 999, str: 999, agi: 999, int: 999, vit: 999, luck: 999 },
    formulas: {},
    expTable: [],
    enemyScaling: { hp: 1, atk: 1 },
    saveEveryCombatAction: true,
};

export const DEFAULT_CLASS = {
    key: 'adventurer',
    name: 'Adventurer',
    description: 'A balanced starting class.',
    baseStats: { maxHp: 90, maxMp: 30, str: 12, agi: 10, int: 9, vit: 11, luck: 8 },
    growth: { maxHp: 18, maxMp: 6, str: 2.2, agi: 1.6, int: 1.5, vit: 2, luck: 1.1 },
    startingItems: [],
    startingSkills: [],
    skillTree: [],
};

export const GAME_PACKAGE_SCHEMA = z.object({
    schema: z.literal('strpg.game-package'),
    schemaVersion: z.number().int().min(1).max(1),
    meta: z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().optional(),
        version: z.string(),
        author: z.string().default('STRPG Studio'),
        description: z.string().default(''),
        createdAt: z.string().optional(),
    }).passthrough(),
    world: worldSchema,
    locations: z.array(sceneSchema).min(1),
    events: z.array(eventSchema).default([]),
    classes: z.array(classSchema).min(1),
    npcs: z.array(npcSchema).default([]),
    monsters: z.array(monsterSchema).default([]),
    items: z.array(equipmentSchema).default([]),
    skills: z.array(skillSchema).default([]),
    effects: z.array(statusEffectSchema).default([]),
    quests: z.array(questSchema).default([]),
    story: storySchema,
    rules: rulesSchema.default(DEFAULT_RULES),
    start: z.object({ locationKey: z.string(), storyNodeKey: z.string().optional() }).optional(),
    integrations: z.record(z.any()).default({}),
}).passthrough();

export function parseAsset(kind, data) {
    const schema = ASSET_SCHEMAS[kind];
    if (!schema) return { success: false, error: { issues: [{ path: ['kind'], message: `Unknown asset kind: ${kind}` }] } };
    const result = schema.safeParse(data);
    return result;
}

export function normalizeZodIssues(error) {
    return error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
    }));
}






