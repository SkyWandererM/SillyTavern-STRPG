import { ConflictError, NotFoundError } from './errors.js';
import { evaluateCondition, getCampaignVariable } from './conditions.js';
import { acceptQuest } from './quests.js';
import { addItem, removeItem } from './inventory.js';
import { addExperience, getPlayer, healEntity, unlockSkill } from './stats.js';
import { getCampaignPackage } from './stats.js';
import { clamp, hashObject, insertEvent, nowIso, parseJson, uuid, withTransaction } from './util.js';

function queueMemoryCandidate(db, campaignId, text, npcKey = null) {
    const payload = { npcKey, fields: { summary: String(text ?? '').slice(0, 2000) } };
    if (!payload.fields.summary) return null;
    const hash = hashObject({ kind: 'narrative', payload });
    const existing = db.prepare("SELECT id FROM bridge_candidates WHERE campaign_id = ? AND dedupe_hash = ? AND status = 'PENDING'")
        .get(campaignId, hash);
    if (existing) return existing.id;
    const id = uuid('cand_');
    db.prepare(`
        INSERT INTO bridge_candidates (id, campaign_id, kind, source, payload_json, evidence_json, confidence, dedupe_hash, status, created_at, note)
        VALUES (?, ?, 'narrative', 'event', ?, '{}', NULL, ?, 'PENDING', ?, '')
    `).run(id, campaignId, JSON.stringify(payload), hash, nowIso());
    return id;
}

function queuePerformanceCandidate(db, campaignId, payload) {
    const text = String(payload.text ?? '').trim();
    if (!text) return null;
    const body = { npcKey: payload.npcKey ?? null, npcName: payload.npcName ?? null, text: text.slice(0, 4000), lines: payload.lines ?? [] };
    const hash = hashObject({ kind: 'performance', payload: body });
    const existing = db.prepare("SELECT id FROM bridge_candidates WHERE campaign_id = ? AND dedupe_hash = ? AND status = 'PENDING'")
        .get(campaignId, hash);
    if (existing) return existing.id;
    const id = uuid('cand_');
    db.prepare(`
        INSERT INTO bridge_candidates (id, campaign_id, kind, source, payload_json, evidence_json, confidence, dedupe_hash, status, created_at, note)
        VALUES (?, ?, 'performance', 'event', ?, '{}', NULL, ?, 'PENDING', ?, '')
    `).run(id, campaignId, JSON.stringify(body), hash, nowIso());
    return id;
}

export function getStory(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    if (!pkg?.story) throw new NotFoundError('Campaign game package has no story', 'STORY_MISSING');
    return pkg.story;
}

export function ensureStoryState(campaignId, db, story) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const gameState = parseJson(campaign.game_state_json, {});
    if (!gameState.story) {
        gameState.story = {
            currentNodeKey: story.startNodeKey,
            visited: [],
            variables: story.variables ?? {},
            ending: null,
            enteredAt: nowIso(),
        };
    }
    db.prepare('UPDATE campaigns SET game_state_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(gameState), nowIso(), campaignId);
    return gameState.story;
}

export function getStoryState(campaignId, db) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const gameState = parseJson(campaign.game_state_json, {});
    return gameState.story ?? null;
}

export function saveStoryState(db, campaignId, storyState) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const gameState = parseJson(campaign.game_state_json, {});
    gameState.story = storyState;
    gameState.flags = gameState.flags ?? [];
    db.prepare('UPDATE campaigns SET game_state_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(gameState), nowIso(), campaignId);
}

function addFlag(db, campaignId, flag) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const gameState = parseJson(campaign.game_state_json, {});
    gameState.flags = [...new Set([...(gameState.flags ?? []), flag])];
    db.prepare('UPDATE campaigns SET game_state_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(gameState), nowIso(), campaignId);
    db.prepare(`
        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, 'true', ?)
        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at
    `).run(campaignId, `flag:${flag}`, nowIso());
}

function setVariable(db, campaignId, key, value) {
    db.prepare(`
        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(campaignId, key, JSON.stringify(value ?? null), nowIso());
    const storyState = getStoryState(campaignId, db);
    if (storyState) {
        storyState.variables ??= {};
        storyState.variables[key] = value ?? null;
        saveStoryState(db, campaignId, storyState);
    }
}

export function applyStoryActions(db, campaignId, actions = [], context = {}) {
    const applied = [];
    for (const action of actions ?? []) {
        try {
            if (action.type === 'set_flag' || action.type === 'setFlag') {
                addFlag(db, campaignId, action.key ?? action.flag);
                applied.push({ type: 'flag', key: action.key ?? action.flag });
            } else if (action.type === 'set_variable' || action.type === 'setVariable') {
                setVariable(db, campaignId, action.key, action.value);
                applied.push({ type: 'variable', key: action.key, value: action.value });
            } else if (action.type === 'give_item' || action.type === 'giveItem') {
                const player = getPlayer(db, campaignId);
                addItem(db, campaignId, player.id, action.itemKey ?? action.key, action.amount ?? 1);
                applied.push({ type: 'item', key: action.itemKey ?? action.key, amount: action.amount ?? 1 });
            } else if (action.type === 'accept_quest' || action.type === 'acceptQuest') {
                const result = acceptQuest(db, campaignId, action.questKey ?? action.key);
                applied.push({ type: 'quest', key: result.key, status: result.status });
            } else if (action.type === 'grant_exp' || action.type === 'grantExp') {
                const player = getPlayer(db, campaignId);
                const result = addExperience(db, campaignId, player.id, Number(action.amount ?? 0), { source: 'story' });
                applied.push({ type: 'experience', amount: Number(action.amount ?? 0), result });
            } else if (action.type === 'unlock_skill' || action.type === 'unlockSkill') {
                const player = getPlayer(db, campaignId);
                unlockSkill(db, player.id, action.skillKey ?? action.key, campaignId);
                applied.push({ type: 'skill', key: action.skillKey ?? action.key });
            } else if (action.type === 'heal') {
                const player = getPlayer(db, campaignId);
                const result = healEntity(db, player.id, Number(action.amount ?? 9999), Number(action.mp ?? 9999));
                applied.push({ type: 'heal', ...result });
            } else if (action.type === 'teleport' || action.type === 'teleport_location') {
                const location = db.prepare(`
                    SELECT l.* FROM locations l JOIN campaigns c ON c.world_id = l.world_id
                    WHERE c.id = ? AND l.location_key = ?
                `).get(campaignId, action.locationKey ?? action.key);
                if (location) {
                    db.prepare('UPDATE campaigns SET current_location_id = ?, updated_at = ? WHERE id = ?').run(location.id, nowIso(), campaignId);
                    db.prepare(`
                        INSERT INTO location_discoveries (campaign_id, location_id, discovered_at) VALUES (?, ?, ?)
                        ON CONFLICT(campaign_id, location_id) DO NOTHING
                    `).run(campaignId, location.id, nowIso());
                    db.prepare('UPDATE entities SET location_id = ? WHERE campaign_id = ? AND is_player = 1').run(location.id, campaignId);
                    applied.push({ type: 'teleport', locationKey: location.location_key });
                }
            } else if (action.type === 'ending') {
                applied.push({ type: 'ending', key: action.key ?? action.value });
            } else if (action.type === 'notice') {
                applied.push({ type: 'notice', text: action.text ?? '' });
            } else if (action.type === 'adjust_relation') {
                const npcKey = action.npcKey ?? action.key;
                if (npcKey) {
                    const delta = clamp(Math.round(Number(action.delta ?? action.amount ?? 1)), -2, 2);
                    const key = `npc:${npcKey}:relation`;
                    const before = Number(getCampaignVariable(db, campaignId, key) ?? 0);
                    const after = clamp(before + delta, -100, 100);
                    db.prepare(`
                        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                    `).run(campaignId, key, JSON.stringify(after), nowIso());
                    applied.push({ type: 'relation', npcKey, delta, before, after });
                }
            } else if (action.type === 'take_item') {
                const player = getPlayer(db, campaignId);
                const itemKey = action.itemKey ?? action.key;
                const amount = Math.max(1, Math.round(Number(action.amount ?? 1)));
                removeItem(db, campaignId, player.id, itemKey, amount, { source: 'event' });
                applied.push({ type: 'item_removed', itemKey, amount });
            } else if (action.type === 'add_memory') {
                const candidateId = queueMemoryCandidate(db, campaignId, action.text ?? action.value, action.npcKey ?? null);
                applied.push({ type: 'memory', candidateId });
            } else if (action.type === 'open_chat') {
                applied.push({ type: 'open_chat', npcKey: action.npcKey ?? action.key ?? null });
            } else if (action.type === 'dialogue') {
                const candidateId = queuePerformanceCandidate(db, campaignId, {
                    npcKey: action.npcKey ?? null,
                    npcName: action.npcName ?? null,
                    text: action.text ?? action.value ?? '',
                    lines: action.lines ?? [],
                });
                applied.push({ type: 'dialogue', candidateId });
            } else if (action.type === 'set_signal') {
                const signal = String(action.key ?? action.signal ?? action.flag ?? '').trim();
                if (signal) {
                    db.prepare(`
                        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                    `).run(campaignId, `signal:${signal}`, JSON.stringify({ receivedAt: nowIso(), note: 'event' }), nowIso());
                    insertEvent(db, campaignId, 'signal.received', { signal, source: 'event' }, `signal:${signal}:${nowIso()}`);
                    applied.push({ type: 'signal', signal });
                }
            }
        } catch (error) {
            applied.push({ type: 'error', action, message: error.message });
        }
    }
    return applied;
}

function nodeMap(story) {
    return new Map(story.nodes.map((node) => [node.key, node]));
}

function availableEdges(db, campaignId, story, nodeKey, event) {
    return (story.edges ?? []).filter((edge) => {
        if (edge.from !== nodeKey) return false;
        return evaluateCondition(db, campaignId, edge.condition ?? {}, event);
    }).sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0));
}

export function storyView(db, campaignId) {
    const story = getStory(db, campaignId);
    const state = getStoryState(campaignId, db) ?? {
        currentNodeKey: story.startNodeKey,
        visited: [],
        variables: story.variables ?? {},
        ending: null,
    };
    const node = nodeMap(story).get(state.currentNodeKey) ?? null;
    const edges = availableEdges(db, campaignId, story, state.currentNodeKey, { type: 'story.view', targetKey: state.currentNodeKey });
    return {
        key: story.key,
        name: story.name,
        description: story.description,
        current: node,
        state,
        endings: story.endings,
        graph: {
            nodes: story.nodes,
            edges: story.edges,
        },
        availableEdges: edges.map((edge) => ({
            key: edge.key,
            to: edge.to,
            label: edge.label || nodeMap(story).get(edge.to)?.title || edge.to,
            manual: Boolean(edge.manual),
            condition: edge.condition ?? {},
        })),
        ending: state.ending ? nodeMap(story).get(state.ending) ?? null : null,
    };
}

function enterNode(db, campaignId, story, state, node, appliedActions) {
    state.visited = [...(state.visited ?? []), node.key].slice(-200);
    state.currentNodeKey = node.key;
    state.enteredAt = nowIso();
    const actions = applyStoryActions(db, campaignId, node.actions ?? [], { type: 'story.enter', targetKey: node.key });
    appliedActions.push(...actions);
    if (node.type === 'ending' || (story.endings ?? []).includes(node.key)) {
        state.ending = node.key;
    }
    saveStoryState(db, campaignId, state);
    insertEvent(db, campaignId, state.ending ? 'story.ending' : 'story.entered', {
        nodeKey: node.key, title: node.title, type: node.type, ending: state.ending ?? null,
    });
}

export function advanceStory(db, campaignId, event = {}) {
    return withTransaction(db, () => {
        const story = getStory(db, campaignId);
        const nodes = nodeMap(story);
        let state = getStoryState(campaignId, db);
        if (!state) state = ensureStoryState(campaignId, db, story);
        if (state.ending) return { state, entered: [], actions: [], ending: state.ending };
        const entered = [];
        const actions = [];
        let guard = 0;
        while (guard++ < 100) {
            const currentNode = nodes.get(state.currentNodeKey);
            if (!currentNode) break;
            if (currentNode.type === 'ending' || (story.endings ?? []).includes(currentNode.key)) {
                state.ending = currentNode.key;
                saveStoryState(db, campaignId, state);
                break;
            }
            const edges = availableEdges(db, campaignId, story, state.currentNodeKey, event);
            const autoEdges = edges.filter((edge) => !edge.manual);
            if (!autoEdges.length) break;
            const edge = autoEdges[0];
            const target = nodes.get(edge.to);
            if (!target) break;
            if (target.conditions && !evaluateCondition(db, campaignId, target.conditions, event)) break;
            applyStoryActions(db, campaignId, edge.actions ?? [], { type: 'story.edge', targetKey: edge.to });
            enterNode(db, campaignId, story, state, target, actions);
            entered.push(target.key);
            if (state.ending) break;
        }
        return { state, entered, actions, ending: state.ending, view: storyView(db, campaignId) };
    });
}

export function chooseStoryEdge(db, campaignId, edgeKey) {
    return withTransaction(db, () => {
        const story = getStory(db, campaignId);
        const nodes = nodeMap(story);
        const state = getStoryState(campaignId, db);
        if (!state) throw new ConflictError('Story has not started', 'STORY_NOT_STARTED');
        if (state.ending) throw new ConflictError('Story already reached an ending', 'STORY_ENDED');
        const edge = (story.edges ?? []).find((entry) => entry.key === edgeKey);
        if (!edge || edge.from !== state.currentNodeKey) throw new NotFoundError('Story choice is not available', 'STORY_CHOICE_NOT_FOUND');
        if (!evaluateCondition(db, campaignId, edge.condition ?? {}, { type: 'story.choice', targetKey: edgeKey })) {
            throw new ConflictError('Story choice condition is not met', 'STORY_CHOICE_LOCKED');
        }
        const target = nodes.get(edge.to);
        if (!target) throw new NotFoundError('Story target missing', 'STORY_TARGET_MISSING');
        const actions = [];
        applyStoryActions(db, campaignId, edge.actions ?? [], { type: 'story.edge', targetKey: edge.to });
        enterNode(db, campaignId, story, state, target, actions);
        return advanceStory(db, campaignId, { type: 'story.choice', targetKey: edgeKey });
    });
}

export function startStory(db, campaignId) {
    return withTransaction(db, () => {
        const story = getStory(db, campaignId);
        const nodes = nodeMap(story);
        const state = ensureStoryState(campaignId, db, story);
        const node = nodes.get(state.currentNodeKey);
        const actions = [];
        if (node) enterNode(db, campaignId, story, state, node, actions);
        const advanced = advanceStory(db, campaignId, { type: 'story.start', targetKey: story.startNodeKey });
        return { state: advanced.state, actions: [...actions, ...(advanced.actions ?? [])], view: advanced.view ?? storyView(db, campaignId) };
    });
}
