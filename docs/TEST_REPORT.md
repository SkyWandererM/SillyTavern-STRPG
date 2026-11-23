# STRPG Test Report

Date: 2026-11-22

## 1. Environment

| Item | Value |
|---|---|
| SillyTavern | 1.19.0 |
| Node.js | 24.15.0 |
| SQLite | `node:sqlite` `DatabaseSync` |
| Browser | Microsoft Edge 158 headless |
| Test runner | Vitest 3.2.7 + Supertest 7 |
| Test DB | isolated temp directory per test |
| Acceptance instance | disposable dataRoot + `STRPG_DATA_DIR`, port 8124 |

## 2. Automated tests

Command:

```powershell
npm test 
```

Result:

```text
Test Files  6 passed (6)
Tests       22 passed (22)
```

### Coverage

| File | Tests | Coverage |
|---|---|---|
| `schema.test.js` | 3 | 34 tables, SQLite integrity, seed, idempotent seed, example package validity, event asset in seed |
| `studio.test.js` | 5 | state machine, pre-publish validation, review, immutability, unreachable story, build/publish, package import, kind aliases, world_map expansion, batch import |
| `campaign-flow.test.js` | 6 | full main quest, combat, quest, ending, save, cross-chat, move idempotency, duplicate action, second encounter conflict, shop idempotency, separate event asset fired once, joint-dice random encounter, respawn cooldown |
| `integrations.test.js` | 5 | Tracker whitelist, Memory Books, Map Regions, database backup/restore, error handling |
| `cards-and-package.test.js` | 2 | six PNG cards parsed by SillyTavern, six outputs imported/reviewed/published/built/played |
| `upgrades.test.js` | 1 | module v2 with new location/connection/event/NPC, preview, in-place upgrade, state preservation, new event firing |

### Key assertions

- DRAFT cannot be published directly.
- PUBLISHED cannot be edited in place.
- Full `DRAFT → VALIDATION → REVIEWED → PUBLISHED` flow.
- Unreachable story nodes and dead ends are errors.
- Duplicate combat idempotency keys do not add actions or double-settle.
- A second pending encounter returns 409.
- Tracker payloads containing `hp` or `exp` return 422.
- Restoring a backup after deleting data restores project counts.
- Equipment slot is `weapon`.
- Level-up, skill unlock, gold, EXP, and drops are applied.
- Snapshot restore preserves `level / hp / gold / location / ending`.
- A separate `event` asset fires once on scene entry and records `world.event`.
- Joint party/danger dice create a random encounter; victory starts a respawn cooldown and the spawn refreshes lazily.
- Campaign upgrade preserves level, gold, inventory and quest state while adding a new scene, event and NPC.
- The upgraded Campaign can enter the new scene, fire its event and find the new NPC.

## 3. End-to-end acceptance

Command:

```powershell
node scripts/verify-e2e.mjs http://127.0.0.1:8124
```

Result:

```text
23/23 steps passed
Report: docs/acceptance-report.json
```

Coverage:

1. Import Game Package → 31 DRAFT assets
2. validate → review → publish every asset
3. build → publish
4. create Campaign
5. bind chat A
6. enter starting location
7. talk / accept quest
8. move to the forest
9. create encounter
10. start combat
11. complete attack rounds
12. victory settlement
13. EXP/gold/drops/level
14. quest stage progress
15. return to town / talk / turn in
16. story ending
17. manual snapshot
18. bind chat B
19. restore snapshot
20. state consistency
21. Tracker whitelist mirror
22. Memory Books summary export
23. event log verification

Detailed checklist: [ACCEPTANCE.md](ACCEPTANCE.md).

## 4. Browser UI tests

Playwright Core + local Microsoft Edge headless:

```text
root mounted
launcher count 1
shell count 1
```

| Tab | Result |
|---|---|
| Dashboard | ✅ world, Campaign, HP/MP/EXP, gold, equipment, location, story |
| World Map | ✅ SVG, zoom, region filter, routes, movement, encounter buttons |
| Characters | ✅ player, attributes, party, NPC cards, interaction modal |
| Inventory | ✅ equipment slots, item cards, equip/unequip, use |
| Skills | ✅ active/passive/locked, MP/CD/formula |
| Quests | ✅ filters, objective progress, accept/turn in |
| Combat | ✅ standalone full-screen pending/active/result |
| Story | ✅ Story Graph, node detail, manual branches, ending |
| Studio | ✅ projects, content list, JSON editor, node graph, versions, import |
| Settings | ✅ backups, snapshots, tokens, adapters, tool protocol |
| Campaign Upgrade | ✅ Dashboard panel, version diff, blockers, in-place upgrade, preserved progress |
| Phaser Map | ✅ canvas, layer-aware nodes, linked exits, click selection, zoom/pan |

Screenshots:

- `docs/screenshot-dashboard.png`
- `docs/screenshot-map.png`
- `docs/screenshot-map-forest.png`
- `docs/screenshot-characters.png`
- `docs/screenshot-inventory.png`
- `docs/screenshot-skills.png`
- `docs/screenshot-quests.png`
- `docs/screenshot-combat-pending.png`
- `docs/screenshot-combat-active.png`
- `docs/screenshot-combat-result.png`
- `docs/screenshot-chat-alert.png`
- `docs/screenshot-story.png`
- `docs/screenshot-studio.png`
- `docs/screenshot-asset-editor.png`
- `docs/screenshot-graph.png`
- `docs/screenshot-world-graph.png`
- `docs/screenshot-versions.png`
- `docs/screenshot-upgrade.png`
- `docs/screenshot-map-phaser.png`
- `docs/screenshot-class-builder.png`
- `docs/screenshot-rules-compiler.png`
- `docs/screenshot-random-encounter.png`
- `docs/screenshot-workbench.png`
- `docs/screenshot-chat-dock.png`
- `docs/screenshot-tavern-import.png`
- `docs/screenshot-workbench-story.png`
- `docs/screenshot-workbench-graph.png`
- `docs/screenshot-entry-import.png`
- `docs/screenshot-memory.png`

### Browser console

STRPG itself produced no `pageerror` or console error.

SillyTavern's Stable Diffusion extension requests ComfyUI endpoints when ComfyUI is not configured:

```text
/api/sd/comfy/samplers
/api/sd/comfy/models
/api/sd/comfy/schedulers
/api/sd/comfy/vaes
```

These return 500. This is expected for an unconfigured external extension and is unrelated to STRPG.

## 5. Character card verification

```js
import { read } from './src/character-card-parser.js';
const json = JSON.parse(read(fs.readFileSync('cards/strpg-card-01-npc-designer.png')));
```

All six pass:

```text
chara_card_v2
STRPG Card 01 · NPC Designer
STRPG Card 02 · Equipment Designer
STRPG Card 03 · Skill Designer
STRPG Card 04 · Scene Designer
STRPG Card 05 · Story Architect
STRPG Card 06 · Quest Designer
```

The `chara` chunk matches the JSON.

## 6. Game Package JSON Schema

```powershell
node validate-schema.mjs
# valid true
```

- `schema/strpg-game-package.schema.json`
- `examples/emberfall.game-package.json`
- Ajv 2020-12, `strict:false`, no errors.

The runtime also uses Zod and cross-reference validation.

## 7. Build artifacts

```text
data/<user>/extensions/strpg/index.js   ~7.0 MB
data/<user>/extensions/strpg/style.css   ~59 KB
plugins/strpg/                                           backend
STRPG-1.0.0.zip                                          ~13.0 MB
```

Build:

```powershell
node build.mjs
node package.mjs
```

## 8. Database verification

```powershell
node plugins/strpg/bin/strpg-cli.js verify
```

```json
{
  "ok": true,
  "schemaVersion": 3,
  "tables": 34,
  "integrity": "ok"
}
```

## 9. Limitations

- No long soak test (hours of continuous combat).
- No multi-user concurrent Studio write stress test.
- Actual LLM generation quality depends on the user's model; tests cover tool proposals and state handoff.
- No full WCAG accessibility audit.
- No physical mobile device touch test; responsive breakpoints exist.
- External integrations are explicit adapters and do not cover every UI feature of those extensions.

## 10. Conclusion

- The engine, Studio, six cards, example game, database, combat, quests, story, saves, cross-chat recovery and modular Campaign upgrades passed automated and browser verification.
- The game loop actually executes and settles.
- External integration and ComfyUI boundaries are clearly marked.





























## 11. STRPG 1.1 UI verification

Added with 1.1.0 and verified against SillyTavern 1.19.0 / Node 24.15.0:

- **Automated**: 39 Vitest cases (9 files), including the new
  `dashboard-state.test.js` aggregate-state test and `generation.test.js`
  prompt/extraction/normalization tests.
- **Browser**: Microsoft Edge headless at 1440×960, real SillyTavern chat with
  55 messages. Verified the chat-side HUD, Adventure panel and its scroll
  sections, Studio header wrapping, Workbench database toolbar, AI modal
  presets and blank-template DRAFT creation.
- **Real model**: SillyTavern custom connection `http://localhost:8123/v1`,
  model `gemma4-it:12b`. A Quest Giver preset generation returned one valid
  NPC JSON object after 145 s, passed extraction/normalization with no
  warnings, and created `npc/archivist_valerius` as a DRAFT with the generated
  scene as `locationKey`.
- **Stubbed model**: a deterministic JSON reply was used to verify the same
  path quickly, including preview summary and DRAFT persistence.
- **Cleanup**: every temporary project created for UI verification was deleted
  through `DELETE /projects/:id`; the live database retained only the original
  two projects and one campaign.

## 12. Director's Room verification (1.2.0)

- Pure tests: `director.test.js` covers state normalization, player-safe memory
  filtering, three-section parsing, spoiler term matching/redaction, role map
  integrity and project-key suggestions.
- Browser (Edge headless, 1440×960, temporary project):
  - 9 role cards and 3 panels render;
  - stubbed Narrator Ask returns player-safe brief, director notes and handoff;
  - Save to memory creates 2 entries (player + director);
  - Record handoff gives the Quest Designer a `1 HANDOFF` inbox badge, and its
    Ask question is prefilled with the handoff text;
  - Player-safe view hides the handoff text;
  - protected term `Sixth Warden` triggers the Spoiler Guard warning, blocks
    Save/Use until **Redact**, and the redacted memory no longer exposes the
    term;
  - **Use brief in AI generator** opens the existing AI modal with the brief in
    the Designer prompt and the role's asset kind selected.
- The temporary project is deleted after each browser run.

## 13. Batch queue verification (1.3.0)

- Pure tests: `buildBatchPlanPrompt`, `parseBatchPlan` (fenced output, duplicate
  key suffixing, table separator skip), batch state normalization, and
  `normalizeGeneratedAsset` locked key/title.
- Browser (Edge headless, temporary project, stubbed model):
  - Quest Designer Batch planner returns 3 rows;
  - Create batch gives 3 editable queue rows;
  - Reserve DRAFTs creates 3 blank quest DRAFTs with the planned keys/titles;
  - Generate next opens the AI modal with the brief and Quest preselected;
  - Create DRAFT keeps the reserved key `sigil_search` and title
    `Search the Shrine` even though the model returned a different key/name;
  - queue status becomes 1 generated + 2 reserved;
  - Auto-advance reopens the generator for `warden_talk` after the save;
  - temporary project deleted afterward.
