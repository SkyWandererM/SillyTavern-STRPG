import React, { useEffect, useMemo, useState } from 'react';
import { api, randomIdempotencyKey } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Loading, SectionTitle, Stat } from '../ui.jsx';

const KIND_LABELS = {
    weapon: 'Weapon', armor: 'Armor', accessory: 'Accessory', consumable: 'Consumable', quest: 'Quest Item', material: 'Material',
};

export function Inventory({ campaignId, revision, notify, onMutated }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('all');
    const [busy, setBusy] = useState(null);

    const load = async () => {
        if (!campaignId) return;
        setError(null);
        try {
            setData(await api(`/campaigns/${campaignId}/inventory`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const items = useMemo(() => {
        if (!data) return [];
        return data.items.filter((item) => filter === 'all' || item.kind === filter);
    }, [data, filter]);

    const action = async (path, body, label) => {
        setBusy(body.inventoryId ?? body.slot ?? body.itemKey);
        try {
            await api(`/campaigns/${campaignId}/inventory/${path}`, { method: 'POST', body });
            notify(label, 'success');
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(null);
        }
    };

    if (!campaignId) return <Empty title="No Campaign selected" icon="▣" />;
    if (!data && !error) return <Loading label="Loading inventory..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    const equipped = new Map((data.equipment ?? []).map((entry) => [entry.slot, entry]));
    return (
        <div className="strpg-inventory">
            <SectionTitle
                eyebrow="INVENTORY"
                title="Inventory and Equipment"
                description="Equipment changes only affect derived stats. They never overwrite base attributes."
                actions={<Badge tone="gold">{data.gold} G</Badge>}
            />
            <div className="strpg-equipment-grid">
                {['weapon', 'armor', 'accessory'].map((slot) => {
                    const item = equipped.get(slot);
                    return (
                        <div className={`strpg-equip-slot ${item ? 'filled' : ''}`} key={slot}>
                            <span className="strpg-eyebrow">{slot.toUpperCase()}</span>
                            <strong>{item?.name ?? 'Empty'}</strong>
                            {item ? (
                                <>
                                    <span className="strpg-muted">{Object.entries(item.data?.stats ?? {}).map(([key, value]) => `${key}+${value}`).join(' · ')}</span>
                                    <Button size="sm" onClick={() => action('unequip', { slot }, 'Item unequipped')} disabled={busy === slot}>Unequip</Button>
                                </>
                            ) : <span className="strpg-muted">Equip an item from your inventory</span>}
                        </div>
                    );
                })}
            </div>
            <div className="strpg-filter-row">
                <div className="strpg-chip-row">
                    {['all', 'weapon', 'armor', 'accessory', 'consumable', 'material', 'quest'].map((kind) => (
                        <button type="button" key={kind} className={`strpg-chip ${filter === kind ? 'active' : ''}`} onClick={() => setFilter(kind)}>
                            {kind === 'all' ? 'All' : KIND_LABELS[kind] ?? kind}
                        </button>
                    ))}
                </div>
                <span className="strpg-muted">{items.length} item types</span>
            </div>
            {items.length ? (
                <div className="strpg-item-grid">
                    {items.map((item) => (
                        <article className={`strpg-item-card rarity-${item.rarity}`} key={item.inventoryId}>
                            <div className="strpg-item-head">
                                <div className="strpg-item-icon">{item.kind === 'consumable' ? '✚' : item.kind === 'weapon' ? '⚔' : item.kind === 'armor' ? '▣' : item.kind === 'accessory' ? '◈' : '◇'}</div>
                                <div>
                                    <strong>{item.name}</strong>
                                    <span>{KIND_LABELS[item.kind] ?? item.kind} · ×{item.quantity}</span>
                                </div>
                                {item.equippedSlot && <Badge tone="gold">Equipped</Badge>}
                            </div>
                            <p>{item.description}</p>
                            <div className="strpg-item-stats">
                                {Object.entries(item.stats ?? {}).map(([key, value]) => <span key={key}>{key} +{value}</span>)}
                                {item.consumable?.healHp ? <span>Restore {item.consumable.healHp} HP</span> : null}
                            </div>
                            <div className="strpg-row end">
                                {item.stackable && <span className="strpg-muted">Stack {item.quantity}/{item.maxStack}</span>}
                                {['weapon', 'armor', 'accessory'].includes(item.kind) && !item.equippedSlot && (
                                    <Button size="sm" onClick={() => action('equip', { inventoryId: item.inventoryId }, 'Equipped')} disabled={busy === item.inventoryId}>Equip</Button>
                                )}
                                {item.kind === 'consumable' && (
                                    <Button size="sm" variant="gold" onClick={() => action('use', { itemKey: item.itemKey }, `Used ${item.name}`)} disabled={busy === item.itemKey}>Use</Button>
                                )}
                            </div>
                        </article>
                    ))}
                </div>
            ) : <Empty title="No matching items" icon="▣">Buy from a merchant or defeat monsters for loot.</Empty>}
            <div className="strpg-grid four">
                <Stat label="Total Items" value={data.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)} sub="including stacks" />
                <Stat label="Gold" value={`${data.gold} G`} />
                <Stat label="Equipment Slots" value={`${equipped.size}/3`} />
                <Stat label="Item Types" value={data.items.length} />
            </div>
        </div>
    );
}




