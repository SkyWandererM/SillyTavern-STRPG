#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseInfo, defaultDataDir, openDatabase, verifySchema } from '../src/db.js';
import { createBackup } from '../src/backups.js';
import { seedExampleProject } from '../src/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const command = process.argv[2] ?? 'help';

function usage() {
    console.log(`STRPG CLI

Usage: node plugins/strpg/bin/strpg-cli.js <command> [options]

Commands:
  migrate              Apply pending database migrations (also runs on plugin start)
  seed [--force]       Seed/refresh the official example game
  backup [label]       Create a logical JSON backup under data/strpg/backups
  verify               Verify schema tables and SQLite integrity
  info                 Print database location and counts
  help                 Show this help

Environment:
  STRPG_DATA_DIR       Override the data directory (default: <ST>/data/strpg)
`);
}

const dataDir = defaultDataDir(pluginRoot);
let db;
try {
    db = openDatabase({ dataDir });
    if (command === 'help' || command === '--help' || command === '-h') {
        usage();
    } else if (command === 'migrate') {
        console.log(JSON.stringify({ ok: true, database: databaseInfo(db), integrity: verifySchema(db) }, null, 2));
    } else if (command === 'seed') {
        const result = seedExampleProject(db, { force: process.argv.includes('--force') });
        console.log(JSON.stringify({ ok: true, projectId: result.projectId, version: result.version, summary: result.summary }, null, 2));
    } else if (command === 'backup') {
        const result = createBackup(db, process.argv[3] ?? 'CLI backup');
        console.log(JSON.stringify({ ok: true, backup: result }, null, 2));
    } else if (command === 'verify') {
        console.log(JSON.stringify({ ok: true, integrity: verifySchema(db), database: databaseInfo(db) }, null, 2));
    } else if (command === 'info') {
        console.log(JSON.stringify({
            database: databaseInfo(db),
            projects: db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count,
            versions: db.prepare('SELECT COUNT(*) AS count FROM game_versions').get().count,
            campaigns: db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count,
            events: db.prepare('SELECT COUNT(*) AS count FROM game_events').get().count,
        }, null, 2));
    } else {
        console.error(`Unknown command: ${command}`);
        usage();
        process.exitCode = 2;
    }
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    db?.close();
}
