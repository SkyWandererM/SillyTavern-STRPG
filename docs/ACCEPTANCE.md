# STRPG Final Acceptance (20 Steps)

Environment:

- SillyTavern 1.19.0
- Node 24.15.0
- disposable dataRoot + `STRPG_DATA_DIR`, port 8124
- same `plugins/strpg` and built frontend
- verifier: `scripts/verify-e2e.mjs`
- report: `docs/acceptance-report.json`

A disposable instance avoids modifying the live `data/strpg`. It runs the same code, plugin loader, and CSRF flow.

| # | Acceptance item | Result | Evidence |
|---|---|---|---|
| 1 | Create a game project | ✅ | `POST /projects`; `studio.test.js`; acceptance project ID |
| 2 | Import content produced by the six designer cards | ✅ | `examples/card-outputs/` six items + base; `cards-and-package.test.js` |
| 3 | Automatic validation and human review | ✅ | 31 assets validated → reviewed; report step 4 |
| 4 | Assemble and publish a game | ✅ | build → publish; 4 locations / 3 NPCs / 2 monsters / 3 quests |
| 5 | Create a Campaign | ✅ | `POST /campaigns` from a published version |
| 6 | Bind a SillyTavern chat | ✅ | `chat-a` and `chat-b` bound to the same Campaign |
| 7 | Create a player character | ✅ | Aria, Lv.1, HP 120/120 |
| 8 | Enter the starting location | ✅ | `mistfall_town` |
| 9 | Interact with an NPC | ✅ | talk to `elder_mira` |
| 10 | Accept a quest | ✅ | `main_sigil` → active |
| 11 | Discover an enemy and trigger combat | ✅ | forest encounter, pending combat, 2 goblins |
| 12 | Enter the combat UI | ✅ | standalone full-screen Combat Arena; browser screenshot |
| 13 | Execute a full turn-based battle | ✅ | server-side rounds; victory |
| 14 | Automatically settle EXP, gold, loot, stats | ✅ | EXP 70, gold 36, drops, Lv.2, skill unlock |
| 15 | Update quest progress | ✅ | `investigate` → `report`; kill 2/2 |
| 16 | Hand combat result to the LLM | ✅/⚠️ | **Hand to LLM** writes a system message; actual generation depends on the configured model |
| 17 | Save the game | ✅ | manual + automatic snapshots |
| 18 | Switch to another chat | ✅ | `chat-b` |
| 19 | Restore the same Campaign | ✅ | `chat-b` → same Campaign ID |
| 20 | Verify complete state consistency | ✅ | level/HP/gold/location/ending identical after restore |

## Detailed verifier output

```text
✓ STRPG plugin health
✓ Published game available
✓ Imported Game Package into a new Studio project (31 assets, all DRAFT)
✓ Validated, reviewed and published all imported assets
✓ Assembled and published Game Version
✓ Created Campaign from frozen game version
✓ Bound SillyTavern chat A
✓ Entered starting location
✓ Talked to NPC and accepted main quest
✓ Moved to forest via real location connection
✓ Discovered enemy and created pending encounter
✓ Entered independent combat UI state
✓ Executed complete turn-based combat and settlement
✓ Automatically applied EXP, gold, drops, levels and skills
✓ Quest objective advanced from combat
✓ Turned in quest at the correct NPC and claimed rewards
✓ Reached a real Story Graph ending through gameplay
✓ Saved game snapshot
✓ Bound alternate chat to the same Campaign
✓ Restored Campaign from snapshot after switching chat
✓ Synced whitelist-only narrative state
✓ Exported Memory Books continuity summary
✓ Verified event log and idempotent settlement trail
```

The 23 steps cover the 20 acceptance items and additionally verify:

- event log includes `campaign.created`, `player.moved`, `npc.interaction`, `quest.accepted`, `combat.victory`, `quest.turned_in`, `story.ending`, `save.restored`
- Tracker whitelist accepts narrative fields only
- Memory Books summary export works
- build stats: 4 locations / 3 NPCs / 2 monsters / 8 items / 5 skills / 3 quests / 1 event / 6 story nodes / 1 ending

## Additional automated coverage

Campaign content upgrades are covered by `tests/upgrades.test.js`:

- base v1 Campaign with progress
- v2 module adds a Scene, connection, Event and NPC
- preview sees the additions
- in-place upgrade preserves level, gold, inventory and quest state
- new Scene/Event/NPC work after upgrade
- `Before upgrade` snapshot restores to v1

This is separate from the 23-step base acceptance, which focuses on the original game loop.

## Explicitly not overstated

1. The LLM content used in acceptance is a **structured example output**; it is not claimed to have been generated live by a model.
2. Step 16 writes a settlement summary to chat for the next LLM turn. It does not pretend to auto-generate a full narrative response.
3. External integrations are explicit adapters; they never write external databases.
4. World Graph connection editing is done through Scene JSON; layout is draggable.

## Reproduce

```powershell
# disposable SillyTavern
$root = Join-Path $env:TEMP "strpg-acceptance"
$data = Join-Path $root "strpg-data"
New-Item -ItemType Directory -Force $root,$data | Out-Null
$env:STRPG_DATA_DIR = $data
$env:NODE_ENV = "production"
node server.js --port 8124 --dataRoot $root --browserLaunchEnabled false

# another terminal
node scripts/verify-e2e.mjs http://127.0.0.1:8124
```




