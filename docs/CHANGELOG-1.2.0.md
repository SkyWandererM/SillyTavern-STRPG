# STRPG 1.2.0 — Director's Room

A new authoring surface for the solo director/player. It introduces persistent
role-based content planning, a narrator memory book, explicit handoffs between
roles, and a layered anti-spoiler workflow. No schema migration: state lives in
`project.metadata.director`.

## New: Studio → Director's Room

- Nine authoring roles, each owning a content domain:
  Narrator (story), Quest Designer (quest), Casting Director (NPC), Ecologist
  (monster), Cartographer (scene), Quartermaster (equipment), Skill Wright
  (skill/status effect), Rules Keeper (class/rules), Continuity Editor (review).
- Each role has editable guidance, an Ask command and a next-role handoff.
- **Ask** returns three sections: `PLAYER-SAFE BRIEF`, `DIRECTOR NOTES`,
  `HANDOFF`. The brief is the only part usable as a public content prompt.
- **Save to memory** stores the brief as player-known and the notes as
  director-only.
- **Record handoff** writes an explicit role-to-role message. A role card shows
  its handoff inbox, and **Follow handoff** opens the target role with the
  message as its question.
- **Use brief in AI generator** opens the existing Workbench AI modal with the
  brief as the prompt, the role's asset kind selected, and relevant project keys
  prefilled as Reference keys. The result is still only a DRAFT.

## Memory book and blackboard

- Memory entries carry `player`, `director` or `secret` visibility.
- The blackboard stores canon facts, decisions, open threads and handoffs.
- Player-safe view hides director/secret memory, handoffs and director notes and
  redacts protected terms in visible text.
- The room is persisted on the Studio project, so it survives reloads and
  travels with the project.

## Anti-spoiler layers

- Explicit visibility on memory and blackboard entries.
- Sectioned model output: brief vs notes vs handoff.
- **Spoiler Guard**: protected terms are scanned in player-safe briefs and
  generated assets.
- **Hard stop**: saving a brief to memory or sending it to the AI generator is
  blocked while the brief contains a protected term. The user must redact or
  remove the term from the guard.
- Generated assets that contain protected terms cannot create a DRAFT until the
  JSON is fixed.
- The game chat's existing `STRPG_CONTEXT` remains separate; Director notes are
  never injected into it.
- A model can still imply a secret without using a protected term. Human review
  remains the final gate; this is documented, not hidden.

## Verification

- 37 Vitest cases, including Director state normalization, memory visibility
  filtering, section parsing, spoiler redaction and project-key suggestions.
- Browser verification: 9 role cards, stubbed Ask → three sections, save to
  memory, handoff inbox/Follow handoff, player-safe view, protected-term block +
  Redact, and brief → AI generator prefill.
- Existing campaigns, projects, saves and published games are unchanged.
