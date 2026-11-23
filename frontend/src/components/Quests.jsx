import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Loading, ProgressDots, SectionTitle, StatusBadge } from '../ui.jsx';

export function Quests({ campaignId, revision, notify, onMutated }) {
    const [quests, setQuests] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('active');
    const [busy, setBusy] = useState(null);
    const [expanded, setExpanded] = useState(null);

    const load = async () => {
        if (!campaignId) return;
        setError(null);
        try {
            setQuests(await api(`/campaigns/${campaignId}/quests`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        if (!quests) return [];
        if (filter === 'active') return quests.filter((quest) => ['active', 'ready_to_turn_in'].includes(quest.status));
        if (filter === 'available') return quests.filter((quest) => quest.status === 'available');
        if (filter === 'done') return quests.filter((quest) => ['completed', 'turned_in'].includes(quest.status));
        return quests;
    }, [quests, filter]);

    const act = async (quest, action) => {
        setBusy(quest.key);
        try {
            await api(`/campaigns/${campaignId}/quests/${quest.key}/${action}`, { method: 'POST', body: {} });
            notify(action === 'accept' ? `Accepted quest "${quest.name}"` : `Turned in quest "${quest.name}"`, 'success');
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(null);
        }
    };

    if (!campaignId) return <Empty title="No Campaign selected" icon="!" />;
    if (!quests && !error) return <Loading label="Loading quest log..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    return (
        <div className="strpg-quests">
            <SectionTitle eyebrow="QUEST LOG" title="Quests" description="All objectives are verified by the rules engine. Unmet prerequisites block acceptance." />
            <div className="strpg-chip-row">
                {[['active', 'Active'], ['available', 'Available'], ['done', 'Completed'], ['all', 'All']].map(([value, label]) => (
                    <button type="button" key={value} className={`strpg-chip ${filter === value ? 'active' : ''}`} onClick={() => setFilter(value)}>
                        {label}<span>{quests.filter((quest) => value === 'all'
                            ? true
                            : value === 'active' ? ['active', 'ready_to_turn_in'].includes(quest.status)
                                : value === 'available' ? quest.status === 'available'
                                    : ['completed', 'turned_in'].includes(quest.status)).length}</span>
                    </button>
                ))}
            </div>
            <div className="strpg-quest-list">
                {filtered.map((quest) => {
                    const stage = quest.stages?.find((entry) => entry.key === quest.stageKey);
                    const open = expanded === quest.key;
                    return (
                        <article className={`strpg-quest-card ${quest.type} ${open ? 'open' : ''}`} key={quest.key}>
                            <header>
                                <div className="strpg-quest-marker">{quest.type === 'main' ? 'M' : quest.type === 'hidden' ? 'H' : 'S'}</div>
                                <div className="strpg-quest-title">
                                    <div className="strpg-row wrap">
                                        <h3>{quest.name}</h3>
                                        <StatusBadge status={quest.status} />
                                        {quest.status === 'ready_to_turn_in' && <Badge tone="gold">Ready to Turn In</Badge>}
                                    </div>
                                    <p>{quest.description}</p>
                                </div>
                                <div className="strpg-quest-actions">
                                    {quest.status === 'available' && <Button size="sm" variant="gold" disabled={busy === quest.key} onClick={() => act(quest, 'accept')}>Accept</Button>}
                                    {quest.status === 'ready_to_turn_in' && <Button size="sm" variant="gold" disabled={busy === quest.key} onClick={() => act(quest, 'turn-in')}>Turn In</Button>}
                                    <Button size="sm" variant="ghost" onClick={() => setExpanded(open ? null : quest.key)}>{open ? 'Collapse' : 'Details'}</Button>
                                </div>
                            </header>
                            {stage && (
                                <div className="strpg-quest-stage">
                                    <span className="strpg-eyebrow">Current stage{stage.mode === 'any' ? ' · any objective' : ''}</span>
                                    <strong>{stage.name}</strong>
                                    <p>{stage.description}</p>
                                    <div className="strpg-objectives">
                                        {stage.objectives.map((objective) => (
                                            <div key={objective.key} className={objective.completed ? 'done' : ''}>
                                                <span>{objective.label || objective.key}</span>
                                                <ProgressDots value={objective.current} max={objective.count} />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {open && (
                                <div className="strpg-quest-detail">
                                    {quest.stages.map((entry, index) => (
                                        <div className={`strpg-quest-stage-block ${entry.key === quest.stageKey ? 'current' : ''}`} key={entry.key}>
                                            <span>Stage {index + 1}</span>
                                            <strong>{entry.name}</strong>
                                            <div className="strpg-objectives">
                                                {entry.objectives.map((objective) => (
                                                    <div key={objective.key} className={objective.completed ? 'done' : ''}>
                                                        <span>{objective.label || `${objective.type}:${objective.targetKey}`}</span>
                                                        <span className="strpg-progress-text">{objective.current} / {objective.count}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                    <div className="strpg-reward-row">
                                        <Badge tone="info">{quest.rewards?.exp ?? 0} EXP</Badge>
                                        <Badge tone="gold">{quest.rewards?.gold ?? 0} G</Badge>
                                        {(quest.rewards?.items ?? []).map((item) => <Badge key={item.itemKey} tone="success">{item.itemKey} × {item.quantity}</Badge>)}
                                        {(quest.rewards?.skills ?? []).map((skill) => <Badge key={skill} tone="info">Skills {skill}</Badge>)}
                                    </div>
                                    {quest.prerequisites?.length > 0 && <p className="strpg-muted">Prerequisites: {quest.prerequisites.join(', ')}</p>}
                                    {quest.turnIn?.npcKey && <p className="strpg-muted">Turn-in NPC: {quest.turnIn.npcKey} (you must be at that NPC's location)</p>}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>
            {!filtered.length && <Empty title="No matching quests" icon="!">Talk to town NPCs to discover more quests.</Empty>}
        </div>
    );
}

