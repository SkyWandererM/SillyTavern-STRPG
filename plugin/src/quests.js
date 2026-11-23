import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { addExperience, getPlayer, unlockSkill } from './stats.js';
import { addItem, countItem } from './inventory.js';
import { insertEvent, nowIso, parseJson, uuid, withTransaction } from './util.js';

const FINISHED = new Set(['completed', 'turned_in']);

export function getQuestDefinition(db, campaignId, questKey) {
    const row = db.prepare(`
        SELECT q.* FROM quest_definitions q
        JOIN campaigns c ON c.game_version_id = q.game_version_id
        WHERE c.id = ? AND q.quest_key = ?
    `).get(campaignId, questKey);
    if (!row) throw new NotFoundError(`Quest '${questKey}' not found`, 'QUEST_NOT_FOUND');
    return { ...row, data: parseJson(row.data_json, {}) };
}

export function ensureQuestInstances(db, campaignId) {
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    const definitions = db.prepare('SELECT * FROM quest_definitions WHERE game_version_id = ? ORDER BY quest_key').all(campaign.game_version_id);
    const now = nowIso();
    for (const definition of definitions) {
        db.prepare(`
            INSERT INTO quest_instances (id, campaign_id, quest_definition_id, quest_key, status, stage_key, progress_json, updated_at)
            VALUES (?, ?, ?, ?, 'available', NULL, '{}', ?)
            ON CONFLICT(campaign_id, quest_key) DO NOTHING
        `).run(uuid('qi_'), campaignId, definition.id, definition.quest_key, now);
    }
    return definitions.length;
}

function getInstance(db, campaignId, questKey) {
    return db.prepare('SELECT * FROM quest_instances WHERE campaign_id = ? AND quest_key = ?').get(campaignId, questKey);
}

export function initProgress(quest, stageKey) {
    const stage = quest.stages.find((entry) => entry.key === stageKey);
    const objectives = {};
    for (const objective of stage?.objectives ?? []) objectives[objective.key] = 0;
    return { stages: { [stageKey]: { objectives } } };
}

function objectiveProgress(progress, stageKey, objectiveKey) {
    return Number(progress?.stages?.[stageKey]?.objectives?.[objectiveKey] ?? 0);
}

function setObjectiveProgress(progress, stageKey, objectiveKey, value) {
    progress.stages ??= {};
    progress.stages[stageKey] ??= { objectives: {} };
    progress.stages[stageKey].objectives ??= {};
    progress.stages[stageKey].objectives[objectiveKey] = value;
    return progress;
}

function evaluateAutomaticObjective(db, campaignId, playerId, objective) {
    if (objective.type === 'collect') return countItem(db, campaignId, playerId, objective.targetKey);
    if (objective.type === 'level') return Number(getPlayer(db, campaignId).level);
    if (objective.type === 'flag') {
        const row = db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?')
            .get(campaignId, `flag:${objective.targetKey}`);
        return row && parseJson(row.value_json, false) ? Number(objective.count) : 0;
    }
    return null;
}

function allObjectivesDone(stage, progress, stageKey) {
    const checks = stage.objectives.map((objective) => objectiveProgress(progress, stageKey, objective.key) >= Number(objective.count));
    return stage.mode === 'any' ? checks.some(Boolean) : checks.every(Boolean);
}

function grantRewards(db, campaignId, quest, state) {
    if (state.rewardsGranted) return { experience: null, gold: 0, items: [], skills: [] };
    const player = getPlayer(db, campaignId);
    const rewards = quest.rewards ?? {};
    const result = { experience: null, gold: Number(rewards.gold ?? 0), items: [], skills: [], flags: rewards.flags ?? [] };
    if (result.gold > 0) db.prepare('UPDATE entities SET gold = gold + ?, updated_at = ? WHERE id = ?').run(result.gold, nowIso(), player.id);
    for (const reward of rewards.items ?? []) {
        addItem(db, campaignId, player.id, reward.itemKey, reward.quantity ?? 1);
        result.items.push({ itemKey: reward.itemKey, quantity: reward.quantity ?? 1 });
    }
    for (const skillKey of rewards.skills ?? []) {
        unlockSkill(db, player.id, skillKey, campaignId);
        result.skills.push(skillKey);
    }
    if (Number(rewards.exp ?? 0) > 0) {
        result.experience = addExperience(db, campaignId, player.id, Number(rewards.exp), { source: `quest:${quest.key}` });
    }
    for (const flag of rewards.flags ?? []) {
        db.prepare(`
            INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, 'true', ?)
            ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at
        `).run(campaignId, `flag:${flag}`, nowIso());
    }
    return result;
}

export function questView(db, campaignId, questKey) {
    const definition = getQuestDefinition(db, campaignId, questKey);
    const quest = definition.data;
    const instance = getInstance(db, campaignId, questKey);
    if (!instance) {
        return {
            key: quest.key,
            name: quest.name,
            type: quest.type,
            description: quest.description,
            status: 'unavailable',
            stage: null,
            stages: [],
            rewards: quest.rewards,
            prerequisites: quest.prerequisites ?? [],
        };
    }
    const progress = parseJson(instance.progress_json, {});
    const stages = (quest.stages ?? []).map((stage) => ({
        key: stage.key,
        name: stage.name,
        description: stage.description,
        objectives: stage.objectives.map((objective) => {
            const automatic = evaluateAutomaticObjective(db, campaignId, getPlayer(db, campaignId).id, objective);
            const current = automatic == null ? objectiveProgress(progress, stage.key, objective.key) : automatic;
            return {
                ...objective,
                current: Math.min(Number(current), Number(objective.count)),
                completed: Number(current) >= Number(objective.count),
            };
        }),
        completed: allObjectivesDone(stage, {
            stages: {
                ...progress.stages,
                [stage.key]: {
                    objectives: Object.fromEntries(stage.objectives.map((objective) => {
                        const automatic = evaluateAutomaticObjective(db, campaignId, getPlayer(db, campaignId).id, objective);
                        return [objective.key, automatic == null ? objectiveProgress(progress, stage.key, objective.key) : automatic];
                    })),
                },
            },
        }, stage.key),
    }));
    return {
        key: quest.key,
        name: quest.name,
        type: quest.type,
        description: quest.description,
        level: quest.level,
        status: instance.status,
        stageKey: instance.stage_key,
        stages,
        rewards: quest.rewards,
        prerequisites: quest.prerequisites ?? [],
        turnIn: quest.turnIn ?? null,
        acceptedAt: instance.accepted_at,
        completedAt: instance.completed_at,
        turnedInAt: instance.turned_in_at,
    };
}

export function listQuests(db, campaignId) {
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const defs = db.prepare('SELECT quest_key FROM quest_definitions WHERE game_version_id = ? ORDER BY type, quest_key').all(campaign.game_version_id);
    return defs.map((row) => questView(db, campaignId, row.quest_key));
}

export function acceptQuest(db, campaignId, questKey, options = {}) {
    const definition = getQuestDefinition(db, campaignId, questKey);
    const quest = definition.data;
    return withTransaction(db, () => {
        const instance = getInstance(db, campaignId, questKey);
        if (!instance) throw new NotFoundError('Quest instance not initialized', 'QUEST_INSTANCE_MISSING');
        if (instance.status !== 'available') throw new ConflictError('Quest is not available to accept', 'QUEST_NOT_AVAILABLE', { status: instance.status });
        for (const prerequisite of quest.prerequisites ?? []) {
            const prerequisiteInstance = getInstance(db, campaignId, prerequisite);
            if (!prerequisiteInstance || !FINISHED.has(prerequisiteInstance.status)) {
                throw new ConflictError(`Prerequisite quest '${prerequisite}' is not complete`, 'QUEST_PREREQUISITE_INCOMPLETE', { questKey: prerequisite });
            }
        }
        const firstStage = quest.stages[0];
        const now = nowIso();
        const progress = initProgress(quest, firstStage.key);
        db.prepare(`
            UPDATE quest_instances SET status = 'active', stage_key = ?, progress_json = ?, accepted_at = ?, updated_at = ?
            WHERE id = ?
        `).run(firstStage.key, JSON.stringify(progress), now, now, instance.id);
        insertEvent(db, campaignId, 'quest.accepted', { questKey, stageKey: firstStage.key }, `quest-accepted:${campaignId}:${questKey}`);
        // Some objectives (collect / level / flag) may already be satisfied on acceptance.
        updateQuestProgress(db, campaignId, { type: 'accept', targetKey: questKey, amount: 0 });
        return { ...questView(db, campaignId, questKey), event: { type: 'quest.accepted', targetKey: questKey, stageKey: firstStage.key } };
    });
}

function completeQuest(db, campaignId, quest, instance, now) {
    const questKey = quest.key;
    if (quest.completion === 'turn_in') {
        db.prepare("UPDATE quest_instances SET status = 'ready_to_turn_in', progress_json = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(instance.progress_json ?? '{}', now, now, instance.id);
        return { status: 'ready_to_turn_in', rewards: null };
    }
    const state = parseJson(instance.progress_json, {});
    const rewards = grantRewards(db, campaignId, quest, state);
    db.prepare("UPDATE quest_instances SET status = 'completed', progress_json = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(instance.progress_json ?? '{}', now, now, instance.id);
    return { status: 'completed', rewards };
}

/**
 * Advance a quest objective. Caller orchestrates story advancement from `events`.
 */
export function updateQuestProgress(db, campaignId, event = {}) {
    const type = event.type;
    if (!type) return { changes: [], events: [] };
    const changes = [];
    const events = [];
    const active = db.prepare("SELECT * FROM quest_instances WHERE campaign_id = ? AND status = 'active'").all(campaignId);
    const player = getPlayer(db, campaignId);
    for (const instance of active) {
        const quest = getQuestDefinition(db, campaignId, instance.quest_key).data;
        let changed = false;
        const progress = parseJson(instance.progress_json, {});
        const stage = quest.stages.find((entry) => entry.key === instance.stage_key);
        if (!stage) continue;
        for (const objective of stage.objectives) {
            if (objective.type !== type) continue;
            if (objective.targetKey && event.targetKey && objective.targetKey !== event.targetKey) continue;
            const current = objectiveProgress(progress, stage.key, objective.key);
            const increment = Math.max(1, Number(event.amount ?? 1));
            const next = Math.min(Number(objective.count), current + increment);
            if (next !== current) {
                setObjectiveProgress(progress, stage.key, objective.key, next);
                changed = true;
                events.push({ type: 'quest.objective', targetKey: quest.key, objectiveKey: objective.key, current: next, count: objective.count });
            }
        }
        for (const objective of stage.objectives) {
            const automatic = evaluateAutomaticObjective(db, campaignId, player.id, objective);
            if (automatic != null) {
                const current = objectiveProgress(progress, stage.key, objective.key);
                const next = Math.min(Number(objective.count), automatic);
                if (next !== current) {
                    setObjectiveProgress(progress, stage.key, objective.key, next);
                    changed = true;
                    events.push({ type: 'quest.objective', targetKey: quest.key, objectiveKey: objective.key, current: next, count: objective.count });
                }
            }
        }
        if (!changed) continue;
        const now = nowIso();
        const nextProgress = progress;
        if (allObjectivesDone(stage, nextProgress, stage.key)) {
            const stageIndex = quest.stages.findIndex((entry) => entry.key === stage.key);
            const nextStage = quest.stages[stageIndex + 1];
            if (nextStage) {
                const nextStageProgress = initProgress(quest, nextStage.key);
                nextStageProgress.stages = { ...progress.stages, ...nextStageProgress.stages };
                db.prepare(`
                    UPDATE quest_instances SET stage_key = ?, progress_json = ?, updated_at = ? WHERE id = ?
                `).run(nextStage.key, JSON.stringify(nextStageProgress), now, instance.id);
                changes.push({ questKey: quest.key, status: 'active', stageKey: nextStage.key, stageAdvanced: true });
                events.push({ type: 'quest.stage', targetKey: quest.key, stageKey: nextStage.key });
            } else {
                const completion = completeQuest(db, campaignId, quest, { ...instance, progress_json: JSON.stringify(nextProgress) }, now);
                changes.push({ questKey: quest.key, status: completion.status, rewards: completion.rewards });
                events.push({ type: 'quest.completed', targetKey: quest.key, status: completion.status });
            }
        } else {
            db.prepare('UPDATE quest_instances SET progress_json = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(nextProgress), now, instance.id);
            changes.push({ questKey: quest.key, status: 'active', stageKey: stage.key });
        }
    }
    for (const event of events) {
        insertEvent(db, campaignId, event.type, event);
    }
    return { changes, events };
}

/**
 * Barter debts settle when the service quest is turned in: the item was fronted at
 * approval, so completion only grants the relationship change and clears the debt.
 */
function settleBarterDebts(db, campaignId, questKey) {
    const rows = db.prepare("SELECT var_key, value_json FROM campaign_variables WHERE campaign_id = ? AND var_key LIKE 'barter:%'").all(campaignId);
    const settled = [];
    for (const row of rows) {
        let debt;
        try { debt = JSON.parse(row.value_json); } catch { continue; }
        if (!debt || debt.questKey !== questKey) continue;
        const delta = Math.max(0, Math.min(2, Math.round(Number(debt.relationDelta ?? 1))));
        if (delta > 0) {
            const key = `npc:${debt.npcKey}:relation`;
            const current = db.prepare('SELECT value_json FROM campaign_variables WHERE campaign_id = ? AND var_key = ?').get(campaignId, key);
            const before = current ? Number(JSON.parse(current.value_json)) || 0 : 0;
            const after = Math.max(-100, Math.min(100, before + delta));
            db.prepare(`
                INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            `).run(campaignId, key, JSON.stringify(after), nowIso());
        }
        db.prepare('DELETE FROM campaign_variables WHERE campaign_id = ? AND var_key = ?').run(campaignId, row.var_key);
        insertEvent(db, campaignId, 'barter.settled', {
            npcKey: debt.npcKey, itemKey: debt.itemKey, questKey, relationDelta: delta, candidateId: debt.candidateId,
        }, `barter-settled:${campaignId}:${row.var_key}`);
        settled.push({ npcKey: debt.npcKey, itemKey: debt.itemKey, relationDelta: delta });
    }
    return settled;
}

export function turnInQuest(db, campaignId, questKey, options = {}) {
    const definition = getQuestDefinition(db, campaignId, questKey);
    const quest = definition.data;
    return withTransaction(db, () => {
        const instance = getInstance(db, campaignId, questKey);
        if (!instance) throw new NotFoundError('Quest instance not found', 'QUEST_INSTANCE_MISSING');
        if (instance.status !== 'ready_to_turn_in') {
            throw new ConflictError('Quest is not ready to turn in', 'QUEST_NOT_READY', { status: instance.status });
        }
        if (quest.completion === 'turn_in' && quest.turnIn?.npcKey) {
            if (options.npcKey && options.npcKey !== quest.turnIn.npcKey) {
                throw new ConflictError(`This quest must be turned in at ${quest.turnIn.npcKey}`, 'QUEST_WRONG_TURNIN_NPC');
            }
            const npc = db.prepare("SELECT * FROM entities WHERE campaign_id = ? AND entity_key = ?")
                .get(campaignId, `npc:${quest.turnIn.npcKey}`);
            const campaign = db.prepare('SELECT current_location_id FROM campaigns WHERE id = ?').get(campaignId);
            if (!npc) throw new ConflictError('The turn-in NPC is not present in this campaign', 'QUEST_TURNIN_NPC_MISSING');
            if (npc.location_id !== campaign.current_location_id) {
                throw new ConflictError('You must be at the turn-in NPC location', 'QUEST_TURNIN_WRONG_LOCATION');
            }
        }
        const now = nowIso();
        const granted = grantRewards(db, campaignId, quest, { rewardsGranted: false });
        db.prepare("UPDATE quest_instances SET status = 'turned_in', turned_in_at = ?, updated_at = ? WHERE id = ?")
            .run(now, now, instance.id);
        insertEvent(db, campaignId, 'quest.turned_in', { questKey, rewards: granted }, `quest-turned-in:${campaignId}:${questKey}`);
        const barters = settleBarterDebts(db, campaignId, questKey);
        return {
            ...questView(db, campaignId, questKey),
            rewards: { ...questView(db, campaignId, questKey).rewards, granted },
            barters,
            event: { type: 'quest.turned_in', targetKey: questKey },
        };
    });
}

export function activeQuestSummary(db, campaignId) {
    return listQuests(db, campaignId).filter((quest) => ['active', 'ready_to_turn_in'].includes(quest.status));
}

export function failQuest(db, campaignId, questKey, reason = '') {
    const instance = getInstance(db, campaignId, questKey);
    if (!instance) throw new NotFoundError('Quest instance not found', 'QUEST_INSTANCE_MISSING');
    if (!['active', 'ready_to_turn_in'].includes(instance.status)) throw new ConflictError('Quest cannot be failed in its current state', 'QUEST_NOT_ACTIVE');
    db.prepare("UPDATE quest_instances SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), instance.id);
    insertEvent(db, campaignId, 'quest.failed', { questKey, reason });
    return { ...questView(db, campaignId, questKey), reason };
}

export function questsReadyForTurnIn(db, campaignId, npcKey) {
    return listQuests(db, campaignId).filter((quest) => quest.status === 'ready_to_turn_in' && quest.turnIn?.npcKey === npcKey);
}

export function validateQuestAcceptance(db, campaignId, questKey) {
    const quest = getQuestDefinition(db, campaignId, questKey).data;
    const instance = getInstance(db, campaignId, questKey);
    const errors = [];
    if (!instance) errors.push('Quest instance missing');
    else if (instance.status !== 'available') errors.push(`Quest status is ${instance.status}`);
    for (const prerequisite of quest.prerequisites ?? []) {
        const prerequisiteInstance = getInstance(db, campaignId, prerequisite);
        if (!prerequisiteInstance || !FINISHED.has(prerequisiteInstance.status)) errors.push(`Prerequisite ${prerequisite} incomplete`);
    }
    return errors.length ? { valid: false, errors } : { valid: true, errors: [], quest };
}
