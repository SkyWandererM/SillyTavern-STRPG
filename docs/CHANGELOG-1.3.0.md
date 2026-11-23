# STRPG 1.3.0 — Batch queue: reserve slots, generate one by one

The Director's Room can now plan a batch of same-kind assets, reserve their
keys and titles as blank DRAFTs, then generate each item through the normal AI
modal in order. Keys and titles are locked to the reserved slot; the DRAFT is
updated in place.

## New: batch planning

- A role's **Batch** button opens a planner: asset kind, count (1–12), theme and
  the current memory/blackboard context.
- The planner returns only `key | Title | one-sentence brief` lines. It does not
  write assets.
- The plan table is editable; rows can be added or removed. One row becomes one
  asset.
- A batch is persisted in `project.metadata.director.batches`.

## Reserve, then generate

- **Reserve DRAFTs** creates one blank DRAFT per planned row using the canonical
  asset template, with the planned key and title. Key collisions are renamed
  with `_2`, `_3` and reported; the plan table is updated.
- **Generate next** opens the existing AI modal with:
  - the row's brief as the Designer prompt;
  - the batch kind preselected;
  - the role-relevant project keys as Reference keys;
  - the reserved key and title locked.
- `normalizeGeneratedAsset` now supports `lockedKey` / `lockedName`; the model
  cannot rename the reserved slot.
- `Create DRAFT` updates the reserved DRAFT in place because the project already
  has a DRAFT with that key. No duplicate asset is created.
- Queue status moves `planned → reserved → generated`. `Regenerate` is allowed
  for generated rows and updates the same DRAFT.
- **Auto-advance** reopens the generator for the next reserved row after a save.
  It still opens the normal review modal; it is not an unattended background
  chain.

## Boundaries

- The generator remains **one JSON object / one asset per call**. A five-quest
  batch is five explicit generation calls.
- Blank reserved DRAFTs may not pass full package validation until their fields
  are filled; that is expected for a reservation.
- The queue does not publish; each generated asset still goes through Save →
  Validate → Approve → Publish.
- Deleting a batch removes the queue, not the reserved DRAFT assets.
- No schema or server API change; no migration.

## Verification

- 39 Vitest cases, including batch-plan parsing, duplicate key suffixing,
  director-state batch normalization and locked-key generation.
- Browser: plan 3 quests with a stubbed model, reserve 3 DRAFTs, generate one
  with a locked key/title, auto-advance reopens the next item. Temporary project
  cleaned up.
