# STRPG 1.0.1 — Chat-first UI refinement

## Interface
- Replaced the persistent in-chat STRPG dock with a compact draggable floating orb.
- The orb position is saved locally and clamped to the visible viewport after resizing.
- Opening STRPG now displays a right-side panel; the SillyTavern chat remains visible and interactive.
- Closing the panel collapses it back to the floating orb.

## Workbench
- Renamed Studio navigation labels to describe their tasks more clearly.
- Added a visible next-step hint for the asset lifecycle.
- Gated Save / Validate / Approve / Publish actions by the asset status so invalid transitions are not offered.

## Compatibility
- No campaign, save, schema, or server API migrations. Existing projects and campaigns remain unchanged.
