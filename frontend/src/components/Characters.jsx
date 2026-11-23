import React, { useEffect, useState } from 'react';
import { api, randomIdempotencyKey } from '../api.js';
import { Badge, Bar, Button, Empty, ErrorBox, Loading, Modal, SectionTitle, StatusBadge } from '../ui.jsx';

export function Characters({ campaignId, revision, notify, onMutated }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [selectedNpc, setSelectedNpc] = useState(null);
    const [shopNpc, setShopNpc] = useState(null);

    const load = async () => {
        if (!campaignId) return;
        setError(null);
        try {
            setData(await api(`/campaigns/${campaignId}/characters`));
        } catch (err) {
            setError(err);
        }
    };

    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!campaignId) return <Empty title="No Campaign selected" icon="☗">Create a Campaign to view characters.</Empty>;
    if (!data && !error) return <Loading label="Loading characters..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    const player = data.player;
    return (
        <div className="strpg-characters">
            <SectionTitle eyebrow="CHARACTERS" title="Characters and Encyclopedia" description="Player and party stats are authoritative in STRPG; NPC relationships and narrative state are tracked separately." />
            <div className="strpg-grid two">
                <section className="strpg-panel character-hero">
                    <div className="strpg-portrait large">{(player.name ?? '?').slice(0, 1)}</div>
                    <div className="character-hero-body">
                        <div className="strpg-row"><Badge tone="gold">PLAYER</Badge><StatusBadge status={player.alive ? 'active' : 'failed'} /></div>
                        <h2>{player.name}</h2>
                        <p>Lv.{player.level} · {player.data?.classKey ?? 'adventurer'}</p>
                        <div className="strpg-bars">
                            <Bar label="HP" value={player.hp} max={player.stats.maxHp} tone="hp" />
                            <Bar label="MP" value={player.mp} max={player.stats.maxMp} tone="mp" />
                            <Bar label="EXP" value={player.xp} max={player.xpToNext} tone="xp" />
                        </div>
                    </div>
                </section>
                <section className="strpg-panel">
                    <SectionTitle eyebrow="ATTRIBUTES" title="Final Attributes" description="Base + permanent bonuses + equipment + passives + temporary effects." />
                    <div className="strpg-stat-grid dense">
                        {['str', 'agi', 'int', 'vit', 'luck', 'atk', 'def', 'res', 'hit', 'evade', 'crit'].map((key) => (
                            <div className="strpg-stat" key={key}><span>{key.toUpperCase()}</span><strong>{Math.round(player.stats[key] ?? 0)}</strong></div>
                        ))}
                    </div>
                    <div className="strpg-divider" />
                    <div className="strpg-kv"><span>Gold</span><strong>{player.gold} G</strong></div>
                    <div className="strpg-kv"><span>Location</span><strong>{player.locationId ? 'Current scene' : 'Unknown'}</strong></div>
                </section>
            </div>

            <section className="strpg-panel">
                <SectionTitle eyebrow="PARTY" title="Party" />
                {data.party.length ? (
                    <div className="strpg-card-grid">
                        {data.party.map((member) => (
                            <div className="strpg-character-card" key={member.id}>
                                <div className="strpg-portrait">{(member.name ?? '?').slice(0, 1)}</div>
                                <div>
                                    <strong>{member.name}</strong>
                                    <span>Lv.{member.level} · Party</span>
                                    <Bar label="HP" value={member.hp} max={member.stats.maxHp} tone="hp" compact />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : <Empty title="You are alone" icon="☗">Build a relationship with a recruitable NPC to invite them along.</Empty>}
            </section>

            <section className="strpg-panel">
                <SectionTitle eyebrow="ENCYCLOPEDIA" title="Local NPCs" description="Click a card to talk, accept quests, trade, or invite the NPC to join." />
                {data.npcs.length ? (
                    <div className="strpg-card-grid npc-grid">
                        {data.npcs.map((npc) => (
                            <button type="button" className="strpg-npc-card" key={npc.id} onClick={() => setSelectedNpc(npc.data.npcKey)}>
                                <div className="strpg-portrait">{(npc.name ?? '?').slice(0, 1)}</div>
                                <div className="strpg-npc-body">
                                    <strong>{npc.name}</strong>
                                    <span>{npc.data.title || 'NPC'}</span>
                                    <div className="strpg-row wrap">
                                        <Badge tone={npc.data.party ? 'gold' : 'info'}>{npc.data.party ? 'Party' : 'Local'}</Badge>
                                        {npc.data.joinable && <Badge tone="neutral">Recruitable</Badge>}
                                        {npc.data.shop && <Badge tone="gold">Merchant</Badge>}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                ) : <Empty title="No NPC at this location" icon="☗">Visit a town to find interactive characters.</Empty>}
            </section>

            {selectedNpc && (
                <NpcModal
                    campaignId={campaignId}
                    npcKey={selectedNpc}
                    onClose={() => setSelectedNpc(null)}
                    onShop={(key) => { setSelectedNpc(null); setShopNpc(key); }}
                    onMutated={onMutated}
                    notify={notify}
                />
            )}
            {shopNpc && (
                <ShopModal
                    campaignId={campaignId}
                    npcKey={shopNpc}
                    onClose={() => setShopNpc(null)}
                    onMutated={onMutated}
                    notify={notify}
                />
            )}
        </div>
    );
}

export function NpcModal({ campaignId, npcKey, onClose, onShop, onMutated, notify }) {
    const [state, setState] = useState(null);
    const [error, setError] = useState(null);
    const [busyKey, setBusyKey] = useState(null);
    const [result, setResult] = useState(null);

    const load = async () => {
        setError(null);
        try {
            setState(await api(`/campaigns/${campaignId}/interactions/${npcKey}`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, npcKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const act = async (interaction) => {
        if (!interaction.available) return;
        setBusyKey(interaction.key);
        setResult(null);
        try {
            const response = await api(`/campaigns/${campaignId}/interactions/${npcKey}/${interaction.key}`, {
                method: 'POST', body: {},
            });
            setResult(response);
            await load();
            await onMutated?.();
            if (interaction.type === 'shop' && state?.shop) {
                onShop?.(npcKey);
            }
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusyKey(null);
        }
    };

    return (
        <Modal
            title={state?.npc?.name ?? npcKey}
            subtitle={state?.npc?.title ?? 'NPC Interaction'}
            onClose={onClose}
            wide
        >
            {error && <ErrorBox error={error} onRetry={load} />}
            {!state ? <Loading /> : (
                <div className="strpg-npc-modal">
                    <div className="strpg-npc-profile">
                        <div className="strpg-portrait large">{(state.npc.name ?? '?').slice(0, 1)}</div>
                        <p>{state.npc.description}</p>
                        <div className="strpg-kv"><span>Personality</span><strong>{state.npc.personality}</strong></div>
                        <div className="strpg-kv"><span>Motivation</span><strong>{state.npc.motivation}</strong></div>
                        <div className="strpg-kv"><span>Relationship</span><strong>{state.npc.relation}</strong></div>
                    </div>
                    <div className="strpg-npc-actions">
                        {state.present ? state.interactions.map((interaction) => (
                            <button
                                type="button"
                                key={interaction.key}
                                className={`strpg-interaction ${interaction.available ? '' : 'locked'}`}
                                disabled={!interaction.available || busyKey === interaction.key}
                                onClick={() => act(interaction)}
                            >
                                <div>
                                    <strong>{interaction.label}</strong>
                                    <span>{interaction.description || interaction.type}</span>
                                </div>
                                <span>{busyKey === interaction.key ? '…' : interaction.available ? '›' : 'Locked'}</span>
                            </button>
                        )) : <Empty title="NPC is not at this location" icon="⌘" />}
                        {state.questsReady?.length > 0 && <Badge tone="gold">You have {state.questsReady.length} quest(s) ready to turn in</Badge>}
                    </div>
                </div>
            )}
            {result && (
                <div className="strpg-interaction-result">
                    <span className="strpg-eyebrow">RESULT</span>
                    {result.quest && (
                        <div>
                            <strong>{result.quest.name}</strong>
                            <Badge tone={result.quest.status === 'ready_to_turn_in' ? 'gold' : 'info'}>{result.quest.status}</Badge>
                            {result.quest.rewards && (
                                <p>Rewards: {result.quest.rewards.exp ?? 0} EXP · {result.quest.rewards.gold ?? 0} G</p>
                            )}
                        </div>
                    )}
                    {result.dialogue?.length > 0 && <blockquote>{result.dialogue.join(' ')}</blockquote>}
                    {result.message && <p>{result.message}</p>}
                    {result.healed && <p>HP and MP restored.</p>}
                    {result.party && <p>{state?.npc?.name} joined the party.</p>}
                    {result.story?.ending && <p className="strpg-good">Story ending: {result.story.ending}</p>}
                </div>
            )}
        </Modal>
    );
}

export function ShopModal({ campaignId, npcKey, onClose, onMutated, notify }) {
    const [shop, setShop] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        setError(null);
        try {
            setShop(await api(`/campaigns/${campaignId}/shop/${npcKey}`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, npcKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const trade = async (direction, itemKey) => {
        setBusy(true);
        try {
            const response = await api(`/campaigns/${campaignId}/shop/${npcKey}/${direction}`, {
                method: 'POST', body: { itemKey, quantity: 1, idempotencyKey: randomIdempotencyKey('shop') },
            });
            notify(`${direction === 'buy' ? 'Buy' : 'Sell'} successfully: ${response.name ?? itemKey}.`, 'success');
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Shop" subtitle={`${npcKey} · Gold ${shop?.gold ?? '—'}`} onClose={onClose} wide>
            {error && <ErrorBox error={error} onRetry={load} />}
            {!shop ? <Loading /> : (
                <div className="strpg-shop">
                    <div>
                        <SectionTitle eyebrow="BUY" title="Buy" />
                        <div className="strpg-shop-list">
                            {shop.items.map((item) => (
                                <div className="strpg-shop-row" key={item.itemKey}>
                                    <div>
                                        <strong>{item.name}</strong>
                                        <span>{item.description}</span>
                                        <div className="strpg-row"><Badge>{item.kind}</Badge><Badge tone="gold">{item.buyPrice} G</Badge></div>
                                    </div>
                                    <Button size="sm" disabled={busy || !item.itemKey} onClick={() => trade('buy', item.itemKey)}>Buy</Button>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div>
                        <SectionTitle eyebrow="SELL" title="Sell" />
                        <div className="strpg-shop-list">
                            {shop.sellable.filter((item) => !item.equippedSlot).map((item) => (
                                <div className="strpg-shop-row" key={item.inventoryId}>
                                    <div>
                                        <strong>{item.name} × {item.quantity}</strong>
                                        <span>Sells for about {Math.max(1, Math.floor((item.price ?? 0) * shop.sellRate))} G</span>
                                    </div>
                                    <Button size="sm" disabled={busy} onClick={() => trade('sell', item.itemKey)}>Sell</Button>
                                </div>
                            ))}
                            {!shop.sellable.length && <Empty title="No items to sell" icon="▣" />}
                        </div>
                    </div>
                </div>
            )}
        </Modal>
    );
}





