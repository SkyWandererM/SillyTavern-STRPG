import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../plugin/src/db.js';
import { seedExampleProject } from '../plugin/src/seed.js';
import { createRouter } from '../plugin/src/app.js';

export function makeTestApp(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strpg-test-'));
    const db = openDatabase({ dataDir: dir });
    const seeded = options.seed === false ? null : seedExampleProject(db);
    const app = express().use('/api/plugins/strpg', createRouter(db));
    const api = request(app);
    return {
        dir,
        db,
        seeded,
        api,
        async close() {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

export function body(response) {
    if (response.body?.ok && response.body.data !== undefined) return response.body.data;
    return response.body;
}

export async function createCampaign(api, versionId, name = 'Test Campaign') {
    const response = await api.post('/api/plugins/strpg/campaigns').send({
        name,
        gameVersionId: versionId,
        playerName: 'Aria',
    });
    if (response.status !== 201) throw new Error(`Campaign create failed: ${JSON.stringify(response.body)}`);
    return body(response);
}

export async function move(api, campaignId, location) {
    const response = await api.post(`/api/plugins/strpg/campaigns/${campaignId}/move`).send({ location });
    if (response.status !== 200) throw new Error(`Move failed: ${JSON.stringify(response.body)}`);
    return body(response);
}

export async function fightUntilOver(api, campaignId, combatId, maxActions = 30) {
    let response = await api.post(`/api/plugins/strpg/combat/${combatId}/start`).send({});
    if (response.status !== 200) throw new Error(`Combat start failed: ${JSON.stringify(response.body)}`);
    let guard = 0;
    while (body(response).status === 'active' && guard < maxActions) {
        guard += 1;
        const combat = body(response);
        const target = combat.participants.find((participant) => participant.side === 'enemy' && participant.alive);
        if (!target) break;
        response = await api.post(`/api/plugins/strpg/combat/${combatId}/action`)
            .set('Idempotency-Key', `test-${combatId}-${guard}`)
            .send({ type: 'attack', targetId: target.id });
        if (response.status !== 200) throw new Error(`Combat action failed: ${JSON.stringify(response.body)}`);
    }
    return body(response);
}
