# Changelog 1.8.3 — Movable in-chat rail, launcher removed

Released: 2026-11-24

UI-only release.

## Changes

- **Removed the separate S launcher orb.** It was the wrong floating entry: the
  in-chat STRPG status rail is the intended one. Opening the full panel is still
  available from the SillyTavern extensions menu (**STRPG** entry).
- **The in-chat status rail is now movable.** Drag it anywhere; the position is stored
  in `localStorage["strpg.hud.rail.position.v1"]`, clamped to the viewport, restored on
  load, re-clamped on window resize, and **double-click resets** it to the default
  (right edge, vertically centred).
- Drag and click do not conflict: a 3px threshold plus a capture-phase click guard means
  the rail's buttons (expand, quests, combat, open panel) keep working after a drag.
- The expanded HUD dock keeps its anchored bottom-right position and still collapses
  back into the movable rail.

## Verified

- Headless harness: rail moves by the dragged delta, keeps its size, and reset returns
  it to the default position.
- Against the running SillyTavern: no `.strpg-launcher` element, extensions menu still
  opens the panel, no page errors.
- Backend suite: 76 tests pass.
