import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { computeEntityStats, getEntity, getPlayer } from './stats.js';
import { insertEvent, nowIso, parseJson, uuid, withTransaction } from './util.js';

export function getItemDefinition(db, campaignId, itemKey) {
    const row = db.prepare(`
        SELECT d.* FROM item_definitions d
        JOIN campaigns c ON c.game_version_id = d.game_version_id
        WHERE c.id = ? AND d.item_key = ?
    `).get(campaignId, itemKey);
    return row ?? null;
}

export function itemView(row) {
    const data = parseJson(row.data_json ?? row.data ?? '{}', {});
    return {
        id: row.id,
        itemKey: row.item_key,
        name: row.name ?? data.name,
        kind: row.kind ?? data.kind,
        rarity: row.rarity ?? data.rarity,
        description: row.description ?? data.description,
        price: Number(row.price ?? data.price ?? 0),
        stackable: Boolean(row.stackable ?? data.stackable),
        maxStack: Number(row.max_stack ?? data.maxStack ?? 99),
        slot: row.slot ?? data.slot ?? null,
        stats: data.stats ?? {},
        effects: data.effects ?? {},
        consumable: data.consumable ?? null,
        classRestrictions: data.classRestrictions ?? [],
        data,
    };
}

export function listInventory(db, campaignId, entityId) {
    const rows = db.prepare(`
        SELECT i.*, d.data_json, d.name, d.kind, d.rarity, d.description, d.price, d.stackable, d.max_stack, d.slot
        FROM inventory i JOIN item_definitions d ON d.id = i.item_definition_id
        WHERE i.campaign_id = ? AND i.entity_id = ?
        ORDER BY d.kind, d.name
    `).all(campaignId, entityId);
    const equipmentRows = db.prepare('SELECT * FROM equipment_slots WHERE entity_id = ?').all(entityId);
    const equipped = new Map(equipmentRows.map((row) => [row.inventory_id, row.slot]));
    return rows.map((row) => ({
        ...itemView(row),
        inventoryId: row.id,
        quantity: Number(row.quantity),
        instanceKey: row.instance_key,
        metadata: parseJson(row.metadata_json, {}),
        equippedSlot: equipped.get(row.id) ?? null,
    }));
}

export function countItem(db, campaignId, entityId, itemKey) {
    const rows = db.prepare('SELECT quantity FROM inventory WHERE campaign_id = ? AND entity_id = ? AND item_key = ?')
        .all(campaignId, entityId, itemKey);
    return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

export function addItem(db, campaignId, entityId, itemKey, quantity = 1, options = {}) {
    const amount = Math.max(1, Math.round(Number(quantity)));
    const definition = getItemDefinition(db, campaignId, itemKey);
    if (!definition) throw new NotFoundError(`Item definition '${itemKey}' not found`, 'ITEM_DEFINITION_NOT_FOUND');
    const item = itemView(definition);
    const now = nowIso();
    if (item.stackable) {
        const existing = db.prepare(`
            SELECT * FROM inventory WHERE entity_id = ? AND item_definition_id = ? AND instance_key IS NULL
        `).get(entityId, definition.id);
        if (existing) {
            const newQuantity = Math.min(item.maxStack, Number(existing.quantity) + amount);
            db.prepare('UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?').run(newQuantity, now, existing.id);
            return { inventoryId: existing.id, quantity: newQuantity, itemKey, added: amount };
        }
        const id = uuid('inv_');
        db.prepare(`
            INSERT INTO inventory (id, campaign_id, entity_id, item_definition_id, item_key, quantity, instance_key, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `).run(id, campaignId, entityId, definition.id, itemKey, Math.min(item.maxStack, amount), JSON.stringify(options.metadata ?? {}), now, now);
        return { inventoryId: id, quantity: Math.min(item.maxStack, amount), itemKey, added: amount };
    }
    const id = uuid('inv_');
    db.prepare(`
        INSERT INTO inventory (id, campaign_id, entity_id, item_definition_id, item_key, quantity, instance_key, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, campaignId, entityId, definition.id, itemKey, amount, uuid('itm_'), JSON.stringify(options.metadata ?? {}), now, now);
    return { inventoryId: id, quantity: amount, itemKey, added: amount };
}

export function removeItem(db, campaignId, entityId, itemKey, quantity = 1, options = {}) {
    let remaining = Math.max(1, Math.round(Number(quantity)));
    const rows = db.prepare(`
        SELECT * FROM inventory WHERE campaign_id = ? AND entity_id = ? AND item_key = ?
        ORDER BY CASE WHEN instance_key IS NULL THEN 0 ELSE 1 END, created_at
    `).all(campaignId, entityId, itemKey);
    if (rows.reduce((sum, row) => sum + Number(row.quantity), 0) < remaining) {
        throw new ConflictError(`Not enough '${itemKey}' in inventory`, 'INSUFFICIENT_ITEMS', { itemKey, required: quantity });
    }
    for (const row of rows) {
        if (remaining <= 0) break;
        if (options.excludeInventoryId && row.id === options.excludeInventoryId) continue;
        const take = Math.min(Number(row.quantity), remaining);
        const next = Number(row.quantity) - take;
        if (next <= 0) db.prepare('DELETE FROM inventory WHERE id = ?').run(row.id);
        else db.prepare('UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), row.id);
        remaining -= take;
    }
    return { itemKey, removed: Math.max(0, Math.round(Number(quantity)) - remaining) };
}

export function equipItem(db, campaignId, entityId, inventoryId) {
    const entity = getEntity(db, entityId);
    const row = db.prepare('SELECT i.*, d.data_json, d.kind, d.slot, d.name FROM inventory i JOIN item_definitions d ON d.id = i.item_definition_id WHERE i.id = ? AND i.entity_id = ?').get(inventoryId, entityId);
    if (!row) throw new NotFoundError('Inventory item not found', 'INVENTORY_ITEM_NOT_FOUND');
    const data = parseJson(row.data_json, {});
    if (!['weapon', 'armor', 'accessory'].includes(row.kind)) throw new ValidationError('This item cannot be equipped');
    const slot = row.slot ?? data.slot ?? row.kind;
    const classKey = parseJson(entity.data_json, {}).classKey;
    if (data.classRestrictions?.length && classKey && !data.classRestrictions.includes(classKey)) {
        throw new ConflictError(`${row.name} cannot be used by class '${classKey}'`, 'CLASS_RESTRICTION');
    }
    withTransaction(db, () => {
        if (Number(row.quantity) > 1) {
            db.prepare('UPDATE inventory SET quantity = quantity - 1, updated_at = ? WHERE id = ?').run(nowIso(), inventoryId);
            const newId = uuid('inv_');
            const now = nowIso();
            db.prepare(`
                INSERT INTO inventory (id, campaign_id, entity_id, item_definition_id, item_key, quantity, instance_key, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            `).run(newId, campaignId, entityId, row.item_definition_id, row.item_key, uuid('itm_'), row.metadata_json, now, now);
            inventoryId = newId;
        }
        const occupied = db.prepare('SELECT * FROM equipment_slots WHERE entity_id = ? AND slot = ?').get(entityId, slot);
        if (occupied) db.prepare('DELETE FROM equipment_slots WHERE id = ?').run(occupied.id);
        const equipped = db.prepare('SELECT * FROM equipment_slots WHERE inventory_id = ?').get(inventoryId);
        if (equipped) db.prepare('DELETE FROM equipment_slots WHERE id = ?').run(equipped.id);
        db.prepare('INSERT INTO equipment_slots (id, entity_id, slot, inventory_id) VALUES (?, ?, ?, ?)')
            .run(uuid('eq_'), entityId, slot, inventoryId);
    });
    insertEvent(db, campaignId, 'item.equipped', { entityId, slot, inventoryId, itemKey: row.item_key });
    return { ok: true, slot, inventoryId };
}

export function unequipItem(db, entityId, slot) {
    const row = db.prepare('SELECT * FROM equipment_slots WHERE entity_id = ? AND slot = ?').get(entityId, slot);
    if (!row) throw new NotFoundError(`No equipment in slot '${slot}'`, 'SLOT_EMPTY');
    const entity = getEntity(db, entityId);
    db.prepare('DELETE FROM equipment_slots WHERE id = ?').run(row.id);
    insertEvent(db, entity.campaign_id, 'item.unequipped', { entityId, slot, inventoryId: row.inventory_id });
    return { ok: true, slot };
}

export function useItem(db, campaignId, entityId, itemKey, options = {}) {
    const row = db.prepare(`
        SELECT i.*, d.data_json, d.kind, d.name FROM inventory i
        JOIN item_definitions d ON d.id = i.item_definition_id
        WHERE i.campaign_id = ? AND i.entity_id = ? AND i.item_key = ?
        ORDER BY CASE WHEN i.instance_key IS NULL THEN 0 ELSE 1 END LIMIT 1
    `).get(campaignId, entityId, itemKey);
    if (!row) throw new NotFoundError(`Item '${itemKey}' is not in inventory`, 'ITEM_NOT_OWNED');
    const data = parseJson(row.data_json, {});
    if (row.kind !== 'consumable') throw new ValidationError('Only consumable items can be used');
    const consumable = data.consumable ?? {};
    const entity = getEntity(db, entityId);
    const stats = computeEntityStats(db, entityId).stats;
    const hp = Math.min(stats.maxHp, Number(entity.hp) + Number(consumable.healHp ?? 0));
    const mp = Math.min(stats.maxMp, Number(entity.mp) + Number(consumable.healMp ?? 0));
    withTransaction(db, () => {
        db.prepare('UPDATE entities SET hp = ?, mp = ?, alive = 1, updated_at = ? WHERE id = ?').run(hp, mp, nowIso(), entityId);
        removeItem(db, campaignId, entityId, itemKey, 1);
    });
    insertEvent(db, campaignId, 'item.used', { entityId, itemKey, healedHp: hp - Number(entity.hp), healedMp: mp - Number(entity.mp) });
    return { ok: true, itemKey, name: row.name, hp, mp, healedHp: hp - Number(entity.hp), healedMp: mp - Number(entity.mp) };
}

export function buyItem(db, campaignId, entityId, itemKey, quantity = 1, shop = null) {
    const amount = Math.max(1, Math.round(Number(quantity)));
    const definition = getItemDefinition(db, campaignId, itemKey);
    if (!definition) throw new NotFoundError(`Item '${itemKey}' does not exist`, 'ITEM_DEFINITION_NOT_FOUND');
    const item = itemView(definition);
    const shopEntry = shop?.items?.find((entry) => entry.itemKey === itemKey);
    if (shop && !shopEntry) throw new ConflictError('This merchant does not sell that item', 'NOT_IN_SHOP');
    const unitPrice = Math.max(0, Math.round(Number(shopEntry?.price ?? item.price) * Number(shop?.buyRate ?? 1)));
    const total = unitPrice * amount;
    const entity = getEntity(db, entityId);
    if (Number(entity.gold) < total) throw new ConflictError('Not enough gold', 'INSUFFICIENT_GOLD', { gold: Number(entity.gold), required: total });
    withTransaction(db, () => {
        db.prepare('UPDATE entities SET gold = gold - ?, updated_at = ? WHERE id = ?').run(total, nowIso(), entityId);
        addItem(db, campaignId, entityId, itemKey, amount);
    });
    insertEvent(db, campaignId, 'item.bought', { entityId, itemKey, quantity: amount, unitPrice, total });
    return { ok: true, itemKey, name: item.name, quantity: amount, unitPrice, total, gold: Number(entity.gold) - total };
}

export function sellItem(db, campaignId, entityId, itemKey, quantity = 1, sellRate = 0.5) {
    const definition = getItemDefinition(db, campaignId, itemKey);
    if (!definition) throw new NotFoundError(`Item '${itemKey}' does not exist`, 'ITEM_DEFINITION_NOT_FOUND');
    const item = itemView(definition);
    const amount = Math.max(1, Math.round(Number(quantity)));
    const equipped = db.prepare(`
        SELECT e.id FROM equipment_slots e JOIN inventory i ON i.id = e.inventory_id
        WHERE e.entity_id = ? AND i.item_key = ?
    `).all(entityId, itemKey);
    if (equipped.length) throw new ConflictError('Unequip the item before selling it', 'ITEM_EQUIPPED');
    const unit = Math.max(1, Math.floor(item.price * Number(sellRate)));
    withTransaction(db, () => {
        removeItem(db, campaignId, entityId, itemKey, amount);
        db.prepare('UPDATE entities SET gold = gold + ?, updated_at = ? WHERE id = ?').run(unit * amount, nowIso(), entityId);
    });
    insertEvent(db, campaignId, 'item.sold', { entityId, itemKey, quantity: amount, unitPrice: unit, total: unit * amount });
    return { ok: true, itemKey, quantity: amount, unitPrice: unit, total: unit * amount };
}

export function buildInventoryView(db, campaignId) {
    const player = getPlayer(db, campaignId);
    return {
        playerId: player.id,
        gold: player.gold,
        items: listInventory(db, campaignId, player.id),
        equipment: computeEntityStats(db, player.id).equipment,
    };
}
