import crypto from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { computeEntityStats, getPlayer } from './stats.js';
import { insertEvent, nowIso, parseJson, uuid, withTransaction } from './util.js';

const RANDOM_KEY = '__random__';

export function sceneSiteType(scene) {
    if (['indoor', 'town', 'wilderness', 'dungeon'].includes(scene?.siteType)) return scene.siteType;
    const type = String(scene?.type ?? '').toLowerCase();
    if (['dungeon', 'crypt', 'ruin', 'ruins'].includes(type) || ['dungeon', 'floor'].includes(scene?.layer)) return 'dungeon';
    if (['town', 'city', 'village', 'settlement'].includes(type) || scene?.layer === 'settlement') return 'town';
    if (['building', 'shop', 'inn', 'temple', 'house'].includes(type) || ['interior', 'room'].includes(scene?.layer)) return 'indoor';
    return 'wilderness';
}

export function randomEncounterAllowed(scene) {
    return ['wilderness', 'dungeon'].includes(sceneSiteType(scene));
}

function locationRow(db, campaignId, locationId) {
    return db.prepare(`
        SELECT l.* FROM locations l JOIN campaigns c ON c.world_id = l.world_id
        WHERE c.id = ? AND l.id = ?
    `).get(campaignId, locationId);
}

function sceneData(location) {
    return parseJson(location?.data_json, {});
}

function spawnRespawnSeconds(encounter, scene) {
    return Math.max(0, Number(encounter.respawnSeconds ?? scene.randomEncounter?.cooldownSeconds ?? 90));
}

export function ensureEncounterSpawns(db, campaignId) {
    const campaign = db.prepare('SELECT world_id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const locations = db.prepare('SELECT * FROM locations WHERE world_id = ?').all(campaign.world_id);
    const now = nowIso();
    for (const location of locations) {
        const scene = sceneData(location);
        for (const encounter of scene.encounters ?? []) {
            db.prepare(`
                INSERT INTO encounter_spawns (id, campaign_id, location_id, encounter_key, status, respawn_at, defeated_at, updated_at)
                VALUES (?, ?, ?, ?, 'available', NULL, NULL, ?)
                ON CONFLICT(campaign_id, location_id, encounter_key) DO NOTHING
            `).run(uuid('spawn_'), campaignId, location.id, encounter.key, now);
        }
        if (scene.randomEncounter?.enabled && randomEncounterAllowed(scene)) {
            db.prepare(`
                INSERT INTO encounter_spawns (id, campaign_id, location_id, encounter_key, status, respawn_at, defeated_at, updated_at)
                VALUES (?, ?, ?, ?, 'available', NULL, NULL, ?)
                ON CONFLICT(campaign_id, location_id, encounter_key) DO NOTHING
            `).run(uuid('spawn_'), campaignId, location.id, RANDOM_KEY, now);
        }
    }
}

export function refreshEncounterSpawns(db, campaignId, locationId = null) {
    const now = nowIso();
    const params = [now, campaignId];
    let sql = "UPDATE encounter_spawns SET status = 'available', respawn_at = NULL, updated_at = ? WHERE campaign_id = ? AND status = 'defeated' AND (respawn_at IS NULL OR respawn_at <= ?)";
    params.push(now);
    if (locationId) {
        sql += ' AND location_id = ?';
        params.push(locationId);
    }
    db.prepare(sql).run(...params);
}

export function encounterState(db, campaignId, locationId) {
    if (!locationId) locationId = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId)?.current_location_id;
    refreshEncounterSpawns(db, campaignId, locationId);
    const location = locationRow(db, campaignId, locationId);
    if (!location) return [];
    const scene = sceneData(location);
    const rows = db.prepare(`
        SELECT * FROM encounter_spawns WHERE campaign_id = ? AND location_id = ?
    `).all(campaignId, locationId);
    const random = scene.randomEncounter;
    const state = rows.filter((row) => row.encounter_key !== RANDOM_KEY || randomEncounterAllowed(scene)).map((row) => {
        const definition = (scene.encounters ?? []).find((entry) => entry.key === row.encounter_key);
        return {
            key: row.encounter_key,
            status: row.status,
            ready: row.status === 'available',
            respawnAt: row.respawn_at,
            defeatedAt: row.defeated_at,
            name: row.encounter_key === RANDOM_KEY ? (random?.name ?? 'Random Encounter') : (definition?.name ?? row.encounter_key),
            random: row.encounter_key === RANDOM_KEY,
            randomEncounter: row.encounter_key === RANDOM_KEY ? random ?? null : null,
        };
    });
    if (random?.enabled && randomEncounterAllowed(scene) && !state.some((entry) => entry.random)) {
        state.push({ key: RANDOM_KEY, status: 'available', ready: true, random: true, randomEncounter: random, name: random.name ?? 'Random Encounter' });
    }
    return state;
}

export function assertEncounterAvailable(db, campaignId, locationId, spawnKey) {
    if (!spawnKey) return null;
    refreshEncounterSpawns(db, campaignId, locationId);
    const row = db.prepare('SELECT * FROM encounter_spawns WHERE campaign_id = ? AND location_id = ? AND encounter_key = ?')
        .get(campaignId, locationId, spawnKey);
    if (row && row.status === 'defeated') {
        throw new ConflictError('This monster group is still respawning', 'ENCOUNTER_RESPAWNING', {
            spawnKey, respawnAt: row.respawn_at,
        });
    }
    return row ?? null;
}

export function markEncounterDefeated(db, campaignId, locationId, spawnKey, respawnSeconds = 90) {
    if (!spawnKey || !locationId) return null;
    const location = locationRow(db, campaignId, locationId);
    const scene = sceneData(location);
    const encounter = (scene.encounters ?? []).find((entry) => entry.key === spawnKey);
    const seconds = Math.max(0, Number(respawnSeconds ?? encounter?.respawnSeconds ?? scene.randomEncounter?.cooldownSeconds ?? 90));
    const respawnAt = new Date(Date.now() + seconds * 1000).toISOString();
    const now = nowIso();
    db.prepare(`
        UPDATE encounter_spawns SET status = 'defeated', defeated_at = ?, respawn_at = ?, updated_at = ?
        WHERE campaign_id = ? AND location_id = ? AND encounter_key = ?
    `).run(now, respawnAt, now, campaignId, locationId, spawnKey);
    insertEvent(db, campaignId, 'encounter.respawn_scheduled', { locationId, spawnKey, respawnAt, seconds });
    return { spawnKey, respawnAt };
}

export function resetEncounterSpawn(db, campaignId, locationId, spawnKey) {
    if (!spawnKey || !locationId) return;
    db.prepare(`
        UPDATE encounter_spawns SET status = 'available', respawn_at = NULL, updated_at = ?
        WHERE campaign_id = ? AND location_id = ? AND encounter_key = ?
    `).run(nowIso(), campaignId, locationId, spawnKey);
}

function roll(count, sides) {
    const dice = [];
    for (let index = 0; index < count; index += 1) dice.push(crypto.randomInt(1, sides + 1));
    return { dice, total: dice.reduce((sum, value) => sum + value, 0) };
}

/**
 * A joint check: the party and the danger both roll the same dice pool, then
 * luck/party size and danger modifiers are added. Higher party result avoids
 * the encounter; lower or equal triggers it.
 */
export function rollJointEncounter(db, campaignId, locationId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const location = locationRow(db, campaignId, locationId ?? campaign.current_location_id);
    if (!location) throw new NotFoundError('Location not found', 'LOCATION_NOT_FOUND');
    const scene = sceneData(location);
    const random = scene.randomEncounter;
    if (!random?.enabled) return { status: 'disabled', locationKey: location.location_key };
    if (!randomEncounterAllowed(scene)) return { status: 'disabled', locationKey: location.location_key, reason: 'site_type' };
    if (!(random.monsters ?? []).length) throw new ValidationError('Random encounter has no monsters');
    refreshEncounterSpawns(db, campaignId, location.id);
    const spawn = db.prepare("SELECT * FROM encounter_spawns WHERE campaign_id = ? AND location_id = ? AND encounter_key = '__random__'")
        .get(campaignId, location.id);
    if (spawn?.status === 'defeated') {
        return { status: 'cooldown', locationKey: location.location_key, respawnAt: spawn.respawn_at };
    }
    const active = db.prepare("SELECT id FROM combat_sessions WHERE campaign_id = ? AND status IN ('pending', 'active')").get(campaignId);
    if (active) return { status: 'combat', combatId: active.id, locationKey: location.location_key };
    if (random.chance < 1 && crypto.randomInt(0, 10000) / 10000 > random.chance) {
        return { status: 'safe', locationKey: location.location_key, reason: 'chance' };
    }
    const player = getPlayer(db, campaignId);
    const partyCount = db.prepare("SELECT COUNT(*) AS count FROM entities WHERE campaign_id = ? AND (is_player = 1 OR (kind = 'npc' AND json_extract(data_json, '$.party') = 1))").get(campaignId).count;
    const sides = Number(random.dice?.sides ?? 6);
    const count = Number(random.dice?.count ?? 2);
    const partyRoll = roll(count, sides);
    const dangerRoll = roll(count, sides);
    const luckBonus = Math.floor(Number(computeEntityStats(db, player.id).stats.luck ?? 0) / 3);
    const partyBonus = Math.max(0, Number(partyCount) - 1);
    const difficulty = Number(random.difficulty ?? 8);
    const partyTotal = partyRoll.total + luckBonus + partyBonus;
    const dangerTotal = dangerRoll.total + difficulty;
    const triggered = partyTotal <= dangerTotal;
    const audit = {
        dice: { count, sides }, party: { dice: partyRoll.dice, luckBonus, partyBonus, total: partyTotal },
        danger: { dice: dangerRoll.dice, difficulty, total: dangerTotal }, triggered,
        locationKey: location.location_key, locationId: location.id,
    };
    insertEvent(db, campaignId, 'encounter.random_roll', audit);
    return { status: triggered ? 'encounter' : 'safe', locationKey: location.location_key, roll: audit };
}

export function randomEncounterData(db, campaignId, locationId) {
    const location = locationRow(db, campaignId, locationId);
    if (!location) return null;
    const scene = sceneData(location);
    const random = scene.randomEncounter;
    return random?.enabled && randomEncounterAllowed(scene) ? random : null;
}

export function tryRandomEncounter(db, campaignId, proposeEncounter, locationId = null) {
    const result = rollJointEncounter(db, campaignId, locationId);
    if (result.status !== 'encounter') return result;
    const random = randomEncounterData(db, campaignId, result.roll.locationId);
    const combat = proposeEncounter(db, campaignId, {
        encounterKey: `random:${result.locationKey}`,
        spawnKey: RANDOM_KEY,
        monsters: random.monsters,
    });
    return { ...result, combat };
}

export { RANDOM_KEY };


