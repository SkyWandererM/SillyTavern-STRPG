import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from './src/app.js';
import { defaultDataDir, openDatabase } from './src/db.js';
import { seedExampleProject, EXAMPLE_PROJECT_ID } from './src/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'strpg',
    name: 'STRPG — SillyTavern RPG Framework',
    description: 'JRPG engine, turn-based combat, maps, quests, saves and a content production Studio for SillyTavern.',
};

let db = null;

export async function init(router) {
    const dataDir = defaultDataDir(__dirname);
    db = openDatabase({ dataDir });
    const projectCount = db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count;
    if (projectCount === 0 && process.env.STRPG_AUTO_SEED !== 'false') {
        try {
            const seeded = seedExampleProject(db);
            console.log(`[STRPG] Seeded example game '${EXAMPLE_PROJECT_ID}' (${seeded.created ? 'created' : 'already present'}).`);
        } catch (error) {
            console.error('[STRPG] Example seed failed; the API will still start.', error);
        }
    }
    router.use(createRouter(db));
    console.log(`[STRPG] Database ready at ${db.__strpg.databasePath}`);
}

export function exit() {
    if (db) {
        try {
            db.close();
        } catch {
            // ignore close errors during shutdown
        }
        db = null;
    }
}
