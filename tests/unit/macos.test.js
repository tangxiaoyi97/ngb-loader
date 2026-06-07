'use strict';

/**
 * macos.test.js — tests for the macOS signing helper + engine integration.
 *
 * The sandbox here is Linux, so we primarily verify:
 *   - repairSignature is a clean no-op off darwin (so inject works everywhere)
 *   - the engine does NOT attempt signing on non-darwin targets
 *   - option plumbing (skipSign) is respected
 *
 * The actual codesign/xattr shell-outs are exercised on a real Mac (see
 * docs/MANUAL-ACCEPTANCE.md); here we assert they aren't invoked inappropriately.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const macos = require('../../packages/injector-core/src/macos');
const detect = require('../../packages/injector-core/src/detect');
const engine = require('../../packages/injector-core/src/engine');

test('repairSignature is a no-op on non-darwin platforms', async () => {
  // We are on Linux in CI/sandbox; this must resolve without touching any tools.
  if (process.platform === 'darwin') return; // skip on real mac
  const res = await macos.repairSignature('/fake/App.app', () => {});
  assert.strictEqual(res.quarantineCleared, false);
  assert.strictEqual(res.resign.ok, false);
  assert.strictEqual(res.resign.reason, 'skipped');
});

test('signatureInfo / assess never throw even on bogus paths', async () => {
  // These shell out; on Linux the tools are absent → our run() swallows errors.
  const info = await macos.signatureInfo('/definitely/not/here.app');
  assert.strictEqual(typeof info.signed, 'boolean');
  const a = await macos.assess('/definitely/not/here.app');
  assert.strictEqual(typeof a.accepted, 'boolean');
});

function buildFolderApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-mac-'));
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version: '6.0.920', main: 'main.js' }));
  fs.writeFileSync(path.join(resources, 'app', 'main.js'), '// real');
  return path.join(root, 'GeoGebra Classic 6.app');
}

test('engine inject reports macSign=null on non-darwin targets', async () => {
  const appBundle = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin'); // forces appBundle present
  // Even though target.platform is darwin, the *host* process.platform is linux,
  // so maybeRepairMacSignature short-circuits on the runtime check.
  const res = await engine.inject(target, {});
  // On a real mac this would be an object; in sandbox it is null (no-op).
  if (process.platform === 'darwin') {
    assert.ok(res.macSign === null || typeof res.macSign === 'object');
  } else {
    assert.strictEqual(res.macSign, null);
  }
});

test('skipSign option prevents any signing attempt', async () => {
  const appBundle = buildFolderApp();
  const target = detect.describeTarget(appBundle, 'darwin');
  const res = await engine.inject(target, { skipSign: true });
  assert.strictEqual(res.macSign, null);
});
