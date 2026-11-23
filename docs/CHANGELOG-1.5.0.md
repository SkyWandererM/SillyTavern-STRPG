# Changelog 1.5.0 — Chat ↔ RPG Bridge (M2): NPC services in chat

Released: 2026-11-23

M2 turns NPCs into configurable service providers. A player can haggle, recruit, learn a
skill or help a companion — all from a normal chat — and every step is a server-validated
proposal the player approves.

## Added

### Configurable NPC policies

`npcSchema` now validates four new blocks (all optional, existing content keeps working):

```json
{
  "recruit": {
    "enabled": true,
    "cost": { "gold": 60, "items": [{ "itemKey": "herb", "quantity": 2 }] },
    "relationRequired": 0,
    "condition": {},
    "maxParty": 3
  },
  "teaching": [
    { "skillKey": "quick_slash", "tuition": { "gold": 40, "items": [] }, "relationRequired": 0 }
  ],
  "recovery": {
    "enabled": true,
    "hpThreshold": 0.4,
    "methods": [
      { "key": "tend", "label": "Help her sort the herb crates", "restoreHp": 0.5, "restoreMp": 0.5, "relationDelta": 1 }
    ]
  },
  "shop": { "haggle": { "enabled": true, "maxDiscount": 0.3 } }
}
```

### Server-side social engine (`plugin/src/social.js`)

- `quoteTrade` — the server owns the price floor. Discount = base + relationship +
  player `int`/`luck`, capped by `shop.haggle.maxDiscount`; below 35% of list is refused
  as insulting, between the floor and list is a counter-offer.
- `proposeTrade` / `proposeRecruit` / `proposeTuition` / `proposeRecovery` — validation
  (party limit, relation gate, conditions, known skill, NPC HP threshold, affordability)
  then a `bridge_candidates` row. No gold, item, party flag or skill changes yet.
- `applyTrade` / `applyRecruit` / `applyTuition` / `applyRecovery` — transactional
  settlement: charge gold/items, add the item, flip the NPC `party` flag, unlock the
  skill, heal the NPC, adjust relationship, write `game_events` + `bridge_apply_log`.
- `socialOptions` — read-only catalogue (prices, teaching, recruit cost, recovery need)
  for tools and the UI.
- Trade quotes are re-validated at approval (`QUOTE_STALE` when the price no longer holds).

### Tools

| Tool | Purpose |
|---|---|
| `strpg_get_social_options` | prices, teaching, recruit cost, recovery need |
| `strpg_propose_trade` | haggled purchase (offer price optional) |
| `strpg_propose_recruit` | party recruitment with its configured cost |
| `strpg_propose_tuition` | skill training with its configured tuition |
| `strpg_propose_recovery` | help a low-state NPC recover |

The injected `STRPG_CONTEXT` prompt now documents these proposals, and the chat tool
whitelist accepts them. Every result is a proposal, never a direct change.

### Combat defeat is now a trigger

- `combat_defeat` added to the event trigger enum; `settleDefeat` runs scene/world events
  with `sceneKey` and `targetKey = encounterKey`, and advances the story with
  `combat.defeat`.
- New event actions: `adjust_relation` (±2, clamped), `take_item`, `add_memory`
  (queues a narrative candidate), `open_chat` (surfaced in event results for the UI).

### Seed example

- Borin teaches `quick_slash` for 40 gold and his shop allows haggling.
- Mira can be recruited for 60 gold; Lina for 30 gold + 2 calming herbs.
- Lina asks for help when below 40% HP and rewards the interaction with relation +1.
- `defeat_at_shrine` (scene `old_shrine`, trigger `combat_defeat`): losing drops Mira's
  relationship by 1, queues a memory line and shows a notice.

### Frontend

- Bridge panel describes trade/recruit/tuition/recovery proposals with their costs.
- Approving a candidate refreshes the dashboard through a `strpg:bridge-changed` event.
- Chat tool block whitelist and context prompt updated.

### Tests

`tests/social.test.js` (9 cases): options catalogue, counter-offer then settlement,
insulting offer refused, recruit approval + cost + duplicate guard, missing item cost,
tuition + duplicate skill guard, recovery need/apply, seeded defeat event, `take_item`
action. Suite total: 57.

## Upgrade notes

1. Restart SillyTavern; no schema change (still v4) and no new npm dependency.
2. Existing campaigns keep their old NPC definitions. Add `recruit`/`teaching`/`recovery`/
   `shop.haggle` in Studio → World Workbench (or publish a new Game Version) to enable the
   new services, then run **Campaign Upgrade**.
3. Approval still needs the manual step; `Publish World Book` is what makes the new state
   visible to the chat.
