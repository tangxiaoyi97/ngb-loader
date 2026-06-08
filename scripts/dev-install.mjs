/**
 * dev-install.mjs — copy a plugin into the shared GeoGebra plugins folder so the
 * in-GeoGebra runtime loads it next time GeoGebra starts. Development helper.
 *
 * This installs the PLUGIN ONLY. It does not touch the framework. Plugins are
 * read live from GGB_Plugins at GeoGebra startup, so after running this you just
 * restart GeoGebra. (Framework changes still need `npm run build:proxy` + a
 * re-inject — that is intentionally separate.)
 *
 * Usage:
 *   node scripts/dev-install.mjs <plugin>          # install one
 *   node scripts/dev-install.mjs --all             # install all valid plugins in examples/
 *   node scripts/dev-install.mjs --list            # list what it can install
 *
 * <plugin> may be:
 *   - a path to a plugin folder (absolute or relative), e.g. ./examples/container-playground
 *   - a plugin folder name found under examples/, e.g. container-playground
 *
 * npm:  npm run dev:install -- <plugin>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// Where the proxy stores the shared plugin library (mirrors desktop plugins-store.js).
function pluginRoots() {
  const home = homedir();
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return [join(base, 'GeoGebra (NeoGebra)', 'GGB_Plugins'), join(base, 'GeoGebra', 'GGB_Plugins')];
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [join(base, 'GeoGebra (NeoGebra)', 'GGB_Plugins'), join(base, 'GeoGebra', 'GGB_Plugins')];
  }
  const base = join(home, '.config');
  return [join(base, 'GeoGebra (NeoGebra)', 'GGB_Plugins'), join(base, 'GeoGebra', 'GGB_Plugins')];
}
function resolvePluginsRoot() {
  const roots = pluginRoots();
  return roots.find((r) => existsSync(r)) || roots[0]; // prefer an existing one
}

// Where plugins live in the repo. `--all` scans this folder; an explicit name or
// path can still target a plugin anywhere.
const EXAMPLES_DIR = join(REPO, 'examples');
const SEARCH_DIRS = [EXAMPLES_DIR];

function isPluginDir(dir) {
  return existsSync(join(dir, 'manifest.json'));
}

// A plugin is "valid/standard" if its manifest has an id, a main entry, and that
// entry file exists. Keeps half-finished folders out of `--all`.
function isValidPlugin(dir) {
  if (!isPluginDir(dir)) return false;
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (!m || !m.id) return false;
    const main = m.main || 'src/index.js';
    return existsSync(join(dir, main));
  } catch { return false; }
}

// Find every valid plugin folder under examples/.
function discoverPlugins() {
  const found = new Map(); // folderName -> absolute dir
  for (const base of SEARCH_DIRS) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const dir = join(base, entry.name);
      if (isValidPlugin(dir) && !found.has(entry.name)) found.set(entry.name, dir);
    }
  }
  return found;
}

function resolvePluginDir(arg) {
  // 1) explicit path?
  const asPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (existsSync(asPath) && isPluginDir(asPath)) return asPath;
  // 2) by folder name in known locations
  const all = discoverPlugins();
  if (all.has(arg)) return all.get(arg);
  return null;
}

function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); }
  catch (e) { throw new Error(`invalid manifest.json in ${dir}: ${e.message}`); }
}

// Copy a plugin folder's installable parts into GGB_Plugins/<id>/.
function installOne(dir) {
  const manifest = readManifest(dir);
  const id = manifest.id || dir.split(/[\\/]/).pop();
  const root = resolvePluginsRoot();
  const dest = join(root, id);
  mkdirSync(root, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // Copy manifest, source, and any icon referenced (plus common extras).
  const items = new Set(['manifest.json', 'src']);
  if (manifest.icon && typeof manifest.icon === 'string' && !/^data:/i.test(manifest.icon)) items.add(manifest.icon);
  for (const extra of ['icon.png', 'icon.svg', 'README.md']) items.add(extra);
  let copied = 0;
  for (const item of items) {
    const from = join(dir, item);
    if (!existsSync(from)) continue;
    cpSync(from, join(dest, item), { recursive: true });
    copied += 1;
  }
  return { id, dest, copied };
}

function printList() {
  const all = discoverPlugins();
  if (!all.size) { console.log('No plugins found in the repo.'); return; }
  console.log('Installable plugins:');
  for (const [name, dir] of all) {
    let id = name;
    try { id = readManifest(dir).id || name; } catch { /* ignore */ }
    console.log(`  ${name}${id !== name ? ` (id: ${id})` : ''}  →  ${dir.replace(REPO, '.')}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/dev-install.mjs <plugin|--all|--list>');
    console.log('  <plugin>  a plugin folder path, or a folder name under examples/ (e.g. container-playground)');
    console.log('  --all     install every valid plugin in examples/');
    console.log('  --list    list installable plugins (in examples/)');
    process.exit(args.length ? 0 : 1);
  }
  if (args.includes('--list')) { printList(); return; }

  const targets = [];
  if (args.includes('--all')) {
    for (const dir of discoverPlugins().values()) targets.push(dir);
  } else {
    for (const arg of args) {
      if (arg.startsWith('-')) continue;
      const dir = resolvePluginDir(arg);
      if (!dir) { console.error(`✗ plugin not found: ${arg}`); process.exitCode = 1; continue; }
      targets.push(dir);
    }
  }
  if (!targets.length) { console.error('Nothing to install.'); process.exit(1); }

  for (const dir of targets) {
    try {
      const { id, dest, copied } = installOne(dir);
      console.log(`✓ ${id} → ${dest}  (${copied} item${copied === 1 ? '' : 's'})`);
    } catch (e) {
      console.error(`✗ ${dir}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log('\nRestart GeoGebra (or use “调试启动 GeoGebra”) to load the changes.');
}

main();
