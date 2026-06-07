// Assemble the shippable proxy folder (packages/proxy-core/dist/): package.json,
// main.js, preload.js, and assets/runtime.bundle.js. Also builds the runtime first.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const proxySrc = join(root, 'packages', 'proxy-core', 'src');
const proxyPkg = join(root, 'packages', 'proxy-core', 'package.json');
const runtimeBundle = join(root, 'packages', 'proxy-core', 'runtime', 'dist', 'runtime.bundle.js');
const out = join(root, 'packages', 'proxy-core', 'dist');

function log(...a) { console.log('[build:proxy]', ...a); }

// 0) Build the runtime (panel-manager plugin → runtime bundle) first.
// This MUST succeed — if it fails we would otherwise ship a stale runtime
// bundle (old panel/version), so fail loudly instead of swallowing the error.
try {
  execFileSync('node', [join(root, 'packages', 'proxy-core', 'build-runtime.mjs')], { stdio: 'inherit' });
} catch (err) {
  console.error('\n[build:proxy] ERROR: runtime build failed — NOT shipping a stale bundle.');
  console.error('[build:proxy] Most likely the proxy-core build deps are missing. Run:');
  console.error('[build:proxy]   npm install            (esbuild + esbuild-svelte + svelte)\n');
  process.exit(1);
}

// Clean the output dir, but tolerate filesystems where deleting individual files
// is restricted (e.g. some network/sandbox mounts) — we overwrite in place via
// copyFileSync (force) below, so a stale file is harmless.
try {
  rmSync(out, { recursive: true, force: true });
} catch (err) {
  log('note: could not fully clean dist (' + err.code + '); overwriting in place');
}
mkdirSync(join(out, 'assets'), { recursive: true });

// Explicitly remove KNOWN-STALE artifacts from older builds so an injected app
// can never pick up a leftover (e.g. the pre-runtime panel bundle).
for (const stale of ['assets/panel.bundle.js']) {
  try { rmSync(join(out, stale), { force: true }); } catch { /* ignore */ }
}

// Copy that tolerates a read-only existing destination on quirky mounts:
// try to remove the target first (ignore errors), then copy.
function copy(src, dest) {
  try { rmSync(dest, { force: true }); } catch { /* ignore */ }
  copyFileSync(src, dest);
}

// Stamp the dist package.json with a build timestamp so we can verify (in logs /
// the injected app) exactly which proxy build was installed.
const pkg = JSON.parse(readFileSync(proxyPkg, 'utf8'));
pkg.builtAt = new Date().toISOString();
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2));
copy(join(proxySrc, 'main.js'), join(out, 'main.js'));
copy(join(proxySrc, 'preload.js'), join(out, 'preload.js'));

if (existsSync(runtimeBundle)) {
  copy(runtimeBundle, join(out, 'assets', 'runtime.bundle.js'));
  log('bundled runtime.bundle.js (SDK + loader + built-in panel)');
} else {
  log('WARNING: runtime bundle missing — runtime build may have failed.');
}

// Also ship the builtin panel-manager (manifest + compiled bundle) so the desktop
// app can seed it into the on-disk plugin library (so it shows in the list).
const panelMgr = join(root, 'packages', 'proxy-core', 'builtin-plugins', 'panel-manager');
const panelMgrBundle = join(panelMgr, 'dist', 'index.bundle.js');
if (existsSync(panelMgrBundle)) {
  mkdirSync(join(out, 'builtin-plugins', 'panel-manager', 'dist'), { recursive: true });
  copy(join(panelMgr, 'manifest.json'), join(out, 'builtin-plugins', 'panel-manager', 'manifest.json'));
  copy(panelMgrBundle, join(out, 'builtin-plugins', 'panel-manager', 'dist', 'index.bundle.js'));
  const panelIcon = join(panelMgr, 'icon.png');
  if (existsSync(panelIcon)) copy(panelIcon, join(out, 'builtin-plugins', 'panel-manager', 'icon.png'));
  log('bundled builtin panel-manager (for desktop seeding)');
}

log('proxy assembled at', out, '(builtAt ' + pkg.builtAt + ')');
