import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { nowIso, parseJson } from './util.js';

function characterPayload(row) {
    const data = parseJson(row.data_json, {});
    const name = String(data.name ?? row.name ?? '').trim();
    if (!name) throw new ValidationError('NPC name is required before importing to SillyTavern');
    const interactions = Array.isArray(data.interactions) ? data.interactions : [];
    const dialogue = interactions.flatMap((interaction) => Array.isArray(interaction.dialogue) ? interaction.dialogue : []);
    const first = data.greeting || dialogue[0] || `${name} looks up as you approach.`;
    const examples = dialogue.length
        ? `<START>\n{{user}}: Hello.\n{{char}}: ${dialogue[0]}`
        : '';
    const personality = [data.personality, data.motivation].filter(Boolean).join('\n');
    const description = [data.title, data.description].filter(Boolean).join('\n\n');
    return {
        ch_name: name,
        description,
        personality,
        scenario: data.scenario || (data.locationKey ? `Found at ${data.locationKey}.` : ''),
        first_mes: first,
        mes_example: examples,
        creator_notes: `Imported from STRPG as ${data.key ?? row.asset_key}. Important NPC.`,
        system_prompt: `You are ${name}. Stay in character. Do not narrate the player's actions. React to the scene and to the STRPG world state.`,
        post_history_instructions: '',
        tags: ['strpg', 'npc', ...(Array.isArray(data.tags) ? data.tags : [])],
        creator: 'STRPG',
        character_version: `strpg-${row.revision}`,
        talkativeness: 0.5,
        fav: false,
    };
}

export async function importNpcToTavern(db, assetId, request) {
    const row = db.prepare('SELECT * FROM content_assets WHERE id = ?').get(assetId);
    if (!row) throw new NotFoundError(`Asset '${assetId}' not found`, 'ASSET_NOT_FOUND');
    if (row.kind !== 'npc') throw new ValidationError('Only NPC assets can be imported to SillyTavern');
    const data = parseJson(row.data_json, {});
    if (!data.important) throw new ConflictError('Mark the NPC as important before importing to SillyTavern', 'NPC_NOT_IMPORTANT');
    const payload = characterPayload(row);
    const host = request.get('host');
    const protocol = request.protocol || 'http';
    const headers = { 'content-type': 'application/json' };
    if (request.headers.cookie) headers.cookie = request.headers.cookie;
    const csrf = request.headers['x-csrf-token'];
    if (csrf) headers['x-csrf-token'] = String(csrf);
    const response = await fetch(`${protocol}://${host}/api/characters/create`, {
        method: 'POST', headers, body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new ConflictError(`SillyTavern character import failed (HTTP ${response.status}): ${text.slice(0, 300)}`, 'TAVERN_IMPORT_FAILED');
    }
    const avatar = text.trim() || null;
    const importedAt = nowIso();
    if (row.status === 'DRAFT') {
        const next = { ...data, tavern: { avatar, importedAt } };
        db.prepare('UPDATE content_assets SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), importedAt, assetId);
    }
    return { avatar, importedAt, npcKey: data.key ?? row.asset_key, name: payload.ch_name, persisted: row.status === 'DRAFT' };
}
