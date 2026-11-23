import crypto from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { evaluateFormula, DEFAULT_FORMULAS } from './formula.js';
import { getCampaignPackage, computeEntityStats, getEntity, getPlayer, addExperience } from './stats.js';
import { addItem, listInventory, removeItem } from './inventory.js';
import { updateQuestProgress } from './quests.js';
import { advanceStory } from './story.js';
import { runEventDefinitions } from './world.js';
import { assertEncounterAvailable, markEncounterDefeated, resetEncounterSpawn } from './encounters.js';
import { campaignSnapshot } from './campaigns.js';
import {
    asJson, insertEvent, nowIso, parseJson, uuid, withTransaction,
} from './util.js';

const MAX_ENEMIES = 8;

function createRng(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return {
        get state() { return state; },
        next() {
            state = (state + 0x6D2B79F5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
        int(min, max) {
            return Math.floor(this.next() * (max - min + 1)) + min;
        },
    };
}

function newSeed() {
    return crypto.randomInt(1, 2 ** 31 - 1);
}

function getSession(db, combatId) {
    const session = db.prepare('SELECT * FROM combat_sessions WHERE id = ?').get(combatId);
    if (!session) throw new NotFoundError(`Combat '${combatId}' not found`, 'COMBAT_NOT_FOUND');
    return session;
}

function participants(db, combatId) {
    return db.prepare('SELECT * FROM combat_participants WHERE combat_session_id = ? ORDER BY order_index, initiative DESC').all(combatId);
}

function participantById(db, combatId, id) {
    return db.prepare('SELECT * FROM combat_participants WHERE combat_session_id = ? AND id = ?').get(combatId, id);
}

function statusModifiers(participant) {
    const statuses = parseJson(participant.statuses_json, []);
    const modifiers = {};
    for (const status of statuses) {
        for (const [key, value] of Object.entries(status.modifiers ?? {})) {
            modifiers[key] = (modifiers[key] ?? 0) + Number(value);
        }
    }
    return modifiers;
}

function effectiveStats(participant) {
    const stats = { ...parseJson(participant.stats_json, {}) };
    for (const [key, value] of Object.entries(statusModifiers(participant))) {
        stats[key] = Math.max(0, Number(stats[key] ?? 0) + Number(value));
    }
    return stats;
}

function skillDefinitionsForParticipant(db, pkg, participant) {
    const template = parseJson(participant.template_json, {});
    if (participant.entity_id) {
        const rows = db.prepare(`
            SELECT s.* FROM entity_skills es JOIN skill_definitions s ON s.id = es.skill_definition_id
            WHERE es.entity_id = ?
        `).all(participant.entity_id);
        return rows.map((row) => parseJson(row.data_json, {})).filter((skill) => skill.category !== 'passive');
    }
    return (template.skills ?? []).map((key) => (pkg.skills ?? []).find((skill) => skill.key === key)).filter(Boolean)
        .filter((skill) => skill.category !== 'passive');
}

function skillByKey(db, pkg, participant, skillKey) {
    return skillDefinitionsForParticipant(db, pkg, participant).find((skill) => skill.key === skillKey) ?? null;
}

function effectDefinition(pkg, key) {
    return (pkg.effects ?? []).find((effect) => effect.key === key) ?? null;
}

function updateParticipant(db, participant) {
    db.prepare(`
        UPDATE combat_participants SET hp = ?, mp = ?, statuses_json = ?, alive = ?, stats_json = ?, template_json = ?
        WHERE id = ?
    `).run(participant.hp, participant.mp, participant.statuses_json, participant.alive ? 1 : 0, participant.stats_json, participant.template_json, participant.id);
}

function actionLog(text, extra = {}) {
    return { text, ...extra, at: nowIso() };
}

function rollDamage(db, actor, target, skill, rng, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const formulas = pkg.rules?.formulas ?? {};
    const a = effectiveStats(actor);
    const t = effectiveStats(target);
    const physical = (skill?.element ?? 'physical') === 'physical';
    const variance = 0.9 + rng.next() * 0.2;
    const hitFormula = formulas.hitChance ?? DEFAULT_FORMULAS.hitChance;
    let hitChance = evaluateFormula(hitFormula, {
        hit: a.hit ?? 0, evade: t.evade ?? 0, agi: a.agi ?? 0, luck: a.luck ?? 0,
    });
    hitChance = Math.max(0.05, Math.min(0.95, hitChance));
    if (rng.next() > hitChance) return { hit: false, damage: 0, crit: false, hitChance };
    const critFormula = formulas.critChance ?? DEFAULT_FORMULAS.critChance;
    const critChance = Math.max(0.01, Math.min(0.5, evaluateFormula(critFormula, {
        luck: a.luck ?? 0, agi: a.agi ?? 0,
    })));
    const crit = rng.next() < critChance;
    const critMult = crit ? 1.5 : 1;
    const resistance = Number(parseJson(target.resistances_json, {})[skill?.element ?? 'physical'] ?? 0);
    const elementMult = Math.max(0.1, 1 - resistance);
    const formula = skill?.formula || (physical
        ? (formulas.physicalDamage ?? DEFAULT_FORMULAS.physicalDamage)
        : (formulas.magicalDamage ?? DEFAULT_FORMULAS.magicalDamage));
    let damage = evaluateFormula(formula, {
        atk: a.atk ?? 0,
        mag: a.mag ?? 0,
        def: t.def ?? 0,
        res: t.res ?? 0,
        power: Number(skill?.power ?? 0),
        variance,
        critMult,
        elementMult,
        level: a.level ?? 1,
        targetLevel: t.level ?? 1,
        str: a.str ?? 0,
        agi: a.agi ?? 0,
        int: a.int ?? 0,
        vit: a.vit ?? 0,
        luck: a.luck ?? 0,
        targetDef: t.def ?? 0,
    });
    const guarding = Boolean(parseJson(target.template_json, {}).guarding);
    if (guarding) damage = Math.max(1, Math.round(damage * 0.5));
    return { hit: true, damage: Math.max(1, Math.round(damage)), crit, hitChance, elementMult };
}

function addStatus(participant, effect) {
    const statuses = parseJson(participant.statuses_json, []);
    const existing = statuses.find((status) => status.key === effect.key);
    if (existing) {
        existing.duration = Math.max(Number(existing.duration), Number(effect.duration ?? 2));
        existing.stacks = Math.min(5, Number(existing.stacks ?? 1) + 1);
    } else {
        statuses.push({
            key: effect.key,
            name: effect.name ?? effect.key,
            duration: Number(effect.duration ?? 2),
            stacks: 1,
            modifiers: effect.modifiers ?? {},
            tick: effect.tick ?? { type: 'none', value: 0 },
            skipTurn: Boolean(effect.skipTurn),
        });
    }
    participant.statuses_json = JSON.stringify(statuses);
}

function chooseTargets(db, combatId, actor, targetId, targetMode, side) {
    const all = participants(db, combatId);
    if (targetMode === 'all_enemies') return all.filter((entry) => entry.side !== side && entry.alive);
    if (targetMode === 'all_allies') return all.filter((entry) => entry.side === side && entry.alive);
    if (targetMode === 'self') return [actor];
    if (targetMode === 'ally') {
        if (targetId) {
            const target = all.find((entry) => entry.id === targetId);
            return target && target.side === side && target.alive ? [target] : [];
        }
        const allies = all.filter((entry) => entry.side === side && entry.alive);
        return [allies.sort((a, b) => (a.hp / a.max_hp) - (b.hp / b.max_hp))[0]].filter(Boolean);
    }
    if (!targetId) return [];
    const target = all.find((entry) => entry.id === targetId);
    return target && target.side !== side && target.alive ? [target] : [];
}

function performAttack(db, combatId, actor, action, rng, campaignId) {
    const target = participantById(db, combatId, action.targetId);
    if (!target || target.side === actor.side || !target.alive) throw new ValidationError('Invalid attack target');
    const result = rollDamage(db, actor, target, null, rng, campaignId);
    if (!result.hit) return { log: [actionLog(`${actor.name}'s attack was evaded by ${target.name}.`, { type: 'miss' })] };
    target.hp = Math.max(0, Number(target.hp) - result.damage);
    if (target.hp <= 0) target.alive = 0;
    updateParticipant(db, target);
    return {
        log: [actionLog(`${actor.name} attacks ${target.name} for ${result.damage} damage${result.crit ? ' (critical!)' : ''}.`, {
            type: 'damage', sourceId: actor.id, targetId: target.id, damage: result.damage, crit: result.crit,
        })],
        damage: result.damage,
        crit: result.crit,
    };
}

function performSkill(db, combatId, actor, action, rng, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const skill = skillByKey(db, pkg, actor, action.skillKey);
    if (!skill) throw new ValidationError(`Skill '${action.skillKey}' is not available`);
    const template = parseJson(actor.template_json, {});
    template.cooldowns ??= {};
    if (Number(template.cooldowns[skill.key] ?? 0) > 0) throw new ConflictError('Skill is on cooldown', 'SKILL_COOLDOWN', { remaining: template.cooldowns[skill.key] });
    if (Number(actor.mp) < Number(skill.mpCost ?? 0)) throw new ConflictError('Not enough MP', 'INSUFFICIENT_MP', { mp: actor.mp, required: skill.mpCost });
    const targets = chooseTargets(db, combatId, actor, action.targetId, skill.target, actor.side);
    if (!targets.length) throw new ValidationError('Skill has no valid target');
    actor.mp = Math.max(0, Number(actor.mp) - Number(skill.mpCost ?? 0));
    actor.template_json = JSON.stringify(template);
    updateParticipant(db, actor);
    const log = [];
    for (const target of targets) {
        if (['attack'].includes(skill.type) || (skill.power ?? 0) > 0 && skill.type === 'attack') {
            const result = rollDamage(db, actor, target, skill, rng, campaignId);
            if (!result.hit) {
                log.push(actionLog(`${target.name} evades ${actor.name}'s ${skill.name}.`, { type: 'miss', targetId: target.id }));
            } else {
                target.hp = Math.max(0, Number(target.hp) - result.damage);
                if (target.hp <= 0) target.alive = 0;
                log.push(actionLog(`${actor.name} uses ${skill.name} on ${target.name} for ${result.damage} ${skill.element === 'physical' ? 'physical' : skill.element} damage${result.crit ? ' (critical!)' : ''}.`, {
                    type: 'damage', sourceId: actor.id, targetId: target.id, damage: result.damage, crit: result.crit, skillKey: skill.key,
                }));
            }
        } else if (skill.type === 'heal') {
            const healFormula = skill.formula || pkg.rules?.formulas?.heal || DEFAULT_FORMULAS.heal;
            const a = effectiveStats(actor);
            const amount = Math.max(1, Math.round(evaluateFormula(healFormula, {
                mag: a.mag ?? 0, power: Number(skill.power ?? 0), level: a.level ?? 1,
            })));
            target.hp = Math.min(Number(target.max_hp), Number(target.hp) + amount);
            log.push(actionLog(`${actor.name} uses ${skill.name} to heal ${target.name} for ${amount} HP.`, {
                type: 'heal', targetId: target.id, amount, skillKey: skill.key,
            }));
        }
        if (skill.effects?.applyStatus && target.alive) {
            if (rng.next() <= Number(skill.effects.applyStatus.chance ?? 1)) {
                const effect = effectDefinition(pkg, skill.effects.applyStatus.effectKey);
                if (effect) {
                    addStatus(target, { ...effect, duration: skill.effects.applyStatus.duration ?? effect.duration });
                    log.push(actionLog(`${target.name} is affected by ${effect.name}.`, { type: 'status', targetId: target.id, effectKey: effect.key }));
                }
            }
        }
        if (skill.effects?.buff) {
            addStatus(target, {
                key: `buff:${skill.key}`,
                name: `${skill.name} Buff`,
                duration: skill.effects.buff.duration ?? 3,
                modifiers: { [skill.effects.buff.stat]: Number(skill.effects.buff.amount) },
            });
        }
        updateParticipant(db, target);
    }
    if (skill.effects?.drain) {
        const totalDamage = log.reduce((sum, entry) => sum + Number(entry.damage ?? 0), 0);
        const heal = Math.round(totalDamage * Number(skill.effects.drain));
        if (heal > 0) {
            actor.hp = Math.min(Number(actor.max_hp), Number(actor.hp) + heal);
            updateParticipant(db, actor);
            log.push(actionLog(`${actor.name} drains ${heal} HP.`, { type: 'heal', targetId: actor.id, amount: heal }));
        }
    }
    if (Number(skill.cooldown ?? 0) > 0) {
        template.cooldowns[skill.key] = Number(skill.cooldown);
        actor.template_json = JSON.stringify(template);
        updateParticipant(db, actor);
    }
    return { log, skill };
}

function performGuard(db, actor) {
    const template = parseJson(actor.template_json, {});
    template.guarding = true;
    actor.template_json = JSON.stringify(template);
    updateParticipant(db, actor);
    return { log: [actionLog(`${actor.name} takes a defensive stance.`, { type: 'guard', sourceId: actor.id })] };
}

function performItem(db, combatId, actor, action, campaignId) {
    if (!actor.entity_id) throw new ValidationError('Only player characters can use items');
    const inventory = listInventory(db, campaignId, actor.entity_id);
    const item = inventory.find((entry) => entry.itemKey === action.itemKey)
        ?? inventory.find((entry) => entry.inventoryId === action.inventoryId);
    if (!item) throw new NotFoundError('Item is not in inventory', 'ITEM_NOT_OWNED');
    if (item.kind !== 'consumable') throw new ValidationError('Only consumables can be used in combat');
    const targets = action.targetId
        ? [participantById(db, combatId, action.targetId)].filter(Boolean)
        : [actor];
    if (!targets.length) throw new ValidationError('Invalid item target');
    const log = [];
    for (const target of targets) {
        const consumable = item.consumable ?? {};
        const oldHp = Number(target.hp);
        const oldMp = Number(target.mp);
        const hp = Math.min(Number(target.max_hp), oldHp + Number(consumable.healHp ?? 0));
        const mp = Math.min(Number(target.max_mp), oldMp + Number(consumable.healMp ?? 0));
        target.hp = hp;
        target.mp = mp;
        if (hp > 0) target.alive = 1;
        updateParticipant(db, target);
        log.push(actionLog(`${actor.name} uses ${item.name} on ${target.name}, restoring ${Math.max(0, hp - oldHp)} HP and ${Math.max(0, mp - oldMp)} MP.`, {
            type: 'item', itemKey: item.itemKey, targetId: target.id,
        }));
    }
    removeItem(db, campaignId, actor.entity_id, item.itemKey, 1);
    return { log, item };
}

function performFlee(db, combatId, actor, rng, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const enemies = participants(db, combatId).filter((entry) => entry.side === 'enemy' && entry.alive);
    const enemyAgi = enemies.reduce((sum, entry) => sum + Number(effectiveStats(entry).agi ?? 0), 0) / Math.max(1, enemies.length);
    const formula = pkg.rules?.formulas?.fleeChance ?? DEFAULT_FORMULAS.fleeChance;
    const chance = Math.max(0.1, Math.min(0.9, evaluateFormula(formula, {
        agi: effectiveStats(actor).agi ?? 0, enemyAgi,
    })));
    const success = rng.next() < chance;
    return {
        fled: success,
        log: [actionLog(success ? `${actor.name} escapes from combat.` : `${actor.name} fails to escape.`, { type: 'flee', success, chance })],
    };
}

function syncParticipantResources(db, combatId) {
    for (const participant of participants(db, combatId)) {
        if (!participant.entity_id) continue;
        db.prepare('UPDATE entities SET hp = ?, mp = ?, alive = ?, updated_at = ? WHERE id = ?')
            .run(participant.hp, participant.mp, participant.alive, nowIso(), participant.entity_id);
    }
}

function spawnKeyForSession(session) {
    return String(session.encounter_key ?? '').startsWith('random:') ? '__random__' : session.encounter_key;
}

function settleVictory(db, session, rng) {
    const all = participants(db, session.id);
    const enemies = all.filter((entry) => entry.side === 'enemy');
    const party = all.filter((entry) => entry.side === 'party');
    syncParticipantResources(db, session.id);
    const player = getPlayer(db, session.campaign_id);
    const pkg = getCampaignPackage(db, session.campaign_id);
    const totalExp = enemies.reduce((sum, enemy) => {
        const template = parseJson(enemy.template_json, {});
        return sum + Number(template.exp ?? 0);
    }, 0);
    const totalGold = enemies.reduce((sum, enemy) => sum + Number(parseJson(enemy.template_json, {}).gold ?? 0), 0);
    const drops = [];
    for (const enemy of enemies) {
        const template = parseJson(enemy.template_json, {});
        for (const drop of template.drops ?? []) {
            if (rng.next() <= Number(drop.chance ?? 0.5)) {
                const quantity = rng.int(Number(drop.min ?? 1), Number(drop.max ?? 1));
                addItem(db, session.campaign_id, player.id, drop.itemKey, quantity, { source: `combat:${session.id}` });
                drops.push({ itemKey: drop.itemKey, quantity });
            }
        }
    }
    if (totalGold > 0) db.prepare('UPDATE entities SET gold = gold + ?, updated_at = ? WHERE id = ?').run(totalGold, nowIso(), player.id);
    const experience = [];
    for (const member of party) {
        if (member.entity_id && Number(member.hp) > 0) {
            experience.push(addExperience(db, session.campaign_id, member.entity_id, totalExp, { source: `combat:${session.id}` }));
        }
    }
    const questChanges = [];
    const questEvents = [];
    for (const enemy of enemies) {
        const template = parseJson(enemy.template_json, {});
        const result = updateQuestProgress(db, session.campaign_id, { type: 'kill', targetKey: template.monsterKey, amount: 1 });
        questChanges.push(...result.changes);
        questEvents.push(...result.events);
        const combatWin = updateQuestProgress(db, session.campaign_id, { type: 'combat_win', targetKey: template.monsterKey, amount: 1 });
        questChanges.push(...combatWin.changes);
        questEvents.push(...combatWin.events);
    }
    const story = advanceStory(db, session.campaign_id, { type: 'combat.victory', targetKey: session.encounter_key });
    const location = db.prepare('SELECT location_key FROM locations WHERE id = (SELECT current_location_id FROM campaigns WHERE id = ?)').get(session.campaign_id);
    const worldEvents = runEventDefinitions(db, session.campaign_id, { trigger: 'combat_victory', sceneKey: location?.location_key });
    const result = {
        outcome: 'victory',
        exp: totalExp,
        gold: totalGold,
        drops,
        levelUps: experience.filter((entry) => entry.levelsGained.length),
        experience,
        questChanges,
        questEvents,
        storyEnding: story.ending ?? null,
        worldEvents,
        summary: `Victory. Gained ${totalExp} EXP, ${totalGold} gold${drops.length ? `, and loot: ${drops.map((drop) => `${drop.itemKey} x${drop.quantity}`).join(', ')}` : ''}.`,
        finishedAt: nowIso(),
    };
    db.prepare(`
        UPDATE combat_sessions SET status = 'victory', result_json = ?, ended_at = ?, updated_at = ?, rng_state = ? WHERE id = ?
    `).run(asJson(result), nowIso(), nowIso(), rng.state, session.id);
    insertEvent(db, session.campaign_id, 'combat.victory', { combatId: session.id, encounterKey: session.encounter_key, result }, `combat-victory:${session.id}`);
    markEncounterDefeated(db, session.campaign_id, session.location_id, spawnKeyForSession(session));
    campaignSnapshot(db, session.campaign_id, `Victory: ${session.encounter_key}`, true);
    return result;
}

function settleDefeat(db, session, rng) {
    syncParticipantResources(db, session.id);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(campaign.world_id);
    const start = db.prepare('SELECT * FROM locations WHERE world_id = ? AND location_key = ?')
        .get(world.id, parseJson(world.data_json, {}).startLocationKey);
    const player = getPlayer(db, session.campaign_id);
    const lostGold = Math.floor(Number(player.gold) * 0.1);
    db.prepare('UPDATE entities SET gold = gold - ?, hp = ?, alive = 1, location_id = ?, updated_at = ? WHERE id = ?')
        .run(lostGold, Math.max(1, Math.floor(Number(player.hp) > 0 ? player.hp : 1)), start?.id ?? campaign.current_location_id, nowIso(), player.id);
    const computed = computeEntityStats(db, player.id);
    const revivedHp = Math.max(1, Math.floor(computed.stats.maxHp * 0.5));
    db.prepare('UPDATE entities SET hp = ?, alive = 1 WHERE id = ?').run(revivedHp, player.id);
    db.prepare(`
        UPDATE entities SET hp = 1, alive = 1, location_id = ?
        WHERE campaign_id = ? AND kind = 'npc' AND json_extract(data_json, '$.party') = 1
    `).run(start?.id ?? campaign.current_location_id, session.campaign_id);
    if (start) db.prepare('UPDATE campaigns SET current_location_id = ?, updated_at = ? WHERE id = ?').run(start.id, nowIso(), session.campaign_id);
    // Defeat is a first-class trigger: events and the story graph can react to it.
    const battleLocation = db.prepare('SELECT location_key FROM locations WHERE id = ?').get(session.location_id);
    const worldEvents = runEventDefinitions(db, session.campaign_id, {
        trigger: 'combat_defeat',
        sceneKey: battleLocation?.location_key,
        targetKey: session.encounter_key,
    });
    const story = advanceStory(db, session.campaign_id, { type: 'combat.defeat', targetKey: session.encounter_key });
    const result = {
        outcome: 'defeat',
        goldLost: lostGold,
        revivedAt: start?.location_key ?? null,
        revivedHp,
        worldEvents,
        storyEnding: story.ending ?? null,
        summary: `The party was defeated. You wake at ${start?.name ?? 'the start'} and lose ${lostGold} gold.`,
        finishedAt: nowIso(),
    };
    db.prepare(`
        UPDATE combat_sessions SET status = 'defeat', result_json = ?, ended_at = ?, updated_at = ?, rng_state = ? WHERE id = ?
    `).run(asJson(result), nowIso(), nowIso(), rng.state, session.id);
    insertEvent(db, session.campaign_id, 'combat.defeat', { combatId: session.id, result }, `combat-defeat:${session.id}`);
    resetEncounterSpawn(db, session.campaign_id, session.location_id, spawnKeyForSession(session));
    campaignSnapshot(db, session.campaign_id, `Defeat: ${session.encounter_key}`, true);
    return result;
}

function checkEnd(db, session, rng) {
    const all = participants(db, session.id);
    const enemiesAlive = all.filter((entry) => entry.side === 'enemy' && entry.alive);
    const partyAlive = all.filter((entry) => entry.side === 'party' && entry.alive);
    if (!enemiesAlive.length) return settleVictory(db, session, rng);
    if (!partyAlive.length) return settleDefeat(db, session, rng);
    return null;
}

function beginTurn(db, participant, rng) {
    const template = parseJson(participant.template_json, {});
    template.guarding = false;
    for (const key of Object.keys(template.cooldowns ?? {})) {
        template.cooldowns[key] = Math.max(0, Number(template.cooldowns[key]) - 1);
    }
    const statuses = parseJson(participant.statuses_json, []);
    const log = [];
    let skip = false;
    const remaining = [];
    for (const status of statuses) {
        if (status.tick?.type === 'damage_percent') {
            const damage = Math.max(1, Math.round(Number(participant.max_hp) * Number(status.tick.value ?? 0)));
            participant.hp = Math.max(0, Number(participant.hp) - damage);
            log.push(actionLog(`${participant.name} takes ${damage} damage from ${status.name}.`, { type: 'status_damage', damage, effectKey: status.key }));
            if (Number(participant.hp) <= 0) participant.alive = 0;
        }
        if (status.tick?.type === 'heal_percent') {
            const heal = Math.max(1, Math.round(Number(participant.max_hp) * Number(status.tick.value ?? 0)));
            participant.hp = Math.min(Number(participant.max_hp), Number(participant.hp) + heal);
        }
        if (status.skipTurn && Number(status.duration) > 0) skip = true;
        status.duration = Number(status.duration) - 1;
        if (status.duration > 0) remaining.push(status);
        else log.push(actionLog(`${status.name} expires on ${participant.name}.`, { type: 'status_expired', effectKey: status.key }));
    }
    participant.statuses_json = JSON.stringify(remaining);
    participant.template_json = JSON.stringify(template);
    updateParticipant(db, participant);
    return { skip, log };
}

function advanceTurn(db, session) {
    const order = parseJson(session.turn_order_json, []);
    const all = new Map(participants(db, session.id).map((entry) => [entry.id, entry]));
    let currentIndex = order.indexOf(session.current_actor_id);
    if (currentIndex < 0) currentIndex = 0;
    let nextIndex = currentIndex;
    let round = Number(session.round);
    for (let tries = 0; tries < order.length + 1; tries += 1) {
        nextIndex += 1;
        if (nextIndex >= order.length) {
            nextIndex = 0;
            round += 1;
        }
        const candidate = all.get(order[nextIndex]);
        if (candidate && candidate.alive) break;
    }
    db.prepare('UPDATE combat_sessions SET current_actor_id = ?, round = ?, updated_at = ? WHERE id = ?')
        .run(order[nextIndex], round, nowIso(), session.id);
    return { currentActorId: order[nextIndex], round };
}

function autoActionFor(db, combatId, actor, rng, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const enemyParticipants = participants(db, combatId).filter((entry) => entry.side !== actor.side && entry.alive);
    if (!enemyParticipants.length) return null;
    const skills = skillDefinitionsForParticipant(db, pkg, actor);
    const template = parseJson(actor.template_json, {});
    const available = skills.filter((skill) => {
        if (Number(actor.mp) < Number(skill.mpCost ?? 0)) return false;
        if (Number(template.cooldowns?.[skill.key] ?? 0) > 0) return false;
        return true;
    });
    const healSkill = available.find((skill) => skill.type === 'heal');
    if (healSkill && Number(actor.hp) / Math.max(1, Number(actor.max_hp)) < 0.35) {
        return { type: 'skill', skillKey: healSkill.key, targetId: actor.id };
    }
    if (available.length && rng.next() < 0.45) {
        const skill = available[Math.floor(rng.next() * available.length)];
        return { type: 'skill', skillKey: skill.key, targetId: enemyParticipants[0].id };
    }
    const target = enemyParticipants.sort((a, b) => Number(a.hp) - Number(b.hp))[0];
    return { type: 'attack', targetId: target.id };
}

function recordAction(db, session, actor, action, result, idempotencyKey = null) {
    const sequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM combat_actions WHERE combat_session_id = ?').get(session.id).sequence;
    db.prepare(`
        INSERT INTO combat_actions (id, combat_session_id, sequence, actor_id, action_type, action_json, result_json, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid('act_'), session.id, sequence, actor.id, action.type, asJson(action), asJson(result), idempotencyKey, nowIso());
    return sequence;
}

function performAction(db, session, actor, action, rng, campaignId) {
    if (action.type === 'attack') return performAttack(db, session.id, actor, action, rng, campaignId);
    if (action.type === 'skill') return performSkill(db, session.id, actor, action, rng, campaignId);
    if (action.type === 'guard') return performGuard(db, actor);
    if (action.type === 'item') return performItem(db, session.id, actor, action, campaignId);
    if (action.type === 'flee') return performFlee(db, session.id, actor, rng, campaignId);
    throw new ValidationError(`Unknown combat action '${action.type}'`);
}

function runUntilPlayer(db, sessionId, rng) {
    let guard = 0;
    while (guard++ < 200) {
        let session = getSession(db, sessionId);
        if (!['active', 'pending'].includes(session.status)) return session;
        const current = participantById(db, sessionId, session.current_actor_id);
        if (!current) return session;
        const began = beginTurn(db, current, rng);
        if (began.log.length) recordAction(db, session, current, { type: 'turn_start' }, { log: began.log });
        if (!current.alive) {
            const ended = checkEnd(db, session, rng);
            if (ended) return getSession(db, sessionId);
            advanceTurn(db, session);
            continue;
        }
        if (began.skip) {
            recordAction(db, session, current, { type: 'skip' }, { log: [actionLog(`${current.name} is controlled and cannot act.`)] });
            advanceTurn(db, session);
            continue;
        }
        if (current.is_player) return getSession(db, sessionId);
        const autoAction = autoActionFor(db, sessionId, current, rng, session.campaign_id);
        if (!autoAction) {
            advanceTurn(db, session);
            continue;
        }
        const result = performAction(db, session, current, autoAction, rng, session.campaign_id);
        recordAction(db, session, current, autoAction, result);
        const ended = checkEnd(db, session, rng);
        if (ended) return getSession(db, sessionId);
        advanceTurn(db, session);
    }
    return getSession(db, sessionId);
}

export function combatView(db, combatId, options = {}) {
    const session = getSession(db, combatId);
    const all = participants(db, combatId);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
    const pkg = getCampaignPackage(db, session.campaign_id);
    const current = all.find((entry) => entry.id === session.current_actor_id) ?? null;
    const currentTemplate = current ? parseJson(current.template_json, {}) : {};
    const actions = db.prepare('SELECT * FROM combat_actions WHERE combat_session_id = ? ORDER BY sequence DESC LIMIT 40').all(combatId)
        .map((row) => ({
            sequence: row.sequence,
            actorId: row.actor_id,
            type: row.action_type,
            action: parseJson(row.action_json, {}),
            result: parseJson(row.result_json, {}),
            at: row.created_at,
        })).reverse();
    const player = getPlayer(db, session.campaign_id);
    const skills = current?.is_player ? skillDefinitionsForParticipant(db, pkg, current) : [];
    const cooldowns = currentTemplate.cooldowns ?? {};
    const items = current?.is_player ? listInventory(db, session.campaign_id, player.id).filter((item) => item.kind === 'consumable') : [];
    const turnOrder = parseJson(session.turn_order_json, []).map((id) => all.find((entry) => entry.id === id)).filter(Boolean);
    return {
        id: session.id,
        campaignId: session.campaign_id,
        encounterKey: session.encounter_key,
        status: session.status,
        round: session.round,
        locationId: session.location_id,
        currentActorId: session.current_actor_id,
        isPlayerTurn: Boolean(current?.is_player && session.status === 'active'),
        currentActor: current ? participantView(db, current, pkg) : null,
        participants: all.map((entry) => participantView(db, entry, pkg)),
        turnOrder: turnOrder.map((entry) => ({ id: entry.id, name: entry.name, side: entry.side, alive: Boolean(entry.alive) })),
        actions,
        skills: skills.map((skill) => ({
            ...skill,
            cooldownRemaining: Number(cooldowns[skill.key] ?? 0),
            available: Number(current?.mp ?? 0) >= Number(skill.mpCost ?? 0) && Number(cooldowns[skill.key] ?? 0) === 0 && session.status === 'active',
        })),
        items,
        result: parseJson(session.result_json, null),
        canFlee: session.status === 'active',
        createdAt: session.started_at ?? session.updated_at,
        updatedAt: session.updated_at,
        campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
        rules: { damageFormulas: pkg.rules?.formulas ?? {} },
    };
}

function participantView(db, participant, pkg) {
    const template = parseJson(participant.template_json, {});
    const statuses = parseJson(participant.statuses_json, []);
    return {
        id: participant.id,
        entityId: participant.entity_id,
        name: participant.name,
        side: participant.side,
        hp: Number(participant.hp),
        maxHp: Number(participant.max_hp),
        mp: Number(participant.mp),
        maxMp: Number(participant.max_mp),
        initiative: Number(participant.initiative),
        orderIndex: Number(participant.order_index),
        alive: Boolean(participant.alive),
        isPlayer: Boolean(participant.is_player),
        guarding: Boolean(template.guarding),
        statuses,
        stats: parseJson(participant.stats_json, {}),
        resistances: parseJson(participant.resistances_json, {}),
        template: {
            monsterKey: template.monsterKey ?? null,
            skills: (template.skills ?? []).map((key) => (pkg.skills ?? []).find((skill) => skill.key === key)?.name ?? key),
            portrait: template.portrait ?? null,
            ai: template.ai ?? null,
        },
    };
}

export function proposeEncounter(db, campaignId, input) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found', 'CAMPAIGN_NOT_FOUND');
    const pkg = getCampaignPackage(db, campaignId);
    const rawMonsters = Array.isArray(input.monsters) ? input.monsters : [];
    if (!rawMonsters.length) throw new ValidationError('At least one monster is required');
    const monsterMap = new Map((pkg.monsters ?? []).map((monster) => [monster.key, monster]));
    const encounter = [];
    for (const entry of rawMonsters) {
        const key = entry.monsterKey ?? entry.key;
        const count = Math.min(MAX_ENEMIES, Math.max(1, Number(entry.count ?? 1)));
        if (!monsterMap.has(key)) throw new ValidationError(`Monster '${key}' is not defined in this game`);
        for (let index = 0; index < count; index += 1) encounter.push({ monster: monsterMap.get(key), index });
    }
    if (encounter.length > MAX_ENEMIES) throw new ValidationError(`An encounter can contain at most ${MAX_ENEMIES} enemies`);
    const spawnKey = input.spawnKey ?? (String(input.encounterKey ?? '').startsWith('random:') ? '__random__' : input.encounterKey);
    if (spawnKey) assertEncounterAvailable(db, campaignId, campaign.current_location_id, spawnKey);
    const existing = db.prepare("SELECT id FROM combat_sessions WHERE campaign_id = ? AND status IN ('pending', 'active')").get(campaignId);
    if (existing) throw new ConflictError('A combat encounter is already pending or active', 'COMBAT_ALREADY_ACTIVE', { combatId: existing.id });
    const player = getPlayer(db, campaignId);
    if (Number(player.hp) <= 0) throw new ConflictError('The player is unable to fight', 'PLAYER_DOWN');
    const combatId = uuid('cmb_');
    const now = nowIso();
    return withTransaction(db, () => {
        db.prepare(`
            INSERT INTO combat_sessions (id, campaign_id, encounter_key, status, location_id, round, turn_order_json, rng_state, updated_at)
            VALUES (?, ?, ?, 'pending', ?, 1, '[]', ?, ?)
        `).run(combatId, campaignId, String(input.encounterKey ?? `encounter_${Date.now()}`), campaign.current_location_id, newSeed(), now);
        const party = db.prepare(`
            SELECT * FROM entities WHERE campaign_id = ? AND (is_player = 1 OR (kind = 'npc' AND json_extract(data_json, '$.party') = 1))
        `).all(campaignId);
        for (const entity of party) {
            if (entity.is_player) {
                const computed = computeEntityStats(db, entity.id);
                const skillRows = db.prepare(`
                    SELECT s.data_json FROM entity_skills es JOIN skill_definitions s ON s.id = es.skill_definition_id WHERE es.entity_id = ?
                `).all(entity.id);
                db.prepare(`
                    INSERT INTO combat_participants (
                        id, combat_session_id, entity_id, name, side, initiative, order_index, hp, max_hp,
                        mp, max_mp, stats_json, resistances_json, statuses_json, alive, is_player, template_json
                    ) VALUES (?, ?, ?, ?, 'party', 0, 0, ?, ?, ?, ?, ?, '{}', '[]', 1, 1, ?)
                `).run(
                    uuid('cp_'), combatId, entity.id, entity.name, Math.min(entity.hp, computed.stats.maxHp), computed.stats.maxHp,
                    Math.min(entity.mp, computed.stats.maxMp), computed.stats.maxMp, JSON.stringify(computed.stats),
                    JSON.stringify({ classKey: parseJson(entity.data_json, {}).classKey, skills: skillRows.map((row) => parseJson(row.data_json, {}).key), cooldowns: {}, guarding: false }),
                );
            } else {
                const computed = computeEntityStats(db, entity.id);
                db.prepare(`
                    INSERT INTO combat_participants (
                        id, combat_session_id, entity_id, name, side, initiative, order_index, hp, max_hp,
                        mp, max_mp, stats_json, resistances_json, statuses_json, alive, is_player, template_json
                    ) VALUES (?, ?, ?, ?, 'party', 0, 0, ?, ?, ?, ?, ?, '{}', '[]', 1, 0, ?)
                `).run(
                    uuid('cp_'), combatId, entity.id, entity.name, Math.min(entity.hp, computed.stats.maxHp), computed.stats.maxHp,
                    Math.min(entity.mp, computed.stats.maxMp), computed.stats.maxMp, JSON.stringify(computed.stats),
                    JSON.stringify({ companion: true, skills: [], cooldowns: {}, guarding: false }),
                );
            }
        }
        for (const { monster, index } of encounter) {
            const raw = monster.stats ?? {};
            const hp = Math.max(1, Math.round(Number(raw.maxHp ?? 60 + Number(monster.level ?? 1) * 15) * Number(pkg.rules?.enemyScaling?.hp ?? 1)));
            const mp = Math.max(0, Math.round(Number(raw.maxMp ?? 10)));
            const stats = {
                maxHp: hp, maxMp: mp, hp, mp,
                str: Number(raw.str ?? 8 + Number(monster.level ?? 1)), agi: Number(raw.agi ?? 6), int: Number(raw.int ?? 5),
                vit: Number(raw.vit ?? 6), luck: Number(raw.luck ?? 4),
                atk: Number(raw.atk ?? 10 + Number(monster.level ?? 1) * 2),
                mag: Number(raw.mag ?? 6), def: Number(raw.def ?? 4), res: Number(raw.res ?? 3),
                hit: Number(raw.hit ?? 85), evade: Number(raw.evade ?? 5), crit: Number(raw.crit ?? 5),
                speed: Number(raw.agi ?? 6), level: Number(monster.level ?? 1),
            };
            const count = encounter.filter((entry) => entry.monster.key === monster.key).length;
            const name = count > 1 ? `${monster.name} ${String.fromCharCode(65 + index)}` : monster.name;
            db.prepare(`
                INSERT INTO combat_participants (
                    id, combat_session_id, entity_id, name, side, initiative, order_index, hp, max_hp,
                    mp, max_mp, stats_json, resistances_json, statuses_json, alive, is_player, template_json
                ) VALUES (?, ?, NULL, ?, 'enemy', 0, 0, ?, ?, ?, ?, ?, ?, '[]', 1, 0, ?)
            `).run(
                uuid('cp_'), combatId, name, hp, hp, mp, mp, JSON.stringify(stats),
                JSON.stringify(monster.resistances ?? {}), JSON.stringify({
                    monsterKey: monster.key, skills: monster.skills ?? [], drops: monster.drops ?? [],
                    exp: monster.exp ?? 10, gold: monster.gold ?? 5, ai: monster.ai ?? 'aggressive', cooldowns: {}, guarding: false,
                    portrait: monster.portrait ?? null,
                }),
            );
        }
        insertEvent(db, campaignId, 'combat.proposed', {
            combatId, encounterKey: input.encounterKey, monsters: rawMonsters, locationId: campaign.current_location_id,
        });
        return combatView(db, combatId);
    });
}

export function startCombat(db, combatId) {
    return withTransaction(db, () => {
        const session = getSession(db, combatId);
        if (session.status === 'active') return combatView(db, combatId);
        if (session.status !== 'pending') throw new ConflictError('Combat cannot be started in its current state', 'COMBAT_NOT_PENDING', { status: session.status });
        const rng = createRng(session.rng_state);
        const all = participants(db, combatId);
        for (const participant of all) {
            const initiative = Number(effectiveStats(participant).agi ?? 0) + rng.int(1, 20);
            db.prepare('UPDATE combat_participants SET initiative = ? WHERE id = ?').run(initiative, participant.id);
        }
        const ordered = participants(db, combatId).sort((a, b) => Number(b.initiative) - Number(a.initiative));
        ordered.forEach((participant, index) => {
            db.prepare('UPDATE combat_participants SET order_index = ? WHERE id = ?').run(index, participant.id);
        });
        const order = ordered.map((participant) => participant.id);
        const first = order[0];
        db.prepare(`
            UPDATE combat_sessions SET status = 'active', started_at = ?, updated_at = ?, turn_order_json = ?,
                current_actor_id = ?, round = 1, rng_state = ? WHERE id = ?
        `).run(nowIso(), nowIso(), JSON.stringify(order), first, rng.state, combatId);
        insertEvent(db, session.campaign_id, 'combat.started', { combatId, order });
        const updated = runUntilPlayer(db, combatId, rng);
        db.prepare('UPDATE combat_sessions SET rng_state = ?, updated_at = ? WHERE id = ?').run(rng.state, nowIso(), combatId);
        return combatView(db, combatId);
    });
}

export function applyCombatAction(db, combatId, input) {
    return withTransaction(db, () => {
        const session = getSession(db, combatId);
        if (session.status !== 'active') throw new ConflictError('Combat is not active', 'COMBAT_NOT_ACTIVE', { status: session.status });
        const current = participantById(db, combatId, session.current_actor_id);
        if (!current) throw new ConflictError('Combat has no current actor', 'NO_CURRENT_ACTOR');
        if (!current.is_player) throw new ConflictError('It is not the player turn', 'NOT_PLAYER_TURN', { currentActor: current.name });
        if (input.actorId && input.actorId !== current.id) throw new ConflictError('Actor does not match current turn', 'ACTOR_MISMATCH');
        const action = input.action ?? input;
        if (!['attack', 'skill', 'guard', 'item', 'flee'].includes(action.type)) throw new ValidationError('Unsupported combat action');
        const rng = createRng(session.rng_state);
        const result = performAction(db, session, current, action, rng, session.campaign_id);
        const sequence = recordAction(db, session, current, action, result, input.idempotencyKey ?? null);
        insertEvent(db, session.campaign_id, 'combat.action', {
            combatId, sequence, actorId: current.id, actionType: action.type, result,
        });
        if (result.fled) {
            syncParticipantResources(db, combatId);
            const output = {
                outcome: 'fled',
                summary: `${current.name} escapes from combat.`,
                finishedAt: nowIso(),
            };
            db.prepare("UPDATE combat_sessions SET status = 'fled', result_json = ?, ended_at = ?, updated_at = ? WHERE id = ?")
                .run(asJson(output), nowIso(), nowIso(), combatId);
            resetEncounterSpawn(db, session.campaign_id, session.location_id, spawnKeyForSession(session));
            campaignSnapshot(db, session.campaign_id, `Fled: ${session.encounter_key}`, true);
            return { ...combatView(db, combatId), lastAction: result };
        }
        const ended = checkEnd(db, session, rng);
        if (!ended) {
            advanceTurn(db, session);
            runUntilPlayer(db, combatId, rng);
        }
        db.prepare('UPDATE combat_sessions SET rng_state = ?, updated_at = ? WHERE id = ?').run(rng.state, nowIso(), combatId);
        if (!ended) campaignSnapshot(db, session.campaign_id, `Combat turn: ${session.encounter_key}`, true);
        return { ...combatView(db, combatId), lastAction: result };
    });
}

export function saveCombat(db, combatId) {
    const session = getSession(db, combatId);
    const snapshot = campaignSnapshot(db, session.campaign_id, `Manual combat save: ${session.encounter_key}`, false);
    insertEvent(db, session.campaign_id, 'combat.saved', { combatId, snapshotId: snapshot.id });
    return { ok: true, snapshot, combat: combatView(db, combatId) };
}

export function getCombatForCampaign(db, campaignId) {
    const session = db.prepare(`
        SELECT * FROM combat_sessions WHERE campaign_id = ? AND status IN ('pending', 'active', 'victory', 'defeat', 'fled')
        ORDER BY updated_at DESC LIMIT 1
    `).get(campaignId);
    return session ? combatView(db, session.id) : null;
}

export function getPendingCombat(db, campaignId) {
    const session = db.prepare("SELECT * FROM combat_sessions WHERE campaign_id = ? AND status IN ('pending', 'active') ORDER BY updated_at DESC LIMIT 1").get(campaignId);
    return session ? combatView(db, session.id) : null;
}

export function getCombatContextForLLM(db, campaignId) {
    const combat = getCombatForCampaign(db, campaignId);
    if (!combat) return { hasCombat: false };
    return {
        hasCombat: true,
        id: combat.id,
        status: combat.status,
        round: combat.round,
        isPlayerTurn: combat.isPlayerTurn,
        currentActor: combat.currentActor,
        participants: combat.participants.map((participant) => ({
            name: participant.name, side: participant.side, hp: participant.hp, maxHp: participant.maxHp,
            mp: participant.mp, maxMp: participant.maxMp, alive: participant.alive, statuses: participant.statuses.map((status) => status.name),
        })),
        recentLog: combat.actions.slice(-8).map((action) => action.result?.log ?? []).flat().map((entry) => entry.text),
        result: combat.result,
        instruction: 'Combat numbers are authoritative in STRPG. Narrate the provided log only; do not invent damage, HP, MP, EXP or loot.',
    };
}


