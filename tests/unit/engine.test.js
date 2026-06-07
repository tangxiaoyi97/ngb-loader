'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const detect = require('../../packages/injector-core/src/detect');
const engine = require('../../packages/injector-core/src/engine');

/* ------------------------------------------------------------------ */

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { out.push(r + '/'); walk(path.join(d, e.name), r); }
      else out.push(r);
    }
  })(dir, '');
  return out;
}

/** Build a realistic pristine folder app and return { root, resources }. */
function buildFolderApp() {
  const root = mkTmp('ggb-engine-');
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'app', 'html'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version: '6.0.920', main: 'main.js' }, null, 2));
  fs.writeFileSync(path.join(resources, 'app', 'main.js'), 'console.log("real geogebra main");');
  fs.writeFileSync(path.join(resources, 'app', 'preload.js'), '// real preload');
  fs.writeFileSync(path.join(resources, 'app', 'html', 'classic.html'), '<html>ggb</html>');
  return { root, resources, appBundle: path.join(root, 'GeoGebra Classic 6.app') };
}

/** Build a pristine asar app. */
function buildAsarApp() {
  const root = mkTmp('ggb-engine-');
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'ASAR-BINARY-CONTENT-v6.0.920');
  // also an unpacked sibling, which must travel with it
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'native.node'), 'BINARY');
  return { root, resources, appBundle: path.join(root, 'GeoGebra Classic 6.app') };
}

/* ------------------------------------------------------------------ */

test('inject (folder): renames app→core and installs proxy', async () => {
  const { resources, appBundle } = buildFolderApp();
  const originalMainSha = sha(path.join(resources, 'app', 'main.js'));

  const target = detect.describeTarget(appBundle, 'darwin');
  assert.strictEqual(target.state, 'pristine');

  const logs = [];
  const res = await engine.inject(target, { onLog: (e) => logs.push(e) });

  assert.strictEqual(res.changed, true);
  // original preserved under core/
  assert.ok(fs.existsSync(path.join(resources, 'core', 'main.js')));
  assert.strictEqual(sha(path.join(resources, 'core', 'main.js')), originalMainSha,
    'core/main.js must be byte-identical to the original');
  // proxy installed at app/
  assert.ok(fs.existsSync(path.join(resources, 'app', 'package.json')));
  const proxyPkg = JSON.parse(fs.readFileSync(path.join(resources, 'app', 'package.json'), 'utf8'));
  assert.strictEqual(proxyPkg.name, 'ggb-extend-proxy');
  assert.ok(fs.existsSync(path.join(resources, 'app', 'main.js')));
  // manifest written
  assert.ok(fs.existsSync(path.join(resources, '.ggb-extend.json')));

  // re-detect: now injected
  const after = detect.describeTarget(appBundle, 'darwin');
  assert.strictEqual(after.state, 'injected');
  assert.strictEqual(after.proxyIsOurs, true);
});

test('inject is idempotent (second run refreshes, no double-rename)', async () => {
  const { resources, appBundle } = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, {});
  const coreShaBefore = sha(path.join(resources, 'core', 'main.js'));

  // re-detect and inject again
  const target2 = detect.describeTarget(appBundle, 'darwin');
  const res2 = await engine.inject(target2, {});
  assert.strictEqual(res2.alreadyInjected, true);
  // core/main.js must NOT have been clobbered with proxy content
  assert.strictEqual(sha(path.join(resources, 'core', 'main.js')), coreShaBefore);
  assert.ok(!fs.existsSync(path.join(resources, 'core', 'core')), 'no nested core/core');
});

test('uninstall (folder): fully restores original tree', async () => {
  const { resources, appBundle } = buildFolderApp();
  const beforeTree = listTree(path.join(resources, 'app'));
  const beforeMainSha = sha(path.join(resources, 'app', 'main.js'));

  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, {});
  const injected = detect.describeTarget(appBundle, 'darwin');
  await engine.uninstall(injected, {});

  // back to pristine
  const restored = detect.describeTarget(appBundle, 'darwin');
  assert.strictEqual(restored.state, 'pristine');
  assert.ok(!fs.existsSync(path.join(resources, 'core')), 'core/ should be gone');
  assert.ok(!fs.existsSync(path.join(resources, '.ggb-extend.json')), 'manifest gone');
  assert.strictEqual(sha(path.join(resources, 'app', 'main.js')), beforeMainSha,
    'restored main.js must equal original');
  assert.deepStrictEqual(listTree(path.join(resources, 'app')), beforeTree,
    'restored app/ tree must match original exactly');
});

test('inject (asar): renames app.asar→core.asar AND moves unpacked sibling', async () => {
  const { resources, appBundle } = buildAsarApp();
  const asarSha = sha(path.join(resources, 'app.asar'));

  const target = detect.describeTarget(appBundle, 'darwin');
  assert.strictEqual(target.kind, 'asar');
  await engine.inject(target, {});

  assert.ok(fs.existsSync(path.join(resources, 'core.asar')));
  assert.strictEqual(sha(path.join(resources, 'core.asar')), asarSha);
  assert.ok(fs.existsSync(path.join(resources, 'core.asar.unpacked', 'node_modules', 'native.node')));
  // proxy is an unpacked folder named app/ (Electron resolves folder before asar)
  assert.ok(fs.statSync(path.join(resources, 'app')).isDirectory());
  assert.ok(fs.existsSync(path.join(resources, 'app', 'main.js')));
});

test('uninstall (asar): restores app.asar and unpacked sibling', async () => {
  const { resources, appBundle } = buildAsarApp();
  const asarSha = sha(path.join(resources, 'app.asar'));
  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, {});
  const injected = detect.describeTarget(appBundle, 'darwin');
  await engine.uninstall(injected, {});

  assert.ok(fs.existsSync(path.join(resources, 'app.asar')));
  assert.strictEqual(sha(path.join(resources, 'app.asar')), asarSha);
  assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'native.node')));
  assert.ok(!fs.existsSync(path.join(resources, 'core.asar')));
  assert.ok(!fs.existsSync(path.join(resources, 'core.asar.unpacked')));
});

test('dry-run injects nothing', async () => {
  const { resources, appBundle } = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.inject(target, { dryRun: true });
  assert.strictEqual(res.dryRun, true);
  assert.ok(res.plan.length >= 2);
  // nothing changed on disk
  assert.ok(!fs.existsSync(path.join(resources, 'core')));
  assert.ok(!fs.existsSync(path.join(resources, '.ggb-extend.json')));
  assert.strictEqual(detect.describeTarget(appBundle, 'darwin').state, 'pristine');
});

test('refuses ambiguous state (core exists, not ours, no manifest)', async () => {
  const { resources, appBundle } = buildFolderApp();
  // simulate a stray core/ that we did not create
  fs.mkdirSync(path.join(resources, 'core'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'core', 'package.json'), JSON.stringify({ name: 'GeoGebra' }));
  const target = detect.describeTarget(appBundle, 'darwin');
  await assert.rejects(() => engine.inject(target, {}), /Refusing to overwrite|EAMBIGUOUS/i);
});

test('uninstall on pristine is a safe no-op', async () => {
  const { appBundle } = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.uninstall(target, {});
  assert.strictEqual(res.changed, false);
  assert.strictEqual(res.reason, 'not-injected');
});
