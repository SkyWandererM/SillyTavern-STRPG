import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This repository root is the extension directory itself:
// <ST>/data/<user>/extensions/strpg -> served as /scripts/extensions/third-party/strpg
const extensionDir = __dirname;
fs.mkdirSync(extensionDir, { recursive: true });

const manifest = {
    display_name: 'STRPG — JRPG Framework',
    loading_order: 90,
    requires: [],
    optional: [],
    js: 'index.js',
    css: 'style.css',
    author: 'STRPG',
    version: '1.5.0',
    homePage: 'https://github.com/SkyWandererM/SillyTavern-STRPG',
    hooks: {},
};

const result = await build({
    entryPoints: [path.join(__dirname, 'frontend', 'src', 'index.jsx')],
    bundle: true,
    outfile: path.join(extensionDir, 'index.js'),
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    define: {
        'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'info',
});

if (result.errors.length) {
    process.exitCode = 1;
} else {
    fs.writeFileSync(path.join(extensionDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.copyFileSync(path.join(__dirname, 'frontend', 'src', 'styles.css'), path.join(extensionDir, 'style.css'));
    const size = fs.statSync(path.join(extensionDir, 'index.js')).size;
    console.log(`[build] Extension written to ${extensionDir}`);
    console.log(`[build] index.js ${(size / 1024).toFixed(1)} KB, style.css ${(fs.statSync(path.join(extensionDir, 'style.css')).size / 1024).toFixed(1)} KB`);
}
