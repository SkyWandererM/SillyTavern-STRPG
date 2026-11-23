import { api, getStContext } from './api.js';

/**
 * M3 scope helpers.
 *
 * The server builds the extraction prompt; this module supplies the chat window and runs
 * the quiet generation. Manual mode bypasses the model entirely: paste JSON items or a
 * single sentence and it lands in the same review queue.
 */

export function chatWindow(lastN = 12) {
    const ctx = getStContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const limit = Math.max(1, Math.min(200, Number(lastN) || 12));
    return chat.slice(-limit)
        .map((message) => ({
            speaker: message?.name || (message?.is_user ? (ctx.name1 || 'Player') : 'Narrator'),
            text: String(message?.mes ?? ''),
        }))
        .filter((message) => message.text.trim());
}

export async function scanScope(campaignId, scope) {
    const ctx = getStContext();
    if (typeof ctx.generateQuietPrompt !== 'function') {
        throw new Error('This SillyTavern build has no generateQuietPrompt; use Manual instead.');
    }
    const messages = chatWindow(scope.config?.source?.lastN ?? 12);
    if (!messages.length) throw new Error('The current chat has no messages to scan.');
    const prepared = await api(`/campaigns/${campaignId}/scopes/${scope.key}/prepare`, {
        method: 'POST', body: { messages },
    });
    if (prepared.skipped) return prepared;
    const reply = await ctx.generateQuietPrompt({ quietPrompt: prepared.prompt, responseLength: 1200 });
    return api(`/campaigns/${campaignId}/scopes/${scope.key}/scan`, {
        method: 'POST',
        body: { raw: reply, source: 'llm', messageCount: messages.length },
    });
}

export async function manualIngest(campaignId, scope, text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('Nothing to ingest.');
    const startsAsJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    return api(`/campaigns/${campaignId}/scopes/${scope.key}/scan`, {
        method: 'POST',
        body: startsAsJson ? { raw: trimmed, source: 'manual' } : { note: trimmed, source: 'manual' },
    });
}

export const SCOPE_MANUAL_HINTS = {
    narrative: '{"items":[{"npcKey":"elder_mira","fields":{"mood":"warm","summary":"She finally trusts you."}}]}',
    relation: '{"items":[{"npcKey":"elder_mira","delta":1,"reason":"Returned the sigil"}]}',
    flag: '{"items":[{"flag":"shrine_cleared"}]}',
    performance: '{"items":[{"npcKey":"elder_mira","text":"She studies you for a long moment."}]}',
};
