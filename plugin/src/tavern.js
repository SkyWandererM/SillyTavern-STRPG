import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { createAsset } from './studio.js';
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

/**
 * M4: import a SillyTavern character card as a DRAFT NPC asset in the campaign's project.
 * The card supplies voice and identity; numbers are never imported.
 */
export function importCardAsNpc(db, campaignId, card = {}) {
    const campaign = db.prepare(`
        SELECT c.*, v.project_id FROM campaigns c JOIN game_versions v ON v.id = c.game_version_id WHERE c.id = ?
    `).get(campaignId);
    if (!campaign) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    const name = String(card.name ?? card.ch_name ?? '').trim();
    if (!name) throw new ValidationError('Character name is required');
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'npc';
    let key = base;
    let suffix = 2;
    while (db.prepare('SELECT 1 FROM content_assets WHERE project_id = ? AND kind = ? AND asset_key = ?').get(campaign.project_id, 'npc', key)) {
        key = `${base}_${suffix}`;
        suffix += 1;
        if (suffix > 99) throw new ConflictError('Too many NPCs with that name', 'NPC_KEY_CONFLICT');
    }
    const firstMessage = String(card.firstMessage ?? card.first_mes ?? '').slice(0, 2000);
    const data = {
        key,
        name,
        title: String(card.title ?? '').slice(0, 200),
        description: String(card.description ?? '').slice(0, 20000),
        personality: String(card.personality ?? '').slice(0, 6000),
        motivation: String(card.scenario ?? '').slice(0, 6000),
        interactions: [{
            key: 'talk',
            label: 'Talk',
            type: 'talk',
            dialogue: firstMessage ? [firstMessage] : [],
        }],
        tavern: {
            avatar: String(card.avatar ?? '').slice(0, 300),
            importedAt: nowIso(),
        },
        sourceCard: {
            name,
            creator: String(card.creator ?? '').slice(0, 120),
            tags: Array.isArray(card.tags) ? card.tags.map(String).slice(0, 20) : [],
        },
        tags: ['strpg', 'imported-card'],
    };
    const asset = createAsset(db, campaign.project_id, { kind: 'npc', name, data });
    return {
        asset: { id: asset.id, key, name, status: asset.status, revision: asset.revision },
        projectId: campaign.project_id,
        next: [
            'Open Studio -> content, validate and review the new NPC asset.',
            'Publish it, then build a new Game Version.',
            'Adventure -> Campaign -> Upgrade so the running campaign can use it.',
            'Bind the character avatar to the NPC in Integrations -> Character Bindings.',
        ],
    };
}