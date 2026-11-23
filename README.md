# STRPG — SillyTavern RPG Framework(This project is completely built by DeepSeek v4 Flash)

**STRPG** is a complete JRPG framework for SillyTavern. The LLM handles natural language, character performance, and narration. STRPG owns the world, maps, stats, combat, quests, story, equipment, skills, saves, and content production.

The project has two subsystems that share one database and one content standard:

| Subsystem | Location | Responsibility |
|---|---|---|
| **STRPG Engine** | Server Plugin + React Control Center | Run published games: maps, NPCs, quests, turn-based combat, progression, inventory, story, saves, cross-chat recovery |
| **STRPG Studio** | Control Center → Studio | Projects, content import, six editor types, schema validation, human review, version builds, publishing |

## Verified environment

- SillyTavern **1.19.0**
- Node.js **24.15.0**
- SQLite via **`node:sqlite`** (no native build)
- Frontend extension: `data/<user>/extensions/strpg` (served as `/scripts/extensions/third-party/strpg`)
- Server plugin: `plugins/strpg` (deployed from this repository's `plugin/` folder)

## Repository layout

This repository is a standard SillyTavern extension package: its root **is** the extension folder, so `manifest.json`, `index.js` and `style.css` sit at the top level and the extension can be cloned straight into an extensions directory.

| Path | Purpose |
|---|---|
| `manifest.json` / `index.js` / `style.css` | Built frontend extension loaded by SillyTavern |
| `frontend/src/` | React / CSS source |
| `plugin/` | Server plugin source (`index.js`, `src/`, `bin/`), deployed to `<SillyTavern>/plugins/strpg` |
| `cards/` | Six Character Card V2 JSON + PNG cards |
| `examples/` | Emberfall Frontier game package and card outputs |
| `schema/` | Game Package JSON Schema |
| `docs/` | Install, user, developer, architecture and test documents |
| `tests/` | Vitest + Supertest suite |
| `scripts/` | Card generation, example export, end-to-end verifier |

## Quick start

### Requirements

- SillyTavern 1.19.x
- Node.js **>= 22.5** (24.x recommended; `node:sqlite` is required)
- Server plugins enabled:

```yaml
# config.yaml
enableServerPlugins: true
```

This checkout already has `enableServerPlugins: true`. The original config is backed up as `config.yaml.strpg-backup`.

### Install the extension

The extension belongs in the per-user extensions folder, next to `Extension-Dice`, `SillyTavern-MemoryBooks` and the other standard packages:

```text
<SillyTavern>/data/<user>/extensions/strpg/     this repository (manifest.json at the root)
<SillyTavern>/plugins/strpg/                    server plugin (copy of plugin/)
<SillyTavern>/data/strpg/strpg.sqlite           database, created on first start
```

1. Install the extension folder — SillyTavern → Extensions → **Install extension** with `https://github.com/SkyWandererM/SillyTavern-STRPG`, or clone it manually: `git clone https://github.com/SkyWandererM/SillyTavern-STRPG <SillyTavern>/data/<user>/extensions/strpg`. SillyTavern names the folder after the repository (`SillyTavern-STRPG`) when it installs from the URL; a manual clone can use `strpg`. Either folder name works — SillyTavern reads that folder's `manifest.json`.
2. Deploy the server plugin: copy the package's `plugin/` folder to `<SillyTavern>/plugins/strpg`. The `install.ps1` in the ZIP release does this automatically.
3. Install dependencies:

```powershell
npm install --prefix <SillyTavern>/plugins/strpg
npm install --prefix <SillyTavern>/data/<user>/extensions/strpg
```

### Start

```powershell
node server.js
# or Start.bat
```

Expected log lines:

```text
Initializing plugin from ...\plugins\strpg\index.js
[STRPG] Database ready at ...\data\strpg\strpg.sqlite
1 server plugin(s) are currently loaded.
```

On first launch, STRPG seeds a playable example:

- World: **Emberfall Frontier**
- Starting town: **Mistfall Town**
- Forest: **Greenwood Edge / Greenwood Deep**
- Shrine: **Old Ember Shrine**
- 3 NPCs, 2 monsters, 8 items (5 equippable), 5 skills, 3 quests, 1 event, 6 story nodes, 1 reachable ending

Open SillyTavern and click the **STRPG** launcher at the bottom right, or the **STRPG** entry in the extensions menu.

### Content model: separate worlds, scenes, events, stories

- **World** — setting identity, lore, and the starting scene key. No locations.
- **Scene** — exactly one place: layout, connections, encounters, and `eventKeys`.
- **Event** — a reusable trigger + condition + actions. Scene and world triggers are evaluated by the engine; `once` state is per Campaign.
- **Story** — narrative nodes and edges. It references scene keys but never defines locations.
- **Quest** — objectives, stages, rewards.

The legacy `world_map` designer output is expanded on import into one World plus Scene assets. A canonical World asset containing a `locations` array is rejected by validation so the domains cannot silently blur.

### Modular Campaign upgrades

Content is delivered as a new published Game Version; a running Campaign is upgraded through **Adventure → Campaign → Upgrade**. The server previews added Scenes/Events/NPCs/Quests, blocks unsafe upgrades, snapshots the save, then remaps locations, inventory, skills, quests, flags and story state by stable key. New content is attached without resetting progress. See [Campaign Content Upgrades](docs/CAMPAIGN_UPGRADES.md).

### Health check

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/plugins/strpg/health
```

## Repository map

```text
manifest.json                            Extension manifest (repository root)
index.js                                 bundled React extension
style.css

plugin/                                  Server Plugin (authoritative rules engine)
├─ index.js                              SillyTavern plugin entry
├─ src/
│  ├─ app.js                             REST API / errors / permissions
│  ├─ db.js                              SQLite, migrations, backup, restore
│  ├─ schema.js                          34 tables
│  ├─ schemas.js                         Zod content schemas
│  ├─ validation.js                      asset and Game Package validation
│  ├─ materializer.js                    package → normalized definition tables
│  ├─ stats.js / formula.js              stats, progression, safe formulas
│  ├─ world.js / conditions.js           world, movement, conditions
│  ├─ interactions.js                    NPC, shop, quest interactions
│  ├─ quests.js / story.js               quests and story graph
│  ├─ combat.js                          turn-based combat and settlement
│  ├─ inventory.js / campaigns.js        inventory, Campaigns, snapshots
│  ├─ upgrades.js                        transactional Campaign content upgrades
│  ├─ studio.js                          content lifecycle, build, import
│  ├─ integrations.js                    Memory Books / Map Regions / Tracker adapters
│  ├─ tools.js                           LLM tool whitelist
│  └─ seed.js                            example game
└─ bin/strpg-cli.js                      migrate / seed / backup / verify / info

frontend/src/                            React / CSS source
cards/                                   six Character Card V2 JSON + PNG files
examples/emberfall.game-package.json
examples/card-outputs/                   structured outputs for the six cards
schema/strpg-game-package.schema.json
tests/                                   Vitest + Supertest
docs/                                    install, user, developer, test report
build.mjs / package.mjs
scripts/                                 cards, example export, E2E verifier
```

Deployment copies this repository's `plugin/` folder to `<SillyTavern>/plugins/strpg`; the extension files stay in the repository root, which SillyTavern serves as `/scripts/extensions/third-party/strpg`.

## Core rules

1. **STRPG Core is the only numeric authority.** HP, MP, EXP, gold, equipment, skills, inventory, quests, and combat results are modified only by the server rules engine.
2. **The LLM can only propose.** It cannot execute SQL, settle damage, or grant rewards directly.
3. **Saves are independent of chat logs.** Chat is a narrative layer; state lives in SQLite and is restored across chats through `chat_bindings`.
4. **Content is reviewed before publication.** `DRAFT → VALIDATION → REVIEWED → PUBLISHED`. Published content is immutable; editing requires a new revision.
5. **Versions are immutable, upgrades are explicit.** A Campaign starts on one `game_version`. Publishing v2 never mutates an existing Campaign; the player can apply a previewed **Campaign Upgrade** to attach newer published content while preserving the save.
6. **External extensions have no numeric write authority.** Integrations use explicit JSON, side-prompt text, or whitelisted narrative mirrors.

## Feature status (honest)

| Module | Status | Notes |
|---|---|---|
| SQLite schema / migrations | ✅ | 34 tables, transactions, foreign keys, WAL, integrity checks |
| REST API | ✅ | projects, assets, review, versions, Campaigns, maps, NPCs, shops, quests, story, combat, saves, backups, integrations, tools |
| Maps and movement | ✅ | node graph, coordinates, connection conditions, exploration, region filter, zoom/pan, route buttons |
| NPCs / shops / quests | ✅ | condition checks, accept/turn in, buy/sell, party join, relationships, healing |
| Turn-based combat | ✅ | standalone full-screen UI, initiative, attack/skill/guard/item/flee, hit/crit/resistance/status, settlement, mid-combat saves |
| Stats / progression | ✅ | base / permanent / temporary / equipment / passive layers, safe formulas, level cap, skill unlocks |
| Inventory / equipment | ✅ | stacks, unique items, equipment slots, buy/sell, use, drops |
| Quests / story | ✅ | multi-stage, multi-objective, dependency cycle checks, Story Graph, reachable endings |
| Saves / cross-chat | ✅ | autosaves, manual snapshots, restore, backups, chat bindings |
| Studio | ✅ | project CRUD, asset import, lifecycle, review, build, publish, rollback, integrity checks |
| Node graph editor | ✅ | drag, connect, condition/action editing, auto-layout, validation highlights; World layout editing |
| Encyclopedia / list editor | ✅ | list, filters, encyclopedia cards, JSON detail, external image Data URLs |
| Six character cards | ✅ | V2 JSON + PNG with `chara` chunk; parsed by SillyTavern's card parser |
| Game Package | ✅ | schema, import, export, builder, example package |
| Campaign content upgrades | ✅ | Preview vN modules, map state by key, snapshot, transactional in-place upgrade |
| World Workbench | ✅ | RPG database toolbar, kind search/filter, new DRAFT palette, lifecycle stepper, entry editor, scene/story graphs, batch image import, DRAFT delete/rename, important NPC → Tavern card |
| RPG state panel + chat HUD | ✅ | Party, local NPCs, routes, quests, combat roster, effects, inventory and journal beside the chat; collapsible rail refreshes after chat messages |
| AI content generation | ✅ | 12 kinds, 30+ preset prompts, tone/level/scene context, editable compiled prompt, JSON preview, DRAFT-only output through SillyTavern `generateQuietPrompt` |
| Director's Room | ✅ | 9 role-owned content domains, Narrator memory book, blackboard + handoffs, player-safe briefs, protected-term spoiler guard, brief → AI generator prefill, batch queue with reserved keys/titles and locked one-by-one generation |
| Phaser 3 exploration | ✅ | Phaser canvas, layered scenes, local exits, click selection, zoom/pan |
| Class / Rules builders | ✅ | Slider class editor, LLM-assisted Rules compiler, server-side ranges |
| Monster respawn + random encounters | ✅ | Lazy spawn refresh, joint party/danger dice, combat settlement cooldown |
| Automated tests | ✅ | 76 Vitest cases + 23-step end-to-end acceptance |
| Panel layout | ✅ | Movable persisted in-chat status rail (double-click reset), docked panel beside the chat, compact/narrow sidebar, Studio full screen |
| Chat ↔ RPG bridge | ✅ | M1: tracker pull → review → apply, incremental world book, relation proposals. M2: recruit / tuition / recovery / haggling with non-cash receipts, defeat dialogues. M3: memory scopes with manual ingest, service barter settled on quest turn-in. M3.1/M4: character-card → NPC import, character bindings with bound-NPC chat context, per-NPC world books, auto-scan, open_chat switching |
| Memory Books integration | ⚠️ explicit export | Generates summary / Side Prompt text; never writes its internal database |
| Map Region Locator integration | ⚠️ JSON adapter | Calls `/show-map`; imports/exports region metadata, never writes its IndexedDB |
| RPG Tracker integration | ⚠️ whitelist mirror | Server records narrative fields; does not write its tracker schema |
| ComfyUI | ⚠️ reserved | Image fields accept external Data URLs; no generation service yet |
| World Graph connection editing | ⚠️ partial | Layout is draggable; connections are edited through Scene JSON |
| Multi-user Studio permissions | ⚠️ optional token | `STRPG_STUDIO_TOKEN` support; not deeply bound to SillyTavern user roles |

Unimplemented or partial features are marked in the UI and docs. They are not presented as complete.

## Documentation

- [Installation](docs/INSTALL.md)
- [User Guide](docs/USER_GUIDE.md)
- [Developer API](docs/DEVELOPER_API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Game Package Schema](docs/GAME_PACKAGE_SCHEMA.md)
- [Character Cards](docs/CHARACTER_CARDS.md)
- [Test Report](docs/TEST_REPORT.md)
- [Campaign Content Upgrades](docs/CAMPAIGN_UPGRADES.md)
- [World Workbench](docs/WORKBENCH.md)
- [Director's Room](docs/DIRECTOR_ROOM.md)
- [Changelog 1.1.0](docs/CHANGELOG-1.1.0.md)
- [Changelog 1.1.1](docs/CHANGELOG-1.1.1.md)
- [Changelog 1.1.2](docs/CHANGELOG-1.1.2.md)
- [Changelog 1.2.0](docs/CHANGELOG-1.2.0.md)
- [Changelog 1.2.1](docs/CHANGELOG-1.2.1.md)
- [Changelog 1.3.0](docs/CHANGELOG-1.3.0.md)
- [Changelog 1.4.0](docs/CHANGELOG-1.4.0.md)
- [Changelog 1.5.0](docs/CHANGELOG-1.5.0.md)
- [Changelog 1.6.0](docs/CHANGELOG-1.6.0.md)
- [Changelog 1.7.0](docs/CHANGELOG-1.7.0.md)
- [Changelog 1.8.3](docs/CHANGELOG-1.8.3.md)
- [Changelog 1.8.2](docs/CHANGELOG-1.8.2.md)
- [Changelog 1.8.1](docs/CHANGELOG-1.8.1.md)
- [Changelog 1.8.0](docs/CHANGELOG-1.8.0.md)
- [Class and Rules](docs/CLASS_RULES.md)
- [Chat ↔ RPG Bridge (design)](docs/CHAT_BRIDGE.md)
- [Acceptance](docs/ACCEPTANCE.md)
- [JSON Schema](schema/strpg-game-package.schema.json)
- [Example game package](examples/emberfall.game-package.json)

## Commands

All commands run from this repository (the extension directory), e.g. `cd data/<user>/extensions/strpg`.

```powershell
# Backend tests
npm test

# Rebuild frontend (writes manifest.json / index.js / style.css into this directory)
npm run build

# Generate character cards
node scripts/make-cards.mjs

# Database health / backup / seed
node plugin/bin/strpg-cli.js verify
node plugin/bin/strpg-cli.js backup "before update"
node plugin/bin/strpg-cli.js seed

# Full acceptance (running ST; disposable dataRoot recommended)
node scripts/verify-e2e.mjs http://127.0.0.1:8124

# Package a ZIP release into dist/
node package.mjs
```








