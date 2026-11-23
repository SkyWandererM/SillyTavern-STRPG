import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const distDir = path.join(__dirname, 'dist');
const stage = path.join(distDir, `STRPG-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const SKIP = new Set([
    'node_modules',
    'dist',
    '.git',
    'tmp-fix-import.mjs',
]);

function copyRecursive(source, destination) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        if (SKIP.has(path.basename(source))) return;
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(destination, entry));
        }
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

// The repository root *is* the extension directory. The staged copy keeps that
// shape, so extracting it is enough to install: manifest.json sits at the root.
copyRecursive(__dirname, stage);

// The server plugin needs its single runtime dependency to work offline.
copyRecursive(path.join(__dirname, 'plugin', 'node_modules', 'zod'), path.join(stage, 'plugin', 'node_modules', 'zod'));

const installScript = `# STRPG installer (PowerShell)
$ErrorActionPreference = 'Stop'
$stage = Split-Path -Parent $MyInvocation.MyCommand.Path

# Locate the SillyTavern root above the extracted folder.
$root = $stage
while ($root -and -not (Test-Path (Join-Path $root 'server.js'))) {
    $parent = Split-Path -Parent $root
    if ($parent -eq $root) { $root = $null; break }
    $root = $parent
}
if (-not $root) {
    throw 'Extract STRPG-${version}.zip inside the SillyTavern folder (the one containing server.js) and run this script again.'
}

$userHandle = 'default-user'
if (-not (Test-Path (Join-Path $root "data\\$userHandle"))) {
    $candidate = Get-ChildItem (Join-Path $root 'data') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $userHandle = $candidate.Name }
}

$extensionDir = Join-Path $root "data\\$userHandle\\extensions\\strpg"
$pluginDir = Join-Path $root 'plugins\\strpg'

New-Item -ItemType Directory -Path (Split-Path -Parent $extensionDir) -Force | Out-Null

if (Test-Path $pluginDir) {
    Write-Host "Keeping existing server plugin at $pluginDir"
    Remove-Item (Join-Path $stage 'plugin') -Recurse -Force
}
if (Test-Path $extensionDir) {
    Write-Host "Updating existing extension at $extensionDir"
    Copy-Item (Join-Path $stage '*') $extensionDir -Recurse -Force
} else {
    Copy-Item $stage $extensionDir -Recurse -Force
}

if (Test-Path (Join-Path $stage 'plugin')) {
    Move-Item (Join-Path $stage 'plugin') $pluginDir
}

if (-not (Test-Path (Join-Path $root 'config.yaml.strpg-backup')) -and (Test-Path (Join-Path $root 'config.yaml'))) {
    Copy-Item (Join-Path $root 'config.yaml') (Join-Path $root 'config.yaml.strpg-backup') -Force
}
$configPath = Join-Path $root 'config.yaml'
$config = Get-Content $configPath -Raw
if ($config -match 'enableServerPlugins:\\s*false') {
    $config = $config -replace 'enableServerPlugins:\\s*false', 'enableServerPlugins: true'
    Set-Content $configPath -Value $config -NoNewline
    Write-Host 'Enabled enableServerPlugins: true (backup: config.yaml.strpg-backup)'
} elseif ($config -notmatch 'enableServerPlugins:\\s*true') {
    Add-Content $configPath 'enableServerPlugins: true'
    Write-Host 'Appended enableServerPlugins: true'
}

if (-not (Test-Path (Join-Path $pluginDir 'node_modules\\zod'))) {
    Write-Host 'Installing backend dependency zod...'
    npm install --prefix $pluginDir --no-audit --no-fund
}

Write-Host ''
Write-Host "STRPG installed into $extensionDir"
Write-Host "Server plugin at $pluginDir"
Write-Host 'Restart SillyTavern (node server.js) and open the STRPG launcher.'
Write-Host 'Health check: Invoke-RestMethod http://127.0.0.1:8000/api/plugins/strpg/health'
`;
fs.writeFileSync(path.join(stage, 'install.ps1'), installScript, 'utf8');

const zipName = `STRPG-${version}.zip`;
const zipPath = path.join(distDir, zipName);
fs.rmSync(zipPath, { force: true });
await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(stage, `STRPG-${version}`);
    archive.finalize();
});
const size = fs.statSync(zipPath).size;
console.log(`[package] ${zipPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[package] staged at ${stage}`);
