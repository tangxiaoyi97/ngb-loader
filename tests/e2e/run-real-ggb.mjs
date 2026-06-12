/**
 * run-real-ggb.mjs — REAL-GeoGebra E2E + pixel regression (P1-4).
 *
 * The DOM-reverse-engineering layers (adapter/row/dock) can only truly be
 * verified against the real GeoGebra Classic 6 app. This script:
 *
 *   1. Builds a TEST proxy (NGB_TEST_BUILD=1 — E2E hooks compiled in).
 *   2. Copies ggb-test/GeoGebra Classic 6.app to a temp dir and injects it
 *      (engine.uninstall → engine.inject, so a pre-injected source app is fine).
 *   3. Seeds an isolated HOME with a fixture plugin that creates a HYBRID
 *      native row and publishes its pixel metrics on window.__e2eRowMetrics.
 *   4. Launches the app under Playwright and asserts:
 *        - runtime ready, panel toggle present (test hooks)
 *        - framework row height matches a real native row's height (±2px)
 *        - marble ball renders at native size (20×20 ±1) and its center
 *          aligns with the native marble's center column (±2px)
 *        - DOM/window carry no branded framework identifiers (beyond test hooks)
 *   5. Screenshot regression: captures the algebra column; compares against
 *      tests/e2e/baselines/real-ggb-algebra.png when pixelmatch+pngjs are
 *      installed (first run writes the baseline).
 *
 * Run LOCALLY on macOS (the bundled app is a mac bundle):
 *   npm i -D playwright pixelmatch pngjs
 *   node tests/e2e/run-real-ggb.mjs
 *
 * Exit codes: 0 pass · 1 fail · 2 skip (deps/app missing).
 * Intended as the regression GATE when bumping GeoGebra: a profile mismatch
 * must turn this red.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const log = (...a) => console.log('[real-e2e]', ...a);
const SKIP = 2;

const APP_SRC = join(repoRoot, 'ggb-test', 'GeoGebra Classic 6.app');
const PROXY_DIST = join(repoRoot, 'packages', 'proxy-core', 'dist');
const BASELINE_DIR = join(__dirname, 'baselines');
const BASELINE = join(BASELINE_DIR, 'real-ggb-algebra.png');

// The fixture plugin: creates one hybrid native row beside a REAL object and
// publishes both rows' pixel metrics for the test to compare.
const FIXTURE_PLUGIN = `
import { Plugin } from '@neogebra/sdk';
export default class E2eRow extends Plugin {
  async onEnable(ctx) {
    const applet = ctx.core && ctx.core.raw;
    if (!applet) { window.__e2eRowMetrics = { error: 'no applet' }; return; }
    applet.evalCommand('nat1=(1,2)'); // a real native row to measure against
    const row = ctx.ui.createNativeRow({
      mode: 'hybrid',
      marble: { kind: 'native', filled: true },
      onAttached: () => setTimeout(() => measure(), 300),
    });
    row.element && (row.element.textContent = 'E2E row');
    const measure = () => {
      try {
        const av = document.querySelector('.algebraView, .gwt-Tree.algebraView');
        const items = [...av.querySelectorAll('.avItem')];
        const natItem = items.find((it) => {
          const t = it.querySelector('.avPlainText');
          return t && (t.getAttribute('aria-label') || t.textContent || '').includes('nat1');
        });
        const ourItem = row.host ? row.host.closest('.avItem') : null;
        const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        const ourBall = row.marble && row.marble.querySelector('span');
        window.__e2eRowMetrics = {
          alive: row.isAlive(),
          native: natItem ? rect(natItem) : null,
          nativeMarble: natItem && natItem.querySelector('.marblePanel') ? rect(natItem.querySelector('.marblePanel')) : null,
          ours: ourItem ? rect(ourItem) : null,
          ourMarblePanel: ourItem && ourItem.querySelector('.marblePanel') ? rect(ourItem.querySelector('.marblePanel')) : null,
          ourBall: ourBall ? rect(ourBall) : null,
          column: (() => { const c = document.querySelector('.dockPanelParent'); return c ? rect(c) : null; })(),
        };
      } catch (e) { window.__e2eRowMetrics = { error: String(e && e.message) }; }
    };
    // onAttached may have fired before this assignment — poll as a fallback.
    let polls = 0;
    const poll = setInterval(() => {
      if (window.__e2eRowMetrics || polls++ > 40) { clearInterval(poll); return; }
      if (row.isAlive()) { measure(); clearInterval(poll); }
    }, 200);
  }
}`;

async function loadPlaywrightElectron() {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const pw = await import(mod);
      if (pw && pw._electron) return pw._electron;
    } catch { /* next */ }
  }
  return null;
}

function buildTestProxy() {
  log('building test proxy (NGB_TEST_BUILD=1)…');
  execFileSync('node', [join(repoRoot, 'scripts', 'build-proxy.mjs')], {
    stdio: 'inherit', env: { ...process.env, NGB_TEST_BUILD: '1' },
  });
}

function prepareApp() {
  const root = mkdtempSync(join(tmpdir(), 'ggb-real-e2e-'));
  const appCopy = join(root, 'GeoGebra Classic 6.app');
  log('copying app (this can take a minute)…');
  cpSync(APP_SRC, appCopy, { recursive: true });

  const injector = require(join(repoRoot, 'packages', 'injector-core', 'src', 'index.js'));
  const target = injector.describeTarget(appCopy);
  if (!target || !target.resources) throw new Error('could not describe the copied app');
  return { root, appCopy, injector, target };
}

async function injectFresh(injector, target, appCopy) {
  if (target.state === 'injected') {
    try { await injector.uninstall(target, {}); log('uninstalled pre-existing injection'); } catch (e) { log('uninstall note:', e && e.message); }
  }
  const fresh = injector.describeTarget(appCopy) || target;
  await injector.inject(fresh, { proxyDir: PROXY_DIST });
  log('injected test proxy');
}

function seedPlugins(homeDir, resources) {
  // Electron userData = $HOME/Library/Application Support/<productName>
  let productName = 'GeoGebra Classic 6';
  try {
    const corePkg = JSON.parse(readFileSync(join(resources, 'core', 'package.json'), 'utf8'));
    productName = corePkg.productName || corePkg.name || productName;
  } catch { /* default */ }
  const pluginsRoot = join(homeDir, 'Library', 'Application Support', productName, 'GGB_Plugins');
  const pluginDir = join(pluginsRoot, 'e2e-row');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'e2e-row', name: 'E2E Row Fixture', version: '1.0.0', main: 'index.js',
  }, null, 2));
  writeFileSync(join(pluginDir, 'index.js'), FIXTURE_PLUGIN);
  // P2-3: plugins are default-DISABLED — pre-enable the fixture for this
  // install (ggbId = 'ggb-' + sha1(<Resources dir>) like the proxy computes).
  const { createHash } = require('node:crypto');
  const id = `ggb-${createHash('sha1').update(resolve(resources)).digest('hex').slice(0, 12)}`;
  writeFileSync(join(pluginsRoot, 'state.json'), JSON.stringify({
    version: 2, targets: { [id]: { enabled: { 'e2e-row': true } } }, settings: {},
  }, null, 2));
  log('seeded fixture plugin (pre-enabled for', id, ') →', pluginDir);
}

function findExecutable(appCopy) {
  const macosDir = join(appCopy, 'Contents', 'MacOS');
  const names = readdirSync(macosDir);
  if (!names.length) throw new Error('no executable in Contents/MacOS');
  return join(macosDir, names[0]);
}

const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

async function compareScreenshot(page, columnRect) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const shot = await page.screenshot({
    clip: { x: columnRect.x, y: columnRect.y, width: columnRect.w, height: columnRect.h },
  });
  if (!existsSync(BASELINE)) {
    writeFileSync(BASELINE, shot);
    log('baseline written (first run):', BASELINE);
    return { ok: true, note: 'baseline created' };
  }
  let pixelmatch; let PNG;
  try { pixelmatch = (await import('pixelmatch')).default; PNG = (await import('pngjs')).PNG; } catch {
    return { ok: true, note: 'pixelmatch/pngjs not installed — pixel diff skipped' };
  }
  const a = PNG.sync.read(readFileSync(BASELINE));
  const b = PNG.sync.read(shot);
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, note: `size changed: baseline ${a.width}×${a.height} vs now ${b.width}×${b.height}` };
  }
  const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.12 });
  const ratio = diff / (a.width * a.height);
  return { ok: ratio < 0.01, note: `pixel diff ${(ratio * 100).toFixed(2)}% (gate <1%)` };
}

async function main() {
  if (process.platform !== 'darwin') { log('SKIP — the bundled GeoGebra app is a macOS bundle.'); process.exit(SKIP); }
  if (!existsSync(APP_SRC)) { log('SKIP — ggb-test/GeoGebra Classic 6.app not found.'); process.exit(SKIP); }
  const _electron = await loadPlaywrightElectron();
  if (!_electron) { log('SKIP — playwright not installed (npm i -D playwright).'); process.exit(SKIP); }

  buildTestProxy();
  const { root, appCopy, injector, target } = prepareApp();
  await injectFresh(injector, target, appCopy);

  const homeDir = join(root, 'home');
  mkdirSync(homeDir, { recursive: true });
  seedPlugins(homeDir, target.resources);

  const electronApp = await _electron.launch({
    executablePath: findExecutable(appCopy),
    args: [],
    env: { ...process.env, HOME: homeDir, GGB_EXTEND_TEST: '1' },
  });

  let failed = false;
  const assert = (cond, msg) => { if (!cond) { failed = true; log('FAIL:', msg); } else log('PASS:', msg); };
  try {
    const page = await electronApp.firstWindow({ timeout: 30000 });
    await page.waitForFunction(() => window.__ggbExtendReady__ === true, null, { timeout: 30000 });
    log('runtime ready');
    await page.waitForFunction(() => !!window.__e2eRowMetrics, null, { timeout: 30000 });
    const m = await page.evaluate(() => window.__e2eRowMetrics);
    log('metrics:', JSON.stringify(m));

    assert(!m.error, `fixture ran without error (${m.error || 'ok'})`);
    assert(m.alive, 'framework row attached (hijack succeeded on real GeoGebra)');
    assert(m.native && m.ours, 'both native and framework rows measurable');
    if (m.native && m.ours) {
      assert(near(m.ours.h, m.native.h, 2), `row height matches native (${m.ours.h} vs ${m.native.h} ±2px)`);
      assert(near(m.ours.x, m.native.x, 2), `row left edge aligns (${m.ours.x} vs ${m.native.x} ±2px)`);
    }
    if (m.ourBall) {
      assert(near(m.ourBall.w, 20, 1) && near(m.ourBall.h, 20, 1), `marble ball 20×20 ±1 (got ${m.ourBall.w}×${m.ourBall.h})`);
    } else assert(false, 'marble ball rendered');
    if (m.ourBall && m.nativeMarble) {
      const ourCx = m.ourBall.x + m.ourBall.w / 2;
      const natCx = m.nativeMarble.x + m.nativeMarble.w / 2;
      assert(near(ourCx, natCx, 2), `marble centers align (${ourCx.toFixed(1)} vs ${natCx.toFixed(1)} ±2px)`);
    }

    const toggle = await page.evaluate(() => typeof window.__ggbExtendToggle__ === 'function');
    assert(toggle, 'panel toggle hook present (test build)');

    // Clean namespace on the REAL app too (test hooks excluded).
    const branded = await page.evaluate(() => {
      const hooks = new Set(['__ggbExtendRuntime__', '__ggbExtendReady__', '__ggbExtendToggle__', '__ggbExtendPanel__', '__ggbExtendPanelHost__', 'ggbExtendHost']);
      const wins = Object.getOwnPropertyNames(window).filter((k) => /ggbextend|ggb-extend|__ngb/i.test(k) && !hooks.has(k));
      const dom = document.querySelector('[data-ngb-container],[data-ngb-row],[data-ngb-dock],[data-ngb-marble],#ggb-extend-host-root') ? ['dom-marker'] : [];
      return [...wins, ...dom];
    });
    assert(branded.length === 0, `no branded identifiers in the live page (found: ${branded.join(',') || 'none'})`);

    if (m.column) {
      const shot = await compareScreenshot(page, m.column);
      assert(shot.ok, `screenshot regression — ${shot.note}`);
    }
  } catch (err) {
    failed = true;
    log('ERROR during real E2E:', err && err.message ? err.message : err);
  } finally {
    await electronApp.close().catch(() => {});
  }

  if (failed) { log('REAL E2E FAILED'); process.exit(1); }
  log('REAL E2E PASSED ✓  (temp app at ' + root + ')');
  process.exit(0);
}

main().catch((e) => { log('fatal', e); process.exit(1); });
