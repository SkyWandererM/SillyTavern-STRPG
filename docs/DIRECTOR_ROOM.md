# Director's Room

The Director's Room is an authoring table inside **Studio**. It exists because
one person is both the director and the player: you want to experience the
campaign you imagined, but you also want it to surprise you. The room keeps the
authoring knowledge, the player-facing knowledge and the generation commands
separate.

## 1. Why roles instead of one prompt

A single all-purpose prompt tends to blend NPCs, quests, scenes and items, and
it leaks future plot into whatever it generates. The room gives each content
domain its own author:

| Role | Owns | Default asset | Next handoff |
|---|---|---|---|
| Narrator | Story & continuity | Story | Quest Designer |
| Quest Designer | Quests | Quest | Casting Director |
| Casting Director | NPCs | NPC | Ecologist |
| Ecologist | Monsters & encounters | Monster | Cartographer |
| Cartographer | Scenes & routes | Scene | Quartermaster |
| Quartermaster | Equipment & items | Equipment | Skill Wright |
| Skill Wright | Skills & status effects | Skill | Rules Keeper |
| Rules Keeper | Classes & rules | Class | Continuity Editor |
| Continuity Editor | Consistency & spoiler audit | none | Narrator |

Each role has an editable **Guidance** field. The shared prompt builder adds the
memory book, canon facts, decisions, open threads, handoffs, existing project
keys and the shared output contract. You do not have to repeat those in every
prompt.

Each Ask is tuned for **one primary asset**. If a role sees several possible
directions, it puts the alternatives in `DIRECTOR NOTES` rather than the
player-safe brief. The AI generator is a one-object-at-a-time interface; a brief
that contains three complete quests would be collapsed to one object. Split a
multi-resource plan into one brief per asset before generating.

## 2. The memory book

The Narrator owns a memory book with three visibility levels:

- **player** — the player knows this. Safe to show and safe to use in a
  player-facing brief.
- **director** — authoring knowledge. Shown in Director view; hidden in
  Player-safe view.
- **secret** — future twists, hidden identities, unrevealed places. Hidden in
  Player-safe view and scanned by the Spoiler Guard.

Ask the Narrator for a recent summary and the next hook and it returns:

```text
### PLAYER-SAFE BRIEF
### DIRECTOR NOTES
### HANDOFF
```

The brief is the only part used as a public prompt. The notes stay in the room.
The handoff is the message to the next author.

## 3. Blackboard and handoffs

The blackboard holds:

- **facts** — canon the room must not forget;
- **decisions** — choices already made;
- **open threads** — unresolved promises and dangers;
- **handoffs** — explicit messages such as
  `Narrator → Quest Designer: turn the missing sigil into a level 3 side quest`.

A role card shows its handoff inbox. Pressing **Ask** on that card pre-fills the
latest handoff as the question, and each handoff row has **Follow handoff**. This
is how the room communicates without a hidden auto-pipeline: you stay in control
of when the next model call happens and what it sees.

## 4. Workflow

1. Open **Studio → Director's Room**.
2. Press **Ask Narrator** (or a role's **Ask**) and read the three sections.
3. Edit the player-safe brief and director notes.
4. **Save to memory**; **Record handoff** to the next role.
5. On the next role card, press **Ask** (it uses the handoff) or open the
   handoff and press **Follow handoff**.
6. When a brief is ready, press **Use brief in AI generator**. The existing
   Workbench AI modal opens with the brief as its prompt, the role's asset kind
   selected, and existing project keys prefilled as Reference keys.
7. Generate, review the preview warnings, and **Create DRAFT**. The normal
   lifecycle still applies: Save → Validate → Approve → Publish.
8. Use the Continuity Editor when roles start contradicting each other or when
   you want a spoiler audit before publishing a chapter.

## 4b. Batch queue: reserve first, generate one by one

Some resources need to be planned together before any one of them can be
written: three linked quests, a zone's NPC cast, a dungeon's monster set. The
batch queue handles this without breaking the one-asset-per-generation contract.

1. On a role card, press **Batch**. Choose the asset kind, count (1–12) and an
   optional theme. The role returns only planning lines:
   `key | Title | one-sentence brief`.
2. Edit the plan table. One row becomes one asset. Keys should be stable because
   other resources will reference them.
3. Press **Create batch**. The queue is saved in the project.
4. Press **Reserve DRAFTs**. The room creates one blank DRAFT per row with the
   planned key and title. If a key collides with an existing asset, it is renamed
   `_2`, `_3`, … and the change is reported.
5. Press **Generate next**. The normal AI modal opens with the row's brief, the
   batch kind, relevant project keys and the **locked key/title**. Create DRAFT
   updates the reserved DRAFT in place instead of creating a duplicate.
6. Optional **Auto-advance** reopens the generator for the next reserved row
   after each save. It still opens the normal review modal; it is not an
   unattended background chain.
7. Reserved DRAFTs may not pass full package validation until their fields are
   filled; that is expected. Each generated item still follows Save → Validate →
   Approve → Publish.
8. Deleting a batch removes the queue only; the reserved DRAFT assets remain.

The queue stores statuses `planned → reserved → generated` per row, plus the
asset id and generation time. It is persisted under
`project.metadata.director.batches`.

## 5. Anti-spoiler layers

1. **Explicit visibility** on every memory entry and blackboard item.
2. **Sectioned output** — player-safe brief vs director notes vs handoff.
3. **Spoiler Guard** — a list of protected terms (names, twists, future places)
   is scanned in every player-safe brief.
4. **Hard stop** — if a brief contains a protected term, **Save to memory** and
   **Use brief in AI generator** are disabled until you redact or remove the
   term from the guard.
5. **Player-safe view** — hides director/secret memory, handoffs and director
   notes, and redacts protected terms in visible text.
6. **Generator scan** — the AI content modal receives the protected terms and
   warns when the generated JSON contains them. **Create DRAFT** is blocked
   while a protected term remains.
7. **Prompt contract** — roles are told that hidden facts may shape the notes
   but must never appear in the player-safe brief.

What this does **not** guarantee: a model can reveal a secret that is not in the
protected-terms list, or write an implication that is not a literal term. The
brief/notes split and the human review step are still the real gate. Add the
names and phrases you care about to the Spoiler Guard before generating a
chapter.

## 6. Persistence

The room is stored in `project.metadata.director` through the existing project
PATCH route. It travels with the Studio project and needs no database migration.
It contains memory, blackboard, role guidance, last brief/notes and protected
terms.

## 7. Current boundaries

- The room is **stepwise**, not an automatic multi-role pipeline. Each model call
  is explicit so you can stop, edit or change direction.
- **One generated asset per model call.** The generator instructs the model to
  return a single JSON object and creates one DRAFT. A role that plans three
  quests is planning, not batch-creating; split the list and generate each quest
  separately. Structured multi-asset JSON can still go through Studio's Import
  tab, but that is not the Director's Room generator.
- The memory book is not yet auto-ingested from campaign events; ask the Narrator
  for a summary or paste the events you want remembered.
- Role quality depends on the selected model. Local 12B models can take a minute
  or more per answer; the Ask dialog shows elapsed seconds.
- The Continuity Editor reviews the material it is given; it cannot inspect
  content that was never saved to memory or the blackboard.
- The AI generator still creates DRAFT assets only. The Director's Room never
  publishes, edits stats directly, or changes a running campaign.
