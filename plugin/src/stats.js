import { NotFoundError, ValidationError } from './errors.js';
import { evaluateFormula, DEFAULT_FORMULAS } from './formula.js';
import { insertEvent, nowIso, parseJson, uuid, withTransaction } from './util.js';

export const PRIMARY_STATS = ['maxHp', 'maxMp', 'str', 'agi', 'int', 'vit', 'luck'];
export const COMBAT_STATS = [...PRIMARY_STATS, 'atk', 'mag', 'def', 'res', 'hit', 'evade', 'crit', 'speed'];

export const STAT_LABELS = {
    maxHp: 'Max HP',
    maxMp: 'Max MP',
    str: 'Strength',
    agi: 'Agility',
    int: 'Intelligence',
    vit: 'Vitality',
    luck: 'Luck',
    atk: 'Attack',
    mag: 'Magic',
    def: 'Defense',
    res: 'Resistance',
    hit: 'Hit',
    evade: 'Evade',
    crit: 'Crit',
    speed: 'Speed',
    hp: 'HP',
    mp: 'MP',
};

export function getCampaignPackage(db, campaignId) {
    const row = db.prepare(`
        SELECT v.package_json FROM campaigns c JOIN game_versions v ON v.id = c.game_version_id WHERE c.id = ?
    `).get(campaignId);
    if (!row) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    return parseJson(row.package_json, null);
}

export function getEntity(db, entityId) {
    const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
    if (!entity) throw new NotFoundError(`Entity '${entityId}' not found`, 'ENTITY_NOT_FOUND');
    return entity;
}

export function getPlayer(db, campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new NotFoundError(`Campaign '${campaignId}' not found`, 'CAMPAIGN_NOT_FOUND');
    if (!campaign.player_entity_id) throw new NotFoundError('Campaign has no player entity', 'PLAYER_MISSING');
    return getEntity(db, campaign.player_entity_id);
}

export function getClassData(db, entity) {
    const data = parseJson(entity.data_json, {});
    if (entity.template_id) {
        const template = db.prepare('SELECT * FROM entity_templates WHERE id = ?').get(entity.template_id);
        if (template) return parseJson(template.data_json, {});
    }
    if (data.classKey) {
        const template = db.prepare(`
            SELECT t.* FROM entity_templates t
            JOIN campaigns c ON c.game_version_id = t.game_version_id
            WHERE c.id = ? AND t.kind = 'class' AND t.template_key = ?
        `).get(entity.campaign_id, data.classKey);
        if (template) return parseJson(template.data_json, {});
    }
    return null;
}

export function ensureStats(db, entityId, stats = {}) {
    const insert = db.prepare(`
        INSERT INTO entity_stats (entity_id, stat_key, base_value, permanent_bonus, temporary_bonus)
        VALUES (?, ?, ?, 0, 0)
        ON CONFLICT(entity_id, stat_key) DO NOTHING
    `);
    for (const key of [...PRIMARY_STATS, 'atk', 'mag', 'def', 'res', 'hit', 'evade', 'crit']) {
        insert.run(entityId, key, Number(stats[key] ?? 0));
    }
}

export function addPermanentBonus(db, entityId, statKey, amount) {
    ensureStats(db, entityId, {});
    db.prepare(`
        UPDATE entity_stats SET permanent_bonus = permanent_bonus + ? WHERE entity_id = ? AND stat_key = ?
    `).run(Number(amount), entityId, statKey);
}

export function getBaseStats(db, entityId) {
    const rows = db.prepare('SELECT * FROM entity_stats WHERE entity_id = ?').all(entityId);
    const output = {};
    for (const row of rows) output[row.stat_key] = Number(row.base_value) + Number(row.permanent_bonus);
    return output;
}

export function getEquipmentModifiers(db, entityId) {
    const rows = db.prepare(`
        SELECT i.*, e.slot AS equipped_slot, d.data_json FROM equipment_slots e
        JOIN inventory i ON i.id = e.inventory_id
        JOIN item_definitions d ON d.id = i.item_definition_id
        WHERE e.entity_id = ?
    `).all(entityId);
    const modifiers = {};
    const equipped = [];
    for (const row of rows) {
        const data = parseJson(row.data_json, {});
        equipped.push({ slot: row.equipped_slot, itemKey: row.item_key, name: data.name, data });
        for (const [key, value] of Object.entries(data.stats ?? {})) {
            if (typeof value === 'number') modifiers[key] = (modifiers[key] ?? 0) + value;
        }
    }
    return { modifiers, equipped };
}

export function getPassiveModifiers(db, entityId) {
    const rows = db.prepare(`
        SELECT s.data_json FROM entity_skills es JOIN skill_definitions s ON s.id = es.skill_definition_id
        WHERE es.entity_id = ?
    `).all(entityId);
    const modifiers = {};
    for (const row of rows) {
        const data = parseJson(row.data_json, {});
        for (const [key, value] of Object.entries(data.passive?.modifiers ?? {})) {
            modifiers[key] = (modifiers[key] ?? 0) + Number(value);
        }
    }
    return modifiers;
}

export function getStatusModifiers(db, entityId) {
    const rows = db.prepare(`
        SELECT i.*, d.data_json AS definition_json FROM status_effect_instances i
        LEFT JOIN status_effect_definitions d ON d.id = i.effect_definition_id
        WHERE i.entity_id = ? AND i.duration > 0
    `).all(entityId);
    const modifiers = {};
    for (const row of rows) {
        const instanceData = parseJson(row.data_json, {});
        const definitionData = parseJson(row.definition_json, {});
        const mods = { ...(definitionData.modifiers ?? {}), ...(instanceData.modifiers ?? {}) };
        for (const [key, value] of Object.entries(mods)) {
            modifiers[key] = (modifiers[key] ?? 0) + Number(value) * Number(row.stacks ?? 1);
        }
    }
    return modifiers;
}

export function computeEntityStats(db, entityId, options = {}) {
    const entity = getEntity(db, entityId);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(entity.campaign_id);
    const pkg = campaign ? parseJson(db.prepare('SELECT package_json FROM game_versions WHERE id = ?').get(campaign.game_version_id)?.package_json, {}) : {};
    const caps = pkg.rules?.statCaps ?? {};
    const base = getBaseStats(db, entityId);
    const equipment = getEquipmentModifiers(db, entityId);
    const passives = getPassiveModifiers(db, entityId);
    const statuses = options.includeStatus === false ? {} : getStatusModifiers(db, entityId);
    const values = {};
    for (const key of COMBAT_STATS) values[key] = 0;
    for (const [key, value] of Object.entries(base)) values[key] = (values[key] ?? 0) + Number(value);
    for (const source of [equipment.modifiers, passives, statuses]) {
        for (const [key, value] of Object.entries(source)) values[key] = (values[key] ?? 0) + Number(value);
    }
    for (const key of PRIMARY_STATS) {
        values[key] = Math.max(0, Number(values[key] ?? 0));
        if (Number.isFinite(caps[key])) values[key] = Math.min(values[key], Number(caps[key]));
    }
    const equip = equipment.modifiers;
    values.atk = Math.max(0, values.str + Number(equip.atk ?? 0) + Number(passives.atk ?? 0));
    values.mag = Math.max(0, values.int + Number(equip.mag ?? 0) + Number(passives.mag ?? 0));
    values.def = Math.max(0, Math.floor(values.vit * 0.8) + Number(equip.def ?? 0) + Number(passives.def ?? 0));
    values.res = Math.max(0, Math.floor(values.vit * 0.4) + Number(equip.res ?? 0) + Number(passives.res ?? 0));
    values.hit = Math.max(1, 80 + values.agi * 2 + Number(equip.hit ?? 0) + Number(passives.hit ?? 0));
    values.evade = Math.max(0, Math.floor(values.agi * 1.5) + Number(equip.evade ?? 0) + Number(passives.evade ?? 0));
    values.crit = Math.max(0, 5 + values.luck * 0.5 + Number(equip.crit ?? 0) + Number(passives.crit ?? 0));
    values.speed = values.agi;
    values.maxHp = Math.max(1, Math.round(values.maxHp));
    if (Number.isFinite(caps.maxHp)) values.maxHp = Math.min(values.maxHp, Number(caps.maxHp));
    values.maxMp = Math.max(0, Math.round(values.maxMp));
    if (Number.isFinite(caps.maxMp)) values.maxMp = Math.min(values.maxMp, Number(caps.maxMp));
    values.hp = Math.min(Number(entity.hp), values.maxHp);
    values.mp = Math.min(Number(entity.mp), values.maxMp);
    return {
        stats: values,
        base,
        equipment: equipment.equipped,
        equipmentModifiers: equipment.modifiers,
        passiveModifiers: passives,
        statusModifiers: statuses,
        caps,
    };
}

export function syncEntityResources(db, entityId) {
    const { stats } = computeEntityStats(db, entityId);
    const entity = getEntity(db, entityId);
    const hp = Math.min(Math.max(0, Number(entity.hp)), stats.maxHp);
    const mp = Math.min(Math.max(0, Number(entity.mp)), stats.maxMp);
    db.prepare('UPDATE entities SET hp = ?, mp = ?, updated_at = ? WHERE id = ?').run(hp, mp, nowIso(), entityId);
    return { hp, mp, stats };
}

export function getEntityView(db, entityId) {
    const entity = getEntity(db, entityId);
    const computed = computeEntityStats(db, entityId);
    const skills = db.prepare(`
        SELECT es.skill_key, es.level, s.name, s.category, s.mp_cost, s.cooldown, s.data_json
        FROM entity_skills es JOIN skill_definitions s ON s.id = es.skill_definition_id
        WHERE es.entity_id = ? ORDER BY s.name
    `).all(entityId).map((row) => ({
        ...row,
        data: parseJson(row.data_json, {}),
    }));
    const pkg = getCampaignPackage(db, entity.campaign_id);
    return {
        id: entity.id,
        key: entity.entity_key,
        name: entity.name,
        kind: entity.kind,
        level: entity.level,
        xp: entity.xp,
        xpToNext: expToNext(pkg?.rules, entity.level),
        hp: entity.hp,
        mp: entity.mp,
        gold: entity.gold,
        alive: Boolean(entity.alive),
        locationId: entity.location_id,
        faction: entity.faction,
        isPlayer: Boolean(entity.is_player),
        data: parseJson(entity.data_json, {}),
        stats: computed.stats,
        equipment: computed.equipment,
        skills,
    };
}

export function expToNext(rules, level) {
    const numericLevel = Math.max(1, Number(level));
    const tableEntry = (rules?.expTable ?? []).find((entry) => Number(entry.level) === numericLevel);
    if (tableEntry) return Number(tableEntry.exp);
    const formula = rules?.formulas?.expToNext ?? DEFAULT_FORMULAS.expToNext;
    return Math.max(1, Math.round(evaluateFormula(formula, { level: numericLevel })));
}

export function totalExpForLevel(rules, level) {
    let total = 0;
    for (let current = 1; current < level; current += 1) total += expToNext(rules, current);
    return total;
}

export function applyBaseStatGrowth(db, entityId, growth = {}) {
    ensureStats(db, entityId, {});
    for (const [key, amount] of Object.entries(growth)) {
        if (!PRIMARY_STATS.includes(key)) continue;
        db.prepare('UPDATE entity_stats SET base_value = base_value + ? WHERE entity_id = ? AND stat_key = ?')
            .run(Number(amount), entityId, key);
    }
}

export function maxHpForClassStats(stats) {
    return Math.max(1, Number(stats.maxHp ?? 1));
}

export function createPlayerEntity(db, { campaignId, name, classKey, classData, templateId, locationId }) {
    if (!name || !String(name).trim()) throw new ValidationError('Player name is required');
    const baseStats = classData?.baseStats ?? {};
    const id = uuid('ent_');
    const now = nowIso();
    const entityKey = 'player';
    db.prepare(`
        INSERT INTO entities (
            id, campaign_id, template_id, entity_key, kind, name, level, xp, hp, mp, gold,
            location_id, faction, alive, is_player, data_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'player', ?, 1, 0, ?, ?, ?, ?, 'player', 1, 1, ?, ?, ?)
    `).run(
        id, campaignId, templateId ?? null, entityKey, String(name).trim(),
        Number(baseStats.maxHp ?? 100), Number(baseStats.maxMp ?? 20), 0,
        locationId, JSON.stringify({ classKey, portrait: null }), now, now,
    );
    ensureStats(db, id, baseStats);
    return id;
}

export function createNpcEntity(db, { campaignId, template, locationId }) {
    const npcData = template.data ?? parseJson(template.data_json, {});
    const stats = npcData.combat?.stats ?? { maxHp: Math.max(30, 40 + Number(template.level ?? 1) * 5), maxMp: 10, str: 8, agi: 6, int: 6, vit: 7, luck: 5 };
    const id = uuid('ent_');
    const now = nowIso();
    const entityKey = `npc:${template.template_key ?? template.key}`;
    db.prepare(`
        INSERT INTO entities (
            id, campaign_id, template_id, entity_key, kind, name, level, xp, hp, mp, gold,
            location_id, faction, alive, is_player, data_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'npc', ?, 1, 0, ?, ?, 0, ?, 'friendly', 1, 0, ?, ?, ?)
    `).run(
        id, campaignId, template.id ?? null, entityKey, npcData.name ?? template.name,
        Number(stats.maxHp ?? 40), Number(stats.maxMp ?? 10), locationId,
        JSON.stringify({ npcKey: npcData.key, title: npcData.title ?? '', joinable: Boolean(npcData.joinable), party: false, combat: npcData.combat ?? null, shop: npcData.shop ?? null }), now, now,
    );
    ensureStats(db, id, stats);
    return id;
}

export function unlockSkill(db, entityId, skillKey, campaignId, level = 1) {
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    const skill = db.prepare('SELECT * FROM skill_definitions WHERE game_version_id = ? AND skill_key = ?').get(campaign.game_version_id, skillKey);
    if (!skill) return null;
    const existing = db.prepare('SELECT id FROM entity_skills WHERE entity_id = ? AND skill_definition_id = ?').get(entityId, skill.id);
    if (existing) return null;
    const id = uuid('esk_');
    db.prepare(`
        INSERT INTO entity_skills (id, entity_id, skill_definition_id, skill_key, level, unlocked_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, entityId, skill.id, skill.skill_key, level, nowIso());
    return id;
}

export function unlockEligibleSkills(db, entityId, campaignId) {
    const entity = getEntity(db, entityId);
    const campaign = db.prepare('SELECT game_version_id FROM campaigns WHERE id = ?').get(campaignId);
    const rows = db.prepare('SELECT * FROM skill_definitions WHERE game_version_id = ?').all(campaign.game_version_id);
    const unlocked = [];
    const classKey = parseJson(entity.data_json, {}).classKey;
    for (const row of rows) {
        const data = parseJson(row.data_json, {});
        const levelOk = Number(data.unlockLevel ?? 1) <= Number(entity.level);
        const classOk = !data.classes?.length || data.classes.includes(classKey);
        if (levelOk && classOk) {
            const id = unlockSkill(db, entityId, row.skill_key, campaignId);
            if (id) unlocked.push(row.skill_key);
        }
    }
    return unlocked;
}

export function readRules(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    return pkg?.rules ?? {};
}

export function addExperience(db, campaignId, entityId, amount, options = {}) {
    const rules = readRules(db, campaignId);
    const entity = getEntity(db, entityId);
    const classData = getClassData(db, entity);
    const cap = Number(rules.levelCap ?? 30);
    let level = Number(entity.level);
    let xp = Number(entity.xp) + Math.max(0, Math.round(Number(amount)));
    const gainedLevels = [];
    const gainedSkills = [];
    while (level < cap) {
        const threshold = expToNext(rules, level);
        if (xp < threshold) break;
        xp -= threshold;
        level += 1;
        applyBaseStatGrowth(db, entityId, classData?.growth ?? {});
        gainedLevels.push(level);
        gainedSkills.push(...unlockEligibleSkills(db, entityId, campaignId));
    }
    if (level >= cap) xp = Math.min(xp, expToNext(rules, cap) - 1);
    const computed = computeEntityStats(db, entityId);
    const hp = gainedLevels.length ? computed.stats.maxHp : Math.min(Number(entity.hp), computed.stats.maxHp);
    const mp = gainedLevels.length ? computed.stats.maxMp : Math.min(Number(entity.mp), computed.stats.maxMp);
    db.prepare('UPDATE entities SET level = ?, xp = ?, hp = ?, mp = ?, updated_at = ? WHERE id = ?')
        .run(level, xp, hp, mp, nowIso(), entityId);
    if (gainedLevels.length) {
        insertEvent(db, campaignId, 'entity.level_up', { entityId, levels: gainedLevels, level, skillsUnlocked: [...new Set(gainedSkills)] });
    }
    return {
        entityId,
        gainedExp: Math.max(0, Math.round(Number(amount))),
        level,
        xp,
        levelsGained: gainedLevels,
        skillsUnlocked: [...new Set(gainedSkills)],
        hp,
        mp,
        source: options.source ?? 'unknown',
    };
}

export function healEntity(db, entityId, hp = 0, mp = 0) {
    const computed = computeEntityStats(db, entityId);
    const entity = getEntity(db, entityId);
    const newHp = Math.min(computed.stats.maxHp, Number(entity.hp) + Number(hp));
    const newMp = Math.min(computed.stats.maxMp, Number(entity.mp) + Number(mp));
    db.prepare('UPDATE entities SET hp = ?, mp = ?, alive = 1, updated_at = ? WHERE id = ?').run(newHp, newMp, nowIso(), entityId);
    return { hp: newHp, mp: newMp, maxHp: computed.stats.maxHp, maxMp: computed.stats.maxMp };
}

export function setEntityLocation(db, entityId, locationId) {
    db.prepare('UPDATE entities SET location_id = ?, updated_at = ? WHERE id = ?').run(locationId, nowIso(), entityId);
}

export function listPartyEntities(db, campaignId) {
    const pkg = getCampaignPackage(db, campaignId);
    const player = getPlayer(db, campaignId);
    const companions = db.prepare(`
        SELECT * FROM entities WHERE campaign_id = ? AND kind = 'npc'
    `).all(campaignId).filter((entity) => parseJson(entity.data_json, {}).party);
    return { player, companions, pkg };
}

