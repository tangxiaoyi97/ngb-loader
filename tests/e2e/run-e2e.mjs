/**
 * run-e2e.mjs — headless E2E smoke test for the injected GGB-Extend stack.
 *
 * Strategy (matches the agreed verification protocol):
 *   1. Build the proxy (proxy-core/dist) and panel bundle.
 *   2. Assemble an "injected" app on disk:  <tmp>/Resources/{app(proxy), core(fixture)}.
 *   3. Launch it with Electron via Playwright's `_electron` API, under Xvfb on
 *      Linux (the caller wraps with `xvfb-run`; on macOS it just runs).
 *   4. Assert in the renderer's MAIN WORLD that:
 *        - window.__fixturePreloadRan === true   (original preload chained)
 *        - window.ggbExtendHost is present        (our bridge injected)
 *        - window.__ggbExtendReady === true       (panel mounted in shadow DOM)
 *        - the closed shadow host element exists
 *
 * The script EXITS 0 on pass, 1 on fail, and 2 (skip) if Playwright/electron are
 * not installed — so it never blocks CI environments that can't run a GUI.
 *
 * Run locally:
 *   npm i -D playwright electron
 *   # Linux headless:
 *   xvfb-run -a node tests/e2e/run-e2e.mjs
 *   # macOS:
 *   node tests/e2e/run-e2e.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, existsSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const log = (...a) => console.log('[e2e]', ...a);
const SKIP = 2;

function tryRequireResolve(spec) {
  try {
    return import(spec);
  } catch {
    return null;
  }
}

async function loadPlaywrightElectron() {
  try {
    const pw = await import('playwright');
    if (pw && pw._electron) return pw._electron;
  } catch { /* not installed */ }
  try {
    const pwc = await import('playwright-core');
    if (pwc && pwc._electron) return pwc._electron;
  } catch { /* not installed */ }
  return null;
}

async function resolveElectronBinary() {
  try {
    const e = await import('electron');
    // `electron` default export is the path to the binary.
    return e.default || e;
  } catch {
    return null;
  }
}

function ensureBuilt() {
  const proxyDist = join(repoRoot, 'packages', 'proxy-core', 'dist', 'main.js');
  const panelBundle = join(repoRoot, 'packages', 'panel', 'dist', 'panel.bundle.js');
  if (!existsSync(panelBundle)) {
    log('building panel…');
    execFileSync('node', [join(repoRoot, 'packages', 'panel', 'build.mjs')], { stdio: 'inherit' });
  }
  if (!existsSync(proxyDist)) {
    log('assembling proxy…');
    execFileSync('node', [join(repoRoot, 'scripts', 'build-proxy.mjs')], { stdio: 'inherit' });
  }
}

function assembleInjectedApp() {
  const root = mkdtempSync(join(tmpdir(), 'ggb-e2e-'));
  const resources = join(root, 'Resources');
  mkdirSync(resources, { recursive: true });

  // core/ = our fixture "GeoGebra"
  cpSync(join(__dirname, 'fixture-app'), join(resources, 'core'), { recursive: true });

  // app/ = the assembled proxy
  cpSync(join(repoRoot, 'packages', 'proxy-core', 'dist'), join(resources, 'app'), { recursive: true });

  // A manifest, mirroring a real injection.
  writeFileSync(join(resources, '.ggb-extend.json'), JSON.stringify({
    framework: 'ggb-extend', frameworkVersion: '0.1.0', kind: 'folder',
    renamed: { original: 'app', to: 'core' },
  }, null, 2));

  return { root, resources, appDir: join(resources, 'app') };
}

async function main() {
  const _electron = await loadPlaywrightElectron();
  const electronBin = await resolveElectronBinary();

  if (!_electron || !electronBin) {
    log('SKIP — playwright and/or electron not installed.');
    log('      Install with:  npm i -D playwright electron   (and `npx playwright install`)');
    process.exit(SKIP);
  }

  ensureBuilt();
  const { resources, appDir } = assembleInjectedApp();
  log('assembled injected app at', resources);

  // Launch Electron pointing at the proxy app dir (Electron loads app/main.js,
  // which is our proxy; the proxy then boots core/ = fixture GeoGebra).
  const electronApp = await _electron.launch({
    executablePath: typeof electronBin === 'string' ? electronBin : undefined,
    args: [appDir],
    env: { ...process.env, GGB_EXTEND_AUTOSTART: '1' },
  });

  let failed = false;
  try {
    const page = await electronApp.firstWindow({ timeout: 20000 });
    // Wait for the panel bootstrap to flip the readiness flag.
    await page.waitForFunction(() => window.__ggbExtendReady === true || window.__ggbExtendReady__ === true, null, { timeout: 20000 });

    const checks = await page.evaluate(() => ({
      fixturePreload: !!window.__fixturePreloadRan,
      bridge: !!window.ggbExtendHost,
      ready: !!(window.__ggbExtendReady || window.__ggbExtendReady__),
      hasApplet: !!window.ggbApplet,
      hasHost: !!document.getElementById('ggb-extend-host-root'),
      toggle: typeof window.__ggbExtendToggle__ === 'function',
    }));

    log('renderer checks:', JSON.stringify(checks, null, 2));

    const assert = (cond, msg) => { if (!cond) { failed = true; log('FAIL:', msg); } else log('PASS:', msg); };
    assert(checks.fixturePreload, 'original (fixture) preload was chained');
    assert(checks.bridge, 'window.ggbExtendHost bridge injected');
    assert(checks.hasApplet, 'window.ggbApplet visible in main world');
    assert(checks.hasHost, 'closed shadow-DOM host element mounted');
    assert(checks.ready, 'panel signalled ready');
    assert(checks.toggle, 'Right-Shift toggle installed');
  } catch (err) {
    failed = true;
    log('ERROR during E2E:', err && err.message ? err.message : err);
  } finally {
    await electronApp.close().catch(() => {});
  }

  if (failed) { log('E2E FAILED'); process.exit(1); }
  log('E2E PASSED ✓');
  process.exit(0);
}

main().catch((e) => { log('fatal', e); process.exit(1); });
