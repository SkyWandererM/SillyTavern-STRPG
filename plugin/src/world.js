import { ConflictError, NotFoundError } from './errors.js';
import { evaluateCondition } from './conditions.js';
import { getPlayer } from './stats.js';
import { updateQuestProgress } from './quests.js';
import { advanceStory, applyStoryActions } from './story.js';
import { encounterState } from './encounters.js';
import { insertEvent, nowIso, parseJson, withTransaction } from './util.js';

export function getCampaignWorld(db, campaignId) {
    const row = db.prepare(`
        SELECT w.* FROM worlds w JOIN campaigns c ON c.world_id = w.id WHERE c.id = ?
    `).get(campaignId);
    if (!row) throw new NotFoundError('Campaign world not found', 'WORLD_NOT_FOUND');
    return row;
}

export function getLocations(db, campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    return db.prepare(`
        SELECT l.*, CASE WHEN d.location_id IS NULL THEN 0 ELSE 1 END AS discovered
        FROM locations l
        LEFT JOIN location_discoveries d ON d.location_id = l.id AND d.campaign_id = ?
        WHERE l.world_id = ? ORDER BY l.name
    `).all(campaignId, campaign.world_id);
}

export function locationView(row, campaignId) {
    return {
        id: row.id,
        key: row.location_key,
        name: row.name,
        type: row.type,
        layer: row.layer ?? 'region',
        region: row.region,
        description: row.description,
        x: row.map_x,
        y: row.map_y,
        image: row.image,
        parentKey: row.parent_key ?? row.parent_id ?? null,
        spawnPoints: parseJson(row.spawn_points_json, []),
        discovered: Boolean(row.discovered),
        discoveredByDefault: Boolean(row.discovered_by_default),
        data: parseJson(row.data_json, {}),
        current: row.current ? Boolean(row.current) : undefined,
    };
}

export function getCampaignLocation(db, campaignId) {
    const row = db.prepare(`
        SELECT l.*, 1 AS discovered FROM campaigns c JOIN locations l ON l.id = c.current_location_id
        WHERE c.id = ?
    `).get(campaignId);
    if (!row) throw new NotFoundError('Current location not found', 'LOCATION_NOT_FOUND');
    return locationView(row, campaignId);
}

export function getConnections(db, campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const rows = db.prepare(`
        SELECT c.*,
            f.location_key AS from_key, f.name AS from_name, f.id AS from_id,
            t.location_key AS to_key, t.name AS to_name, t.id AS to_id,
            CASE WHEN df.location_id IS NULL THEN 0 ELSE 1 END AS from_discovered,
            CASE WHEN dt.location_id IS NULL THEN 0 ELSE 1 END AS to_discovered
        FROM location_connections c
        JOIN locations f ON f.id = c.from_location_id
        JOIN locations t ON t.id = c.to_location_id
        LEFT JOIN location_discoveries df ON df.location_id = f.id AND df.campaign_id = ?
        LEFT JOIN location_discoveries dt ON dt.location_id = t.id AND dt.campaign_id = ?
        WHERE c.world_id = ?
    `).all(campaignId, campaignId, campaign.world_id);
    return rows.map((row) => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        fromKey: row.from_key,
        toKey: row.to_key,
        fromName: row.from_name,
        toName: row.to_name,
        travelCost: row.travel_cost,
        mode: row.mode ?? 'walk',
        entryKey: row.entry_key ?? null,
        condition: parseJson(row.condition_json, {}),
        discovered: Boolean(row.from_discovered && row.to_discovered),
        fromDiscovered: Boolean(row.from_discovered),
        toDiscovered: Boolean(row.to_discovered),
    }));
}

export function discoverLocation(db, campaignId, locationId) {
    const existing = db.prepare('SELECT 1 FROM location_discoveries WHERE campaign_id = ? AND location_id = ?').get(campaignId, locationId);
    if (existing) return false;
    db.prepare('INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?)')
        .run(campaignId, locationId, nowIso());
    return true;
}

export function mapView(db, campaignId, filters = {}) {
    const locations = getLocations(db, campaignId);
    const connections = getConnections(db, campaignId);
    const campaign = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId);
    const current = locations.find((location) => location.id === campaign.current_location_id);
    const regions = [...new Set(locations.map((location) => location.region).filter(Boolean))].sort();
    const selected = locations.filter((location) => !filters.region || location.region === filters.region);
    const selectedIds = new Set(selected.map((location) => location.id));
    const world = getCampaignWorld(db, campaignId);
    const byKey = new Map(locations.map((location) => [location.location_key, location]));
    const breadcrumbs = [];
    let cursor = current ? byKey.get(current.location_key) : null;
    const guard = new Set();
    while (cursor && !guard.has(cursor.location_key)) {
        guard.add(cursor.location_key);
        breadcrumbs.unshift({ key: cursor.location_key, name: cursor.name, layer: cursor.layer ?? 'region' });
        cursor = cursor.parent_key ? byKey.get(cursor.parent_key) : null;
    }
    return {
        world: world ? {
            key: world.world_key,
            name: world.name,
            description: world.description,
            data: parseJson(world.data_json, {}),
        } : null,
        locations: selected.map((location) => ({ ...locationView(location, campaignId), current: location.id === campaign.current_location_id })),
        connections: connections.filter((connection) => !filters.region || (selectedIds.has(connection.fromId) && selectedIds.has(connection.toId))),
        current: current ? locationView(current, campaignId) : null,
        currentLayer: current?.layer ?? 'region',
        encounters: current ? encounterState(db, campaignId, current.id) : [],
        breadcrumbs,
        children: current ? locations.filter((location) => location.parent_key === current.location_key).map((location) => locationView(location, campaignId)) : [],
        regions,
    };
}

function findConnection(db, campaignId, targetLocationId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const connection = db.prepare(`
        SELECT c.*, t.location_key, t.id AS target_id, t.name AS target_name
        FROM location_connections c JOIN locations t ON t.id = c.to_location_id
        WHERE c.world_id = ? AND c.from_location_id = ? AND c.to_location_id = ?
    `).get(campaign.world_id, campaign.current_location_id, targetLocationId);
    return { campaign, connection };
}

const ROAD_LAYERS = new Set(['world', 'region', 'settlement', 'dungeon']);
const LOCAL_LAYERS = new Set(['settlement', 'interior', 'room', 'dungeon', 'floor']);

function validateTransition(from, to, mode, entryKey) {
    if (!from || !to) return { allowed: false, reason: 'Missing source or target location' };
    if (entryKey && !(to.spawnPoints ?? []).some((point) => point.key === entryKey)) {
        return { allowed: false, reason: `Unknown entry point '${entryKey}' at '${to.name}'` };
    }
    if (mode === 'road' || mode === 'trail') {
        if (!ROAD_LAYERS.has(from.layer) || !ROAD_LAYERS.has(to.layer)) {
            return { allowed: false, reason: `A ${mode} cannot enter a '${to.layer}' scene from a '${from.layer}' scene` };
        }
        return { allowed: true, reason: 'Road transition' };
    }
    if (mode === 'walk') {
        if (from.layer !== to.layer || from.parentKey !== to.parentKey) {
            return { allowed: false, reason: `Walking requires the same layer and parent (${from.layer}/${from.parentKey ?? '-'} → ${to.layer}/${to.parentKey ?? '-'})` };
        }
        return { allowed: true, reason: 'Walk transition' };
    }
    if (mode === 'door') {
        if (to.parentKey !== from.key && from.parentKey !== to.key) {
            return { allowed: false, reason: `Door '${from.key}' → '${to.key}' requires a parent/child scene relationship` };
        }
        if (!LOCAL_LAYERS.has(from.layer) && !LOCAL_LAYERS.has(to.layer)) {
            return { allowed: false, reason: 'Door transition must involve a local scene' };
        }
        return { allowed: true, reason: 'Door transition' };
    }
    if (mode === 'stairs') {
        if (!['dungeon', 'floor'].includes(from.layer) || !['dungeon', 'floor'].includes(to.layer)) {
            return { allowed: false, reason: 'Stairs can only connect dungeon or floor scenes' };
        }
        return { allowed: true, reason: 'Stairs transition' };
    }
    if (['gate', 'portal', 'secret'].includes(mode)) return { allowed: true, reason: `${mode} transition` };
    return { allowed: false, reason: `Unknown transition mode '${mode}'` };
}

export function proposeMovement(db, campaignId, targetLocationIdOrKey) {
    const target = db.prepare(`
        SELECT l.* FROM locations l JOIN campaigns c ON c.world_id = l.world_id
        WHERE c.id = ? AND (l.id = ? OR l.location_key = ?)
    `).get(campaignId, targetLocationIdOrKey, targetLocationIdOrKey);
    if (!target) return { allowed: false, code: 'LOCATION_NOT_FOUND', reason: 'Target location does not exist', target: null };
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (target.id === campaign.current_location_id) {
        return { allowed: false, code: 'ALREADY_THERE', reason: 'Player is already at this location', target: locationView(target, campaignId) };
    }
    const { connection } = findConnection(db, campaignId, target.id);
    if (!connection) {
        return { allowed: false, code: 'NO_CONNECTION', reason: 'There is no direct route from the current location', target: locationView(target, campaignId) };
    }
    if (!evaluateCondition(db, campaignId, parseJson(connection.condition_json, {}), { type: 'movement', targetKey: target.location_key })) {
        return { allowed: false, code: 'CONDITION_FAILED', reason: 'Travel conditions are not met', target: locationView(target, campaignId) };
    }
    const player = getPlayer(db, campaignId);
    if (Number(player.gold) < Number(connection.travel_cost)) {
        return { allowed: false, code: 'INSUFFICIENT_GOLD', reason: 'Not enough gold for travel', target: locationView(target, campaignId), cost: connection.travel_cost };
    }
    const targetView = locationView(target, campaignId);
    const fromView = locationView(db.prepare('SELECT * FROM locations WHERE id = ?').get(campaign.current_location_id), campaignId);
    const transition = validateTransition(fromView, targetView, connection.mode ?? 'walk', connection.entry_key ?? null);
    if (!transition.allowed) {
        return { allowed: false, code: 'TRANSITION_NOT_ALLOWED', reason: transition.reason, target: targetView, mode: connection.mode ?? 'walk' };
    }
    return {
        allowed: true,
        target: targetView,
        travelCost: Number(connection.travel_cost),
        mode: connection.mode ?? 'walk',
        entryKey: connection.entry_key ?? null,
        reason: 'Route is available',
    };
}

export function listEventDefinitions(db, campaignId, options = {}) {
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return [];
    const scopes = options.scopes ?? ['world', 'scene'];
    const scopeSql = scopes.map(() => '?').join(', ');
    const rows = db.prepare(`
        SELECT * FROM event_definitions
        WHERE game_version_id = ? AND trigger = ? AND scope IN (${scopeSql})
        ORDER BY priority DESC, event_key
    `).all(campaign.game_version_id, options.trigger ?? 'enter', ...scopes);
    return rows.map((row) => ({
        ...parseJson(row.data_json, {}),
        key: row.event_key,
        name: row.name,
        scope: row.scope,
        sceneKey: row.scene_key,
        trigger: row.trigger,
        targetKey: row.target_key,
        priority: row.priority,
        once: Boolean(row.once),
        condition: parseJson(row.condition_json, {}),
        actions: parseJson(row.actions_json, []),
    }));
}

/**
 * Run authored Event assets for a scene/world trigger. Events are separate
 * content assets; scenes only reference or host them. State is per Campaign.
 */
export function runEventDefinitions(db, campaignId, options = {}) {
    const trigger = options.trigger ?? 'enter';
    const sceneKey = options.sceneKey ?? null;
    const targetKey = options.targetKey ?? null;
    const events = listEventDefinitions(db, campaignId, { trigger, scopes: options.scopes });
    let sceneEventKeys = null;
    if (sceneKey) {
        const scene = db.prepare(`
            SELECT l.data_json FROM locations l JOIN campaigns c ON c.world_id = l.world_id
            WHERE c.id = ? AND l.location_key = ?
        `).get(campaignId, sceneKey);
        sceneEventKeys = new Set(parseJson(scene?.data_json, {}).eventKeys ?? []);
    }
    const firedRows = db.prepare("SELECT var_key FROM campaign_variables WHERE campaign_id = ? AND var_key LIKE 'event:%:fired'").all(campaignId);
    const fired = new Set(firedRows.map((row) => row.var_key));
    const results = [];
    for (const event of events) {
        if (options.eventKey && event.key !== options.eventKey) continue;
        if (event.scope === 'scene') {
            if (event.sceneKey !== sceneKey) continue;
            if (!sceneEventKeys?.has(event.key)) continue;
        }
        if (event.targetKey && event.targetKey !== targetKey) continue;
        if (event.once && fired.has(`event:${event.key}:fired`)) continue;
        if (!evaluateCondition(db, campaignId, event.condition ?? {}, { type: 'event', trigger, targetKey, eventKey: event.key })) continue;
        const applied = applyStoryActions(db, campaignId, event.actions ?? [], { source: 'event', eventKey: event.key });
        db.prepare(`
            INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, 'true', ?)
            ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at
        `).run(campaignId, `event:${event.key}:fired`, nowIso());
        insertEvent(db, campaignId, 'world.event', { eventKey: event.key, trigger, sceneKey, applied });
        results.push({ key: event.key, name: event.name, trigger, applied });
    }
    return results;
}

export function triggerManualEvent(db, campaignId, eventKey, options = {}) {
    const location = db.prepare('SELECT l.location_key FROM locations l JOIN campaigns c ON c.current_location_id = l.id WHERE c.id = ?').get(campaignId);
    const results = runEventDefinitions(db, campaignId, {
        trigger: 'manual', eventKey, sceneKey: location?.location_key, targetKey: options.targetKey ?? null,
    });
    if (!results.length) {
        const event = listEventDefinitions(db, campaignId, { trigger: 'manual', scopes: ['world', 'scene'] }).find((entry) => entry.key === eventKey);
        if (!event) throw new NotFoundError(`Manual event '${eventKey}' not found`, 'EVENT_NOT_FOUND');
        return { triggered: false, eventKey, reason: 'Event was already fired, condition failed, or it is not a manual event' };
    }
    return { triggered: true, event: results[0] };
}

export function movePlayer(db, campaignId, targetLocationIdOrKey, options = {}) {
    return withTransaction(db, () => {
        const proposal = proposeMovement(db, campaignId, targetLocationIdOrKey);
        if (!proposal.allowed) throw new ConflictError(proposal.reason, proposal.code, proposal);
        const player = getPlayer(db, campaignId);
        const previousLocationId = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId).current_location_id;
        const target = proposal.target;
        const now = nowIso();
        if (proposal.travelCost > 0) {
            db.prepare('UPDATE entities SET gold = gold - ?, updated_at = ? WHERE id = ?').run(proposal.travelCost, now, player.id);
        }
        db.prepare('UPDATE campaigns SET current_location_id = ?, updated_at = ?, last_played_at = ? WHERE id = ?')
            .run(target.id, now, now, campaignId);
        db.prepare("UPDATE entities SET location_id = ?, updated_at = ? WHERE campaign_id = ? AND (is_player = 1 OR json_extract(data_json, '$.party') = 1)")
            .run(target.id, now, campaignId);
        const wasDiscovered = !target.discovered;
        discoverLocation(db, campaignId, target.id);
        const questResult = updateQuestProgress(db, campaignId, { type: 'visit', targetKey: target.key, amount: 1 });
        const worldEvents = runEventDefinitions(db, campaignId, { trigger: 'enter', sceneKey: target.key });
        // Backward compatibility for packages that kept inline scene actions.
        const legacyApplied = applyStoryActions(db, campaignId, target.data?.events ?? [], { source: 'scene', sceneKey: target.key });
        const story = advanceStory(db, campaignId, { type: 'location.enter', targetKey: target.key });
        insertEvent(db, campaignId, 'player.moved', {
            from: previousLocationId, to: target.id, locationKey: target.key, travelCost: proposal.travelCost, discovered: wasDiscovered,
        });
        return {
            location: getCampaignLocation(db, campaignId),
            discovered: wasDiscovered,
            travelCost: proposal.travelCost,
            questChanges: questResult.changes,
            questEvents: questResult.events,
            worldEvents,
            legacyEventActions: legacyApplied,
            story,
        };
    });
}

export function locationDetail(db, campaignId, locationKey) {
    const location = db.prepare(`
        SELECT l.*, CASE WHEN d.location_id IS NULL THEN 0 ELSE 1 END AS discovered
        FROM locations l JOIN campaigns c ON c.world_id = l.world_id
        LEFT JOIN location_discoveries d ON d.location_id = l.id AND d.campaign_id = ?
        WHERE c.id = ? AND l.location_key = ?
    `).get(campaignId, campaignId, locationKey);
    if (!location) throw new NotFoundError('Location not found', 'LOCATION_NOT_FOUND');
    const npcs = db.prepare(`
        SELECT * FROM entities WHERE campaign_id = ? AND kind = 'npc' AND location_id = ?
    `).all(campaignId, location.id).map((entity) => ({
        id: entity.id,
        name: entity.name,
        key: entity.entity_key.replace(/^npc:/, ''),
        data: parseJson(entity.data_json, {}),
    }));
    const connections = db.prepare(`
        SELECT c.*, t.location_key AS to_key, t.name AS to_name, f.location_key AS from_key, f.name AS from_name
        FROM location_connections c
        JOIN locations f ON f.id = c.from_location_id
        JOIN locations t ON t.id = c.to_location_id
        WHERE c.world_id = ? AND (c.from_location_id = ? OR c.to_location_id = ?)
    `).all(getCampaignWorld(db, campaignId).id, location.id, location.id);
    return { ...locationView(location, campaignId), npcs, connections: connections.map((row) => ({
        from: row.from_key, to: row.to_key, fromName: row.from_name, toName: row.to_name, cost: row.travel_cost,
    })) };
}






