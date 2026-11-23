# STRPG 1.1.2 — Built-in prompt audit and schema alignment

Audit of every Workbench AI preset, field guide and normalization rule against
the server Zod schemas and package-level reference validation. No schema or
database change.

## Fixed in built-in prompts

- **Monster / Boss**: removed unsupported "phase" and "defensive phase"
  requirements. Bosses now use the supported `ai` field plus a signature skill
  and a described tell. "Pack tactics" is prose, not a new field.
- **Monster / drops and skills**: drops only use item keys supplied in
  Reference keys; skills only use supplied skill keys.
- **Quest / Side**: removed the unsupported `optional` objective. A side quest
  can use a stage with `mode: "any"` and two alternative objectives instead.
- **Quest / Hidden**: no longer puts a flag into `prerequisites` (which only
  accepts quest keys); discovery is gated with `start.type` and an existing
  location or story node.
- **Quest / rewards**: item rewards only when the item key is supplied; turn-in
  quests must include `turnIn.npcKey`.
- **Skill / Support**: removed "cleanse", which is not a supported skill
  effect. Healing uses `type: heal` + `power`; buffs use `effects.buff`.
- **Equipment / Armor**: removed "resistance" (items have no `resistances`
  field); use a `def` or `res` stat bonus.
- **Equipment / Consumable**: requires the `consumable` object instead of a
  top-level heal field, slot is null.
- **NPC / Healer**: no invented fee field; heal is an interaction and any
  donation is dialogue.
- **NPC / Quest Giver and Merchant**: quest and shop keys are only used when
  supplied in Reference keys; otherwise the offer stays in dialogue.
- **Scene / Town, Wilderness, Dungeon, Interior**: encounters are only created
  when monster keys are supplied; otherwise the danger stays in prose.
  Random encounters stay disabled on town/indoor scenes.
- **Event**: prompts now list the supported action types
  (`set_flag`, `set_variable`, `give_item`, `accept_quest`, `grant_exp`,
  `unlock_skill`, `heal`, `teleport`, `notice`) instead of a generic "change the
  scene".
- **World**: requires `startLocationKey` and forbids `locations`/`connections`
  arrays.
- **Class**: requires the exact stat keys `maxHp, maxMp, str, agi, int, vit,
  luck`; starting kit only with supplied keys.
- **Rules**: prefers `levelCap`, `startingGold`, `expTable` and
  `enemyScaling`; documents the safe formula grammar and forbids JavaScript.
- **Status Effect**: documents `kind`, `tick.type` and `skipTurn` enums.

## Field guides and normalization

- NPC interaction shapes now include `questKey`, `condition` and `actions`;
  `questsOffered` is kept consistent with `accept_quest` interactions.
- Quest shapes now include `turnIn`, stage `mode`, objective type enums,
  `failure` and reward shapes. A turn-in quest with a single NPC start infers
  `turnIn.npcKey`.
- Scene guides include connection modes, parent rules, encounter and random
  encounter shapes.
- Skill guides include the actual `effects.applyStatus` / `buff` / `drain`
  shapes and mark `formula` as optional.
- Equipment slots are normalized from item kind; armor no longer advertises a
  resistances field.
- World start scene falls back to the Anchor scene.
- New preview warnings: missing questKey, quest not in questsOffered, turn-in
  without `turnIn.npcKey`, objectives without `targetKey`, random encounter on
  a non-wild site or without monsters, empty fixed encounters, consumable
  without effect, heal/buff/passive skill without required effect data,
  invalid class stat names, code-like formulas, and unsupported event actions.

## Tests

31 Vitest cases, including preset/schema alignment assertions and
cross-reference normalization tests.
