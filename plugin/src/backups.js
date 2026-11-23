import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './errors.js';
import { databaseInfo, exportDatabaseJson, importDatabaseJson } from './db.js';
import { nowIso } from './util.js';

function backupDir(db) {
    const dataDir = db.__strpg?.dataDir ?? path.resolve(process.cwd(), 'data', 'strpg');
    const directory = path.join(dataDir, 'backups');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

export function createBackup(db, label = '') {
    const directory = backupDir(db);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `strpg-${stamp}.json`;
    const filePath = path.join(directory, name);
    const payload = exportDatabaseJson(db);
    payload.label = label;
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    return {
        name,
        label,
        sizeBytes: fs.statSync(filePath).size,
        createdAt: payload.createdAt,
        schemaVersion: payload.schemaVersion,
        database: databaseInfo(db),
    };
}

export function listBackups(db) {
    return fs.readdirSync(backupDir(db))
        .filter((name) => /^strpg-[A-Za-z0-9_.-]+\.json$/.test(name))
        .map((name) => {
            const filePath = path.join(backupDir(db), name);
            const stat = fs.statSync(filePath);
            return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readBackup(db, name) {
    if (!/^strpg-[A-Za-z0-9_.-]+\.json$/.test(name)) throw new ValidationError('Invalid backup name');
    const directory = backupDir(db);
    const filePath = path.resolve(directory, name);
    if (!filePath.startsWith(path.resolve(directory) + path.sep)) throw new ValidationError('Invalid backup path');
    if (!fs.existsSync(filePath)) throw new ValidationError('Backup does not exist');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function restoreBackup(db, name) {
    const payload = readBackup(db, name);
    const result = importDatabaseJson(db, payload);
    return {
        ...result,
        name,
        restoredAt: nowIso(),
        note: 'Restore is transactional. Restart SillyTavern if the browser still shows stale data.',
    };
}

export function deleteBackup(db, name) {
    if (!/^strpg-[A-Za-z0-9_.-]+\.json$/.test(name)) throw new ValidationError('Invalid backup name');
    const filePath = path.join(backupDir(db), name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, name };
}
