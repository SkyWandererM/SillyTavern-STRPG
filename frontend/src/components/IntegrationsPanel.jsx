import React, { useEffect, useState } from 'react';
import { api, downloadJson, getStContext } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Field, Modal, SectionTitle, Select, Textarea } from '../ui.jsx';

export function IntegrationsPanel({ campaignId, notify }) {
    const [status, setStatus] = useState(null);
    const [memory, setMemory] = useState(null);
    const [tracker, setTracker] = useState(null);
    const [trackerDraft, setTrackerDraft] = useState({ mood: '', attitude: '', summary: '' });
    const [mapJson, setMapJson] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [memoryOpen, setMemoryOpen] = useState(false);

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
            notify(`Memory book '${result.name}' written to SillyTavern World Info (${result.entries} entries).`, 'success');
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







