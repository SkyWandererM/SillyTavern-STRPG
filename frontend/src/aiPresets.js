/**
 * AI content generation presets for the STRPG Workbench.
 *
 * The Workbench generates content through SillyTavern's own quiet-prompt
 * pipeline, so the player's configured model, presets and connection are used.
 * This module is deliberately free of React and browser-only APIs: it builds
 * prompts, extracts JSON, and normalizes the result against the same asset
 * templates the manual editor uses. It can therefore be unit tested in Node.
 */
import { assetTemplate } from './assetTemplates.js';

export const AI_KINDS = [
    ['npc', 'NPC', '☗', 'People who talk, trade, heal or join the party.'],
    ['scene', 'Scene', '⌘', 'One place on the world map: town, wilds, dungeon or room.'],
    ['quest', 'Quest', '!', 'Objectives, stages, rewards and turn-in logic.'],
    ['monster', 'Monster', '☠', 'Enemies, bosses and encounter stats.'],
    ['equipment', 'Item', '▣', 'Weapons, armor, accessories, consumables and key items.'],
    ['skill', 'Skill', '✦', 'Active or passive abilities with costs and effects.'],
    ['event', 'Event', '⚑', 'Trigger + condition + actions for scenes or the world.'],
    ['story', 'Story', '❖', 'Narrative graph with nodes, edges and endings.'],
    ['class', 'Class', '♜', 'Base stats, growth and starting kit for the player.'],
    ['status_effect', 'Status Effect', '◉', 'Buffs, debuffs, damage over time and control.'],
    ['world', 'World', '◈', 'Setting identity, lore and starting scene.'],
    ['rules', 'Rules', '⚖', 'Level cap, formulas, EXP table and scaling.'],
];

export const AI_KIND_LABELS = Object.fromEntries(AI_KINDS.map(([kind, label]) => [kind, label]));

export const AI_TONES = [
    ['heroic', 'Heroic', 'hopeful, heroic, high fantasy'],
    ['grim', 'Grim', 'grim, grounded, low fantasy'],
    ['whimsical', 'Whimsical', 'whimsical, fairy-tale, warm'],
    ['mysterious', 'Mysterious', 'mysterious, uncanny, restrained'],
    ['political', 'Political', 'political, courtly, morally grey'],
    ['horror', 'Horror', 'eerie, gothic, unsettling'],
];

export const AI_PRESETS = {
    npc: [
        {
            id: 'quest-giver',
            label: 'Quest Giver',
            summary: 'A villager with a personal problem that becomes the party\'s job.',
            prompt: 'An elder or official in the starting town whose family heirloom vanished into the nearby wilds. They are proud, evasive about the truth, and offer a modest reward. Include a talk interaction with a line that hints at the lie without stating it. Only if Reference keys include a quest key, add an accept_quest interaction, a matching turn_in_quest interaction and a questsOffered entry for that key; otherwise put the offer in dialogue and leave questsOffered empty. Do not invent a quest key.',
        },
        {
            id: 'merchant',
            label: 'Merchant',
            summary: 'A trader with a shop, a personality and a reason to travel.',
            prompt: 'A travelling merchant with a wry sense of humour and a carefully maintained shop. Their stock is useful at the current level, their prices are fair but not generous, and one item has a story attached. Add a shop interaction and a talk interaction with two dialogue lines. Stock only item keys listed in Reference keys; if none are listed, keep shop.items empty and describe the wares in dialogue.',
        },
        {
            id: 'companion',
            label: 'Recruitable Companion',
            summary: 'Someone who can join the party after a small trust test.',
            prompt: 'A capable wanderer who can join the party. They are guarded at first, respect competence, and want to see the player finish one small task before trusting them. Set joinable to true. Use joinCondition only with supported keys (flag, questKey, itemKey, level, locationKey); if uncertain, omit joinCondition.',
        },
        {
            id: 'antagonist',
            label: 'Antagonist',
            summary: 'A named rival or villain with a motive and a weakness.',
            prompt: 'A named antagonist who is not simply evil. Give them a public face, a private motive, a line the player will remember, and one weakness the story can exploit. They should be usable as an important NPC now and as a boss later. If you include combat data, use only skill keys from Reference keys; otherwise leave combat out.',
        },
        {
            id: 'healer',
            label: 'Healer / Innkeeper',
            summary: 'A safe haven with a heal interaction and local gossip.',
            prompt: 'The keeper of the local inn or shrine. They heal the party, know the town\'s gossip, and quietly keep a secret about the road ahead. Add a heal interaction (the engine performs the heal) and a talk interaction with local rumours. Any donation is dialogue only; do not invent a price field.',
        },
    ],
    scene: [
        {
            id: 'town',
            label: 'Settlement',
            summary: 'A town with a social problem, services and one exit hook.',
            prompt: 'A small settlement on the edge of the frontier. Give it a reason to exist, two visible landmarks, a social tension the player can notice, and one road that leads deeper into danger. siteType must be town and randomEncounter must stay disabled or absent. Omit connections unless a target scene key is listed in Reference keys; do not invent one.',
        },
        {
            id: 'wilderness',
            label: 'Wilderness Area',
            summary: 'A traversable wild zone with weather, danger and a secret.',
            prompt: 'A travel scene between two settlements. Describe weather, landmarks and what the player can hear before they see it. siteType must be wilderness. If Reference keys include monster keys, enable a random encounter with them and optionally one fixed encounter; otherwise leave both empty and describe the danger in prose. Do not invent monster keys. Keep the description playable, not a lore dump.',
        },
        {
            id: 'dungeon',
            label: 'Dungeon',
            summary: 'A hostile interior with a theme, a hazard and a reward.',
            prompt: 'A small dungeon with a clear theme and one described hazard. The entrance, hazard and reward room should each be describable in one sentence. siteType must be dungeon. If Reference keys include monster keys, add one fixed and one random encounter with them; otherwise leave encounters empty and express the hazard through description or an event key. Do not invent monster keys, and do not add a hazard field.',
        },
        {
            id: 'interior',
            label: 'Interior / Room',
            summary: 'A shop, temple, home or room with a purpose and a detail.',
            prompt: 'An interior scene that exists for a reason: a shop, a temple, a workshop or a private room. Describe what is on the walls, what the light does, and what the player can interact with. siteType must be indoor; layer must be interior or room; randomEncounter must stay disabled. Use the Anchor scene as parentKey and omit connections unless a target key is listed in Reference keys.',
        },
    ],
    quest: [
        {
            id: 'main',
            label: 'Main Story Beat',
            summary: 'A three-stage main quest that moves the central plot.',
            prompt: 'A main quest that advances the central story. Three stages: investigate, confront, resolve. Every objective targetKey must come from Reference keys. If completion is turn_in, include turnIn {npcKey}. Rewards should include EXP, gold and one flag; add an item reward only when its itemKey is in Reference keys. Type must be main. Do not invent NPC, scene, monster, item or quest keys.',
        },
        {
            id: 'side',
            label: 'Side Quest',
            summary: 'A compact side story with a small moral choice.',
            prompt: 'A side quest that a local NPC would plausibly ask for. Two stages. One stage may have two objectives with mode "any" so the player can choose an approach; do not use an unsupported "optional" field. Use only Reference keys for start, turnIn and objective targets. The quest should reveal something about the settlement rather than only asking for a fetch item. Type must be side.',
        },
        {
            id: 'hidden',
            label: 'Hidden Quest',
            summary: 'An optional discovery quest with a secret reward.',
            prompt: 'A hidden quest the player can discover by exploring a non-obvious place. Gate discovery with start.type and an existing locationKey or storyNodeKey; do not put a flag in prerequisites, because prerequisites only accepts quest keys. Reward a flag and/or an existing itemKey from Reference keys. Type must be hidden. Do not invent keys.',
        },
    ],
    monster: [
        {
            id: 'beast',
            label: 'Wild Beast',
            summary: 'A level-appropriate animal enemy with a readable gimmick.',
            prompt: 'A wild beast that fits the current region. Express its behaviour through description and the ai field (aggressive, defensive or random); do not add unsupported mechanics. Stats should be appropriate for the current level band. Add skills only when Reference keys include skill keys. Drop an item only when Reference keys include its itemKey; otherwise omit drops. Do not invent skill or item keys.',
        },
        {
            id: 'raider',
            label: 'Humanoid Raider',
            summary: 'A human enemy with equipment and a motive.',
            prompt: 'A humanoid raider or soldier. Describe their gear so the player understands what they are fighting. They use one skill only when Reference keys include a skill key. Drop the carried weapon only when its itemKey is in Reference keys; otherwise omit drops. Keep their stats fair for the level band.',
        },
        {
            id: 'boss',
            label: 'Boss',
            summary: 'A set-piece enemy with a signature move.',
            prompt: 'A boss for a dungeon or story beat. It needs one signature skill (use an existing skill key only if Reference keys include one), ai set to defensive or aggressive, and a clear visual tell in the description. Its HP should be roughly triple a normal enemy of the level, with rewards to match. Add one rare drop only when its itemKey is in Reference keys. STRPG has no phase field; express phases through description, actions or counterplay, not new fields.',
        },
    ],
    equipment: [
        {
            id: 'weapon',
            label: 'Weapon',
            summary: 'A weapon with a history and a small trade-off.',
            prompt: 'A weapon that a character in this world would actually carry. Give it a name with history, one positive stat bonus in stats, and an optional negative stat as a trade-off. Price it for the current level band. Kind must be weapon and slot must be weapon. Do not add a resistances field.',
        },
        {
            id: 'armor',
            label: 'Armor',
            summary: 'Protective gear tied to a place or faction.',
            prompt: 'A piece of armor associated with a place or faction in the world. It should protect against a specific threat rather than everything. Include a short description and one stat bonus such as def or res in stats. Kind must be armor and slot must be armor. Do not add a resistances field; items do not support it.',
        },
        {
            id: 'consumable',
            label: 'Consumable',
            summary: 'A limited-use item with a clear tactical use.',
            prompt: 'A consumable the player will be glad to find before a hard fight. It should have a clear use, a modest price, and a description that explains when to use it. Kind must be consumable and slot must be null. Include a consumable object with healHp, healMp, cure and/or buff; do not rely on a top-level heal field.',
        },
    ],
    skill: [
        {
            id: 'offensive',
            label: 'Offensive Skill',
            summary: 'A damaging skill with an element and a cost.',
            prompt: 'An offensive skill for a class in this world. Pick one element, a target type, an MP cost and a cooldown that make it a meaningful alternative to a basic attack. Set type to attack and power to the skill power. The description should explain the visual and the tactical use. Omit formula unless you are certain of the engine syntax; do not invent classes or effect keys.',
        },
        {
            id: 'support',
            label: 'Support Skill',
            summary: 'A heal, buff or cleanse with a meaningful cost.',
            prompt: 'A support skill that solves a specific problem the party will face, with an MP cost that makes it a decision. Use type heal with power for healing, or type buff with effects.buff {stat, amount, duration} for a buff. STRPG has no cleanse field on skills; if you want a cleanse, set type utility and keep it in the description. Set category active. Use only Reference keys for classes and effectKey.',
        },
        {
            id: 'passive',
            label: 'Passive Skill',
            summary: 'A passive that changes how a class is played.',
            prompt: 'A passive skill that rewards a particular play style. Set category to passive and put one clear modifier in passive.modifiers {stat: number}. Set an unlockLevel. Use only Reference keys for classes. Do not add an MP cost or an active effect.',
        },
    ],
    event: [
        {
            id: 'scene-event',
            label: 'Scene Event',
            summary: 'An entering event with a condition and consequences.',
            prompt: 'A scene event that fires when the player enters a specific place for the first time. Set scope to scene and use the Anchor scene as sceneKey. Use only these action types: set_flag, set_variable, give_item, accept_quest, grant_exp, unlock_skill, heal, teleport, notice. Reference existing item, quest, location and skill keys only; there is no generic "change the scene" action beyond teleport or notice. Keep the action list small and deterministic.',
        },
        {
            id: 'world-event',
            label: 'World Event',
            summary: 'A world-scope event that pays off an earlier choice.',
            prompt: 'A world-scope event that triggers a consequence for an earlier choice. Set scope to world and once to true. The condition may check a flag, questKey or storyNodeKey. Use only these action types: set_flag, set_variable, give_item, accept_quest, grant_exp, unlock_skill, heal, teleport, notice. Reference existing keys only; do not invent item, quest, location or skill keys.',
        },
    ],
    story: [
        {
            id: 'arc',
            label: 'Story Arc',
            summary: 'A five-node story graph with one branch and one ending.',
            prompt: 'A compact story arc for the current world: five nodes, one meaningful branch, and one ending. Each node needs a short title, a type (scene, branch, ending), and one paragraph of text. Use "branch" for the choice node, never "choice". Edges must connect only node keys declared in this asset. startNodeKey and endings must reference declared nodes. sceneKey must be an existing scene key. Every node must be reachable from the start.',
        },
    ],
    class: [
        {
            id: 'class',
            label: 'Player Class',
            summary: 'A class with a clear combat identity and growth curve.',
            prompt: 'A player class with a clear identity: one primary stat, one weakness, and a reason to exist beside the default class. baseStats and growth must use exactly these keys: maxHp, maxMp, str, agi, int, vit, luck. Put items and skills in startingItems/startingSkills and skillTree only when their keys are in Reference keys; otherwise leave those arrays empty. Do not use hp, attack or magic as stat names.',
        },
    ],
    status_effect: [
        {
            id: 'debuff',
            label: 'Debuff',
            summary: 'A status that changes a fight without stopping it.',
            prompt: 'A debuff that makes a fight more interesting without removing the player\'s turn. kind must be buff, debuff, dot or control. Set duration 1-5. Use modifiers with engine stat names and/or tick {type: damage_percent|heal_percent|none, value}. Set skipTurn true only for a control effect. Keep the numbers small; do not invent a new stat name.',
        },
    ],
    world: [
        {
            id: 'world',
            label: 'World Identity',
            summary: 'A setting with a central tension and a starting scene.',
            prompt: 'A world identity for a JRPG campaign. It needs a central tension, a reason the player starts where they do, and a tone that can sustain a campaign. startLocationKey must be an existing scene key; use the Anchor scene. Do not include locations or connections arrays; those belong to scene assets. Keep lore to what a player can discover in play.',
        },
    ],
    rules: [
        {
            id: 'rules',
            label: 'Ruleset',
            summary: 'A level curve and formula set for a campaign.',
            prompt: 'A ruleset for the current campaign. Prefer levelCap, startingGold, expTable ({level, exp}, ascending levels) and enemyScaling {hp, atk}. Leave formulas empty unless you are certain: the engine accepts numbers, + - * / % ^, parentheses, min/max/round/floor/ceil/abs/sqrt/pow/clamp and engine variables such as level, atk, def, mag, res, power, variance, critMult, elementMult, hit, evade, luck, agi, enemyAgi. Never use JavaScript arrows, function, eval or code blocks. statCaps must be positive numbers.',
        },
    ],
};

export const FIELD_GUIDES = {
    npc: 'key, name, title, description, personality, motivation, locationKey (existing scene key), portrait (null), interactions[] ({key,label,type: talk|shop|accept_quest|turn_in_quest|join_party|heal|story|custom, questKey (required for accept_quest and turn_in_quest), dialogue[], condition, actions[]}), shop (null or {buyRate, sellRate, items[] ({itemKey, price, stock})}), questsOffered[] (must also contain any questKey used by accept_quest), important, joinable, joinCondition, relations',
    scene: 'key, name, type (town/forest/dungeon/...), layer (world|region|settlement|interior|room|dungeon|floor), siteType (indoor|town|wilderness|dungeon), isSpawn, region, description, parentKey (existing scene), map {x,y}, spawnPoints[] ({key,x,y,label}), image (null), discoveredByDefault, connections[] ({toKey, mode: road|trail|walk|door|stairs|gate|portal|secret, travelCost, bidirectional, entryKey, condition, label}), interactions[], events[], eventKeys[], encounters[] ({key, name, description, respawnSeconds, monsters[] ({monsterKey, count})}), randomEncounter {enabled, name, chance, dice {count,sides}, difficulty, cooldownSeconds, monsters[]}, tags[]',
    quest: 'key, name, type (main|side|hidden), description, level, prerequisites[] (quest keys only), start {type: npc|location|story|auto, npcKey|locationKey|storyNodeKey}, turnIn {npcKey} (required when completion is turn_in), completion (auto|turn_in), stages[] ({key,name,description,mode: all|any, objectives[] ({key,type: kill|collect|talk|visit|flag|level|combat_win,targetKey,count,label})}), rewards {exp,gold,items[] ({itemKey,quantity}),skills[],flags[],storyKey}, failure {type: time|flag|combat,targetKey}, nodes[], edges[]',
    monster: 'key, name, description, level, stats {maxHp,maxMp,str,agi,int,vit,luck,atk,def,res,hit,evade,crit}, skills[] (existing skill keys only), resistances {element: number}, exp, gold, drops[] ({itemKey (existing item key), chance, min, max}), ai (aggressive|defensive|random), tags[]',
    equipment: 'key, name, kind (weapon|armor|accessory|consumable|quest|material), description, rarity (common|uncommon|rare|epic|legendary), price, stackable, maxStack, slot (weapon|armor|accessory|null), stats {stat: number}, effects, classRestrictions[], consumable {healHp, healMp, cure[], buff {stat, amount, duration}}, tags[]',
    skill: 'key, name, category (active|passive), type (attack|heal|buff|debuff|status|utility), description, mpCost, cooldown, target (single|all_enemies|self|ally|all_allies), element (physical|fire|ice|lightning|holy|dark|none), power, effects {applyStatus {effectKey, chance, duration}, buff {stat, amount, duration}, drain}, unlockLevel, classes[] (existing class keys), passive {modifiers}, formula (optional; omit unless certain)',
    event: 'key, name, description, scope (scene|world|story), sceneKey (existing scene key), trigger (enter|interact|flag|quest|combat_victory|manual), targetKey, priority, once, condition, actions[] ({type: set_flag|set_variable|give_item|accept_quest|grant_exp|unlock_skill|heal|teleport|notice, key, value, amount, questKey, itemKey, locationKey, skillKey, flag, text}), tags[]',
    story: 'key, name, description, startNodeKey, endings[], variables, nodes[] ({key,title,type: scene|branch|ending|event, sceneKey (existing scene), text, conditions, actions[], map {x,y}}), edges[] ({key,from,to,label,condition,actions})',
    class: 'key, name, description, baseStats {maxHp,maxMp,str,agi,int,vit,luck}, growth {same keys}, startingItems[] ({itemKey,quantity}), startingSkills[] (existing skill keys), skillTree[] ({level,skillKey})',
    status_effect: 'key, name, kind (buff|debuff|dot|control), description, duration, modifiers {stat: number}, tick {type: damage_percent|heal_percent|none, value}, skipTurn',
    world: 'key, name, description, startLocationKey (existing scene key), mapImage (null), lore, tags[]',
    rules: 'key, name, levelCap, startingGold, statCaps {stat: number}, formulas {name: expression}, expTable[] ({level,exp}), enemyScaling {hp,atk}, saveEveryCombatAction',
};

const KIND_COUNT_NOUN = {
    npc: 'NPC', scene: 'scene', quest: 'quest', monster: 'monster', equipment: 'item',
    skill: 'skill', event: 'event', story: 'story', class: 'class', status_effect: 'status effect',
    world: 'world', rules: 'ruleset',
};

export function slugKey(value, fallback = 'entry') {
    const key = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return key || `${fallback}_${Date.now().toString(36).slice(-5)}`;
}

export function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** Merge generated values onto a template. Arrays replace; objects merge. */
export function mergeInto(template, patch) {
    if (patch === undefined) return clone(template);
    if (Array.isArray(template) || Array.isArray(patch)) return clone(patch);
    if (template && patch && typeof template === 'object' && typeof patch === 'object') {
        const result = clone(template);
        for (const [key, value] of Object.entries(patch)) result[key] = mergeInto(template[key], value);
        return result;
    }
    return clone(patch);
}

export function buildGenerationPrompt({ kind, preset, prompt, context = {} }) {
    const guide = FIELD_GUIDES[kind] ?? 'any fields suitable for the content';
    const tone = AI_TONES.find(([value]) => value === context.tone)?.[2] ?? 'grounded fantasy';
    const label = AI_KIND_LABELS[kind] ?? kind;
    const presetText = preset?.prompt ? `PRESET DIRECTION: ${preset.prompt}` : '';
    const references = String(context.references ?? '').trim();
    const lines = [
        'You are the STRPG World Writer, a senior JRPG content designer. You write production-ready content for a SillyTavern RPG framework.',
        '',
        `TASK: Create exactly one ${label} ${KIND_COUNT_NOUN[kind] ? `(${KIND_COUNT_NOUN[kind]})` : ''} as a single JSON object.`,
        'OUTPUT: JSON only. No markdown fences, no commentary, no explanation before or after the object.',
        '',
        `REQUIRED SHAPE: ${guide}`,
        '',
        'RULES:',
        '- "key" must be lowercase ASCII snake_case and unique, max 60 chars.',
        '- Do not use placeholder values such as REPLACE_WITH_LOCATION, TBD, TODO or lorem ipsum.',
        '- Reference only keys that exist in the current world. If a reference is uncertain, omit that optional field instead of inventing a near-duplicate.',
        '- If a field needs an existing key and no matching key is supplied in Reference keys, use a non-reference design (empty array, dialogue-only, description-only) instead of inventing a key.',
        '- Scene connections: use mode road or trail between different layers, door only for parent/child scenes, stairs only between dungeon/floor scenes, and walk only for the same layer and parent. Omit a connection you cannot ground in an existing target key.',
        '- Scene parents: interior, room and floor scenes require a parentKey; use an existing scene with a compatible layer.',
        '- Numbers must be integers or simple decimals. No formulas expressed as JavaScript code.',
        '- Keep prose vivid and specific; avoid generic fantasy filler.',
        '- The result is a DRAFT for human review, so make it useful for a designer, not vague.',
        '',
        `TONE: ${tone}.`,
        context.worldName ? `WORLD: ${context.worldName}${context.worldDescription ? ` — ${String(context.worldDescription).slice(0, 600)}` : ''}` : '',
        context.sceneKeys?.length ? `KNOWN SCENES: ${context.sceneKeys.slice(0, 40).join(', ')}` : '',
        context.level ? `LEVEL BAND: ${context.level}. Balance stats, prices and rewards for a party around this level.` : '',
        context.locationKey ? `LOCATION: ${context.locationKey}. Attach NPCs and scene events here when the format allows it.` : '',
        context.parentKey ? `PARENT SCENE: ${context.parentKey}. Use it as parentKey for a child scene.` : '',
        references ? `EXISTING KEYS YOU MAY REFERENCE: ${references}` : '',
        context.existing ? `EXISTING DRAFT TO IMPROVE (preserve its key and intent):\n${JSON.stringify(context.existing, null, 2)}` : '',
        '',
        presetText,
        '',
        `DESIGNER REQUEST:\n${String(prompt ?? '').trim() || preset?.prompt || 'Create one fitting piece of content for this world.'}`,
        '',
        'Return the JSON object now.',
    ];
    return lines.filter((line) => line !== '').join('\n');
}

/** Extract the first balanced JSON object from a model reply. */
export function extractJsonObject(text) {
    const source = String(text ?? '').trim();
    if (!source) throw new Error('The model returned an empty reply.');
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : source;
    const start = candidate.indexOf('{');
    if (start < 0) throw new Error('The model reply does not contain a JSON object.');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
        const char = candidate[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(candidate.slice(start, index + 1));
                } catch (error) {
                    throw new Error(`The model returned invalid JSON: ${error.message}`);
                }
            }
        }
    }
    throw new Error('The model JSON object is not closed. Try generating again.');
}

function autoUniqueKey(kind, key, existingAssets = []) {
    const used = new Set(existingAssets.filter((asset) => asset.kind === kind).map((asset) => asset.asset_key ?? asset.data?.key));
    if (!used.has(key)) return key;
    let index = 2;
    while (used.has(`${key}_${index}`)) index += 1;
    return `${key}_${index}`;
}

export function normalizeGeneratedAsset(kind, raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Generated content must be a JSON object.');
    const context = options.context ?? {};
    const template = assetTemplate(kind);
    const data = mergeInto(template, raw);
    delete data.tagsText;
    data.key = slugKey(data.key || data.name, kind);
    data.name = String(data.name || data.key).trim();
    if (kind === 'npc') {
        data.kind = 'npc';
        data.locationKey = data.locationKey && !String(data.locationKey).startsWith('REPLACE_')
            ? data.locationKey
            : (context.locationKey || context.parentKey || data.locationKey || 'REPLACE_WITH_LOCATION');
        data.interactions = (data.interactions ?? []).map((entry, index) => ({
            key: slugKey(entry.key || `${kind}_${index + 1}`, 'talk'),
            label: entry.label || 'Talk',
            type: entry.type || 'talk',
            description: entry.description || '',
            dialogue: Array.isArray(entry.dialogue) ? entry.dialogue : (entry.dialogue ? [String(entry.dialogue)] : []),
            actions: Array.isArray(entry.actions) ? entry.actions : [],
            ...(entry.questKey ? { questKey: entry.questKey } : {}),
        }));
        data.questsOffered = Array.isArray(data.questsOffered) ? data.questsOffered : [];
        for (const interaction of data.interactions) {
            if (!['accept_quest', 'turn_in_quest'].includes(interaction.type)) continue;
            if (!interaction.questKey && data.questsOffered.length === 1) interaction.questKey = data.questsOffered[0];
            if (interaction.type === 'accept_quest' && interaction.questKey && !data.questsOffered.includes(interaction.questKey)) {
                data.questsOffered.push(interaction.questKey);
            }
        }
    }
    if (kind === 'scene') {
        data.layer = data.layer || 'region';
        data.siteType = data.siteType || (data.layer === 'settlement' ? 'town' : data.layer === 'dungeon' || data.layer === 'floor' ? 'dungeon' : data.layer === 'interior' || data.layer === 'room' ? 'indoor' : 'wilderness');
        data.type = data.type || 'town';
        data.parentKey = context.parentKey || data.parentKey || null;
        data.map = { x: Number(raw.map?.x ?? 240), y: Number(raw.map?.y ?? 240) };
        data.connections = Array.isArray(data.connections) ? data.connections : [];
        data.tags = Array.isArray(data.tags) ? data.tags : [];
    }
    if (kind === 'event') {
        data.scope = data.scope || 'scene';
        data.sceneKey = data.sceneKey && !String(data.sceneKey).startsWith('REPLACE_')
            ? data.sceneKey
            : (context.locationKey || context.parentKey || data.sceneKey || null);
        data.actions = Array.isArray(data.actions) ? data.actions : [];
    }
    if (kind === 'quest') {
        data.type = data.type || 'side';
        if (context.locationKey && data.start?.type === 'location') data.start.locationKey = context.locationKey;
        data.stages = Array.isArray(data.stages) && data.stages.length ? data.stages : template.stages;
        data.rewards = { exp: 20, gold: 10, items: [], skills: [], flags: [], ...(data.rewards ?? {}) };
        data.nodes = Array.isArray(data.nodes) ? data.nodes : [];
        data.edges = Array.isArray(data.edges) ? data.edges : [];
        if (data.completion === 'turn_in' && !data.turnIn?.npcKey && data.start?.type === 'npc' && data.start.npcKey) {
            data.turnIn = { npcKey: data.start.npcKey };
        }
    }
    if (kind === 'monster' && context.level) data.level = Number(context.level);
    if (kind === 'equipment') {
        data.kind = data.kind || 'weapon';
        const slotForKind = { weapon: 'weapon', armor: 'armor', accessory: 'accessory' };
        data.slot = slotForKind[data.kind] ?? null;
        data.tags = Array.isArray(data.tags) ? data.tags : [];
    }
    if (kind === 'skill') data.classes = Array.isArray(data.classes) ? data.classes : [];
    if (kind === 'world') {
        const start = data.startLocationKey;
        data.startLocationKey = start && !String(start).startsWith('REPLACE_')
            ? start
            : (context.locationKey || start || 'REPLACE_WITH_LOCATION');
    }
    if (kind === 'story') {
        const usingTemplateNodes = !(Array.isArray(raw.nodes) && raw.nodes.length);
        const rawNodes = usingTemplateNodes ? template.nodes : raw.nodes;
        data.nodes = rawNodes.map((node, index) => {
            const key = slugKey(node.key || `node_${index + 1}`, 'node');
            return {
                ...node,
                key,
                title: node.title || key,
                type: node.type === 'choice' ? 'branch' : (['scene', 'branch', 'ending', 'event'].includes(node.type) ? node.type : 'scene'),
                text: String(node.text ?? ''),
                map: { x: Number(node.map?.x ?? 120 + index * 180), y: Number(node.map?.y ?? 120) },
            };
        });
        const nodeKeys = new Set(data.nodes.map((node) => node.key));
        const rawStart = data.startNodeKey || template.startNodeKey;
        data.startNodeKey = nodeKeys.has(rawStart) ? rawStart : data.nodes[0].key;
        const rawEdges = Array.isArray(raw.edges) && raw.edges.length ? raw.edges : (usingTemplateNodes ? template.edges : []);
        data.edges = rawEdges.map((edge, index) => ({
            ...edge,
            key: edge.key || `edge_${index + 1}`,
            from: edge.from,
            to: edge.to,
            label: edge.label ?? '',
            condition: edge.condition ?? {},
            actions: Array.isArray(edge.actions) ? edge.actions : [],
        }));
        data.endings = (Array.isArray(data.endings) ? data.endings : []).filter((key) => nodeKeys.has(key));
        if (!data.endings.length) {
            const endingNode = data.nodes.find((node) => node.type === 'ending');
            if (endingNode) data.endings = [endingNode.key];
        }
    }
    if (options.lockedKey) data.key = slugKey(options.lockedKey);
    else if (options.assets) data.key = autoUniqueKey(kind, data.key, options.assets);
    if (options.lockedName) data.name = String(options.lockedName).trim();
    return { kind, data, name: data.name };
}

export function summarizeGeneratedAsset(kind, data) {
    const rows = [];
    const push = (label, value) => {
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
        rows.push({ label, value: Array.isArray(value) ? value.join(', ') : String(value) });
    };
    push('Name', data.name);
    push('Key', data.key);
    if (kind === 'npc') {
        push('Title', data.title);
        push('Location', data.locationKey);
        push('Interactions', (data.interactions ?? []).map((entry) => entry.label));
        push('Joinable', data.joinable ? 'yes' : 'no');
    } else if (kind === 'scene') {
        push('Layer', data.layer);
        push('Site type', data.siteType);
        push('Parent', data.parentKey);
        push('Connections', (data.connections ?? []).map((entry) => entry.toKey));
    } else if (kind === 'quest') {
        push('Type', data.type);
        push('Level', data.level);
        push('Stages', (data.stages ?? []).map((entry) => entry.name || entry.key));
        push('Reward', data.rewards ? `${data.rewards.exp ?? 0} EXP / ${data.rewards.gold ?? 0} G` : null);
    } else if (kind === 'monster') {
        push('Level', data.level);
        push('HP', data.stats?.maxHp);
        push('EXP / Gold', `${data.exp ?? 0} / ${data.gold ?? 0}`);
        push('Drops', (data.drops ?? []).map((entry) => entry.itemKey));
    } else if (kind === 'equipment') {
        push('Kind / slot', `${data.kind}${data.slot ? ` / ${data.slot}` : ''}`);
        push('Rarity', data.rarity);
        push('Price', data.price);
        push('Stats', data.stats ? Object.entries(data.stats).map(([key, value]) => `${key} +${value}`).join(', ') : null);
    } else if (kind === 'skill') {
        push('Type', `${data.category} / ${data.type}`);
        push('MP / cooldown', `${data.mpCost ?? 0} / ${data.cooldown ?? 0}`);
        push('Target', data.target);
        push('Power', data.power);
    } else if (kind === 'event') {
        push('Scope', data.scope === 'scene' ? `scene: ${data.sceneKey}` : data.scope);
        push('Trigger', data.trigger);
        push('Actions', (data.actions ?? []).map((entry) => entry.type));
    } else if (kind === 'story') {
        push('Nodes', (data.nodes ?? []).map((entry) => entry.title || entry.key));
        push('Endings', data.endings);
    } else if (kind === 'world') {
        push('Start scene', data.startLocationKey);
    } else if (kind === 'class') {
        push('Base HP/MP', `${data.baseStats?.maxHp ?? '?'} / ${data.baseStats?.maxMp ?? '?'}`);
        push('Skills', data.startingSkills);
    } else if (kind === 'status_effect') {
        push('Kind', data.kind);
        push('Duration', data.duration);
    } else if (kind === 'rules') {
        push('Level cap', data.levelCap);
        push('Starting gold', data.startingGold);
    }
    push('Description', String(data.description ?? '').slice(0, 280));
    return rows;
}

export function generatedContentWarnings(kind, data) {
    const warnings = [];
    const text = JSON.stringify(data ?? {});
    if (/REPLACE_WITH_|TBD|TODO|lorem ipsum/i.test(text)) warnings.push('The result still contains placeholder values. Replace them before publishing.');
    if (kind === 'npc' && !data.locationKey) warnings.push('Assign a location before this NPC can appear in play.');
    if (kind === 'npc') {
        for (const interaction of data.interactions ?? []) {
            if (['accept_quest', 'turn_in_quest'].includes(interaction.type) && !interaction.questKey) {
                warnings.push(`Interaction "${interaction.label || interaction.key}" needs a questKey.`);
            }
            if (interaction.type === 'accept_quest' && interaction.questKey && !(data.questsOffered ?? []).includes(interaction.questKey)) {
                warnings.push(`questsOffered does not include "${interaction.questKey}", so the NPC cannot offer it.`);
            }
        }
    }
    if (kind === 'event') {
        if (data.scope === 'scene' && !data.sceneKey) warnings.push('A scene event needs a scene key.');
        const allowedActions = new Set(['set_flag', 'set_variable', 'give_item', 'accept_quest', 'grant_exp', 'unlock_skill', 'heal', 'teleport', 'notice']);
        for (const action of data.actions ?? []) {
            if (!allowedActions.has(action.type)) warnings.push(`Unsupported event action "${action.type}".`);
        }
    }
    if (kind === 'quest') {
        if (!(data.stages ?? []).length) warnings.push('A quest needs at least one stage.');
        if (data.completion === 'turn_in' && !data.turnIn?.npcKey) warnings.push('completion is turn_in but turnIn.npcKey is missing.');
        for (const [stageIndex, stage] of (data.stages ?? []).entries()) {
            for (const objective of stage.objectives ?? []) {
                if (['kill', 'collect', 'talk', 'visit'].includes(objective.type) && !objective.targetKey) {
                    warnings.push(`Stage ${stageIndex + 1} objective "${objective.key}" needs a targetKey.`);
                }
            }
        }
    }
    if (kind === 'scene') {
        if (!(data.connections ?? []).length) warnings.push('This scene has no connections yet. Add at least one route in the Connections tab.');
        if (data.randomEncounter?.enabled && !(data.randomEncounter.monsters ?? []).length) warnings.push('Random encounter is enabled but has no monsters.');
        if (data.randomEncounter?.enabled && !['wilderness', 'dungeon'].includes(data.siteType)) warnings.push(`Random encounters are only allowed in wilderness or dungeon scenes, not ${data.siteType}.`);
        for (const encounter of data.encounters ?? []) {
            if (!(encounter.monsters ?? []).length) warnings.push(`Fixed encounter "${encounter.name || encounter.key}" has no monsters.`);
        }
    }
    if (kind === 'monster') {
        for (const drop of data.drops ?? []) {
            if (Number(drop.max ?? 1) < Number(drop.min ?? 1)) warnings.push(`Drop "${drop.itemKey}" has max below min.`);
        }
    }
    if (kind === 'equipment' && data.kind === 'consumable' && !data.consumable) warnings.push('A consumable item needs a consumable effect object.');
    if (kind === 'skill') {
        if (data.type === 'heal' && !Number(data.power ?? 0)) warnings.push('A heal skill has no power value; healing will depend only on the caster stat.');
        if (data.type === 'buff' && !data.effects?.buff) warnings.push('A buff skill needs effects.buff {stat, amount, duration}.');
        if (data.category === 'passive' && !Object.keys(data.passive?.modifiers ?? {}).length) warnings.push('A passive skill needs at least one passive.modifiers entry.');
    }
    if (kind === 'class' && (!data.baseStats?.maxHp || !data.baseStats?.maxMp)) warnings.push('baseStats should use maxHp and maxMp (not hp/mp).');
    if (kind === 'rules') {
        for (const [name, formula] of Object.entries(data.formulas ?? {})) {
            if (/=>|function|eval|`/.test(String(formula))) warnings.push(`Formula "${name}" looks like code. Use engine arithmetic only.`);
        }
    }
    if (kind === 'story') {
        const nodeKeys = new Set((data.nodes ?? []).map((node) => node.key));
        if (!nodeKeys.size) warnings.push('A story needs at least one node.');
        if (data.startNodeKey && !nodeKeys.has(data.startNodeKey)) warnings.push('startNodeKey does not match any node key.');
        if (!(data.endings ?? []).length) warnings.push('A story needs at least one ending node key.');
        for (const ending of data.endings ?? []) {
            if (!nodeKeys.has(ending)) warnings.push(`Ending "${ending}" does not match any node key.`);
        }
        const badEdges = (data.edges ?? []).filter((edge) => !nodeKeys.has(edge.from) || !nodeKeys.has(edge.to));
        if (badEdges.length) warnings.push(`${badEdges.length} edge(s) reference a node key that is not declared in this story.`);
        if (!(data.nodes ?? []).some((node) => node.type === 'branch')) warnings.push('This story has no branch node; the choice will not be meaningful.');
    }
    return warnings;
}
