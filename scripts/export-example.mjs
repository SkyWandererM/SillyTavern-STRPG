import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugin/src/db.js';
import { seedExampleProject } from '../plugin/src/seed.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strpg-export-'));
const db = openDatabase({ dataDir: dir });
const seeded = seedExampleProject(db);
const row = db.prepare('SELECT package_json FROM game_versions WHERE id = ?').get(seeded.version.id);
const pkg = JSON.parse(row.package_json);
const out = path.resolve(__dirname, '..', 'examples', 'emberfall.game-package.json');
fs.writeFileSync(out, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`Wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
console.log(JSON.stringify({ version: seeded.version.version, meta: pkg.meta, counts: { locations: pkg.locations.length, npcs: pkg.npcs.length, monsters: pkg.monsters.length, items: pkg.items.length, skills: pkg.skills.length, quests: pkg.quests.length, events: pkg.events.length, storyNodes: pkg.story.nodes.length } }, null, 2));
db.close();
fs.rmSync(dir, { recursive: true, force: true });

