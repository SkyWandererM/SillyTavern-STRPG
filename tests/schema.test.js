import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';
import { verifySchema } from '../plugin/src/db.js';
import { validateGamePackage } from '../plugin/src/validation.js';

describe('database and seed', () => {
    it('creates every required table and passes SQLite integrity check', async () => {
        const app = makeTestApp({ seed: false });
        try {
            const report = verifySchema(app.db);
            expect(report.ok).toBe(true);
            expect(report.tables).toBeGreaterThan(30);
            expect(app.db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('seeds a valid example game and publishes it', async () => {
        const app = makeTestApp();
        try {
            const version = app.seeded.version;
            expect(version.status).toBe('published');
            const pkg = JSON.parse(app.db.prepare('SELECT package_json FROM game_versions WHERE id = ?').get(version.id).package_json);
            expect(pkg.locations.length).toBeGreaterThanOrEqual(4);
            expect(pkg.npcs.length).toBeGreaterThanOrEqual(3);
            expect(pkg.monsters.length).toBeGreaterThanOrEqual(2);
            expect(pkg.items.length).toBeGreaterThanOrEqual(5);
            expect(pkg.skills.length).toBeGreaterThanOrEqual(5);
            expect(pkg.quests.length).toBeGreaterThanOrEqual(3);
            expect(pkg.story.endings.length).toBeGreaterThanOrEqual(1);
            expect(pkg.events.length).toBeGreaterThanOrEqual(1);
            expect(pkg.locations.find((location) => location.key === 'old_shrine').eventKeys).toContain('shrine_discovery');
            const report = validateGamePackage(pkg);
            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it('is idempotent when the seed is run twice', async () => {
        const app = makeTestApp();
        try {
            const second = await import('../plugin/src/seed.js').then((module) => module.seedExampleProject(app.db));
            expect(second.created).toBe(false);
            expect(app.db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count).toBe(1);
        } finally {
            await app.close();
        }
    });
});
