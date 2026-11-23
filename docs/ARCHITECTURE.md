# STRPG Architecture and Tradeoffs

## 1. Overview

```text
SillyTavern Chat
       │ natural language / narration
       ▼
SillyTavern Extension (React bundle)
  ├─ Control Center
  ├─ injects STRPG context into the LLM prompt
  ├─ parses <strpg> tool proposals (whitelist)
  ├─ standalone combat UI
  └─ REST API calls
       │
       ▼
Server Plugin (/api/plugins/strpg)
  ├─ API validation / CSRF / optional token
  ├─ rules engine
  │   ├─ world / movement
  │   ├─ stats / formulas / progression
  │   ├─ inventory / equipment
  │   ├─ quests / story
  │   ├─ combat
  │   └─ settlement
  ├─ Studio lifecycle / builder
  └─ SQLite (node:sqlite)
```

The LLM never performs numeric settlement. Chat logs are not the save. External extensions are not numeric authorities.

## 2. Why `node:sqlite`

The requirement allowed `better-sqlite3` or an equivalent compatible with the current environment.

This environment:

- Node 24.15
- built-in `node:sqlite` available
- `better-sqlite3` not installed and would require a matching native ABI build

Chosen: `node:sqlite`.

Benefits:

- no native build
- no extra dependency risk
- ships with Node
- supports transactions, prepared statements, WAL, foreign keys, integrity checks

Costs:

- Node >= 22.5
- simpler API than better-sqlite3 (no `.transaction()` helper)

`util.js` provides `withTransaction`:

```js
BEGIN IMMEDIATE
  ...
COMMIT / ROLLBACK
```

Nested calls use `SAVEPOINT`, so services compose safely.

## 3. Data separation

### 3.1 Definitions vs runtime instances

```text
game_versions.package_json        immutable content snapshot
        │ materialize
        ▼
worlds / locations / item_definitions / skill_definitions / ...
        │ campaign creation
        ▼
campaigns / entities / inventory / quest_instances / combat_sessions / ...
```

- `entity_templates` are definitions.
- `entities` are Campaign instances.
- One NPC template can be used by many Campaigns with isolated dynamic state.
- `game_version_id` freezes a Campaign to a version.

### 3.2 Content version vs Campaign version

- Content assets have a `revision`.
- Builds create immutable `game_versions`.
- Campaigns reference `game_version_id`.
- Publishing a new version never changes old versions or Campaigns. A Campaign may explicitly attach a newer published version through the transactional Campaign Upgrade path.

### 3.3 World / scene / event separation

- `world` is setting metadata and `startLocationKey` only.
- `scene` is exactly one location, its layout, connections, encounters and `eventKeys`.
- `event` is a separate asset with `trigger`, `condition` and `actions`; the engine dispatches `enter`, `interact`, `combat_victory` and `manual` triggers, with `once` state stored per Campaign.
- `story` is a narrative graph and never contains location definitions.
- `quest` is objectives and rewards only.

The old `world_map` alias is accepted at import and expanded into one `world` plus `scene` assets; a canonical `world` asset with a `locations` array is rejected by validation. `scene.events` remains readable for backward compatibility but new content must use separate `event` assets.

### 3.4 Campaign upgrade

`upgrades.js` maps a Campaign from version A to version B by stable key:

- locations map old location ID → key → target location ID
- inventory/equipment/skills/effects/quests remap definition IDs by key
- existing entities keep their state and are remapped to target templates/locations
- new NPCs are instantiated; new quests become available instances
- discoveries, current location and story node are mapped by key
- a pre-upgrade and post-upgrade snapshot are created
- `campaign.world_id`, `game_version_id`, `current_location_id` and the internal campaign version are updated in one transaction

Blockers prevent unsafe upgrades: active combat, different project/world, removed key used by the save, missing story node. Additive modules are supported by design; destructive edits require a migration strategy before they can upgrade.

### 3.5 Map layers and transitions

- `locations.layer` and `parent_key` express world/region/settlement/interior/room/dungeon/floor.
- `location_connections.mode` (`road`, `trail`, `walk`, `door`, `stairs`, `gate`, `portal`, `secret`) is the transition policy; coordinates never define reachability.
- `spawn_points_json` provides named destination entry points.
- The Phaser 3 canvas is a presentation layer; the server still validates every move.

### 3.6 Exploration and encounters

- `encounter_spawns` stores per-Campaign spawn state; refresh is lazy at read time, so no background timer is required.
- `randomEncounter` on a Scene defines dice (`count`/`sides`), difficulty, chance, monsters and cooldown.
- The joint check compares party `NdS + luck/party bonus` with danger `NdS + difficulty`; the result and combat proposal are logged.
- Victory marks the spawn `defeated` and schedules `respawn_at`; defeat/flee releases it.
- Phaser renders the map but never owns movement/encounter decisions.

## 4. Content lifecycle

```text
DRAFT
  │ validate (schema + structure + graph + numeric checks)
  ▼
VALIDATION
  │ review (reviewer + decision)
  ▼
REVIEWED
  │ publish
  ▼
PUBLISHED
```

Rules:

- only DRAFT is editable
- only VALIDATION is reviewable
- only REVIEWED is publishable
- only the latest revision of a key can be published
- builds use the latest PUBLISHED revision of each key
- editing published content requires `new-revision` → new DRAFT

## 5. Validation

Two layers:

### Asset-level

- Zod field/type/range checks
- duplicate keys
- self/duplicate connections
- Story node/edge references, start, endings, reachability, dead ends
- Quest stage/objective duplicates, turn-in NPC
- safe formula parsing

### Game Package level

- unique keys across assets
- start location
- location connectivity
- NPC location, quest, shop, skill references
- monster skills and drops
- skill class and effect references
- class starting items/skills
- quest prerequisites, objectives, rewards, dependency cycles
- Story scene/node/edge references, ending reachability, dead ends
- formulas and stat caps

Errors block builds. Warnings are displayed.

## 6. Safe formula evaluation

No `eval` or `new Function`.

`formula.js` is a recursive-descent parser supporting:

- numbers
- variables
- `+ - * / % ^ **`
- parentheses
- `min max round floor ceil abs sqrt pow clamp`

Example:

```text
max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult))
```

Formulas are validated at build time and evaluated server-side at runtime.

## 7. Stat layers

```text
base_value
+ permanent_bonus
+ temporary_bonus
+ equipment.stats
+ passives
+ status modifiers
= final primary
→ derived atk / mag / def / res / hit / evade / crit
→ clamp by rules.statCaps
```

Equipment never overwrites `entity_stats.base_value`.

## 8. Combat

### State

- `pending`: proposed, not started
- `active`: in progress
- `victory` / `defeat` / `fled`: final

`combat_sessions` stores round, turn order, current actor, RNG state, and result.

`combat_participants` stores HP/MP, stat snapshots, resistances, statuses, AI, drops, and EXP.

`combat_actions` stores sequence, actor, action, result, and idempotency key.

### Initiative

- agility + d20
- sort descending
- dead actors skipped
- round wraps

### Server-side math

- hit formula
- crit formula
- physical / magical formulas
- resistance `1 - resistance`
- guard halves damage
- DOT, skip, buffs/debuffs
- AI heals low HP, chooses skills, targets low HP
- settlement: EXP, gold, drops, levels, quests, story, snapshot

### Idempotency

- route-level `Idempotency-Key` caches the whole response
- `combat_actions` unique `(session, key)`
- duplicate requests cannot double-damage or double-reward

## 9. Saves

`save_snapshots` stores the full runtime Campaign state.

Autosave triggers:

- Campaign creation
- movement
- NPC interaction
- quest accept/turn-in
- equipment/use/buy/sell
- every combat action
- combat end
- manual save

Restore:

1. begin transaction
2. delete Campaign child tables
3. insert snapshot in dependency order
4. restore Campaign row
5. `foreign_key_check`
6. write `save.restored`
7. commit

Automatic snapshots are pruned to the latest 60.

## 10. External integrations

### 10.1 Memory Books

- reads STRPG data and produces Markdown
- the user pastes it into a Memory Books entry or Side Prompt
- never writes its lorebook/internal DB
- reason: no stable write API; direct writes bypass its transactions, indexing, and rollback

### 10.2 Map Region Locator

- invokes its `/show-map` slash command
- imports/exports region metadata into `locations.data_json.mapRegions`
- never writes its IndexedDB
- regions affect display only, never connections

### 10.3 RPG Tracker

- server-side whitelist mirror and audit log
- never modifies its tracker schema
- reason: its public `window.RPGBridge` manages chat tracker data but offers no stable custom narrative-field write API; direct overwrites would break its lock/history/snapshot logic

## 11. Frontend

- React 18 + esbuild, one ESM bundle
- uses `globalThis.SillyTavern.getContext()` to avoid build-time coupling
- includes CSRF through `getRequestHeaders()`
- CSS scoped under `.strpg-*`
- error boundary per view
- chat integration:
  - extension menu item + launcher
  - `setExtensionPrompt`
  - parse `<strpg>`
  - chat combat entrance
  - combat result written as a system message

### Why bundle React

- SillyTavern does not provide a React runtime to third-party extensions
- avoids version/path conflicts
- single file, no CDN
- about 500 KB

## 12. Known limitations and tradeoffs

1. **Single-process assumption**: SQLite WAL supports concurrent reads, but the server runs synchronous transactions; no multi-process write coordinator.
2. **Studio permissions**: optional token, not deeply tied to ST user roles.
3. **External integrations**: explicit adapters; no external DB writes.
4. **World Graph connections**: edited through Scene JSON to avoid implicit cross-asset writes. Layout is draggable.
5. **ComfyUI**: image fields support Data URLs; generation is not wired.
6. **Campaign import**: Campaign export exists for audit; no cross-database ID remap import.
7. **Combat AI**: basic tactics, not a full tactical AI.
8. **Status effects**: engine supports apply/tick/modifier/skip; Studio has no standalone status-effect graph.
9. **Multiple endings**: supported; the example has one.
10. **Localization**: English UI/content; ASCII keys.

## 13. Source responsibilities

| Path | Responsibility |
|---|---|
| `plugins/strpg/index.js` | plugin registration, DB init, seed, router mount |
| `plugins/strpg/src/app.js` | routes, permissions, errors |
| `plugins/strpg/src/studio.js` | content lifecycle, build, import |
| `plugins/strpg/src/materializer.js` | Package → definition tables |
| `plugins/strpg/src/validation.js` | two-layer validation |
| `plugins/strpg/src/combat.js` | combat state machine and settlement |
| `plugins/strpg/src/campaigns.js` | Campaign, snapshots, chat binding |
| `frontend/src` | React UI source |
| `data/<user>/extensions/strpg` | built extension package |
| `cards` | six character cards |
| `examples` | example game package and card outputs |

## 14. Future work

- localization packs
- combat animation and portraits
- persistent shop stock
- ComfyUI adapter
- multi-process job queue
- Studio user roles
- advanced party/tactical AI
- generated JSON Schema synchronized with Zod


