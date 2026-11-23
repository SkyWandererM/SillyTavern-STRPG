import { api } from './api.js';
import { scanScope } from './scopeBridge.js';

/**
 * M3.1 auto-scan scheduler.
 *
 * Scopes whose config says `schedule: "every_n_messages:N"` run after every N received
 * messages. Failures only notify — nothing is written without the normal review step.
 * Manual scan stays available, so the automatic path is an optimization, not a dependency.
 */

const STORAGE_KEY = 'strpg.scopeAuto';
let counter = 0;

export function getAutoSettings() {
    try {
        const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
        return {
            enabled: Boolean(parsed?.enabled),
            everyN: Math.max(1, Math.min(100, Number(parsed?.everyN) || 8)),
        };
    } catch {
        return { enabled: false, everyN: 8 };
    }
}

export function setAutoSettings(settings) {
    const next = {
        enabled: Boolean(settings?.enabled),
        everyN: Math.max(1, Math.min(100, Number(settings?.everyN) || 8)),
    };
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // storage may be unavailable
    }
    return next;
}

export function resetAutoCounter() {
    counter = 0;
}

/** Applies the auto-scan setting to every scope of the campaign (manual ↔ every N). */
export async function applyAutoSchedule(campaignId, settings) {
    const { scopes } = await api(`/campaigns/${campaignId}/scopes`);
    const schedule = settings.enabled ? `every_n_messages:${settings.everyN}` : 'manual';
    for (const scope of scopes) {
        await api(`/campaigns/${campaignId}/scopes`, {
            method: 'POST',
            body: { key: scope.key, name: scope.name, enabled: scope.enabled, config: { ...scope.config, schedule } },
        });
    }
    return { updated: scopes.length, schedule };
}

export async function maybeAutoScan(campaignId, notify = null) {
    const settings = getAutoSettings();
    if (!settings.enabled || !campaignId) return null;
    counter += 1;
    if (counter < settings.everyN) return null;
    counter = 0;
    try {
        const { scopes } = await api(`/campaigns/${campaignId}/scopes`);
        const due = (scopes ?? []).filter((scope) => scope.enabled && /^every_n_messages:\d+$/.test(scope.config?.schedule ?? ''));
        if (!due.length) return null;
        const results = [];
        for (const scope of due) {
            try {
                const run = await scanScope(campaignId, scope);
                results.push({ key: scope.key, ...run });
            } catch (error) {
                notify?.(`Auto-scan '${scope.key}' failed: ${error.message}`, 'warning');
            }
        }
        const queued = results.reduce((sum, run) => sum + (Number(run.queued) || 0), 0);
        if (queued) notify?.(`Auto-scan queued ${queued} candidate(s) for review.`, 'success');
        return results;
    } catch (error) {
        notify?.(`Auto-scan failed: ${error.message}`, 'warning');
        return null;
    }
}
