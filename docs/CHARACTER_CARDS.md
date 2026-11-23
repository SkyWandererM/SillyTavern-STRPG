# Six STRPG Designer Character Cards

Location: `cards/`

Each card ships as:

- **Character Card V2 JSON**
- **PNG** with a `chara` tEXt chunk (base64 UTF-8 V2 JSON)
- **manifest.json**

The PNGs were verified with SillyTavern 1.19's `src/character-card-parser.js`. All six return `chara_card_v2` with the complete system prompt.

## 1. Cards

| # | Card | Mode | Output kind | File |
|---|---|---|---|---|
| 01 | NPC Designer | NPC / Monster | `npc` / `monster` | `strpg-card-01-npc-designer.png` |
| 02 | Equipment Designer | weapons / armor / accessories / consumables | `equipment` | `strpg-card-02-equipment-designer.png` |
| 03 | Skill Designer | active / passive / class tree | `skill` | `strpg-card-03-skill-designer.png` |
| 04 | Scene Designer | towns / regions / dungeons / rooms | `scene` | `strpg-card-04-scene-designer.png` |
| 05 | Story Architect | world / chapters / branches / endings | `story` | `strpg-card-05-story-architect.png` |
| 06 | Quest Designer | main / side / hidden | `quest` | `strpg-card-06-quest-designer.png` |

Matching `.json` files are provided.

## 2. Import into SillyTavern

1. SillyTavern → Character Management → Import.
2. Select `cards/*.png`.
3. The six cards appear in the character list.
4. Select a card to start designing.

JSON import may work depending on the ST version/importer.

## 3. What each card contains

- name, description, personality, scenario, first message
- system prompt
- role and workflow
- strict JSON output format
- schema fields
- few-shot JSON example
- hard constraints
- prohibited behavior

Shared rules:

```text
Output exactly one JSON object
Envelope: {"kind":"KIND","asset":{...}}
Keys are ASCII
Numeric values are numbers
Conditions and actions are structured
Never modify published content
Never generate SQL
Never settle combat for the player
```

## 4. Output envelope

```json
{
  "kind": "npc",
  "asset": {
    "key": "herbalist_lina",
    "name": "Lina the Herbalist",
    "kind": "npc",
    "locationKey": "mistfall_town",
    "interactions": []
  }
}
```

Canonical output kinds are the only kinds promised by the cards: world, scene, event, npc, monster, equipment, skill, quest, story, class, rules, status_effect. Studio also maps legacy aliases (for example world_map, character, enemy, item, spell, mission) at import. A world_map payload with a locations array is expanded into a world asset plus scene assets. World, scene, and event are separate assets: a world never contains locations, and a scene references event assets through eventKeys.

The Scene Designer now emits `layer`, `parentKey`, `spawnPoints`, connection `mode`/`entryKey` and optional `randomEncounter`. It may return an array containing one `scene` plus zero or more `event` envelopes; it must not return a world. The Story Architect may return an array containing one `world` plus one `story`, but no scenes. This keeps world metadata, location layout, scripted events, and narrative graph independently reviewable.

Studio Import supports:

- the envelope above
- a bare asset with `kind` and `key`
- a full `strpg.game-package`

## 5. Six-card output samples

`examples/card-outputs/` contains a mutually consistent set:

| File | Content |
|---|---|
| `01-npc.json` | Archivist Sela at the Moonlit Glade, offers The Moonlit Relic |
| `02-equipment.json` | Moonlit Dagger |
| `03-skill.json` | Moon Slash |
| `04-scene.json` | Moonlit Glade |
| `05-story.json` | The Moonlit Vow (start + ending) |
| `06-quest.json` | The Moonlit Relic (collect objective) |
| `base/world.json` | Moonlit world |
| `base/class.json` | Moonlit Adventurer (starts with the dagger) |
| `base/rules.json` | Moonlit rules |

The automated test:

1. imports the six outputs + base;
2. validates, reviews, and publishes each;
3. builds and publishes a Game Version;
4. creates a Campaign;
5. accepts the quest from the NPC;
6. auto-completes the quest and reaches `ending_moon`.

Test: `tests/cards-and-package.test.js`.

These are structured examples of what the cards are asked to produce, not a claim that an LLM generated them in real time. Real LLM output still goes through Studio validation, review, and publication.

## 6. Regenerate

```powershell
node scripts/make-cards.mjs
```

The generator:

- reads `cards/specs.js`
- writes V2 JSON
- draws a 512×768 PNG
- embeds the `chara` tEXt chunk
- verifies the chunk decodes and matches
- updates `manifest.json`

## 7. Usage advice

### NPC / Monster

- define gameplay role, location, quest, shop, and combat role
- one object per response
- list existing questKey / itemKey / skillKey
- put missing dependencies in `designerNotes`

### Equipment

- define build role and level
- avoid filling every stat
- consumables need explicit `consumable` values
- equippable items use `stackable:false`

### Skill

- use safe formulas only
- active skills need MP, target, and a formula
- passive skills use `passive.modifiers`
- effect keys must exist

### Scene

- map coordinates are separate from connections
- dangerous areas provide encounters
- do not connect every node

### Story

- at least one ending
- non-ending nodes need outgoing edges
- all nodes reachable from start
- express branches with conditions

### Quest

- objectives must be machine-checkable
- prerequisites must not cycle
- `turn_in` needs an NPC
- rewards reference real items/skills

## 8. After import

```text
Paste/import JSON
→ DRAFT
→ automatic validation
→ human review
→ publish
→ build Game Version
→ publish version
→ create Campaign
```

Designer cards cannot write the database directly or skip review.


