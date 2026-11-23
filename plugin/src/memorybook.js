import { ConflictError } from './errors.js';
import { getCampaignPackage, getPlayer } from './stats.js';
import { parseJson } from './util.js';

function entry(uid, name, keys, content, order = 100) {
    return {
        uid,
        key: [name, ...keys.filter(Boolean)],
        keysecondary: [],
        comment: name,
        content,
        constant: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: uid,
    };
}

export function buildMemoryBook(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(campaign?.current_location_id);
    const player = getPlayer(db, campaignId);
    const entries = {};
    let uid = 0;
    const add = (name, keys, content, order = 100) => { entries[String(uid)] = entry(uid, name, keys, content, order); uid += 1; };
    add(pkg.world.name, [pkg.world.key, 'world', 'setting'], [pkg.world.lore, pkg.world.description].filter(Boolean).join('\n\n'), 150);
    for (const scene of pkg.locations ?? []) {
        const links = (scene.connections ?? []).map((connection) => connection.toKey).join(', ');
        add(scene.name, [scene.key, scene.type, scene.layer], [scene.description, `Layer: ${scene.layer}. Site type: ${scene.siteType ?? scene.type}.`, links ? `Connections: ${links}.` : ''].filter(Boolean).join('\n'), 100);
    }
    for (const npc of pkg.npcs ?? []) {
        add(npc.name, [npc.key, npc.title], [npc.title, npc.description, npc.personality, npc.motivation].filter(Boolean).join('\n'), 110);
    }
    for (const quest of pkg.quests ?? []) {
        add(quest.name, [quest.key, 'quest'], [quest.description, ...(quest.stages ?? []).map((stage) => `${stage.name}: ${(stage.objectives ?? []).map((objective) => objective.label || objective.key).join('; ')}`)].filter(Boolean).join('\n'), 90);
    }
    add('STRPG Rules', ['strpg', 'rules', 'system'], 'STRPG owns HP, MP, EXP, gold, items, skills, quests, combat and world state. The LLM narrates only; never invent or change numbers. Use the current location, NPC and quest facts from this memory book. A proposal is not an action until the player confirms it.', 200);
    add('Current Situation', ['current', 'campaign', campaign?.name], [`Campaign: ${campaign?.name ?? 'unknown'}`, `Current location: ${location?.name ?? 'unknown'} (${location?.location_key ?? 'unknown'})`, `Player: ${player.name} Lv.${player.level ?? 1}`].join('\n'), 180);
    return { name: `STRPG - ${campaign?.name ?? 'Campaign'}`, data: { entries } };
}

export async function pushMemoryBook(db, campaignId, request) {
    const book = buildMemoryBook(db, campaignId);
    const headers = { 'content-type': 'application/json' };
    if (request.headers.cookie) headers.cookie = request.headers.cookie;
    const csrf = request.headers['x-csrf-token'];
    if (csrf) headers['x-csrf-token'] = String(csrf);
    const protocol = request.protocol || 'http';
    const response = await fetch(`${protocol}://${request.get('host')}/api/worldinfo/edit`, {
        method: 'POST', headers, body: JSON.stringify(book),
    });
    if (!response.ok) throw new ConflictError(`Memory book push failed (HTTP ${response.status})`, 'MEMORY_BOOK_PUSH_FAILED');
    return { name: book.name, entries: Object.keys(book.data.entries).length };
}
