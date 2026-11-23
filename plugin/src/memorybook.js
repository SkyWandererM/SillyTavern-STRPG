import { previewBook, pushLorebook } from './lorebook.js';

/**
 * Backwards-compatible wrapper around the incremental lorebook builder.
 *
 * `buildMemoryBook` returns the full STRPG-owned entry set (used for preview and by
 * the old endpoint). `pushMemoryBook` merges that set into the SillyTavern world
 * book instead of replacing the whole file, so user-written entries survive.
 */

export function buildMemoryBook(db, campaignId) {
    const preview = previewBook(db, campaignId);
    return { name: preview.name, data: { entries: preview.entries }, stats: preview.stats };
}

export async function pushMemoryBook(db, campaignId, request, options = {}) {
    const result = await pushLorebook(db, campaignId, request, options);
    return { ...result, entries: result.total };
}
