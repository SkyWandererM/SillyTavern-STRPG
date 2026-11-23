import crypto from 'node:crypto';
import { ConflictError } from './errors.js';

export const nowIso = () => new Date().toISOString();
export const uuid = (prefix = '') => `${prefix}${crypto.randomUUID()}`;
export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function parseJson(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function asJson(value) {
    return JSON.stringify(value ?? null);
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashObject(value) {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function deepMerge(base, patch) {
    if (Array.isArray(base) || Array.isArray(patch)) return clone(patch ?? base);
    if (typeof base !== 'object' || base === null) return clone(patch ?? base);
    if (typeof patch !== 'object' || patch === null) return clone(patch ?? base);
    const output = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        output[key] = key in base ? deepMerge(base[key], value) : clone(value);
    }
    return output;
}

const txState = new WeakMap();

/**
 * Run a synchronous callback in a SQLite transaction. Nested calls use savepoints.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
    let state = txState.get(db);
    if (!state) {
        state = { depth: 0, savepoint: 0 };
        txState.set(db, state);
    }

    if (state.depth > 0) {
        const name = `strpg_sp_${++state.savepoint}`;
        db.exec(`SAVEPOINT ${name}`);
        state.depth += 1;
        try {
            const result = fn();
            db.exec(`RELEASE SAVEPOINT ${name}`);
            return result;
        } catch (error) {
            db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
            db.exec(`RELEASE SAVEPOINT ${name}`);
            throw error;
        } finally {
            state.depth -= 1;
        }
    }

    db.exec('BEGIN IMMEDIATE');
    state.depth = 1;
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Ignore rollback errors, preserve the original failure.
        }
        throw error;
    } finally {
        state.depth = 0;
        state.savepoint = 0;
    }
}

export function getOrThrow(db, sql, params, message, code = 'NOT_FOUND') {
    const row = db.prepare(sql).get(...params);
    if (!row) {
        const error = new Error(message);
        error.status = 404;
        error.code = code;
        throw error;
    }
    return row;
}

export function insertEvent(db, campaignId, type, payload = {}, idempotencyKey = null) {
    if (!campaignId) return null;
    if (idempotencyKey) {
        const existing = db.prepare(
            'SELECT * FROM game_events WHERE campaign_id = ? AND idempotency_key = ?',
        ).get(campaignId, idempotencyKey);
        if (existing) return existing;
    }
    const next = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM game_events WHERE campaign_id = ?',
    ).get(campaignId);
    const id = uuid('evt_');
    db.prepare(`
        INSERT INTO game_events (id, campaign_id, seq, type, payload_json, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, campaignId, next.seq, type, asJson(payload), idempotencyKey, nowIso());
    return { id, campaign_id: campaignId, seq: next.seq, type, payload_json: asJson(payload) };
}

/**
 * Execute an operation at most once for the supplied idempotency key.
 * The result is stored as JSON and replayed for repeated requests.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ key?: string|null, scope: string, request?: any, statusCode?: number }} options
 * @param {() => T} fn
 * @returns {T}
 */
export function idempotent(db, options, fn) {
    const { key, scope, request = null, statusCode = 200 } = options;
    if (!key) return fn();
    if (typeof key !== 'string' || key.length < 3 || key.length > 200) {
        throw new ConflictError('Idempotency key must be between 3 and 200 characters', 'BAD_IDEMPOTENCY_KEY');
    }
    const requestHash = hashObject(request);
    return withTransaction(db, () => {
        const existing = db.prepare('SELECT * FROM api_idempotency WHERE key = ?').get(key);
        if (existing) {
            if (existing.scope !== scope || existing.request_hash !== requestHash) {
                throw new ConflictError(
                    'This idempotency key was already used for a different request',
                    'IDEMPOTENCY_MISMATCH',
                );
            }
            return parseJson(existing.response_json, null);
        }
        const result = fn();
        db.prepare(`
            INSERT INTO api_idempotency (key, scope, request_hash, response_json, status_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(key, scope, requestHash, asJson(result), statusCode, nowIso());
        return result;
    });
}

export function chunk(array, size) {
    const output = [];
    for (let index = 0; index < array.length; index += size) output.push(array.slice(index, index + size));
    return output;
}

export function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function pick(object, keys) {
    const output = {};
    for (const key of keys) {
        if (object && Object.prototype.hasOwnProperty.call(object, key)) output[key] = object[key];
    }
    return output;
}
