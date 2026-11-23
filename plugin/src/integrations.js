import { NotFoundError, ValidationError } from './errors.js';
import { getDashboard } from './campaigns.js';
import { listQuests } from './quests.js';
import { getCampaignLocation } from './world.js';
import { nowIso, parseJson, uuid, withTransaction } from './util.js';

export const TRACKER_WHITELIST = [
    'mood', 'emotion', 'attitude', 'relationship', 'trust', 'affection', 'fear', 'desire',
    'thought', 'summary', 'narrativeFlags', 'lastInteraction',
];

function validateWhitelist(payload) {
    const unknown = Object.keys(payload ?? {}).filter((key) => !TRACKER_WHITELIST.includes(key));
    if (unknown.length) {
        throw new ValidationError(`Tracker Bridge only accepts narrative whitelist fields. Rejected: ${unknown.join(', ')}`, {
            allowed: TRACKER_WHITELIST,
        });
    }
    if (JSON.stringify(payload).length > 20000) throw new ValidationError('Tracker payload is too large');
    return payload;
}

export function trackerSync(db, campaignId, payload, options = {}) {
    const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const direction = options.direction === 'outbound' ? 'outbound' : 'inbound';
    let data;
    if (direction === 'inbound') {
        data = validateWhitelist(payload);
    } else {
        const current = db.prepare('SELECT state_json FROM narrative_state WHERE campaign_id = ?').get(campaignId);
        data = current ? parseJson(current.state_json, {}) : {};
    }
    const status = options.available === false ? 'buffered_no_extension' : 'synced';
    return withTransaction(db, () => {
        if (direction === 'inbound') {
            const current = db.prepare('SELECT state_json FROM narrative_state WHERE campaign_id = ?').get(campaignId);
            const merged = { ...(current ? parseJson(current.state_json, {}) : {}), ...data, updatedAt: nowIso() };
            db.prepare(`
                INSERT INTO narrative_state (campaign_id, provider, state_json, updated_at) VALUES (?, 'rpg-tracker', ?, ?)
                ON CONFLICT(campaign_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
            `).run(campaignId, JSON.stringify(merged), nowIso());
        }
        db.prepare(`
            INSERT INTO tracker_sync_log (id, campaign_id, provider, direction, payload_json, status, message, created_at)
            VALUES (?, ?, 'rpg-tracker', ?, ?, ?, ?, ?)
        `).run(uuid('sync_'), campaignId, direction, JSON.stringify(data), status, options.message ?? '', nowIso());
        return {
            ok: true,
            direction,
            status,
            data,
            authoritativeFields: [],
            note: 'RPG Tracker is a narrative mirror only. STRPG remains authoritative for HP, MP, EXP, gold, equipment, skills and inventory.',
        };
    });
}

export function trackerState(db, campaignId) {
    const row = db.prepare('SELECT * FROM narrative_state WHERE campaign_id = ?').get(campaignId);
    return {
        available: Boolean(row),
        provider: 'rpg-tracker',
        state: row ? parseJson(row.state_json, {}) : {},
        whitelist: TRACKER_WHITELIST,
        authority: 'STRPG Core',
    };
}

export function memoryBooksPayload(db, campaignId) {
    const dashboard = getDashboard(db, campaignId);
    const quests = listQuests(db, campaignId);
    const recentEvents = db.prepare('SELECT seq, type, payload_json, created_at FROM game_events WHERE campaign_id = ? ORDER BY seq DESC LIMIT 12').all(campaignId)
        .map((row) => ({ seq: row.seq, type: row.type, payload: parseJson(row.payload_json, {}), at: row.created_at })).reverse();
    const active = quests.filter((quest) => ['active', 'ready_to_turn_in'].includes(quest.status));
    const completed = quests.filter((quest) => ['completed', 'turned_in'].includes(quest.status));
    const markdown = [
        `# STRPG Story Memory: ${dashboard.campaign.name}`,
        `- World: ${dashboard.world?.name ?? 'Unknown'}`,
        `- Current location: ${dashboard.location.name}`,
        `- Story node: ${dashboard.story.current?.title ?? 'Not started'}`,
        `- Player: ${dashboard.player.name} (Lv.${dashboard.player.level})`,
        '',
        '## In Progress',
        ...(active.length ? active.map((quest) => `- [${quest.type}] ${quest.name}: ${quest.stages.find((stage) => stage.key === quest.stageKey)?.description ?? ''}`) : ['- None']),
        '',
        '## Completed',
        ...(completed.length ? completed.map((quest) => `- ${quest.name}`) : ['- None']),
        '',
        '## Recent Events',
        ...recentEvents.map((event) => {
            const summary = typeof event.payload?.summary === 'string' ? event.payload.summary : JSON.stringify(event.payload);
            return `- ${event.at} ${event.type}: ${summary.slice(0, 240)}`;
        }),
        '',
        '> This text is an explicit Memory Books continuity export. Numeric state remains authoritative in the STRPG database.',
    ].join('\n');
    return {
        provider: 'memory-books',
        mode: 'explicit-side-prompt-export',
        markdown,
        structured: {
            world: dashboard.world?.name,
            location: dashboard.location.name,
            storyNode: dashboard.story.current?.key,
            activeQuests: active.map((quest) => quest.key),
            completedQuests: completed.map((quest) => quest.key),
            recentEvents,
        },
        note: 'STRPG does not write Memory Books internal storage. Paste this into a Memory Books entry or use its Side Prompt feature.',
    };
}

export function importMapRegions(db, campaignId, payload) {
    const regions = Array.isArray(payload?.regions) ? payload.regions : [];
    if (!regions.length) throw new ValidationError('regions array is required');
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const updated = [];
    return withTransaction(db, () => {
        for (const region of regions) {
            if (!region.locationKey) continue;
            const location = db.prepare('SELECT * FROM locations WHERE world_id = ? AND location_key = ?')
                .get(campaign.world_id, region.locationKey);
            if (!location) continue;
            const data = parseJson(location.data_json, {});
            data.mapRegions = (data.mapRegions ?? []).filter((entry) => entry.regionId !== region.regionId);
            data.mapRegions.push({
                regionId: String(region.regionId ?? `${region.locationKey}_region`),
                label: String(region.label ?? location.name),
                polygon: Array.isArray(region.polygon) ? region.polygon : [],
                color: region.color ?? null,
                source: 'Map Region Locator',
            });
            db.prepare('UPDATE locations SET data_json = ? WHERE id = ?').run(JSON.stringify(data), location.id);
            updated.push({ locationKey: location.location_key, name: location.name });
        }
        db.prepare(`
            INSERT INTO external_imports (id, campaign_id, provider, kind, payload_json, imported_at)
            VALUES (?, ?, 'map-region-locator', 'map-regions', ?, ?)
        `).run(uuid('ext_'), campaignId, JSON.stringify(payload), nowIso());
        return {
            ok: true,
            imported: updated,
            note: 'Region polygons are display metadata only. Location connections remain authoritative in STRPG.',
        };
    });
}

export function exportMapRegions(db, campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const locations = db.prepare('SELECT * FROM locations WHERE world_id = ?').all(campaign.world_id);
    return {
        format: 'strpg.map-regions-export',
        formatVersion: 1,
        campaignId,
        regions: locations.flatMap((location) => {
            const data = parseJson(location.data_json, {});
            return (data.mapRegions ?? []).map((region) => ({
                ...region,
                locationKey: location.location_key,
                locationName: location.name,
                x: location.map_x,
                y: location.map_y,
            }));
        }),
        note: 'Import into Map Region Locator manually. STRPG does not modify that extension.',
    };
}

export function integrationStatus(db) {
    const imports = db.prepare(`
        SELECT provider, kind, MAX(imported_at) AS last_import, COUNT(*) AS count FROM external_imports GROUP BY provider, kind
    `).all();
    const tracker = db.prepare('SELECT COUNT(*) AS count FROM tracker_sync_log').get().count;
    return {
        mode: 'adapter-json',
        coreAuthority: ['hp', 'mp', 'exp', 'gold', 'equipment', 'skills', 'inventory', 'quests', 'combat'],
        adapters: [
            {
                id: 'memory-books', name: 'SillyTavern Memory Books', status: 'explicit-export',
                capabilities: ['story summary export', 'side prompt text', 'event log export'],
                writesToExtension: false,
            },
            {
                id: 'map-regions', name: 'SillyTavern Map Region Locator', status: imports.some((entry) => entry.provider === 'map-region-locator') ? 'imported' : 'available',
                capabilities: ['region JSON import', 'region JSON export'], writesToExtension: false,
            },
            {
                id: 'rpg-tracker', name: 'RPG Tracker for SillyTavern', status: tracker ? 'synced' : 'available',
                capabilities: ['whitelist narrative sync', 'sync audit log'], writesToExtension: false,
            },
        ],
        imports,
        trackerSyncs: tracker,
        note: 'All integrations use explicit JSON or prompt exchange. No external extension database is modified directly.',
    };
}
