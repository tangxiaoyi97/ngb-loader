'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const detect = require('../../packages/injector-core/src/detect');

/* ------------------------------------------------------------------ *
 * Helpers to build throwaway fake app trees on disk.
 * ------------------------------------------------------------------ */

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a macOS-style pristine folder app. */
function buildMacFolderApp(root, { version = '6.0.920' } = {}) {
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version, main: 'main.js' })
  );
  fs.writeFileSync(path.join(resources, 'app', 'main.js'), '// original');
  return resources;
}

/** Build a macOS-style packaged (asar) app. */
function buildMacAsarApp(root, { version = '6.0.920' } = {}) {
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'FAKEASARCONTENT');
  return resources;
}

/** Build a Windows-style folder app: <install>/resources/app */
function buildWinFolderApp(root, { version = '6.0.920' } = {}) {
  const resources = path.join(root, 'GeoGebra', 'resources');
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version, main: 'main.js' })
  );
  return resources;
}

/* ------------------------------------------------------------------ */

test('classifyResources detects pristine folder app', () => {
  const root = mkTmp('ggb-detect-');
  const resources = buildMacFolderApp(root);
  const t = detect.describeTarget(path.join(root, 'GeoGebra Classic 6.app'), 'darwin');
  assert.ok(t, 'should describe a target');
  assert.strictEqual(t.kind, 'folder');
  assert.strictEqual(t.state, 'pristine');
  assert.strictEqual(t.version, '6.0.920');
  assert.match(t.entry, /Resources\/app$/);
  assert.match(t.coreTarget, /Resources\/core$/);
  assert.ok(t.appBundle && t.appBundle.endsWith('.app'));
});

test('classifyResources detects pristine asar app', () => {
  const root = mkTmp('ggb-detect-');
  buildMacAsarApp(root);
  const t = detect.describeTarget(path.join(root, 'GeoGebra Classic 6.app'), 'darwin');
  assert.ok(t);
  assert.strictEqual(t.kind, 'asar');
  assert.strictEqual(t.state, 'pristine');
  assert.match(t.entry, /app\.asar$/);
  assert.match(t.coreTarget, /core\.asar$/);
});

test('detects injected state when core + proxy present', () => {
  const root = mkTmp('ggb-detect-');
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(resources, 'core', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version: '6.0.570', main: 'main.js' })
  );
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'ggb-extend-proxy', ggbExtend: true, main: 'main.js' })
  );
  const t = detect.describeTarget(path.join(root, 'GeoGebra Classic 6.app'), 'darwin');
  assert.strictEqual(t.state, 'injected');
  assert.strictEqual(t.proxyIsOurs, true);
  assert.strictEqual(t.kind, 'folder');
});

test('resolves Windows-style resources dir', () => {
  const root = mkTmp('ggb-detect-');
  buildWinFolderApp(root);
  const t = detect.describeTarget(path.join(root, 'GeoGebra'), 'win32');
  assert.ok(t, 'should find windows install');
  assert.strictEqual(t.kind, 'folder');
  assert.strictEqual(t.platform, 'win32');
  assert.strictEqual(t.appBundle, null);
});

test('returns null for a non-electron directory', () => {
  const root = mkTmp('ggb-detect-');
  fs.mkdirSync(path.join(root, 'random'), { recursive: true });
  const t = detect.describeTarget(path.join(root, 'random'), 'darwin');
  assert.strictEqual(t, null);
});

test('candidateRoots are platform-specific', () => {
  const mac = detect.candidateRoots('darwin', {});
  assert.ok(mac.some((p) => p.includes('Applications')));
  const win = detect.candidateRoots('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' });
  assert.ok(win.some((p) => p.includes('Programs')));
});

test('windows candidateRoots: valid Program Files path (regression: no broken C\\Program)', () => {
  const win = detect.candidateRoots('win32', {
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    SystemDrive: 'C:',
  });
  // Every root that mentions "Program Files" must include a drive colon — the old
  // code produced "C\Program Files" (no colon), which never matched a real path.
  for (const p of win) {
    if (/Program Files/.test(p)) assert.match(p, /:/, `root missing drive colon: ${p}`);
  }
  // Per-user install root (no admin) is present and ordered before Program Files.
  const perUser = win.findIndex((p) => /AppData\\Local[\\/]Programs/.test(p));
  const progFiles = win.findIndex((p) => /Program Files$/.test(p));
  assert.ok(perUser >= 0, 'per-user Programs root present');
  assert.ok(progFiles < 0 || perUser < progFiles, 'per-user root comes before Program Files');
  // No duplicates.
  assert.strictEqual(win.length, new Set(win).size, 'roots are de-duplicated');
});

test('windows candidateRoots: falls back to SystemDrive when env vars missing', () => {
  const win = detect.candidateRoots('win32', { SystemDrive: 'D:' });
  assert.ok(win.some((p) => p === 'D:\\Program Files'));
});
