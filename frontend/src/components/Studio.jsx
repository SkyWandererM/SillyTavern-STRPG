import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    api, downloadJson, fileToDataUrl,
} from '../api.js';
import {
    Badge, Button, Confirm, Empty, ErrorBox, Field, Input, Loading, Modal, SectionTitle, Select, StatusBadge, Tabs, Textarea,
} from '../ui.jsx';
import { ASSET_KINDS, KIND_LABELS, assetTemplate, normalizeImportJson } from '../assetTemplates.js';
import { NodeGraphEditor } from './NodeGraphEditor.jsx';
import { ClassBuilder } from './ClassBuilder.jsx';
import { Workbench } from './Workbench.jsx';
import { DirectorRoom } from './DirectorRoom.jsx';
import { RulesCompiler } from './RulesCompiler.jsx';

const STUDIO_TABS = [
    { value: 'workbench', label: 'World Workbench' },
    { value: 'director', label: "Director's Room" },
    { value: 'content', label: 'Asset Browser' },
    { value: 'graph', label: 'Graph Tools' },
    { value: 'versions', label: 'Build & Publish' },
    { value: 'import', label: 'Import' },
    { value: 'overview', label: 'Project Settings' },
];

export function Studio({ notify, loadCampaigns }) {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [project, setProject] = useState(null);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('workbench');
    const [kindFilter, setKindFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [sortBy, setSortBy] = useState('kind');
    const [search, setSearch] = useState('');
    const [viewMode, setViewMode] = useState('list');
    const [asset, setAsset] = useState(null);
    const [assetLoading, setAssetLoading] = useState(false);
    const [draftJson, setDraftJson] = useState('');
    const [draftName, setDraftName] = useState('');
    const [editorError, setEditorError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [modal, setModal] = useState(null);
    const [classOpen, setClassOpen] = useState(false);
    const [rulesOpen, setRulesOpen] = useState(false);
    const [newProject, setNewProject] = useState({ name: '', description: '' });
    const [newAsset, setNewAsset] = useState({ kind: 'npc', text: JSON.stringify(assetTemplate('npc'), null, 2) });
    const [importText, setImportText] = useState('');
    const [importError, setImportError] = useState(null);
    const [review, setReview] = useState({ reviewer: 'studio-reviewer', note: '', decision: 'approve' });
    const [integrity, setIntegrity] = useState(null);
    const [graphKind, setGraphKind] = useState('story');
    const [graphAssetId, setGraphAssetId] = useState('');
    const [buildResult, setBuildResult] = useState(null);

    const loadProjects = async (selectId = projectId) => {
        setError(null);
        try {
            const rows = await api('/projects');
            setProjects(rows);
            const next = selectId ?? rows[0]?.id ?? null;
            if (!projectId && next) setProjectId(next);
            return rows;
        } catch (err) {
            setError(err);
            return [];
        }
    };

    const loadProject = async (id) => {
        if (!id) {
            setProject(null);
            return;
        }
        setError(null);
        try {
            const data = await api(`/projects/${id}`);
            setProject(data);
            setProjectId(id);
            setAsset(null);
            setGraphAssetId('');
        } catch (err) {
            setError(err);
        }
    };

    useEffect(() => { loadProjects(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (projectId) loadProject(projectId); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

    const assets = project?.assets ?? [];
    const filteredAssets = useMemo(() => assets.filter((entry) => {
        if (kindFilter && entry.kind !== kindFilter) return false;
        if (statusFilter && entry.status !== statusFilter) return false;
        if (search && !`${entry.name} ${entry.asset_key} ${entry.kind}`.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    }).sort((a, b) => {
        if (sortBy === 'name') return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
        if (sortBy === 'status') return String(a.status).localeCompare(String(b.status));
        if (sortBy === 'revision') return Number(b.revision) - Number(a.revision);
        return `${a.kind}:${a.asset_key}`.localeCompare(`${b.kind}:${b.asset_key}`);
    }), [assets, kindFilter, statusFilter, search, sortBy]);

    const openAsset = async (id) => {
        setAssetLoading(true);
        setEditorError(null);
        try {
            const data = await api(`/assets/${id}`);
            setAsset(data);
            setDraftJson(JSON.stringify(data.data, null, 2));
            setDraftName(data.name);
        } catch (err) {
            setEditorError(err);
        } finally {
            setAssetLoading(false);
        }
    };

    const refreshProject = async (selectAssetId = asset?.id) => {
        if (!projectId) return;
        const data = await api(`/projects/${projectId}`);
        setProject(data);
        if (selectAssetId) {
            try {
                const refreshed = await api(`/assets/${selectAssetId}`);
                setAsset(refreshed);
                setDraftJson(JSON.stringify(refreshed.data, null, 2));
                setDraftName(refreshed.name);
            } catch {
                setAsset(null);
            }
        }
    };

    const createProject = async () => {
        setBusy(true);
        try {
            const created = await api('/projects', { method: 'POST', body: newProject });
            notify('Project created.', 'success');
            setModal(null);
            setNewProject({ name: '', description: '' });
            await loadProjects(created.id);
            setProjectId(created.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const cloneProject = async () => {
        setBusy(true);
        try {
            const created = await api(`/projects/${projectId}/clone`, { method: 'POST', body: { name: `${project.name} (Copy)` } });
            notify('Project copied.', 'success');
            await loadProjects(created.id);
            setProjectId(created.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const deleteProject = async () => {
        setBusy(true);
        try {
            await api(`/projects/${projectId}`, { method: 'DELETE' });
            notify('Project deleted.', 'success');
            setModal(null);
            setProjectId(null);
            await loadProjects(null);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const createAsset = async () => {
        setBusy(true);
        try {
            const parsed = normalizeImportJson(newAsset.text);
            if (parsed.package) throw new Error('This is a full Game Package. Use the Import tab.');
            if (parsed.items) throw new Error('This is a batch of assets. Use the Import tab.');
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST',
                body: { kind: parsed.kind, data: parsed.data, name: parsed.data.name },
            });
            if (created.normalization?.warning) notify(created.normalization.warning, 'warning');
            const extra = Math.max(0, (created.createdAssets?.length ?? 1) - 1);
            notify(created.validation?.valid ? `Content created and schema-validated${extra ? ` with ${extra} supporting assets` : ''}.` : 'Content created, but validation errors remain. Fix them.', created.validation?.valid ? 'success' : 'warning');
            setModal(null);
            await refreshProject();
            await openAsset(created.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const saveDraft = async (silent = false) => {
        if (!asset) return null;
        let parsed;
        try {
            parsed = JSON.parse(draftJson);
        } catch (err) {
            setEditorError(new Error(`JSON syntax error: ${err.message}`));
            throw err;
        }
        setBusy(true);
        try {
            const updated = await api(`/assets/${asset.id}`, {
                method: 'PATCH',
                body: { data: parsed, name: draftName },
            });
            setAsset(updated);
            setEditorError(null);
            if (!silent) notify(updated.validation?.valid ? 'DRAFT saved.' : 'DRAFT saved with validation errors.', updated.validation?.valid ? 'success' : 'warning');
            await refreshProject(asset.id);
            return updated;
        } catch (err) {
            setEditorError(err);
            if (!silent) notify(err.message, 'danger');
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const validateAsset = async () => {
        if (asset?.status === 'DRAFT') {
            try { await saveDraft(true); } catch { return; }
        }
        setBusy(true);
        try {
            const result = await api(`/assets/${asset.id}/validate`, { method: 'POST', body: {} });
            setAsset(result);
            notify(result.validation?.valid ? 'Automatic validation passed. Ready for human review.' : 'Automatic validation failed.', result.validation?.valid ? 'success' : 'warning');
            await refreshProject(asset.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const startReview = async () => {
        if (!asset) return;
        let current = asset;
        if (current.status === 'DRAFT') {
            try {
                current = await saveDraft(true);
                current = await api(`/assets/${current.id}/validate`, { method: 'POST', body: {} });
                setAsset(current);
                await refreshProject(current.id);
            } catch { return; }
        }
        if (current.status !== 'VALIDATION') {
            notify('Only content in VALIDATION can be reviewed.', 'warning');
            return;
        }
        setModal('review');
    };

    const submitReview = async () => {
        setBusy(true);
        try {
            await api(`/assets/${asset.id}/review`, { method: 'POST', body: review });
            notify(review.decision === 'approve' ? 'Review approved.' : 'Returned to DRAFT.', 'success');
            setModal(null);
            await refreshProject(asset.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const publishAsset = async () => {
        setBusy(true);
        try {
            await api(`/assets/${asset.id}/publish`, { method: 'POST', body: {} });
            notify('Content published to the library.', 'success');
            await refreshProject(asset.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const newRevision = async () => {
        if (!asset) return;
        setBusy(true);
        try {
            const created = await api(`/assets/${asset.id}/new-revision`, { method: 'POST', body: {} });
            notify('New DRAFT revision created.', 'success');
            await refreshProject();
            await openAsset(created.id);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const buildVersion = async () => {
        setBusy(true);
        setBuildResult(null);
        try {
            const result = await api(`/projects/${projectId}/build`, { method: 'POST', body: {} });
            setBuildResult(result);
            notify(`Built v${result.version}.`, 'success');
            await refreshProject();
            if (loadCampaigns) await loadCampaigns();
        } catch (err) {
            setBuildResult({ error: err });
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const publishVersion = async (versionId) => {
        setBusy(true);
        try {
            await api(`/versions/${versionId}/publish`, { method: 'POST', body: {} });
            notify('Game version published. New Campaigns can use it.', 'success');
            await refreshProject();
            if (loadCampaigns) await loadCampaigns();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const rollbackVersion = async (versionId) => {
        setBusy(true);
        try {
            const version = await api(`/versions/${versionId}/rollback`, { method: 'POST', body: {} });
            notify(`Created rollback version v${version.version}.`, 'success');
            await refreshProject();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const checkIntegrity = async () => {
        setBusy(true);
        try {
            setIntegrity(await api(`/projects/${projectId}/integrity`));
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const importContent = async () => {
        setImportError(null);
        setBusy(true);
        try {
            const parsed = normalizeImportJson(importText);
            if (parsed.package) {
                const result = await api(`/projects/${projectId}/import-package`, { method: 'POST', body: { package: parsed.package } });
                notify(`Imported ${result.importedAssets} DRAFT assets into a new project.`, 'success');
                await loadProjects(result.project.id);
                setProjectId(result.project.id);
                setTab('content');
            } else {
                if (!projectId) throw new Error('Select a project first.');
                if (parsed.items) {
                    const result = await api(`/projects/${projectId}/assets`, {
                        method: 'POST', body: { items: parsed.items },
                    });
                    const mapped = result.summary?.mappedKinds?.map((entry) => `${entry.from} → ${entry.to}`).join(', ');
                    notify(`Imported ${result.summary?.items ?? parsed.items.length} item(s), ${result.summary?.assets ?? parsed.items.length} DRAFT asset(s).${mapped ? ` Mapped: ${mapped}.` : ''}`, 'success');
                    await refreshProject();
                    await openAsset(result.primary.id);
                    setTab('content');
                } else {
                    const created = await api(`/projects/${projectId}/assets`, {
                        method: 'POST', body: { kind: parsed.kind, data: parsed.data, name: parsed.data.name },
                    });
                    if (created.normalization?.warning) notify(created.normalization.warning, 'warning');
                    const extra = Math.max(0, (created.createdAssets?.length ?? 1) - 1);
                    notify(`Content imported as DRAFT${extra ? ` with ${extra} supporting scene/event asset(s)` : ''}.`, 'success');
                    await refreshProject();
                    await openAsset(created.id);
                    setTab('content');
                }
            }
            setImportText('');
        } catch (err) {
            setImportError(err);
        } finally {
            setBusy(false);
        }
    };

    const uploadImage = async (event) => {
        try {
            const file = event.target.files?.[0];
            if (!file) return;
            const dataUrl = await fileToDataUrl(file);
            const parsed = JSON.parse(draftJson);
            if (asset.kind === 'scene') parsed.image = dataUrl;
            else parsed.portrait = dataUrl;
            setDraftJson(JSON.stringify(parsed, null, 2));
            notify('Image loaded into the editor. Save the DRAFT to apply it.', 'success');
        } catch (err) {
            notify(err.message, 'danger');
        }
    };

    if (error && !projects.length) return <ErrorBox error={error} onRetry={() => loadProjects()} />;
    if (!projects.length) {
        return (
            <div className="strpg-studio">
                <SectionTitle eyebrow="STRPG STUDIO" title="Content Production Studio" description="Create a project, import structured JSON from the six designer cards, validate and review it, then assemble a game." />
                <div className="strpg-panel">
                    <Empty title="No game projects yet" icon="⚒" action={<Button variant="gold" onClick={() => setModal('project')}>Create Project</Button>}>
                        Create a new project, or import a full Game Package from the Import tab.
                    </Empty>
                </div>
                <ProjectModal open={modal === 'project'} value={newProject} setValue={setNewProject} onClose={() => setModal(null)} onSubmit={createProject} busy={busy} />
            </div>
        );
    }

    return (
        <div className="strpg-studio">
            <SectionTitle
                eyebrow="STRPG STUDIO"
                title={project?.name ?? 'Content Production Studio'}
                description="Design the world in the Workbench, validate each asset, then approve and publish a version for play. Published content stays immutable; edits create a new draft revision."
                actions={(
                    <div className="strpg-row">
                        <Select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value)} className="strpg-project-select">
                            {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                        </Select>
                        <Button size="sm" variant="gold" onClick={() => setModal('project')}>New Project</Button>
                        <Button size="sm" onClick={cloneProject} disabled={busy}>Duplicate</Button>
                        <Button size="sm" onClick={() => setClassOpen(true)} disabled={busy || !projectId}>Class Builder</Button>
                        <Button size="sm" onClick={() => setRulesOpen(true)} disabled={busy || !projectId}>Rules Compiler</Button>
                    </div>
                )}
            />
            <div className="strpg-studio-tabs">
                <Tabs tabs={STUDIO_TABS} value={tab} onChange={setTab} />
                <div className="strpg-studio-meta">
                    <Badge tone="info">{project?.campaignCount ?? 0} Campaigns</Badge>
                    <Button size="sm" variant="ghost" onClick={checkIntegrity} disabled={busy}>Integrity Check</Button>
                    <Button size="sm" variant="ghost" onClick={() => setModal('delete')} disabled={busy || (project?.campaignCount ?? 0) > 0}>Delete Project</Button>
                </div>
            </div>
            {integrity && (
                <div className="strpg-integrity">
                    <div className="strpg-row between"><strong>Project Integrity</strong><Badge tone={integrity.valid ? 'success' : 'danger'}>{integrity.valid ? 'Passed' : 'Issues'}</Badge></div>
                    {integrity.issues.map((issue, index) => <div key={index} className={`strpg-integrity-row ${issue.severity}`}><Badge tone={issue.severity === 'error' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{issue.severity}</Badge><span>{issue.message}</span></div>)}
                </div>
            )}

            {tab === 'workbench' && (
                <Workbench projectId={projectId} project={project} onRefresh={refreshProject} notify={notify} />
            )}

            {tab === 'director' && (
                <DirectorRoom projectId={projectId} project={project} onRefresh={() => refreshProject(null)} notify={notify} />
            )}

            {tab === 'overview' && (
                <div className="strpg-grid two">
                    <section className="strpg-panel">
                        <SectionTitle eyebrow="PROJECT" title="Project Details" />
                        <div className="strpg-form">
                            <Field label="Project Name"><Input value={project?.name ?? ''} onChange={(event) => setProject((current) => ({ ...current, name: event.target.value }))} /></Field>
                            <Field label="Description"><Textarea rows={4} value={project?.description ?? ''} onChange={(event) => setProject((current) => ({ ...current, description: event.target.value }))} /></Field>
                            <Button onClick={async () => {
                                try {
                                    await api(`/projects/${projectId}`, { method: 'PATCH', body: { name: project.name, description: project.description } });
                                    notify('Project details saved.', 'success');
                                    await loadProjects(projectId);
                                } catch (err) { notify(err.message, 'danger'); }
                            }}>Save Project</Button>
                        </div>
                    </section>
                    <section className="strpg-panel">
                        <SectionTitle eyebrow="CONTENT" title="Content Statistics" />
                        {['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'].map((status) => {
                            const count = assets.filter((entry) => entry.status === status).length;
                            return <div className="strpg-kv" key={status}><StatusBadge status={status} /><strong>{count}</strong></div>;
                        })}
                        <div className="strpg-divider" />
                        <div className="strpg-kv"><span>Total Assets</span><strong>{assets.length}</strong></div>
                        <div className="strpg-kv"><span>Game Versions</span><strong>{project?.versions?.length ?? 0}</strong></div>
                    </section>
                </div>
            )}

            {tab === 'content' && (
                <div className="strpg-content-workbench">
                    <div className="strpg-content-list">
                        <div className="strpg-content-toolbar">
                            <Input placeholder="Search name / key..." value={search} onChange={(event) => setSearch(event.target.value)} />
                            <Select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                                <option value="">All Types</option>
                                {ASSET_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </Select>
                            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                                <option value="">All Statuses</option>
                                {['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'].map((status) => <option key={status} value={status}>{status}</option>)}
                            </Select>
                            <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)} title="Sort">
                                <option value="kind">Sort by Type</option>
                                <option value="name">Sort by Name</option>
                                <option value="status">Sort by Status</option>
                                <option value="revision">Sort by Revision</option>
                            </Select>
                            <Button size="sm" onClick={() => setViewMode(viewMode === 'list' ? 'cards' : 'list')}>{viewMode === 'list' ? 'Cards' : 'List'}</Button>
                            <Button size="sm" variant="gold" onClick={() => { setNewAsset({ kind: 'npc', text: JSON.stringify(assetTemplate('npc'), null, 2) }); setModal('asset'); }}>+ Content</Button>
                        </div>
                        {viewMode === 'list' ? (
                            <div className="strpg-asset-table">
                                {filteredAssets.map((entry) => (
                                    <button type="button" key={entry.id} className={`strpg-asset-row ${asset?.id === entry.id ? 'active' : ''}`} onClick={() => openAsset(entry.id)}>
                                        <span className="strpg-asset-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                                        <span className="strpg-asset-name"><strong>{entry.name}</strong><small>{entry.asset_key} · r{entry.revision}</small></span>
                                        <StatusBadge status={entry.status} />
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="strpg-encyclopedia-grid">
                                {filteredAssets.map((entry) => {
                                    const image = entry.data?.portrait ?? entry.data?.image;
                                    return (
                                        <button type="button" className={`strpg-encyclopedia-card ${asset?.id === entry.id ? 'active' : ''}`} key={entry.id} onClick={() => openAsset(entry.id)}>
                                            <div className="strpg-encyclopedia-image">
                                                {image ? <img src={image} alt={entry.name} /> : <span>{(entry.name ?? '?').slice(0, 1)}</span>}
                                            </div>
                                            <div>
                                                <strong>{entry.name}</strong>
                                                <span>{KIND_LABELS[entry.kind]} · {entry.asset_key}</span>
                                                <StatusBadge status={entry.status} />
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {!filteredAssets.length && <Empty title="No matching content" icon="⌕">Adjust filters or add content.</Empty>}
                    </div>
                    <div className="strpg-asset-detail">
                        {assetLoading && <Loading />}
                        {!asset && !assetLoading && <Empty title="Select content" icon="◇">Inspect, validate, review, and publish.</Empty>}
                        {asset && (
                            <AssetEditor
                                asset={asset}
                                draftJson={draftJson}
                                setDraftJson={setDraftJson}
                                draftName={draftName}
                                setDraftName={setDraftName}
                                editorError={editorError}
                                busy={busy}
                                onSave={() => saveDraft()}
                                onValidate={validateAsset}
                                onReview={startReview}
                                onPublish={publishAsset}
                                onNewRevision={newRevision}
                                onUploadImage={uploadImage}
                                onExport={() => {
                                    const blob = new Blob([JSON.stringify({ kind: asset.kind, asset: JSON.parse(draftJson) }, null, 2)], { type: 'application/json' });
                                    const url = URL.createObjectURL(blob);
                                    const anchor = document.createElement('a');
                                    anchor.href = url; anchor.download = `${asset.asset_key}.json`; anchor.click();
                                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                                }}
                                onOpenGraph={['story', 'quest'].includes(asset.kind) ? () => { setGraphKind(asset.kind); setGraphAssetId(asset.id); setTab('graph'); } : null}
                            />
                        )}
                    </div>
                </div>
            )}

            {tab === 'graph' && (
                <GraphWorkspace
                    project={project}
                    assets={assets}
                    graphKind={graphKind}
                    setGraphKind={setGraphKind}
                    graphAssetId={graphAssetId}
                    setGraphAssetId={setGraphAssetId}
                    notify={notify}
                    onRefresh={refreshProject}
                    projectId={projectId}
                />
            )}

            {tab === 'versions' && (
                <VersionsPanel
                    project={project}
                    busy={busy}
                    onBuild={buildVersion}
                    onPublish={publishVersion}
                    onRollback={rollbackVersion}
                    onExport={(versionId) => downloadJson(`/versions/${versionId}/export`, `strpg-game-v${versionId}.json`).catch((err) => notify(err.message, 'danger'))}
                    buildResult={buildResult}
                />
            )}

            {tab === 'import' && (
                <div className="strpg-grid two">
                    <section className="strpg-panel">
                        <SectionTitle eyebrow="IMPORT" title="Paste / Import JSON" description="Supports {kind,asset} envelopes, batches/arrays, single assets, six designer-card outputs, and full Game Packages. Legacy kind aliases are mapped to canonical kinds." />
                        <Textarea rows={16} placeholder="Paste designer-card JSON here..." value={importText} onChange={(event) => setImportText(event.target.value)} />
                        <div className="strpg-row">
                            <label className="strpg-btn strpg-btn-default strpg-btn-md">
                                Choose JSON File
                                <input type="file" accept=".json,application/json" hidden onChange={async (event) => {
                                    const file = event.target.files?.[0];
                                    if (file) setImportText(await file.text());
                                }} />
                            </label>
                            <Button variant="gold" onClick={importContent} disabled={busy || !importText.trim()}>Import as DRAFT</Button>
                        </div>
                        <ErrorBox error={importError} />
                    </section>
                    <section className="strpg-panel">
                        <SectionTitle eyebrow="GUIDE" title="Designer Cards → Studio" />
                        <ol className="strpg-checklist">
                            <li>Import the six STRPG Character Cards into SillyTavern</li>
                            <li>Let a designer card output <code>{'{"kind":"npc","asset":{...}}'}</code></li>
                            <li>Paste the JSON into the left panel and import it as DRAFT</li>
                            <li>Run automatic validation</li>
                            <li>Enter a reviewer and approve</li>
                            <li>Publish assets, then build a Game Version</li>
                        </ol>
                        <div className="strpg-divider" />
                        <p className="strpg-muted">Importing a Game Package creates a new project. Every asset is DRAFT and must be validated, reviewed, and published before building.</p>
                    </section>
                </div>
            )}

            <ProjectModal open={modal === 'project'} value={newProject} setValue={setNewProject} onClose={() => setModal(null)} onSubmit={createProject} busy={busy} />
            <NewAssetModal
                open={modal === 'asset'}
                value={newAsset}
                setValue={setNewAsset}
                onClose={() => setModal(null)}
                onSubmit={createAsset}
                busy={busy}
            />
            <Confirm
                open={modal === 'delete'}
                title="Delete Project?"
                onCancel={() => setModal(null)}
                onConfirm={deleteProject}
                confirmLabel="Delete"
                danger
            >
                <p>Projects with Campaigns cannot be deleted. This cannot be undone. Back up first.</p>
            </Confirm>
            {modal === 'review' && asset && (
                <Modal
                    title="Human Review"
                    subtitle={`${asset.kind}/${asset.asset_key} · revision ${asset.revision}`}
                    onClose={() => setModal(null)}
                    footer={(
                        <div className="strpg-row end">
                            <Button onClick={() => setModal(null)}>Cancel</Button>
                            <Button variant="gold" onClick={submitReview} disabled={busy || !review.reviewer}>Submit Review</Button>
                        </div>
                    )}
                >
                    <div className="strpg-form">
                        <Field label="Reviewer"><Input value={review.reviewer} onChange={(event) => setReview({ ...review, reviewer: event.target.value })} /></Field>
                        <Field label="Decision">
                            <Select value={review.decision} onChange={(event) => setReview({ ...review, decision: event.target.value })}>
                                <option value="approve">Passed</option>
                                <option value="reject">Return to DRAFT</option>
                            </Select>
                        </Field>
                        <Field label="Note"><Textarea rows={3} value={review.note} onChange={(event) => setReview({ ...review, note: event.target.value })} /></Field>
                    </div>
                    <div className="strpg-callout">Only VALIDATION content can be reviewed. Publishing is a separate step after approval.</div>
                </Modal>
            )}
            <ClassBuilder
                open={classOpen}
                projectId={projectId}
                notify={notify}
                onClose={() => setClassOpen(false)}
                onSaved={async (created) => { await refreshProject(); await openAsset(created.id); }}
            />
            <RulesCompiler
                open={rulesOpen}
                projectId={projectId}
                notify={notify}
                onClose={() => setRulesOpen(false)}
                onSaved={async (created) => { await refreshProject(); await openAsset(created.id); }}
            />
        </div>
    );
}

function AssetEditor({ asset, draftJson, setDraftJson, draftName, setDraftName, editorError, busy, onSave, onValidate, onReview, onPublish, onNewRevision, onUploadImage, onExport, onOpenGraph }) {
    const editable = asset.status === 'DRAFT';
    const validation = asset.validation;
    let draftKey = asset.asset_key;
    try { draftKey = JSON.parse(draftJson || '{}').key ?? asset.asset_key; } catch { /* invalid JSON is shown in the editor */ }
    return (
        <div className="strpg-asset-editor">
            <header>
                <div>
                    <div className="strpg-row wrap">
                        <Badge tone="info">{KIND_LABELS[asset.kind] ?? asset.kind}</Badge>
                        <StatusBadge status={asset.status} />
                        <span className="strpg-muted">r{asset.revision}</span>
                    </div>
                    <h2>{asset.name}</h2>
                    <code>{asset.asset_key}</code>
                </div>
                <div className="strpg-row wrap end">
                    {onOpenGraph && <Button size="sm" onClick={onOpenGraph}>Node Graph</Button>}
                    {editable && <Button size="sm" onClick={onSave} disabled={busy}>Save DRAFT</Button>}
                    {editable && <Button size="sm" onClick={onValidate} disabled={busy}>Automatic Validation</Button>}
                    {asset.status === 'VALIDATION' && <Button size="sm" variant="gold" onClick={onReview} disabled={busy}>Human Review</Button>}
                    {asset.status === 'REVIEWED' && <Button size="sm" variant="gold" onClick={onPublish} disabled={busy}>Publish</Button>}
                    {!editable && <Button size="sm" variant="gold" onClick={onNewRevision} disabled={busy}>New Revision</Button>}
                    <Button size="sm" variant="ghost" onClick={onExport}>Export</Button>
                </div>
            </header>
            <div className="strpg-asset-meta">
                <Field label="Display Name"><Input value={draftName} disabled={!editable} onChange={(event) => setDraftName(event.target.value)} /></Field>
                <Field label="Key"><Input value={draftKey} disabled readOnly /></Field>
                {['npc', 'monster', 'scene'].includes(asset.kind) && (
                    <Field label="Image (external file)">
                        <div className="strpg-row">
                            <label className={`strpg-btn strpg-btn-default strpg-btn-sm ${editable ? '' : 'disabled'}`}>
                                {editable ? 'Import Image' : 'Read Only'}
                                <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={!editable} onChange={onUploadImage} />
                            </label>
                            <span className="strpg-muted">Stored as a Data URL, max 3 MB. ComfyUI can supply the same field later.</span>
                        </div>
                    </Field>
                )}
            </div>
            {editorError && <ErrorBox error={editorError} />}
            {validation && (
                <div className={`strpg-validation ${validation.valid ? 'valid' : 'invalid'}`}>
                    <Badge tone={validation.valid ? 'success' : 'danger'}>{validation.valid ? 'Schema validation passed' : `${validation.errors.length}  errors`}</Badge>
                    {(validation.errors ?? []).map((entry, index) => <div className="strpg-validation-row" key={index}><code>{entry.path}</code><span>{entry.message}</span></div>)}
                    {(validation.warnings ?? []).map((entry, index) => <div className="strpg-validation-row warning" key={`w-${index}`}><code>{entry.path}</code><span>{entry.message}</span></div>)}
                </div>
            )}
            <div className="strpg-editor-split">
                <div className="strpg-json-editor">
                    <div className="strpg-editor-head"><span>Structured JSON</span><span>{editable ? 'Editable' : 'Locked'}</span></div>
                    <Textarea
                        spellCheck={false}
                        rows={30}
                        value={draftJson}
                        readOnly={!editable}
                        onChange={(event) => setDraftJson(event.target.value)}
                    />
                </div>
                <aside className="strpg-asset-history">
                    <span className="strpg-eyebrow">HISTORY</span>
                    {(asset.history ?? []).slice(0, 8).map((entry) => (
                        <div className="strpg-history-row" key={entry.id}>
                            <span>r{entry.revision}</span>
                            <strong>{entry.status}</strong>
                            <small>{entry.created_by} · {new Date(entry.created_at).toLocaleString()}</small>
                            {entry.note && <p>{entry.note}</p>}
                        </div>
                    ))}
                    <div className="strpg-divider" />
                    <span className="strpg-eyebrow">REVIEWS</span>
                    {(asset.reviews ?? []).slice(0, 5).map((entry) => (
                        <div className="strpg-history-row" key={entry.id}>
                            <strong>{entry.decision}</strong>
                            <small>{entry.reviewer} · {new Date(entry.created_at).toLocaleString()}</small>
                            {entry.note && <p>{entry.note}</p>}
                        </div>
                    ))}
                </aside>
            </div>
        </div>
    );
}

function ProjectModal({ open, value, setValue, onClose, onSubmit, busy }) {
    if (!open) return null;
    return (
        <Modal
            title="Create Game Project"
            onClose={onClose}
            footer={<div className="strpg-row end"><Button onClick={onClose}>Cancel</Button><Button variant="gold" onClick={onSubmit} disabled={busy || !value.name.trim()}>Create</Button></div>}
        >
            <div className="strpg-form">
                <Field label="Project Name"><Input value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} placeholder="e.g. Starfall Isles" /></Field>
                <Field label="Description"><Textarea rows={4} value={value.description} onChange={(event) => setValue({ ...value, description: event.target.value })} /></Field>
            </div>
        </Modal>
    );
}

function NewAssetModal({ open, value, setValue, onClose, onSubmit, busy }) {
    if (!open) return null;
    return (
        <Modal
            title="Add / Import Content"
            subtitle="Paste {kind, asset} JSON from a designer card, or start from a template."
            onClose={onClose}
            wide
            footer={<div className="strpg-row end"><Button onClick={onClose}>Cancel</Button><Button variant="gold" onClick={onSubmit} disabled={busy}>Create DRAFT</Button></div>}
        >
            <div className="strpg-form">
                <Field label="Content Type">
                    <Select value={value.kind} onChange={(event) => setValue({ kind: event.target.value, text: JSON.stringify(assetTemplate(event.target.value), null, 2) })}>
                        {ASSET_KINDS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                    </Select>
                </Field>
                <Field label="JSON" hint="Must be {kind,asset} or an object with key/kind. It remains DRAFT after import.">
                    <Textarea rows={22} value={value.text} onChange={(event) => setValue({ ...value, text: event.target.value })} spellCheck={false} />
                </Field>
                <label className="strpg-btn strpg-btn-default strpg-btn-sm">
                    Fill from JSON File
                    <input type="file" accept=".json,application/json" hidden onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        try {
                            const parsed = normalizeImportJson(text);
                            if (parsed.package) throw new Error('This is a full Game Package. Use the Import tab.');
                            if (parsed.items) throw new Error('This is a batch of assets. Use the Import tab.');
                            setValue({ kind: parsed.kind, text: JSON.stringify(parsed.data, null, 2) });
                        } catch (error) {
                            window.alert(error.message);
                        }
                    }} />
                </label>
            </div>
        </Modal>
    );
}

function VersionsPanel({ project, busy, onBuild, onPublish, onRollback, onExport, buildResult }) {
    return (
        <div className="strpg-versions">
            <SectionTitle
                eyebrow="GAME BUILDER"
                title="Versions & Publishing"
                description="Builds use the latest PUBLISHED revision of each key. New versions never overwrite existing Campaigns."
                actions={<Button variant="gold" onClick={onBuild} disabled={busy}>Build New Version</Button>}
            />
            {buildResult?.error && <ErrorBox error={buildResult.error} />}
            {buildResult && !buildResult.error && (
                <div className="strpg-build-result">
                    <Badge tone="success">v{buildResult.version} built</Badge>
                    <span>{buildResult.materialized?.locations} locations · {buildResult.materialized?.npcs} NPC · {buildResult.materialized?.monsters} monsters · {buildResult.materialized?.quests} quests</span>
                    <code>{buildResult.packageHash?.slice(0, 16)}</code>
                </div>
            )}
            <div className="strpg-version-list">
                {(project?.versions ?? []).map((version) => (
                    <div className="strpg-version-row" key={version.id}>
                        <div className="strpg-version-number">v{version.version}</div>
                        <div className="strpg-version-info">
                            <div className="strpg-row"><strong>Game Version {version.version}</strong><StatusBadge status={version.status} /></div>
                            <span>{version.notes || 'No release notes'}</span>
                            <small>{version.published_at ? `Published ${new Date(version.published_at).toLocaleString()}` : `Created ${new Date(version.created_at).toLocaleString()}`} · {version.package_hash?.slice(0, 12)}</small>
                        </div>
                        <div className="strpg-row wrap">
                            {version.status === 'draft' && <Button size="sm" variant="gold" onClick={() => onPublish(version.id)} disabled={busy}>Publish</Button>}
                            {version.status === 'published' && <Button size="sm" onClick={() => onRollback(version.id)} disabled={busy}>Roll Back to This Version</Button>}
                            <Button size="sm" variant="ghost" onClick={() => onExport(version.id)}>Export Package</Button>
                        </div>
                    </div>
                ))}
                {!project?.versions?.length && <Empty title="No versions built yet" icon="⚒">Publish all content, then click Build New Version.</Empty>}
            </div>
        </div>
    );
}

function GraphWorkspace({ project, assets, graphKind, setGraphKind, graphAssetId, setGraphAssetId, notify, onRefresh }) {
    const [fullAsset, setFullAsset] = useState(null);
    const storyAssets = assets.filter((entry) => entry.kind === 'story');
    const questAssets = assets.filter((entry) => entry.kind === 'quest');
    const options = graphKind === 'story' ? storyAssets : graphKind === 'quest' ? questAssets : [];
    const selectedId = graphAssetId || options[0]?.id;
    useEffect(() => {
        if (graphKind === 'world' || !selectedId) { setFullAsset(null); return; }
        api(`/assets/${selectedId}`).then(setFullAsset).catch((err) => notify(err.message, 'danger'));
        setGraphAssetId(selectedId);
    }, [graphKind, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

    const apply = async (data, options = {}) => {
        if (!fullAsset) return null;
        if (fullAsset.status !== 'DRAFT') throw new Error('Published or reviewed content is immutable. Create a new revision first.');
        const updated = await api(`/assets/${fullAsset.id}`, { method: 'PATCH', body: { data, name: fullAsset.name } });
        const result = options.validate ? await api(`/assets/${fullAsset.id}/validate`, { method: 'POST', body: {} }) : updated;
        setFullAsset(result);
        await onRefresh(result.id);
        return result;
    };
    const newRevision = async () => {
        if (!fullAsset) return;
        const created = await api(`/assets/${fullAsset.id}/new-revision`, { method: 'POST', body: {} });
        setFullAsset(created);
        await onRefresh(created.id);
        notify('New editable revision created.', 'success');
    };

    return (
        <div className="strpg-graph-workspace">
            <SectionTitle
                eyebrow="NODE GRAPH EDITOR"
                title="Story Graph / Quest Graph / World Graph"
                description="Drag nodes, connect edges, edit conditions and actions, auto-layout, validate connectivity, and highlight errors."
                actions={(
                    <div className="strpg-row">
                        <Select value={graphKind} onChange={(event) => { setGraphKind(event.target.value); setGraphAssetId(''); }}>
                            <option value="story">Story Graph</option>
                            <option value="quest">Quest Graph</option>
                            <option value="world">World Graph</option>
                        </Select>
                        {graphKind !== 'world' && options.length > 0 && (
                            <Select value={selectedId} onChange={(event) => setGraphAssetId(event.target.value)}>
                                {options.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.status}</option>)}
                            </Select>
                        )}
                    </div>
                )}
            />
            {graphKind === 'world' ? (
                <WorldGraphPreview project={project} assets={assets} notify={notify} onRefresh={onRefresh} />
            ) : fullAsset ? (
                <NodeGraphEditor asset={fullAsset} onApply={apply} onNewRevision={newRevision} notify={notify} />
            ) : <Empty title="No editable graph assets" icon="❖">Create a Story or Quest asset in the Content Library first.</Empty>}
        </div>
    );
}

function WorldGraphPreview({ project, assets, notify, onRefresh }) {
    const scenes = assets.filter((entry) => entry.kind === 'scene');
    const [positions, setPositions] = useState({});
    const [drag, setDrag] = useState(null);
    const svgRef = useRef(null);
    useEffect(() => {
        const next = {};
        for (const scene of scenes) next[scene.id] = { x: Number(scene.data?.map?.x ?? 100), y: Number(scene.data?.map?.y ?? 100) };
        setPositions(next);
    }, [assets]); // eslint-disable-line react-hooks/exhaustive-deps

    const edges = scenes.flatMap((scene) => (scene.data?.connections ?? []).map((connection) => ({
        from: scene.id,
        to: scenes.find((entry) => entry.asset_key === connection.toKey)?.id,
        label: connection.label,
    }))).filter((edge) => edge.to);

    const point = (event) => {
        const rect = svgRef.current.getBoundingClientRect();
        return { x: ((event.clientX - rect.left) / rect.width) * 1040, y: ((event.clientY - rect.top) / rect.height) * 560 };
    };
    const saveLayout = async () => {
        let saved = 0;
        for (const scene of scenes) {
            if (scene.status !== 'DRAFT') continue;
            const position = positions[scene.id];
            if (!position) continue;
            try {
                await api(`/assets/${scene.id}`, { method: 'PATCH', body: { data: { ...scene.data, map: { ...(scene.data.map ?? {}), x: position.x, y: position.y } } } });
                saved += 1;
            } catch (err) {
                notify(err.message, 'danger');
            }
        }
        notify(saved ? `Saved ${saved} DRAFT scene layouts.` : 'No editable DRAFT scenes. Published scene layouts are locked.', saved ? 'success' : 'warning');
        await onRefresh();
    };
    return (
        <div className="strpg-world-graph">
            <div className="strpg-graph-toolbar editor">
                <Button size="sm" variant="gold" onClick={saveLayout}>Save Scene Layouts</Button>
                <span className="strpg-muted">World Graph aggregates each Scene's map coordinates and connections. Only DRAFT scene layouts can be saved.</span>
            </div>
            <div className="strpg-graph-stage">
                <svg
                    ref={svgRef}
                    viewBox="0 0 1040 560"
                    className="strpg-graph-svg"
                    onPointerMove={(event) => {
                        if (!drag) return;
                        const pointNow = point(event);
                        setPositions((current) => ({ ...current, [drag.id]: { x: Math.max(20, pointNow.x - drag.dx), y: Math.max(20, pointNow.y - drag.dy) } }));
                    }}
                    onPointerUp={() => setDrag(null)}
                    onPointerLeave={() => setDrag(null)}
                >
                    <rect width="1040" height="560" fill="#0b1119" />
                    {edges.map((edge, index) => {
                        const a = positions[edge.from];
                        const b = positions[edge.to];
                        if (!a || !b) return null;
                        return <line key={index} x1={a.x + 85} y1={a.y + 24} x2={b.x} y2={b.y + 24} className="strpg-graph-edge" />;
                    })}
                    {scenes.map((scene) => {
                        const position = positions[scene.id] ?? { x: 100, y: 100 };
                        return (
                            <g
                                key={scene.id}
                                transform={`translate(${position.x} ${position.y})`}
                                className={`strpg-graph-node ${scene.status !== 'DRAFT' ? 'locked' : ''}`}
                                onPointerDown={(event) => {
                                    if (scene.status !== 'DRAFT') return;
                                    const pointNow = point(event);
                                    setDrag({ id: scene.id, dx: pointNow.x - position.x, dy: pointNow.y - position.y });
                                    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
                                }}
                            >
                                <rect width="170" height="48" rx="8" />
                                <text x="10" y="19" className="strpg-graph-node-title">{scene.name}</text>
                                <text x="10" y="35" className="strpg-graph-node-sub">{scene.asset_key} · {scene.status}</text>
                            </g>
                        );
                    })}
                </svg>
            </div>
        </div>
    );
}



