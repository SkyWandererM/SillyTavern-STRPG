import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getStContext, randomIdempotencyKey } from '../api.js';
import { Badge, Bar, Button, ErrorBox, Loading } from '../ui.jsx';

export function CombatArena({ campaignId, combatId, onClose, notify, onFinished }) {
    const [combat, setCombat] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [mode, setMode] = useState('main');
    const [targetId, setTargetId] = useState(null);
    const [sentToChat, setSentToChat] = useState(false);
    const logRef = useRef(null);

    const load = async () => {
        setError(null);
        try {
            let data;
            if (combatId) data = await api(`/combat/${combatId}`);
            else data = await api(`/campaigns/${campaignId}/combat`);
            setCombat(data);
            const firstEnemy = data?.participants?.find((participant) => participant.side === 'enemy' && participant.alive);
            setTargetId((current) => current && data?.participants?.some((participant) => participant.id === current && participant.alive) ? current : firstEnemy?.id ?? null);
        } catch (err) {
            setError(err);
        }
    };

    useEffect(() => { load(); }, [campaignId, combatId]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [combat?.actions?.length]);

    const enemies = combat?.participants?.filter((participant) => participant.side === 'enemy') ?? [];
    const party = combat?.participants?.filter((participant) => participant.side === 'party') ?? [];
    const current = combat?.participants?.find((participant) => participant.id === combat.currentActorId);
    const selected = combat?.participants?.find((participant) => participant.id === targetId);

    const start = async () => {
        setBusy(true);
        try {
            const data = await api(`/combat/${combat.id}/start`, { method: 'POST', body: {} });
            setCombat(data);
            const firstEnemy = data?.participants?.find((participant) => participant.side === 'enemy' && participant.alive);
            setTargetId(firstEnemy?.id ?? null);
            await onFinished?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const act = async (action, label = '') => {
        if (!combat || busy) return;
        setBusy(true);
        try {
            const data = await api(`/combat/${combat.id}/action`, {
                method: 'POST',
                idempotencyKey: randomIdempotencyKey('combat'),
                body: { ...action, idempotencyKey: randomIdempotencyKey('combat-key') },
            });
            setCombat(data);
            setTargetId((previous) => {
                const stillValid = data?.participants?.some((participant) => participant.id === previous && participant.alive);
                if (stillValid) return previous;
                return data?.participants?.find((participant) => participant.side === 'enemy' && participant.alive)?.id ?? null;
            });
            setMode('main');
            if (label) notify(label, 'info');
            if (['victory', 'defeat', 'fled'].includes(data.status)) {
                void handleOpenChatActions(campaignId, data.result?.worldEvents, notify);
                await onFinished?.();
            }
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const attack = () => {
        if (!targetId) return notify('Select an enemy target.', 'warning');
        act({ type: 'attack', targetId }, 'Attack executed');
    };

    const useSkill = (skill) => {
        let target = targetId;
        if (skill.target === 'self') target = current?.id;
        if (['ally', 'all_allies'].includes(skill.target)) {
            target = party.find((participant) => participant.alive)?.id;
        }
        if (skill.target === 'single' && !selected) return notify('Select a target.', 'warning');
        act({ type: 'skill', skillKey: skill.key, targetId: target }, `Cast ${skill.name}`);
    };

    const useItem = (item) => act({ type: 'item', itemKey: item.itemKey, targetId: current?.id }, `Use ${item.name}`);

    const save = async () => {
        setBusy(true);
        try {
            await api(`/combat/${combat.id}/save`, { method: 'POST', body: {} });
            notify('Combat state and save snapshot written.', 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const sendToChat = async () => {
        if (!combat?.result) return;
        const result = combat.result;
        const text = [
            '[STRPG Combat Result — narrative only; do not change values]',
            result.summary,
            `EXP +${result.exp ?? 0}, Gold +${result.gold ?? 0}.`,
            result.drops?.length ? `Loot: ${result.drops.map((drop) => `${drop.itemKey} x${drop.quantity}`).join(', ')}.` : '',
            result.levelUps?.length ? `Level up: ${result.levelUps.map((entry) => `Lv.${entry.level}`).join(', ')}.` : '',
            "Describe the party's reaction after combat and the current scene. Do not recalculate or invent any values.",
        ].filter(Boolean).join('\n');
        try {
            const ctx = getStContext();
            if (!ctx.addOneMessage) throw new Error('This SillyTavern version does not support addOneMessage');
            ctx.addOneMessage({
                name: 'STRPG',
                mes: text,
                is_system: true,
                is_user: false,
                send_date: Date.now(),
                extra: { strpg: { type: 'combat-result', combatId: combat.id } },
            });
            await ctx.saveChat?.();
            setSentToChat(true);
            notify('Combat summary written to chat for the next LLM turn.', 'success');
        } catch (err) {
            notify(`Failed to write to chat: ${err.message}`, 'danger');
        }
    };

    if (error) {
        return (
            <div className="strpg-combat-overlay">
                <div className="strpg-combat-window">
                    <ErrorBox error={error} onRetry={load} />
                    <Button onClick={onClose}>Close</Button>
                </div>
            </div>
        );
    }
    if (!combat) {
        return <div className="strpg-combat-overlay"><div className="strpg-combat-window"><Loading label="Loading combat..." /></div></div>;
    }

    if (combat.status === 'pending') {
        return (
            <div className="strpg-combat-overlay">
                <div className="strpg-combat-window pending">
                    <header className="strpg-combat-header">
                        <div><span className="strpg-eyebrow">ENCOUNTER</span><h2>{combat.encounterKey}</h2></div>
                        <Button variant="ghost" onClick={onClose}>Leave</Button>
                    </header>
                    <div className="strpg-combat-versus">
                        <div>
                            <span className="strpg-eyebrow">Party</span>
                            {party.map((participant) => <div className="strpg-versus-name" key={participant.id}>{participant.name}<small>HP {participant.hp}/{participant.maxHp}</small></div>)}
                        </div>
                        <div className="strpg-vs">VS</div>
                        <div>
                            <span className="strpg-eyebrow">Enemies</span>
                            {enemies.map((participant) => <div className="strpg-versus-name enemy" key={participant.id}>{participant.name}<small>HP {participant.hp}/{participant.maxHp}</small></div>)}
                        </div>
                    </div>
                    <p className="strpg-combat-tip">Combat is turn-based. Damage, hit, crit, loot, and EXP are calculated by the server rules engine.</p>
                    <div className="strpg-row center">
                        <Button variant="gold" size="lg" onClick={start} disabled={busy}>{busy ? 'Preparing...' : 'Enter Battle'}</Button>
                    </div>
                </div>
            </div>
        );
    }

    if (['victory', 'defeat', 'fled'].includes(combat.status)) {
        const result = combat.result ?? {};
        return (
            <div className="strpg-combat-overlay">
                <div className={`strpg-combat-window result ${combat.status}`}>
                    <span className="strpg-result-kicker">{combat.status === 'victory' ? 'VICTORY' : combat.status === 'defeat' ? 'DEFEAT' : 'ESCAPED'}</span>
                    <h2>{combat.status === 'victory' ? 'Victory' : combat.status === 'defeat' ? 'Party Defeated' : 'Escaped'}</h2>
                    <p>{result.summary}</p>
                    {combat.status === 'victory' && (
                        <div className="strpg-reward-grid">
                            <div><span>EXP</span><strong>+{result.exp ?? 0}</strong></div>
                            <div><span>GOLD</span><strong>+{result.gold ?? 0}</strong></div>
                            <div><span>DROPS</span><strong>{result.drops?.length ?? 0}</strong></div>
                            <div><span>LEVEL</span><strong>{result.levelUps?.length ? `+${result.levelUps.length}` : '—'}</strong></div>
                        </div>
                    )}
                    {result.drops?.length > 0 && <div className="strpg-row wrap">{result.drops.map((drop, index) => <Badge key={`${drop.itemKey}-${index}`} tone="gold">{drop.itemKey} × {drop.quantity}</Badge>)}</div>}
                    {combat.actions?.length > 0 && (
                        <details className="strpg-combat-details">
                            <summary>Combat Log</summary>
                            <div className="strpg-combat-log static">
                                {combat.actions.flatMap((action) => action.result?.log ?? []).map((entry, index) => <div key={index}>{entry.text}</div>)}
                            </div>
                        </details>
                    )}
                    <div className="strpg-row center wrap">
                        <Button variant="gold" onClick={sendToChat} disabled={sentToChat}>{sentToChat ? 'Written to Chat' : 'Hand to LLM'}</Button>
                        <Button onClick={onClose}>Back to Control Center</Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="strpg-combat-overlay">
            <div className="strpg-combat-window">
                <header className="strpg-combat-header">
                    <div>
                        <span className="strpg-eyebrow">TURN-BASED COMBAT · ROUND {combat.round}</span>
                        <h2>{combat.encounterKey}</h2>
                    </div>
                    <div className="strpg-row">
                        <Badge tone={combat.isPlayerTurn ? 'success' : 'warning'}>{combat.isPlayerTurn ? 'Your Turn' : `${current?.name ?? '…'} acting`}</Badge>
                        <Button size="sm" variant="ghost" onClick={save} disabled={busy}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={onClose}>Leave</Button>
                    </div>
                </header>
                <div className="strpg-turn-order">
                    {combat.turnOrder.map((entry) => (
                        <span key={entry.id} className={`${entry.id === combat.currentActorId ? 'current' : ''} ${entry.side} ${!entry.alive ? 'dead' : ''}`}>
                            {entry.name}
                        </span>
                    ))}
                </div>
                <div className="strpg-battlefield">
                    <div className="strpg-side enemies">
                        <span className="strpg-eyebrow">ENEMY FORMATION</span>
                        <div className="strpg-combatants">
                            {enemies.map((participant) => (
                                <button
                                    type="button"
                                    key={participant.id}
                                    className={`strpg-combatant enemy ${!participant.alive ? 'dead' : ''} ${targetId === participant.id ? 'targeted' : ''} ${participant.id === combat.currentActorId ? 'acting' : ''}`}
                                    onClick={() => participant.alive && setTargetId(participant.id)}
                                    disabled={!participant.alive}
                                >
                                    <div className="strpg-combatant-avatar">{(participant.name ?? '?').slice(0, 1)}</div>
                                    <div className="strpg-combatant-name">{participant.name}</div>
                                    <Bar label="HP" value={participant.hp} max={participant.maxHp} tone="enemy" compact />
                                    {participant.statuses?.length > 0 && <div className="strpg-status-row">{participant.statuses.map((status) => <span key={status.key}>{status.name}</span>)}</div>}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="strpg-battle-center">
                        <div className="strpg-round-seal">{combat.round}</div>
                        <span>ROUND</span>
                    </div>
                    <div className="strpg-side party">
                        <span className="strpg-eyebrow">YOUR PARTY</span>
                        <div className="strpg-combatants">
                            {party.map((participant) => (
                                <button
                                    type="button"
                                    key={participant.id}
                                    className={`strpg-combatant party ${!participant.alive ? 'dead' : ''} ${participant.id === combat.currentActorId ? 'acting' : ''} ${participant.isPlayer ? 'player' : ''}`}
                                    onClick={() => participant.alive && setTargetId(participant.id)}
                                    disabled={!participant.alive}
                                >
                                    <div className="strpg-combatant-avatar">{(participant.name ?? '?').slice(0, 1)}</div>
                                    <div className="strpg-combatant-name">{participant.name}{participant.isPlayer ? ' ★' : ''}</div>
                                    <Bar label="HP" value={participant.hp} max={participant.maxHp} tone="hp" compact />
                                    <Bar label="MP" value={participant.mp} max={participant.maxMp} tone="mp" compact />
                                    {participant.guarding && <Badge tone="info">Guard</Badge>}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="strpg-combat-bottom">
                    <div className="strpg-combat-log" ref={logRef}>
                        {combat.actions.flatMap((action) => action.result?.log ?? []).map((entry, index) => <div key={index} className={entry.type}>{entry.text}</div>)}
                        {!combat.actions.length && <div className="strpg-muted">The battle has just begun.</div>}
                    </div>
                    <div className="strpg-command-panel">
                        {!combat.isPlayerTurn ? (
                            <div className="strpg-waiting"><span className="strpg-spinner" />Waiting for the enemy...</div>
                        ) : (
                            <>
                                {mode === 'main' && (
                                    <div className="strpg-command-grid">
                                        <Button variant="danger" onClick={attack} disabled={busy || !targetId}>Attack {selected?.side === 'enemy' ? `· ${selected.name}` : ''}</Button>
                                        <Button onClick={() => setMode('skill')} disabled={busy || !combat.skills.length}>Skills</Button>
                                        <Button onClick={() => act({ type: 'guard' }, 'Take a defensive stance')} disabled={busy}>Guard</Button>
                                        <Button onClick={() => setMode('item')} disabled={busy || !combat.items.length}>Items</Button>
                                        <Button variant="ghost" onClick={() => act({ type: 'flee' })} disabled={busy}>Flee</Button>
                                    </div>
                                )}
                                {mode === 'skill' && (
                                    <div className="strpg-command-list">
                                        <div className="strpg-row between"><strong>Choose Skill</strong><Button size="sm" variant="ghost" onClick={() => setMode('main')}>Back</Button></div>
                                        {combat.skills.map((skill) => (
                                            <button type="button" key={skill.key} className="strpg-command-item" disabled={busy || !skill.available} onClick={() => useSkill(skill)}>
                                                <div><strong>{skill.name}</strong><span>{skill.description}</span></div>
                                                <div className="strpg-command-meta">MP {skill.mpCost}{skill.cooldownRemaining ? ` · CD ${skill.cooldownRemaining}` : ''}</div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {mode === 'item' && (
                                    <div className="strpg-command-list">
                                        <div className="strpg-row between"><strong>Use Item</strong><Button size="sm" variant="ghost" onClick={() => setMode('main')}>Back</Button></div>
                                        {combat.items.map((item) => (
                                            <button type="button" key={item.inventoryId} className="strpg-command-item" disabled={busy} onClick={() => useItem(item)}>
                                                <div><strong>{item.name} × {item.quantity}</strong><span>{item.description}</span></div>
                                                <div className="strpg-command-meta">{item.consumable?.healHp ? `+${item.consumable.healHp} HP` : ''}</div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
