import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { assetTemplate } from '../assetTemplates.js';
import { Button, Field, Input, Modal } from '../ui.jsx';

const BASE_RANGES = {
    maxHp: [40, 300, 5], maxMp: [0, 200, 5],
    str: [1, 30, 1], agi: [1, 30, 1], int: [1, 30, 1], vit: [1, 30, 1], luck: [1, 30, 1],
};
const GROWTH_RANGES = {
    maxHp: [0, 30, 1], maxMp: [0, 10, 1],
    str: [0, 5, 0.1], agi: [0, 5, 0.1], int: [0, 5, 0.1], vit: [0, 5, 0.1], luck: [0, 5, 0.1],
};

function Slider({ label, value, range, onChange, suffix = '' }) {
    const [min, max, step] = range;
    return (
        <label className="strpg-slider-field">
            <span><strong>{label}</strong><em>{value}{suffix}</em></span>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={(event) => onChange(Number(event.target.value))}
            />
            <small>{min} – {max}</small>
        </label>
    );
}

export function ClassBuilder({ open, projectId, onClose, onSaved, notify }) {
    const initial = useMemo(() => assetTemplate('class'), []);
    const [name, setName] = useState(initial.name);
    const [description, setDescription] = useState(initial.description);
    const [baseStats, setBaseStats] = useState({ ...initial.baseStats });
    const [growth, setGrowth] = useState({ ...initial.growth });
    const [startingItems, setStartingItems] = useState('');
    const [startingSkills, setStartingSkills] = useState('');
    const [skillTree, setSkillTree] = useState('');
    const [busy, setBusy] = useState(false);
    if (!open) return null;

    const derived = {
        atk: baseStats.str, mag: baseStats.int,
        def: Math.floor(baseStats.vit * 0.8), res: Math.floor(baseStats.vit * 0.4),
        hit: 80 + baseStats.agi * 2, evade: Math.floor(baseStats.agi * 1.5), crit: 5 + baseStats.luck * 0.5,
    };
    const basePower = Math.round(baseStats.maxHp / 10 + baseStats.maxMp / 10 + baseStats.str + baseStats.agi + baseStats.int + baseStats.vit + baseStats.luck);
    const growthPower = Math.round(growth.maxHp + growth.maxMp + (growth.str + growth.agi + growth.int + growth.vit + growth.luck) * 5);
    const parseList = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const parseTree = (value) => parseList(value).map((entry) => {
        const [level, skillKey] = entry.split(':').map((part) => part.trim());
        return { level: Number(level), skillKey };
    }).filter((entry) => entry.level > 0 && entry.skillKey);

    const save = async () => {
        setBusy(true);
        try {
            const data = {
                ...initial,
                key: initial.key,
                name: name.trim() || 'New Class',
                description,
                baseStats,
                growth,
                startingItems: parseList(startingItems).map((itemKey) => ({ itemKey, quantity: 1 })),
                startingSkills: parseList(startingSkills),
                skillTree: parseTree(skillTree),
            };
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST', body: { kind: 'class', data, name: data.name },
            });
            notify(created.validation?.valid ? 'Class DRAFT created and schema-validated.' : 'Class DRAFT created; check validation errors.', created.validation?.valid ? 'success' : 'warning');
            onSaved?.(created);
            onClose?.();
        } catch (error) {
            notify(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            title="Class Builder"
            subtitle="Slider-based class tuning. Server-side ranges prevent invalid values; save remains DRAFT."
            onClose={onClose}
            wide
            footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="gold" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Create Class DRAFT'}</Button></>}
        >
            <div className="strpg-class-builder">
                <div className="strpg-class-meta">
                    <Field label="Class name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
                    <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
                </div>
                <div className="strpg-class-columns">
                    <section>
                        <span className="strpg-eyebrow">BASE STATS · LEVEL 1</span>
                        {Object.entries(BASE_RANGES).map(([key, range]) => (
                            <Slider key={key} label={key} value={baseStats[key]} range={range} onChange={(value) => setBaseStats((current) => ({ ...current, [key]: value }))} />
                        ))}
                        <div className={basePower > 80 ? 'strpg-budget warn' : 'strpg-budget'}>Base power: {basePower} / recommended ≤ 80</div>
                    </section>
                    <section>
                        <span className="strpg-eyebrow">GROWTH · PER LEVEL</span>
                        {Object.entries(GROWTH_RANGES).map(([key, range]) => (
                            <Slider key={key} label={key} value={growth[key]} range={range} onChange={(value) => setGrowth((current) => ({ ...current, [key]: value }))} stepSuffix="" />
                        ))}
                        <div className={growthPower > 60 ? 'strpg-budget warn' : 'strpg-budget'}>Growth power: {growthPower} / recommended ≤ 60</div>
                    </section>
                </div>
                <div className="strpg-derived">
                    <span className="strpg-eyebrow">DERIVED PREVIEW</span>
                    {Object.entries(derived).map(([key, value]) => <span key={key}><strong>{key.toUpperCase()}</strong>{Number.isInteger(value) ? value : value.toFixed(1)}</span>)}
                </div>
                <div className="strpg-class-content">
                    <Field label="Starting items" hint="Comma-separated item keys, for example iron_sword, healing_herb">
                        <Input value={startingItems} onChange={(event) => setStartingItems(event.target.value)} placeholder="iron_sword, healing_herb" />
                    </Field>
                    <Field label="Starting skills" hint="Comma-separated skill keys">
                        <Input value={startingSkills} onChange={(event) => setStartingSkills(event.target.value)} placeholder="power_strike, heal" />
                    </Field>
                    <Field label="Skill tree notes" hint="Format level:skillKey, comma-separated. Runtime currently unlocks via Skill.unlockLevel/classes.">
                        <Input value={skillTree} onChange={(event) => setSkillTree(event.target.value)} placeholder="3:fireball, 5:iron_will" />
                    </Field>
                </div>
            </div>
        </Modal>
    );
}
