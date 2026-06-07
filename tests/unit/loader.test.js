'use strict';

/**
 * loader.test.js — the plugin runtime loader (proxy-core/runtime/src/loader.js).
 *
 * Verifies the dog-fooding path: authored ESM plugin source → transform →
 * evaluate → instantiate → lifecycle, including the onOpenSettings bridge.
 * Uses the REAL ggb-hello plugin source and the REAL SDK.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const loaderUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'proxy-core', 'runtime', 'src', 'loader.js')).href;
const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;

// ggb-hello lives in a sibling mounted folder in dev; resolve a few candidates.
function helloSource() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'ggb-hello', 'src', 'index.js'),
    '/Users/tangxiaoyi/workspace/ggb-hello/src/index.js',
    '/sessions/brave-wizardly-dirac/mnt/ggb-hello/src/index.js',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8'); }
  return null;
}
function helloManifest() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'ggb-hello', 'manifest.json'),
    '/Users/tangxiaoyi/workspace/ggb-hello/manifest.json',
    '/sessions/brave-wizardly-dirac/mnt/ggb-hello/manifest.json',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8')); }
  return null;
}

test('transformPluginSource rewrites the SDK import and default export', async () => {
  const { transformPluginSource } = await import(loaderUrl);
  const out = transformPluginSource(
    "import { Plugin } from '@neogebra/sdk';\nexport default class X extends Plugin {}\n"
  );
  assert.match(out, /const \{ Plugin \} = __sdk;/);
  assert.match(out, /__exports\.default = class X extends Plugin/);
  assert.doesNotMatch(out, /import .* from '@ggb-extend\/sdk'/);
});

test('evaluatePlugin returns the default export class', async () => {
  const { evaluatePlugin } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const def = evaluatePlugin(
    "import { Plugin } from '@neogebra/sdk';\nexport default class X extends Plugin { hi(){return 42;} }\n",
    sdk
  );
  assert.strictEqual(typeof def, 'function');
  const inst = new def({});
  assert.strictEqual(inst.hi(), 42);
});

test('PluginLoader loads a plugin and runs onEnable; builtin loads first', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);

  const logs = [];
  const loader = new PluginLoader({
    sdk, core: null, host: null,
    makeStorage: () => new sdk.MemoryStorage(),
    onLog: (e) => logs.push(e),
  });

  const userSrc = `
    import { Plugin } from '@neogebra/sdk';
    export default class P extends Plugin {
      async onEnable(ctx){ globalThis.__userEnabled = (globalThis.__userEnabled||0)+1; }
      async onOpenSettings(){ globalThis.__userSettings = true; }
    }`;
  const builtinSrc = `
    import { Plugin } from '@neogebra/sdk';
    export default class B extends Plugin {
      async onEnable(){ globalThis.__order = (globalThis.__order||[]); globalThis.__order.push('builtin'); }
    }`;

  await loader.loadAll([
    { id: 'user', manifest: { id: 'user', name: 'User', version: '1.0.0', main: 'i.js' }, source: userSrc, enabled: true, builtin: false },
    { id: 'panel', manifest: { id: 'panel', name: 'Panel', version: '1.0.0', main: 'i.js' }, source: builtinSrc, enabled: true, builtin: true },
  ]);

  const list = loader.list();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(globalThis.__userEnabled, 1, 'user onEnable ran');

  // onOpenSettings bridge
  assert.strictEqual(loader.hasSettings('user'), true);
  assert.strictEqual(loader.hasSettings('panel'), false);
  await loader.openSettings('user');
  assert.strictEqual(globalThis.__userSettings, true, 'onOpenSettings invoked via loader');

  // builtin loaded before user
  assert.strictEqual(globalThis.__order[0], 'builtin');

  delete globalThis.__userEnabled; delete globalThis.__userSettings; delete globalThis.__order;
});

test('a broken plugin does not stop the others', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const loader = new PluginLoader({ sdk, core: null, host: null, makeStorage: () => new sdk.MemoryStorage() });

  await loader.loadAll([
    { id: 'bad', manifest: { id: 'bad', name: 'Bad', version: '1.0.0', main: 'i.js' }, source: 'this is { not valid js', enabled: true },
    { id: 'good', manifest: { id: 'good', name: 'Good', version: '1.0.0', main: 'i.js' },
      source: "import { Plugin } from '@neogebra/sdk'; export default class G extends Plugin { async onEnable(){ globalThis.__goodOK=true; } }", enabled: true },
  ]);
  const bad = loader.list().find((p) => p.id === 'bad');
  assert.ok(bad.error, 'bad plugin recorded an error');
  assert.strictEqual(globalThis.__goodOK, true, 'good plugin still loaded');
  delete globalThis.__goodOK;
});

test('disable refuses on builtin, works on normal', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const loader = new PluginLoader({ sdk, core: null, host: null, makeStorage: () => new sdk.MemoryStorage() });
  await loader.loadAll([
    { id: 'b', manifest: { id: 'b', name: 'B', version: '1', main: 'i' }, source: "import {Plugin} from '@neogebra/sdk'; export default class extends Plugin {}", enabled: true, builtin: true },
    { id: 'n', manifest: { id: 'n', name: 'N', version: '1', main: 'i' }, source: "import {Plugin} from '@neogebra/sdk'; export default class extends Plugin {}", enabled: true, builtin: false },
  ]);
  await loader.disable('b');
  assert.strictEqual(loader.list().find((p) => p.id === 'b').enabled, true, 'builtin stays enabled');
  await loader.disable('n');
  assert.strictEqual(loader.list().find((p) => p.id === 'n').enabled, false, 'normal disabled');
});

test('REAL ggb-hello loads, greets on enable, and opens settings popup', async (t) => {
  const src = helloSource();
  const manifest = helloManifest();
  if (!src || !manifest) { t.skip('ggb-hello source not found'); return; }

  // jsdom for the popup DOM
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch { t.skip('jsdom not installed'); return; }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const savedWin = global.window, savedDoc = global.document;
  global.window = dom.window; global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent; global.KeyboardEvent = dom.window.KeyboardEvent;
  // runtime version source the plugin reads
  dom.window.__ggbExtendRuntime__ = { version: '0.2.0' };

  // capture BOTH console.log (terminal path) and console.warn (DevTools path),
  // since GeoGebra overrides console.log → hello also greets via console.warn.
  const logged = [];
  const origLog = console.log; const origWarn = console.warn;
  console.log = (...a) => { logged.push('log:' + a.join(' ')); };
  console.warn = (...a) => { logged.push('warn:' + a.join(' ')); };

  // a mock GeoGebra applet to verify the heart-drawing API call
  const cmds = [];
  const mockApplet = {
    evalCommand: (c) => { cmds.push(c); return true; },
    deleteObject: () => {}, setColor: () => {}, setLineThickness: () => {}, setFilling: () => {},
  };
  dom.window.ggbApplet = mockApplet;

  try {
    const { PluginLoader } = await import(loaderUrl);
    const sdk = await import(sdkUrl);
    const loader = new PluginLoader({ sdk, core: null, host: null, makeStorage: () => new sdk.MemoryStorage() });
    await loader.loadAll([{ id: manifest.id, manifest, source: src, enabled: true, builtin: false }]);

    const listed = loader.list().find((p) => p.id === 'ggb-hello');
    assert.ok(listed, 'ggb-hello loaded');
    assert.strictEqual(listed.error, null, 'no load error');
    assert.ok(logged.some((l) => l.includes('Hello')), 'greeted with Hello on enable (console.log or warn)');
    assert.ok(logged.some((l) => l.startsWith('warn:')), 'used console.warn for DevTools-visible greeting');
    assert.strictEqual(listed.hasSettings, true, 'exposes settings');

    // open settings → popup mounts (closed shadow)
    await loader.openSettings('ggb-hello');
    const host = dom.window.document.getElementById('ggb-hello-popup-host');
    assert.ok(host, 'popup host element created');
    assert.strictEqual(host.shadowRoot, null, 'popup uses a CLOSED shadow root');

    // exercise the heart-drawing API the popup button calls (internal record has instance+ctx)
    const rec = loader.loaded.get('ggb-hello');
    await rec.instance._drawHeart(rec.ctx);
    assert.ok(cmds.some((c) => /Curve\(/.test(c) && /ggbHello_heart/.test(c)), 'drew a heart Curve via evalCommand');
  } finally {
    console.log = origLog; console.warn = origWarn;
    global.window = savedWin; global.document = savedDoc;
  }
});
