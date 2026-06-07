'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { PluginsStore, resolvePluginsRoot } = require('../../packages/desktop/src/plugins-store');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-ps-')); }

test('resolvePluginsRoot is platform-specific and honors override', () => {
  assert.strictEqual(resolvePluginsRoot('/custom'), '/custom');
  assert.match(resolvePluginsRoot(null, 'darwin'), /Library\/Application Support\/GeoGebra \(NeoGebra\)\/GGB_Plugins$/);
  assert.match(resolvePluginsRoot(null, 'win32'), /GeoGebra \(NeoGebra\)[\\/]GGB_Plugins$/);
});

test('list defaults plugins to enabled; explicit false disables (per-GGB)', async () => {
  const root = tmpRoot();
  const store = new PluginsStore({ root });
  const G = 'ggb-A';
  for (const id of ['a', 'b']) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0' }));
  }
  let list = await store.list(G);
  assert.strictEqual(list.length, 2);
  assert.ok(list.every((p) => p.enabled), 'all default enabled');

  await store.setEnabled(G, 'b', false);
  list = await store.list(G);
  assert.strictEqual(list.find((p) => p.id === 'a').enabled, true);
  assert.strictEqual(list.find((p) => p.id === 'b').enabled, false);
});

test('enabled lists are isolated per GGB', async () => {
  const root = tmpRoot();
  const store = new PluginsStore({ root });
  fs.mkdirSync(path.join(root, 'p'));
  fs.writeFileSync(path.join(root, 'p', 'manifest.json'), JSON.stringify({ id: 'p', name: 'P', version: '1.0.0' }));

  await store.setEnabled('ggb-A', 'p', false); // disable for A only
  const listA = await store.list('ggb-A');
  const listB = await store.list('ggb-B');
  assert.strictEqual(listA.find((x) => x.id === 'p').enabled, false, 'A: disabled');
  assert.strictEqual(listB.find((x) => x.id === 'p').enabled, true, 'B: still enabled (isolated)');
});

test('setEnabled persists per-target to state.json and round-trips', async () => {
  const root = tmpRoot();
  const store = new PluginsStore({ root });
  await store.setEnabled('ggb-A', 'x', false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.strictEqual(onDisk.targets['ggb-A'].enabled.x, false);

  const store2 = new PluginsStore({ root });
  const state = await store2.readState();
  assert.strictEqual(state.targets['ggb-A'].enabled.x, false);
});

test('list tolerates a broken manifest', async () => {
  const root = tmpRoot();
  const store = new PluginsStore({ root });
  fs.mkdirSync(path.join(root, 'bad'));
  fs.writeFileSync(path.join(root, 'bad', 'manifest.json'), '{ not json');
  const list = await store.list();
  assert.strictEqual(list.length, 1);
  assert.ok(list[0].broken, 'broken flag set');
});

test('empty/missing plugins dir returns empty list', async () => {
  const store = new PluginsStore({ root: path.join(tmpRoot(), 'does-not-exist') });
  assert.deepStrictEqual(await store.list(), []);
});

test('manifest icon resolves to a data URI; no icon → null', async () => {
  const root = tmpRoot();
  const store = new PluginsStore({ root });
  // a real 1x1 PNG
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f5f0000000049454e44ae426082', 'hex');
  const withIcon = path.join(root, 'withicon');
  fs.mkdirSync(withIcon);
  fs.writeFileSync(path.join(withIcon, 'icon.png'), png);
  fs.writeFileSync(path.join(withIcon, 'manifest.json'), JSON.stringify({ id: 'withicon', name: 'With Icon', version: '1.0.0', main: 'src/index.js', icon: 'icon.png' }));
  const m = store.readManifest(withIcon);
  assert.match(m.icon, /^data:image\/png;base64,/, 'icon → data URI');

  const noIcon = path.join(root, 'noicon');
  fs.mkdirSync(noIcon);
  fs.writeFileSync(path.join(noIcon, 'manifest.json'), JSON.stringify({ id: 'noicon', name: 'No Icon', version: '1.0.0', main: 'x' }));
  assert.strictEqual(store.readManifest(noIcon).icon, null, 'no icon → null');

  // missing icon file → null (not a crash)
  const badIcon = path.join(root, 'badicon');
  fs.mkdirSync(badIcon);
  fs.writeFileSync(path.join(badIcon, 'manifest.json'), JSON.stringify({ id: 'badicon', name: 'Bad', version: '1.0.0', main: 'x', icon: 'nope.png' }));
  assert.strictEqual(store.readManifest(badIcon).icon, null, 'missing icon file → null');
});
