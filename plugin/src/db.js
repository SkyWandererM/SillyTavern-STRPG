import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION, REQUIRED_TABLES } from './schema.js';
import { nowIso, parseJson, withTransaction } from './util.js';

/** Future schema upgrades are appended here. Never edit an applied migration. */
export const MIGRATIONS = [
    {
        version: 1,
        name: 'initial-strpg-schema',
        up(db) {
            db.exec(SCHEMA_SQL);
        },
    },
    {
        version: 3,
        name: 'layered-world-and-encounter-spawns',
        up(db) {
            const columns = (table) => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
            const locations = columns('locations');
            if (!locations.has('layer')) db.exec("ALTER TABLE locations ADD COLUMN layer TEXT NOT NULL DEFAULT 'region'");
            if (!locations.has('parent_key')) db.exec('ALTER TABLE locations ADD COLUMN parent_key TEXT');
            if (!locations.has('spawn_points_json')) db.exec("ALTER TABLE locations ADD COLUMN spawn_points_json TEXT NOT NULL DEFAULT '[]'");
            const connections = columns('location_connections');
            if (!connections.has('mode')) db.exec("ALTER TABLE location_connections ADD COLUMN mode TEXT NOT NULL DEFAULT 'walk'");
            if (!connections.has('entry_key')) db.exec('ALTER TABLE location_connections ADD COLUMN entry_key TEXT');
            db.exec(`
                CREATE TABLE IF NOT EXISTS encounter_spawns (
                    id TEXT PRIMARY KEY,
                    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
                    encounter_key TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'available',
                    respawn_at TEXT,
                    defeated_at TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE (campaign_id, location_id, encounter_key)
                );
                CREATE INDEX IF NOT EXISTS idx_spawns_location ON encounter_spawns(campaign_id, location_id, status);
            `);
        },
    },
    {
        version: 2,
        name: 'separate-world-scene-events',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS event_definitions (
                    id TEXT PRIMARY KEY,
                    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
                    event_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    scope TEXT NOT NULL DEFAULT 'scene',
                    scene_key TEXT,
                    trigger TEXT NOT NULL DEFAULT 'enter',
                    target_key TEXT,
                    priority INTEGER NOT NULL DEFAULT 0,
                    once INTEGER NOT NULL DEFAULT 1,
                    condition_json TEXT NOT NULL DEFAULT '{}',
                    actions_json TEXT NOT NULL DEFAULT '[]',
                    data_json TEXT NOT NULL,
                    UNIQUE (game_version_id, event_key)
                );
                CREATE INDEX IF NOT EXISTS idx_events_version ON event_definitions(game_version_id, scope, trigger);
            `);
        },
    },
    {
        version: 4,
        name: 'bridge-candidates-and-apply-log',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS bridge_candidates (
                    id TEXT PRIMARY KEY,
                    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'manual',
                    payload_json TEXT NOT NULL,
                    evidence_json TEXT NOT NULL DEFAULT '{}',
                    confidence REAL,
                    dedupe_hash TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'PENDING',
                    created_at TEXT NOT NULL,
                    reviewed_at TEXT,
                    applied_at TEXT,
                    note TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_candidates_dedupe
                    ON bridge_candidates(campaign_id, dedupe_hash) WHERE status = 'PENDING';
                CREATE INDEX IF NOT EXISTS idx_bridge_candidates_queue
                    ON bridge_candidates(campaign_id, status, created_at);
                CREATE TABLE IF NOT EXISTS bridge_apply_log (
                    id TEXT PRIMARY KEY,
                    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                    candidate_id TEXT,
                    target TEXT NOT NULL,
                    before_json TEXT,
                    after_json TEXT,
                    applied_by TEXT NOT NULL DEFAULT 'server',
                    applied_at TEXT NOT NULL,
                    undone_at TEXT
                );
            `);
        },
    },
    {
        version: 5,
        name: 'memory-scopes',
        up(db) {
            const columns = new Set(db.prepare('PRAGMA table_info("bridge_candidates")').all().map((row) => row.name));
            if (!columns.has('scope_key')) db.exec('ALTER TABLE bridge_candidates ADD COLUMN scope_key TEXT');
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_scopes (
                    id TEXT PRIMARY KEY,
                    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                    scope_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    last_run_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (campaign_id, scope_key)
                );
                CREATE INDEX IF NOT EXISTS idx_scopes_campaign ON memory_scopes(campaign_id, enabled);
                CREATE INDEX IF NOT EXISTS idx_candidates_scope ON bridge_candidates(campaign_id, scope_key, status);
            `);
        },
    },
];

export function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

/**
 * Locate the SillyTavern root above a plugin directory. The plugin ships in two
 * shapes: <ST>/plugins/strpg (classic) and <ST>/data/<user>/extensions/strpg/plugin
 * (when installed together with the STRPG extension), so walk up instead of
 * assuming a fixed depth.
 * @param {string} start Directory to start from
 * @returns {string|null} SillyTavern root, or null when it cannot be found
 */
export function findSillyTavernRoot(start) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 12; depth += 1) {
        if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'config.yaml'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

export function defaultDataDir(pluginRoot) {
    if (process.env.STRPG_DATA_DIR) return path.resolve(process.env.STRPG_DATA_DIR);
    const stRoot = findSillyTavernRoot(pluginRoot);
    if (stRoot) return path.join(stRoot, 'data', 'strpg');
    // No SillyTavern root above the plugin: keep the classic plugins/strpg assumption.
    return path.resolve(pluginRoot, '..', '..', 'data', 'strpg');
}

export function openDatabase(options = {}) {
    const dataDir = ensureDir(options.dataDir ?? path.resolve(process.cwd(), 'data', 'strpg'));
    const databasePath = options.databasePath ?? path.join(dataDir, 'strpg.sqlite');
    ensureDir(path.dirname(databasePath));
    const db = new DatabaseSync(databasePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
    db.__strpg = { dataDir, databasePath };
    return db;
}

export function migrate(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
    `);
    const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get();
    const current = Number(row?.version ?? 0);
    const pending = MIGRATIONS.filter((migration) => migration.version > current)
        .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
        withTransaction(db, () => {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
                .run(migration.version, migration.name, nowIso());
        });
    }

    const latest = Math.max(0, ...MIGRATIONS.map((migration) => migration.version));
    db.exec(`PRAGMA user_version = ${latest}`);
    verifySchema(db);
    return { from: current, to: latest, applied: pending.map((m) => m.version) };
}

export function verifySchema(db) {
    const missing = REQUIRED_TABLES.filter((table) => {
        return !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    });
    if (missing.length) {
        throw new Error(`STRPG database is missing tables: ${missing.join(', ')}`);
    }
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity && Object.values(integrity)[0] !== 'ok') {
        throw new Error(`STRPG database integrity check failed: ${JSON.stringify(integrity)}`);
    }
    return { ok: true, schemaVersion: SCHEMA_VERSION, tables: REQUIRED_TABLES.length };
}

export function databaseInfo(db) {
    return {
        path: db.__strpg?.databasePath ?? null,
        dataDir: db.__strpg?.dataDir ?? null,
        schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version ?? 0),
        sizeBytes: (() => {
            try {
                return ['', '-wal', '-shm'].reduce((total, suffix) => {
                    try {
                        return total + fs.statSync(`${db.__strpg.databasePath}${suffix}`).size;
                    } catch {
                        return total;
                    }
                }, 0);
            } catch {
                return null;
            }
        })(),
    };
}

const BACKUP_EXCLUDED_TABLES = new Set(['schema_migrations']);

export function exportDatabaseJson(db) {
    const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map((row) => row.name);
    const data = {};
    for (const table of tables) {
        data[table] = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
    }
    return {
        format: 'strpg.database-backup',
        formatVersion: 1,
        schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version ?? 0),
        createdAt: nowIso(),
        tables: data,
    };
}

export function importDatabaseJson(db, backup, options = {}) {
    if (!backup || backup.format !== 'strpg.database-backup' || !backup.tables) {
        throw new Error('Not a valid STRPG database backup');
    }
    if (Number(backup.schemaVersion) > SCHEMA_VERSION) {
        throw new Error('Backup was created by a newer STRPG schema');
    }
    const allowed = new Set(db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name));
    return withTransaction(db, () => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const table of [...allowed].reverse()) {
            if (BACKUP_EXCLUDED_TABLES.has(table)) continue;
            if (!(table in backup.tables)) continue;
            db.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
        }
        for (const [table, rows] of Object.entries(backup.tables)) {
            if (!allowed.has(table) || BACKUP_EXCLUDED_TABLES.has(table)) continue;
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
                const columns = Object.keys(row);
                if (!columns.length) continue;
                const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`);
                db.prepare(
                    `INSERT INTO "${table.replaceAll('"', '""')}" (${quoted.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                ).run(...columns.map((column) => normalizeSqliteValue(row[column])));
            }
        }
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) {
            throw new Error(`Restored backup has ${violations.length} foreign-key violation(s)`);
        }
        return { ok: true, restoredAt: nowIso(), tables: Object.keys(backup.tables).length };
    });
}

function normalizeSqliteValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

export function readSetting(db, key, fallback = null) {
    const row = db.prepare('SELECT value_json FROM app_settings WHERE setting_key = ?').get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
}

export function writeSetting(db, key, value) {
    db.prepare(`
        INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value ?? null), nowIso());
    return value;
}
