import { evaluateCondition, getCampaignVariable } from './conditions.js';
import { addItem, countItem, getItemDefinition, itemView, removeItem } from './inventory.js';
import { getNpcByKey, npcData } from './interactions.js';
import { queueCandidate } from './bridge.js';
import { getEntityView, getPlayer, healEntity, unlockSkill } from './stats.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { clamp, insertEvent, nowIso, parseJson, withTransaction } from './util.js';

/**
 * M2 social layer: configurable NPC services that start in chat and end in a reviewed
 * transaction. Every proposal is a `bridge_candidates` row; nothing is charged until the
 * player approves it.
 *
 * Configurable NPC fields (schemas.js):
 *   recruit  { enabled, cost:{gold,items}, relationRequired, condition, maxParty }
 *   teaching [{ skillKey, tuition:{gold,items}, relationRequired, condition }]
 *   recovery { enabled, hpThreshold, methods:[{key,label,restoreHp,restoreMp,relationDelta,cost}] }
 *   shop.haggle { enabled, maxDiscount }
 */

export const PARTY_LIMIT = 3;
export const COST_ITEM_MAX = 10;

function campaignRow(db, campaignId) {
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return row;
}

function definitionOf(db, campaignId, npcKey) {
    return npcData(db, campaignId, npcKey).definition;
}

function relationOf(db, campaignId, npcKey) {
    const value = getCampaignVariable(db, campaignId, `npc:${npcKey}:relation`);
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function setRelation(db, campaignId, npcKey, value) {
    db.prepare(`
        INSERT INTO campaign_variables (campaign_id, var_key, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(campaign_id, var_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(campaignId, `npc:${npcKey}:relation`, JSON.stringify(value), nowIso());
}

function isPartyMember(db, campaignId, npcKey) {
    const entity = getNpcByKey(db, campaignId, npcKey);
    return Boolean(parseJson(entity.data_json, {}).party);
}

function partyCount(db, campaignId) {
    return db.prepare(`
        SELECT COUNT(*) AS count FROM entities WHERE campaign_id = ? AND kind = 'npc' AND json_extract(data_json, '$.party') = 1
    `).get(campaignId).count;
}

export function normalizeCost(cost = {}) {
    const gold = Math.max(0, Math.round(Number(cost?.gold ?? 0)));
    const items = (Array.isArray(cost?.items) ? cost.items : [])
        .map((entry) => ({ itemKey: String(entry.itemKey ?? entry.key ?? ''), quantity: clamp(Math.round(Number(entry.quantity ?? 1)), 1, COST_ITEM_MAX) }))
        .filter((entry) => entry.itemKey);
    return {
        gold,
        items,
        signal: cost?.signal ? String(cost.signal).trim() : null,
        flag: cost?.flag ? String(cost.flag).trim() : null,
        questKey: cost?.questKey ? String(cost.questKey).trim() : null,
        manual: cost?.manual === true,
        autoApprove: cost?.autoApprove !== false,
    };
}

function describeCost(cost) {
    const parts = [];
    if (cost.gold) parts.push(`${cost.gold} gold`);
    for (const item of cost.items) parts.push(`${item.itemKey} x${item.quantity}`);
    if (cost.signal) parts.push(`signal:${cost.signal}`);
    if (cost.flag) parts.push(`flag:${cost.flag}`);
    if (cost.questKey) parts.push(`quest:${cost.questKey}`);
    if (cost.manual) parts.push('manual confirmation');
    return parts.join(' + ') || 'nothing';
}

function questStatusOf(db, campaignId, questKey) {
    return db.prepare('SELECT status FROM quest_instances WHERE campaign_id = ? AND quest_key = ?').get(campaignId, questKey)?.status ?? 'unavailable';
}

/**
 * Non-numeric requirements (signal / flag / quest / manual). Signals are receipts the chat
 * or an event can send when the player actually did the favour.
 */
export function requirementStatus(db, campaignId, cost) {
    const normalized = normalizeCost(cost);
    const checks = [];
    if (normalized.signal) {
        checks.push({
            kind: 'signal', key: normalized.signal,
            satisfied: Boolean(getCampaignVariable(db, campaignId, `signal:${normalized.signal}`)),
        });
    }
    if (normalized.flag) {
        checks.push({
            kind: 'flag', key: normalized.flag,
            satisfied: Boolean(getCampaignVariable(db, campaignId, `flag:${normalized.flag}`)),
        });
    }
    if (normalized.questKey) {
        checks.push({
            kind: 'quest', key: normalized.questKey,
            satisfied: ['completed', 'turned_in'].includes(questStatusOf(db, campaignId, normalized.questKey)),
        });
    }
    if (normalized.manual) checks.push({ kind: 'manual', satisfied: true });
    return { checks, satisfied: checks.every((check) => check.satisfied), missing: checks.filter((check) => !check.satisfied), cost: normalized };
}

function assertRequirements(db, campaignId, cost, options = {}) {
    const status = requirementStatus(db, campaignId, cost);
    if (status.satisfied) return status;
    if (options.overrideReason) {
        return { ...status, overridden: true, overrideReason: String(options.overrideReason).slice(0, 300) };
    }
    throw new ConflictError(`Waiting for ${status.missing.map((check) => `${check.kind}:${check.key}`).join(', ')}`, 'AWAITING_SIGNAL', {
        missing: status.missing,
        hint: 'Send the signal (POST /bridge/signals/:name), or approve with an override reason.',
    });
}


export function affordability(db, campaignId, entityId, cost) {
    const entity = getPlayer(db, campaignId);
    const missing = [];
    if (Number(entity.gold) < cost.gold) missing.push({ kind: 'gold', required: cost.gold, have: Number(entity.gold) });
    for (const item of cost.items) {
        const have = countItem(db, campaignId, entityId ?? entity.id, item.itemKey);
        if (have < item.quantity) missing.push({ kind: 'item', itemKey: item.itemKey, required: item.quantity, have });
    }
    return { ok: missing.length === 0, missing, gold: Number(entity.gold) };
}

function charge(db, campaignId, cost, options = {}) {
    const player = getPlayer(db, campaignId);
    const requirements = assertRequirements(db, campaignId, cost, options);
    const check = affordability(db, campaignId, player.id, cost);
    if (!check.ok) throw new ConflictError(`Not enough to pay ${describeCost(cost)}`, 'INSUFFICIENT_PAYMENT', check);
    if (cost.gold > 0) {
        db.prepare('UPDATE entities SET gold = gold - ?, updated_at = ? WHERE id = ?').run(cost.gold, nowIso(), player.id);
    }
    for (const item of cost.items) {
        removeItem(db, campaignId, player.id, item.itemKey, item.quantity, { source: 'npc-service' });
    }
    // A favour signal is a one-shot receipt: consume it after the service is paid for.
    if (cost.signal) {
        db.prepare('DELETE FROM campaign_variables WHERE campaign_id = ? AND var_key = ?').run(campaignId, `signal:${cost.signal}`);
    }
    return { paid: cost, gold: Number(player.gold) - cost.gold, requirements };
}

function skillKnown(db, campaignId, entityId, skillKey) {
    const campaign = campaignRow(db, campaignId);
    return Boolean(db.prepare(`
        SELECT 1 FROM entity_skills es JOIN skill_definitions s ON s.id = es.skill_definition_id
        WHERE es.entity_id = ? AND s.skill_key = ? AND s.game_version_id = ?
    `).get(entityId, skillKey, campaign.game_version_id));
}

function skillName(db, campaignId, skillKey) {
    const campaign = campaignRow(db, campaignId);
    return db.prepare('SELECT name FROM skill_definitions WHERE game_version_id = ? AND skill_key = ?')
        .get(campaign.game_version_id, skillKey)?.name ?? skillKey;
}

/* ------------------------------------------------------------------ trade */

/**
 * Price a purchase from an NPC shop. The server, not the model, decides the floor:
 * relation and the player's int/luck move the discount, capped by shop.haggle.maxDiscount.
 */
export function quoteTrade(db, campaignId, input = {}) {
    const npcKey = String(input.npcKey ?? '').trim();
    const itemKey = String(input.itemKey ?? '').trim();
    if (!npcKey || !itemKey) throw new ValidationError('npcKey and itemKey are required');
    const quantity = clamp(Math.round(Number(input.quantity ?? 1)), 1, 20);
    const definition = definitionOf(db, campaignId, npcKey);
    const shop = definition.shop;
    if (!shop) throw new NotFoundError(`'${definition.name}' has no shop`, 'SHOP_NOT_FOUND');
    const entry = (shop.items ?? []).find((candidate) => candidate.itemKey === itemKey);
    if (!entry) throw new ConflictError(`'${definition.name}' does not sell '${itemKey}'`, 'NOT_IN_SHOP');
    const item = getItemDefinition(db, campaignId, itemKey);
    if (!item) throw new NotFoundError(`Item '${itemKey}' does not exist`, 'ITEM_DEFINITION_NOT_FOUND');
    const view = itemView(item);
    const unitList = Math.max(0, Math.round(Number(entry.price ?? view.price) * Number(shop.buyRate ?? 1)));
    const player = getEntityView(db, getPlayer(db, campaignId).id);
    const relation = relationOf(db, campaignId, npcKey);
    const haggle = shop.haggle ?? {};
    const maxDiscount = clamp(Number(haggle.maxDiscount ?? 0.3), 0, 0.5);
    const discount = clamp(
        0.02 + Math.max(0, relation) * 0.01 + Number(player.stats?.int ?? 0) * 0.003 + Number(player.stats?.luck ?? 0) * 0.002,
        0,
        maxDiscount,
    );
    const unitBest = Math.max(1, Math.round(unitList * (1 - discount)));
    const minimum = Math.max(1, Math.round(unitList * 0.35));
    const offer = input.offerPrice == null ? unitList : Math.max(0, Math.round(Number(input.offerPrice)));
    const insulting = offer > 0 && offer < minimum;
    const accepted = offer >= unitBest && !insulting;
    const unitFinal = insulting ? null : (accepted ? offer : unitBest);
    return {
        npcKey,
        npcName: definition.name,
        itemKey,
        itemName: view.name,
        quantity,
        unitList,
        unitBest,
        minimum,
        unitFinal,
        totalList: unitList * quantity,
        totalFinal: unitFinal == null ? null : unitFinal * quantity,
        discount: Math.round(discount * 100) / 100,
        relation,
        accepted,
        countered: !accepted && !insulting,
        insulting,
        gold: Number(player.gold),
    };
}

export function proposeTrade(db, campaignId, input = {}) {
    const quote = quoteTrade(db, campaignId, input);
    if (quote.insulting) {
        throw new ConflictError(`${quote.npcName} refuses ${quote.unitFinal ?? quote.itemName}: the offer is insulting`, 'OFFER_TOO_LOW', quote);
    }
    const candidate = queueCandidate(db, campaignId, {
        kind: 'trade',
        source: input.source ?? 'chat',
        payload: {
            npcKey: quote.npcKey,
            npcName: quote.npcName,
            itemKey: quote.itemKey,
            itemName: quote.itemName,
            quantity: quote.quantity,
            unitPrice: quote.unitFinal,
            unitList: quote.unitList,
            total: quote.totalFinal,
            accepted: quote.accepted,
            countered: quote.countered,
        },
        evidence: input.evidence ?? { quote },
        confidence: input.confidence,
    });
    return { quote, ...candidate };
}

export function applyTrade(db, campaignId, candidate) {
    const payload = candidate.payload ?? {};
    const quote = quoteTrade(db, campaignId, {
        npcKey: payload.npcKey,
        itemKey: payload.itemKey,
        quantity: payload.quantity,
        offerPrice: payload.unitPrice,
    });
    if (!quote.accepted || quote.unitFinal !== payload.unitPrice) {
        throw new ConflictError('The quoted price is no longer valid. Ask again.', 'QUOTE_STALE', quote);
    }
    const player = getPlayer(db, campaignId);
    const total = quote.totalFinal;
    if (Number(player.gold) < total) throw new ConflictError('Not enough gold', 'INSUFFICIENT_GOLD', { required: total, gold: Number(player.gold) });
    db.prepare('UPDATE entities SET gold = gold - ?, updated_at = ? WHERE id = ?').run(total, nowIso(), player.id);
    addItem(db, campaignId, player.id, payload.itemKey, quote.quantity, { source: `trade:${candidate.id}` });
    if (quote.unitList > quote.unitFinal) {
        setRelation(db, campaignId, payload.npcKey, clamp(relationOf(db, campaignId, payload.npcKey) + 1, -100, 100));
    }
    insertEvent(db, campaignId, 'trade.completed', {
        npcKey: payload.npcKey, itemKey: payload.itemKey, quantity: quote.quantity,
        unitPrice: quote.unitFinal, total, candidateId: candidate.id,
    }, `bridge-trade:${candidate.id}`);
    return { target: 'trade', npcKey: payload.npcKey, itemKey: payload.itemKey, quantity: quote.quantity, total, gold: Number(player.gold) - total };
}

/* -------------------------------------------------------------- recruit */

export function proposeRecruit(db, campaignId, input = {}) {
    const npcKey = String(input.npcKey ?? '').trim();
    const definition = definitionOf(db, campaignId, npcKey);
    const policy = definition.recruit;
    if (!policy?.enabled && !definition.joinable) {
        throw new ConflictError(`${definition.name} is not willing to join the party`, 'RECRUIT_NOT_AVAILABLE');
    }
    if (isPartyMember(db, campaignId, npcKey)) throw new ConflictError(`${definition.name} is already in the party`, 'ALREADY_IN_PARTY');
    const limit = clamp(Number(policy?.maxParty ?? PARTY_LIMIT), 1, 4);
    if (partyCount(db, campaignId) >= limit) throw new ConflictError('Party is full', 'PARTY_FULL', { limit });
    const relationRequired = Number(policy?.relationRequired ?? 0);
    const relation = relationOf(db, campaignId, npcKey);
    if (relation < relationRequired) {
        throw new ConflictError(`${definition.name} needs more trust first (${relation}/${relationRequired})`, 'RELATION_TOO_LOW', { relation, relationRequired });
    }
    const condition = policy?.condition ?? definition.joinCondition ?? {};
    if (!evaluateCondition(db, campaignId, condition, { type: 'join', targetKey: npcKey })) {
        throw new ConflictError(`${definition.name} refuses to join yet`, 'JOIN_CONDITION_FAILED');
    }
    const cost = normalizeCost(policy?.cost ?? {});
    const check = affordability(db, campaignId, null, cost);
    if (!check.ok) throw new ConflictError(`Cannot pay the recruiting cost (${describeCost(cost)})`, 'INSUFFICIENT_PAYMENT', check);
    const candidate = queueCandidate(db, campaignId, {
        kind: 'recruit',
        source: input.source ?? 'chat',
        payload: { npcKey, npcName: definition.name, cost, requirements: requirementStatus(db, campaignId, cost), relation, relationRequired },
        evidence: input.evidence ?? {},
        confidence: input.confidence,
    });
    return { cost, relation, ...candidate };
}

export function applyRecruit(db, campaignId, candidate, options = {}) {
    const payload = candidate.payload ?? {};
    const definition = definitionOf(db, campaignId, payload.npcKey);
    if (isPartyMember(db, campaignId, payload.npcKey)) throw new ConflictError(`${definition.name} is already in the party`, 'ALREADY_IN_PARTY');
    if (partyCount(db, campaignId) >= PARTY_LIMIT) throw new ConflictError('Party is full', 'PARTY_FULL');
    const cost = normalizeCost(payload.cost ?? {});
    const paid = charge(db, campaignId, cost, options);
    const npcEntity = getNpcByKey(db, campaignId, payload.npcKey);
    const runtime = parseJson(npcEntity.data_json, {});
    runtime.party = true;
    db.prepare('UPDATE entities SET data_json = ?, updated_at = ? WHERE campaign_id = ? AND entity_key = ?')
        .run(JSON.stringify(runtime), nowIso(), campaignId, `npc:${payload.npcKey}`);
    for (const skillKey of definition.combat?.skills ?? []) unlockSkill(db, npcEntity.id, skillKey, campaignId);
    setRelation(db, campaignId, payload.npcKey, clamp(relationOf(db, campaignId, payload.npcKey) + 1, -100, 100));
    insertEvent(db, campaignId, 'npc.recruited', { npcKey: payload.npcKey, cost, candidateId: candidate.id }, `bridge-recruit:${candidate.id}`);
    return { target: 'party.join', npcKey: payload.npcKey, cost, paid, requirements: paid.requirements };
}

/* --------------------------------------------------------------- tuition */

export function proposeTuition(db, campaignId, input = {}) {
    const npcKey = String(input.npcKey ?? '').trim();
    const skillKey = String(input.skillKey ?? '').trim();
    if (!skillKey) throw new ValidationError('skillKey is required');
    const definition = definitionOf(db, campaignId, npcKey);
    const offerings = Array.isArray(definition.teaching) ? definition.teaching : [];
    const offer = offerings.find((entry) => entry.skillKey === skillKey);
    if (!offer) throw new ConflictError(`${definition.name} does not teach '${skillKey}'`, 'NOT_TEACHING');
    const player = getPlayer(db, campaignId);
    if (skillKnown(db, campaignId, player.id, skillKey)) {
        throw new ConflictError(`You already know ${skillName(db, campaignId, skillKey)}`, 'ALREADY_KNOWN');
    }
    const relationRequired = Number(offer.relationRequired ?? 0);
    const relation = relationOf(db, campaignId, npcKey);
    if (relation < relationRequired) {
        throw new ConflictError(`${definition.name} will not teach you yet (${relation}/${relationRequired})`, 'RELATION_TOO_LOW', { relation, relationRequired });
    }
    if (offer.condition && !evaluateCondition(db, campaignId, offer.condition, { type: 'tuition', targetKey: npcKey })) {
        throw new ConflictError(`${definition.name} refuses to teach you yet`, 'TUITION_CONDITION_FAILED');
    }
    const tuition = normalizeCost(offer.tuition ?? {});
    const check = affordability(db, campaignId, player.id, tuition);
    if (!check.ok) throw new ConflictError(`Cannot pay the tuition (${describeCost(tuition)})`, 'INSUFFICIENT_PAYMENT', check);
    const candidate = queueCandidate(db, campaignId, {
        kind: 'tuition',
        source: input.source ?? 'chat',
        payload: { npcKey, npcName: definition.name, skillKey, skillName: skillName(db, campaignId, skillKey), tuition, requirements: requirementStatus(db, campaignId, tuition), relation },
        evidence: input.evidence ?? {},
        confidence: input.confidence,
    });
    return { tuition, ...candidate };
}

export function applyTuition(db, campaignId, candidate, options = {}) {
    const payload = candidate.payload ?? {};
    const definition = definitionOf(db, campaignId, payload.npcKey);
    const offering = (definition.teaching ?? []).find((entry) => entry.skillKey === payload.skillKey);
    if (!offering) throw new ConflictError(`${definition.name} does not teach that skill`, 'NOT_TEACHING');
    const player = getPlayer(db, campaignId);
    if (skillKnown(db, campaignId, player.id, payload.skillKey)) throw new ConflictError('Skill already known', 'ALREADY_KNOWN');
    const paid = charge(db, campaignId, normalizeCost(offering.tuition ?? {}), options);
    unlockSkill(db, player.id, payload.skillKey, campaignId);
    setRelation(db, campaignId, payload.npcKey, clamp(relationOf(db, campaignId, payload.npcKey) + 1, -100, 100));
    insertEvent(db, campaignId, 'npc.tuition', { npcKey: payload.npcKey, skillKey: payload.skillKey, cost: paid.paid, candidateId: candidate.id }, `bridge-tuition:${candidate.id}`);
    return { target: 'skill.unlocked', npcKey: payload.npcKey, skillKey: payload.skillKey, tuition: paid.paid, requirements: paid.requirements };
}

/* -------------------------------------------------------------- recovery */

function npcVitals(db, campaignId, npcKey) {
    const entity = getNpcByKey(db, campaignId, npcKey);
    const view = getEntityView(db, entity.id);
    const maxHp = Math.max(1, Number(view.stats?.maxHp ?? 1));
    const maxMp = Math.max(0, Number(view.stats?.maxMp ?? 0));
    return { entity, view, maxHp, maxMp, hpRatio: Number(view.hp) / maxHp };
}

export function proposeRecovery(db, campaignId, input = {}) {
    const npcKey = String(input.npcKey ?? '').trim();
    const definition = definitionOf(db, campaignId, npcKey);
    const policy = definition.recovery;
    if (!policy?.enabled) throw new ConflictError(`${definition.name} has no recovery needs`, 'RECOVERY_NOT_AVAILABLE');
    const vitals = npcVitals(db, campaignId, npcKey);
    const threshold = clamp(Number(policy.hpThreshold ?? 0.4), 0, 1);
    if (vitals.hpRatio > threshold) {
        throw new ConflictError(`${definition.name} is holding up (${Math.round(vitals.hpRatio * 100)}% HP)`, 'RECOVERY_NOT_NEEDED', { hpRatio: vitals.hpRatio, threshold });
    }
    const methods = Array.isArray(policy.methods) ? policy.methods : [];
    const method = methods.find((entry) => entry.key === input.method) ?? methods[0];
    if (!method) throw new ConflictError('No recovery method is configured', 'RECOVERY_METHOD_MISSING');
    const cost = normalizeCost(method.cost ?? {});
    const player = getPlayer(db, campaignId);
    const check = affordability(db, campaignId, player.id, cost);
    if (!check.ok) throw new ConflictError(`Cannot pay the recovery cost (${describeCost(cost)})`, 'INSUFFICIENT_PAYMENT', check);
    const candidate = queueCandidate(db, campaignId, {
        kind: 'recovery',
        source: input.source ?? 'chat',
        payload: {
            npcKey,
            npcName: definition.name,
            method: method.key,
            label: method.label ?? method.key,
            restoreHp: clamp(Number(method.restoreHp ?? 0.3), 0, 1),
            restoreMp: clamp(Number(method.restoreMp ?? 0.2), 0, 1),
            relationDelta: clamp(Math.round(Number(method.relationDelta ?? 1)), 0, 2),
            cost,
            requirements: requirementStatus(db, campaignId, cost),
            hpRatio: Math.round(vitals.hpRatio * 100) / 100,
        },
        evidence: input.evidence ?? {},
        confidence: input.confidence,
    });
    return { hpRatio: vitals.hpRatio, ...candidate };
}

export function applyRecovery(db, campaignId, candidate, options = {}) {
    const payload = candidate.payload ?? {};
    const definition = definitionOf(db, campaignId, payload.npcKey);
    const policy = definition.recovery;
    if (!policy?.enabled) throw new ConflictError('Recovery is not available', 'RECOVERY_NOT_AVAILABLE');
    const vitals = npcVitals(db, campaignId, payload.npcKey);
    if (vitals.hpRatio > clamp(Number(policy.hpThreshold ?? 0.4), 0, 1)) {
        throw new ConflictError(`${definition.name} does not need help right now`, 'RECOVERY_NOT_NEEDED');
    }
    const paid = charge(db, campaignId, normalizeCost(payload.cost ?? {}), options);
    const healHp = Math.round(vitals.maxHp * Number(payload.restoreHp ?? 0.3));
    const healMp = Math.round(vitals.maxMp * Number(payload.restoreMp ?? 0.2));
    const healed = healEntity(db, vitals.entity.id, healHp, healMp);
    const delta = clamp(Math.round(Number(payload.relationDelta ?? 1)), 0, 2);
    if (delta > 0) setRelation(db, campaignId, payload.npcKey, clamp(relationOf(db, campaignId, payload.npcKey) + delta, -100, 100));
    insertEvent(db, campaignId, 'npc.recovery', { npcKey: payload.npcKey, method: payload.method, healHp, healMp, relationDelta: delta, candidateId: candidate.id }, `bridge-recovery:${candidate.id}`);
    return { target: 'npc.recovery', npcKey: payload.npcKey, method: payload.method, healHp, healMp, requirements: paid.requirements, ...healed };
}

/* --------------------------------------------------------------- options */

export function socialOptions(db, campaignId, npcKey) {
    const definition = definitionOf(db, campaignId, npcKey);
    const relation = relationOf(db, campaignId, npcKey);
    const player = getPlayer(db, campaignId);
    const inParty = isPartyMember(db, campaignId, npcKey);
    const shop = definition.shop ? {
        buyRate: definition.shop.buyRate ?? 1,
        haggle: definition.shop.haggle ?? { enabled: false, maxDiscount: 0.3 },
        items: (definition.shop.items ?? []).map((entry) => {
            const item = getItemDefinition(db, campaignId, entry.itemKey);
            const view = item ? itemView(item) : { itemKey: entry.itemKey, name: entry.itemKey, price: 0 };
            return {
                itemKey: entry.itemKey,
                name: view.name,
                unitList: Math.max(0, Math.round(Number(entry.price ?? view.price) * Number(definition.shop.buyRate ?? 1))),
                stock: entry.stock ?? null,
            };
        }),
    } : null;
    const recruit = definition.recruit ?? (definition.joinable ? { enabled: true, cost: { gold: 0, items: [] } } : null);
    let vitals = null;
    try { vitals = npcVitals(db, campaignId, npcKey); } catch { vitals = null; }
    return {
        npcKey,
        name: definition.name,
        relation,
        inParty,
        partyCount: partyCount(db, campaignId),
        playerGold: Number(player.gold),
        shop,
        recruit: recruit ? {
            enabled: Boolean(recruit.enabled),
            cost: normalizeCost(recruit.cost ?? {}),
            relationRequired: Number(recruit.relationRequired ?? 0),
            maxParty: clamp(Number(recruit.maxParty ?? PARTY_LIMIT), 1, 4),
        } : null,
        teaching: (definition.teaching ?? []).map((entry) => ({
            skillKey: entry.skillKey,
            skillName: skillName(db, campaignId, entry.skillKey),
            tuition: normalizeCost(entry.tuition ?? {}),
            relationRequired: Number(entry.relationRequired ?? 0),
            known: skillKnown(db, campaignId, player.id, entry.skillKey),
        })),
        recovery: definition.recovery ? {
            enabled: Boolean(definition.recovery.enabled),
            hpThreshold: clamp(Number(definition.recovery.hpThreshold ?? 0.4), 0, 1),
            hpRatio: vitals ? Math.round(vitals.hpRatio * 100) / 100 : null,
            needed: vitals ? vitals.hpRatio <= clamp(Number(definition.recovery.hpThreshold ?? 0.4), 0, 1) : false,
            methods: (definition.recovery.methods ?? []).map((entry) => ({
                key: entry.key, label: entry.label ?? entry.key,
                restoreHp: Number(entry.restoreHp ?? 0.3), restoreMp: Number(entry.restoreMp ?? 0.2),
                relationDelta: Number(entry.relationDelta ?? 1), cost: normalizeCost(entry.cost ?? {}),
            })),
        } : null,
    };
}

/** Dispatch used by bridge.approveCandidate for the social candidate kinds. */
export function applySocialCandidate(db, campaignId, candidate, options = {}) {
    if (candidate.kind === 'trade') return applyTrade(db, campaignId, candidate);
    if (candidate.kind === 'recruit') return applyRecruit(db, campaignId, candidate, options);
    if (candidate.kind === 'tuition') return applyTuition(db, campaignId, candidate, options);
    if (candidate.kind === 'recovery') return applyRecovery(db, campaignId, candidate, options);
    throw new ValidationError(`Unsupported social candidate kind '${candidate.kind}'`);
}

export const SOCIAL_KINDS = ['trade', 'recruit', 'tuition', 'recovery'];
