# STRPG 1.1.0 — RPG state panel and AI content workbench

This release turns the control center into a game state surface and gives the
Workbench a real content-production loop. The server database schema is
unchanged: existing projects, campaigns, saves and published versions keep
working.

## Adventure panel (former Dashboard)

- The Dashboard is now a game state sheet: scene banner, vitals, equipment,
  status effects, party roster, local NPCs, routes, quest objectives, combat
  roster and a chronicle/journal feed.
- New dashboard payload fields (server): `party`, `nearbyNpcs`, `exits`,
  `combat`, `effects`, `inventory` and `journal`. `getDashboard` remains the one
  aggregate request used by the client.
- Routes show travel cost and lock state (condition or gold). Local NPC cards
  open the existing interaction dialog, including shops.
- Campaign binding, snapshots and content upgrades are compacted into a single
  campaign strip instead of competing with the game state.

## Chat-side HUD

- A collapsible RPG status rail is docked beside the chat: HP/MP, level, gold,
  party avatars, active quest objectives, encounter alert and one-click routes.
- The rail remembers its collapsed state in `localStorage` and collapses to a
  narrow level/HP/combat strip.
- The HUD refreshes after each received message, after every rules-engine
  mutation, and when the active chat changes.
- Travel and Explore actions are available without opening the full panel.
  Exploration results still go through the authoritative `/explore` route.

## Workbench (RPG database layout)

- New Workbench header with project counts, `New DRAFT` palette for all content
  kinds, `Generate with AI`, import tools and a database filter bar.
- Kind filters, text search, expand/collapse and a child-area shortcut make the
  world tree behave like an RPG Maker database rather than a raw file list.
- Selected entry now shows a lifecycle stepper (DRAFT → VALIDATION → REVIEWED →
  PUBLISHED), the asset key/revision, and gated actions. `AI Rewrite` and
  `Duplicate` were added.
- The arrow-key/Delete behavior and drag-and-drop parenting remain unchanged.

## AI content interface

- New `GenerateAssetModal` supports all 12 content kinds, 30+ preset prompts,
  tone, level band, anchor scene, reference keys and an editable compiled
  prompt.
- Generation calls SillyTavern `generateQuietPrompt` (falling back to
  `generateRaw`) so the user's configured model and connection are used. STRPG
  never contacts a provider directly.
- The model must return one JSON object; the client extracts it, merges it onto
  the canonical asset template, enforces unique keys, applies scene context and
  shows readiness warnings before creating a DRAFT.
- `AI Rewrite` on a selected entry applies the result to the editor only; the
  designer still has to Save DRAFT, Validate, Approve and Publish.
- Preset prompts cover NPC (quest giver, merchant, companion, antagonist,
  healer), scene (settlement, wilderness, dungeon, interior), quest, monster,
  item, skill, event, story, class, status effect, world and rules.

## Compatibility

- No SQL migrations. Existing `content_assets`, `campaigns`, `chat_bindings`
  and saves are untouched.
- API additions are fields only. Existing clients that ignore unknown fields
  keep working; `pendingCombat` is preserved alongside the new `combat` summary.
- Build output is installed at
  `public/scripts/extensions/third-party/strpg` and plugin version reports
  `1.1.0` on `/api/plugins/strpg/health`.
