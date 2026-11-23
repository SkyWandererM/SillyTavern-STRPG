# Changelog 1.8.1 — Movable launcher and chat-aware panel layout

Released: 2026-11-24

UI-only release. No schema, API or data changes.

## Floating launcher

- The orb is now reliably draggable: pointer capture, a 3px move threshold, viewport
  clamping, `touch-action: none`, and the position persists in
  `localStorage["strpg.launcher.position.v2"]`.
- **Double-click resets** it to the new default position (bottom-left), so it no longer
  starts on top of other extensions' floating buttons (for example the Scene Continuity
  Bridge orb in the bottom-right corner).
- The orb stays available whenever the panel is closed, including while a campaign is
  loaded (previously it hid itself once a dashboard existed, which made reopening awkward).

## Panel layout

- **Docked mode**: the panel is placed in the gutter immediately beside the chat window
  (`left = chat.right + 8`), with the same top edge and height as `#chat`, so it never covers
  the conversation. If the right gutter is too narrow it docks on the left side of the chat;
  if neither gutter fits, it falls back to the previous overlay mode.
- The dock recomputes on window resize and on `#chat` size changes (`ResizeObserver`), so
  ST's own sidebars opening/closing keeps the alignment correct.
- **Compact / narrow breakpoints**: below 640px the sidebar shrinks to 132px; below 380px it
  becomes a 56px icon rail. Main content keeps the remaining width.
- **Studio tab is full screen**: `strpg-root-studio` uses `inset: 0`, 100vw × 100vh and
  removes the shell border/radius.

## Verification

- Headless Edge against the running SillyTavern (1600×900 and 1366×768):
  - launcher drags, position persists, double-click resets;
  - docked panel at 1600: `1208…1592` vs chat `400…1200` (no overlap, top 70, height 790);
  - at 1366: `1033…1359` vs chat `342…1025` (icon rail);
  - Studio: panel `0,0,1600×900`;
  - no page errors.
- Backend suite unchanged: **76 tests pass**.
