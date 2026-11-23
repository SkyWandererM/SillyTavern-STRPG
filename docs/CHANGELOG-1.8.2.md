# Changelog 1.8.2 — Responsive panel content

Released: 2026-11-24

UI-only release. The docked panel is narrow (about 320–400px), so the content now
responds to the panel width instead of assuming a 760px drawer.

## What changed

- `.strpg-shell` is a container and the content uses container queries, so typography
  and grids react to the panel, not the browser window.
- Single column under 720px: two-column page grids, card grids, item grids, map layout,
  equipment slots and the dashboard "game" grid all collapse to one column.
- Dashboard hero: the decorative sigil and facts move into a row under the copy; the
  heading uses container-relative sizing and no longer wraps one word per line.
- Top bar: wraps instead of overlapping; under 520px the duplicate campaign title is
  hidden and the campaign select takes the full row.
- Stats strip: 6 → 3 → 2 columns; section titles wrap; filter rows stack; chip rows wrap.
- Map and graph heights shrink on narrow panels; equipment slots stack.
- No schema/API changes.

## Verified

Headless Edge at 1600×900 (384px dock) and 1366×768 (326px dock):
- Dashboard, Party, Inventory, Quests, Map and Studio screenshots are readable;
- Studio stays full screen;
- no page errors;
- backend suite: 76 tests pass.
