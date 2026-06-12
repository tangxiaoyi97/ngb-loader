'use strict';

/**
 * loader-lifecycle.test.js — P0-2 (no leaks across repeated enable/disable) and
 * P0-7 (lifecycle hook watchdog).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const loaderUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'proxy-core', 'runtime', 'src', 'loader.js')).href;
const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

test('enable→disable cycles tear down each generation of docks (no DOM/listener leak)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter };
  g.window = window; g.document = window.document;
  g.MutationObserver = window.MutationObserver; g.NodeFilter = window.NodeFilter;

  try {
    const { PluginLoader } = await import(loaderUrl);
    const sdk = await import(sdkUrl);

    // A plugin that mounts a dock on EVERY enable (the real-world pattern that
    // leaked: cleanup used to be registered once at load, consumed by the first
    // disable, leaving later generations orphaned).
    const source = `
      import { Plugin } from '@neogebra/sdk';
      export default class Docker extends Plugin {
        async onEnable(ctx) { this._dock = ctx.ui.mountInAlgebraView({}); }
      }`;
    const manifest = { id: 'docker', name: 'Docker', version: '1.0.0', main: 'index.js' };
    const loader = new PluginLoader({ sdk, core: null, host: null, makeStorage: () => new sdk.MemoryStorage() });
    await loader.loadAll([{ id: 'docker', manifest, source, enabled: true, builtin: false }]);

    const countHosts = () => window.document.querySelectorAll('div').length;
    const baselineAfterFirstEnable = countHosts();
    assert.ok(baselineAfterFirstEnable > 0, 'first enable mounted something');

    await loader.disable('docker');
    const afterFirstDisable = countHosts();
    assert.ok(afterFirstDisable < baselineAfterFirstEnable, 'first disable removed the dock');

    // The regression: repeat the cycle several times — node count must not grow.
    for (let i = 0; i < 5; i += 1) {
      await loader.enable('docker');   // eslint-disable-line no-await-in-loop
      await loader.disable('docker');  // eslint-disable-line no-await-in-loop
      assert.strictEqual(countHosts(), afterFirstDisable, `no leaked DOM after cycle ${i + 1}`);
    }
  } finally {
    Object.assign(g, saved);
  }
});

test('watchdog: a hanging onEnable marks the plugin failed and does NOT stall the load chain', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);

  const hangingSource = `
    import { Plugin } from '@neogebra/sdk';
    export default class Hang extends Plugin {
      async onEnable() { await new Promise(() => {}); } // never resolves
    }`;
  const okSource = `
    import { Plugin } from '@neogebra/sdk';
    export default class Ok extends Plugin {
      async onEnable(ctx) { ctx.storage.set('ran', true); }
    }`;
  const mkManifest = (id) => ({ id, name: id, version: '1.0.0', main: 'index.js' });

  const stores = new Map();
  const loader = new PluginLoader({
    sdk, core: null, host: null,
    makeStorage: (id) => { const s = new sdk.MemoryStorage(); stores.set(id, s); return s; },
    hookTimeoutMs: 60, // fast watchdog for the test
  });

  const t0 = Date.now();
  await loader.loadAll([
    { id: 'hang', manifest: mkManifest('hang'), source: hangingSource, enabled: true, builtin: false },
    { id: 'ok', manifest: mkManifest('ok'), source: okSource, enabled: true, builtin: false },
  ]);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2000, `load chain completed promptly (took ${elapsed}ms)`);
  const list = loader.list();
  const hang = list.find((p) => p.id === 'hang');
  const ok = list.find((p) => p.id === 'ok');
  assert.match(hang.error, /timed out/, 'hanging plugin marked failed with a timeout error');
  assert.strictEqual(ok.error, null, 'the next plugin still loaded');
  assert.strictEqual(stores.get('ok').get('ran'), true, 'its onEnable actually ran');
});

test('watchdog: a hanging onDisable still runs the disposables (UI is torn down)', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);

  const source = `
    import { Plugin } from '@neogebra/sdk';
    export default class Stuck extends Plugin {
      async onEnable(ctx) { ctx.registerDisposable(() => { globalThis.__stuckCleaned = true; }); }
      async onDisable() { await new Promise(() => {}); } // hangs
    }`;
  const manifest = { id: 'stuck', name: 'Stuck', version: '1.0.0', main: 'index.js' };
  const loader = new PluginLoader({
    sdk, core: null, host: null,
    makeStorage: () => new sdk.MemoryStorage(),
    hookTimeoutMs: 60,
  });
  delete globalThis.__stuckCleaned;
  await loader.loadAll([{ id: 'stuck', manifest, source, enabled: true, builtin: false }]);
  await loader.disable('stuck');
  assert.strictEqual(globalThis.__stuckCleaned, true, 'disposables ran despite the hung hook');
  assert.strictEqual(loader.list()[0].enabled, false, 'plugin marked disabled');
  delete globalThis.__stuckCleaned;
});
