import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Empty, ErrorBox, Loading, SectionTitle } from '../ui.jsx';

export function Skills({ campaignId, revision }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('all');

    const load = async () => {
        if (!campaignId) return;
        setError(null);
        try {
            setData(await api(`/campaigns/${campaignId}/skills`));
        } catch (err) {
            setError(err);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!campaignId) return <Empty title="No Campaign selected" icon="✦" />;
    if (!data && !error) return <Loading label="Loading skills..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    const skills = data.all.filter((skill) => {
        if (filter === 'active') return skill.category === 'active';
        if (filter === 'passive') return skill.category === 'passive';
        if (filter === 'unlocked') return skill.unlocked;
        return true;
    });
    return (
        <div className="strpg-skills">
            <SectionTitle
                eyebrow="SKILLS"
                title="Skills and Class Tree"
                description={`Class: ${data.classKey ?? 'unknown'} · Unlocked ${data.unlocked.length} / ${data.all.length}`}
                actions={(
                    <div className="strpg-chip-row">
                        {[['all', 'All'], ['active', 'Active'], ['passive', 'Passive'], ['unlocked', 'Unlocked']].map(([value, label]) => (
                            <button type="button" className={`strpg-chip ${filter === value ? 'active' : ''}`} key={value} onClick={() => setFilter(value)}>{label}</button>
                        ))}
                    </div>
                )}
            />
            <div className="strpg-skill-grid">
                {skills.map((skill) => (
                    <article className={`strpg-skill-card ${skill.unlocked ? 'unlocked' : 'locked'} element-${skill.element}`} key={skill.key}>
                        <div className="strpg-skill-head">
                            <div className="strpg-skill-glyph">{skill.category === 'passive' ? '◈' : skill.element === 'fire' ? 'F' : skill.element === 'holy' ? 'H' : '✦'}</div>
                            <div>
                                <strong>{skill.name}</strong>
                                <span>{skill.category} · {skill.target}</span>
                            </div>
                            <Badge tone={skill.unlocked ? 'success' : 'neutral'}>{skill.unlocked ? 'Unlocked' : `Lv.${skill.unlockLevel}`}</Badge>
                        </div>
                        <p>{skill.description}</p>
                        <div className="strpg-skill-meta">
                            <span>MP {skill.mpCost ?? 0}</span>
                            <span>CD {skill.cooldown ?? 0}</span>
                            <span>{skill.element}</span>
                            <span>Power {skill.power ?? 0}</span>
                        </div>
                        {skill.formula && <code className="strpg-formula">{skill.formula}</code>}
                        {skill.passive?.modifiers && (
                            <div className="strpg-row wrap">
                                {Object.entries(skill.passive.modifiers).map(([key, value]) => <Badge key={key} tone="info">{key} +{value}</Badge>)}
                            </div>
                        )}
                        {skill.effects?.applyStatus && <span className="strpg-muted">Status effect: {skill.effects.applyStatus.effectKey}({(Number(skill.effects.applyStatus.chance) * 100).toFixed(0)}%)</span>}
                    </article>
                ))}
            </div>
            {!skills.length && <Empty title="No matching skills" icon="✦" />}
        </div>
    );
}



