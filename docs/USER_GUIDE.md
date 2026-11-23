# STRPG User Guide

## 1. Open the Control Center

When a Campaign is active, STRPG shows a **chat-side status rail** at the right edge of the chat. It shows HP/MP, level, gold, party, the leading quest, routes and any pending combat; `Full` opens the complete panel. The `—` button collapses the rail to a narrow level/HP strip, and the strip's `S` button restores it.

If no Campaign is active, click the **STRPG** launcher at the bottom right, or the **STRPG** entry in the SillyTavern extensions menu.

The full panel is a side panel: the SillyTavern chat stays visible and interactive. Tabs:

1. Adventure
2. World Map
3. Party & People
4. Inventory
5. Skills
6. Quests
7. Combat
8. Chronicle
9. Studio
10. Settings

The top bar selects a Campaign. The close button collapses back to the HUD.

## 2. Create a Campaign

1. Open **Adventure**.
2. Click **Create Campaign**.
3. Choose a published game version. The built-in example is **Emberfall Frontier**.
4. Enter a Campaign name, player name, and class.
5. Leave **Bind the current SillyTavern chat after creation** enabled if desired.

Campaign creation:

- starts on the current `game_version`;
- instantiates the player and NPCs;
- initializes inventory, skills, starting location;
- creates the first autosave;
- places the player in the starting story node.

### Cross-chat recovery

- Each chat can bind one Campaign. One Campaign can bind multiple chats.
- When you switch chats, STRPG reads `chat_bindings` and loads the Campaign Dashboard.
- Chat is only the narrative layer. It is not the save file.
- Use **Dashboard → Bind Current Chat** to bind manually.

### Upgrade a Campaign with new content

A Campaign starts on one Game Version, but it can later receive a newer published version as an in-place content upgrade.

1. Add the new Scene / Event / NPC / Quest in Studio.
2. Revise the existing Scene that needs a new connection or event reference.
3. Validate, review and publish every asset.
4. Build a new Game Version with module notes and publish it.
5. Dashboard → **Content Upgrade** → **Review Upgrade**.
6. Select the target version, inspect additions and blockers.
7. Click **Upgrade to vN**.

Preserved: level, EXP, HP/MP, gold, inventory, equipment, skills, quest progress, flags, story position, discovered locations, NPC relationships and chat bindings.

Added: new locations/connections, event definitions, NPC instances, quest instances and story nodes.

The upgrade creates a **Before upgrade** snapshot and an **Upgraded** snapshot. Active combat and removed content block the upgrade; it never silently drops save data.

See [Campaign Content Upgrades](CAMPAIGN_UPGRADES.md).

## 3. Adventure panel

The Adventure tab is the campaign's game-state sheet:

- scene banner with world, location, layer, site type and campaign status;
- six-cell strip: HP, MP, EXP, gold, party size, active quests;
- **Adventurer** card: portrait, bars, effects, ATK/DEF/RES/CRIT, equipment;
- **Party & People** card: companions with HP, plus local NPCs you can click to talk, trade or recruit;
- **Location** card: description, badges, routes with travel cost and lock state;
- **Danger** card: pending/active combat roster, round and current actor;
- **Quest Log**: active quests, stage objectives and turn-in state;
- **Chronicle**: current story node, ending, and a journal of meaningful events;
- **Campaign strip**: bind chat, take a snapshot, apply a content upgrade, open saves/backups.

Route buttons move the player through the same server-validated `/move` route as the map. `Explore` uses the authoritative random-encounter roll.

## 4. World Map

### Phaser 3 map

The World Map is rendered with **Phaser 3**:

- zoom with the mouse wheel
- drag empty space to pan
- click a node to inspect it
- current layer is shown in the toolbar
- local scenes show their parent, children and linked exits
- routes still come from the server graph, never from display coordinates

Layers:

`world` → `region` → `settlement` → `interior` → `room`, plus `dungeon` / `floor`.

A transition is only legal when its connection mode matches the layers, for example `road`, `door`, `stairs` or `walk`.

### Random encounters and respawns

A Scene can define a `randomEncounter`:

```json
{
  "enabled": true,
  "chance": 1,
  "dice": { "count": 2, "sides": 6 },
  "difficulty": 8,
  "cooldownSeconds": 60,
  "monsters": [{ "monsterKey": "forest_goblin", "count": 1 }]
}
```

**Explore** rolls a joint check:

```text
party  = 2d6 + floor(luck / 3) + (partySize - 1)
danger = 2d6 + difficulty
party <= danger → encounter
```

The result is logged as `encounter.random_roll`, then a normal pending combat is created. Victory marks the spawn defeated and starts `cooldownSeconds`; defeat/flee releases it again. Spawns refresh lazily when the map/location is read.




### Navigation

- Mouse wheel zooms; drag empty space to pan; use the +/− controls.
- Region filter.
- Explored nodes show names. Unexplored nodes show “Unexplored”.
- The current location has a gold pulse.
- The right panel shows description, coordinates, connection count, and exploration state.

### Movement

There are two ways to move:

1. Click an adjacent node and use **Travel**.
2. Use the **Available Routes** list and click a route.

The server validates:

- a direct connection exists;
- connection conditions (flag / quest / item / level, etc.);
- travel cost;
- exploration, quests, story triggers on arrival.

Map coordinates are display-only. Without a real connection, you cannot move.

### Encounters

In dangerous locations the right panel lists local encounters:

- **Trigger Battle** creates a pending combat;
- a combat entrance appears at the top of chat when a chat is available;
- click it to enter the standalone combat UI.

## 5. Characters and NPCs

### Player

- Final stats = base + permanent bonuses + equipment + passives + temporary effects.
- Equipment never overwrites base stats.
- The character page shows HP/MP/EXP, attributes, gold, and party.

### NPC interactions

Click a local NPC card:

- **Talk**: records relationships and quest progress; returns structured dialogue for the LLM.
- **Accept quest**: checks prerequisites and state.
- **Turn in**: must be at the correct NPC location.
- **Shop**: buy and sell.
- **Join party**: recruitable NPCs join the party and fight.
- **Heal**: costs gold and restores HP/MP.

Unavailable interactions are shown as locked with a reason from the rules engine.

### Shops

- Buy prices use the NPC shop configuration and `buyRate`.
- Sell prices use `sellRate`.
- Equipped items must be unequipped before selling.

## 6. Inventory and Equipment

- Filters: weapon / armor / accessory / consumable / material / quest item.
- Equip into `weapon`, `armor`, or `accessory`.
- Equipping a new item automatically removes the old one from that slot.
- Consumables can be used outside combat.
- Stack size and maximum stack come from the item definition.

## 7. Skills

Shows all class skills:

- unlocked / locked;
- active / passive;
- MP, cooldown, target, element, power;
- structured formula;
- passive modifiers;
- applied status effects.

Skills unlock on level-up according to `unlockLevel` and class.

## 8. Quests

Statuses:

- `available`
- `active`
- `ready_to_turn_in`
- `completed` (automatic reward)
- `turned_in`
- `failed`

Objective types:

- `kill`
- `collect`
- `talk`
- `visit`
- `flag`
- `level`
- `combat_win`

A stage can use `mode: "all"` (every objective) or `mode: "any"` (multi-path completion through any objective).

Unmet prerequisites block acceptance. Turn-in must happen at the correct NPC location.

## 9. Combat

### Flow

1. Trigger from the map, an LLM proposal, or the Combat tab.
2. Click **Enter Battle**.
3. The server builds initiative from agility + d20.
4. Choose attack, skill, guard, item, or flee.
5. Enemies and companions act through server-side AI.
6. All enemies dead → victory; party wiped → defeat.
7. Autosave and result summary.

### Settlement

Victory:

- EXP to surviving party members;
- gold to the player;
- probabilistic loot;
- quest `kill` / `combat_win` progress;
- level-ups and skill unlocks;
- story triggers;
- autosave.

Defeat:

- return to the starting location;
- revive at half max HP;
- lose 10% gold;
- revive the party;
- autosave.

### Mid-combat saves

- Autosave after every player action.
- **Save** creates a manual snapshot.
- Closing the combat UI does not lose state.

### Handing the result to the LLM

The result screen has **Hand to LLM**. It writes a server-authored summary to chat:

```text
[STRPG Combat Result — narrative only; do not change values]
...
```

The LLM can narrate reactions, but must not change values.

## 10. Story

- Displays the Story Graph and current node.
- Gold node = current.
- Green node = ending.
- The right panel shows node text, actions, and scene.
- Manual branches appear as choices.
- Reaching an ending shows ENDING.

The graph is real data. Nodes, edges, conditions, and actions are edited in Studio.

## 11. Studio

### Projects

- Create, duplicate, delete (blocked when Campaigns exist).
- Integrity check.
- Edit project details.

### Workbench

Studio opens on **World Workbench**, an RPG database rather than a flat asset table:

- header counts, `New DRAFT` palette for all 12 content kinds, `Generate with AI`, `Import Entry`, `Images`, `Chat Character`
- database filter chips with per-kind counts and free-text search
- World → regions → settlements → interiors / rooms / dungeons / floors
- NPCs, Events, Quests, Monsters, Items, Skills, Classes, Rules, Effects, Stories
- drag a Scene onto another Scene to change `parentKey`
- drag an NPC/Event onto a Scene to attach it
- Entry tab edits fields and JSON; Connections creates visual Scene transitions; Story/Quest use the node graph
- lifecycle stepper and gated Save / Validate / Approve / Publish actions
- **AI Rewrite** and **Duplicate** for the selected entry
- **Generate with AI** opens the prompt/preset interface (NPC, scene, quest, monster, item, skill, event, story, class, status effect, world, rules) with tone, level band, anchor scene and reference keys; the model returns JSON, the client normalizes it onto the canonical template, and only a DRAFT is created
- **Import Entry** accepts a human-readable Entry Card and optionally expands it with the World Writer LLM
- **Import Images** attaches a folder of images using `category_name_status-or-level.ext`
- **Important NPC** enables **Import to Tavern**, which creates a real SillyTavern character card through `/api/characters/create`

Saving a published entry creates a new DRAFT revision; validation/review/publish still apply. See [World Workbench](WORKBENCH.md).

### Director's Room

The **Director's Room** is the multi-role authoring table for a solo director/player. Nine roles own one content domain each: Narrator (story and memory), Quest Designer, Casting Director (NPCs), Ecologist (monsters), Cartographer (scenes), Quartermaster (items), Skill Wright, Rules Keeper and Continuity Editor.

Ask a role for a three-part answer: a **player-safe brief**, **director notes**, and a **handoff** to the next role. Save the brief to the memory book, record the handoff, then press **Follow handoff** on the next role. **Use brief in AI generator** opens the Workbench AI modal with the brief and relevant project keys prefilled; it still creates only a DRAFT.

The memory book uses `player`, `director` and `secret` visibility. The **Spoiler Guard** blocks saving or using a brief while it contains a protected term, and blocks creating a generated DRAFT that still contains one. Player-safe view hides director/secret memory, handoffs and director notes. See [Director's Room](DIRECTOR_ROOM.md).

### Content lifecycle

```text
DRAFT → VALIDATION → REVIEWED → PUBLISHED
```

Workflow:

1. **+ Content**: choose a type, paste JSON, or start from a template.
2. **Save DRAFT**.
3. **Automatic Validation**: schema, graph connectivity, numeric ranges.
4. **Human Review**: reviewer name, approve or reject.
5. **Publish**: only REVIEWED content can be published.
6. Published content is read-only. Use **New Revision** to edit.

Content types:

- NPC
- Monster
- Equipment / Item
- Skill
- Scene / Location
- Event
- Story Graph
- Quest
- World
- Class
- Rules
- Status Effect

**Separation rule:** World is setting metadata only. Scene is one place with connections and encounters. Event holds triggers/conditions/actions and is referenced by a Scene's `eventKeys`; an unreferenced scene event is ignored. Story holds narrative nodes/edges. Do not paste a location list into World, or inline story logic into Scene.

The importer accepts legacy `world_map` output and expands it into one World plus Scene assets. A canonical World asset containing `locations` shows a validation error instead of silently mixing domains.

### Class Builder

Studio → **Class Builder** provides sliders for base stats and growth, a derived preview, starting items/skills and a DRAFT save. Server-side ranges reject invalid values even through the API.

Important: only `maxHp, maxMp, str, agi, int, vit, luck` are primary stats. `atk/def/res/hit/evade/crit` are derived. `class.skillTree` is metadata only; runtime unlocking uses `Skill.unlockLevel` and `Skill.classes`.

### Rules Compiler

Studio → **Rules Compiler** turns natural language into Rules JSON:

1. enter a request such as "level cap 50, enemies 20% more HP, crit cap 40%"
2. the configured SillyTavern model returns JSON
3. JSON is range-checked and shown for editing
4. **Apply as DRAFT** creates a normal Rules asset

The compiler cannot publish or bypass Validation/Review. Formulas use a restricted variable/function whitelist and no `eval`.

See [Class and Rules](CLASS_RULES.md).

### Node Graph Editor

- Story Graph / Quest Graph: drag, connect, edit conditions/actions, auto-layout, validate, highlight errors.
- World Graph: aggregates Scene layout coordinates and connections. DRAFT scenes can be dragged and saved.
- Published content requires a new revision.

### Import

Supported inputs:

- `{ "kind": "npc", "asset": { ... } }`
- a single asset with `kind` and `key`
- output from the six designer cards
- a full `strpg.game-package`
- JSON file selection

Importing a Game Package creates a new project. Every asset is DRAFT and must be validated, reviewed, and published again.

### Versions and publishing

- **Build New Version** uses the latest PUBLISHED revision of each key.
- The build performs full package validation.
- **Publish** makes the version available to new Campaigns.
- Old Campaigns stay on their version unless the player applies Content Upgrade.
- **Roll Back** creates a new version; it never changes old versions or Campaigns.
- **Export Package** downloads the `strpg.game-package` JSON.

### Six character cards

Import `cards/*.png`:

1. NPC Designer
2. Equipment Designer
3. Skill Designer
4. Scene Designer
5. Story Architect
6. Quest Designer

See [CHARACTER_CARDS.md](CHARACTER_CARDS.md).


### Chat HUD

When a Campaign is active, the **STRPG** status HUD sits beside the chat. It shows world/location, HP/MP, level, gold, party avatars, active quest objectives, pending combat, routes and quick actions. `Full` opens the Adventure panel; `—` collapses the HUD to a narrow rail that still shows level, HP percentage, quest count and combat.

The HUD refreshes after every received chat message, every rules-engine mutation, and when the active chat changes. It is a view of authoritative state, not a second chat. Dialogue remains in SillyTavern.

### Memory book

**Settings → Integrations → Memory Books → Push to World Info** writes a generated World Info book named `STRPG - <Campaign>` through SillyTavern's `/api/worldinfo/edit`. The book contains the world, regions, NPCs, quests, rules and current situation.

The existing `setExtensionPrompt('STRPG_CONTEXT', ...)` remains as the lightweight in-chat context. The World Info book is the persistent memory layer that the character and model can retrieve.


## 12. Settings and backups

- Studio / Tool tokens.
- Database path, schema version, size.
- Logical database backup / restore / delete.
- Campaign manual snapshot / restore.
- Export Campaign JSON.
- External integration adapters.
- LLM tool whitelist.

Restore is transactional. Create a backup first.

## 13. External integrations

### Memory Books

**Settings → Adapters → Generate Memory Books Summary**:

- shows world, location, story node, active/completed quests, recent events;
- **Copy Summary** to paste into a Memory Books entry or Side Prompt;
- **Download JSON**;
- never writes Memory Books' internal database.

### Map Region Locator

- **Open Map Region Locator** invokes its `/show-map`.
- **Export Region JSON**.
- **Import Region JSON** updates only STRPG display metadata, never location connections.
- never writes its IndexedDB.

### RPG Tracker

- **Narrative Mirror** form: mood / attitude / summary.
- Only whitelisted narrative fields. HP/EXP/items/skills are never sent.
- The server writes `narrative_state` and `tracker_sync_log`.
- Because the extension has no stable custom-field write API, STRPG does not directly modify its tracker data.

## 14. LLM tool protocol

STRPG injects game context before generation:

```text
[STRPG GAME CONTEXT — authoritative]
...
```

The LLM may output:

```html
<strpg>{"tool":"strpg_propose_movement","args":{"location":"greenwood_edge"}}</strpg>
```

or:

```html
<strpg>{"tool":"strpg_propose_encounter","args":{"monsters":[{"monsterKey":"forest_goblin","count":2}]}}</strpg>
```

The client accepts only:

- `strpg_propose_movement`
- `strpg_propose_encounter`
- `strpg_propose_character_reaction`

Movement proposals open a confirmation dialog. Encounters create a pending combat and show a chat entrance.

Other tools are read-only API calls.

## 15. FAQ

**The LLM's damage number differs from the UI.**  
STRPG settlement is authoritative. The LLM only narrates.

**Switching chats did not restore my Campaign.**  
The chat is not bound. Use Dashboard → Bind Current Chat.

**Does publishing a new version change my Campaign?**  
Not automatically. Publishing only affects new Campaigns. An existing Campaign sees new content only after **Dashboard → Content Upgrade** is applied.

**Why can't I edit published content?**  
By design. Create a new revision, review it, publish it, then build a new version.

**Can Tracker HP be authoritative?**  
No. Tracker is a narrative mirror. STRPG Core is the only numeric authority.

**Can designer-card output enter the game directly?**  
No. It must go through import → validation → human review → publish → build.


