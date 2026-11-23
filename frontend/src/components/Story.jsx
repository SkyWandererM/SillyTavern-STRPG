import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Loading, SectionTitle } from '../ui.jsx';

export function Story({ campaignId, revision, notify, onMutated }) {
    const [story, setStory] = useState(null);
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [zoom, setZoom] = useState(1);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        if (!campaignId) return;
        setError(null);
        try {
            const data = await api(`/campaigns/${campaignId}/story`);
            setStory(data);
            setSelected(data.current?.key ?? null);
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const graph = story?.graph;
    const bounds = useMemo(() => {
        if (!graph) return { width: 900, height: 480 };
        const xs = graph.nodes.map((node) => Number(node.map?.x ?? 0));
        const ys = graph.nodes.map((node) => Number(node.map?.y ?? 0));
        return {
            width: Math.max(780, Math.max(...xs) + 220),
            height: Math.max(400, Math.max(...ys) + 180),
        };
    }, [graph]);

    const choose = async (edge) => {
        setBusy(true);
        try {
            await api(`/campaigns/${campaignId}/story/choose`, { method: 'POST', body: { edgeKey: edge.key } });
            notify('Story branch advanced.', 'success');
            await load();
            await onMutated?.();
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    if (!campaignId) return <Empty title="No Campaign selected" icon="❖" />;
    if (!story && !error) return <Loading label="Loading story graph..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    const node = graph.nodes.find((entry) => entry.key === selected);
    return (
        <div className="strpg-story">
            <SectionTitle
                eyebrow="STORY GRAPH"
                title={story.name}
                description={story.description}
                actions={<Badge tone={story.ending ? 'success' : 'info'}>{story.ending ? `Ending: ${story.ending.title}` : 'Story in progress'}</Badge>}
            />
            <div className="strpg-story-layout">
                <div className="strpg-graph-panel">
                    <div className="strpg-graph-toolbar">
                        <button type="button" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>+</button>
                        <span>{Math.round(zoom * 100)}%</span>
                        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>-</button>
                    </div>
                    <div className="strpg-graph-scroll">
                        <svg viewBox={`0 0 ${bounds.width} ${bounds.height}`} width={bounds.width * zoom} height={bounds.height * zoom} className="strpg-story-svg">
                            <defs>
                                <marker id="strpg-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                                    <path d="M0,0 L0,6 L9,3 z" fill="rgba(224,184,92,.65)" />
                                </marker>
                            </defs>
                            {graph.edges.map((edge) => {
                                const from = graph.nodes.find((entry) => entry.key === edge.from);
                                const to = graph.nodes.find((entry) => entry.key === edge.to);
                                if (!from || !to) return null;
                                const x1 = Number(from.map?.x ?? 0) + 92;
                                const y1 = Number(from.map?.y ?? 0) + 26;
                                const x2 = Number(to.map?.x ?? 0);
                                const y2 = Number(to.map?.y ?? 0) + 26;
                                return (
                                    <g key={edge.key}>
                                        <path d={`M${x1},${y1} C${x1 + 70},${y1} ${x2 - 70},${y2} ${x2},${y2}`} className="strpg-story-edge" markerEnd="url(#strpg-arrow)" />
                                        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} className="strpg-story-edge-label">{edge.label}</text>
                                    </g>
                                );
                            })}
                            {graph.nodes.map((entry) => (
                                <g
                                    key={entry.key}
                                    transform={`translate(${Number(entry.map?.x ?? 0)} ${Number(entry.map?.y ?? 0)})`}
                                    className={`strpg-story-node ${entry.type} ${entry.key === story.current?.key ? 'current' : ''} ${entry.key === selected ? 'selected' : ''}`}
                                    onClick={() => setSelected(entry.key)}
                                >
                                    <rect width="184" height="52" rx="8" />
                                    <text x="14" y="22" className="strpg-story-node-title">{entry.title}</text>
                                    <text x="14" y="39" className="strpg-story-node-type">{entry.type}{entry.sceneKey ? ` · ${entry.sceneKey}` : ''}</text>
                                    {entry.key === story.current?.key && <circle cx="172" cy="14" r="5" className="strpg-story-current-dot" />}
                                </g>
                            ))}
                        </svg>
                    </div>
                </div>
                <aside className="strpg-story-detail">
                    {node ? (
                        <>
                            <span className="strpg-eyebrow">{node.type}</span>
                            <h3>{node.title}</h3>
                            <p>{node.text}</p>
                            {node.sceneKey && <Badge tone="info">{node.sceneKey}</Badge>}
                            {node.actions?.length > 0 && (
                                <div className="strpg-story-actions">
                                    <span className="strpg-eyebrow">Node Actions</span>
                                    {node.actions.map((action, index) => <code key={index}>{JSON.stringify(action)}</code>)}
                                </div>
                            )}
                            {node.key === story.current?.key && story.state?.ending && <Badge tone="success">Ending Reached</Badge>}
                        </>
                    ) : <Empty title="Select a story node" icon="❖" />}
                    <div className="strpg-divider" />
                    <span className="strpg-eyebrow">Current Location</span>
                    <h4>{story.current?.title}</h4>
                    <p>{story.current?.text}</p>
                    {story.availableEdges?.length > 0 && !story.state?.ending && (
                        <div className="strpg-choices">
                            <span className="strpg-eyebrow">Optional Branches</span>
                            {story.availableEdges.map((edge) => (
                                <button type="button" className="strpg-choice" key={edge.key} disabled={busy} onClick={() => choose(edge)}>
                                    <span>{edge.label}</span><span>›</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {story.state?.ending && (
                        <div className="strpg-ending">
                            <Badge tone="success">ENDING</Badge>
                            <h4>{story.ending?.title}</h4>
                            <p>{story.ending?.text}</p>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}
