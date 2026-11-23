import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, randomIdempotencyKey } from '../api.js';
import { Badge, Button, ProgressDots } from '../ui.jsx';

function useStoredFlag(key, fallback) {
    const [value, setValue] = useState(() => {
        try {
            const stored = localStorage.getItem(key);
            return stored == null ? fallback : stored === '1';
        } catch {
            return fallback;
        }
    });
    const update = (next) => {
        setValue(next);
        try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* storage is optional */ }
    };
    return [value, update];
}

function useDraggablePosition(storageKey) {
    const ref = useRef(null);
    const drag = useRef(null);
    const suppressClick = useRef(false);
    const [position, setPosition] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) return saved;
        } catch { /* storage is optional */ }
        return null;
    });

    useEffect(() => {
        if (!position) return;
        try { localStorage.setItem(storageKey, JSON.stringify(position)); } catch { /* storage is optional */ }
    }, [position, storageKey]);

    useEffect(() => {
        if (position) return;
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPosition({
            left: Math.max(8, window.innerWidth - 10 - rect.width),
            top: Math.max(8, window.innerHeight / 2 - rect.height / 2),
        });
    }, [position]);

    useEffect(() => {
        const onResize = () => setPosition((current) => {
            if (!current) return current;
            const width = ref.current?.offsetWidth ?? 54;
            const height = ref.current?.offsetHeight ?? 220;
            return {
                left: Math.min(current.left, Math.max(8, window.innerWidth - width - 8)),
                top: Math.min(current.top, Math.max(8, window.innerHeight - height - 8)),
            };
        });
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.startX;
        const dy = event.clientY - active.startY;
        if (!active.moved && Math.abs(dx) + Math.abs(dy) <= 3) return;
        active.moved = true;
        setPosition({
            left: Math.min(Math.max(active.left + dx, 8), Math.max(8, window.innerWidth - active.width - 8)),
            top: Math.min(Math.max(active.top + dy, 8), Math.max(8, window.innerHeight - active.height - 8)),
        });
    };
    const finishDrag = () => {
        if (!drag.current) return;
        suppressClick.current = drag.current.moved;
        drag.current = null;
    };
    const onClickCapture = (event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.stopPropagation();
        event.preventDefault();
    };
    const reset = () => setPosition(null);
    const style = position
        ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto', transform: 'none' }
        : undefined;
    return {
        ref,
        style,
        handlers: {
            onPointerDown,
            onPointerMove,
            onPointerUp: finishDrag,
            onPointerCancel: finishDrag,
            onClickCapture,
            onDoubleClick: reset,
        },
    };
}

function hpPercent(player) {
    return Math.max(0, Math.min(100, (Number(player?.hp ?? 0) / Math.max(1, Number(player?.stats?.maxHp ?? 1))) * 100));
}

/**
 * The in-chat RPG status rail. It is deliberately read-mostly: it shows the
 * authoritative state and offers the few actions a player needs mid-scene
 * (travel, explore, open battle), without duplicating the full control panel.
 */
export function ChatHud({ dashboard, campaignId, onOpen, onCombat, onRefresh, notify, setTab }) {
    const [collapsed, setCollapsed] = useStoredFlag('strpg.hud.collapsed', false);
    const [busy, setBusy] = useState(false);
    const railDrag = useDraggablePosition('strpg.hud.rail.position.v1');
    const campaign = dashboard?.campaign;
    const player = dashboard?.player;
    const location = dashboard?.location;
    const combat = dashboard?.combat ?? dashboard?.pendingCombat;
    const quests = dashboard?.activeQuests ?? [];
    const party = dashboard?.party ?? [];
    const exits = dashboard?.exits ?? [];
    const effects = dashboard?.effects ?? [];
    const leadQuest = quests[0] ?? null;
    const leadStage = useMemo(() => {
        if (!leadQuest) return null;
        return (leadQuest.stages ?? []).find((stage) => stage.key === leadQuest.stageKey) ?? leadQuest.stages?.[0] ?? null;
    }, [leadQuest]);

    if (!campaign || !player || !location) return null;

    const travel = async (exit) => {
        if (!exit.available) {
            notify?.(exit.lockedReason === 'gold' ? 'Not enough gold for that route.' : 'That route is locked by a condition.', 'warning');
            return;
        }
        setBusy(true);
        try {
            await api(`/campaigns/${campaignId}/move`, {
                method: 'POST',
                body: { location: exit.key, idempotencyKey: randomIdempotencyKey('hud-move') },
            });
            notify?.(`Travelled to ${exit.name}.`, 'success');
            await onRefresh?.(campaignId, { silent: true });
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const explore = async () => {
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/explore`, { method: 'POST', body: {} });
            if (result?.status === 'encounter' && result.combat?.id) {
                notify?.('Random encounter!', 'gold');
                onCombat?.(result.combat.id);
            } else if (result?.status === 'cooldown') {
                notify?.('The area is still respawning.', 'info');
            } else {
                notify?.(result?.status === 'safe' ? 'The area is quiet.' : 'Explored.', 'info');
            }
            await onRefresh?.(campaignId, { silent: true });
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    if (collapsed) {
        const percent = hpPercent(player);
        return (
            <aside
                ref={railDrag.ref}
                className="strpg-hud-rail"
                style={railDrag.style}
                aria-label="STRPG status rail"
                title="Drag to move · double-click to reset"
                {...railDrag.handlers}
            >
                <button type="button" className="strpg-hud-rail-mark" onClick={() => setCollapsed(false)} title="Expand STRPG status">
                    S
                </button>
                <button type="button" className="strpg-hud-rail-level" onClick={() => setCollapsed(false)} title={`${player.name} · Lv.${player.level}`}>
                    <strong>{player.level}</strong><span>LV</span>
                </button>
                <button type="button" className="strpg-hud-rail-hp" onClick={() => setCollapsed(false)} title={`HP ${player.hp}/${player.stats.maxHp}`}>
                    <div className="strpg-hud-rail-track"><i style={{ height: `${percent}%` }} /></div>
                    <span>{Math.round(percent)}%</span>
                </button>
                {combat && (
                    <button type="button" className={`strpg-hud-rail-combat ${combat.status}`} onClick={() => onCombat?.(combat.id)} title="Combat pending">
                        ⚔
                    </button>
                )}
                {quests.length > 0 && (
                    <button type="button" className="strpg-hud-rail-quest" onClick={() => { setTab?.('quests'); onOpen?.(); }} title={`${quests.length} active quests`}>
                        !<span>{quests.length}</span>
                    </button>
                )}
                <button type="button" className="strpg-hud-rail-open" onClick={() => { setTab?.('dashboard'); onOpen?.(); }} title="Open the full game panel">
                    ⤢
                </button>
            </aside>
        );
    }

    return (
        <aside className="strpg-hud" aria-label="STRPG game status">
            <header className="strpg-hud-head">
                <div className="strpg-hud-brand">
                    <span className="strpg-hud-mark">S</span>
                    <div>
                        <span>{dashboard.world?.name ?? 'STRPG'}</span>
                        <strong>{location.name}</strong>
                    </div>
                </div>
                <div className="strpg-hud-head-actions">
                    <button type="button" onClick={() => { setTab?.('dashboard'); onOpen?.(); }} title="Open the full game panel">⤢</button>
                    <button type="button" onClick={() => setCollapsed(true)} title="Collapse to the status rail">—</button>
                </div>
            </header>

            <div className="strpg-hud-vitals">
                <div className="strpg-hud-portrait">{player.data?.portrait ? <img src={player.data.portrait} alt="" /> : (player.name ?? '?').slice(0, 1)}</div>
                <div className="strpg-hud-vitals-body">
                    <div className="strpg-hud-name">
                        <strong>{player.name}</strong>
                        <span>Lv.{player.level} · {player.data?.classKey ?? 'adventurer'}</span>
                        <Badge tone="gold">{dashboard.inventory?.gold ?? player.gold ?? 0} G</Badge>
                    </div>
                    <div className="strpg-hud-bar hp"><span>HP</span><i style={{ width: `${hpPercent(player)}%` }} /><em>{player.hp}/{player.stats.maxHp}</em></div>
                    <div className="strpg-hud-bar mp"><span>MP</span><i style={{ width: `${Math.max(0, Math.min(100, (player.mp / Math.max(1, player.stats.maxMp)) * 100))}%` }} /><em>{player.mp}/{player.stats.maxMp}</em></div>
                </div>
            </div>
            {effects.length > 0 && (
                <div className="strpg-hud-effects">
                    {effects.map((effect) => <span key={effect.key} title={`${effect.duration} turns`}>{effect.name}{effect.stacks > 1 ? ` ×${effect.stacks}` : ''}</span>)}
                </div>
            )}

            <div className="strpg-hud-section">
                <div className="strpg-hud-section-head"><span>PARTY</span><button type="button" onClick={() => { setTab?.('characters'); onOpen?.(); }}>People ›</button></div>
                <div className="strpg-hud-party">
                    <button type="button" className="strpg-hud-member player" onClick={() => { setTab?.('characters'); onOpen?.(); }} title={player.name}>
                        <span>{(player.name ?? '?').slice(0, 1)}</span>
                        <small>YOU</small>
                    </button>
                    {party.map((member) => (
                        <button type="button" key={member.id} className="strpg-hud-member" onClick={() => { setTab?.('characters'); onOpen?.(); }} title={`${member.name} · ${member.hp}/${member.maxHp}`}>
                            <span>{member.portrait ? <img src={member.portrait} alt="" /> : (member.name ?? '?').slice(0, 1)}</span>
                            <small style={{ '--strpg-hp': `${Math.max(0, Math.min(100, (member.hp / Math.max(1, member.maxHp)) * 100))}%` }}>{member.name.split(' ')[0]}</small>
                        </button>
                    ))}
                    {!party.length && <span className="strpg-hud-empty">Travelling alone</span>}
                </div>
            </div>

            {combat ? (
                <div className={`strpg-hud-combat ${combat.status}`}>
                    <div>
                        <span className="strpg-hud-combat-kicker">{combat.status === 'active' ? 'BATTLE ACTIVE' : 'HOSTILE ENCOUNTER'}</span>
                        <strong>{combat.enemies?.map((enemy) => enemy.name).slice(0, 2).join(', ') || combat.encounterKey || 'Enemies'}</strong>
                        <small>Round {combat.round}{combat.isPlayerTurn ? ' · your turn' : combat.currentActor ? ` · ${combat.currentActor}` : ''}</small>
                    </div>
                    <Button size="sm" variant={combat.status === 'active' ? 'danger' : 'gold'} onClick={() => onCombat?.(combat.id)}>
                        {combat.status === 'active' ? 'Fight' : 'Enter'}
                    </Button>
                </div>
            ) : (
                <div className="strpg-hud-calm">
                    <span>No hostiles in the scene.</span>
                    <Button size="sm" variant="ghost" onClick={explore} disabled={busy}>Explore</Button>
                </div>
            )}

            <div className="strpg-hud-section">
                <div className="strpg-hud-section-head"><span>QUESTS</span><button type="button" onClick={() => { setTab?.('quests'); onOpen?.(); }}>{quests.length} active ›</button></div>
                {leadQuest ? (
                    <div className="strpg-hud-quest">
                        <div><Badge tone={leadQuest.type === 'main' ? 'gold' : 'info'}>{leadQuest.type}</Badge><strong>{leadQuest.name}</strong></div>
                        {leadStage && <p>{leadStage.description || leadStage.name}</p>}
                        {leadStage?.objectives?.length ? (
                            <div className="strpg-hud-objectives">
                                {leadStage.objectives.slice(0, 3).map((objective) => (
                                    <div key={objective.key} className={objective.completed ? 'done' : ''}>
                                        <span>{objective.label || objective.key}</span>
                                        <ProgressDots value={objective.current} max={objective.count} />
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : <span className="strpg-hud-empty">No active quest. Talk to someone local.</span>}
            </div>

            <div className="strpg-hud-section">
                <div className="strpg-hud-section-head"><span>ROUTES</span><button type="button" onClick={() => { setTab?.('map'); onOpen?.(); }}>Map ›</button></div>
                <div className="strpg-hud-exits">
                    {exits.slice(0, 3).map((exit) => (
                        <button type="button" key={exit.key} disabled={busy || !exit.available} onClick={() => travel(exit)} title={exit.available ? `${exit.mode} · ${exit.travelCost} G` : (exit.lockedReason === 'gold' ? 'Not enough gold' : 'Condition not met')}>
                            <span>{exit.name}</span><small>{exit.lockedReason ? '🔒' : `${exit.travelCost} G`}</small>
                        </button>
                    ))}
                    {!exits.length && <span className="strpg-hud-empty">No mapped route from here.</span>}
                </div>
            </div>

            <footer className="strpg-hud-foot">
                <button type="button" onClick={() => { setTab?.('map'); onOpen?.(); }}>Map</button>
                <button type="button" onClick={() => { setTab?.('characters'); onOpen?.(); }}>Party</button>
                <button type="button" onClick={() => { setTab?.('quests'); onOpen?.(); }}>Quests</button>
                <button type="button" onClick={() => { setTab?.('inventory'); onOpen?.(); }}>Bag</button>
                <button type="button" className="accent" onClick={() => { setTab?.('dashboard'); onOpen?.(); }}>Full</button>
            </footer>
        </aside>
    );
}
