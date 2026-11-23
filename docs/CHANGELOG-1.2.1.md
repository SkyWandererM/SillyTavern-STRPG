# STRPG 1.2.1 — One primary asset per role Ask

Small alignment release for the Director's Room after the first real use
question: *can one Ask generate several quests?*

## Changed

- Every Director's Room authoring role now asks for **one primary asset** per
  Ask. The old "one to three" wording was planning-friendly but conflicted with
  the AI generator, which requires one JSON object and creates one DRAFT.
- Alternative castings, encounters, scenes, items, skills and quest hooks now
  go into `DIRECTOR NOTES` instead of the player-safe brief, so the brief maps
  cleanly to one generation call.
- Narrator handoffs still work the same way; a role can be asked again for the
  next asset.

## Clarified

- The room is stepwise; it is not an automatic background generator.
- The AI generator is one-object-at-a-time. To create three quests, produce
  three briefs and generate three DRAFTs, or use the structured Import tab for
  batch JSON.
- Structured batch import is not the AI generator and does not normalize model
  output; it expects valid asset JSON.

No schema or server API change; project, campaign and save data are untouched.
