import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
    AI_KINDS, AI_KIND_LABELS, AI_PRESETS, AI_TONES, buildGenerationPrompt, clone,
    extractJsonObject, generatedContentWarnings, normalizeGeneratedAsset, summarizeGeneratedAsset,
} from '../aiPresets.js';
import { describeGenerationTarget, generateQuiet, hasGeneration } from '../llm.js';
import { findSpoilerTerms } from '../directorRoles.js';
import { Badge, Button, ErrorBox, Field, Input, Loading, Modal, Select, Textarea } from '../ui.jsx';

const DEFAULT_PRESET = (kind) => AI_PRESETS[kind]?.[0] ?? null;

/**
 * The Workbench's AI content interface.
 *
 * create + blank: make a new DRAFT.
 * improve: generate from the selected asset and apply the result to the open editor.
 */
export function GenerateAssetModal({
    open, project, projectId, assets = [], selected = null, initialKind = 'npc',
    initialPrompt = '', initialReferences = '', spoilerTerms = [], keyOverride = '', nameOverride = '',
    onClose, onSaved, onApply, notify,
}) {
    const mode = selected ? 'improve' : 'create';
    const scenes = useMemo(() => assets.filter((asset) => asset.kind === 'scene'), [assets]);
    const defaultSceneKey = useMemo(() => {
        if (selected?.kind === 'scene') return selected.data?.key ?? null;
        return scenes.find((scene) => scene.data?.isSpawn)?.data?.key ?? scenes[0]?.data?.key ?? null;
    }, [scenes, selected]);

    const [kind, setKind] = useState(initialKind);
    const [presetId, setPresetId] = useState(DEFAULT_PRESET(initialKind)?.id ?? '');
    const [prompt, setPrompt] = useState(DEFAULT_PRESET(initialKind)?.prompt ?? '');
    const [tone, setTone] = useState('heroic');
    const [level, setLevel] = useState(1);
    const [locationKey, setLocationKey] = useState(defaultSceneKey ?? '');
    const [references, setReferences] = useState('');
    const [data, setData] = useState(null);
    const [jsonText, setJsonText] = useState('');
    const [rawReply, setRawReply] = useState('');
    const [panel, setPanel] = useState('preview');
    const [busy, setBusy] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [startedAt, setStartedAt] = useState(0);
    const [error, setError] = useState(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);

    const presets = AI_PRESETS[kind] ?? [];
    const preset = presets.find((entry) => entry.id === presetId) ?? null;
    const kindMeta = AI_KINDS.find(([value]) => value === kind);
    const spoilerHits = useMemo(() => (data ? findSpoilerTerms(JSON.stringify(data), spoilerTerms) : []), [data, spoilerTerms]);
    const warnings = useMemo(() => {
        const base = data ? generatedContentWarnings(kind, data) : [];
        if (data && spoilerHits.length) base.push(`This asset may reveal protected spoiler terms: ${spoilerHits.join(', ')}.`);
        return base;
    }, [data, kind, spoilerHits]);
    const summary = useMemo(() => (data ? summarizeGeneratedAsset(kind, data) : []), [data, kind]);

    const resetForKind = (nextKind) => {
        const nextPreset = DEFAULT_PRESET(nextKind);
        setKind(nextKind);
        setPresetId(nextPreset?.id ?? '');
        setPrompt(nextPreset?.prompt ?? '');
        setData(null);
        setJsonText('');
        setRawReply('');
        setPanel('preview');
        setError(null);
    };

    useEffect(() => {
        if (!open) return;
        if (selected) {
            setKind(selected.kind);
            setPresetId(DEFAULT_PRESET(selected.kind)?.id ?? '');
            setPrompt(DEFAULT_PRESET(selected.kind)?.prompt ?? '');
            setData(clone(selected.data));
            setJsonText(JSON.stringify(selected.data, null, 2));
            setLevel(Number(selected.data?.level ?? 1));
            setLocationKey(selected.data?.locationKey ?? selected.data?.sceneKey ?? defaultSceneKey ?? '');
            setRawReply('');
            setPanel('preview');
            setError(null);
            return;
        }
        const nextKind = initialKind ?? 'npc';
        const nextPreset = DEFAULT_PRESET(nextKind);
        setKind(nextKind);
        setPresetId(nextPreset?.id ?? '');
        setPrompt(initialPrompt?.trim() ? initialPrompt : (nextPreset?.prompt ?? ''));
        setReferences(initialReferences ?? '');
        setData(null);
        setJsonText('');
        setRawReply('');
        setPanel('preview');
        setError(null);
        setLocationKey(defaultSceneKey ?? '');
    }, [open, selected?.id, initialKind, initialPrompt, initialReferences, defaultSceneKey]);

    useEffect(() => {
        if (!busy) return undefined;
        const timer = setInterval(() => {
            setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        }, 1000);
        return () => clearInterval(timer);
    }, [busy, startedAt]);

    if (!open) return null;

    const compilePrompt = () => buildGenerationPrompt({
        kind,
        preset,
        prompt,
        context: {
            tone,
            level: Number(level) || 1,
            locationKey: locationKey || null,
            parentKey: kind === 'scene' ? locationKey || null : null,
            references,
            worldName: project?.world?.name ?? project?.name,
            worldDescription: project?.world?.description,
            sceneKeys: scenes.map((scene) => scene.data?.key).filter(Boolean),
            existing: mode === 'improve' ? data : undefined,
        },
    });

    const run = async () => {
        setBusy(true);
        setError(null);
        setStartedAt(Date.now());
        setElapsed(0);
        try {
            if (!hasGeneration()) throw new Error('SillyTavern generation is unavailable in this context. Open STRPG from SillyTavern, not a static preview.');
            const compiled = compilePrompt();
            const reply = await generateQuiet(compiled, { responseLength: kind === 'story' ? 2400 : 1800 });
            const raw = extractJsonObject(reply);
            const normalized = normalizeGeneratedAsset(kind, raw, {
                context: { level: Number(level) || 1, locationKey, parentKey: kind === 'scene' ? locationKey : null },
                assets,
                lockedKey: keyOverride,
                lockedName: nameOverride,
            });
            setData(normalized.data);
            setJsonText(JSON.stringify(normalized.data, null, 2));
            setRawReply(String(reply));
            setPanel('preview');
            notify?.(`${kindMeta?.[1] ?? kind} generated. Review the JSON, then create a DRAFT.`, 'success');
        } catch (caught) {
            setError(caught);
        } finally {
            setBusy(false);
        }
    };

    const startBlank = () => {
        const template = normalizeGeneratedAsset(kind, {}, {
            context: { level: Number(level) || 1, locationKey, parentKey: kind === 'scene' ? locationKey : null },
            assets,
            lockedKey: keyOverride,
            lockedName: nameOverride,
        });
        setData(template.data);
        setJsonText(JSON.stringify(template.data, null, 2));
        setRawReply('');
        setPanel('json');
        setError(null);
    };

    const applyJson = () => {
        try {
            const parsed = JSON.parse(jsonText);
            const normalized = normalizeGeneratedAsset(kind, parsed, {
                context: { level: Number(level) || 1, locationKey, parentKey: kind === 'scene' ? locationKey : null },
                assets,
                lockedKey: keyOverride,
                lockedName: nameOverride,
            });
            setData(normalized.data);
            setJsonText(JSON.stringify(normalized.data, null, 2));
            notify?.('JSON applied to the preview.', 'success');
        } catch (caught) {
            setError(caught);
        }
    };

    const commit = async () => {
        if (!data) return;
        if (spoilerHits.length) {
            setError(new Error(`This content still contains protected spoiler terms: ${spoilerHits.join(', ')}`));
            return;
        }
        if (mode === 'improve') {
            onApply?.(clone(data));
            onClose?.();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST',
                body: { kind, data, name: data.name, note: 'Generated in Workbench AI' },
            });
            notify?.(`Created DRAFT ${kind}/${data.key}. Validate it before publishing.`, 'success');
            onSaved?.(created);
            onClose?.();
        } catch (caught) {
            setError(caught);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title={mode === 'improve' ? `AI Rewrite · ${selected.data?.name ?? selected.name}` : 'Create Content with AI'}
            subtitle={`Prompt, preset and world context are sent to ${describeGenerationTarget()}. The model only proposes; the DRAFT must still be validated and reviewed.`}
            onClose={onClose}
            wide
            className="strpg-gen-modal"
            footer={(
                <div className="strpg-row end">
                    <span className="strpg-gen-footnote">{data ? `${data.key} · ${AI_KIND_LABELS[kind] ?? kind}` : 'No content generated yet'}</span>
                    <Button onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="gold" onClick={commit} disabled={busy || !data || spoilerHits.length > 0} title={spoilerHits.length ? 'Remove protected spoiler terms before creating the DRAFT.' : ''}>
                        {mode === 'improve' ? 'Apply to Editor' : 'Create DRAFT'}
                    </Button>
                </div>
            )}
        >
            <div className="strpg-gen-layout">
                <aside className="strpg-gen-side">
                    <div className="strpg-eyebrow">CONTENT TYPE</div>
                    <div className="strpg-gen-kinds">
                        {AI_KINDS.map(([value, label, icon]) => (
                            <button
                                key={value}
                                type="button"
                                className={kind === value ? 'active' : ''}
                                disabled={mode === 'improve' && selected?.kind !== value}
                                onClick={() => resetForKind(value)}
                                title={AI_KINDS.find(([key]) => key === value)?.[3]}
                            >
                                <span>{icon}</span>{label}
                            </button>
                        ))}
                    </div>
                    <div className="strpg-eyebrow strpg-gen-preset-title">PRESET PROMPTS</div>
                    <div className="strpg-gen-presets">
                        {presets.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={presetId === entry.id ? 'active' : ''}
                                onClick={() => { setPresetId(entry.id); setPrompt(entry.prompt); }}
                            >
                                <strong>{entry.label}</strong>
                                <span>{entry.summary}</span>
                            </button>
                        ))}
                        {!presets.length && <span className="strpg-muted">No preset for this type. Write a prompt.</span>}
                    </div>
                </aside>

                <section className="strpg-gen-main">
                    <div className="strpg-gen-context">
                        <Field label="Tone">
                            <Select value={tone} onChange={(event) => setTone(event.target.value)}>
                                {AI_TONES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </Select>
                        </Field>
                        <Field label="Level band">
                            <Input type="number" min="1" max="99" value={level} onChange={(event) => setLevel(Number(event.target.value))} />
                        </Field>
                        <Field label={kind === 'scene' ? 'Parent scene' : 'Anchor scene'}>
                            <Select value={locationKey} onChange={(event) => setLocationKey(event.target.value)}>
                                <option value="">None</option>
                                {scenes.map((scene) => (
                                    <option key={scene.id} value={scene.data?.key}>{scene.data?.name} · {scene.data?.key}</option>
                                ))}
                            </Select>
                        </Field>
                    </div>
                    <Field label="Designer prompt" hint="The preset fills this field. Rewrite it freely; the compiled prompt adds the JSON contract and world context.">
                        <Textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                    </Field>
                    <div className="strpg-row wrap">
                        <Field label="Reference keys" className="strpg-gen-references">
                            <Input value={references} onChange={(event) => setReferences(event.target.value)} placeholder="npc_elder_mira, mistfall_town (optional)" />
                        </Field>
                    </div>
                    <div className="strpg-row wrap">
                        <Button variant="gold" onClick={run} disabled={busy || !prompt.trim()}>
                            {busy ? 'Generating…' : 'Generate with AI'}
                        </Button>
                        <Button onClick={startBlank} disabled={busy}>Blank template</Button>
                        <Button variant="ghost" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? 'Hide' : 'Show'} compiled prompt</Button>
                    </div>
                    {advancedOpen && (
                        <div className="strpg-gen-compiled">
                            <pre>{compilePrompt()}</pre>
                        </div>
                    )}
                    {busy && <Loading label={`Waiting for the model… ${elapsed}s`} />}
                    <ErrorBox error={error} />
                    {data && (
                        <div className="strpg-gen-result">
                            <div className="strpg-gen-tabs">
                                <button type="button" className={panel === 'preview' ? 'active' : ''} onClick={() => setPanel('preview')}>Preview</button>
                                <button type="button" className={panel === 'json' ? 'active' : ''} onClick={() => setPanel('json')}>JSON</button>
                                <span className="strpg-gen-result-key">{data.key}</span>
                                <Badge tone={warnings.length ? 'warning' : 'success'}>{warnings.length ? `${warnings.length} warnings` : 'Ready to draft'}</Badge>
                            </div>
                            {panel === 'preview' ? (
                                <div className="strpg-gen-preview">
                                    <div className="strpg-gen-summary">
                                        {summary.map((row) => (
                                            <div className="strpg-kv" key={row.label}><span>{row.label}</span><strong>{row.value}</strong></div>
                                        ))}
                                    </div>
                                    {warnings.length > 0 && (
                                        <ul className="strpg-gen-warnings">
                                            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
                                        </ul>
                                    )}
                                    {rawReply && (
                                        <details className="strpg-gen-raw">
                                            <summary>Raw model reply</summary>
                                            <pre>{rawReply}</pre>
                                        </details>
                                    )}
                                </div>
                            ) : (
                                <div className="strpg-gen-json">
                                    <Field label="Editable JSON" hint="Fix names, references or numbers, then apply before creating the DRAFT.">
                                        <Textarea rows={18} value={jsonText} onChange={(event) => setJsonText(event.target.value)} />
                                    </Field>
                                    <div className="strpg-row"><Button size="sm" onClick={applyJson}>Apply JSON</Button></div>
                                </div>
                            )}
                        </div>
                    )}
                    {!data && !busy && (
                        <p className="strpg-muted strpg-gen-hint">
                            Pick a type, choose a preset or write a prompt, then generate. The result is reviewable JSON; nothing is written until you press “{mode === 'improve' ? 'Apply to Editor' : 'Create DRAFT'}”. Local models can take a minute or more for a full entry.
                        </p>
                    )}
                </section>
            </div>
        </Modal>
    );
}
