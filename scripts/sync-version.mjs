// Single source of truth for the app version: the root package.json "version".
// This script propagates it to every derived location so a release only requires
// editing the root version (then running `npm run sync-version`, which the build
// also runs automatically).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
if (!version) { console.error('[sync-version] root package.json has no version'); process.exit(1); }

let changed = 0;
const log = (f) => { changed++; console.log('[sync-version]', version, '→', f); };

// 1) every workspace package.json "version"
const pkgJsons = [
  'packages/desktop/package.json',
  'packages/injector-core/package.json',
  'packages/installer/package.json',
  'packages/proxy-core/package.json',
  'packages/sdk/package.json',
  'examples/hello-plugin/package.json',
  'packages/proxy-core/builtin-plugins/panel-manager/manifest.json',
];
for (const rel of pkgJsons) {
  const p = join(repo, rel);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (j.version !== version) { j.version = version; writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); log(rel); }
}

// 2) source files with a version literal — targeted regex replace
const literals = [
  ['packages/injector-core/src/engine.js', /(const FRAMEWORK_VERSION = ')[^']*(')/],
  ['packages/sdk/src/index.js',            /(export const VERSION = ')[^']*(')/],
  ['packages/proxy-core/builtin-plugins/panel-manager/src/Panel.svelte', /(const APP_VERSION = ')[^']*(')/],
];
for (const [rel, re] of literals) {
  const p = join(repo, rel);
  const src = readFileSync(p, 'utf8');
  const next = src.replace(re, `$1${version}$2`);
  if (next !== src) { writeFileSync(p, next); log(rel); }
}

// 3) the panel footer "v1.0.0"
{
  const rel = 'packages/proxy-core/builtin-plugins/panel-manager/src/Panel.svelte';
  const p = join(repo, rel);
  const src = readFileSync(p, 'utf8');
  const next = src.replace(/(<footer><span>v)[\d.]+(<\/span>)/, `$1${version}$2`);
  if (next !== src) { writeFileSync(p, next); log(rel + ' (footer)'); }
}

console.log(`[sync-version] done — ${changed} file(s) updated to ${version}.`);
