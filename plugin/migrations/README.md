# Migrations

Schema migrations are defined in `../src/db.js` as the `MIGRATIONS` array and applied by
`migrate(db)` whenever the plugin starts or when running:

```powershell
node plugins/strpg/bin/strpg-cli.js migrate
```

Rules:

- Never edit an already-applied migration.
- Append a new `{ version, name, up(db) }`.
- Back up the database before a destructive migration.
- `schema_migrations` stores applied versions.
- Current schema version: `3`.

Migration 1 creates the base tables, indexes, WAL settings and foreign keys. Migration 2 adds `event_definitions` to separate world, scene, event and story content. Migration 3 adds layered locations, portal metadata and `encounter_spawns` for lazy monster respawn.



