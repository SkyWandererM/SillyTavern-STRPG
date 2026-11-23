# Campaign Content Upgrades

A Campaign is normally frozen to the Game Version it was created from. **Campaign Upgrade** is the controlled exception: it attaches a newer published version to an existing Campaign and preserves the save.

This is designed for modular content growth:

```text
v1: base world
v2: v1 + Moonlit Glade + The Glade Answers event + The Glade Keeper NPC
v3: v2 + a new quest chain
```

A designer can deliver one module at a time. Build and publish it as the next Game Version, then upgrade the running Campaign.

## 1. What is preserved

Mapped by stable keys:

- player level, EXP, HP/MP, gold
- inventory and equipment
- unlocked skills
- quest instances, stage, objective progress and status
- campaign flags and variables
- current story node, visited nodes, story variables, ending
- discovered locations
- NPC entities, party membership and relationship variables
- historical combat sessions and narrative mirror state
- chat bindings
- old save snapshots

New content is instantiated:

- new Scene/Location definitions
- new connections
- new Event definitions
- new NPC entities at their defined locations
- new Quest definitions become available instances
- new Story nodes and edges

Existing Events do **not** re-fire. New Event assets fire according to their trigger and `once` state.

## 2. What blocks an upgrade

The UI/API refuses to upgrade when state cannot be mapped safely:

- pending or active combat
- a different Studio project or world key
- target version is not newer or not published
- the player class was removed
- the current location was removed
- an entity's location was removed
- an inventory item was removed
- an unlocked skill was removed
- an active status effect was removed
- a quest was removed
- the active quest stage or objective was removed
- the current Story node was removed
- an existing NPC was removed

This is deliberate: it never silently drops a save.

## 3. Create a module

Example: add a new location, event and NPC.

1. Studio → **+ Content**
2. Create `scene` `moonlit_glade`
   - map coordinates, description, encounters
   - `eventKeys: ["glade_awakening"]`
3. Create `event` `glade_awakening`
   - `scope: "scene"`, `sceneKey: "moonlit_glade"`
   - `trigger: "enter"`, `once: true`
   - structured actions
4. Create `npc` `glade_keeper`
   - `locationKey: "moonlit_glade"`
5. To connect the new Scene, open the existing Scene (for example `mistfall_town`) → **New Revision** → add the connection → publish that revision.
6. Validate, review and publish every new asset.
7. **Build New Version** with notes such as `Moonlit Glade module`.
8. **Publish** the version.

A published version is immutable. The module is the set of new revisions/assets included in that version.

## 4. Apply the upgrade

Dashboard → **Content Upgrade → Review Upgrade**:

- select a target version
- inspect added Scenes / Events / NPCs / Monsters / Items / Skills / Quests / Story nodes
- inspect blockers
- click **Upgrade to vN**

The server:

1. re-checks all blockers;
2. creates a `Before upgrade vX -> vY` snapshot;
3. switches `campaigns.world_id` and `game_version_id`;
4. remaps entities, locations, inventory, equipment, skills, quests and effects by key;
5. instantiates new NPCs and quest instances;
6. restores the current location and discovered locations by key;
7. creates an `Upgraded to vY` snapshot;
8. writes `campaign.upgraded` to the event log.

The API is transactional. A failure rolls back the entire upgrade.

## 5. Event behavior

Scene Events require both:

- `event.scope = "scene"` and `event.sceneKey`
- the Scene's `eventKeys` containing that event key

An unreferenced Scene Event is ignored. Adding only the Event asset is not enough; the Scene needs a new revision that references it.

```json
{
  "key": "moonlit_glade",
  "eventKeys": ["glade_awakening"]
}
```

This keeps Scene, Event and Story modules independently reviewable.

## 6. Snapshots and rollback

The upgrade creates two automatic snapshots:

- `Before upgrade vX -> vY`
- `Upgraded to vY`

`Before upgrade` restores the Campaign row, entities, locations references and event state from before the upgrade. It is a recovery point, not a version rollback UI: the target Game Version itself remains published and immutable.

Published versions are never modified. Rolling back a **game version** in Studio is a separate operation that creates another published version; it does not rewrite history.

## 7. API

```http
GET /api/plugins/strpg/campaigns/:id/upgrades
```

```json
{
  "currentVersion": { "id": "ver_...", "version": 1 },
  "available": [
    {
      "targetVersion": { "id": "ver_...", "version": 2, "notes": "Moonlit Glade module" },
      "diff": {
        "locations": { "added": [{ "key": "moonlit_glade", "name": "Moonlit Glade" }], "removed": [] },
        "events": { "added": [], "removed": [] }
      },
      "blockers": [],
      "canUpgrade": true
    }
  ]
}
```

```http
GET /api/plugins/strpg/campaigns/:id/upgrades/:versionId/preview
POST /api/plugins/strpg/campaigns/:id/upgrade
Content-Type: application/json

{ "versionId": "ver_..." }
```

CSRF applies to the POST.

## 8. Design implications for designers

- Split work into modules instead of rebuilding the whole world.
- Keep keys stable; upgrades map state by key.
- Do not remove keys used by an existing Campaign; add and deprecate instead.
- Add one connection revision to an existing Scene rather than duplicating the whole Scene.
- Put scripted logic in Event assets, not Scene inline actions.
- Use build notes to name the module; the Dashboard uses them.
- Test with a throwaway Campaign before upgrading a long-running one.

## 9. Limitations

- Upgrade requires the same Studio project and world key.
- Only published versions can be targets.
- Active/pending combat blocks upgrade.
- Removed content blocks upgrade; additive modules are the supported path.
- It does not merge two different worlds or import a Campaign from another database.
- Existing Campaign snapshots remain tied to the version they were captured from; the pre-upgrade snapshot is the intended recovery point.
- Event `flag` and `quest` trigger names are reserved and are not automatically dispatched yet.
