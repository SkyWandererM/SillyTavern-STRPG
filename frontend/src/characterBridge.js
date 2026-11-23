import { api, getStContext } from './api.js';

/**
 * M4 character bridge: bind the active SillyTavern character to an STRPG NPC, open that
 * NPC's chat, and react to `open_chat` event actions.
 */

export function currentCharacter() {
    const ctx = getStContext();
    const index = Number(ctx.characterId);
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const character = Number.isInteger(index) && index >= 0 ? characters[index] : null;
    return character ? { index, avatar: character.avatar, name: character.name } : null;
}

export async function loadBindings(campaignId) {
    return api(`/campaigns/${campaignId}/bindings`);
}

export async function bindCurrentCharacter(campaignId, npcKey, direction = 'chat2rpg') {
    const character = currentCharacter();
    if (!character) throw new Error('No SillyTavern character is selected.');
    return api(`/campaigns/${campaignId}/bindings`, {
        method: 'POST',
        body: { npcKey: npcKey || null, stAvatar: character.avatar, stCharacterName: character.name, direction },
    });
}

export async function removeBinding(campaignId, bindingId) {
    return api(`/campaigns/${campaignId}/bindings/${bindingId}`, { method: 'DELETE' });
}

export async function resolveByAvatar(campaignId, avatar) {
    if (!avatar) return { found: false };
    return api(`/campaigns/${campaignId}/bindings/resolve?avatar=${encodeURIComponent(avatar)}`);
}

export async function openCharacterByAvatar(avatar) {
    const ctx = getStContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex((character) => character?.avatar === avatar);
    if (index === -1) throw new Error('That character is not available in SillyTavern.');
    if (typeof ctx.selectCharacterById !== 'function') throw new Error('SillyTavern does not expose character selection.');
    await ctx.selectCharacterById(index);
    return { index, avatar };
}

/**
 * Imports the active SillyTavern character card as a DRAFT NPC in this campaign's project.
 */
export async function importCurrentCardAsNpc(campaignId) {
    const character = currentCharacter();
    if (!character) throw new Error('No SillyTavern character is selected.');
    const ctx = getStContext();
    const index = Number(ctx.characterId);
    const card = (Array.isArray(ctx.characters) ? ctx.characters[index] : null) ?? {};
    return api(`/campaigns/${campaignId}/npcs/import-card`, {
        method: 'POST',
        body: {
            name: card.name ?? character.name,
            description: card.description ?? '',
            personality: card.personality ?? '',
            scenario: card.scenario ?? '',
            firstMessage: card.first_mes ?? card.firstMessage ?? '',
            avatar: character.avatar,
            creator: card.creator ?? '',
            tags: Array.isArray(card.tags) ? card.tags : [],
        },
    });
}

/**
 * Reacts to event results that carry `open_chat` actions. Returns the opened NPC keys.
 */
export async function handleOpenChatActions(campaignId, worldEvents = [], notify = null) {
    const opens = (worldEvents ?? [])
        .flatMap((event) => event?.applied ?? [])
        .filter((applied) => applied.type === 'open_chat' && applied.npcKey);
    const opened = [];
    for (const action of opens) {
        try {
            const resolved = await api(`/campaigns/${campaignId}/bindings/resolve?npcKey=${encodeURIComponent(action.npcKey)}`);
            if (resolved.found && resolved.binding?.stAvatar) {
                await openCharacterByAvatar(resolved.binding.stAvatar);
                notify?.(`Opened ${resolved.binding.stCharacterName || action.npcKey}'s chat.`, 'success');
                opened.push(action.npcKey);
            } else {
                notify?.(`${action.npcKey} wants to talk, but no character is bound to it yet.`, 'info');
            }
        } catch (error) {
            notify?.(`Could not open ${action.npcKey}'s chat: ${error.message}`, 'warning');
        }
    }
    return opened;
}
