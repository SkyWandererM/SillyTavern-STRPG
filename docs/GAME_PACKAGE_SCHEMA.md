# STRPG Game Package Schema

Formal JSON Schema:

[`schema/strpg-game-package.schema.json`](../schema/strpg-game-package.schema.json)

Example:

[`examples/emberfall.game-package.json`](../examples/emberfall.game-package.json)

The runtime also validates with Zod (`plugins/strpg/src/schemas.js`) and cross-reference checks (`validation.js`). JSON Schema is for editors and external tools, not the only validation layer.

## 1. Top level

```json
{
  "schema": "strpg.game-package",
  "schemaVersion": 1,
  "meta": {
    "id": "project-id",
    "name": "Game Name",
    "title": "Display Name",
    "version": "1",
    "author": "STRPG Studio",
    "description": "..."
  },
  "world": { },
  "locations": [ ],
  "events": [ ],
  "classes": [ ],
  "npcs": [ ],
  "monsters": [ ],
  "items": [ ],
  "skills": [ ],
  "effects": [ ],
  "quests": [ ],
  "story": { },
  "rules": { },
  "start": { "locationKey": "...", "storyNodeKey": "..." },
  "integrations": { }
}
```

Required:

- `schema` is `strpg.game-package`
- `schemaVersion` is `1`
- `meta`, `world`, `locations`, `classes`, `story`, `rules`

## 2. World

```json
{
  "key": "emberfall",
  "name": "Emberfall Frontier",
  "description": "...",
  "startLocationKey": "mistfall_town",
  "lore": "...",
  "tags": ["frontier"]
}
```

- `startLocationKey` must exist in `locations`.
- A package has exactly one world.
- A world asset must not include a `locations` array or `connections`; those belong to Scene assets.

## 3. Location / Scene

```json
{
  "key": "greenwood_edge",
  "name": "Greenwood Edge",
  "type": "forest",
  "region": "Mistwood",
  "description": "...",
  "map": { "x": 360, "y": 250 },
  "discoveredByDefault": false,
  "connections": [
    { "toKey": "mistfall_town", "travelCost": 0, "bidirectional": true, "label": "Road back to town" },
    { "toKey": "greenwood_deep", "travelCost": 0, "bidirectional": true, "label": "Deeper into the woods" }
  ],
  "spawnPoints": [{ "key": "forest_path", "x": 360, "y": 250, "label": "Forest path" }],
  "eventKeys": ["shrine_discovery"],
  "randomEncounter": { "enabled": true, "chance": 1, "dice": { "count": 2, "sides": 6 }, "difficulty": 8, "cooldownSeconds": 60, "monsters": [{ "monsterKey": "forest_goblin", "count": 1 }] },
  "encounters": [
    {
      "key": "goblin_patrol",
      "name": "Goblin Patrol",
      "monsters": [{ "monsterKey": "forest_goblin", "count": 2 }]
    }
  ],
  "tags": ["wilderness"]
}
```

Rules:

- `map` is display-only.
- `connections` is the movement authority.
- Bidirectional connections expand to two directed edges during materialization.
- Connection conditions use structured `condition`.
- Encounter monster keys must exist.
- `layer`: `world | region | settlement | interior | room | dungeon | floor`.
- `parentKey` expresses map hierarchy; it does not create travel by itself.
- `connections[].mode`: `road | trail | walk | door | stairs | gate | portal | secret`.
- `connections[].entryKey` names a destination `spawnPoints[].key`.
- `randomEncounter` is optional; the engine rolls a joint party/danger check.
- `eventKeys` references optional top-level Event assets.
- A scene must not define a `world`, story `nodes`, or a `locations` array.
- `scene.events` remains readable as legacy inline actions; new content uses Event assets.

### 3.1 Event

```json
{
  "key": "shrine_discovery",
  "name": "The Shrine Wakes",
  "description": "The Ember Sigil answers the player arrival.",
  "scope": "scene",
  "sceneKey": "old_shrine",
  "trigger": "enter",
  "targetKey": null,
  "priority": 0,
  "once": true,
  "condition": {},
  "actions": [{ "type": "set_flag", "key": "shrine_found" }],
  "tags": ["story"]
}
```

- `scope`: `world` | `scene` | `story`.
- `trigger`: `enter` | `interact` | `flag` | `quest` | `combat_victory` | `manual`.
- A `scene` event requires `sceneKey`, and the scene must list its key in `eventKeys`; the engine ignores unreferenced scene events.
- `once` state is stored per Campaign in `campaign_variables`.
- Implemented dispatch: `enter`, `interact`, `combat_victory`, `manual` (`POST /campaigns/:id/events/:eventKey/trigger`). `flag` and `quest` are reserved trigger names.
- `world` assets must not contain `locations` or `connections`; use Scene assets.

## 4. NPC

```json
{
  "key": "elder_mira",
  "name": "Elder Mira",
  "kind": "npc",
  "title": "Ember Warden",
  "description": "...",
  "personality": "...",
  "motivation": "...",
  "locationKey": "mistfall_town",
  "interactions": [
    { "key": "talk", "label": "Talk", "type": "talk", "dialogue": ["..."] },
    {
      "key": "accept_main",
      "label": "Accept quest",
      "type": "accept_quest",
      "questKey": "main_sigil",
      "condition": { "questKey": "main_sigil", "questStatus": "available" }
    },
    {
      "key": "turn_in_main",
      "label": "Report",
      "type": "turn_in_quest",
      "questKey": "main_sigil",
      "condition": { "questKey": "main_sigil", "questStatus": "ready_to_turn_in" }
    }
  ],
  "shop": null,
  "questsOffered": ["main_sigil"],
  "joinable": false
}
```

Interaction types:

```text
talk | shop | accept_quest | turn_in_quest | join_party | heal | story | custom
```

## 5. Monster

```json
{
  "key": "forest_goblin",
  "name": "Forest Goblin",
  "level": 2,
  "stats": {
    "maxHp": 50, "maxMp": 5, "str": 9, "agi": 8, "int": 4, "vit": 6, "luck": 4,
    "atk": 9, "def": 4, "res": 2, "hit": 85, "evade": 6, "crit": 5
  },
  "skills": ["power_strike"],
  "resistances": { "fire": -0.2 },
  "exp": 35,
  "gold": 18,
  "drops": [{ "itemKey": "herb", "chance": 0.9, "min": 1, "max": 2 }],
  "ai": "aggressive"
}
```

Resistances are `-1..1`. Positive values reduce damage.

## 6. Item

```json
{
  "key": "iron_sword",
  "name": "Iron Sword",
  "kind": "weapon",
  "description": "...",
  "rarity": "common",
  "price": 120,
  "stackable": false,
  "maxStack": 1,
  "slot": "weapon",
  "stats": { "atk": 8, "hit": 5 },
  "effects": {},
  "classRestrictions": ["adventurer"]
}
```

Kinds:

```text
weapon | armor | accessory | consumable | quest | material
```

Equippable items need a `slot` and `stackable=false`.

## 7. Skill

```json
{
  "key": "power_strike",
  "name": "Power Strike",
  "category": "active",
  "type": "attack",
  "target": "single",
  "mpCost": 3,
  "cooldown": 0,
  "element": "physical",
  "power": 9,
  "formula": "max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult))",
  "effects": {
    "applyStatus": { "effectKey": "burn", "chance": 0.4, "duration": 2 }
  },
  "unlockLevel": 1,
  "classes": ["adventurer"]
}
```

Formula functions:

- numbers and variables
- `+ - * / % ^ **`
- `min max round floor ceil abs sqrt pow clamp`

## 8. Quest

```json
{
  "key": "main_sigil",
  "name": "The Ember Sigil",
  "type": "main",
  "description": "...",
  "level": 1,
  "prerequisites": [],
  "start": { "type": "npc", "npcKey": "elder_mira" },
  "turnIn": { "npcKey": "elder_mira" },
  "completion": "turn_in",
  "stages": [
    {
      "key": "investigate",
      "name": "Investigate the Forest Edge",
      "mode": "all",
      "objectives": [
        { "key": "reach_edge", "type": "visit", "targetKey": "greenwood_edge", "count": 1 },
        { "key": "kill_goblins", "type": "kill", "targetKey": "forest_goblin", "count": 2 }
      ]
    }
  ],
  "rewards": {
    "exp": 120,
    "gold": 100,
    "items": [{ "itemKey": "moonstone_charm", "quantity": 1 }],
    "skills": [],
    "flags": ["sigil_restored"]
  },
  "nodes": [
    { "key": "start", "title": "Accept", "type": "start" },
    { "key": "done", "title": "Complete", "type": "end" }
  ],
  "edges": [{ "key": "q1", "from": "start", "to": "done" }]
}
```

Objective types:

```text
kill | collect | talk | visit | flag | level | combat_win
```

Stage completion:

- `mode: "all"` — every objective (default)
- `mode: "any"` — any objective, for multi-path completion

Rules:

- `completion=turn_in` requires `turnIn.npcKey`.
- On acceptance, already satisfied `collect / level / flag` objectives complete automatically.
- Prerequisites must not form a cycle.

## 9. Story

```json
{
  "key": "ember_sigil_story",
  "name": "The Ember Road",
  "startNodeKey": "prologue",
  "endings": ["ending_ember"],
  "variables": { "sigil_restored": false },
  "nodes": [
    {
      "key": "prologue",
      "title": "A Frontier Morning",
      "type": "scene",
      "sceneKey": "mistfall_town",
      "text": "...",
      "map": { "x": 80, "y": 100 }
    }
  ],
  "edges": [
    {
      "key": "p_to_town",
      "from": "prologue",
      "to": "town_arrival",
      "label": "Walk to the square",
      "condition": {},
      "manual": false
    }
  ]
}
```

Validation:

- start exists
- endings exist
- every non-ending node has an outgoing edge
- every node is reachable from start
- at least one ending is reachable

## 10. Class

```json
{
  "key": "adventurer",
  "name": "Frontier Adventurer",
  "baseStats": { "maxHp": 120, "maxMp": 40, "str": 14, "agi": 10, "int": 10, "vit": 12, "luck": 8 },
  "growth": { "maxHp": 18, "maxMp": 6, "str": 2.2, "agi": 1.6, "int": 1.5, "vit": 2, "luck": 1.1 },
  "startingItems": [{ "itemKey": "iron_sword", "quantity": 1 }],
  "startingSkills": ["power_strike"],
  "skillTree": [{ "level": 3, "skillKey": "fireball" }]
}
```

## 11. Rules

```json
{
  "levelCap": 30,
  "startingGold": 80,
  "statCaps": { "maxHp": 9999, "maxMp": 999 },
  "formulas": {
    "physicalDamage": "max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult))",
    "magicalDamage": "max(1, round((mag * 1.7 + power) * (100 / (100 + res)) * variance * critMult))",
    "heal": "max(1, round(mag * 1.4 + power))",
    "hitChance": "clamp(0.75 + (hit - evade) * 0.01, 0.05, 0.95)",
    "critChance": "clamp(0.05 + luck * 0.005, 0.01, 0.5)",
    "fleeChance": "clamp(0.5 + (agi - enemyAgi) * 0.01, 0.1, 0.9)",
    "expToNext": "round(20 * pow(level, 1.55))"
  },
  "expTable": [],
  "enemyScaling": { "hp": 1, "atk": 1 },
  "saveEveryCombatAction": true
}
```

`expTable` takes priority over the `expToNext` formula.

## 12. Condition

```json
{
  "all": [ ],
  "any": [ ],
  "not": { },
  "flag": "forest_seen",
  "questKey": "main_sigil",
  "questStatus": "active",
  "itemKey": "herb",
  "itemCount": 3,
  "level": 3,
  "locationKey": "greenwood_edge",
  "variable": { "key": "choice_a", "op": "eq", "value": true },
  "storyNodeKey": "town_arrival"
}
```

`all` is AND, `any` is OR, `not` negates.

## 13. Action

```json
{ "type": "set_flag", "key": "forest_seen" }
{ "type": "set_variable", "key": "choice_a", "value": true }
{ "type": "give_item", "itemKey": "healing_herb", "amount": 2 }
{ "type": "accept_quest", "questKey": "main_sigil" }
{ "type": "teleport", "locationKey": "old_shrine" }
{ "type": "heal", "amount": 9999, "mp": 9999 }
```

## 14. Import and build rules

### Import

`POST /projects/:id/import-package`:

- validates the Game Package
- creates a new project
- stores every asset as DRAFT
- requires validation, review, and publish before building

### Build

`POST /projects/:id/build`:

- takes the latest PUBLISHED revision per key
- assembles a package
- validates
- materializes definition rows
- saves a draft game version

### Publish

`POST /versions/:id/publish`:

- draft only
- validates again
- makes the version available to new Campaigns

## 15. Validate the example with JSON Schema

```js
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = JSON.parse(fs.readFileSync('schema/strpg-game-package.schema.json'));
const pkg = JSON.parse(fs.readFileSync('examples/emberfall.game-package.json'));
const validate = ajv.compile(schema);
console.log(validate(pkg)); // true
```


