# STRPG Developer API

Base URL:

```text
/api/plugins/strpg
```

All requests from the SillyTavern frontend should use:

```js
const ctx = SillyTavern.getContext();
fetch('/api/plugins/strpg/health', { headers: ctx.getRequestHeaders() });
```

POST requests are protected by SillyTavern CSRF. External scripts must GET `/csrf-token`, then send `x-csrf-token` and the session cookie.

Success:

```json
{ "ok": true, "data": { } }
```

Error:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "details": { }
  }
}
```

Export endpoints return raw JSON files.

## 1. Health and metadata

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Plugin, schema, database status |
| GET | `/meta` | Version, content statuses, asset kinds, tools, stats |
| GET | `/published-games` | Versions available for new Campaigns |

## 2. Studio: projects

| Method | Path | Description |
|---|---|---|
| GET | `/projects` | Project list with content counts |
| POST | `/projects` | `{name, description?, metadata?}` |
| GET | `/projects/:id` | Project, assets, versions, Campaign count |
| PATCH | `/projects/:id` | `{name?, description?, status?, metadata?}` |
| POST | `/projects/:id/clone` | Copy latest assets as DRAFT |
| DELETE | `/projects/:id` | 409 if Campaigns exist |
| GET | `/projects/:id/integrity` | Project integrity report |

## 3. Studio: content lifecycle

| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/assets?kind=&status=&revisions=1` | Latest revisions, or all revisions |
| POST | `/projects/:id/assets` | One asset or `{items:[...]}` batch; canonical kinds are world, scene, npc, monster, equipment, skill, quest, story, class, rules, status_effect. Common aliases (world_map, character, item, mission, ...) are normalized; a `world_map` with a `locations` array expands to world + scene assets. DRAFT only. |
| GET | `/assets/:id` | Asset + validation + history + reviews |
| PATCH | `/assets/:id` | DRAFT only; `{data,name?,note?}` |
| POST | `/assets/:id/new-revision` | Copy to next revision as DRAFT |
| POST | `/assets/:id/validate` | Validate; success → VALIDATION |
| POST | `/assets/:id/review` | `{reviewer,decision:'approve'|'reject',note}` |
| POST | `/assets/:id/publish` | REVIEWED → PUBLISHED; stale revision = 409 |

State machine:

```text
DRAFT --validate.ok--> VALIDATION --review.approve--> REVIEWED --publish--> PUBLISHED
  ^                         |                              |
  └------ validate.fail ---┘                              └-- new revision only
```

Publication locks:

- PATCH on non-DRAFT is 409.
- An old revision cannot be published if a newer revision exists.
- Human review accepts only VALIDATION.

## 4. Studio: Game Builder and versions

| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/versions` | Version list |
| POST | `/projects/:id/build` | `{version?,notes?}` builds a draft version |
| GET | `/versions/:id?package=1` | Metadata or full package |
| POST | `/versions/:id/publish` | Publish; available to new Campaigns |
| POST | `/versions/:id/rollback` | Create a new version from a published version |
| GET | `/versions/:id/export` | Download Game Package |
| POST | `/projects/:id/import-package` | `{package,projectName?}` creates a new DRAFT project |

Build rules:

- Each `(kind, asset_key)` uses its highest revision with status `PUBLISHED`.
- Exactly one world, one story, at least one scene, at least one class.
- Missing class/rules use defaults, but explicit assets are recommended.
- Full package validation failure returns 422 with `details.report`.
- Builds are transactional; failures leave no partial version.

## 5. Campaigns

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns` | List |
| POST | `/campaigns` | `{name, gameVersionId?, playerName?, classKey?}` |
| GET | `/campaigns/:id` | Full view (dashboard + map + quests + bindings) |
| PATCH | `/campaigns/:id` | Name / status |
| GET | `/campaigns/:id/dashboard` | Dashboard |
| GET | `/campaigns/:id/events?limit=` | Event log |
| GET | `/campaigns/:id/upgrades` | Published target versions with diff/blockers |
| GET | `/campaigns/:id/upgrades/:versionId/preview` | Preview one target version |
| POST | `/campaigns/:id/upgrade` | `{versionId}` transactional in-place content upgrade |
| GET | `/campaigns/:id/export` | Campaign export (audit) |
| POST | `/campaigns/:id/bind-chat` | `{chatKey,characterName?}` |
| GET | `/chat-bindings/:chatKey` | Find a Campaign by chat key (URL encoded) |
| GET | `/chat-campaigns` | All bindings |
| DELETE | `/chat-bindings/:chatKey` | Remove binding |

Campaign creation:

- accepts only `status='published'` versions;
- instantiates player and NPCs;
- initializes quest instances;
- enters the starting story node;
- saves the first snapshot.

### Campaign content upgrade

Upgrading is an explicit, transactional operation; publishing a version does not mutate a running Campaign.

Preview response:

```json
{
  "currentVersion": { "id": "ver_a", "version": 1 },
  "targetVersion": { "id": "ver_b", "version": 2, "notes": "Moonlit Glade module" },
  "diff": {
    "locations": { "added": [{ "key": "moonlit_glade", "name": "Moonlit Glade" }], "removed": [] },
    "events": { "added": [], "removed": [] },
    "npcs": { "added": [], "removed": [] },
    "quests": { "added": [], "removed": [] },
    "storyNodes": { "added": [], "removed": [] }
  },
  "blockers": [],
  "canUpgrade": true
}
```

`POST /campaigns/:id/upgrade`:

- requires a newer published version in the same project/world;
- blocks pending/active combat;
- blocks removed classes, locations, NPCs, items, skills, effects, quests/stages/objectives, or current story node;
- creates `Before upgrade` and `Upgraded` snapshots;
- remaps campaign state by stable key;
- instantiates new NPCs and quest instances;
- writes `campaign.upgraded`;
- rolls back all changes if any step fails.

See [CAMPAIGN_UPGRADES.md](CAMPAIGN_UPGRADES.md).

## 6. World, map, movement

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/map?region=` | World, locations, connections, current location, regions |
| GET | `/campaigns/:id/location` | Current location |
| GET | `/campaigns/:id/locations` | Locations |
| GET | `/campaigns/:id/locations/:key` | Location detail + NPCs + connections |
| POST | `/campaigns/:id/move/propose` | `{location}` validates only |
| POST | `/campaigns/:id/move` | `{location,idempotencyKey?}` applies movement |
| POST | `/campaigns/:id/events/:eventKey/trigger` | Trigger a manual Event asset; `{targetKey?}` |

Movement checks:

1. target exists;
2. target is not current;
3. a `location_connections` row exists;
4. condition is true;
5. enough gold;
6. deduct travel cost, write discovery, move party;
7. quest `visit`;
8. story `location.enter`;
9. event log + autosave.

## 7. NPCs, shops, quests

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/interactions` | NPC interactions at current location |
| GET | `/campaigns/:id/interactions/:npcKey` | One NPC |
| POST | `/campaigns/:id/interactions/:npcKey/:interactionKey` | Execute interaction |
| GET | `/campaigns/:id/shop/:npcKey` | Shop stock + sell list |
| POST | `/campaigns/:id/shop/:npcKey/buy` | `{itemKey,quantity}` |
| POST | `/campaigns/:id/shop/:npcKey/sell` | `{itemKey,quantity}` |
| GET | `/campaigns/:id/quests` | All quests |
| GET | `/campaigns/:id/quests/:key` | Quest detail |
| POST | `/campaigns/:id/quests/:key/accept` | Accept |
| POST | `/campaigns/:id/quests/:key/turn-in` | Turn in |
| POST | `/campaigns/:id/quests/:key/fail` | Fail |

Interaction types:

```text
talk | shop | accept_quest | turn_in_quest | join_party | heal | story | custom
```

Interaction conditions are structured. Unavailable interactions are returned with `available:false`.

## 8. Inventory, equipment, experience

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/inventory` | Items, equipment, gold |
| POST | `/campaigns/:id/inventory/equip` | `{inventoryId}` |
| POST | `/campaigns/:id/inventory/unequip` | `{slot}` |
| POST | `/campaigns/:id/inventory/use` | `{itemKey}` |
| POST | `/campaigns/:id/inventory/buy` | `{itemKey,quantity}` |
| POST | `/campaigns/:id/inventory/sell` | `{itemKey,quantity}` |
| POST | `/campaigns/:id/experience` | `{amount}` admin/test grant |

Equipment does not overwrite base stats. Final stats are layered.

## 9. Characters, skills, story

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/characters` | Player, party, NPCs |
| GET | `/campaigns/:id/skills` | `{unlocked,all,classKey}` |
| GET | `/campaigns/:id/story` | Current node, graph, available edges, ending |
| POST | `/campaigns/:id/story/choose` | `{edgeKey}` manual branch |

Manual edges (`manual:true`) never auto-advance. The UI shows them as choices.

## 10. Combat

| Method | Path | Description |
|---|---|---|
| POST | `/campaigns/:id/encounters/propose` | `{encounterKey?,monsters:[{monsterKey,count}]}` |
| GET | `/campaigns/:id/encounter-spawns` | Lazy-refreshed scene encounter spawn state |
| POST | `/campaigns/:id/explore` | Joint party/danger dice; may create a random encounter |
| GET | `/campaigns/:id/combat` | Latest combat, including final state |
| GET | `/campaigns/:id/combat/pending` | Pending/active only |
| GET | `/campaigns/:id/combat/context` | LLM narrative context |
| GET | `/combat/:id` | Full combat state |
| POST | `/combat/:id/start` | Roll initiative and start |
| POST | `/combat/:id/action` | Player action |
| POST | `/combat/:id/save` | Manual snapshot |

Encounter proposal validates:

- monster definitions exist;
- counts are 1-8;
- no pending/active combat;
- player HP > 0;
- participant snapshots are created.

Actions:

```json
{ "type": "attack", "targetId": "cp_..." }
{ "type": "skill", "skillKey": "power_strike", "targetId": "cp_..." }
{ "type": "guard" }
{ "type": "item", "itemKey": "healing_herb", "targetId": "cp_..." }
{ "type": "flee" }
```

Idempotency:

```http
Idempotency-Key: combat-<uuid>
```

All combat math is server-side:

- hit / evade
- critical hits
- physical / magical damage
- elemental resistance
- statuses / DOT
- guard
- healing
- death
- victory/defeat
- EXP / gold / drops
- quest / story progression
- autosave

Clients never submit damage.

## 11. Saves and backups

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/saves` | Snapshot list |
| POST | `/campaigns/:id/saves` | `{label}` manual snapshot |
| POST | `/campaigns/:id/saves/:saveId/restore` | Transactional restore |
| GET | `/admin/backups` | Database backup list |
| POST | `/admin/backups` | Create backup `{label}` |
| POST | `/admin/backups/:name/restore` | Restore full database |
| DELETE | `/admin/backups/:name` | Delete file |
| GET | `/admin/database` | Database info |
| POST | `/admin/seed` | `{force:true}` reseed example |

Campaign snapshots contain:

- campaign row
- entities / stats
- inventory / equipment
- entity_skills
- quest_instances
- location_discoveries
- campaign_variables
- status effects
- combat sessions / participants / actions
- narrative_state

Restore runs in a transaction and writes `save.restored`.

## 12. Integration adapters

| Method | Path | Description |
|---|---|---|
| GET | `/integrations` | Adapter status |
| GET | `/campaigns/:id/integrations/tracker` | Narrative mirror + whitelist |
| POST | `/campaigns/:id/integrations/tracker/sync` | `{state:{mood,attitude,...}}` |
| GET | `/campaigns/:id/integrations/memory-books` | Markdown + structured summary |
| GET | `/campaigns/:id/integrations/map-regions/export` | Region metadata |
| POST | `/campaigns/:id/integrations/map-regions/import` | `{regions:[...]}` |

Tracker whitelist:

```text
mood, emotion, attitude, relationship, trust, affection, fear, desire,
thought, summary, narrativeFlags, lastInteraction
```

Any `hp/mp/exp/gold/item/skill` field returns 422.

### Bridge (M1)

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/bridge` | Candidate counts, relation bounds, last apply |
| GET | `/campaigns/:id/bridge/mirror` | Read-only projection for RPG Tracker / lorebook |
| POST | `/campaigns/:id/bridge/tracker/pull` | `{characters:[{name,mood,trust,...}], world:{...}}` → review queue |
| GET | `/campaigns/:id/bridge/candidates?status=PENDING` | Review queue |
| POST | `/campaigns/:id/bridge/candidates/:cid/approve` | Apply one candidate (transaction + audit) |
| POST | `/campaigns/:id/bridge/candidates/:cid/reject` | `{note}` |
| POST | `/campaigns/:id/memory-book/push` | Incremental world book merge (`{dryRun?, replace?, adoptLegacy?}`) |

Semantics:

- Pull never writes state. Whitelisted narrative fields become `bridge_candidates`
  rows (`kind: narrative`) with evidence; `hp/gold/...` are stripped before queueing.
- `strpg_propose_relation` queues `kind: relation`; a single proposal is capped at
  ±2 and clamped to −100…100. Approval is the only write path.
- Applying writes `narrative_state` / `campaign_variables` / `game_events` and a
  `bridge_apply_log` row. Re-approving a non-pending candidate returns 409.
- `memory-book/push` reads the existing book, upserts only `[STRPG]`-marked entries
  and prunes stale ones. Entries written by the old full-replace push have no marker;
  inside the STRPG-named book they are adopted by memo match (`adoptLegacy`, default on).

## 13. LLM tools

| Tool | Purpose | Mutates state |
|---|---|---|
| `strpg_get_status` | Status summary | No |
| `strpg_get_location` | Current location | No |
| `strpg_propose_movement` | Validate movement | No (player confirms) |
| `strpg_propose_encounter` | Validate and create pending combat | Yes, creates pending combat |
| `strpg_get_combat_context` | Combat narrative context | No |
| `strpg_propose_character_reaction` | Record narrative reaction | Audit only, no stats |
| `strpg_get_quest_status` | Quest progress | No |
| `strpg_get_available_interactions` | NPC interactions | No |
| `strpg_get_bridge_mirror` | Read-only state mirror | No |
| `strpg_propose_relation` | Queue an NPC relation change (±2) | No (candidate only) |

```http
POST /tools/strpg_get_status
Content-Type: application/json
x-strpg-tool-token: optional

{ "campaignId": "cmp_..." }
```

Response:

```json
{ "ok": true, "data": { "tool": "strpg_get_status", "result": { } } }
```

If `STRPG_TOOL_TOKEN` is set, the token is required.

## 14. Database tables

34 tables, grouped:

- projects/content: `game_projects`, `content_assets`, `content_versions`, `content_reviews`, `game_versions`
- world: `worlds`, `locations`, `location_connections`, `location_discoveries`
- events: `event_definitions`
- encounters: `encounter_spawns`
- encounters: `encounter_spawns`
- characters: `entity_templates`, `entities`, `entity_stats`
- items: `item_definitions`, `inventory`, `equipment_slots`
- skills: `skill_definitions`, `entity_skills`
- status: `status_effect_definitions`, `status_effect_instances`
- story: `story_nodes`, `story_edges`
- quests: `quest_definitions`, `quest_nodes`, `quest_edges`, `quest_instances`
- combat: `combat_sessions`, `combat_participants`, `combat_actions`
- runtime: `campaigns`, `chat_bindings`, `game_events`, `save_snapshots`, `campaign_variables`
- integrations: `narrative_state`, `tracker_sync_log`, `external_imports`
- infrastructure: `schema_migrations`, `api_idempotency`, `app_settings`

Important writes:

- run in a transaction;
- append `game_events`;
- create an autosave;
- support idempotency keys.

## 15. Security model

- **Input validation**: Zod + cross-reference + numeric range checks.
- **LLM output validation**: tool whitelist, JSON parse, server validation.
- **State writes**: server services only; no SQL endpoint.
- **Permissions**: ST CSRF + optional Studio/Tool token.
- **Idempotency**: `Idempotency-Key` → `api_idempotency`; unique combat action keys.
- **Transactions**: `BEGIN IMMEDIATE`, nested `SAVEPOINT`.
- **Restore**: transaction + `foreign_key_check`, rollback on failure.
- **External extensions**: read-only / explicit JSON / whitelist mirror.

## 16. Extension development entry points

```text
plugins/strpg/src/app.js          routes
plugins/strpg/src/db.js           migrations/backups
plugins/strpg/src/validation.js   schema + cross-reference validation
plugins/strpg/src/combat.js       combat
plugins/strpg/src/studio.js       content lifecycle
frontend/src/App.jsx        React root
frontend/src/components/    pages
```

Adding a content type requires:

1. add a Zod schema and `ASSET_KINDS`;
2. add cross-reference rules;
3. write definition rows in `materializer.js`;
4. merge it in `studio.js`;
5. add a frontend template;
6. add tests.

Adding a combat formula requires:

1. place a safe expression in `rules.formulas`;
2. use only variables/functions supported by `formula.js`;
3. never use `eval` or `new Function`.

See [ARCHITECTURE.md](ARCHITECTURE.md).






