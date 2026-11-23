import React, { useEffect, useState } from 'react';
import { api, downloadJson, getStContext } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Field, Input, Modal, SectionTitle, Select, Textarea } from '../ui.jsx';
import { performChatLine } from '../chatBridge.js';
import { manualIngest, scanScope, SCOPE_MANUAL_HINTS } from '../scopeBridge.js';
import { bindCurrentCharacter, importCurrentCardAsNpc, openCharacterByAvatar, removeBinding, loadBindings } from '../characterBridge.js';
import { applyAutoSchedule, getAutoSettings, setAutoSettings } from '../scopeScheduler.js';
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
    const [signalName, setSignalName] = useState('');
    const [scopes, setScopes] = useState([]);
    const [bindings, setBindings] = useState([]);
    const [npcKeyInput, setNpcKeyInput] = useState('');
    const [autoSettings, setAuto] = useState(() => getAutoSettings());
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
            const [data, scopeData] = await Promise.all([
                loadBridge(campaignId),
                api(`/campaigns/${campaignId}/scopes`),
            ]);
            setBridge(data.status);
            setCandidates(data.candidates.candidates ?? []);
            setScopes(scopeData.scopes ?? []);
            setBindings(bindingData.bindings ?? []);
            setTrackerReady(trackerAvailable());
        } catch (err) {
            notify(`Bridge status failed: ${err.message}`, 'danger');
        }
    };
    useEffect(() => { refreshBridge(); }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

    const addStarterScopes = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/scopes/defaults`, { method: 'POST', body: {} });
            setScopes(result.scopes ?? []);
            notify(`Starter scopes ready (${(result.scopes ?? []).length}).`, 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const runScope = async (scope) => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await scanScope(campaignId, scope);
            if (result.skipped) {
                notify(`Scope skipped: ${result.reason}`, 'warning');
            } else {
                notify(`Scope '${scope.key}': ${result.queued} queued${result.duplicates ? `, ${result.duplicates} duplicate` : ''}${result.skipped?.length ? `, ${result.skipped.length} skipped` : ''}.`, result.queued ? 'success' : 'info');
            }
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const manualScope = async (scope) => {
        if (!campaignId) return;
        const hint = SCOPE_MANUAL_HINTS[scope.config?.extract?.kind] ?? '';
        const text = globalThis.prompt?.(`Manual ingest for '${scope.key}'\n你可以直接写一句摘要，或粘贴 JSON：\n${hint}`, '');
        if (!text) return;
        setBusy(true);
        try {
            const result = await manualIngest(campaignId, scope, text);
            notify(`Manual ingest: ${result.queued} queued${result.duplicates ? `, ${result.duplicates} duplicate` : ''}${result.skipped?.length ? `, ${result.skipped.length} skipped` : ''}.`, result.queued ? 'success' : 'warning');
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

const bindCurrent = async () => {
        if (!campaignId) return;
        const npcKey = npcKeyInput.trim() || globalThis.prompt?.('要绑定的 NPC key（留空=玩家人格）：', 'elder_mira') || '';
        setBusy(true);
        try {
            const binding = await bindCurrentCharacter(campaignId, npcKey.trim() || null);
            notify(`Bound ${binding.stAvatar} → ${binding.npcName ?? 'player persona'}.`, 'success');
            setNpcKeyInput('');
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const importCard = async () => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const result = await importCurrentCardAsNpc(campaignId);
            notify(`Created DRAFT NPC '${result.asset.key}' (rev ${result.asset.revision}). Validate → review → publish → build → Campaign Upgrade.`, 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const openBindingChat = async (binding) => {
        try {
            await openCharacterByAvatar(binding.stAvatar);
            notify(`Opened ${binding.stCharacterName || binding.stAvatar}.`, 'success');
        } catch (err) {
            notify(err.message, 'warning');
        }
    };

    const unbind = async (binding) => {
        setBusy(true);
        try {
            await removeBinding(campaignId, binding.id);
            notify('Binding removed.', 'info');
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const toggleAuto = async () => {
        if (!campaignId) return;
        const next = setAutoSettings({ ...autoSettings, enabled: !autoSettings.enabled });
        setAuto(next);
        setBusy(true);
        try {
            const result = await applyAutoSchedule(campaignId, next);
            notify(`Auto-scan ${next.enabled ? `every ${next.everyN} messages` : 'off'} (${result.updated} scope(s) updated).`, 'success');
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const changeAutoN = async (value) => {
        const next = setAutoSettings({ ...autoSettings, everyN: value });
        setAuto(next);
        if (!next.enabled || !campaignId) return;
        setBusy(true);
        try {
            await applyAutoSchedule(campaignId, next);
            await refreshBridge();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

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

    const decideCandidate = async (candidate, action, options = {}) => {
        if (!campaignId) return;
        setBusy(true);
        try {
            const body = action === 'reject'
                ? { note: options.note ?? 'Rejected from the bridge panel' }
                : (options.overrideReason ? { overrideReason: options.overrideReason } : {});
            const result = await api(`/campaigns/${campaignId}/bridge/candidates/${candidate.id}/${action}`, { method: 'POST', body });
            if (action === 'approve' && result.applied?.target === 'chat.performance') {
                try {
                    await performChatLine(result.applied);
                    notify('Performance written into the current chat.', 'success');
                } catch (err) {
                    notify(`Performance approved but not written: ${err.message}`, 'warning');
                }
            } else if (action === 'approve') {
                notify(`Applied ${result.applied.target}${result.applied.npcKey ? ` (${result.applied.npcKey})` : ''}. Push the world book to publish the change.`, 'success');
            } else {
                notify('Candidate rejected.', 'info');
            }
            await refreshBridge();
            globalThis.window?.dispatchEvent?.(new CustomEvent('strpg:bridge-changed'));
        } catch (err) {
            if (action === 'approve' && (err.code === 'AWAITING_SIGNAL' || err.code === 'INSUFFICIENT_PAYMENT')) {
                const missing = (err.details?.missing ?? []).map((entry) => `${entry.kind}${entry.key ? `:${entry.key}` : ''}`).join(', ');
                const reason = globalThis.prompt?.(`仍缺：${missing || err.message}\n输入手动放行理由（会写入审计）：`, '剧情中已用其他方式完成代价');
                if (reason) {
                    setBusy(false);
                    await decideCandidate(candidate, 'approve', { overrideReason: reason });
                    return;
                }
            }
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const sendSignal = async () => {
        if (!campaignId || !signalName.trim()) return;
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/bridge/signals/${encodeURIComponent(signalName.trim())}`, {
                method: 'POST', body: { note: 'Sent from the bridge panel' },
            });
            notify(`Signal '${result.signal}' recorded. ${result.released.length} proposal(s) released${result.waiting.length ? `, ${result.waiting.length} waiting for manual approval` : ''}.`, result.released.length ? 'success' : 'info');
            setSignalName('');
            await refreshBridge();
            globalThis.window?.dispatchEvent?.(new CustomEvent('strpg:bridge-changed'));
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
                <div className="strpg-row wrap">
                    <Field label="Signal receipt" hint="e.g. mira_favor_paid — releases proposals whose cost waits for it">
                        <Input value={signalName} onChange={(event) => setSignalName(event.target.value)} placeholder="mira_favor_paid" />
                    </Field>
                    <Button onClick={sendSignal} disabled={!campaignId || busy || !signalName.trim()}>Send Signal</Button>
                </div>
                <p className="strpg-muted">
                    Relationship changes are capped at ±{bridge?.relationBounds?.maxStep ?? 2} per approval and stay inside {bridge?.relationBounds?.min ?? -100}…{bridge?.relationBounds?.max ?? 100}. Non-cash costs (signal / flag / quest / manual) are checked at approval; if a receipt is missing you can still release the proposal with a written reason, which is recorded in the audit log. Approving a candidate changes STRPG state immediately; publishing the world book makes it visible to the chat.
                </p>
                {candidates.length ? (
                    <div className="strpg-form">
                        {candidates.map((candidate) => {
                            const requirements = candidate.payload?.requirements;
                            const unmet = Array.isArray(requirements?.checks) && requirements.checks.some((check) => !check.satisfied);
                            return (
                            <div key={candidate.id} className="strpg-item-card">
                                <div className="strpg-item-head">
                                    <div className="strpg-item-icon">{candidate.kind === 'relation' ? '✦' : candidate.kind === 'performance' ? '🎭' : candidate.kind === 'narrative' ? '✎' : '⚑'}</div>
                                    <div>
                                        <strong>{candidate.payload?.npcName ?? candidate.payload?.npcKey ?? 'World narrative'}</strong>
                                        <span>{candidate.kind} · {candidate.source} · {new Date(candidate.createdAt).toLocaleString()}</span>
                                    </div>
                                    <Badge tone={unmet ? 'gold' : 'info'}>{unmet ? 'needs receipt' : candidate.status}</Badge>
                                </div>
                                <p className="strpg-muted">{describeCandidate(candidate)}</p>
                                {unmet && (
                                    <p className="strpg-muted">
                                        Waiting for: {requirements.checks.filter((check) => !check.satisfied).map((check) => `${check.kind}:${check.key}`).join(', ')}
                                    </p>
                                )}
                                {candidate.evidence && Object.keys(candidate.evidence).length > 0 && (
                                    <code>{JSON.stringify(candidate.evidence).slice(0, 240)}</code>
                                )}
                                <div className="strpg-row end">
                                    <Button variant="gold" onClick={() => decideCandidate(candidate, 'approve')} disabled={busy}>Approve</Button>
                                    {unmet && (
                                        <Button
                                            variant="ghost"
                                            onClick={() => {
                                                const reason = globalThis.prompt?.('手动放行理由（写入审计）：', '剧情中已用其他方式完成代价');
                                                if (reason) decideCandidate(candidate, 'approve', { overrideReason: reason });
                                            }}
                                            disabled={busy}
                                        >Manual release</Button>
                                    )}
                                    <Button onClick={() => decideCandidate(candidate, 'reject')} disabled={busy}>Reject</Button>
                                </div>
                            </div>
                            );
                        })}
                    </div>
                ) : <Empty title="No pending candidates" icon="◇" />}
            </section>
            <section className="strpg-panel">
                <SectionTitle
                    eyebrow="M3 · MEMORY SCOPES"
                    title="Chat memory scopes"
                    description="Define what to extract from a chat window. The server builds the prompt, the extension runs it, and every item lands in the review queue. Manual mode works without a model."
                    actions={(
                        <div className="strpg-row">
                            <Button size="sm" onClick={refreshBridge} disabled={busy}>Refresh</Button>
                            <Button size="sm" variant="ghost" onClick={addStarterScopes} disabled={!campaignId || busy}>Add starter scopes</Button>
                        </div>
                    )}
                />
                {scopes.length ? (
                    <div className="strpg-form">
                        {scopes.map((scope) => (
                            <div key={scope.key} className="strpg-item-card">
                                <div className="strpg-item-head">
                                    <div className="strpg-item-icon">◇</div>
                                    <div>
                                        <strong>{scope.name}</strong>
                                        <span>{scope.key} · {scope.config?.extract?.kind ?? 'narrative'} · last {scope.config?.source?.lastN ?? 12} messages</span>
                                    </div>
                                    <Badge tone={scope.enabled ? 'success' : 'info'}>{scope.enabled ? 'enabled' : 'paused'}</Badge>
                                </div>
                                <p className="strpg-muted">Last run: {scope.lastRunAt ? new Date(scope.lastRunAt).toLocaleString() : 'never'}</p>
                                <div className="strpg-row end">
                                    <Button variant="gold" onClick={() => runScope(scope)} disabled={busy}>Scan chat (LLM)</Button>
                                    <Button onClick={() => manualScope(scope)} disabled={busy}>Manual…</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : <Empty title="No scopes yet" icon="◇">Add starter scopes to begin.</Empty>}
            </section>
            <section className="strpg-panel">
                <SectionTitle
                    eyebrow="M3.1 · M4 · CHARACTER BINDINGS"
                    title="Chat ↔ RPG identity"
                    description="Bind a SillyTavern character to an STRPG NPC (or to the player persona). A bound NPC carries its relationship and memory into the chat, and open_chat events can switch to it."
                    actions={<Button size="sm" onClick={refreshBridge} disabled={busy}>Refresh</Button>}
                />
                <div className="strpg-row wrap">
                    <Badge tone={autoSettings.enabled ? 'gold' : 'info'}>
                        Auto-scan: {autoSettings.enabled ? `every ${autoSettings.everyN} messages` : 'off'}
                    </Badge>
                    <Button onClick={toggleAuto} disabled={!campaignId || busy}>{autoSettings.enabled ? 'Disable auto-scan' : 'Enable auto-scan'}</Button>
                    <Field label="Every N messages">
                        <Input
                            type="number"
                            min="1"
                            max="100"
                            value={autoSettings.everyN}
                            onChange={(event) => changeAutoN(event.target.value)}
                        />
                    </Field>
                </div>
                <div className="strpg-row wrap">
                    <Field label="NPC key (blank = player persona)">
                        <Input value={npcKeyInput} onChange={(event) => setNpcKeyInput(event.target.value)} placeholder="elder_mira" />
                    </Field>
                    <Button variant="gold" onClick={bindCurrent} disabled={!campaignId || busy}>Bind current character</Button>
                    <Button onClick={importCard} disabled={!campaignId || busy}>Import current card as NPC</Button>
                </div>
                {bindings.length ? (
                    <div className="strpg-form">
                        {bindings.map((binding) => (
                            <div key={binding.id} className="strpg-item-card">
                                <div className="strpg-item-head">
                                    <div className="strpg-item-icon">☺</div>
                                    <div>
                                        <strong>{binding.npcName ?? 'Player persona'}</strong>
                                        <span>{binding.stCharacterName || binding.stAvatar} · {binding.direction}</span>
                                    </div>
                                    <Badge tone={binding.npcKey ? 'info' : 'gold'}>{binding.npcKey ?? 'player'}</Badge>
                                </div>
                                <div className="strpg-row end">
                                    <Button onClick={() => openBindingChat(binding)} disabled={busy}>Open chat</Button>
                                    <Button variant="ghost" onClick={() => unbind(binding)} disabled={busy}>Unbind</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : <Empty title="No character bindings" icon="◇">Bind the active character to an NPC to share memory both ways.</Empty>}
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

function describeCost(cost) {
    if (!cost) return 'nothing';
    const parts = [];
    if (Number(cost.gold)) parts.push(`${Number(cost.gold)} gold`);
    for (const item of cost.items ?? []) parts.push(`${item.itemKey} x${item.quantity}`);
    return parts.join(' + ') || 'nothing';
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
    if (candidate.kind === 'barter') {
        const payload = candidate.payload ?? {};
        return `${payload.itemName ?? payload.itemKey} now — repay by: ${payload.questKey} (relation +${payload.relationDelta ?? 0}, quest ${payload.questStatus})`;
    }
    if (candidate.kind === 'trade') {
        const payload = candidate.payload ?? {};
        return `${payload.itemName ?? payload.itemKey} x${payload.quantity} @ ${payload.unitPrice} gold (list ${payload.unitList})${payload.countered ? ' — counter-offer' : ''}`;
    }
    if (candidate.kind === 'recruit') {
        return `Recruit ${candidate.payload?.npcName ?? candidate.payload?.npcKey} for ${describeCost(candidate.payload?.cost)}`;
    }
    if (candidate.kind === 'tuition') {
        return `Learn ${candidate.payload?.skillName ?? candidate.payload?.skillKey} for ${describeCost(candidate.payload?.tuition)}`;
    }
    if (candidate.kind === 'recovery') {
        const payload = candidate.payload ?? {};
        return `${payload.npcName ?? payload.npcKey}: ${payload.label ?? payload.method} — restore ${Math.round(Number(payload.restoreHp ?? 0) * 100)}% HP, relation +${payload.relationDelta ?? 0}${Number(payload.cost?.gold) ? `, ${payload.cost.gold} gold` : ''}`;
    }
    if (candidate.kind === 'performance') {
        const payload = candidate.payload ?? {};
        return `${payload.npcName ? `${payload.npcName}: ` : ''}${String(payload.text ?? '').slice(0, 240)}`;
    }
    if (candidate.kind === 'flag') return `Flag: ${candidate.payload?.flag ?? ''}`;
    return JSON.stringify(candidate.payload ?? {}).slice(0, 300);
}
