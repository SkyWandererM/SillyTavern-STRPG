/**
 * Thin bridge to SillyTavern's generation pipeline.
 *
 * STRPG never talks to a provider directly: it asks the SillyTavern client for
 * a quiet prompt, so the user's current connection, preset and model apply.
 */
export function generationContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

export function hasGeneration() {
    const ctx = generationContext();
    return Boolean(ctx?.generateQuietPrompt || ctx?.generateRaw);
}

export function describeGenerationTarget() {
    const ctx = generationContext();
    if (!ctx) return 'SillyTavern context unavailable';
    const model = ctx.getChatCompletionModel?.()
        ?? ctx.chatCompletionSettings?.custom_model
        ?? ctx.chatCompletionSettings?.openai_model
        ?? 'configured model';
    return `SillyTavern · ${model}`;
}

export async function generateQuiet(prompt, { responseLength = 1800, quietName = 'STRPG Workbench' } = {}) {
    const ctx = generationContext();
    if (!ctx) throw new Error('SillyTavern is not available. Open STRPG inside SillyTavern.');
    try {
        // generateRaw avoids pulling the current roleplay chat into a content
        // writing request. It still uses the user's configured connection,
        // preset and model.
        if (typeof ctx.generateRaw === 'function') {
            const reply = await ctx.generateRaw({
                prompt,
                responseLength,
                quietName,
                systemPrompt: 'You are the STRPG World Writer, a precise JRPG content designer. Follow the requested JSON contract exactly.',
            });
            return String(reply ?? '');
        }
        if (typeof ctx.generateQuietPrompt === 'function') {
            const reply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName, responseLength });
            return String(reply ?? '');
        }
    } catch (error) {
        throw new Error(`Generation failed: ${error?.message ?? error}`);
    }
    throw new Error('This SillyTavern build does not expose generateRaw or generateQuietPrompt. Update SillyTavern or generate content in chat and paste the JSON.');
}
