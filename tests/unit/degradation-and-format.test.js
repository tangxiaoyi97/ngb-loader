'use strict';

/**
 * degradation-and-format.test.js — P1-2 graceful degradation for native rows
 * and P1-5 pre-bundled (iife) plugin loading without the regex transformer.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const loaderUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'proxy-core', 'runtime', 'src', 'loader.js')).href;
const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function makeDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter };
  g.window = dom.window; g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver; g.NodeFilter = dom.window.NodeFilter;
  return { window: dom.window, restore: () => Object.assign(g, saved) };
}

// Fake applet that renders rows WITHOUT the classic6 anatomy (no .elem /
// .elemText) — simulating a future GeoGebra that changed its DOM.
function makeBrokenGgb(doc, av) {
  const objects = new Map();
  return {
    _names: () => [...objects.keys()],
    evalCommand(cmd) {
      const m = String(cmd).match(/^(\w+)\s*=\s*(.+)$/);
      if (!m) return false;
      const [, name, def] = m;
      if (objects.has(name)) return true;
      const item = doc.createElement('div'); item.className = 'avItem';
      const inner = doc.createElement('div'); inner.className = 'futureLayout';
      const plain = doc.createElement('div'); plain.className = 'avPlainText';
      plain.setAttribute('aria-label', `${name} = ${def}`); plain.textContent = `${name} = ${def}`;
      inner.appendChild(plain); item.appendChild(inner); av.appendChild(item);
      objects.set(name, item);
      return true;
    },
    setVisible() {}, setAuxiliary() {},
    deleteObject(name) { const r = objects.get(name); if (r && r.parentNode) r.parentNode.removeChild(r); objects.delete(name); },
    registerRemoveListener() {}, unregisterRemoveListener() {},
  };
}

test('degradation: pre-existing broken anatomy → no helper object is even created', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { window, restore } = makeDom();
  try {
    const doc = window.document;
    const av = doc.createElement('div'); av.className = 'gwt-Tree algebraView'; doc.body.appendChild(av);
    const ggb = makeBrokenGgb(doc, av);
    ggb.evalCommand('userObj=1'); // an existing (broken-anatomy) native row
    const before = av.children.length;

    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const handle = createNativeRow({ applet: ggb, name: 'degraded1' });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(handle.isAlive(), false, 'never attached');
    assert.ok(!ggb._names().includes('degraded1'), 'NO backing object created (self-check refused)');
    assert.strictEqual(av.children.length, before, 'not a single node added to GeoGebra\'s UI');
    handle.destroy();
  } finally { restore(); }
});

test('degradation: hijack refusal + retry exhaustion removes the helper (no orphan raw row)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { window, restore } = makeDom();
  try {
    const doc = window.document;
    const av = doc.createElement('div'); av.className = 'gwt-Tree algebraView'; doc.body.appendChild(av);
    const ggb = makeBrokenGgb(doc, av); // EMPTY view: anatomy unknown → row creation proceeds

    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const handle = createNativeRow({ applet: ggb, name: 'degraded2', attachRetry: { tries: 3, intervalMs: 10 } });
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(handle.isAlive(), false, 'hijack was refused (anatomy mismatch)');
    assert.ok(!ggb._names().includes('degraded2'), 'helper object deleted after the retry budget');
    assert.strictEqual(av.children.length, 0, 'no orphan raw row left in the algebra view');
    handle.destroy();
  } finally { restore(); }
});

// An esbuild-shaped IIFE bundle (format=iife, global-name=__exports.default,
// external sdk → require). Includes a string that LOOKS like ESM syntax — the
// classic regex-transformer trap — which must pass through untouched.
const IIFE_BUNDLE = `
var __exports;
(__exports ||= {}).default = (() => {
  const sdk = require('@neogebra/sdk');
  const trap = "export default class Fake {}"; // must NOT be rewritten
  const trap2 = "import { x } from '@neogebra/sdk';";
  class BundledPlugin extends sdk.Plugin {
    async onEnable(ctx) { ctx.storage.set('ran', trap.length + trap2.length); }
  }
  return { default: BundledPlugin };
})();
`;

test('P1-5: iife bundles load without the regex transformer (string traps untouched)', async () => {
  const { evaluatePlugin } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const def = evaluatePlugin(IIFE_BUNDLE, sdk, { format: 'iife' });
  assert.strictEqual(typeof def, 'function', 'default export unwrapped from the namespace object');
  assert.strictEqual(def.name, 'BundledPlugin');
});

test('P1-5: loader end-to-end with manifest format:"iife"', async () => {
  const { PluginLoader } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const store = new sdk.MemoryStorage();
  const loader = new PluginLoader({ sdk, core: null, host: null, makeStorage: () => store });
  await loader.loadAll([{
    id: 'bundled',
    manifest: { id: 'bundled', name: 'Bundled', version: '1.0.0', main: 'dist/index.bundle.js', format: 'iife' },
    source: IIFE_BUNDLE,
    enabled: true,
    builtin: false,
  }]);
  const rec = loader.list().find((p) => p.id === 'bundled');
  assert.strictEqual(rec.error, null, 'loaded cleanly');
  assert.ok(store.get('ran') > 0, 'onEnable ran');
});

test('P1-5: iife bundles may only require the SDK', async () => {
  const { evaluatePlugin } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const evil = 'var __exports; (__exports ||= {}).default = require("fs");';
  assert.throws(() => evaluatePlugin(evil, sdk, { format: 'iife' }), /Cannot require "fs"/);
});

test('P1-5: the REAL ai-assistant dist bundle evaluates via the iife path', async () => {
  const fs = require('node:fs');
  const bundlePath = path.join(__dirname, '..', '..', 'examples', 'geogebra-ai-assistant', 'dist', 'index.bundle.js');
  if (!fs.existsSync(bundlePath)) { return; } // built artifact not present — skip silently
  const { evaluatePlugin } = await import(loaderUrl);
  const sdk = await import(sdkUrl);
  const def = evaluatePlugin(fs.readFileSync(bundlePath, 'utf8'), sdk, { format: 'iife' });
  assert.strictEqual(typeof def, 'function', 'AI assistant class exported');
});
