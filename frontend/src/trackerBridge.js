import { api } from './api.js';

/**
 * RPG Tracker adapter (M1).
 *
 * Pull: read whitelisted narrative fields from the Tracker's live state and queue them
 * in the STRPG review inbox. Nothing is written until the player approves it.
 *
 * Push: write a compact read-only STRPG line into worldState.events. This is opt-in
 * because RPG Tracker owns that object and the player may prefer a clean log.
 */

const PUSH_FLAG = 'strpg.trackerPush';
export const NARRATIVE_WHITELIST = [
    'mood', 'emotion', 'attitude', 'relationship', 'trust', 'affection', 'fear', 'desire',
    'thought', 'summary', 'narrativeFlags', 'lastInteraction',
];

export function getTrackerBridge() {
    return globalThis.window?.RPGBridge ?? null;
}

export function trackerAvailable() {
    const bridge = getTrackerBridge();
    return Boolean(bridge && bridge.currentTrackerData && typeof bridge.syncChatData === 'function');
}

export function isPushEnabled() {
    try {
        return globalThis.localStorage?.getItem(PUSH_FLAG) === '1';
    } catch {
        return false;
    }
}

export function setPushEnabled(enabled) {
    try {
        if (enabled) globalThis.localStorage?.setItem(PUSH_FLAG, '1');
        else globalThis.localStorage?.removeItem(PUSH_FLAG);
    } catch {
        // localStorage may be unavailable in private modes.
    }
}

function stringifyValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
    if (typeof value === 'object') return Object.entries(value).map(([key, entry]) => `${key}: ${entry}`).join('; ');
    return String(value).trim();
}

/**
 * Extract whitelisted narrative fields from the live Tracker state.
 * @returns {{characters: Array<object>, world: object}}
 */
export function readTrackerNarrative() {
    const data = getTrackerBridge()?.currentTrackerData ?? {};
    const characters = (Array.isArray(data.characters) ? data.characters : [])
        .map((character) => {
            const name = stringifyValue(character?.name ?? character?.charName ?? character?.id);
            const out = { name };
            for (const key of NARRATIVE_WHITELIST) {
                const value = stringifyValue(character?.[key]);
                if (value) out[key] = value;
            }
            return name ? out : null;
        })
        .filter(Boolean)
        .filter((character) => Object.keys(character).length > 1);
    return { characters };
}

export async function pullTrackerNarrative(campaignId) {
    const payload = readTrackerNarrative();
    if (!payload.characters.length) {
        throw new Error('RPG Tracker has no narrative fields to pull. Add mood/attitude/summary to a tracker character first.');
    }
    return api(`/campaigns/${campaignId}/bridge/tracker/pull`, { method: 'POST', body: payload });
}

/**
 * Push one compact STRPG line into RPG Tracker's worldState.events.
 * Never touches character sheets, stats, inventory or quests.
 */
export async function pushMirrorToTracker(campaignId) {
    const bridge = getTrackerBridge();
    if (!bridge?.currentTrackerData) throw new Error('RPG Tracker is not loaded in this browser.');
    const mirror = await api(`/campaigns/${campaignId}/bridge/mirror`);
    const data = JSON.parse(JSON.stringify(bridge.currentTrackerData));
    const player = mirror.characters?.[0] ?? {};
    const activeQuests = (mirror.quests ?? []).filter((quest) => ['active', 'ready_to_turn_in'].includes(quest.status)).length;
    const desc = [
        `STRPG ${mirror.world?.location ?? 'unknown'}`,
        `Lv.${player.level ?? 1} HP ${player.hp ?? '?'}/${player.maxHp ?? '?'} MP ${player.mp ?? '?'}/${player.maxMp ?? '?'}`,
        `Gold ${player.gold ?? '?'}`,
        `Quests ${activeQuests}`,
        mirror.world?.storyNode ? `Story ${mirror.world.storyNode}` : '',
    ].filter(Boolean).join(' | ');
    data.worldState = data.worldState && typeof data.worldState === 'object' ? data.worldState : {};
    const events = Array.isArray(data.worldState.events) ? data.worldState.events : [];
    data.worldState.events = [
        { id: 'strpg_mirror', name: 'STRPG', desc: desc.slice(0, 260) },
        ...events.filter((entry) => entry?.name !== 'STRPG'),
    ].slice(0, 12);
    bridge.syncChatData?.(data);
    bridge.saveChatData?.(data);
    return { pushed: true, line: desc, events: data.worldState.events.length };
}

export async function loadBridge(campaignId) {
    const [status, candidates] = await Promise.all([
        api(`/campaigns/${campaignId}/bridge`),
        api(`/campaigns/${campaignId}/bridge/candidates?status=PENDING`),
    ]);
    return { status, candidates };
}
