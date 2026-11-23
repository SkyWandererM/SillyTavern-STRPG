# STRPG Installation and Deployment

## 1. Environment

Installed and verified in this checkout:

| Item | Value |
|---|---|
| SillyTavern | `1.19.0` |
| Node.js | `24.15.0` |
| OS | Windows 11 |
| SQLite | Node built-in `node:sqlite` (WAL) |
| Browser tested | Microsoft Edge 158 headless |
| Extension path | `data/<user>/extensions/strpg` (served as `/scripts/extensions/third-party/strpg`) |
| Plugin path | `plugins/strpg` (deployed from `plugin/` in this repository) |
| Database | `data/strpg/strpg.sqlite` |

Requirements:

- Node.js **>= 22.5** (`DatabaseSync`). Node 24 is recommended.
- SillyTavern 1.19.x.
- Server plugins enabled:

```yaml
enableServerPlugins: true
```

This checkout already sets it to `true`. The original file is backed up as `config.yaml.strpg-backup`.

## 2. Layout of a standard installation

This repository is the extension package itself: its root holds `manifest.json`, `index.js` and `style.css`, and its `plugin/` folder is the server plugin source.

```text
D:\SillyTavern-release\
├─ data\default-user\extensions\strpg\   Extension package (this repository)
│  ├─ manifest.json / index.js / style.css
│  ├─ frontend\                          React source
│  ├─ plugin\                            Server plugin source
│  ├─ cards\ examples\ schema\ docs\ tests\ scripts\
│  └─ build.mjs / package.mjs
├─ plugins\strpg\                        Deployed server plugin (copy of plugin\)
└─ data\strpg\strpg.sqlite               SQLite (created on first start)
```

Dependencies:

```powershell
npm install --prefix plugins/strpg
npm install --prefix data/default-user/extensions/strpg
```

`plugins/strpg` only depends on `zod`. The frontend bundle is committed; no runtime build is required.

## 3. Install from the GitHub repository

SillyTavern → Extensions → **Install extension** with:

```text
https://github.com/SkyWandererM/SillyTavern-STRPG
```

That clones the package into `data/<user>/extensions/SillyTavern-STRPG` — SillyTavern derives the folder name from the repository URL, and any folder name works as long as it contains `manifest.json`. Then deploy the plugin:

```powershell
# from the SillyTavern root; use the folder name you actually installed
Copy-Item data/<user>/extensions/SillyTavern-STRPG/plugin plugins/strpg -Recurse
npm install --prefix plugins/strpg
```

### Install from ZIP

Extract `STRPG-1.3.0.zip` somewhere inside the SillyTavern folder (the directory containing `server.js`) and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\STRPG-1.3.0\install.ps1
```

The script copies the package to `data/<user>/extensions/strpg`, deploys `plugin/` to `plugins/strpg`, sets `enableServerPlugins: true`, and installs `zod` when missing.

Ensure:

```yaml
enableServerPlugins: true
```

Restart SillyTavern.

## 4. Start and verify

```powershell
cd <SillyTavern>
node server.js
```

Expected log lines:

```text
Initializing plugin from ...\plugins\strpg\index.js
[STRPG] Database ready at ...\data\strpg\strpg.sqlite
1 server plugin(s) are currently loaded.
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/plugins/strpg/health
```

Expected:

```json
{
  "ok": true,
  "data": {
    "plugin": "STRPG",
    "schemaVersion": 3,
    "database": { "path": "...\\data\\strpg\\strpg.sqlite" }
  }
}
```

Open SillyTavern:

- The **STRPG** entry appears in the extensions menu.
- The **STRPG** launcher appears at the bottom right.
- The first launch seeds the **Emberfall Frontier** example game.

## 5. Enable or disable

### Disable the frontend

SillyTavern → Extensions → disable **STRPG — JRPG Framework**. The server plugin remains active.

### Disable the backend

```yaml
enableServerPlugins: false
```

Restart. The frontend will still load but will report API errors.

## 6. Studio permissions

Local single-user setups may run without tokens. For shared or production environments:

```powershell
$env:STRPG_STUDIO_TOKEN = "a-long-random-token"
$env:STRPG_TOOL_TOKEN = "another-long-random-token"
node server.js
```

- Studio write routes require `x-strpg-studio-token`.
- `/tools/*` requires `x-strpg-tool-token`.
- Enter the tokens in **Settings → Studio / Tool Token**. They are stored in browser localStorage.

Tokens are an additional layer, not a replacement for SillyTavern accounts, a reverse proxy, or network access control.

## 7. Data and backups

```text
data/strpg/
├─ strpg.sqlite
├─ strpg.sqlite-wal
├─ strpg.sqlite-shm
└─ backups/
   └─ strpg-2026-...json
```

- Backups are logical JSON exports of all tables and restore in a transaction.
- Before upgrades:

```powershell
node plugins/strpg/bin/strpg-cli.js backup "before upgrade"
```

- UI: **Settings → Database Backups**.
- API: `POST /api/plugins/strpg/admin/backups`.

`STRPG_DATA_DIR` overrides the data directory for tests or multiple instances.

## 8. Upgrade

1. Back up the database.
2. Update the extension package (`git pull` inside `data/<user>/extensions/strpg`, or reinstall from the repository URL).
3. Re-deploy the plugin: replace `plugins/strpg` with the package's `plugin/` folder.
4. Install new npm dependencies if needed: `npm install --prefix plugins/strpg`.
5. Restart.
6. Verify:

```powershell
node plugins/strpg/bin/strpg-cli.js verify
node plugins/strpg/bin/strpg-cli.js migrate
```

Applied migrations are recorded in `schema_migrations`. Current schema version: `3`.

## 9. Uninstall

```powershell
# 1. Disable server plugins
# config.yaml: enableServerPlugins: false

# 2. Remove the extension package
Remove-Item -Recurse data/default-user/extensions/strpg

# 3. Remove the plugin
Remove-Item -Recurse plugins/strpg

# 4. Data is kept by default; remove only after backing up
# Remove-Item -Recurse data/strpg
```

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Frontend shows API failure | `health` returns 200; `enableServerPlugins` is true; plugin log has no errors |
| `Cannot find module zod` | `npm install --prefix plugins/strpg` |
| `node:sqlite` missing | Upgrade to Node 22.5+ / 24 |
| 401/403 CSRF | The frontend uses `getRequestHeaders()`; external scripts must GET `/csrf-token` and send `x-csrf-token` |
| Studio 403 | `STRPG_STUDIO_TOKEN` is set but the UI token is missing |
| Old UI | Hard-refresh the browser; rebuild with `node build.mjs` inside the extension package |
| Database locked | Run one ST instance; `busy_timeout` is 5 seconds |
| Character card import fails | Use `cards/*.png` from the extension package; all six were verified with SillyTavern's card parser |

## 11. Restart record for this environment

To load `plugins/strpg`:

1. Backed up `config.yaml` as `config.yaml.strpg-backup`.
2. Set `enableServerPlugins: true`.
3. Restarted `node server.js`.
4. Confirmed `1 server plugin(s) are currently loaded`.
5. `health` returned 200.
6. Opened `http://127.0.0.1:8000/` in headless Edge and verified the UI and all tabs.
7. The old pre-English database was backed up to `data/strpg/backups/pre-english/`, then a fresh English seed was created.



