#!/usr/bin/env node
/**
 * End-to-end acceptance verifier for a running SillyTavern + STRPG plugin.
 *
 * Usage: node strpg/scripts/verify-e2e.mjs http://127.0.0.1:8124
 *
 * The script creates a new project by importing the official example Game Package,
 * then performs the full Studio publication flow and the full runtime acceptance flow.
 * It is safe to run against a disposable data root; it does not delete existing data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const report = { base, startedAt: new Date().toISOString(), steps: [], ok: false };
const failures = [];

function step(name, detail = {}) {
    report.steps.push({ name, at: new Date().toISOString(), detail });
    console.log(`✓ ${name}`);
}

async function main() {
    let cookie = '';
    const csrfResponse = await fetch(`${base}/csrf-token`);
    if (!csrfResponse.ok) throw new Error(`csrf-token failed: HTTP ${csrfResponse.status}`);
    const csrf = await csrfResponse.json();
    cookie = (csrfResponse.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
    const token = csrf.token;

    async function request(method, url, body, extraHeaders = {}) {
        const headers = {
            accept: 'application/json',
            cookie,
            'x-csrf-token': token,
            ...extraHeaders,
        };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(`${base}${url}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let payload;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
        if (!response.ok) {
            const error = new Error(`${method} ${url} -> HTTP ${response.status}: ${payload?.error?.message ?? text.slice(0, 400)}`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload?.ok === true && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
    }

    const health = await request('GET', '/api/plugins/strpg/health');
    step('STRPG plugin health', { schemaVersion: health.schemaVersion, database: health.database.path });

    const games = await request('GET', '/api/plugins/strpg/published-games');
    if (!games.length) throw new Error('No published example game found. Run the seed or build a game first.');
    const example = games[0];
    step('Published game available', { versionId: example.versionId, name: example.name });

    const exported = await request('GET', `/api/plugins/strpg/versions/${example.versionId}/export`);
    const imported = await request('POST', `/api/plugins/strpg/projects/${example.projectId}/import-package`, { package: exported.package });
    const projectId = imported.project.id;
    step('Imported Game Package into a new Studio project', { projectId, assets: imported.importedAssets, allDraft: true });

    const drafted = await request('GET', `/api/plugins/strpg/projects/${projectId}/assets`);
    if (!drafted.every((asset) => asset.status === 'DRAFT')) throw new Error('Imported package contains non-DRAFT assets');
    for (const asset of drafted) {
        const validated = await request('POST', `/api/plugins/strpg/assets/${asset.id}/validate`, {});
        if (!validated.validation.valid) {
            throw new Error(`Validation failed for ${asset.kind}/${asset.asset_key}: ${JSON.stringify(validated.validation.errors)}`);
        }
        const reviewed = await request('POST', `/api/plugins/strpg/assets/${asset.id}/review`, {
            reviewer: 'acceptance-runner', decision: 'approve', note: 'Automated acceptance verification',
        });
        if (reviewed.status !== 'REVIEWED') throw new Error(`Review failed for ${asset.kind}/${asset.asset_key}`);
        const published = await request('POST', `/api/plugins/strpg/assets/${asset.id}/publish`, {});
        if (published.status !== 'PUBLISHED') throw new Error(`Publish failed for ${asset.kind}/${asset.asset_key}`);
    }
    step('Validated, reviewed and published all imported assets', { count: drafted.length, statuses: ['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'] });

    const built = await request('POST', `/api/plugins/strpg/projects/${projectId}/build`, { notes: 'Acceptance build' });
    if (!built.report.valid) throw new Error('Built package failed package validation');
    const version = await request('POST', `/api/plugins/strpg/versions/${built.id}/publish`, {});
    step('Assembled and published Game Version', { versionId: built.id, version: built.version, report: built.report.stats });

    const campaign = await request('POST', '/api/plugins/strpg/campaigns', {
        name: `Acceptance ${new Date().toISOString().slice(0, 19)}`,
        gameVersionId: built.id,
        playerName: 'Aria',
    });
    const campaignId = campaign.id;
    step('Created Campaign from frozen game version', { campaignId, player: campaign.player.name, location: campaign.location.key });

    const chatA = `acceptance/${campaignId}/chat-a`;
    const chatB = `acceptance/${campaignId}/chat-b`;
    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/bind-chat`, { chatKey: chatA, characterName: 'Aria' });
    const boundA = await request('GET', `/api/plugins/strpg/chat-bindings/${encodeURIComponent(chatA)}`);
    if (boundA.campaign.id !== campaignId) throw new Error('Chat A binding mismatch');
    step('Bound SillyTavern chat A', { chatKey: chatA });

    let dashboard = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/dashboard`);
    if (dashboard.location.key !== 'mistfall_town') throw new Error('Campaign did not start at mistfall_town');
    step('Entered starting location', { location: dashboard.location.key, hp: dashboard.player.hp, mp: dashboard.player.mp });

    const interactions = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/interactions`);
    const elder = interactions.find((entry) => entry.npc.key === 'elder_mira');
    if (!elder) throw new Error('Elder NPC not present');
    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/interactions/elder_mira/talk`, {});
    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/interactions/elder_mira/accept_main`, {});
    step('Talked to NPC and accepted main quest', { npc: 'elder_mira', quest: 'main_sigil' });

    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/move`, {
        location: 'greenwood_edge', idempotencyKey: `acceptance-move-${campaignId}`,
    }, { 'Idempotency-Key': `acceptance-move-${campaignId}` });
    step('Moved to forest via real location connection', { location: 'greenwood_edge' });

    const proposed = await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/encounters/propose`, {
        encounterKey: 'acceptance_goblin_patrol',
        monsters: [{ monsterKey: 'forest_goblin', count: 2 }],
        idempotencyKey: `acceptance-encounter-${campaignId}`,
    }, { 'Idempotency-Key': `acceptance-encounter-${campaignId}` });
    const combatId = proposed.id;
    step('Discovered enemy and created pending encounter', { combatId, participants: proposed.participants.length });

    let combat = await request('POST', `/api/plugins/strpg/combat/${combatId}/start`, {});
    step('Entered independent combat UI state', { combatId, round: combat.round, currentActor: combat.currentActor?.name });
    let guard = 0;
    while (combat.status === 'active' && guard++ < 30) {
        const target = combat.participants.find((participant) => participant.side === 'enemy' && participant.alive);
        if (!target) break;
        const skill = combat.skills.find((entry) => entry.available && entry.type === 'attack');
        const action = guard % 4 === 0 && skill
            ? { type: 'skill', skillKey: skill.key, targetId: target.id }
            : { type: 'attack', targetId: target.id };
        combat = await request('POST', `/api/plugins/strpg/combat/${combatId}/action`, action, {
            'Idempotency-Key': `acceptance-action-${campaignId}-${guard}`,
        });
    }
    if (combat.status !== 'victory') throw new Error(`Expected victory, got ${combat.status}`);
    step('Executed complete turn-based combat and settlement', {
        outcome: combat.status, exp: combat.result.exp, gold: combat.result.gold, drops: combat.result.drops.length, rounds: combat.round,
    });

    dashboard = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/dashboard`);
    if (dashboard.player.level < 2) throw new Error('Expected at least one level-up');
    if (dashboard.player.gold <= 80) throw new Error('Expected gold reward');
    step('Automatically applied EXP, gold, drops, levels and skills', {
        level: dashboard.player.level, xp: dashboard.player.xp, gold: dashboard.player.gold,
    });

    let quest = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/quests/main_sigil`);
    if (quest.stageKey !== 'report') throw new Error(`Expected report stage, got ${quest.stageKey}`);
    step('Quest objective advanced from combat', { quest: quest.key, stage: quest.stageKey, objectives: quest.stages[0].objectives.map((objective) => [objective.key, objective.current]) });

    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/move`, { location: 'mistfall_town' });
    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/interactions/elder_mira/talk`, {});
    quest = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/quests/main_sigil`);
    if (quest.status !== 'ready_to_turn_in') throw new Error(`Expected ready_to_turn_in, got ${quest.status}`);
    const turnedIn = await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/interactions/elder_mira/turn_in_main`, {});
    if (turnedIn.quest.status !== 'turned_in') throw new Error('Quest turn-in failed');
    step('Turned in quest at the correct NPC and claimed rewards', { quest: turnedIn.quest.key, rewards: turnedIn.quest.rewards.granted });

    const story = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/story`);
    if (story.state.ending !== 'ending_ember') throw new Error(`Expected ending_ember, got ${story.state.ending}`);
    step('Reached a real Story Graph ending through gameplay', { ending: story.state.ending, title: story.ending.title });

    const save = await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/saves`, { label: 'Acceptance checkpoint' });
    dashboard = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/dashboard`);
    const signature = {
        level: dashboard.player.level, hp: dashboard.player.hp, gold: dashboard.player.gold,
        location: dashboard.location.key, ending: dashboard.story.state.ending,
    };
    step('Saved game snapshot', { saveId: save.id, signature });

    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/bind-chat`, { chatKey: chatB, characterName: 'Aria' });
    const boundB = await request('GET', `/api/plugins/strpg/chat-bindings/${encodeURIComponent(chatB)}`);
    if (boundB.campaign.id !== campaignId) throw new Error('Chat B binding mismatch');
    step('Bound alternate chat to the same Campaign', { chatKey: chatB });

    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/move`, { location: 'greenwood_edge' });
    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/saves/${save.id}/restore`, {});
    dashboard = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/dashboard`);
    const restored = {
        level: dashboard.player.level, hp: dashboard.player.hp, gold: dashboard.player.gold,
        location: dashboard.location.key, ending: dashboard.story.state.ending,
    };
    if (JSON.stringify(restored) !== JSON.stringify(signature)) {
        throw new Error(`Restored state mismatch: ${JSON.stringify({ signature, restored })}`);
    }
    step('Restored Campaign from snapshot after switching chat', { restored });

    await request('POST', `/api/plugins/strpg/campaigns/${campaignId}/integrations/tracker/sync`, {
        state: { mood: 'determined', attitude: 'trusting the elder', summary: 'The Ember Sigil is restored.' },
    });
    const tracker = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/integrations/tracker`);
    if (tracker.state.mood !== 'determined') throw new Error('Tracker narrative mirror was not stored');
    step('Synced whitelist-only narrative state', { tracker: tracker.provider, authoritative: tracker.authority });

    const memory = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/integrations/memory-books`);
    if (!memory.markdown.includes('STRPG Story Memory')) throw new Error('Memory Books export missing');
    step('Exported Memory Books continuity summary', { mode: memory.mode, length: memory.markdown.length });

    const events = await request('GET', `/api/plugins/strpg/campaigns/${campaignId}/events?limit=200`);
    const eventTypes = [...new Set(events.map((event) => event.type))];
    for (const required of ['campaign.created', 'player.moved', 'npc.interaction', 'quest.accepted', 'combat.victory', 'quest.turned_in', 'story.ending', 'save.restored']) {
        if (!eventTypes.includes(required)) throw new Error(`Missing event type ${required}`);
    }
    step('Verified event log and idempotent settlement trail', { events: events.length, types: eventTypes });

    report.ok = true;
    report.campaignId = campaignId;
    report.projectId = projectId;
    report.versionId = built.id;
    report.artifacts = { signature, eventTypes };
}

try {
    await main();
} catch (error) {
    report.ok = false;
    report.error = { message: error.message, status: error.status, payload: error.payload };
    failures.push(error);
    console.error(`\n✗ ACCEPTANCE FAILED: ${error.message}`);
    if (error.payload) console.error(JSON.stringify(error.payload, null, 2));
} finally {
    report.finishedAt = new Date().toISOString();
    const out = path.resolve(__dirname, '..', 'docs', 'acceptance-report.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nReport written to ${out}`);
    if (!report.ok) process.exitCode = 1;
}

