import React, { useEffect, useState } from 'react';
import {
    api, downloadJson, getStudioToken, getToolToken, setStudioToken, setToolToken,
} from '../api.js';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Input, Loading, SectionTitle } from '../ui.jsx';
import { IntegrationsPanel } from './IntegrationsPanel.jsx';

export function Settings({ campaignId, revision, notify, onMutated, dashboard }) {
    const [settings, setSettings] = useState(null);
    const [backups, setBackups] = useState([]);
    const [saves, setSaves] = useState([]);
    const [error, setError] = useState(null);
    const [studioToken, setStudioTokenState] = useState(getStudioToken());
    const [toolToken, setToolTokenState] = useState(getToolToken());
    const [confirm, setConfirm] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        setError(null);
        try {
            const [settingsData, backupData] = await Promise.all([
                api('/settings'),
                api('/admin/backups'),
            ]);
            setSettings(settingsData);
            setBackups(backupData);
            if (campaignId) setSaves(await api(`/campaigns/${campaignId}/saves`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const createBackup = async () => {
        setBusy(true);
        try {
            await api('/admin/backups', { method: 'POST', body: { label: 'Manual backup from Control Center' } });
            notify('Database backup created.', 'success');
            await load();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const createSave = async () => {
        setBusy(true);
        try {
            await api(`/campaigns/${campaignId}/saves`, { method: 'POST', body: { label: 'Manual save' } });
            notify('Campaign snapshot saved.', 'success');
            await load();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const doRestore = async () => {
        if (!confirm) return;
        setBusy(true);
        try {
            if (confirm.type === 'backup') await api(`/admin/backups/${encodeURIComponent(confirm.name)}/restore`, { method: 'POST', body: {} });
            else await api(`/campaigns/${campaignId}/saves/${confirm.id}/restore`, { method: 'POST', body: {} });
            notify('Restore complete.', 'success');
            setConfirm(null);
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    if (error) return <ErrorBox error={error} onRetry={load} />;
    if (!settings) return <Loading label="Loading settings..." />;

    return (
        <div className="strpg-settings">
            <SectionTitle eyebrow="SETTINGS" title="System, Saves and Integrations" description="The STRPG database is independent of chat logs; backups and restores never run through the LLM." />

            <div className="strpg-grid two">
                <section className="strpg-panel">
                    <SectionTitle eyebrow="SECURITY" title="Studio / Tool Token" description="If the server sets STRPG_STUDIO_TOKEN or STRPG_TOOL_TOKEN, enter them here. Tokens are stored only in browser localStorage." />
                    <Field label="Studio Token" hint={settings.studioTokenRequired ? 'The server requires a Studio Token' : 'Not currently required by the server'}>
                        <Input type="password" value={studioToken} onChange={(event) => setStudioTokenState(event.target.value)} placeholder="Optional" />
                    </Field>
                    <Field label="Tool Token" hint="Used by /tools/*; LLM proposals still require player confirmation.">
                        <Input type="password" value={toolToken} onChange={(event) => setToolTokenState(event.target.value)} placeholder="Optional" />
                    </Field>
                    <div className="strpg-row">
                        <Button onClick={() => { setStudioToken(studioToken); setToolToken(toolToken); notify('Tokens saved locally.', 'success'); }}>Save Tokens</Button>
                        <Button variant="ghost" onClick={() => { setStudioToken(''); setToolToken(''); setStudioTokenState(''); setToolTokenState(''); }}>Clear</Button>
                    </div>
                    <div className="strpg-divider" />
                    <div className="strpg-kv"><span>Database</span><strong className="strpg-mono">{settings.database?.path}</strong></div>
                    <div className="strpg-kv"><span>Schema</span><strong>v{settings.database?.schemaVersion}</strong></div>
                    <div className="strpg-kv"><span>Size</span><strong>{settings.database?.sizeBytes ? `${(settings.database.sizeBytes / 1024).toFixed(1)} KB` : '—'}</strong></div>
                </section>

                <section className="strpg-panel">
                    <SectionTitle eyebrow="BACKUP" title="Database Backups" actions={<Button size="sm" variant="gold" onClick={createBackup} disabled={busy}>Create Backup</Button>} />
                    {backups.length ? backups.slice(0, 8).map((backup) => (
                        <div className="strpg-save-row" key={backup.name}>
                            <div><strong>{backup.name}</strong><span>{new Date(backup.createdAt).toLocaleString()} · {(backup.sizeBytes / 1024).toFixed(1)} KB</span></div>
                            <div className="strpg-row">
                                <Button size="sm" onClick={() => setConfirm({ type: 'backup', name: backup.name, label: backup.name })}>Restore</Button>
                                <Button size="sm" variant="ghost" onClick={() => api(`/admin/backups/${encodeURIComponent(backup.name)}`, { method: 'DELETE' }).then(load).catch((err) => notify(err.message, 'danger'))}>Delete</Button>
                            </div>
                        </div>
                    )) : <Empty title="No backups yet" icon="◈">A backup contains worlds, Campaigns, and Studio data.</Empty>}
                </section>
            </div>

            <section className="strpg-panel">
                <SectionTitle
                    eyebrow="CAMPAIGN SAVES"
                    title="Campaign Snapshots"
                    description="Every move, combat action, and quest change is autosaved; manual snapshots are available here."
                    actions={<Button size="sm" variant="gold" onClick={createSave} disabled={!campaignId || busy}>Manual Save</Button>}
                />
                {saves.length ? saves.slice(0, 12).map((save) => (
                    <div className="strpg-save-row" key={save.id}>
                        <div><strong>{save.label || 'Autosave'} {save.automatic && <Badge tone="neutral">AUTO</Badge>}</strong><span>{new Date(save.created_at).toLocaleString()} · {save.hash.slice(0, 10)}</span></div>
                        <Button size="sm" onClick={() => setConfirm({ type: 'save', id: save.id, label: save.label })}>Restore</Button>
                    </div>
                )) : <Empty title="No snapshots yet" icon="◈">The first snapshot is created automatically with a Campaign.</Empty>}
                {campaignId && (
                    <div className="strpg-row end">
                        <Button variant="ghost" onClick={() => downloadJson(`/campaigns/${campaignId}/export`, `strpg-campaign-${campaignId}.json`).catch((err) => notify(err.message, 'danger'))}>Export Campaign JSON</Button>
                    </div>
                )}
            </section>

            <IntegrationsPanel campaignId={campaignId} notify={notify} />

            <div className="strpg-grid two">
                <section className="strpg-panel">
                    <SectionTitle eyebrow="LLM TOOL PROTOCOL" title="Structured Tools" />
                    <p>The LLM may only submit proposals through <code>strpg_propose_*</code>; all numeric changes are performed by the server rules engine.</p>
                    <div className="strpg-tool-list">
                        {['strpg_get_status', 'strpg_get_location', 'strpg_propose_movement', 'strpg_propose_encounter', 'strpg_get_combat_context', 'strpg_propose_character_reaction', 'strpg_get_quest_status', 'strpg_get_available_interactions'].map((tool) => (
                            <code key={tool}>{tool}</code>
                        ))}
                    </div>
                    <p className="strpg-muted">The LLM may use <code>{'<strpg>{"tool":"...","args":{...}}</strpg>'}</code>; the client accepts only the propose/get whitelist and requires player confirmation for movement.</p>
                </section>
                <section className="strpg-panel">
                    <SectionTitle eyebrow="DATA OWNERSHIP" title="Authority" />
                    <p>STRPG SQLite is independent of chat logs. Chat is a narrative layer, not the save game.</p>
                    <div className="strpg-kv"><span>Campaign Snapshots</span><strong>Autosaved on every move, combat action, and quest change</strong></div>
                    <div className="strpg-kv"><span>Backup</span><strong>Logical JSON backup with transactional restore</strong></div>
                    <div className="strpg-kv"><span>External Sync</span><strong>Read-only / whitelisted narrative fields</strong></div>
                    <div className="strpg-kv"><span>LLM Permissions</span><strong>propose only; no SQL writes</strong></div>
                </section>
            </div>

            <Confirm
                open={Boolean(confirm)}
                title={confirm?.type === 'backup' ? 'Restore the entire database?' : 'Restore this Campaign snapshot?'}
                onCancel={() => setConfirm(null)}
                onConfirm={doRestore}
                confirmLabel="Restore"
                danger
            >
                <p>This overwrites current data. STRPG performs the operation in a transaction and rolls back on failure. Create a backup first.</p>
                <div className="strpg-code-small">{confirm?.label}</div>
            </Confirm>
        </div>
    );
}


