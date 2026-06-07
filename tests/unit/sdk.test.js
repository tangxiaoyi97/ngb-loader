'use strict';

/**
 * sdk.test.js — verify the SDK wrapper + lifecycle using a mock GeoGebra applet.
 * Uses dynamic import() because the SDK is ESM.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;
const pluginUrl = pathToFileURL(path.join(__dirname, '..', '..', 'examples', 'hello-plugin', 'src', 'index.js')).href;

/** A mock applet that records commands and supports the listener API. */
function makeMockApplet() {
  const objects = new Map();
  const listeners = { add: [], remove: [], update: [], rename: [], clear: [], click: [] };
  const commands = [];
  return {
    _objects: objects,
    _commands: commands,
    _fire(type, ...args) { listeners[type].forEach((fn) => fn(...args)); },
    evalCommand(cmd) {
      commands.push(cmd);
      // crude parse of "Name=(x,y)"
      const m = cmd.match(/^([A-Za-z]\w*)=\(([-\d.]+),([-\d.]+)\)$/);
      if (m) {
        objects.set(m[1], { x: +m[2], y: +m[3], visible: true, color: null });
        listeners.add.forEach((fn) => fn(m[1]));
        return true;
      }
      const seg = cmd.match(/^(\w+)=Segment\(/);
      if (seg) { objects.set(seg[1], { type: 'segment' }); listeners.add.forEach((fn) => fn(seg[1])); return true; }
      return true;
    },
    getValue(n) { const o = objects.get(n); return o ? (o.value ?? 0) : 0; },
    getXcoord(n) { return objects.get(n)?.x ?? 0; },
    getYcoord(n) { return objects.get(n)?.y ?? 0; },
    getZcoord() { return 0; },
    setColor(n, r, g, b) { const o = objects.get(n); if (o) o.color = [r, g, b]; },
    setVisible(n, v) { const o = objects.get(n); if (o) o.visible = v; },
    deleteObject(n) { objects.delete(n); listeners.remove.forEach((fn) => fn(n)); },
    getObjectNumber() { return objects.size; },
    getObjectName(i) { return [...objects.keys()][i]; },
    getObjectType(n) { return objects.has(n) ? 'point' : ''; },
    exists(n) { return objects.has(n); },
    registerAddListener(fn) { listeners.add.push(fn); },
    registerRemoveListener(fn) { listeners.remove.push(fn); },
    registerUpdateListener(fn) { listeners.update.push(fn); },
    registerRenameListener(fn) { listeners.rename.push(fn); },
    registerClearListener(fn) { listeners.clear.push(fn); },
    registerClickListener(fn) { listeners.click.push(fn); },
  };
}

test('Emitter on/once/off/emit works with unsubscribe', async () => {
  const { Emitter } = await import(sdkUrl);
  const e = new Emitter();
  let n = 0;
  const off = e.on('x', () => { n += 1; });
  e.emit('x'); e.emit('x');
  off();
  e.emit('x');
  assert.strictEqual(n, 2);

  let m = 0;
  e.once('y', () => { m += 1; });
  e.emit('y'); e.emit('y');
  assert.strictEqual(m, 1);
});

test('GgbCore.create resolves with a ready applet and wraps object API', async () => {
  const { GgbCore } = await import(sdkUrl);
  const applet = makeMockApplet();
  const core = await GgbCore.create({ getApplet: () => applet, timeout: 1000 });

  const name = await core.objects.createPoint(1, 2, 'A');
  assert.strictEqual(name, 'A');
  const coords = await core.objects.getCoords('A');
  assert.deepStrictEqual(coords, { x: 1, y: 2, z: 0 });

  await core.objects.setColor('A', 10, 20, 30);
  assert.deepStrictEqual(applet._objects.get('A').color, [10, 20, 30]);

  const list = await core.objects.list();
  assert.deepStrictEqual(list, ['A']);

  await core.objects.remove('A');
  assert.strictEqual(await core.objects.exists('A'), false);
});

test('GgbCore bridges applet listeners into events', async () => {
  const { GgbCore } = await import(sdkUrl);
  const applet = makeMockApplet();
  const core = await GgbCore.create({ getApplet: () => applet, timeout: 1000 });

  const seen = [];
  core.on('add', (p) => seen.push(p.name));
  applet.evalCommand('B=(5,5)');
  assert.deepStrictEqual(seen, ['B']);
});

test('whenAppletReady rejects on timeout', async () => {
  const { whenAppletReady } = await import(sdkUrl);
  await assert.rejects(
    () => whenAppletReady({ getApplet: () => null, timeout: 150 }),
    /did not become ready/
  );
});

test('validateManifest enforces required fields', async () => {
  const { validateManifest } = await import(sdkUrl);
  assert.throws(() => validateManifest({ name: 'x' }), /missing required field: id/);
  const m = validateManifest({ id: 'ok', name: 'OK', version: '1.0.0', main: 'i.js' });
  assert.strictEqual(m.author, 'unknown');
  assert.throws(() => validateManifest({ id: 'bad id!', name: 'x', version: '1', main: 'm' }), /alphanumeric/);
});

test('hello-plugin runs through the full lifecycle on a mock applet', async () => {
  const sdk = await import(sdkUrl);
  const { GgbCore, PluginContext, MemoryStorage, runLifecycle, validateManifest } = sdk;
  const HelloPlugin = (await import(pluginUrl)).default;

  const applet = makeMockApplet();
  const core = await GgbCore.create({ getApplet: () => applet, timeout: 1000 });
  const manifest = validateManifest({
    id: 'hello-plugin', name: 'Hello', version: '0.1.0', main: 'src/index.js',
  });
  const ctx = new PluginContext({ core, manifest, storage: new MemoryStorage() });

  const plugin = new HelloPlugin(ctx);

  await runLifecycle(plugin, 'onLoad', ctx);
  await runLifecycle(plugin, 'onEnable', ctx);

  // The plugin should have created a 'Hello' point and colored it.
  assert.ok(applet._objects.has('Hello'), 'Hello point created on enable');
  assert.deepStrictEqual(applet._objects.get('Hello').color, [91, 118, 216]);
  assert.strictEqual(ctx.storage.get('enableCount'), 1);

  // Disable should run disposables: remove the point + unsubscribe.
  await runLifecycle(plugin, 'onDisable', ctx);
  assert.strictEqual(applet._objects.has('Hello'), false, 'point removed on disable');
  assert.strictEqual(ctx._disposables.length, 0, 'disposables cleared');

  // Re-enable increments the persisted counter.
  await runLifecycle(plugin, 'onEnable', ctx);
  assert.strictEqual(ctx.storage.get('enableCount'), 2);

  await runLifecycle(plugin, 'onUnload', ctx);
});

test('runLifecycle runs disposables even if a teardown hook throws', async () => {
  const sdk = await import(sdkUrl);
  const { PluginContext, MemoryStorage, runLifecycle } = sdk;
  const ctx = new PluginContext({
    core: {}, manifest: { id: 't', name: 't', version: '1', main: 'm' }, storage: new MemoryStorage(),
  });
  let cleaned = false;
  ctx.registerDisposable(() => { cleaned = true; });
  const instance = { onDisable() { throw new Error('boom'); } };
  await runLifecycle(instance, 'onDisable', ctx); // must not throw
  assert.strictEqual(cleaned, true);
});
