import React, { useEffect, useState } from 'react';
import { api, downloadJson, getStContext } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Field, Modal, SectionTitle, Select, Textarea } from '../ui.jsx';
import {
    isPushEnabled, loadBridge, pullTrackerNarrative, pushMirrorToTracker, setPushEnabled, trackerAvailable,
} from '../trackerBridge.js';

export function IntegrationsPanel({ campaignId, notify }) {
    const [status, setStatus] = useState(null);
    const [memory, setMemory] = useState(null);
    const [tracker, setTracker] = useState(null);
    const [trackerDraft, setTrackerDraft] = useState({ mood: '', attitude: '', summary: '' });
    const [mapJson, setMapJson] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [memoryOpen, setMemoryOpen] = useState(false);
    const [bridge, setBridge] = useState(null);
    const [candidates, setCandidates] = useState([]);
    const [pushOn, setPushOn] = useState(() => isPushEnabled());
    const [trackerReady, setTrackerReady] = useState(() => trackerAvailable());

    const load = async () => {
        setError(null);
        try {
            setStatus(await api('/integrations'));
            if (campaignId) {
                setTracker(await api(`/campaigns/${campaignId}/integrations/tracker`));
            }
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

    const refreshBridge = async () => {
        if (!campaignId) return;
        try {
            const data = await loadBridge(campaignId);
            setBridge(data.status);
            setCandidates(data.candidates.candidates ?? []);
            setTrackerReady(trackerAvailable());
        } catch (err) {
            notify(`Bridge status failed: ${err.message}`, 'danger');
        }
    };
    useEffect(() => { refreshBridge(); }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

    const pullTracker = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await pullTrackerNarrative(campaignId);
            notify(`Queued ${result.queued} Tracker field(s) for review${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}.`, result.queued ? 'success' : 'warning');
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const pushMirror = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await pushMirrorToTracker(campaignId);
            notify(`Wrote one read-only STRPG line into Tracker world events (${result.events} events kept).`, 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const togglePush = () => {
        const next = !pushOn;
        setPushOn(next);
        setPushEnabled(next);
        notify(next ? 'Tracker push enabled: the STRPG mirror line will be written when you press Push.' : 'Tracker push disabled.', 'info');
    };

    const decideCandidate = async (candidate, action) => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/bridge/candidates/${candidate.id}/${action}`, {
                method: 'POST', body: action === 'reject' ? { note: 'Rejected from the bridge panel' } : {},
            });
            if (action === 'approve') {
                notify(`Applied ${result.applied.target}${result.applied.npcKey ? ` (${result.applied.npcKey})` : ''}. Push the world book to publish the change.`, 'success');
            } else {
                notify('Candidate rejected.', 'info');
            }
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const loadMemory = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const data = await api(`/campaigns/${campaignId}/integrations/memory-books`);
            setMemory(data);
            setMemoryOpen(true);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };


    const pushWorldInfo = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/memory-book/push`, { method: 'POST', body: {} });
            const stats = result.stats ?? {};
            notify(`World book '${result.name}' merged: +${stats.added ?? 0} new, ${stats.updated ?? 0} updated, ${stats.removed ?? 0} removed, ${stats.kept ?? 0} kept (${result.entries} total).`, 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const copyText = async (text, label) => {
        try {
            await navigator.clipboard.writeText(text);
            notify(`${label} copied to clipboard.`, 'success');
        } catch (err) {
            notify(`Copy failed: ${err.message}`, 'danger');
        }
    };

    const syncTracker = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const payload = Object.fromEntries(Object.entries(trackerDraft).filter(([, value]) => String(value).trim()));
            const result = await api(`/campaigns/${campaignId}/integrations/tracker/sync`, { method: 'POST', body: { state: payload } });
            notify(result.status === 'synced' ? 'Narrative fields written to the STRPG mirror and audit log.' : 'Narrative fields buffered.', 'success');
            setTrackerDraft({ mood: '', attitude: '', summary: '' });
            await load();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const importMap = async () => {
        if (!campaignId) return;
        let payload;
        try {
            payload = JSON.parse(mapJson);
        } catch (err) {
            notify(`Invalid map region JSON: ${err.message}`, 'danger');
            return;
        }
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/integrations/map-regions/import`, {
                method: 'POST', body: payload.regions ? payload : { regions: payload },
            });
            notify(`Imported ${result.imported.length} regions; location connections were not changed.`, 'success');
            await load();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const openMapRegionLocator = async () => {
        try {
            const ctx = getStContext();
            if (!ctx.executeSlashCommandsWithOptions) throw new Error('slash command API unavailable');
            await ctx.executeSlashCommandsWithOptions('/show-map');
            notify('Invoked Map Region Locator /show-map.', 'success');
        } catch (err) {
            notify(`Map Region Locator did not respond: ${err.message}`, 'warning');
        }
    };

    if (error) return <ErrorBox error={error} onRetry={load} />;

    return (
        <div className="strpg-integrations-panel">
            <SectionTitle
                eyebrow="ADAPTERS"
                title="External Adapter Bridge"
                description="All integrations use explicit JSON or prompt exports. STRPG remains numerically authoritative and never writes external databases."
                actions={<Button size="sm" onClick={load} disabled={busy}>Refresh Status</Button>}
            />
            <div className="strpg-grid two">
                <section className="strpg-panel">
                    <SectionTitle eyebrow="MEMORY BOOKS" title="Story Memory" description="Export a Memory Books summary or write a structured World Info book into SillyTavern." />
                    <p className="strpg-muted">The export contains location, story node, active quests, recent events and the world/location/NPC/quest facts. The World Info push writes a named book; HP/EXP remain authoritative in STRPG.</p>
                    <div className="strpg-row wrap">
                        <Button variant="gold" onClick={loadMemory} disabled={!campaignId || busy}>Generate Memory Books Summary</Button>
                        <Button variant="ghost" onClick={() => downloadJson(`/campaigns/${campaignId}/integrations/memory-books`, 'strpg-memory-books.json').catch((err) => notify(err.message, 'danger'))} disabled={!campaignId}>Download Full JSON</Button>
                        <Button variant="gold" onClick={pushWorldInfo} disabled={!campaignId || busy}>Push to World Info</Button>
                    </div>
                </section>
                <section className="strpg-panel">
                    <SectionTitle eyebrow="MAP REGION LOCATOR" title="Map Regions" description="Map Region Locator keeps image, region editing, and marker features; STRPG exchanges region metadata only." />
                    <div className="strpg-row wrap">
                        <Button onClick={openMapRegionLocator}>Open Map Region Locator</Button>
                        <Button variant="ghost" onClick={() => downloadJson(`/campaigns/${campaignId}/integrations/map-regions/export`, 'strpg-map-regions.json').catch((err) => notify(err.message, 'danger'))} disabled={!campaignId}>Export Region JSON</Button>
                    </div>
                    <Field label="Import Region JSON" hint="Accepts {regions:[...]} or an array. Only display metadata changes; location connections are not modified.">
                        <Textarea rows={4} value={mapJson} onChange={(event) => setMapJson(event.target.value)} placeholder='{"regions":[{"locationKey":"greenwood_edge","regionId":"forest_edge","polygon":[[0,0],[100,0],[100,100]]}]}' />
                    </Field>
                    <Button onClick={importMap} disabled={!campaignId || !mapJson.trim() || busy}>Import Regions</Button>
                </section>
            </div>
            <div className="strpg-grid two">
                <section className="strpg-panel">
                    <SectionTitle eyebrow="RPG TRACKER" title="Narrative Mirror" description="Whitelisted narrative fields only. HP, EXP, items, and skills are never written to Tracker." />
                    <div className="strpg-row">
                        <Badge tone={status?.adapters?.find((entry) => entry.id === 'rpg-tracker')?.status === 'synced' ? 'success' : 'info'}>
                            {status?.adapters?.find((entry) => entry.id === 'rpg-tracker')?.status ?? 'available'}
                        </Badge>
                        <span className="strpg-muted">Last mirror: {tracker?.state?.updatedAt ? new Date(tracker.state.updatedAt).toLocaleString() : 'None'}</span>
                    </div>
                    <div className="strpg-form">
                        <Field label="Mood"><Textarea rows={2} value={trackerDraft.mood} onChange={(event) => setTrackerDraft({ ...trackerDraft, mood: event.target.value })} placeholder="wary, tired, hopeful..." /></Field>
                        <Field label="Attitude"><Textarea rows={2} value={trackerDraft.attitude} onChange={(event) => setTrackerDraft({ ...trackerDraft, attitude: event.target.value })} placeholder="Respectful of the elder, but suspicious." /></Field>
                        <Field label="Summary"><Textarea rows={3} value={trackerDraft.summary} onChange={(event) => setTrackerDraft({ ...trackerDraft, summary: event.target.value })} placeholder="Character reactions and relationship changes from this story turn." /></Field>
                        <Button variant="gold" onClick={syncTracker} disabled={!campaignId || busy}>Sync Whitelisted Narrative Fields</Button>
                    </div>
                </section>
                <section className="strpg-panel">
                    <SectionTitle eyebrow="AUTHORITY" title="Data Ownership" />
                    <div className="strpg-authority-list">
                        {['HP / MP', 'EXP / Level', 'Gold', 'Equipment', 'Skills', 'Inventory', 'Quests', 'Combat'].map((field) => (
                            <div key={field}><span>{field}</span><Badge tone="gold">STRPG Core</Badge></div>
                        ))}
                        {['Mood / Attitude', 'Relationships', 'Unresolved Story', 'Scene Summary'].map((field) => (
                            <div key={field}><span>{field}</span><Badge tone="info">External narrative mirror</Badge></div>
                        ))}
                    </div>
                    <p className="strpg-muted">If an external extension is missing or fails, authoritative state remains in STRPG SQLite.</p>
                </section>
            </div>
            <section className="strpg-panel">
                <SectionTitle
                    eyebrow="M1 · CHAT ↔ RPG BRIDGE"
                    title="State & Memory Bridge"
                    description="Pull whitelisted Tracker narrative fields into a review queue, approve them into STRPG, then publish the world book. STRPG stays authoritative for every number."
                    actions={<Button size="sm" onClick={refreshBridge} disabled={busy}>Refresh Queue</Button>}
                />
                <div className="strpg-row wrap">
                    <Badge tone={trackerReady ? 'success' : 'info'}>{trackerReady ? 'RPG Tracker detected' : 'RPG Tracker not loaded'}</Badge>
                    <Badge tone={(bridge?.counts?.PENDING ?? 0) ? 'gold' : 'info'}>{bridge?.counts?.PENDING ?? 0} pending candidate(s)</Badge>
                    {bridge?.lastApply && (
                        <span className="strpg-muted">
                            Last applied: {bridge.lastApply.target} · {new Date(bridge.lastApply.appliedAt).toLocaleString()}
                        </span>
                    )}
                </div>
                <div className="strpg-row wrap">
                    <Button onClick={pullTracker} disabled={busy || !campaignId || !trackerReady}>Pull Tracker → Review Queue</Button>
                    <Button variant="ghost" onClick={pushMirror} disabled={busy || !campaignId || !trackerReady || !pushOn}>Push STRPG Mirror → Tracker</Button>
                    <Button variant={pushOn ? 'gold' : 'ghost'} onClick={togglePush}>
                        {pushOn ? 'Tracker push: ON' : 'Tracker push: OFF'}
                    </Button>
                    <Button variant="gold" onClick={pushWorldInfo} disabled={!campaignId || busy}>Publish World Book (incremental)</Button>
                    {campaignId && (
                        <Button variant="ghost" onClick={() => downloadJson(`/campaigns/${campaignId}/bridge/mirror`, 'strpg-bridge-mirror.json').catch((err) => notify(err.message, 'danger'))}>Download Mirror</Button>
                    )}
                </div>
                <p className="strpg-muted">
                    Relationship changes are capped at ±{bridge?.relationBounds?.maxStep ?? 2} per approval and stay inside {bridge?.relationBounds?.min ?? -100}…{bridge?.relationBounds?.max ?? 100}. Approving a candidate changes STRPG state immediately; publishing the world book makes it visible to the chat.
                </p>
                {candidates.length ? (
                    <div className="strpg-form">
                        {candidates.map((candidate) => (
                            <div key={candidate.id} className="strpg-item-card">
                                <div className="strpg-item-head">
                                    <div className="strpg-item-icon">{candidate.kind === 'relation' ? '✦' : candidate.kind === 'narrative' ? '✎' : '⚑'}</div>
                                    <div>
                                        <strong>{candidate.payload?.npcName ?? candidate.payload?.npcKey ?? 'World narrative'}</strong>
                                        <span>{candidate.kind} · {candidate.source} · {new Date(candidate.createdAt).toLocaleString()}</span>
                                    </div>
                                    <Badge tone="info">{candidate.status}</Badge>
                                </div>
                                <p className="strpg-muted">{describeCandidate(candidate)}</p>
                                {candidate.evidence && Object.keys(candidate.evidence).length > 0 && (
                                    <code>{JSON.stringify(candidate.evidence).slice(0, 240)}</code>
                                )}
                                <div className="strpg-row end">
                                    <Button variant="gold" onClick={() => decideCandidate(candidate, 'approve')} disabled={busy}>Approve</Button>
                                    <Button onClick={() => decideCandidate(candidate, 'reject')} disabled={busy}>Reject</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : <Empty title="No pending candidates" icon="◇" />}
            </section>
            {memoryOpen && <Modal
                title="Memory Books Summary"
                subtitle="Copy into a Memory Books memory entry or Side Prompt. STRPG never writes its internal database."
                onClose={() => setMemoryOpen(false)}
                wide
                footer={(
                    <div className="strpg-row end">
                        <Button onClick={() => { setMemoryOpen(false); downloadJson(`/campaigns/${campaignId}/integrations/memory-books`, 'strpg-memory-books.json').catch((err) => notify(err.message, 'danger')); }}>Download JSON</Button>
                        <Button variant="gold" onClick={() => copyText(memory?.markdown ?? '', 'Memory Books Summary')}>Copy Summary</Button>
                    </div>
                )}
            >
                {memory ? <pre className="strpg-memory-pre">{memory.markdown}</pre> : <Empty title="Not generated yet" icon="✦" />}
            </Modal>}
        </div>
    );
}

function describeCandidate(candidate) {
    if (candidate.kind === 'relation') {
        return `Relation ${candidate.payload?.before ?? '?'} → ${candidate.payload?.after ?? '?'}: ${candidate.payload?.reason ?? ''}`;
    }
    if (candidate.kind === 'narrative') {
        return Object.entries(candidate.payload?.fields ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join('  ·  ')
            .slice(0, 400);
    }
    if (candidate.kind === 'flag') return `Flag: ${candidate.payload?.flag ?? ''}`;
    return JSON.stringify(candidate.payload ?? {}).slice(0, 300);
}
