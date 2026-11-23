# Changelog 1.8.0 — Character bindings, card import and auto-scan (M3.1 / M4)

Released: 2026-11-23

M3.1 closes the "bring a chat character into the RPG" loop and makes scopes run on their
own; M4 adds the identity layer that lets one NPC be the same person in chat and in the
campaign. Manual paths stay first-class.

## 1. Character card → NPC (M3.1)

```http
POST /campaigns/:id/npcs/import-card
{ "name": "Seraphine the Bard", "description": "...", "personality": "...",
  "scenario": "...", "firstMessage": "...", "avatar": "Seraphine.png", "tags": ["bard"] }
```

- Creates a **DRAFT** NPC asset in the campaign's project, with `tavern.avatar`,
  `sourceCard` metadata and a `talk` interaction seeded from the card's first message.
- The key is slugged from the name; duplicates get `_2`, `_3`, …
- It does **not** bypass the content pipeline: validate → review → publish → build →
  **Campaign Upgrade** still applies. Numbers are never imported from a card.
- The reverse direction (NPC → SillyTavern card) already existed in Studio.

## 2. Character bindings (M4)

Schema v6 adds `character_bindings`:

| Method | Path | Description |
|---|---|---|
| GET | `/campaigns/:id/bindings` | Bindings + directions |
| POST | `/campaigns/:id/bindings` | `{npcKey\|null, stAvatar, stCharacterName?, direction?}` upsert by avatar |
| DELETE | `/campaigns/:id/bindings/:bindingId` | Remove |
| GET | `/campaigns/:id/bindings/resolve?avatar=\|npcKey=` | Resolve one identity |
| GET | `/campaigns/:id/bindings/context?avatar=` | Compact prompt line |

When the active chat character is bound, `STRPG_CONTEXT` gains a `[BOUND NPC]` line with
that NPC's relationship, last interaction and open debts. Binding with `npcKey: null` marks
the active character as the **player persona** instead.

`open_chat` event actions now actually switch: after a move or combat settlement, the
extension resolves the NPC's bound avatar and calls SillyTavern's character selection; if
nothing is bound it only notifies.

**Per-NPC world book:** `GET /campaigns/:id/memory-book?npcKey=…` and
`POST …/memory-book/push {npcKey}` build a dedicated book (`STRPG - <campaign> - <NPC>`)
containing only that NPC, debt, player and current-situation entries — useful for a
focused single-NPC chat.

## 3. Automatic scope scans (M3.1)

- Scopes accept `schedule: "every_n_messages:N"`.
- The panel has an auto-scan toggle + N input; it rewrites every scope's schedule
  (manual ↔ every N) and stores the preference locally.
- The extension counts received messages and, at every N, runs each scheduled scope with
  the same extraction pipeline. Results only queue review candidates; failures notify and
  never block the chat.
- Manual scan and manual ingest remain available at all times.

## 4. Manual fallbacks (unchanged policy)

| Situation | Fallback |
|---|---|
| Model or chat API unavailable | Scope **Manual…** (note or JSON) |
| Auto-scan fails | Notification only; manual scan still works |
| `open_chat` with no binding | Info toast, no hard failure |
| Binding to a missing character | Warning toast on Open chat; unbind still works |
| Card import rejected by schema | Asset stays DRAFT with validation errors in Studio |

## 5. Tests

`tests/bindings.test.js` (6 cases): card import + unique keys, binding CRUD/upsert/resolve,
unknown-NPC guard, bound-NPC prompt line and player persona line, per-NPC book filtering,
scope schedule normalization. Suite total: **76**.

## 6. Still open

- Auto-scan only runs while the SillyTavern tab is open (the chat is only readable there).
- "Open chat" selects the character (its existing chat); creating a brand-new dedicated
  chat per NPC is not automated.
- Bindings are per campaign; a global character↔NPC registry would need a profile-level
  store.

## Upgrade notes

1. Restart SillyTavern; migration v6 creates `character_bindings`.
2. No new npm dependency.
3. Existing campaigns have no bindings until you bind a character in
   **Integrations → Character Bindings**.
