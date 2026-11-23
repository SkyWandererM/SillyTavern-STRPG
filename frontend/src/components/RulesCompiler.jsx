import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { assetTemplate } from '../assetTemplates.js';
import { Button, Field, Modal, Textarea } from '../ui.jsx';

const ALLOWED = new Set(['key', 'name', 'description', 'levelCap', 'startingGold', 'statCaps', 'formulas', 'expTable', 'enemyScaling', 'saveEveryCombatAction']);
const FORMULA_VARS = 'atk, mag, power, def, res, hit, evade, luck, agi, enemyAgi, variance, critMult, elementMult, level';
const SYSTEM = `You convert natural-language game balance requests into STRPG Rules JSON.
Output exactly one JSON object. No markdown fences, no prose.
Allowed keys: key, name, description, levelCap, startingGold, statCaps, formulas, expTable, enemyScaling, saveEveryCombatAction.
levelCap: integer 2-999. startingGold: integer >= 0. statCaps: object of positive numbers.
formulas: object using only these variables: ${FORMULA_VARS}. Allowed functions: min,max,round,floor,ceil,abs,sqrt,pow,clamp. Operators: + - * / % ^ ** and parentheses.
expTable: array of {level, exp}. enemyScaling: {hp, atk}. saveEveryCombatAction: boolean.
Never invent keys, never output code, never use eval. If the request is ambiguous, keep existing defaults and explain via description.`;

function stripFence(text) {
    return String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function validateRules(value) {
    const errors = [];
    const unknown = Object.keys(value).filter((key) => !ALLOWED.has(key));
    if (unknown.length) errors.push(`Unsupported keys: ${unknown.join(', ')}`);
    if (!Number.isInteger(value.levelCap) || value.levelCap < 2 || value.levelCap > 999) errors.push('levelCap must be an integer 2-999');
    if (!Number.isInteger(value.startingGold) || value.startingGold < 0) errors.push('startingGold must be an integer >= 0');
    for (const [key, formula] of Object.entries(value.formulas ?? {})) {
        if (typeof formula !== 'string') errors.push(`formulas.${key} must be a string`);
    }
    for (const [key, cap] of Object.entries(value.statCaps ?? {})) {
        if (!Number.isFinite(Number(cap)) || Number(cap) <= 0) errors.push(`statCaps.${key} must be positive`);
    }
    return errors;
}

export function RulesCompiler({ open, projectId, onClose, onSaved, notify }) {
    const base = useMemo(() => assetTemplate('rules'), []);
    const [natural, setNatural] = useState('Make the frontier harsher: level cap 50, starting gold 120, enemies have 20% more HP, and critical chance is capped at 40%.');
    const [jsonText, setJsonText] = useState(JSON.stringify(base, null, 2));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (!open) return null;

    const compile = async () => {
        setBusy(true);
        setError(null);
        try {
            const ctx = globalThis.SillyTavern?.getContext?.();
            if (!ctx?.generateQuietPrompt) throw new Error('SillyTavern generateQuietPrompt is not available in this context');
            const prompt = `${SYSTEM}\n\nCURRENT RULES:\n${JSON.stringify(base, null, 2)}\n\nREQUEST:\n${natural}\n\nReturn only the complete JSON object.`;
            const reply = await ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: 1200 });
            const parsed = JSON.parse(stripFence(reply));
            const merged = { ...base, ...parsed, key: base.key, name: parsed.name || base.name };
            const errors = validateRules(merged);
            if (errors.length) throw new Error(errors.join('; '));
            setJsonText(JSON.stringify(merged, null, 2));
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const apply = async () => {
        setBusy(true);
        setError(null);
        try {
            const parsed = JSON.parse(jsonText);
            const errors = validateRules(parsed);
            if (errors.length) throw new Error(errors.join('; '));
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST', body: { kind: 'rules', data: parsed, name: parsed.name || parsed.key },
            });
            notify(created.validation?.valid ? 'Rules DRAFT created. Review formulas before publishing.' : 'Rules DRAFT created; validation errors remain.', created.validation?.valid ? 'success' : 'warning');
            onSaved?.(created);
            onClose?.();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            title="Rules Compiler"
            subtitle="Natural language → structured Rules JSON. Nothing is published; the result is a DRAFT that still needs Validation and Review."
            onClose={onClose}
            wide
            footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={compile} disabled={busy}>{busy ? 'Working...' : 'Compile with LLM'}</Button><Button variant="gold" onClick={apply} disabled={busy}>Apply as DRAFT</Button></>}
        >
            <div className="strpg-rules-compiler">
                <Field label="Design request" hint="Describe balance in natural language. The LLM only maps it into the allowed Rules fields.">
                    <Textarea rows={5} value={natural} onChange={(event) => setNatural(event.target.value)} />
                </Field>
                {error && <p className="strpg-error-text">{error}</p>}
                <Field label="Rules JSON preview" hint="You can edit this before applying. Unsupported keys and invalid values are rejected.">
                    <Textarea rows={16} value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} />
                </Field>
                <p className="strpg-muted">
                    Formula variables: {FORMULA_VARS}. Allowed functions: min, max, round, floor, ceil, abs, sqrt, pow, clamp. No eval, no arbitrary code.
                </p>
            </div>
        </Modal>
    );
}
