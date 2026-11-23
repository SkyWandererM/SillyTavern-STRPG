/**
 * Director's Room authoring roles.
 *
 * Each role owns one content domain and is asked for a natural-language brief.
 * The brief can be sent to the existing Workbench AI generator as its prompt.
 * Role state is persisted in project.metadata.director, so it travels with the
 * Studio project without a schema migration.
 */

export const DIRECTOR_ROLES = [
    {
        id: 'narrator',
        name: 'Narrator',
        icon: '❖',
        owns: 'Story & continuity',
        assetKind: 'story',
        allowedKinds: ['story'],
        nextRole: 'quest-designer',
        description: 'Keeps the memory book, separates what the player knows from what is hidden, and proposes the next story hook.',
        systemPrompt: `You are the Narrator of a solo JRPG campaign. You keep the chronicle and the memory book from an author's point of view. You do not control the player character, and you never invent numerical outcomes: STRPG owns stats, combat, rewards and saves.
When asked, summarize what changed recently, distinguish what the player knows from what is still hidden, and propose the next story beat as a concrete hook. A hook must name a place, a pressure, a choice and a consequence.`,
    },
    {
        id: 'quest-designer',
        name: 'Quest Designer',
        icon: '!',
        owns: 'Quests',
        assetKind: 'quest',
        allowedKinds: ['quest'],
        nextRole: 'casting-director',
        description: 'Turns the strongest hook into one playable quest with stages, objectives and rewards.',
        systemPrompt: `You are the Quest Designer. Turn the strongest story hook or open thread into one playable quest ready for a single Quest asset. It must name its type (main, side or hidden), level, start NPC or location, turn-in NPC, two or three stages with concrete objectives, and rewards. Use only target keys that were supplied. Put one or two alternative hooks in DIRECTOR NOTES, not in the player-safe brief. Do not design a whole campaign at once.`,
    },
    {
        id: 'casting-director',
        name: 'Casting Director',
        icon: '☗',
        owns: 'NPCs',
        assetKind: 'npc',
        allowedKinds: ['npc'],
        nextRole: 'ecologist',
        description: 'Designs one NPC at a time: role, voice, motive, secret, interactions and what they want from the player.',
        systemPrompt: `You are the Casting Director. Design one NPC who belongs to the current place and moment. Give them a role in the settlement, an appearance the player can notice, a personality, a motivation, a secret, how they speak, what they offer, and which interactions they expose. Ground the NPC in a supplied location key. Put one or two alternative castings in DIRECTOR NOTES, not in the player-safe brief.`,
    },
    {
        id: 'ecologist',
        name: 'Ecologist',
        icon: '☠',
        owns: 'Monsters & encounters',
        assetKind: 'monster',
        allowedKinds: ['monster'],
        nextRole: 'cartographer',
        description: 'Decides which creature belongs in an environment, why it is there, how it fights and what the player can read before combat.',
        systemPrompt: `You are the Ecologist. For a given environment, propose one creature or encounter group that makes ecological sense: why it is here, what it eats or fears, how it fights, what it drops, and how the player can read the danger before combat. Respect the level band. Use only supplied item and skill keys for drops and skills. Put alternatives in DIRECTOR NOTES, not in the player-safe brief.`,
    },
    {
        id: 'cartographer',
        name: 'Cartographer',
        icon: '⌘',
        owns: 'Scenes & routes',
        assetKind: 'scene',
        allowedKinds: ['scene'],
        nextRole: 'quartermaster',
        description: 'Proposes one place at a time: layer, parent scene, routes and what the player can learn there.',
        systemPrompt: `You are the Cartographer. Propose one scene or location that connects to existing places. Give its layer, site type, parent scene, visible landmarks, atmosphere, routes and what the player can learn or do there. Use only supplied scene and monster keys. Never invent a connection to a key you were not given. Put alternative routes or rooms in DIRECTOR NOTES, not in the player-safe brief.`,
    },
    {
        id: 'quartermaster',
        name: 'Quartermaster',
        icon: '▣',
        owns: 'Equipment & items',
        assetKind: 'equipment',
        allowedKinds: ['equipment'],
        nextRole: 'skill-wright',
        description: 'Designs one item at a time: place in the economy, history, stats, price and acquisition route.',
        systemPrompt: `You are the Quartermaster. Propose one item with a place in the world's economy: who made it, who sells or drops it, what it costs, what it does mechanically, and what trade-off or obligation comes with it. Use the exact equipment fields; do not invent resistances. Put alternatives in DIRECTOR NOTES, not in the player-safe brief.`,
    },
    {
        id: 'skill-wright',
        name: 'Skill Wright',
        icon: '✦',
        owns: 'Skills & status effects',
        assetKind: 'skill',
        allowedKinds: ['skill', 'status_effect'],
        nextRole: 'rules-keeper',
        description: 'Designs one skill or status effect at a time, expressing a class or creature identity through a clear combat problem.',
        systemPrompt: `You are the Skill Wright. Propose one skill or status effect that expresses a class or creature identity: what problem it solves, MP or cooldown cost, target, element, power and the exact effect shape. Avoid cleanse mechanics, which the engine does not support. Keep numbers modest and readable. Put alternatives in DIRECTOR NOTES, not in the player-safe brief.`,
    },
    {
        id: 'rules-keeper',
        name: 'Rules Keeper',
        icon: '⚖',
        owns: 'Classes & rules',
        assetKind: 'class',
        allowedKinds: ['class', 'rules'],
        nextRole: 'continuity-editor',
        description: 'Designs one class or small ruleset at a time with exact stat keys, growth curves and safe formulas.',
        systemPrompt: `You are the Rules Keeper. Propose one class or one small ruleset: stat identity, growth curve, starting kit, level cap, EXP curve and enemy scaling. Use exactly maxHp, maxMp, str, agi, int, vit and luck as stat keys. Leave formulas empty unless you are certain of the engine grammar; never use JavaScript.`,
    },
    {
        id: 'continuity-editor',
        name: 'Continuity Editor',
        icon: '⌘',
        owns: 'Consistency & spoiler audit',
        assetKind: null,
        allowedKinds: [],
        nextRole: 'narrator',
        description: 'Reviews memory, handoffs and briefs for contradictions, repetition, timeline problems and spoiler leaks. Creates no asset.',
        systemPrompt: `You are the Continuity Editor. You do not create game assets. Read the memory book, the blackboard and the latest briefs, then report contradictions, timeline problems, repeated content, unresolved threads and possible spoiler leaks. Put the player-safe summary in PLAYER-SAFE BRIEF, the issues in DIRECTOR NOTES, and a short prioritized fix list in HANDOFF.`,
    },
];

export const DIRECTOR_ROLE_MAP = Object.fromEntries(DIRECTOR_ROLES.map((role) => [role.id, role]));

export const MEMORY_VISIBILITY = ['player', 'director', 'secret'];

export function directorRole(roleId) {
    return DIRECTOR_ROLE_MAP[roleId] ?? DIRECTOR_ROLES[0];
}

export function roleAssetKind(role, state) {
    const saved = state?.roles?.[role.id]?.assetKind;
    if (saved && role.allowedKinds.includes(saved)) return saved;
    return role.assetKind ?? role.allowedKinds?.[0] ?? null;
}

export function rolePrompt(role, state) {
    return String(state?.roles?.[role.id]?.prompt || '').trim() || role.systemPrompt;
}

function id(prefix = 'dir') {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function batchKey(value, fallback = 'entry') {
    const key = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return key || `${fallback}_${Date.now().toString(36).slice(-5)}`;
}

export function createMemoryEntry(input = {}) {
    return {
        id: input.id ?? id('mem'),
        at: input.at ?? new Date().toISOString(),
        source: String(input.source ?? 'director'),
        type: String(input.type ?? 'note'),
        text: String(input.text ?? '').trim(),
        visibility: MEMORY_VISIBILITY.includes(input.visibility) ? input.visibility : 'director',
        terms: Array.isArray(input.terms) ? input.terms.map(String).filter(Boolean) : [],
    };
}

function normalizeList(rows, factory) {
    return (Array.isArray(rows) ? rows : []).map(factory).filter((entry) => entry.text);
}

export function normalizeDirectorState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const memoryRows = Array.isArray(source.memory) ? source.memory : [];
    const blackboard = source.blackboard && typeof source.blackboard === 'object' ? source.blackboard : {};
    const roleRows = source.roles && typeof source.roles === 'object' ? source.roles : {};
    const roles = {};
    for (const role of DIRECTOR_ROLES) {
        const saved = roleRows[role.id] && typeof roleRows[role.id] === 'object' ? roleRows[role.id] : {};
        roles[role.id] = {
            prompt: String(saved.prompt ?? ''),
            assetKind: role.allowedKinds.includes(saved.assetKind) ? saved.assetKind : (role.assetKind ?? role.allowedKinds?.[0] ?? ''),
            lastBrief: String(saved.lastBrief ?? ''),
            lastNotes: String(saved.lastNotes ?? ''),
            lastAt: saved.lastAt ?? null,
        };
    }
    const entryFactory = (entry) => ({
        id: entry.id ?? id('bb'),
        at: entry.at ?? new Date().toISOString(),
        text: String(entry.text ?? '').trim(),
        visibility: MEMORY_VISIBILITY.includes(entry.visibility) ? entry.visibility : 'director',
    });
    const handoffFactory = (entry) => ({
        id: entry.id ?? id('hand'),
        at: entry.at ?? new Date().toISOString(),
        from: String(entry.from ?? ''),
        to: String(entry.to ?? ''),
        text: String(entry.text ?? '').trim(),
    });
    const batches = (Array.isArray(source.batches) ? source.batches : []).map((batch) => ({
        id: batch.id ?? id('batch'),
        name: String(batch.name ?? 'Batch'),
        kind: String(batch.kind ?? ''),
        roleId: String(batch.roleId ?? ''),
        createdAt: batch.createdAt ?? new Date().toISOString(),
        autoAdvance: Boolean(batch.autoAdvance),
        items: (Array.isArray(batch.items) ? batch.items : []).map((item) => ({
            id: item.id ?? id('item'),
            key: String(item.key ?? '').trim(),
            title: String(item.title ?? '').trim(),
            brief: String(item.brief ?? '').trim(),
            status: ['planned', 'reserved', 'generated', 'failed'].includes(item.status) ? item.status : 'planned',
            assetId: item.assetId ?? null,
            generatedAt: item.generatedAt ?? null,
            error: String(item.error ?? ''),
        })).filter((item) => item.key || item.title),
    })).filter((batch) => batch.items.length).slice(-20);
    return {
        version: 1,
        settings: {
            includeSecrets: source.settings?.includeSecrets !== false,
            tone: String(source.settings?.tone ?? 'mysterious'),
        },
        memory: memoryRows.map((entry) => createMemoryEntry(entry)).filter((entry) => entry.text).slice(0, 200),
        blackboard: {
            facts: normalizeList(blackboard.facts, entryFactory),
            decisions: normalizeList(blackboard.decisions, entryFactory),
            threads: normalizeList(blackboard.threads, entryFactory),
            handoffs: (Array.isArray(blackboard.handoffs) ? blackboard.handoffs : []).map(handoffFactory).filter((entry) => entry.text).slice(-100),
        },
        roles,
        spoilers: {
            terms: [...new Set((Array.isArray(source.spoilers?.terms) ? source.spoilers.terms : []).map((term) => String(term).trim()).filter(Boolean))],
        },
        batches,
    };
}

export function emptyDirectorState() {
    return normalizeDirectorState({});
}

function formatEntries(entries, includeSecrets) {
    return entries
        .filter((entry) => !entry.text ? false : (includeSecrets || entry.visibility === 'player'))
        .slice(0, 14)
        .map((entry) => `- [${entry.source}/${entry.visibility}] ${entry.text}`)
        .join('\n');
}

export function buildRolePrompt({ role, state, question, includeSecrets = true, knownKeys = [] }) {
    const memory = state.memory ?? [];
    const blackboard = state.blackboard ?? { facts: [], decisions: [], threads: [], handoffs: [] };
    const sections = [
        `You are the ${role.name}, the ${role.owns} author for STRPG Studio.`,
        '',
        `ROLE BRIEF:\n${rolePrompt(role, state)}`,
        '',
        'CONTEXT RULES:',
        '- You are advising a solo director who is also the player. Preserve surprise for the player while keeping the world coherent.',
        '- The PLAYER-SAFE BRIEF is shown to the player and may be used as a public content prompt. It must not reveal secrets, hidden identities, future twists, or anything in DIRECTOR NOTES.',
        '- If a secret must shape the brief, describe only its visible symptom.',
        '- Use existing project keys when they are supplied. If a required key is missing, describe the gap instead of inventing a key.',
        '',
        `MODE: ${includeSecrets ? 'DIRECTOR (secrets may inform your notes, never the player-safe brief)' : 'PLAYER-SAFE (only player-known facts are supplied; do not speculate about hidden truths)'}.`,
        '',
        `MEMORY BOOK${includeSecrets ? ' (all visibility levels)' : ' (player-known only)'}:\n${formatEntries(memory, includeSecrets) || '- empty'}`,
        '',
        `CANON FACTS:\n${formatEntries(blackboard.facts, includeSecrets) || '- none'}`,
        `DECISIONS:\n${formatEntries(blackboard.decisions, includeSecrets) || '- none'}`,
        `OPEN THREADS:\n${formatEntries(blackboard.threads, includeSecrets) || '- none'}`,
        includeSecrets ? `HANDOFFS:\n${(blackboard.handoffs ?? []).slice(-8).map((entry) => `- ${entry.from || 'author'} -> ${entry.to || 'next'}: ${entry.text}`).join('\n') || '- none'}` : '',
        '',
        knownKeys?.length ? `EXISTING PROJECT KEYS YOU MAY REFERENCE:\n${knownKeys.slice(0, 60).join(', ')}` : '',
        '',
        `DIRECTOR QUESTION:\n${String(question ?? '').trim() || 'Propose the next piece of content for your domain.'}`,
        '',
        'OUTPUT FORMAT — use exactly these three section headings:',
        '### PLAYER-SAFE BRIEF',
        'Natural language the player could read. No secrets.',
        '### DIRECTOR NOTES',
        'Hidden truths, constraints and reasoning. Never shown to the player.',
        '### HANDOFF',
        'One short message to the next role, naming what they should build or preserve.',
    ];
    return sections.filter((line) => line !== '').join('\n');
}

export function buildBatchPlanPrompt({ role, state, kind, count, theme = '', knownKeys = [] }) {
    const memory = state.memory ?? [];
    const blackboard = state.blackboard ?? { facts: [], decisions: [], threads: [], handoffs: [] };
    const total = Math.max(1, Math.min(12, Number(count) || 1));
    return [
        `You are the ${role.name}; you are planning a batch of ${kind} assets for STRPG Studio.`,
        `PLAN ONLY. Do not write asset JSON, and do not write full descriptions yet.`,
        `Plan exactly ${total} distinct ${kind} entries. Each needs a stable ASCII snake_case key, a short title, and a one-sentence brief that can later become an AI generation prompt.`,
        'Keys must be unique and must not collide with the existing project keys below.',
        '',
        'OUTPUT FORMAT — exactly one line per entry, no table, no numbering, no commentary:',
        'key | Title | one-sentence brief',
        '',
        `MEMORY BOOK:\n${formatEntries(memory, true) || '- empty'}`,
        `CANON FACTS:\n${formatEntries(blackboard.facts, true) || '- none'}`,
        `DECISIONS:\n${formatEntries(blackboard.decisions, true) || '- none'}`,
        `OPEN THREADS:\n${formatEntries(blackboard.threads, true) || '- none'}`,
        `HANDOFFS:\n${(blackboard.handoffs ?? []).slice(-8).map((entry) => `- ${entry.from || 'author'} -> ${entry.to || 'next'}: ${entry.text}`).join('\n') || '- none'}`,
        knownKeys?.length ? `EXISTING PROJECT KEYS (do not reuse):\n${knownKeys.slice(0, 80).join(', ')}` : '',
        theme ? `BATCH THEME / CONSTRAINT:\n${String(theme).trim()}` : '',
        'Return only the plan lines now.',
    ].filter((line) => line !== '').join('\n');
}

export function parseBatchPlan(text, kind = 'asset', limit = 12) {
    const source = String(text ?? '').replace(/```(?:text|markdown)?/gi, '').trim();
    const rows = [];
    const usedKeys = new Set();
    for (const line of source.split(/\r?\n/)) {
        const clean = line.replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
        if (!clean || /^key\s*[|｜]/i.test(clean)) continue;
        const parts = clean.split(/\s*[|｜]\s*/);
        if (parts.length < 3) continue;
        if (parts.every((part) => /^:?-{2,}:?$/.test(part.trim()))) continue;
        let key = batchKey(parts[0], kind);
        let suffix = 2;
        while (usedKeys.has(key)) { key = `${batchKey(parts[0], kind)}_${suffix}`; suffix += 1; }
        usedKeys.add(key);
        rows.push({
            key,
            title: parts[1].trim() || key,
            brief: parts.slice(2).join(' | ').trim(),
        });
        if (rows.length >= limit) break;
    }
    return rows;
}

function normalizeHeading(value) {
    return String(value ?? '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
}

export function parseRoleOutput(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { brief: '', notes: '', handoff: '', raw: '', structured: false };
    const sections = {};
    let current = null;
    let sawHeading = false;
    for (const line of raw.split(/\r?\n/)) {
        const heading = line.match(/^\s*#{1,4}\s*(.+?)\s*$/);
        if (heading) {
            const key = normalizeHeading(heading[1]);
            if (key === 'PLAYER SAFE BRIEF' || key === 'PLAYER BRIEF') current = 'brief';
            else if (key === 'DIRECTOR NOTES' || key === 'DIRECTOR NOTE') current = 'notes';
            else if (key === 'HANDOFF') current = 'handoff';
            else current = null;
            if (current) {
                sawHeading = true;
                sections[current] = sections[current] ?? [];
            }
            continue;
        }
        if (current) sections[current].push(line);
    }
    if (!sawHeading) return { brief: raw, notes: '', handoff: '', raw, structured: false };
    return {
        brief: (sections.brief ?? []).join('\n').trim(),
        notes: (sections.notes ?? []).join('\n').trim(),
        handoff: (sections.handoff ?? []).join('\n').trim(),
        raw,
        structured: true,
    };
}

export function findSpoilerTerms(text, terms = []) {
    const haystack = String(text ?? '').toLowerCase();
    return [...new Set(terms.map((term) => String(term).trim()).filter((term) => term.length >= 2))]
        .filter((term) => haystack.includes(term.toLowerCase()));
}

export function redactSpoilerTerms(text, terms = []) {
    let output = String(text ?? '');
    for (const term of terms.map((entry) => String(entry).trim()).filter((term) => term.length >= 2)) {
        output = output.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[hidden]');
    }
    return output;
}

const KIND_REFERENCE_MAP = {
    story: ['scene'],
    quest: ['scene', 'npc', 'monster', 'equipment', 'quest'],
    npc: ['scene', 'quest', 'skill'],
    monster: ['equipment', 'skill'],
    scene: ['scene', 'monster'],
    equipment: ['class'],
    skill: ['class', 'status_effect'],
    status_effect: [],
    class: ['equipment', 'skill'],
    rules: [],
    world: ['scene'],
    event: ['scene', 'quest', 'equipment', 'npc'],
};

export function referenceKeysForKind(kind, assets = []) {
    const kinds = new Set(KIND_REFERENCE_MAP[kind] ?? []);
    if (!kinds.size) return [];
    const keys = assets
        .filter((asset) => kinds.has(asset.kind))
        .map((asset) => asset.asset_key ?? asset.data?.key)
        .filter(Boolean);
    return [...new Set(keys)].slice(0, 60);
}
