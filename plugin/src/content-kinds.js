import { ValidationError } from './errors.js';
import { ASSET_KINDS } from './schemas.js';

/**
 * Designer cards and third-party prompts sometimes use semantic names instead of
 * the canonical Studio kinds. Keep the public contract strict, but normalize
 * common aliases at the import boundary so a valid design is not lost.
 */
export const KIND_ALIASES = {
    world_map: 'world',
    worldmap: 'world',
    world_map_graph: 'world',
    overworld: 'world',
    map: 'world',
    region_map: 'world',

    location: 'scene',
    locations: 'scene',
    scene_map: 'scene',
    town: 'scene',
    city: 'scene',
    village: 'scene',
    dungeon: 'scene',
    room: 'scene',
    building: 'scene',
    area: 'scene',
    region: 'scene',

    character: 'npc',
    characters: 'npc',
    person: 'npc',
    shopkeeper: 'npc',
    ally: 'npc',

    enemy: 'monster',
    enemies: 'monster',
    creature: 'monster',
    mob: 'monster',
    boss: 'monster',

    item: 'equipment',
    items: 'equipment',
    weapon: 'equipment',
    armor: 'equipment',
    armour: 'equipment',
    accessory: 'equipment',
    consumable: 'equipment',
    loot: 'equipment',
    gear: 'equipment',

    ability: 'skill',
    abilities: 'skill',
    spell: 'skill',
    technique: 'skill',

    plot: 'story',
    chapter: 'story',
    narrative: 'story',
    story_graph: 'story',
    adventure: 'story',

    mission: 'quest',
    task: 'quest',
    quest_graph: 'quest',
    objective: 'quest',

    job: 'class',
    profession: 'class',

    status: 'status_effect',
    effect: 'status_effect',
    buff: 'status_effect',
    debuff: 'status_effect',

    world_rules: 'rules',
    game_rules: 'rules',
};

export const KIND_CONTRACT = [...ASSET_KINDS];

function cleanKind(kind) {
    return String(kind ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function inferKind(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (Array.isArray(data.locations) || Array.isArray(data.regions) && data.startLocationKey) return 'world';
    if (data.startNodeKey && Array.isArray(data.nodes)) return 'story';
    if (Array.isArray(data.stages) && (data.completion || data.rewards || data.prerequisites)) return 'quest';
    if (Array.isArray(data.connections) && data.type) return 'scene';
    if (Array.isArray(data.interactions) && data.locationKey) return 'npc';
    if (data.baseStats && data.growth) return 'class';
    if (data.stats && (data.exp != null || data.drops || data.ai)) return 'monster';
    if ((data.mpCost != null || data.target) && (data.formula != null || data.power != null)) return 'skill';
    if (data.price != null && (data.kind || data.slot || data.stats)) return 'equipment';
    if (data.levelCap != null || data.startingGold != null || data.statCaps != null) return 'rules';
    if (data.startLocationKey) return 'world';
    return null;
}

/**
 * Resolve a canonical content kind from an incoming kind and/or payload shape.
 * @returns {{kind: string, originalKind: string|null, normalized: boolean, inferred: boolean, warning: string|null}}
 */
export function normalizeContentKind(kind, data) {
    const originalKind = kind == null ? null : String(kind);
    const cleaned = cleanKind(kind);
    if (ASSET_KINDS.includes(cleaned)) {
        return { kind: cleaned, originalKind, normalized: originalKind !== cleaned, inferred: false, warning: null };
    }
    let canonical = KIND_ALIASES[cleaned] ?? null;
    if (!canonical) {
        const tokens = cleaned.split('_');
        if (tokens.some((token) => ['npc', 'character', 'characters', 'person'].includes(token))) canonical = 'npc';
        else if (tokens.some((token) => ['monster', 'enemy', 'enemies', 'creature', 'mob', 'boss'].includes(token))) canonical = 'monster';
        else if (tokens.some((token) => ['item', 'items', 'equipment', 'weapon', 'armor', 'accessory', 'consumable'].includes(token))) canonical = 'equipment';
        else if (tokens.some((token) => ['skill', 'skills', 'ability', 'spell', 'technique'].includes(token))) canonical = 'skill';
        else if (tokens.some((token) => ['quest', 'mission', 'task'].includes(token))) canonical = 'quest';
        else if (tokens.some((token) => ['story', 'plot', 'chapter', 'narrative'].includes(token))) canonical = 'story';
        else if (tokens.some((token) => ['scene', 'location', 'place', 'room', 'dungeon'].includes(token))) canonical = 'scene';
        else if (tokens.some((token) => ['world', 'map', 'overworld'].includes(token))) canonical = 'world';
        else if (tokens.some((token) => ['class', 'job', 'profession'].includes(token))) canonical = 'class';
        else if (tokens.some((token) => ['rule', 'rules'].includes(token))) canonical = 'rules';
    }
    if (!canonical) canonical = inferKind(data);
    if (!canonical) {
        throw new ValidationError(
            `Unsupported content kind '${originalKind ?? '(missing)'}'. Studio accepts: ${ASSET_KINDS.join(', ')}.`,
            {
                code: 'UNKNOWN_ASSET_KIND',
                receivedKind: originalKind,
                allowedKinds: ASSET_KINDS,
                hint: 'Designer cards may emit an alias, but unknown kinds require a canonical kind before review.',
            },
        );
    }
    const warning = canonical
        ? `Mapped content kind '${originalKind ?? '(inferred)'}' to canonical kind '${canonical}'.`
        : null;
    return {
        kind: canonical,
        originalKind,
        normalized: true,
        inferred: !KIND_ALIASES[cleaned],
        warning,
    };
}

function ensureSceneConnections(location, connections = []) {
    const normalized = { ...location };
    if (!Array.isArray(normalized.connections)) normalized.connections = [];
    for (const connection of connections) {
        if (connection.from !== normalized.key && connection.fromKey !== normalized.key) continue;
        const toKey = connection.toKey ?? connection.to;
        if (!toKey) continue;
        normalized.connections.push({
            toKey,
            travelCost: Number(connection.travelCost ?? 0),
            bidirectional: connection.bidirectional !== false,
            condition: connection.condition ?? {},
            label: connection.label ?? '',
        });
    }
    normalized.connections = normalized.connections.filter((entry, index, list) => {
        return entry?.toKey && list.findIndex((candidate) => candidate.toKey === entry.toKey) === index;
    });
    return normalized;
}

/**
 * Expand a world-map-like payload into one world asset plus scene assets.
 * This handles designer output such as kind=world_map with a locations array.
 */
export function expandWorldMap(data, options = {}) {
    const source = data?.world && typeof data.world === 'object'
        ? { ...data.world, locations: data.locations ?? data.world.locations, connections: data.connections ?? data.world.connections }
        : data;
    const locations = Array.isArray(source?.locations) ? source.locations : [];
    if (!locations.length) return null;
    const connections = Array.isArray(source.connections) ? source.connections : [];
    const scenes = locations.map((location, index) => {
        const key = String(location.key ?? location.locationKey ?? `location_${index + 1}`);
        const scene = ensureSceneConnections({ ...location, key }, connections);
        scene.name = scene.name ?? key;
        scene.type = scene.type ?? 'town';
        scene.connections = scene.connections ?? [];
        return { kind: 'scene', data: scene, name: scene.name };
    });
    const start = source.startLocationKey ?? source.start ?? scenes[0]?.data.key;
    const world = {
        key: source.key ?? source.worldKey ?? 'world',
        name: source.name ?? source.title ?? options.name ?? 'World',
        description: source.description ?? '',
        startLocationKey: start,
        lore: source.lore ?? '',
        tags: Array.isArray(source.tags) ? source.tags : [],
    };
    if (source.mapImage) world.mapImage = source.mapImage;
    return [
        { kind: 'world', data: world, name: world.name },
        ...scenes,
    ];
}

/**
 * Convert any supported import input into zero or more canonical asset drafts.
 * @param {{kind?: string, data?: object, asset?: object, name?: string}} input
 */
export function normalizeAssetInput(input) {
    if (!input || typeof input !== 'object') {
        throw new ValidationError('Asset import must be a JSON object');
    }
    const data = input.data ?? input.asset ?? input;
    const declaredKind = input.kind ?? data.kind;
    const normalized = normalizeContentKind(declaredKind, data);
    // A canonical world asset must stay a world asset. Only an alias/legacy
    // world-map payload is expanded, so mixed world data is surfaced as an error.
    const isCanonicalWorld = String(normalized.originalKind ?? '').toLowerCase() === 'world';
    const expanded = normalized.kind === 'world' && !isCanonicalWorld
        ? expandWorldMap(data, { name: input.name ?? data.name })
        : null;
    if (expanded) {
        return { primaryKind: 'world', originalKind: normalized.originalKind, normalization: normalized, assets: expanded };
    }
    return {
        primaryKind: normalized.kind,
        originalKind: normalized.originalKind,
        normalization: normalized,
        assets: [{ kind: normalized.kind, data, name: input.name ?? data.name ?? data.key }],
    };
}

