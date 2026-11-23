# Changelog 1.4.0 — Chat ↔ RPG Bridge (M1)

Released: 2026-11-23

M1 delivers the state/memory bridge between a SillyTavern chat and a running Campaign.
STRPG stays numerically authoritative; external narrative input is reviewed before it
can change anything.

## Added

### Incremental world book

- `plugin/src/lorebook.js` owns the generated entries. Every entry has a stable logical
  id (`world`, `scene:<key>`, `npc:<key>`, `quest:<key>`, `player`, `current`, `rules`,
  `debt:<npcKey>`) and a memo of the form `[STRPG] <id> — <name>`.
- `uid` is derived from the logical id (FNV-1a), so churn in content does not reshuffle
  entries. When an entry already exists its `uid` and timed-effect fields are kept.
- `pushLorebook` now reads the existing book first (`/api/worldinfo/get`), merges, then
  writes (`/api/worldinfo/edit`). Foreign entries are kept byte-for-byte; STRPG entries
  that are no longer generated are pruned.
- Books written by the old full-replace push have no marker. Inside the STRPG-named book
  they are adopted by memo match (`adoptLegacy`, default on). A memo that does not match a
  generated entry is treated as user content and kept.
- Entries now include relationship, promises and last interaction for NPCs, plus a
  `debt:<npcKey>` entry when `npc:<key>:debts` is present, and a `sticky` current-situation
  entry.

### Review queue

- New tables `bridge_candidates` and `bridge_apply_log` (schema v4).
- `pullTrackerNarrative` turns whitelisted Tracker fields (`mood`, `trust`, `summary`, …)
  into `PENDING` candidates. `hp`, `gold`, `exp`, equipment and skills are stripped before
  queueing, and characters that do not match a campaign NPC are reported as skipped.
- `proposeRelation` queues a relationship candidate. A single proposal is capped at ±2,
  clamped to −100…100, requires a reason and deduplicates while pending.
- `approveCandidate` is the only write path: it runs in a transaction, updates
  `campaign_variables` / `narrative_state`, writes a `game_events` row and a
  `bridge_apply_log` entry. Approving a non-pending candidate returns 409.

### Read-only mirror

- `GET /campaigns/:id/bridge/mirror` returns the player block, quest states, relations,
  recent events and the narrative whitelist. It never mutates Tracker data.

### Tools

- `strpg_get_bridge_mirror` — read the mirror.
- `strpg_propose_relation` — queue a relation change for approval.
- The chat tool block whitelist now accepts `strpg_propose_relation`, and the injected
  `STRPG_CONTEXT` prompt documents it.

### Frontend

- `frontend/src/trackerBridge.js`: detects `window.RPGBridge`, reads whitelisted narrative
  fields, pulls them into the queue, and (opt-in) writes one compact STRPG line into
  `worldState.events` without touching character sheets.
- Integrations → **State & Memory Bridge**: pull, push (toggle), publish the world book
  incrementally, download the mirror, and approve/reject pending candidates inline.
- World book push now reports merge stats (`+new / updated / removed / kept`).

### Tests

- `tests/bridge.test.js` — 9 cases: stable ids, merge/prune/uid retention, legacy adoption,
  push-through-fetch merge, relation proposal dedupe + approve + 409, unsafe proposal
  rejection, Tracker pull queueing, mirror shape, preview. Suite total: 48.

## Upgrade notes

1. Restart SillyTavern so the plugin loads schema v4 (migration is automatic).
2. No npm dependency changes.
3. The first incremental push replaces legacy unmarked STRPG entries; use
   `{"dryRun":true}` to preview, or `{"adoptLegacy":false}` to keep them.
4. Relationship changes made before 1.4.0 were not tracked; relations start at 0 until a
   candidate is approved.
