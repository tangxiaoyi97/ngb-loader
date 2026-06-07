'use strict';

/**
 * manager.test.js — desktop business logic (manager.js) with a FAKE injector and
 * a real temp-file Registry. No Electron required.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { Registry } = require('../../packages/desktop/src/registry');
const { Manager, resolveExecutable } = require('../../packages/desktop/src/manager');

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-mgr-'));
  return new Registry(path.join(dir, 'registry.json'));
}

/** A fake injector-core that records calls and simulates state transitions. */
function makeFakeInjector() {
  const installs = new Map(); // path -> { state, version, kind }
  return {
    _installs: installs,
    _addInstall(p, info) { installs.set(path.resolve(p), { state: 'pristine', kind: 'folder', version: '6.0.570', ...info }); },
    scan() { return [...installs.entries()].map(([p, v]) => ({ appBundle: p, resources: p + '/R', ...v })); },
    describeTarget(p) {
      const v = installs.get(path.resolve(p));
      if (!v) return null;
      return { appBundle: path.resolve(p), resources: path.resolve(p) + '/R', ...v };
    },
    async inject(target, opts) {
      installs.get(target.appBundle).state = 'injected';
      return { changed: true, usedBackupDir: opts.backupDir, proxyDir: opts.proxyDir };
    },
    async uninstall(target, opts) {
      installs.get(target.appBundle).state = 'pristine';
      return { changed: true, usedBackupDir: opts.backupDir };
    },
  };
}

async function setup() {
  const registry = tmpRegistry();
  await registry.load();
  const injector = makeFakeInjector();
  // Point the shared plugin store at a throwaway temp dir so tests never touch
  // the real ~/Library plugin library.
  const { PluginsStore } = require('../../packages/desktop/src/plugins-store');
  const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-plug-'));
  const pluginsStore = new PluginsStore({ root: pluginsRoot, platform: 'darwin' });
  const manager = new Manager({ registry, injector, platform: 'darwin', pluginsStore });
  return { registry, injector, manager, pluginsRoot };
}

test('addByPath validates + registers; rejects non-GGB', async () => {
  const { injector, manager } = await setup();
  injector._addInstall('/Apps/GGB.app', { version: '6.0.570' });

  const { entry, created } = await manager.addByPath('/Apps/GGB.app');
  assert.strictEqual(created, true);
  assert.strictEqual(entry.version, '6.0.570');

  await assert.rejects(() => manager.addByPath('/Apps/NotReal.app'), /No GeoGebra/);
});

test('listEntries merges live injection state', async () => {
  const { injector, manager } = await setup();
  injector._addInstall('/Apps/GGB.app', { version: '6.0.570' });
  await manager.addByPath('/Apps/GGB.app');

  let list = manager.listEntries();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].live.state, 'pristine');

  // a path that disappears shows as missing
  injector._installs.clear();
  list = manager.listEntries();
  assert.strictEqual(list[0].live.state, 'missing');
  assert.strictEqual(list[0].live.exists, false);
});

test('inject uses resolved per-entry backup dir and persists it', async () => {
  const { registry, injector, manager } = await setup();
  injector._addInstall('/Apps/GGB.app', { version: '6.0.570' });
  await manager.setSettings({ defaultBackupDir: '/Backups' });
  const { entry } = await manager.addByPath('/Apps/GGB.app');

  const res = await manager.inject(entry.id, { proxyDir: '/proxy/dist' });
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.usedBackupDir, path.join('/Backups', entry.id), 'inject got per-entry backup dir');
  assert.strictEqual(res.proxyDir, '/proxy/dist');

  // backupDir persisted on the entry
  assert.strictEqual(registry.get(entry.id).backupDir, path.join('/Backups', entry.id));
  // live state now injected
  assert.strictEqual(manager.listEntries()[0].live.state, 'injected');
});

test('restore flips state back', async () => {
  const { injector, manager } = await setup();
  injector._addInstall('/Apps/GGB.app', {});
  const { entry } = await manager.addByPath('/Apps/GGB.app');
  await manager.inject(entry.id, {});
  assert.strictEqual(manager.listEntries()[0].live.state, 'injected');
  await manager.restore(entry.id);
  assert.strictEqual(manager.listEntries()[0].live.state, 'pristine');
});

test('plugin toggle writes per-GGB state.json (version isolation)', async () => {
  const { manager, pluginsRoot } = await setup();
  const G = 'ggb-test-1';
  const pdir = path.join(pluginsRoot, 'hello-plugin');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({ id: 'hello-plugin', name: 'Hello', version: '1.0.0', main: 'src/index.js' }));

  // default: enabled (only explicit false disables)
  let list = await manager.listPlugins(G);
  assert.strictEqual(list.find((p) => p.id === 'hello-plugin').enabled, true, 'defaults enabled');

  // disable for this GGB → persisted under targets[G]
  await manager.setPluginEnabled(G, 'hello-plugin', false);
  const state = JSON.parse(fs.readFileSync(path.join(pluginsRoot, 'state.json'), 'utf8'));
  assert.strictEqual(state.targets[G].enabled['hello-plugin'], false);

  list = await manager.listPlugins(G);
  assert.strictEqual(list.find((p) => p.id === 'hello-plugin').enabled, false, 'reflects disabled for this GGB');

  // a DIFFERENT GGB is unaffected
  const other = await manager.listPlugins('ggb-other');
  assert.strictEqual(other.find((p) => p.id === 'hello-plugin').enabled, true, 'other GGB still enabled');
});

test('resolveExecutable reads CFBundleExecutable from a mac .app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-exe-'));
  const appBundle = path.join(root, 'GeoGebra Classic 6.app');
  const macos = path.join(appBundle, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleExecutable</key><string>GeoGebra Classic 6</string></dict></plist>');
  fs.writeFileSync(path.join(macos, 'GeoGebra Classic 6'), '#!/bin/sh\n');
  const exe = resolveExecutable(appBundle, 'darwin');
  assert.strictEqual(exe, path.join(macos, 'GeoGebra Classic 6'));
});

test('launchTarget returns the executable for a registered GGB', async () => {
  const { manager } = await setup();
  // build a real fake .app on disk so resolveExecutable can read it
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-exe2-'));
  const appBundle = path.join(root, 'G.app');
  const macos = path.join(appBundle, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleExecutable</key><string>G</string></dict></plist>');
  fs.writeFileSync(path.join(macos, 'G'), '#!/bin/sh\n');
  manager.injector._addInstall(appBundle, {});
  const { entry } = await manager.addByPath(appBundle);
  // manager.platform is 'darwin' in setup()
  const exe = manager.launchTarget(entry.id);
  assert.strictEqual(exe, path.join(macos, 'G'));
});

test('installPluginFromFolder copies a plugin into the shared library', async () => {
  const { manager, pluginsRoot } = await setup();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-src-'));
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', main: 'src/index.js' }));
  fs.writeFileSync(path.join(src, 'src', 'index.js'), 'export default class {};');

  const installed = await manager.installPluginFromFolder(src);
  assert.strictEqual(installed.id, 'demo');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'demo', 'manifest.json')), 'installed into library');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'demo', 'src', 'index.js')), 'payload copied');

  // shows up in the per-GGB list
  const list = await manager.listPlugins('ggb-x');
  assert.ok(list.some((p) => p.id === 'demo'), 'appears in plugin list');
});

test('installPluginFromFolder rejects a builtin and a folder without manifest', async () => {
  const { manager } = await setup();
  const noManifest = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-nomani-'));
  await assert.rejects(() => manager.installPluginFromFolder(noManifest), /No manifest/);

  const builtin = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-bi-'));
  fs.writeFileSync(path.join(builtin, 'manifest.json'), JSON.stringify({ id: 'b', name: 'B', version: '1.0.0', builtin: true }));
  await assert.rejects(() => manager.installPluginFromFolder(builtin), /built-in/);
});

test('removeEntry forgets the GGB', async () => {
  const { manager } = await setup();
  manager.injector._addInstall('/Apps/GGB.app', {});
  const { entry } = await manager.addByPath('/Apps/GGB.app');
  assert.strictEqual(await manager.removeEntry(entry.id), true);
  assert.strictEqual(manager.listEntries().length, 0);
});
