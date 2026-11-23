import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Textarea } from '../ui.jsx';

const W = 1180;
const H = 680;

function nodePosition(kind, node, index) {
    if (kind === 'story') return { x: Number(node.map?.x ?? 80 + index * 210), y: Number(node.map?.y ?? 100) };
    return { x: Number(node.x ?? 80 + index * 210), y: Number(node.y ?? 100) };
}

function withPosition(kind, node, x, y) {
    if (kind === 'story') return { ...node, map: { ...(node.map ?? {}), x, y } };
    return { ...node, x, y };
}

function normalizeEdges(kind, data) {
    return (data.edges ?? []).map((edge, index) => ({
        ...edge,
        key: edge.key ?? edge.id ?? `${kind}_edge_${index}`,
        from: edge.from ?? edge.source,
        to: edge.to ?? edge.target,
    })).filter((edge) => edge.from && edge.to);
}

export function NodeGraphEditor({ asset, onApply, onNewRevision, notify }) {
    const kind = asset.kind;
    const editable = asset.status === 'DRAFT';
    const [nodes, setNodes] = useState([]);
    const [edges, setEdges] = useState([]);
    const [selected, setSelected] = useState(null);
    const [selectedEdge, setSelectedEdge] = useState(null);
    const [connectFrom, setConnectFrom] = useState(null);
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
    const [drag, setDrag] = useState(null);
    const [pan, setPan] = useState(null);
    const [busy, setBusy] = useState(false);
    const [validation, setValidation] = useState(null);
    const svgRef = useRef(null);

    useEffect(() => {
        setNodes((asset.data.nodes ?? []).map((node, index) => ({ ...node, key: node.key ?? node.id ?? `node_${index}` })));
        setEdges(normalizeEdges(kind, asset.data));
        setSelected(null);
        setSelectedEdge(null);
        setConnectFrom(null);
        setValidation(null);
    }, [asset.id, asset.revision, asset.data, kind]); // eslint-disable-line react-hooks/exhaustive-deps

    const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.key, node])), [nodes]);
    const displayEdges = useMemo(() => {
        const seen = new Map();
        const output = [];
        for (const edge of edges) {
            const pair = [edge.from, edge.to].sort().join('|');
            if (seen.has(pair)) { seen.get(pair).bidirectional = true; continue; }
            const entry = { ...edge, bidirectional: Boolean(edge.bidirectional) };
            seen.set(pair, entry);
            output.push(entry);
        }
        return output;
    }, [edges]);
    const selectedNode = selected ? nodeMap.get(selected) : null;
    const selectedEdgeData = selectedEdge ? edges.find((edge) => edge.key === selectedEdge) : null;

    const point = (event) => {
        const rect = svgRef.current.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * W;
        const y = ((event.clientY - rect.top) / rect.height) * H;
        return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale };
    };

    const updateNode = (key, patch) => setNodes((current) => current.map((node) => node.key === key ? { ...node, ...patch } : node));
    const updateEdge = (key, patch) => setEdges((current) => current.map((edge) => edge.key === key ? { ...edge, ...patch } : edge));
    const moveNode = (key, x, y) => setNodes((current) => current.map((node) => node.key === key ? withPosition(kind, node, Math.max(20, x), Math.max(20, y)) : node));

    const onNodeDown = (event, node) => {
        event.stopPropagation();
        event.preventDefault();
        if (!editable) return;
        const position = nodePosition(kind, node, 0);
        setDrag({ key: node.key, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, moved: false });
        setSelected(node.key);
        svgRef.current?.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event) => {
        if (drag && drag.key) {
            const dx = (event.clientX - drag.startX) / view.scale;
            const dy = (event.clientY - drag.startY) / view.scale;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
            moveNode(drag.key, drag.x + dx, drag.y + dy);
        } else if (pan) {
            setView((current) => ({ ...current, x: pan.x + event.clientX - pan.startX, y: pan.y + event.clientY - pan.startY }));
        }
    };

    const onPointerUp = () => {
        setDrag(null);
        setPan(null);
    };

    const onCanvasDown = (event) => {
        if (event.target.closest?.('.strpg-graph-node')) return;
        event.preventDefault();
        setPan({ startX: event.clientX, startY: event.clientY, x: view.x, y: view.y });
        setSelected(null);
        svgRef.current?.setPointerCapture?.(event.pointerId);
    };

    const addNode = () => {
        if (!editable) return;
        const key = `node_${Date.now().toString(36)}`;
        const node = kind === 'story'
            ? { key, title: 'New Story Node', type: 'scene', text: '', map: { x: 120, y: 120 } }
            : { key, title: 'New Stage', type: 'stage', x: 120, y: 120 };
        setNodes((current) => [...current, node]);
        setSelected(key);
    };

    const deleteNode = (key) => {
        if (!editable) return;
        setNodes((current) => current.filter((node) => node.key !== key));
        setEdges((current) => current.filter((edge) => edge.from !== key && edge.to !== key));
        setSelected(null);
        setSelectedEdge(null);
    };

    const connect = (targetKey) => {
        if (!editable) return;
        if (!connectFrom) {
            setConnectFrom(targetKey);
            return;
        }
        if (connectFrom === targetKey) {
            setConnectFrom(null);
            return;
        }
        const key = `${kind}_edge_${Date.now().toString(36)}`;
        setEdges((current) => [...current, { key, from: connectFrom, to: targetKey, label: '', condition: {}, actions: [] }]);
        setConnectFrom(null);
    };

    const autoLayout = () => {
        if (!editable) return;
        const start = asset.data.startNodeKey ?? nodes[0]?.key;
        const levels = new Map();
        const queue = start ? [[start, 0]] : [];
        while (queue.length) {
            const [key, level] = queue.shift();
            if (levels.has(key)) continue;
            levels.set(key, level);
            for (const edge of edges.filter((entry) => entry.from === key)) queue.push([edge.to, level + 1]);
        }
        let fallback = 0;
        const byLevel = new Map();
        for (const node of nodes) {
            const level = levels.has(node.key) ? levels.get(node.key) : 6 + fallback++;
            const list = byLevel.get(level) ?? [];
            list.push(node.key);
            byLevel.set(level, list);
        }
        setNodes((current) => current.map((node) => {
            const level = levels.has(node.key) ? levels.get(node.key) : 6;
            const index = byLevel.get(level)?.indexOf(node.key) ?? 0;
            return withPosition(kind, node, 80 + level * 250, 80 + index * 130);
        }));
    };

    const apply = async () => {
        setBusy(true);
        try {
            const data = { ...asset.data, nodes, edges };
            await onApply(data);
            notify?.('Graph saved to DRAFT.', 'success');
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const validate = async () => {
        setBusy(true);
        try {
            const result = await onApply({ ...asset.data, nodes, edges }, { validate: true });
            setValidation(result?.validation ?? null);
            notify?.('Validation complete.', result?.validation?.valid ? 'success' : 'warning');
        } catch (error) {
            setValidation(error.details ?? null);
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const errorPaths = new Set((validation?.errors ?? []).map((entry) => entry.path));
    const nodeHasError = (node, index) => [...errorPaths].some((path) => path.includes(`nodes.${index}`) || path === 'nodes' || path.includes(node.key));

    return (
        <div className="strpg-graph-editor">
            <div className="strpg-graph-toolbar editor">
                <Button size="sm" onClick={addNode} disabled={!editable}>+ Node</Button>
                <Button size="sm" variant={connectFrom ? 'gold' : 'default'} onClick={() => setConnectFrom(null)} disabled={!editable}>
                    {connectFrom ? `Connecting: ${connectFrom} (click a target)` : 'Connect: click two nodes'}
                </Button>
                <Button size="sm" onClick={autoLayout} disabled={!editable}>Auto Layout</Button>
                <Button size="sm" onClick={validate} disabled={busy}>{busy ? '…' : 'Validation'}</Button>
                <Button size="sm" variant="gold" onClick={apply} disabled={!editable || busy}>Save Graph</Button>
                {!editable && <Button size="sm" variant="gold" onClick={onNewRevision}>New Revision</Button>}
                <div className="strpg-graph-zoom">
                    <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.min(2, current.scale + 0.1) }))}>+</button>
                    <span>{Math.round(view.scale * 100)}%</span>
                    <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.max(0.4, current.scale - 0.1) }))}>-</button>
                </div>
            </div>
            <div className="strpg-graph-workbench">
                <div className="strpg-graph-stage">
                    <svg
                        ref={svgRef}
                        viewBox={`0 0 ${W} ${H}`}
                        className="strpg-graph-svg"
                        onWheel={(event) => {
                            event.preventDefault();
                            setView((current) => ({ ...current, scale: Math.max(0.4, Math.min(2, current.scale + (event.deltaY > 0 ? -0.08 : 0.08))) }));
                        }}
                        onPointerDown={onCanvasDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    >
                        <defs>
                            <pattern id="strpg-graph-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(160,190,210,.07)" strokeWidth="1" />
                            </pattern>
                            <marker id="strpg-graph-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                                <path d="M0,0 L0,6 L9,3 z" fill="rgba(224,184,92,.8)" />
                            </marker>
                            <marker id="strpg-graph-arrow-start" markerWidth="10" markerHeight="10" refX="1" refY="3" orient="auto">
                                <path d="M0,0 L0,6 L9,3 z" fill="rgba(88,166,166,.85)" />
                            </marker>
                        </defs>
                        <rect width={W} height={H} fill="#0b1119" />
                        <rect width={W} height={H} fill="url(#strpg-graph-grid)" />
                        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                            {displayEdges.map((edge) => {
                                const from = nodeMap.get(edge.from);
                                const to = nodeMap.get(edge.to);
                                if (!from || !to) return null;
                                const a = nodePosition(kind, from, nodes.indexOf(from));
                                const b = nodePosition(kind, to, nodes.indexOf(to));
                                return (
                                    <g key={edge.key}>
                                        <path d={`M${a.x + 88},${a.y + 26} C${a.x + 170},${a.y + 26} ${b.x - 70},${b.y + 26} ${b.x},${b.y + 26}`} className={`strpg-graph-edge ${edge.bidirectional ? 'bidirectional' : 'oneway'}`} markerEnd="url(#strpg-graph-arrow)" markerStart={edge.bidirectional ? 'url(#strpg-graph-arrow-start)' : undefined} />
                                        {edge.label && <text x={(a.x + b.x) / 2 + 88} y={(a.y + b.y) / 2 + 12} className="strpg-graph-edge-label">{edge.label}</text>}
                                    </g>
                                );
                            })}
                            {nodes.map((node, index) => {
                                const position = nodePosition(kind, node, index);
                                return (
                                    <g
                                        key={node.key}
                                        className={`strpg-graph-node ${node.key === selected ? 'selected' : ''} ${node.key === asset.data.startNodeKey ? 'start' : ''} ${connectFrom === node.key ? 'connecting' : ''} ${nodeHasError(node, index) ? 'error' : ''}`}
                                        transform={`translate(${position.x} ${position.y})`}
                                        onPointerDown={(event) => onNodeDown(event, node)}
                                        onClick={(event) => { event.stopPropagation(); if (connectFrom) connect(node.key); else { setSelected(node.key); setSelectedEdge(null); } }}
                                    >
                                        <rect width="176" height="52" rx="8" />
                                        <text x="12" y="21" className="strpg-graph-node-title">{node.title ?? node.key}</text>
                                        <text x="12" y="38" className="strpg-graph-node-sub">{node.type ?? kind} · {node.key}</text>
                                    </g>
                                );
                            })}
                        </g>
                    </svg>
                    {!editable && <div className="strpg-graph-lock">Published or reviewed content is read-only. Create a new revision to edit.</div>}
                </div>
                <aside className="strpg-graph-inspector">
                    {selectedNode ? (
                        <>
                            <div className="strpg-row between">
                                <Badge tone="info">{selectedNode.type ?? kind}</Badge>
                                <div className="strpg-row">
                                    <Button size="sm" variant="ghost" onClick={() => {
                                        if (!editable) return;
                                        const position = nodePosition(kind, selectedNode, 0);
                                        const copy = { ...selectedNode, key: `${selectedNode.key}_copy`, title: `${selectedNode.title ?? selectedNode.key} Copy` };
                                        setNodes((current) => [...current, withPosition(kind, copy, position.x + 36, position.y + 36)]);
                                        setSelected(copy.key);
                                    }} disabled={!editable}>Duplicate</Button>
                                    <Button size="sm" variant="danger" onClick={() => deleteNode(selectedNode.key)} disabled={!editable}>Delete</Button>
                                </div>
                            </div>
                            <Field label="Key"><Input value={selectedNode.key} disabled={!editable} onChange={(event) => {
                                const oldKey = selectedNode.key;
                                const newKey = event.target.value;
                                setNodes((current) => current.map((node) => node.key === oldKey ? { ...node, key: newKey } : node));
                                setEdges((current) => current.map((edge) => ({
                                    ...edge,
                                    from: edge.from === oldKey ? newKey : edge.from,
                                    to: edge.to === oldKey ? newKey : edge.to,
                                })));
                                setSelected(newKey);
                            }} /></Field>
                            <Field label="Title"><Input value={selectedNode.title ?? ''} disabled={!editable} onChange={(event) => updateNode(selectedNode.key, { title: event.target.value })} /></Field>
                            <Field label="Type">
                                <select className="strpg-select" value={selectedNode.type ?? 'scene'} disabled={!editable} onChange={(event) => updateNode(selectedNode.key, { type: event.target.value })}>
                                    {(kind === 'story' ? ['scene', 'branch', 'event', 'ending'] : ['start', 'stage', 'end', 'branch']).map((type) => <option key={type} value={type}>{type}</option>)}
                                </select>
                            </Field>
                            {kind === 'story' && (
                                <>
                                    <Field label="Scene Key"><Input value={selectedNode.sceneKey ?? ''} disabled={!editable} onChange={(event) => updateNode(selectedNode.key, { sceneKey: event.target.value })} /></Field>
                                    <Field label="Node Text"><Textarea rows={4} value={selectedNode.text ?? ''} disabled={!editable} onChange={(event) => updateNode(selectedNode.key, { text: event.target.value })} /></Field>
                                </>
                            )}
                            <Field label="Condition JSON" hint="Leave empty or {} for no condition">
                                <Textarea key={`${selectedNode.key}-conditions`} rows={3} defaultValue={JSON.stringify(selectedNode.conditions ?? {}, null, 2)} disabled={!editable} onBlur={(event) => {
                                    try { updateNode(selectedNode.key, { conditions: JSON.parse(event.target.value || "{}") }); } catch { notify?.("Condition is not valid JSON", "warning"); }
                                }} />
                            </Field>
                            <Field label="Actions JSON Array">
                                <Textarea key={`${selectedNode.key}-actions`} rows={3} defaultValue={JSON.stringify(selectedNode.actions ?? [], null, 2)} disabled={!editable} onBlur={(event) => {
                                    try { updateNode(selectedNode.key, { actions: JSON.parse(event.target.value || "[]") }); } catch { notify?.("Actions must be a valid JSON array", "warning"); }
                                }} />
                            </Field>
                            <div className="strpg-divider" />
                            <span className="strpg-eyebrow">Outgoing Edges</span>
                            {edges.filter((edge) => edge.from === selectedNode.key).map((edge) => (
                                <div className="strpg-edge-row" key={edge.key}>
                                    <span>→ {edge.to}{edge.label ? ` · ${edge.label}` : ''}</span>
                                    <div className="strpg-row">
                                        <Button size="sm" variant={selectedEdge === edge.key ? 'gold' : 'ghost'} onClick={() => setSelectedEdge(edge.key)}>Edit</Button>
                                        <Button size="sm" variant="ghost" onClick={() => { setEdges((current) => current.filter((entry) => entry.key !== edge.key)); setSelectedEdge(null); }} disabled={!editable}>Delete</Button>
                                    </div>
                                </div>
                            ))}
                            {selectedEdgeData && (
                                <div className="strpg-edge-editor">
                                    <div className="strpg-row between"><strong>Edge {selectedEdgeData.key}</strong><Badge tone="info">{selectedEdgeData.from} → {selectedEdgeData.to}</Badge></div>
                                    <Field label="Display Label"><Input value={selectedEdgeData.label ?? ''} disabled={!editable} onChange={(event) => updateEdge(selectedEdgeData.key, { label: event.target.value })} /></Field>
                                    <Field label="Edge Condition JSON">
                                        <Textarea key={`${selectedEdgeData.key}-condition`} rows={3} defaultValue={JSON.stringify(selectedEdgeData.condition ?? {}, null, 2)} disabled={!editable} onBlur={(event) => {
                                            try { updateEdge(selectedEdgeData.key, { condition: JSON.parse(event.target.value || '{}') }); } catch { notify?.('Edge condition is not valid JSON', 'warning'); }
                                        }} />
                                    </Field>
                                    <Field label="Edge Actions JSON">
                                        <Textarea key={`${selectedEdgeData.key}-actions`} rows={3} defaultValue={JSON.stringify(selectedEdgeData.actions ?? [], null, 2)} disabled={!editable} onBlur={(event) => {
                                            try { updateEdge(selectedEdgeData.key, { actions: JSON.parse(event.target.value || '[]') }); } catch { notify?.('Edge actions must be a valid JSON array', 'warning'); }
                                        }} />
                                    </Field>
                                    <label className="strpg-checkbox">
                                        <input type="checkbox" checked={Boolean(selectedEdgeData.manual)} disabled={!editable} onChange={(event) => updateEdge(selectedEdgeData.key, { manual: event.target.checked })} />
                                        Manual choice (does not auto-advance)
                                    </label>
                                </div>
                            )}
                        </>
                    ) : <div className="strpg-graph-help"><span className="strpg-eyebrow">NODE GRAPH</span><p>Drag nodes to move the layout; drag empty space to pan; scroll to zoom. Click Connect, then click two nodes to create an edge.</p><p>Layout coordinates are display-only. Story and quest connectivity is determined by real edges.</p></div>}
                    {validation && (
                        <div className="strpg-validation">
                            <Badge tone={validation.valid ? 'success' : 'danger'}>{validation.valid ? 'Validation Passed' : `${validation.errors?.length ?? 0}  errors`}</Badge>
                            {(validation.errors ?? []).map((entry, index) => <div key={index} className="strpg-validation-row"><code>{entry.path}</code><span>{entry.message}</span></div>)}
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}



