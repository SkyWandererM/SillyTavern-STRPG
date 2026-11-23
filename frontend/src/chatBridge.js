/**
 * Chat-side performance helper.
 *
 * The server cannot write into a SillyTavern chat, so an approved `chat.performance`
 * candidate is rendered here: the line is appended as a narrator/NPC message and saved.
 */

export function chatApi() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

export function canPerform() {
    const ctx = chatApi();
    return Boolean(ctx?.chat && typeof ctx.addOneMessage === 'function');
}

export async function performChatLine(applied = {}) {
    const ctx = chatApi();
    if (!ctx?.chat) throw new Error('SillyTavern chat is not available.');
    if (typeof ctx.addOneMessage !== 'function') throw new Error('SillyTavern addOneMessage is not available.');
    const lines = [applied.text, ...(Array.isArray(applied.lines) ? applied.lines : [])]
        .map((line) => String(line ?? '').trim())
        .filter(Boolean);
    if (!lines.length) throw new Error('The performance has no text.');
    const message = {
        name: applied.npcName || 'Narrator',
        is_user: false,
        is_system: !applied.npcName,
        send_date: new Date().toISOString(),
        mes: lines.join('\n'),
        extra: { strpgPerformance: true, npcKey: applied.npcKey ?? null },
    };
    ctx.chat.push(message);
    ctx.addOneMessage(message);
    await ctx.saveChat?.();
    return message;
}
