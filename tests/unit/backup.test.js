'use strict';

/**
 * backup.test.js — verify the copy-backup inject mode used by the desktop manager.
 *
 * Covers:
 *   - inject with backupDir copies the original into the backup folder
 *   - the in-app `core` is still created (dual safety)
 *   - manifest records externalBackup
 *   - uninstall works normally (in-app core path) AND
 *   - uninstall recovers from the external backup when in-app core is deleted
 *   - .unpacked sibling travels in the asar case
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const detect = require('../../packages/injector-core/src/detect');
const engine = require('../../packages/injector-core/src/engine');

function mkTmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function sha(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

function buildFolderApp() {
  const root = mkTmp('ggb-bk-');
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'app', 'html'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version: '6.0.920', main: 'main.js' }, null, 2));
  fs.writeFileSync(path.join(resources, 'app', 'main.js'), 'console.log("real");');
  fs.writeFileSync(path.join(resources, 'app', 'html', 'classic.html'), '<html>ggb</html>');
  return { root, resources, appBundle: path.join(root, 'GeoGebra Classic 6.app') };
}

function buildAsarApp() {
  const root = mkTmp('ggb-bk-');
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'ASAR-BYTES-v6');
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'nm'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'nm', 'native.node'), 'BIN');
  return { root, resources, appBundle: path.join(root, 'GeoGebra Classic 6.app') };
}

test('inject with backupDir copies original AND keeps in-app core', async () => {
  const { resources, appBundle } = buildFolderApp();
  const backupDir = mkTmp('ggb-store-');
  const originalSha = sha(path.join(resources, 'app', 'main.js'));

  const target = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.inject(target, { backupDir });

  assert.strictEqual(res.changed, true);
  // external backup exists & matches
  assert.ok(fs.existsSync(path.join(backupDir, 'app', 'main.js')), 'external backup copied');
  assert.strictEqual(sha(path.join(backupDir, 'app', 'main.js')), originalSha);
  // in-app core also exists (dual safety)
  assert.ok(fs.existsSync(path.join(resources, 'core', 'main.js')), 'in-app core kept');
  // proxy installed
  const proxyPkg = JSON.parse(fs.readFileSync(path.join(resources, 'app', 'package.json'), 'utf8'));
  assert.strictEqual(proxyPkg.name, 'ggb-extend-proxy');
  // manifest records the backup
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, '.ggb-extend.json'), 'utf8'));
  assert.ok(manifest.externalBackup, 'manifest has externalBackup');
  assert.strictEqual(manifest.externalBackup.dir, backupDir);
});

test('uninstall recovers from external backup when in-app core is deleted', async () => {
  const { resources, appBundle } = buildFolderApp();
  const backupDir = mkTmp('ggb-store-');
  const originalSha = sha(path.join(resources, 'app', 'main.js'));

  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, { backupDir });

  // Simulate disaster: the in-app core is wiped (e.g. user cleaned the .app).
  fs.rmSync(path.join(resources, 'core'), { recursive: true, force: true });

  // Re-detect: state should be 'unknown' (proxy present, no core).
  const broken = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.uninstall(broken, { backupDir });
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.restoredFrom, 'external-backup');

  // app/ restored to original content
  assert.ok(fs.existsSync(path.join(resources, 'app', 'main.js')));
  assert.strictEqual(sha(path.join(resources, 'app', 'main.js')), originalSha);
  // proxy + manifest gone
  assert.ok(!fs.existsSync(path.join(resources, '.ggb-extend.json')));
  const restored = detect.describeTarget(appBundle, 'darwin');
  assert.strictEqual(restored.state, 'pristine');
});

test('uninstall uses in-app core normally even when backup exists', async () => {
  const { resources, appBundle } = buildFolderApp();
  const backupDir = mkTmp('ggb-store-');
  const originalSha = sha(path.join(resources, 'app', 'main.js'));

  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, { backupDir });
  const injected = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.uninstall(injected, { backupDir });

  assert.strictEqual(res.changed, true);
  assert.notStrictEqual(res.restoredFrom, 'external-backup'); // used in-app core
  assert.strictEqual(sha(path.join(resources, 'app', 'main.js')), originalSha);
});

test('backup mode handles asar + .unpacked sibling', async () => {
  const { resources, appBundle } = buildAsarApp();
  const backupDir = mkTmp('ggb-store-');
  const asarSha = sha(path.join(resources, 'app.asar'));

  const target = detect.describeTarget(appBundle, 'darwin');
  await engine.inject(target, { backupDir });

  assert.ok(fs.existsSync(path.join(backupDir, 'app.asar')));
  assert.strictEqual(sha(path.join(backupDir, 'app.asar')), asarSha);
  assert.ok(fs.existsSync(path.join(backupDir, 'app.asar.unpacked', 'nm', 'native.node')));
  // in-app core.asar also present
  assert.ok(fs.existsSync(path.join(resources, 'core.asar')));

  // disaster recovery from backup
  fs.rmSync(path.join(resources, 'core.asar'), { force: true });
  fs.rmSync(path.join(resources, 'core.asar.unpacked'), { recursive: true, force: true });
  const broken = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.uninstall(broken, { backupDir });
  assert.strictEqual(res.restoredFrom, 'external-backup');
  assert.strictEqual(sha(path.join(resources, 'app.asar')), asarSha);
  assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked', 'nm', 'native.node')));
});

test('inject without backupDir is unchanged (backward compatible)', async () => {
  const { resources, appBundle } = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.inject(target, {});
  assert.strictEqual(res.changed, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, '.ggb-extend.json'), 'utf8'));
  assert.strictEqual(manifest.externalBackup, undefined, 'no externalBackup when backupDir omitted');
});
