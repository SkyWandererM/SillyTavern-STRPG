# Class and Rules

The six designer cards do not cover **Class** or **Rules**. They are first-class Studio assets and can be created manually or with the built-in builders.

## 1. Class

A Class is the player archetype used at Campaign creation.

### Runtime responsibilities

- initial primary stats and HP/MP
- per-level growth
- starting items
- starting skills
- class restrictions on equipment and skills
- class choice in **Create Campaign**

### Structure

```json
{
  "key": "frontier_adventurer",
  "name": "Frontier Adventurer",
  "description": "A balanced frontier class.",
  "baseStats": {
    "maxHp": 120,
    "maxMp": 40,
    "str": 14,
    "agi": 10,
    "int": 10,
    "vit": 12,
    "luck": 8
  },
  "growth": {
    "maxHp": 18,
    "maxMp": 6,
    "str": 2.2,
    "agi": 1.6,
    "int": 1.5,
    "vit": 2,
    "luck": 1.1
  },
  "startingItems": [
    { "itemKey": "iron_sword", "quantity": 1 },
    { "itemKey": "healing_herb", "quantity": 2 }
  ],
  "startingSkills": ["power_strike", "heal"],
  "skillTree": [
    { "level": 3, "skillKey": "fireball" }
  ]
}
```

### Important behavior

- Only primary stats participate in growth:
  `maxHp, maxMp, str, agi, int, vit, luck`.
- `atk / mag / def / res / hit / evade / crit` are derived from primary stats, equipment, passives and statuses. Putting them in `baseStats` does not produce the expected result.
- `startingItems` must exist and must be usable by the class. The first weapon is auto-equipped at Campaign creation.
- `startingSkills` must exist.
- `class.skillTree` is currently **metadata + validation only**. Runtime unlocking is driven by `Skill.unlockLevel` and `Skill.classes`.
- A Campaign selects one class at creation. There is no class change UI.
- Upgrade keeps the current class; removing it in the target version blocks the upgrade.
- Multiple Class assets are allowed. If no Class is published, `DEFAULT_CLASS` (Adventurer) is injected at build.

## 2. Class Builder

Studio → **Class Builder**:

- sliders for base stats and growth
- server-side numeric ranges
- derived level-1 preview
- recommended power budgets
- starting item/skill pickers
- saves as DRAFT

Slider is only UI convenience; the backend `classSchema` rejects out-of-range values even for direct API calls.

Ranges:

```text
base maxHp 40..300
base maxMp 0..200
base str/agi/int/vit/luck 1..30
growth maxHp 0..30
growth maxMp 0..10
growth primary 0..5
```

## 3. Rules

Rules are global, package-level balance.

### Fields

| Field | Purpose |
|---|---|
| `levelCap` | maximum level, 2–999 |
| `startingGold` | new Campaign starting gold |
| `statCaps` | positive caps for primary stats / HP / MP |
| `formulas` | override damage/hit/crit/flee/EXP formulas |
| `expTable` | explicit per-level EXP thresholds; takes priority over formula |
| `enemyScaling.hp` | enemy HP multiplier |
| `enemyScaling.atk` | accepted, currently unused |
| `saveEveryCombatAction` | accepted, currently not read |

### Structure

```json
{
  "key": "emberfall_rules",
  "name": "Emberfall Rules",
  "levelCap": 30,
  "startingGold": 80,
  "statCaps": {
    "maxHp": 9999,
    "maxMp": 999,
    "str": 999,
    "agi": 999,
    "int": 999,
    "vit": 999,
    "luck": 999
  },
  "formulas": {
    "physicalDamage": "max(1, round((atk * 1.6 + power) * (100 / (100 + def)) * variance * critMult * elementMult))",
    "magicalDamage": "max(1, round((mag * 1.7 + power) * (100 / (100 + res)) * variance * critMult * elementMult))",
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

### Formula variables

| Formula | Variables |
|---|---|
| `physicalDamage` | `atk, power, def, variance, critMult, elementMult` |
| `magicalDamage` | `mag, power, res, variance, critMult, elementMult` |
| `heal` | `mag, power` |
| `hitChance` | `hit, evade` |
| `critChance` | `luck` |
| `fleeChance` | `agi, enemyAgi` |
| `expToNext` | `level` |

Functions: `min, max, round, floor, ceil, abs, sqrt, pow, clamp`.

Operators: `+ - * / % ^ **` and parentheses.

No `eval`, no JavaScript, no arbitrary code.

### Rules Compiler

Studio → **Rules Compiler**:

1. Enter a natural-language balance request.
2. `generateQuietPrompt` asks the configured SillyTavern model for Rules JSON.
3. The response is parsed, merged with defaults, range-checked and shown as editable JSON.
4. **Apply as DRAFT** creates a normal Rules asset.
5. Validation → Review → Publish → Build is still required.

The compiler cannot publish and cannot bypass the formula allowlist. If the model is unavailable, edit the JSON manually.

### Rules scope after Campaign Upgrade

- `levelCap`, `statCaps`, `formulas`, `expTable`: apply to the upgraded Campaign after upgrade.
- `startingGold`: only affects new Campaigns; it does not retroactively change existing gold.
- `enemyScaling.hp`: affects newly generated enemies.

## 4. Build requirements

```text
world     exactly 1
story     exactly 1
scene     >= 1
class     >= 1 (or DEFAULT_CLASS)
rules     optional (DEFAULT_RULES)
```

Only the latest **PUBLISHED** revision of each asset is used.

## 5. Designer cards

The six cards cover NPC, Equipment, Skill, Scene, Story and Quest. Class and Rules are intentionally editor-driven because they are tuning surfaces, not narrative content.

If you want a seventh/eighth card later, use the same JSON structures above and add the canonical output kinds `class` and `rules`.
