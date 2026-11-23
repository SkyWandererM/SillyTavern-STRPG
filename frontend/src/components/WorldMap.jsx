import React, { useEffect, useMemo, useState } from 'react';
import { api, randomIdempotencyKey } from '../api.js';
import { handleOpenChatActions } from '../characterBridge.js';
import { PhaserMap } from './PhaserMap.jsx';
import { Badge, Button, Empty, ErrorBox, Loading, SectionTitle } from '../ui.jsx';

export function WorldMap({ campaignId, revision, notify, onMutated, openCombat }) {
    const [map, setMap] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [region, setRegion] = useState('');
    const [selectedId, setSelectedId] = useState(null);
    const [transition, setTransition] = useState(null);

    const load = async (regionFilter = region) => {
        setLoading(true);
        setError(null);
        try {
            const query = regionFilter ? `?region=${encodeURIComponent(regionFilter)}` : '';
            const data = await api(`/campaigns/${campaignId}/map${query}`);
            setMap(data);
            setSelectedId((current) => current ?? data.current?.id);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (campaignId) load();
    }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const selected = useMemo(() => map?.locations.find((location) => location.id === selectedId) ?? map?.current, [map, selectedId]);
    const connections = map?.connections ?? [];
    const routeFromCurrent = selected && selected.id !== map?.current?.id
        ? connections.find((connection) => connection.fromId === map.current?.id && connection.toId === selected.id)
        : null;

    const changeRegion = async (value) => {
        setRegion(value);
        await load(value);
    };

    const moveTo = async (location) => {
        setTransition(true);
        try {
            const result = await api(`/campaigns/${campaignId}/move`, {
                method: 'POST',
                body: { location: location.key, idempotencyKey: randomIdempotencyKey('move') },
            });
            const eventNames = (result.worldEvents ?? []).map((entry) => entry.name).filter(Boolean);
            const notices = (result.worldEvents ?? []).flatMap((entry) => entry.applied ?? [])
                .filter((entry) => entry.type === 'notice' && entry.text).map((entry) => entry.text);
            const suffix = eventNames.length ? ` Event: ${eventNames.join(', ')}.` : '';
            const noticeText = notices.length ? ` ${notices.join(' ')}` : '';
            notify(`Arrived at ${location.name}.${suffix}${noticeText}`, 'success');
            void handleOpenChatActions(campaignId, result.worldEvents, notify);
            setSelectedId(null);
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setTransition(false);
        }
    };

    const triggerRandomEncounter = async () => {
        setTransition(true);
        try {
            const result = await api(`/campaigns/${campaignId}/explore`, {
                method: 'POST', body: {},
            });
            if (result.status === 'encounter') {
                notify(`Joint dice: party ${result.roll.party.total} vs danger ${result.roll.danger.total}. Encounter!`, 'gold');
                openCombat(result.combat.id);
            } else if (result.status === 'cooldown') {
                notify(`Monsters are respawning${result.respawnAt ? ` at ${new Date(result.respawnAt).toLocaleTimeString()}` : ''}.`, 'warning');
            } else if (result.status === 'safe') {
                notify(`Joint dice: party ${result.roll?.party?.total ?? '?'} vs danger ${result.roll?.danger?.total ?? '?'}. No encounter.`, 'success');
            } else {
                notify('No random encounter table is enabled here.', 'warning');
            }
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setTransition(false);
        }
    };

    const triggerEncounter = async (encounter) => {
        setTransition(true);
        try {
            const combat = await api(`/campaigns/${campaignId}/encounters/propose`, {
                method: 'POST',
                body: {
                    encounterKey: encounter.key,
                    monsters: encounter.monsters,
                    idempotencyKey: randomIdempotencyKey('encounter'),
                },
            });
            notify('Encounter created. Entering the standalone combat UI.', 'gold');
            openCombat(combat.id);
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setTransition(false);
        }
    };

    if (!campaignId) return <Empty title="No Campaign selected" icon="⌘">Create or select a Campaign first.</Empty>;
    if (loading && !map) return <Loading label="Loading world map..." />;
    if (error) return <ErrorBox error={error} onRetry={() => load()} />;
    if (!map) return null;

    return (
        <div className="strpg-map-page">
            <SectionTitle
                eyebrow="WORLD MAP"
                title={map.world?.name ?? 'World Map'}
                description="Display coordinates only determine layout; movement is validated against real location connections and conditions."
                actions={(
                    <div className="strpg-row">
                        <select className="strpg-select compact" value={region} onChange={(event) => changeRegion(event.target.value)}>
                            <option value="">All Regions</option>
                            {map.regions.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                        </select>
                        <Button size="sm" onClick={() => load()}>Refresh</Button>
                    </div>
                )}
            />
            <div className="strpg-map-layout">
                <div className="strpg-map-canvas">
                    <div className="strpg-map-toolbar"><span>PHASER 3 · {map.currentLayer?.toUpperCase() ?? 'WORLD'}</span></div>
                    <PhaserMap data={map} selectedId={selected?.id} onSelect={(location) => setSelectedId(location.id)} />
                    <div className="strpg-map-legend">
                        <span><i className="town" />Town</span>
                        <span><i className="forest" />Forest</span>
                        <span><i className="dungeon" />Dungeon</span>
                        <span><i className="unknown" />Unexplored</span>
                    </div>
                </div>
                <aside className="strpg-map-detail">
                    {selected ? (
                        <>
                            <span className="strpg-eyebrow">{selected.region || 'Unknown Region'}</span>
                            <h3>{selected.name}</h3>
                            <div className="strpg-row wrap">
                                <Badge tone="info">{selected.type}</Badge>
                                {selected.id === map.current?.id && <Badge tone="gold">Current Location</Badge>}
                                {!selected.discovered && selected.id !== map.current?.id && <Badge tone="neutral">Unexplored</Badge>}
                            </div>
                            <p>{selected.description}</p>
                            <div className="strpg-map-actions">
                                {selected.id === map.current?.id && (
                                    <div className="strpg-routes">
                                        <span className="strpg-eyebrow">Available Routes</span>
                                        {connections.filter((connection) => connection.fromId === map.current?.id).map((connection) => {
                                            const target = map.locations.find((location) => location.id === connection.toId);
                                            if (!target) return null;
                                            return (
                                                <button type="button" className="strpg-route" key={connection.id} onClick={() => moveTo(target)} disabled={transition}>
                                                    <span>
                                                        <strong>{target.discovered ? target.name : 'Unexplored Area'}</strong>
                                                        <small>{connection.label || `${connection.fromName} → ${connection.toName}`} · {connection.travelCost}G</small>
                                                    </span>
                                                    <span>Travel ›</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                {selected.id !== map.current?.id && (
                                    <Button variant="gold" onClick={() => moveTo(selected)} disabled={!routeFromCurrent || transition}>
                                        {routeFromCurrent ? `Travel · ${routeFromCurrent.travelCost}G` : 'No direct route'}
                                    </Button>
                                )}
                                {selected.id === map.current?.id && selected.data?.encounters?.length > 0 && (
                                    <div className="strpg-encounters">
                                        <span className="strpg-eyebrow">Local Encounters</span>
                                        {selected.data.encounters.map((encounter) => {
                                            const state = (map.encounters ?? []).find((entry) => entry.key === encounter.key);
                                            return (
                                                <div className="strpg-encounter" key={encounter.key}>
                                                    <div>
                                                        <strong>{encounter.name}</strong>
                                                        <span>{encounter.description}</span>
                                                        {state && !state.ready && <span className="strpg-muted">Respawning{state.respawnAt ? ` · ${new Date(state.respawnAt).toLocaleTimeString()}` : ''}</span>}
                                                    </div>
                                                    <Button size="sm" variant="danger" onClick={() => triggerEncounter(encounter)} disabled={transition || (state && !state.ready)}>Trigger Battle</Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {selected.id === map.current?.id && (map.encounters ?? []).some((entry) => entry.random) && (
                                    <div className="strpg-encounters">
                                        <span className="strpg-eyebrow">Random Encounter · Joint Dice</span>
                                        {(() => {
                                            const state = map.encounters.find((entry) => entry.random);
                                            const random = state?.randomEncounter ?? selected.data?.randomEncounter;
                                            return (
                                                <div className="strpg-encounter">
                                                    <div>
                                                        <strong>{random?.name ?? 'Random Encounter'}</strong>
                                                        <span>{random?.description ?? 'Roll a joint party/danger check while exploring.'}</span>
                                                        <span className="strpg-muted">
                                                            {state?.ready ? 'Ready' : `Respawning${state?.respawnAt ? ` · ${new Date(state.respawnAt).toLocaleTimeString()}` : ''}`}
                                                            {random?.dice ? ` · ${random.dice.count}d${random.dice.sides} + luck/party vs ${random.dice.count}d${random.dice.sides} + ${random.difficulty}` : ''}
                                                        </span>
                                                    </div>
                                                    <Button size="sm" variant="gold" onClick={triggerRandomEncounter} disabled={transition || !state?.ready}>Explore</Button>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>
                            <div className="strpg-divider" />
                            <div className="strpg-kv"><span>Map Coordinates</span><strong>{Math.round(selected.x)}, {Math.round(selected.y)}</strong></div>
                            <div className="strpg-kv"><span>Connections</span><strong>{connections.filter((connection) => connection.fromId === selected.id || connection.toId === selected.id).length}</strong></div>
                            <div className="strpg-kv"><span>Exploration</span><strong>{selected.discovered ? 'Explored' : 'Unexplored'}</strong></div>
                        </>
                    ) : <Empty title="Select a location" icon="⌘">Click a map node to inspect it.</Empty>}
                </aside>
            </div>
        </div>
    );
}




