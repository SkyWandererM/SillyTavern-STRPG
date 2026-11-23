# Changelog 1.7.0 — Chat memory scopes and service barter (M3)

Released: 2026-11-23

M3 adds the two remaining pieces of the "companion RPG" loop: **scoped memory extraction**
from a chat window, and **paying with a service** instead of gold or items. Both stay inside
the same rule as M1/M2 — everything becomes a reviewed candidate — and both have a
first-class manual path so they work without a model and without a chat API.

## 1. Memory scopes

A scope is a saved extraction recipe:

```json
{
  "key": "npc_state",
  "name": "NPC state after this scene",
  "config": {
    "source": { "type": "chat", "lastN": 12 },
    "filter": { "speakers": [], "requiresKey": ["sigil"] },
    "extract": { "kind": "narrative" },
    "apply": { "targets": ["narrative_state", "lorebook"] },
    "review": "required",
    "schedule": "manual"
  }
}
```

Kinds: `narrative`, `relation`, `flag`, `performance`.

Flow:

1. `POST /campaigns/:id/scopes/:key/prepare` with `{messages}` → the server returns a strict
   JSON prompt built from the scope, the known NPC keys and the transcript (with the
   `requiresKey` filter applied first).
2. The extension runs `generateQuietPrompt` with that prompt and posts the answer back to
   `POST /campaigns/:id/scopes/:key/scan` as `{raw}` (prose/fenced JSON is tolerated).
3. Items are validated and queued in the normal review inbox; each candidate records
   `scopeKey`, message count and source.

**Manual fallback (no model):**

```json
POST /campaigns/:id/scopes/npc_state/scan
{ "note": "Mira agreed to teach fireball once the shrine is cleansed." }
```

or the structured form:

```json
{ "items": [{ "npcKey": "elder_mira", "fields": { "mood": "warm", "trust": 4 } }] }
```

A single `note` is only accepted by narrative scopes; other kinds need structured items.

Starter scopes (`POST /campaigns/:id/scopes/defaults`) create `npc_state` and
`relationship_changes`. Scopes can be updated, disabled and deleted.

## 2. Service barter ("帮忙抵账")

NPCs can front an item in exchange for a service:

```json
"barter": [
  { "key": "blade_for_wolves", "label": "Take the blade now, clear the wolves later",
    "itemKey": "iron_sword", "questKey": "wolf_hunt", "relationDelta": 1 }
]
```

- `strpg_propose_barter` (or the panel) queues a `barter` candidate.
- Approval accepts the service quest, grants the item immediately, records the debt in
  `barter:<npc>:<item>`, and logs `barter.started`.
- Turning that quest in settles the debt: relationship `+relationDelta`, debt removed,
  `barter.settled` logged. This runs inside the existing quest transaction.
- If the quest is already finished, approval returns `409 BARTER_ALREADY_DONE`; approving
  again with an `overrideReason` settles it manually and marks the audit row `manual`.

## 3. Manual fallbacks everywhere (by design)

| Situation | Fallback |
|---|---|
| No model configured / generation fails | Scope **Manual…** accepts a note or JSON items |
| Model output not valid JSON | Paste the fixed JSON into Manual, or send a note |
| A signal receipt was never sent | **Manual release** with a written reason (audited) |
| Quest for a barter already finished | Approve with an override reason (audited, `manual: true`) |
| Chat API missing for a performance | Approval still succeeds; the panel reports it could not write the line |
| Tracker not loaded | Pull/push buttons disable; the mirror is downloadable instead |

## 4. Tests

`tests/scopes.test.js` (9 cases): starter scopes, prompt building + keyword skip, narrative
ingest with whitelist and dedupe, manual note, note rejected on non-narrative scope, raw
JSON with prose and invalid-item skipping, scope lifecycle, barter front-and-settle on
turn-in, barter manual settlement after the quest finished. Suite total: **70**.

## 5. Still open

- Character card → NPC reverse import (chat character reuse) — planned for M3.1; NPC → card
  export already exists.
- `open_chat` events are returned to the UI but do not yet switch chats automatically.
- Auto-scheduled scans (every N messages) are not run by the server; the cron belongs to
  the extension so it can read the chat. Manual and button-triggered runs only, for now.

## Upgrade notes

1. Restart SillyTavern. Schema v5 adds `memory_scopes` and `bridge_candidates.scope_key`
   (migration runs on start).
2. No new npm dependency.
3. Existing campaigns have no scopes until you press **Add starter scopes** or create one.
4. Barter offers must be added to NPC assets (Studio → Workbench) and published before use.
