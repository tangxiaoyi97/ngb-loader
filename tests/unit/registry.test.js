'use strict';

/**
 * registry.test.js — the desktop manager's multi-GeoGebra persistence layer.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { Registry, makeId } = require('../../packages/desktop/src/registry');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-reg-'));
  return path.join(dir, 'registry.json');
}

test('makeId is stable for the same path and unique across paths', () => {
  const a1 = makeId('/Applications/GeoGebra Classic 6.app/Contents/Resources');
  const a2 = makeId('/Applications/GeoGebra Classic 6.app/Contents/Resources');
  const b = makeId('/Applications/Other GeoGebra.app/Contents/Resources');
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b, 'different installs → different ids (isolation)');
});

test('makeId does NOT depend on version (matches proxy ggbId which excludes it)', () => {
  // makeId now takes only a path; passing extra args must not change the result.
  assert.strictEqual(makeId('/x/Resources'), makeId('/x/Resources', '6.0.570', 'extra'));
});

test('makeId matches the proxy ggbId algorithm exactly (sha1(resources) → ggb-<12>)', () => {
  // This mirrors packages/proxy-core/src/main.js ggbId(): both hash the SAME
  // Resources dir with sha1, take 12 hex chars, and prefix "ggb-". If these ever
  // diverge, per-install plugin isolation breaks (Bug #3).
  const crypto = require('node:crypto');
  const resources = '/Applications/GeoGebra Classic 6.app/Contents/Resources';
  const proxyId = `ggb-${crypto.createHash('sha1').update(resources).digest('hex').slice(0, 12)}`;
  assert.strictEqual(makeId(resources), proxyId);
});

test('add creates an entry and persists; second add returns existing', async () => {
  const file = tmpFile();
  const reg = new Registry(file);
  await reg.load();

  const { entry, created } = await reg.add({ path: '/Apps/GGB.app', version: '6.0.570' });
  assert.strictEqual(created, true);
  assert.ok(entry.id);
  assert.strictEqual(entry.label, 'GGB');
  assert.deepStrictEqual(entry.plugins, {});

  // reload from disk → entry survives
  const reg2 = new Registry(file);
  await reg2.load();
  assert.strictEqual(reg2.list().length, 1);

  // adding same path again → not created
  const again = await reg2.add({ path: '/Apps/GGB.app', version: '6.0.570' });
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.entry.id, entry.id);
  assert.strictEqual(reg2.list().length, 1);
});

test('update merges fields and plugins map', async () => {
  const reg = new Registry(tmpFile());
  await reg.load();
  const { entry } = await reg.add({ path: '/Apps/GGB.app', version: '6.0.570' });

  await reg.update(entry.id, { backupDir: '/backups/ggb', plugins: { a: true } });
  await reg.update(entry.id, { plugins: { b: false } });

  const e = reg.get(entry.id);
  assert.strictEqual(e.backupDir, '/backups/ggb');
  assert.deepStrictEqual(e.plugins, { a: true, b: false }, 'plugins merge, not replace');
});

test('setPluginEnabled persists per-entry plugin state', async () => {
  const file = tmpFile();
  const reg = new Registry(file);
  await reg.load();
  const { entry } = await reg.add({ path: '/Apps/GGB.app', version: '6.0.570' });

  await reg.setPluginEnabled(entry.id, 'hello-plugin', true);

  const reg2 = new Registry(file);
  await reg2.load();
  assert.strictEqual(reg2.get(entry.id).plugins['hello-plugin'], true);
});

test('remove deletes an entry', async () => {
  const reg = new Registry(tmpFile());
  await reg.load();
  const { entry } = await reg.add({ path: '/Apps/GGB.app' });
  assert.strictEqual(await reg.remove(entry.id), true);
  assert.strictEqual(reg.list().length, 0);
  assert.strictEqual(await reg.remove('nope'), false);
});

test('settings round-trip + resolveBackupDir', async () => {
  const reg = new Registry(tmpFile());
  await reg.load();
  await reg.setSettings({ defaultBackupDir: '/Users/x/GGB-Backups' });
  assert.strictEqual(reg.getSettings().defaultBackupDir, '/Users/x/GGB-Backups');

  const { entry } = await reg.add({ path: '/Apps/GGB.app', version: '6.0.570' });
  // no explicit backupDir → derived under default
  assert.strictEqual(reg.resolveBackupDir(entry), path.join('/Users/x/GGB-Backups', entry.id));
  // explicit backupDir wins
  await reg.update(entry.id, { backupDir: '/custom/here' });
  assert.strictEqual(reg.resolveBackupDir(reg.get(entry.id)), '/custom/here');
});

test('corrupt registry file falls back to empty', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json');
  const reg = new Registry(file);
  await reg.load();
  assert.deepStrictEqual(reg.list(), []);
  // still usable
  const { created } = await reg.add({ path: '/Apps/GGB.app' });
  assert.strictEqual(created, true);
});
