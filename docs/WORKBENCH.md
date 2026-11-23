# World Workbench

The **Workbench** is the RPG resource and content management surface in Studio.

It is designed around a file tree rather than a flat asset table:

```text
Project
└─ World
   ├─ Region
   │  ├─ Settlement
   │  │  ├─ Interior
   │  │  │  └─ Room
   │  └─ Dungeon
   │     └─ Floor
   ├─ NPCs
   ├─ Events
   ├─ Quests
   ├─ Monsters
   ├─ Items
   ├─ Skills
   ├─ Classes
   ├─ Rules
   ├─ Effects
   └─ Stories
```

Scenes are nested by `parentKey`; other content types are grouped in folders. Every item in the tree is a real Studio asset, not a separate unreviewed copy.

## 0. RPG database toolbar

The Workbench is laid out like an RPG Maker database rather than a raw JSON browser:

- **Header**: project counts, `New DRAFT` palette (all 12 content kinds), `Generate with AI`, `Import Entry`, `Images`, `Chat Character`.
- **Database bar**: one filter chip per content kind with counts, plus free-text search over name, key and status.
- **World tree**: expand/collapse, `+ Area` to create a child scene, drag-and-drop parenting, inline spawn toggle.
- **Entry header**: lifecycle stepper `DRAFT → VALIDATION → REVIEWED → PUBLISHED`, asset key/revision, and gated actions. `AI Rewrite` and `Duplicate` sit beside the lifecycle buttons.
- **Entry tabs**: human fields, Connections/Node Graph, and raw JSON. `Save DRAFT`, `Validate`, `Approve` and `Publish` stay gated by the current status.

`New DRAFT` creates the canonical template for the selected kind, attaches it to the selected scene where that makes sense (NPC location, event scene, child scene parent), makes the key unique and selects the new DRAFT.

## 1. Tree and hierarchy

- Click a scene to edit it.
- Drag a Scene onto another Scene to change its parent.
- Drag an NPC onto a Scene to set `locationKey`.
- Drag an Event onto a Scene to set `scope: "scene"` and `sceneKey`.
- The tree prevents moving a Scene under its own descendant.
- Published assets are edited through a new DRAFT revision.

The tree is not the same thing as movement:

```text
parentKey      map ownership / grouping
connections    actual travel
```

A parent link alone does not make a destination reachable.

## 2. Entry editor

The **Entry** tab provides human-editable fields:

- name, immutable key, description, tags
- scene layer, type, parent, map coordinates
- NPC location
- Event scope / scene / trigger
- Quest type / level
- **JSON** tab for advanced structured fields

The **Contains** panel for a Scene shows:

- child scenes
- NPCs at the scene
- events bound to the scene
- quests starting or turning in there
- fixed encounters
- random encounter state


## 2b. Tree quick actions

Every Scene row has two inline buttons:

- **+** creates a child area with the next likely layer:
  ```text
  region -> region
  settlement -> interior
  interior -> room
  room -> room
  dungeon -> floor
  floor -> floor
  ```
  The child starts as a DRAFT with `parentKey` set but no connection. Connect it from the Connections tab.
- **S** toggles `isSpawn` for that scene. White S = not a spawn point; gold S = marked spawn point. Only one spawn point is allowed per layer; selecting a new one clears the previous flag on that layer. This is a design flag, not a second movement edge.

## 2c. Site type

`layer` is structural. `siteType` describes gameplay:

```text
indoor     buildings, shops, interiors
town       outdoor settlements
wilderness forests, plains, mountains, coasts
dungeon    dungeons and floors
```

Only **wilderness** and **dungeon** allow random encounters. Towns and interiors may still have fixed encounters, story battles, NPCs and quests, but random encounter rolls return `site_type` and the validator rejects an enabled random encounter on a town/indoor scene.

If `siteType` is missing, it is inferred from legacy `type` and `layer`.

## 2d. Detailed resource editors

The Entry tab now exposes specialized editors:

- **NPC**: functions/interactions (talk, shop, accept quest, turn in quest, join, heal, story, custom), shop item list, offer list
- **Monster**: level, HP, ATK, DEF, EXP, gold, drops
- **Equipment**: item kind, slot, price, rarity
- **Skill**: active/passive, type, MP cost, cooldown
- **Status Effect**: buff/debuff/dot/control, duration
- **Quest**: type, level
- **Scene**: layer, site type, spawn flag, fixed encounters, random encounter, monsters, child/contains summary

Quest folder is split into Main / Side / Hidden. Items are split into Weapons / Armor / Accessories / Consumables / Key Items / Materials.


## 2g. Important NPCs and SillyTavern characters

An NPC has an **Important NPC** switch and a **Quick Replies** button. Quick Replies writes a named SillyTavern Quick Replies set through `/api/quick-replies/save`; it does not create a second dialogue system inside STRPG.

When it is **important**, the NPC editor shows **Import to Tavern**.

Pressing it calls the plugin route `POST /assets/:id/tavern-import`, which:

1. builds a Character Card V2 payload from the NPC
2. calls SillyTavern's own `/api/characters/create` using the current browser session cookie and CSRF token
3. creates the character with SillyTavern's default avatar
4. returns the avatar filename

The card maps:

- name → `ch_name`
- title + description → description
- personality + motivation → personality
- first interaction dialogue → `first_mes`
- interactions dialogue → `mes_example`
- locationKey → scenario fallback
- tags → character tags plus `strpg`

Only NPCs with `important: true` are allowed. The backend rejects others with `NPC_NOT_IMPORTANT`.

If the NPC is DRAFT, the avatar/import date is stored in `npc.tavern`. Published NPCs can still be imported, but the immutable asset is not modified.


## 2e. Missing references and placeholders

Reference lists (shop items, monster drops, scene monsters, random monsters) have an **Ensure ...** button.

If the referenced key does not exist, the Workbench asks for confirmation and creates a placeholder DRAFT of the correct kind. You can then open that entry and complete it, or rename it.

## 2f. Rename / refactor

A DRAFT entry has a **Rename** button. Renaming:

- changes `asset_key` and `data.key`
- updates known key-reference fields in other latest assets
- resets modified referenced assets to DRAFT
- blocks when a PUBLISHED asset references the old key

The backend route is `POST /assets/:id/rename`.


## 3. Connections graph

For a Scene, the **Connections** tab shows all scenes as draggable visual nodes and draws their current connections.

1. Click **Connect Scenes**.
2. Click the source node.
3. Click the target node.
4. Choose mode, travel cost and bidirectional.
5. Create Connection.

**Disconnect** mode removes the edge between two scenes. The Workbench removes the reference from both scenes when it exists, then saves new DRAFT revisions as needed.

The connection is stored on the source Scene asset. A published source gets a new DRAFT revision and still needs validation, review and publication.

Edges are drawn once per pair: gold for one-way, teal with arrows at both ends for bidirectional. Graph text is non-selectable while dragging.

For Story and Quest assets, the Workbench embeds the existing **NodeGraphEditor**:

- drag nodes
- connect nodes
- edit conditions/actions
- auto-layout
- validation
- save to DRAFT

## 4. Quick Entry / World Writer

**Import Entry** opens a human-readable importer:

```text
Type: scene
Key: mossy_hollow
Name: Mossy Hollow
Parent: greenwood
Layer: region
Tags: forest, hidden

Description:
A damp hollow where the canopy closes...
```

The parser fills only known fields. Unlabeled lines go to `designerNotes` instead of disappearing.

Select the asset type (Scene, NPC, Monster, Quest, Item, Skill, Event, Story) before generating. This changes the Entry template and the World Writer prompt, so a Monster request does not drift into a town description.

**Expand with LLM** calls SillyTavern `generateQuietPrompt` using the World Writer system prompt:

- expands the user's idea into one Entry Card
- uses human-readable labels, not JSON
- does not write to the database
- does not auto-publish

You can edit the generated text before **Parse and Create DRAFT**.

Unknown or unsupported fields are kept in notes; a single incompatible line does not discard the entry.

## 5. Batch image import

**Import Images** accepts a whole folder.

Filename convention:

```text
category_name_status-or-level.ext
```

Examples:

```text
npc_elder_mira_3.png
scene_mistfall_town.png
event_glade_awakening.png
item_iron_sword_rare.png
monster_forest_goblin_lv2.png
```

Matching:

- first token = category alias
- middle tokens = slug of asset key or name
- trailing number / `lvN` / status word = optional image level/status

Supported categories:

```text
npc, scene, event, quest, item, equipment, skill, monster, class,
world, rules, effect, story
```

Images are attached as:

- `npc.portrait`
- `scene.image`
- other kinds: `image`

Published assets receive a new DRAFT revision. Unmatched files are reported as **skipped**, not imported into a wrong asset.

Image limit: 3 MB per file (`fileToDataUrl`).

This is intended for later ComfyUI batch output. ComfyUI is not required by the importer.

## 6. Lifecycle

The Workbench edits **authoring content**; it does not bypass the content lifecycle.

```text
Edit DRAFT
→ Validate
→ Approve
→ Publish
→ Build Version
→ Publish Version
```

Published content is immutable in place. Saving a published entry creates a DRAFT revision.


## Delete

DRAFT, VALIDATION and REVIEWED assets have a **Delete** button in the Entry toolbar.

- Keyboard: select an entry in the tree, then press `Delete` or `Backspace`.
- Deleting the current DRAFT revision is permanent.
- If an older PUBLISHED revision exists, only the selected DRAFT revision is removed; the published version remains in existing game versions.
- PUBLISHED assets cannot be deleted from the immutable history. To remove one from the game, omit it from the next version and publish that version.

The backend route is `DELETE /assets/:id` and rejects PUBLISHED assets with `PUBLISHED_ASSET_IMMUTABLE`.

## 8. AI content generation

`Generate with AI` (header) and `AI Rewrite` (entry toolbar) open the same
interface:

1. **Content type** — NPC, scene, quest, monster, item, skill, event, story,
   class, status effect, world or rules.
2. **Preset prompt** — 30+ recipes such as Quest Giver, Merchant, Companion,
   Wilderness Area, Dungeon, Main Story Beat, Boss, Consumable, Passive Skill.
   Selecting one fills the designer prompt; every word stays editable.
3. **Context** — tone, level band, anchor scene and optional reference keys.
   The compiled prompt also carries the world name, known scene keys and, for
   `AI Rewrite`, the current DRAFT.
4. **Generate** — calls SillyTavern `generateQuietPrompt` with a strict JSON
   contract. The player's configured model, connection and preset are used;
   STRPG has no provider of its own.
5. **Review** — the reply is parsed to one JSON object, merged onto the
   canonical template, given a unique key, and shown as a field summary plus
   readiness warnings. The raw JSON is editable before creation.
6. **Create DRAFT** — writes through `POST /projects/:id/assets`. Nothing is
   published. `AI Rewrite` only applies the result to the open editor, so the
   designer must still Save, Validate, Approve and Publish.

Fallbacks:

- `Blank template` seeds the editor without calling a model.
- If the model is unavailable, the preview keeps the compiled prompt so it can
  be pasted into chat, and the JSON tab accepts hand-edited content.
- Invalid JSON, a missing `{}` or a truncated reply produces a readable error
  instead of a partial asset write.

## 9. Known boundaries

- Scene graph selection/connection is visual; world movement is still server-validated.
- The scene graph does not yet support freeform node positioning saved to `map.x/map.y`; layout coordinates are edited in Entry fields.
- Image import attaches images to existing assets; it does not create missing assets.
- Quick Entry parses labels only; complex nested conditions/actions should be edited in JSON or a dedicated node editor.
- Batch review/publish is not yet implemented; the existing per-asset review gate still applies.
- Phaser uses these scene coordinates for the exploration map; the Workbench tree is a separate authoring view.
