import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Field, Input, Loading, Modal, Select, Textarea } from '../ui.jsx';
import {
    DIRECTOR_ROLES, DIRECTOR_ROLE_MAP, MEMORY_VISIBILITY, buildBatchPlanPrompt, buildRolePrompt,
    createMemoryEntry, directorRole, findSpoilerTerms, normalizeDirectorState, parseBatchPlan,
    parseRoleOutput, redactSpoilerTerms, referenceKeysForKind, roleAssetKind, rolePrompt,
} from '../directorRoles.js';
import { assetTemplate } from '../assetTemplates.js';
import { generateQuiet } from '../llm.js';
import { GenerateAssetModal } from './GenerateAssetModal.jsx';

const DEFAULT_QUESTIONS = {
    narrator: 'Summarize the last few events for the memory book. Separate what the player knows from what is still hidden, then propose the next story hook as a concrete place-pressure-choice-consequence.',
    'quest-designer': 'Turn the strongest open thread into one playable quest ready for a single Quest asset. Name type, level, start, turn-in, stages, objectives and rewards. Put alternative hooks in director notes.',
    'casting-director': 'Design one primary NPC for the current place, ready for a single NPC asset. Give them a role, a visible detail, a voice, a motive, a secret and the interactions they expose. Put alternative castings in director notes.',
    ecologist: 'Propose one primary creature or encounter group for the current environment, ready for a single Monster asset. Explain why it belongs here, how it fights and what the player can read before combat. Put alternatives in director notes.',
    cartographer: 'Propose one primary scene that connects to the current map, ready for a single Scene asset. Give layer, site type, parent, landmarks, routes and what the player can learn there. Put alternative rooms in director notes.',
    quartermaster: 'Propose one primary item with a place in the economy, a history, stats, price and an acquisition route. Put alternatives in director notes.',
    'skill-wright': 'Propose one primary skill or status effect with a clear tactical identity and exact effect shape. Put alternatives in director notes.',
    'rules-keeper': 'Propose one class or one small ruleset with an exact stat identity, growth curve and safe numbers.',
    'continuity-editor': 'Review the memory book, handoffs and latest briefs for contradictions, repetition, timeline problems, unresolved threads and spoiler leaks. Propose fixes; create no asset.',
};

const MEMORY_TYPES = ['event', 'summary', 'hook', 'secret', 'decision', 'note'];

function visibilityTone(visibility) {
    return visibility === 'player' ? 'success' : visibility === 'secret' ? 'danger' : 'warning';
}

function sourceName(source) {
    return DIRECTOR_ROLE_MAP[source]?.name ?? 'Director';
}

function batchStatusTone(status) {
    return status === 'generated' ? 'success' : status === 'reserved' ? 'warning' : status === 'failed' ? 'danger' : 'neutral';
}

function timeLabel(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleString(); } catch { return ''; }
}

function defaultQuestion(role) {
    return DEFAULT_QUESTIONS[role.id] ?? 'Propose the next piece of content for your domain.';
}

export function DirectorRoom({ projectId, project, onRefresh, notify }) {
    const [board, setBoard] = useState(() => normalizeDirectorState(project?.metadata?.director));
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState(null);
    const [playerView, setPlayerView] = useState(false);
    const [ask, setAsk] = useState(null);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [promptRoleId, setPromptRoleId] = useState(null);
    const [promptDraft, setPromptDraft] = useState('');
    const [memoryForm, setMemoryForm] = useState({ text: '', visibility: 'player', type: 'event', source: 'director' });
    const [noteForm, setNoteForm] = useState({ text: '', type: 'facts', visibility: 'director' });
    const [termDraft, setTermDraft] = useState('');
    const [genSeed, setGenSeed] = useState(null);
    const [batchPlan, setBatchPlan] = useState(null);
    const [planBusy, setPlanBusy] = useState(false);
    const [planError, setPlanError] = useState(null);
    const [activeBatchId, setActiveBatchId] = useState(null);
    const [batchBusy, setBatchBusy] = useState(false);

    const assets = project?.assets ?? [];
    const terms = board.spoilers.terms;
    const activeRole = ask ? directorRole(ask.roleId) : null;
    const batches = board.batches ?? [];
    const activeBatch = batches.find((batch) => batch.id === activeBatchId) ?? batches[batches.length - 1] ?? null;
    const planRole = batchPlan ? directorRole(batchPlan.roleId) : null;

    useEffect(() => {
        setBoard(normalizeDirectorState(project?.metadata?.director));
        setActiveBatchId(null);
        setBatchPlan(null);
        setAsk(null);
    }, [projectId]);

    useEffect(() => {
        if (!activeBatchId && board.batches.length) setActiveBatchId(board.batches[board.batches.length - 1].id);
    }, [board.batches.length, activeBatchId]);

    useEffect(() => {
        if (!ask?.busy) return undefined;
        const timer = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
        return () => clearInterval(timer);
    }, [ask?.busy, startedAt]);

    const persist = async (next, message = '') => {
        setBoard(next);
        setSaving(true);
        try {
            await api(`/projects/${projectId}`, { method: 'PATCH', body: { metadata: { director: next } } });
            setSavedAt(new Date());
            if (message) notify?.(message, 'success');
            await onRefresh?.();
            return true;
        } catch (error) {
            notify?.(error.message, 'danger');
            return false;
        } finally {
            setSaving(false);
        }
    };

    const openAsk = (role, question = '') => {
        setAsk({
            roleId: role.id,
            question: question || defaultQuestion(role),
            includeSecrets: playerView ? false : board.settings.includeSecrets,
            busy: false,
            result: null,
            error: null,
            targetRole: role.nextRole,
            resultKind: roleAssetKind(role, board) ?? '',
            redacted: false,
        });
        setElapsed(0);
    };

    const runAsk = async () => {
        if (!ask || !activeRole) return;
        setStartedAt(Date.now());
        setElapsed(0);
        setAsk((current) => ({ ...current, busy: true, result: null, error: null }));
        try {
            const prompt = buildRolePrompt({
                role: activeRole,
                state: board,
                question: ask.question,
                includeSecrets: ask.includeSecrets,
                knownKeys: referenceKeysForKind(roleAssetKind(activeRole, board), assets),
            });
            const reply = await generateQuiet(prompt, { responseLength: activeRole.id === 'continuity-editor' ? 1200 : 2000 });
            setAsk((current) => (current ? { ...current, busy: false, result: parseRoleOutput(reply) } : current));
        } catch (error) {
            setAsk((current) => (current ? { ...current, busy: false, error } : current));
        }
    };

    const updateResult = (key, value) => setAsk((current) => (current?.result ? { ...current, result: { ...current.result, [key]: value } } : current));

    const saveAskToMemory = async () => {
        if (!ask?.result) return;
        const brief = ask.result.brief.trim();
        const notes = ask.result.notes.trim();
        if (!brief && !notes) { notify?.('There is no brief or note to save.', 'warning'); return; }
        if (brief && findSpoilerTerms(brief, terms).length) {
            notify?.('Redact protected spoiler terms in the player-safe brief first.', 'warning');
            return;
        }
        const entries = [];
        if (brief) entries.push(createMemoryEntry({ source: activeRole.id, type: 'summary', text: brief, visibility: 'player' }));
        if (notes) entries.push(createMemoryEntry({ source: activeRole.id, type: 'note', text: notes, visibility: 'director' }));
        const roleState = board.roles[activeRole.id] ?? {};
        const next = normalizeDirectorState({
            ...board,
            memory: [...entries, ...board.memory].slice(0, 200),
            roles: {
                ...board.roles,
                [activeRole.id]: {
                    ...roleState,
                    lastBrief: brief || roleState.lastBrief,
                    lastNotes: notes || roleState.lastNotes,
                    lastAt: new Date().toISOString(),
                },
            },
        });
        await persist(next, 'Saved to the memory book.');
    };

    const addHandoff = async () => {
        if (!ask?.result?.handoff?.trim()) { notify?.('Write a handoff first.', 'warning'); return; }
        const entry = {
            id: `hand_${Date.now().toString(36)}`,
            at: new Date().toISOString(),
            from: activeRole.id,
            to: ask.targetRole,
            text: ask.result.handoff.trim(),
        };
        const next = normalizeDirectorState({
            ...board,
            blackboard: { ...board.blackboard, handoffs: [...board.blackboard.handoffs, entry].slice(-100) },
        });
        await persist(next, 'Handoff recorded.');
    };

    const useBriefInGenerator = () => {
        if (!ask?.result || !activeRole) return;
        const kind = ask.resultKind || roleAssetKind(activeRole, board);
        if (!kind) { notify?.('This role does not own a content kind.', 'warning'); return; }
        const brief = ask.result.brief.trim() || ask.result.raw;
        if (findSpoilerTerms(brief, terms).length) {
            notify?.('Redact protected spoiler terms before using the brief as a public prompt.', 'warning');
            return;
        }
        setGenSeed({
            kind,
            prompt: brief,
            references: referenceKeysForKind(kind, assets).join(', '),
            spoilerTerms: terms,
        });
        setAsk(null);
    };

    const openBatchPlan = (role) => {
        if (!role.allowedKinds.length) return;
        setPlanError(null);
        setBatchPlan({
            roleId: role.id,
            kind: roleAssetKind(role, board) || role.allowedKinds[0],
            count: 3,
            theme: '',
            items: [],
        });
    };

    const runBatchPlan = async () => {
        if (!batchPlan || !planRole) return;
        setPlanBusy(true);
        setPlanError(null);
        try {
            const prompt = buildBatchPlanPrompt({
                role: planRole,
                state: board,
                kind: batchPlan.kind,
                count: batchPlan.count,
                theme: batchPlan.theme,
                knownKeys: assets.map((asset) => asset.asset_key),
            });
            const reply = await generateQuiet(prompt, { responseLength: 1200 });
            const items = parseBatchPlan(reply, batchPlan.kind, Number(batchPlan.count) || 12);
            if (!items.length) throw new Error('The model did not return any "key | Title | brief" lines. Add rows manually or plan again.');
            setBatchPlan((current) => ({
                ...current,
                items: items.map((item, index) => ({ ...item, id: `plan_${Date.now()}_${index}` })),
            }));
        } catch (error) {
            setPlanError(error);
        } finally {
            setPlanBusy(false);
        }
    };

    const updatePlanItem = (id, key, value) => {
        setBatchPlan((current) => ({
            ...current,
            items: current.items.map((item) => item.id === id ? { ...item, [key]: value } : item),
        }));
    };

    const addPlanRow = () => {
        setBatchPlan((current) => ({
            ...current,
            items: [...current.items, { id: `plan_${Date.now()}`, key: `${current.kind}_${current.items.length + 1}`, title: 'New entry', brief: '' }],
        }));
    };

    const removePlanRow = (id) => {
        setBatchPlan((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
    };

    const updateBatchItem = (batchId, itemId, key, value) => {
        setBoard((current) => normalizeDirectorState({
            ...current,
            batches: current.batches.map((batch) => batch.id === batchId ? {
                ...batch,
                items: batch.items.map((item) => item.id === itemId ? { ...item, [key]: value } : item),
            } : batch),
        }));
    };

    const createBatch = async () => {
        if (!batchPlan || !planRole) return;
        const items = batchPlan.items.filter((item) => item.key.trim() && item.title.trim());
        if (!items.length) { notify?.('A batch needs at least one key and title.', 'warning'); return; }
        const batch = {
            id: `batch_${Date.now().toString(36)}`,
            name: `${planRole.name} · ${batchPlan.kind}`,
            kind: batchPlan.kind,
            roleId: planRole.id,
            createdAt: new Date().toISOString(),
            autoAdvance: false,
            items: items.map((item, index) => ({
                id: `item_${Date.now().toString(36)}_${index}`,
                key: item.key.trim(),
                title: item.title.trim(),
                brief: item.brief.trim(),
                status: 'planned',
                assetId: null,
                generatedAt: null,
                error: '',
            })),
        };
        const next = normalizeDirectorState({ ...board, batches: [...board.batches, batch] });
        await persist(next, `Planned a batch of ${batch.items.length} ${batch.kind} entries.`);
        setActiveBatchId(batch.id);
        setBatchPlan(null);
    };

    const deleteBatch = async () => {
        if (!activeBatch) return;
        if (!window.confirm(`Delete the batch "${activeBatch.name}"? Reserved DRAFT assets stay in the project; this only removes the queue.`)) return;
        const next = normalizeDirectorState({ ...board, batches: board.batches.filter((batch) => batch.id !== activeBatch.id) });
        await persist(next, 'Batch queue removed.');
        setActiveBatchId(null);
    };

    const toggleAutoAdvance = async () => {
        if (!activeBatch) return;
        const next = normalizeDirectorState({
            ...board,
            batches: board.batches.map((batch) => batch.id === activeBatch.id ? { ...batch, autoAdvance: !batch.autoAdvance } : batch),
        });
        await persist(next);
    };

    const reserveBatch = async () => {
        if (!activeBatch) return;
        setBatchBusy(true);
        const next = normalizeDirectorState({ ...board });
        const target = next.batches.find((batch) => batch.id === activeBatch.id);
        const used = new Set(assets.filter((asset) => asset.kind === target.kind).map((asset) => asset.asset_key));
        const renamed = [];
        let createdCount = 0;
        try {
            for (const item of target.items) {
                if (item.status !== 'planned' || !item.key) continue;
                let key = item.key;
                let suffix = 2;
                while (used.has(key)) { key = `${item.key}_${suffix}`; suffix += 1; }
                if (key !== item.key) renamed.push(`${item.key} → ${key}`);
                used.add(key);
                const template = assetTemplate(target.kind);
                const data = {
                    ...template,
                    key,
                    name: item.title || key,
                    description: template.description ?? '',
                    designerNotes: [item.brief].filter(Boolean),
                };
                const created = await api(`/projects/${projectId}/assets`, {
                    method: 'POST',
                    body: { kind: target.kind, data, name: item.title || key, note: 'Reserved from Director batch' },
                });
                item.key = key;
                item.assetId = created.id;
                item.status = 'reserved';
                createdCount += 1;
            }
            await persist(next, `Reserved ${createdCount} DRAFT${createdCount === 1 ? '' : 's'} for the batch.`);
            if (renamed.length) notify?.(`Renamed reserved keys to avoid collisions: ${renamed.join(', ')}`, 'warning');
        } catch (error) {
            await persist(next);
            notify?.(`Reservation stopped: ${error.message}`, 'danger');
        } finally {
            setBatchBusy(false);
        }
    };

    const openBatchItem = (batch, item) => {
        if (!batch || !item) return;
        if (item.status === 'planned') {
            notify?.('Reserve the batch first so the key and title are locked.', 'warning');
            return;
        }
        setGenSeed({
            kind: batch.kind,
            prompt: item.brief || item.title,
            references: referenceKeysForKind(batch.kind, assets).join(', '),
            spoilerTerms: terms,
            keyOverride: item.key,
            nameOverride: item.title,
            batchId: batch.id,
            itemId: item.id,
        });
    };

    const generateNextBatchItem = () => {
        if (!activeBatch) return;
        const next = activeBatch.items.find((item) => item.status === 'reserved');
        if (!next) {
            notify?.('No reserved items are waiting. Reserve the planned entries first.', 'info');
            return;
        }
        openBatchItem(activeBatch, next);
    };

    const handleBatchSaved = async (created) => {
        const seed = genSeed;
        if (!seed?.batchId || !seed?.itemId) { setGenSeed(null); return; }
        const next = normalizeDirectorState({ ...board });
        const batch = next.batches.find((entry) => entry.id === seed.batchId);
        const item = batch?.items.find((entry) => entry.id === seed.itemId);
        if (item) {
            item.status = 'generated';
            item.assetId = created?.id ?? item.assetId;
            item.generatedAt = new Date().toISOString();
        }
        await persist(next, 'Batch item generated as DRAFT.');
        setGenSeed(null);
        if (batch?.autoAdvance) {
            const following = batch.items.find((entry) => entry.status === 'reserved');
            if (following) setTimeout(() => openBatchItem(batch, following), 350);
        }
    };

    const addMemory = async () => {
        if (!memoryForm.text.trim()) return;
        const entry = createMemoryEntry({ ...memoryForm, text: memoryForm.text, visibility: memoryForm.visibility, type: memoryForm.type, source: memoryForm.source });
        const next = normalizeDirectorState({ ...board, memory: [entry, ...board.memory].slice(0, 200) });
        setMemoryForm((current) => ({ ...current, text: '' }));
        await persist(next, 'Memory entry added.');
    };

    const removeMemory = async (id) => {
        const next = normalizeDirectorState({ ...board, memory: board.memory.filter((entry) => entry.id !== id) });
        await persist(next);
    };

    const changeMemoryVisibility = async (id, visibility) => {
        const next = normalizeDirectorState({ ...board, memory: board.memory.map((entry) => entry.id === id ? { ...entry, visibility } : entry) });
        await persist(next);
    };

    const addNote = async () => {
        if (!noteForm.text.trim()) return;
        const entry = {
            id: `bb_${Date.now().toString(36)}`,
            at: new Date().toISOString(),
            text: noteForm.text.trim(),
            visibility: noteForm.visibility,
        };
        const key = ['facts', 'decisions', 'threads'].includes(noteForm.type) ? noteForm.type : 'facts';
        const next = normalizeDirectorState({
            ...board,
            blackboard: { ...board.blackboard, [key]: [...board.blackboard[key], entry] },
        });
        setNoteForm((current) => ({ ...current, text: '' }));
        await persist(next, 'Blackboard updated.');
    };

    const removeBoardEntry = async (type, id) => {
        const next = normalizeDirectorState({
            ...board,
            blackboard: { ...board.blackboard, [type]: (board.blackboard[type] ?? []).filter((entry) => entry.id !== id) },
        });
        await persist(next);
    };

    const removeHandoff = async (id) => {
        const next = normalizeDirectorState({
            ...board,
            blackboard: { ...board.blackboard, handoffs: board.blackboard.handoffs.filter((entry) => entry.id !== id) },
        });
        await persist(next);
    };

    const addTerm = async () => {
        const term = termDraft.trim();
        if (!term) return;
        const next = normalizeDirectorState({ ...board, spoilers: { terms: [...terms, term] } });
        setTermDraft('');
        await persist(next, 'Spoiler term added.');
    };

    const removeTerm = async (term) => {
        const next = normalizeDirectorState({ ...board, spoilers: { terms: terms.filter((entry) => entry !== term) } });
        await persist(next);
    };

    const openPrompt = (role) => {
        setPromptRoleId(role.id);
        setPromptDraft(rolePrompt(role, board));
    };

    const savePrompt = async () => {
        if (!promptRoleId) return;
        const next = normalizeDirectorState({
            ...board,
            roles: { ...board.roles, [promptRoleId]: { ...(board.roles[promptRoleId] ?? {}), prompt: promptDraft.trim() } },
        });
        await persist(next, 'Role guidance saved.');
        setPromptRoleId(null);
    };

    const toggleExcludeSecrets = async () => {
        const next = normalizeDirectorState({ ...board, settings: { ...board.settings, includeSecrets: !board.settings.includeSecrets } });
        await persist(next);
    };

    const memoryRows = useMemo(() => {
        const rows = board.memory;
        if (!playerView) return rows;
        return rows.filter((entry) => entry.visibility === 'player');
    }, [board.memory, playerView]);

    const promptRole = promptRoleId ? directorRole(promptRoleId) : null;
    const askSpoilerHits = ask?.result?.brief ? findSpoilerTerms(ask.result.brief, terms) : [];

    return (
        <div className="strpg-director">
            <header className="strpg-director-head">
                <div>
                    <span className="strpg-eyebrow">DIRECTOR'S ROOM · AUTHORING TABLE</span>
                    <h2>Write with a room, not a slot machine</h2>
                    <p>Each role owns one content domain. Ask it for a player-safe brief, review the director notes, then hand the brief to the Workbench AI generator as a precise prompt. Hidden facts stay in the memory book and are never shown in the player-safe brief.</p>
                </div>
                <div className="strpg-director-head-actions">
                    <Badge tone={playerView ? 'success' : 'gold'}>{playerView ? 'PLAYER VIEW' : 'DIRECTOR VIEW'}</Badge>
                    <Button size="sm" variant={playerView ? 'gold' : 'ghost'} onClick={() => setPlayerView((value) => !value)}>
                        {playerView ? 'Show director view' : 'Player-safe view'}
                    </Button>
                    <Button size="sm" variant="gold" onClick={() => openAsk(directorRole('narrator'))}>Ask Narrator</Button>
                </div>
            </header>

            <div className="strpg-director-roles">
                {DIRECTOR_ROLES.map((role) => {
                    const state = board.roles[role.id] ?? {};
                    const inbox = board.blackboard.handoffs.filter((entry) => entry.to === role.id);
                    return (
                        <article className={`strpg-director-role ${state.lastAt ? 'active' : ''}`} key={role.id}>
                            <div className="strpg-director-role-head">
                                <span className="strpg-director-role-icon">{role.icon}</span>
                                <div>
                                    <strong>{role.name}</strong>
                                    <span>{role.owns}</span>
                                </div>
                                <Badge tone={inbox.length ? 'gold' : role.assetKind ? 'info' : 'neutral'}>
                                    {inbox.length ? `${inbox.length} handoff${inbox.length > 1 ? 's' : ''}` : role.assetKind ? role.allowedKinds.join(' / ') : 'review'}
                                </Badge>
                            </div>
                            <p>{role.description}</p>
                            <div className="strpg-director-role-foot">
                                <span>{state.lastAt ? `Last asked ${timeLabel(state.lastAt)}` : 'Not consulted yet'}</span>
                                <div className="strpg-row">
                                    <Button size="sm" variant="ghost" onClick={() => openPrompt(role)}>Guidance</Button>
                                    {role.allowedKinds.length > 0 && <Button size="sm" variant="ghost" onClick={() => openBatchPlan(role)}>Batch</Button>}
                                    <Button
                                        size="sm"
                                        variant="gold"
                                        onClick={() => openAsk(role, playerView || !inbox.length ? '' : inbox[inbox.length - 1].text)}
                                    >
                                        Ask
                                    </Button>
                                </div>
                            </div>
                        </article>
                    );
                })}
            </div>

            <section className="strpg-director-panel strpg-batch-panel">
                <div className="strpg-director-panel-head">
                    <div>
                        <span className="strpg-eyebrow">BATCH QUEUE</span>
                        <h3>{activeBatch ? activeBatch.name : 'Reserve first, generate one by one'}</h3>
                    </div>
                    <Button size="sm" variant="gold" onClick={() => openBatchPlan(directorRole('quest-designer'))}>Plan batch</Button>
                </div>
                {!batches.length ? (
                    <Empty title="No batch planned" icon="▤">
                        Use a role's <strong>Batch</strong> button to plan a list of keys and titles, reserve those slots as DRAFTs, then generate them one by one.
                    </Empty>
                ) : activeBatch && (
                    <>
                        <div className="strpg-batch-toolbar">
                            <Select value={activeBatch.id} onChange={(event) => setActiveBatchId(event.target.value)}>
                                {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
                            </Select>
                            <Badge tone={activeBatch.items.every((item) => item.status === 'generated') ? 'success' : 'info'}>
                                {activeBatch.items.filter((item) => item.status === 'generated').length} / {activeBatch.items.length} generated
                            </Badge>
                            <Button size="sm" onClick={reserveBatch} disabled={batchBusy || !activeBatch.items.some((item) => item.status === 'planned')}>
                                {batchBusy ? 'Reserving…' : 'Reserve DRAFTs'}
                            </Button>
                            <Button size="sm" variant="gold" onClick={generateNextBatchItem} disabled={batchBusy || !activeBatch.items.some((item) => item.status === 'reserved')}>
                                Generate next
                            </Button>
                            <label className="strpg-checkbox">
                                <input type="checkbox" checked={Boolean(activeBatch.autoAdvance)} onChange={toggleAutoAdvance} />
                                Auto-advance
                            </label>
                            <Button size="sm" variant="ghost" onClick={deleteBatch}>Delete queue</Button>
                        </div>
                        <p className="strpg-muted">
                            Reserve creates blank DRAFTs with the planned keys and titles. Generate opens the normal AI modal with the key/title locked; the DRAFT is updated in place. Auto-advance reopens the generator for the next reserved item after each save. Queue edits are saved when you reserve or press Save now.
                        </p>
                        <div className="strpg-batch-list">
                            {activeBatch.items.map((item) => (
                                <div className={`strpg-batch-row ${item.status}`} key={item.id}>
                                    <Badge tone={batchStatusTone(item.status)}>{item.status}</Badge>
                                    <Input
                                        value={item.key}
                                        disabled={item.status !== 'planned'}
                                        onChange={(event) => updateBatchItem(activeBatch.id, item.id, 'key', event.target.value)}
                                        title={item.key}
                                    />
                                    <Input
                                        value={item.title}
                                        disabled={item.status !== 'planned'}
                                        onChange={(event) => updateBatchItem(activeBatch.id, item.id, 'title', event.target.value)}
                                    />
                                    <Textarea
                                        rows={2}
                                        value={item.brief}
                                        onChange={(event) => updateBatchItem(activeBatch.id, item.id, 'brief', event.target.value)}
                                        placeholder="One-sentence brief for this asset"
                                    />
                                    <div className="strpg-batch-row-actions">
                                        {item.status === 'reserved' && <Button size="sm" variant="gold" onClick={() => openBatchItem(activeBatch, item)}>Generate</Button>}
                                        {item.status === 'generated' && <Button size="sm" variant="ghost" onClick={() => openBatchItem(activeBatch, item)}>Regenerate</Button>}
                                        {item.status === 'failed' && <Button size="sm" variant="gold" onClick={() => openBatchItem(activeBatch, item)}>Retry</Button>}
                                        {item.status === 'planned' && <span className="strpg-muted">reserve first</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </section>

            <div className="strpg-director-columns">
                <section className="strpg-director-panel">
                    <div className="strpg-director-panel-head">
                        <div><span className="strpg-eyebrow">MEMORY BOOK</span><h3>{board.memory.length} entries</h3></div>
                        <Badge tone="info">{board.memory.filter((entry) => entry.visibility === 'secret').length} secrets</Badge>
                    </div>
                    <p className="strpg-muted">The Narrator's memory. Mark entries player-known, director-only or secret. The player-safe view hides the last two.</p>
                    <div className="strpg-director-form">
                        <div className="strpg-row">
                            <Select value={memoryForm.type} onChange={(event) => setMemoryForm({ ...memoryForm, type: event.target.value })}>
                                {MEMORY_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                            </Select>
                            <Select value={memoryForm.visibility} onChange={(event) => setMemoryForm({ ...memoryForm, visibility: event.target.value })}>
                                {MEMORY_VISIBILITY.map((visibility) => <option key={visibility} value={visibility}>{visibility}</option>)}
                            </Select>
                            <Select value={memoryForm.source} onChange={(event) => setMemoryForm({ ...memoryForm, source: event.target.value })}>
                                {DIRECTOR_ROLES.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                                <option value="director">Director</option>
                            </Select>
                        </div>
                        <Textarea rows={3} value={memoryForm.text} onChange={(event) => setMemoryForm({ ...memoryForm, text: event.target.value })} placeholder="What changed in the campaign, and who knows it?" />
                        <div className="strpg-row"><Button size="sm" onClick={addMemory} disabled={!memoryForm.text.trim()}>Add memory</Button></div>
                    </div>
                    <div className="strpg-director-memory">
                        {memoryRows.map((entry) => (
                            <div className={`strpg-director-memory-row ${entry.visibility}`} key={entry.id}>
                                <div className="strpg-director-memory-meta">
                                    <Badge tone={visibilityTone(entry.visibility)}>{entry.visibility}</Badge>
                                    <span>{entry.type}</span>
                                    <span>{sourceName(entry.source)}</span>
                                    <span>{timeLabel(entry.at)}</span>
                                </div>
                                <p>{playerView ? redactSpoilerTerms(entry.text, terms) : entry.text}</p>
                                <div className="strpg-row">
                                    <Select value={entry.visibility} onChange={(event) => changeMemoryVisibility(entry.id, event.target.value)}>
                                        {MEMORY_VISIBILITY.map((visibility) => <option key={visibility} value={visibility}>{visibility}</option>)}
                                    </Select>
                                    <Button size="sm" variant="ghost" onClick={() => removeMemory(entry.id)}>Remove</Button>
                                </div>
                            </div>
                        ))}
                        {!memoryRows.length && <Empty title="Memory book is empty" icon="◇">Ask the Narrator for a recent summary, or add the first event yourself.</Empty>}
                    </div>
                </section>

                <div className="strpg-director-side">
                    <section className="strpg-director-panel">
                        <div className="strpg-director-panel-head">
                            <div><span className="strpg-eyebrow">BLACKBOARD</span><h3>Shared continuity</h3></div>
                        </div>
                        <p className="strpg-muted">Facts, decisions and open threads are visible to every role. Handoffs are the messages between roles.</p>
                        <div className="strpg-director-form">
                            <div className="strpg-row">
                                <Select value={noteForm.type} onChange={(event) => setNoteForm({ ...noteForm, type: event.target.value })}>
                                    <option value="facts">fact</option>
                                    <option value="decisions">decision</option>
                                    <option value="threads">open thread</option>
                                </Select>
                                <Select value={noteForm.visibility} onChange={(event) => setNoteForm({ ...noteForm, visibility: event.target.value })}>
                                    {MEMORY_VISIBILITY.map((visibility) => <option key={visibility} value={visibility}>{visibility}</option>)}
                                </Select>
                            </div>
                            <Textarea rows={2} value={noteForm.text} onChange={(event) => setNoteForm({ ...noteForm, text: event.target.value })} placeholder="A fact the room must not forget..." />
                            <div className="strpg-row"><Button size="sm" onClick={addNote} disabled={!noteForm.text.trim()}>Add to board</Button></div>
                        </div>
                        {['facts', 'decisions', 'threads'].map((type) => (
                            <div className="strpg-director-board-group" key={type}>
                                <div className="strpg-director-board-label">{type}</div>
                                {(board.blackboard[type] ?? []).filter((entry) => !playerView || entry.visibility === 'player').map((entry) => (
                                    <div className="strpg-director-board-row" key={entry.id}>
                                        <span>{playerView ? redactSpoilerTerms(entry.text, terms) : entry.text}</span>
                                        <div>
                                            <Badge tone={visibilityTone(entry.visibility)}>{entry.visibility}</Badge>
                                            <button type="button" onClick={() => removeBoardEntry(type, entry.id)}>×</button>
                                        </div>
                                    </div>
                                ))}
                                {!(board.blackboard[type] ?? []).length && <span className="strpg-director-empty">None yet.</span>}
                            </div>
                        ))}
                        <div className="strpg-director-board-label">handoffs</div>
                        {!playerView && board.blackboard.handoffs.slice(-6).reverse().map((entry) => (
                            <div className="strpg-director-handoff" key={entry.id}>
                                <div><strong>{sourceName(entry.from)}</strong><span>→</span><strong>{sourceName(entry.to)}</strong><small>{timeLabel(entry.at)}</small></div>
                                <p>{entry.text}</p>
                                <div className="strpg-director-handoff-actions">
                                    <Button size="sm" variant="ghost" onClick={() => openAsk(directorRole(entry.to), entry.text)}>Follow handoff</Button>
                                    <button type="button" onClick={() => removeHandoff(entry.id)}>×</button>
                                </div>
                            </div>
                        ))}
                        {playerView && <span className="strpg-director-empty">Handoffs and director notes are hidden in player-safe view.</span>}
                        {!playerView && !board.blackboard.handoffs.length && <span className="strpg-director-empty">Ask a role and record a handoff to pass work along.</span>}
                    </section>

                    <section className="strpg-director-panel spoiler">
                        <div className="strpg-director-panel-head">
                            <div><span className="strpg-eyebrow">SPOILER GUARD</span><h3>{terms.length} protected terms</h3></div>
                            <Badge tone={terms.length ? 'warning' : 'neutral'}>{terms.length ? 'scanning' : 'empty'}</Badge>
                        </div>
                        <p className="strpg-muted">These terms are scanned in player-safe briefs and generated assets. A hit is a warning, not a silent edit. Add names, twists or future locations you do not want surfaced.</p>
                        <div className="strpg-director-terms">
                            {terms.map((term) => (
                                <span key={term}>{term}<button type="button" onClick={() => removeTerm(term)}>×</button></span>
                            ))}
                            {!terms.length && <span className="strpg-director-empty">No protected terms yet.</span>}
                        </div>
                        <div className="strpg-row">
                            <Input value={termDraft} onChange={(event) => setTermDraft(event.target.value)} placeholder="e.g. the Sixth Warden" />
                            <Button size="sm" onClick={addTerm} disabled={!termDraft.trim()}>Protect</Button>
                        </div>
                        <div className="strpg-director-spoiler-actions">
                            <Button size="sm" variant={board.settings.includeSecrets ? 'gold' : 'ghost'} onClick={toggleExcludeSecrets}>
                                {board.settings.includeSecrets ? 'Roles may use secrets in notes' : 'Roles see player-known facts only'}
                            </Button>
                            <span className="strpg-muted">{playerView ? 'Player-safe view is on.' : 'Director view is on.'}</span>
                        </div>
                    </section>
                </div>
            </div>

            <div className="strpg-director-save">
                <span>{saving ? 'Saving…' : savedAt ? `Saved ${timeLabel(savedAt)}` : 'Changes are stored on the Studio project.'}</span>
                <Button size="sm" variant="ghost" onClick={() => persist(board, 'Director state saved.')} disabled={saving}>Save now</Button>
            </div>

            {ask && activeRole && (
                <Modal
                    title={`Ask ${activeRole.name}`}
                    subtitle={`${activeRole.owns} · ${ask.includeSecrets ? 'director context' : 'player-known context only'} · ${ask.result?.structured === false ? 'unstructured reply' : 'three-section reply'}`}
                    onClose={() => setAsk(null)}
                    wide
                    footer={(
                        <div className="strpg-row end">
                            <Button onClick={() => setAsk(null)} disabled={ask.busy}>Close</Button>
                            <Button variant="ghost" onClick={saveAskToMemory} disabled={ask.busy || !ask.result || askSpoilerHits.length > 0}>Save to memory</Button>
                            <Button variant="ghost" onClick={addHandoff} disabled={ask.busy || !ask.result?.handoff}>Record handoff</Button>
                            <Button variant="gold" onClick={useBriefInGenerator} disabled={ask.busy || !ask.result?.brief || !activeRole.allowedKinds.length || askSpoilerHits.length > 0}>Use brief in AI generator</Button>
                        </div>
                    )}
                >
                    <div className="strpg-ask">
                        <div className="strpg-ask-context">
                            <Field label="Question">
                                <Textarea rows={3} value={ask.question} onChange={(event) => setAsk({ ...ask, question: event.target.value })} />
                            </Field>
                            <div className="strpg-ask-options">
                                <label className="strpg-checkbox">
                                    <input type="checkbox" checked={ask.includeSecrets} disabled={playerView} onChange={(event) => setAsk({ ...ask, includeSecrets: event.target.checked })} />
                                    Include director-only and secret memory
                                </label>
                                {activeRole.allowedKinds.length > 1 && (
                                    <Field label="Asset kind">
                                        <Select value={ask.resultKind} onChange={(event) => setAsk({ ...ask, resultKind: event.target.value })}>
                                            {activeRole.allowedKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                                        </Select>
                                    </Field>
                                )}
                            </div>
                        </div>
                        <div className="strpg-row">
                            <Button variant="gold" onClick={runAsk} disabled={ask.busy || !ask.question.trim()}>{ask.busy ? 'Asking…' : 'Ask'}</Button>
                            <span className="strpg-muted">The reply is not written to the project until you save it.</span>
                        </div>
                        {ask.busy && <Loading label={`Waiting for ${activeRole.name}… ${elapsed}s`} />}
                        <ErrorBox error={ask.error} />
                        {ask.result && (
                            <div className="strpg-ask-result">
                                {!ask.result.structured && <div className="strpg-ask-warning">The model did not use the three headings. Review the whole reply before using it as a player-safe brief.</div>}
                                {askSpoilerHits.length > 0 && (
                                    <div className="strpg-ask-warning danger">
                                        Player-safe brief contains protected terms: {askSpoilerHits.join(', ')}.
                                        <Button size="sm" onClick={() => updateResult('brief', redactSpoilerTerms(ask.result.brief, terms))}>Redact</Button>
                                    </div>
                                )}
                                <Field label="Player-safe brief" hint="This is what the player would see. It is also the prompt sent to the AI generator.">
                                    <Textarea rows={8} value={ask.result.brief} onChange={(event) => updateResult('brief', event.target.value)} />
                                </Field>
                                <Field label="Director notes" hint="Hidden from the player. Never sent to the player-facing generator unless you copy it yourself.">
                                    <Textarea rows={5} value={ask.result.notes} onChange={(event) => updateResult('notes', event.target.value)} />
                                </Field>
                                <div className="strpg-ask-handoff">
                                    <Field label="Handoff" hint="A short message to the next role.">
                                        <Textarea rows={2} value={ask.result.handoff} onChange={(event) => updateResult('handoff', event.target.value)} />
                                    </Field>
                                    <Field label="To">
                                        <Select value={ask.targetRole} onChange={(event) => setAsk({ ...ask, targetRole: event.target.value })}>
                                            {DIRECTOR_ROLES.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                                        </Select>
                                    </Field>
                                </div>
                                {activeRole.allowedKinds.length > 0 && (
                                    <div className="strpg-ask-generator-hint">
                                        Using the brief will open the AI generator for <strong>{ask.resultKind || roleAssetKind(activeRole, board)}</strong> with project keys pre-filled. It still creates only a DRAFT.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </Modal>
            )}

            {batchPlan && planRole && (
                <Modal
                    title={`Plan ${batchPlan.kind} batch · ${planRole.name}`}
                    subtitle="Plan keys and titles first. Reserve blank DRAFTs, then generate each item one at a time with the key and title locked."
                    onClose={() => setBatchPlan(null)}
                    wide
                    footer={(
                        <div className="strpg-row end">
                            <Button onClick={() => setBatchPlan(null)}>Cancel</Button>
                            <Button variant="ghost" onClick={addPlanRow}>Add row</Button>
                            <Button variant="gold" onClick={createBatch} disabled={!batchPlan.items.length}>Create batch</Button>
                        </div>
                    )}
                >
                    <div className="strpg-batch-plan">
                        <div className="strpg-batch-plan-context">
                            <Field label="Asset kind">
                                <Select value={batchPlan.kind} onChange={(event) => setBatchPlan({ ...batchPlan, kind: event.target.value })}>
                                    {planRole.allowedKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                                </Select>
                            </Field>
                            <Field label="How many">
                                <Input type="number" min="1" max="12" value={batchPlan.count} onChange={(event) => setBatchPlan({ ...batchPlan, count: Number(event.target.value) })} />
                            </Field>
                            <Field label="Theme / constraint" className="strpg-batch-plan-theme">
                                <Input value={batchPlan.theme} onChange={(event) => setBatchPlan({ ...batchPlan, theme: event.target.value })} placeholder="e.g. the missing sigil, level 3, Mistfall Town" />
                            </Field>
                        </div>
                        <div className="strpg-row">
                            <Button variant="gold" onClick={runBatchPlan} disabled={planBusy}>{planBusy ? 'Planning…' : 'Plan with AI'}</Button>
                            <span className="strpg-muted">The model returns only key | title | brief lines; no assets are written yet.</span>
                        </div>
                        {planBusy && <Loading label="Planning batch keys and titles…" />}
                        <ErrorBox error={planError} />
                        <div className="strpg-batch-plan-list">
                            {batchPlan.items.map((item) => (
                                <div className="strpg-batch-plan-row" key={item.id}>
                                    <Input value={item.key} onChange={(event) => updatePlanItem(item.id, 'key', event.target.value)} placeholder="key" />
                                    <Input value={item.title} onChange={(event) => updatePlanItem(item.id, 'title', event.target.value)} placeholder="Title" />
                                    <Textarea rows={2} value={item.brief} onChange={(event) => updatePlanItem(item.id, 'brief', event.target.value)} placeholder="One-sentence brief" />
                                    <Button size="sm" variant="ghost" onClick={() => removePlanRow(item.id)}>×</Button>
                                </div>
                            ))}
                            {!batchPlan.items.length && !planBusy && <span className="strpg-muted">Plan with AI, or add rows manually. One row becomes one asset.</span>}
                        </div>
                    </div>
                </Modal>
            )}

            {promptRole && (
                <Modal
                    title={`${promptRole.name} guidance`}
                    subtitle="This is appended before the shared memory, blackboard and output contract. Keep it about responsibility and constraints, not a full example."
                    onClose={() => setPromptRoleId(null)}
                    wide
                    footer={(
                        <div className="strpg-row end">
                            <Button onClick={() => setPromptRoleId(null)}>Cancel</Button>
                            <Button variant="ghost" onClick={() => setPromptDraft(promptRole.systemPrompt)}>Reset to built-in</Button>
                            <Button variant="gold" onClick={savePrompt}>Save guidance</Button>
                        </div>
                    )}
                >
                    <Field label="Role guidance">
                        <Textarea rows={14} value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} />
                    </Field>
                </Modal>
            )}

            {genSeed && (
                <GenerateAssetModal
                    open
                    project={project}
                    projectId={projectId}
                    assets={assets}
                    selected={null}
                    initialKind={genSeed.kind}
                    initialPrompt={genSeed.prompt}
                    initialReferences={genSeed.references}
                    spoilerTerms={genSeed.spoilerTerms}
                    keyOverride={genSeed.keyOverride ?? ''}
                    nameOverride={genSeed.nameOverride ?? ''}
                    onClose={() => setGenSeed(null)}
                    onSaved={async (created) => {
                        if (genSeed.batchId) {
                            await handleBatchSaved(created);
                        } else {
                            await onRefresh?.();
                            setGenSeed(null);
                        }
                    }}
                    notify={notify}
                />
            )}
        </div>
    );
}
