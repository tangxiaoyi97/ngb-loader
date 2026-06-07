'use strict';

/**
 * renderer-integration.test.js — simulate the RENDERER side end-to-end in jsdom,
 * for the v0.2 runtime architecture.
 *
 * Wires up:
 *   - a mock electron { contextBridge, ipcRenderer, webFrame } as the preload sees
 *   - a fake GeoGebra "original preload" that sets window.ipc (to be chained)
 *   - the REAL assembled proxy preload.js (reads assets/runtime.bundle.js)
 *   - the REAL runtime bundle (SDK + loader + built-in panel), executed via the
 *     mock webFrame, fed a fake user plugin over the mocked IPC
 *
 * Asserts:
 *   - the original preload was chained (window.ipc present)
 *   - our bridge (window.ggbExtendHost) was exposed
 *   - the runtime booted → window.__ggbExtendRuntime__ exists
 *   - the built-in panel plugin loaded (closed shadow host present)
 *   - a fed user plugin was loaded and its onEnable ran
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const REPO = path.join(__dirname, '..', '..');
const PROXY_DIST = path.join(REPO, 'packages', 'proxy-core', 'dist');
const PRELOAD = path.join(PROXY_DIST, 'preload.js');
const RUNTIME_BUNDLE = path.join(PROXY_DIST, 'assets', 'runtime.bundle.js');

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

test('renderer flow: preload chains original, boots runtime, loads builtin panel + user plugin', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const cp = require('child_process');
  if (!fs.existsSync(RUNTIME_BUNDLE) || !fs.existsSync(PRELOAD)) {
    cp.execFileSync('node', [path.join(REPO, 'scripts', 'build-proxy.mjs')], { stdio: 'inherit' });
  }

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><h1>fake geogebra</h1></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'app://html/classic.html',
  });
  const { window } = dom;

  // A fake user plugin the mocked IPC will serve.
  const userPluginSrc = `
    import { Plugin } from '@neogebra/sdk';
    export default class UserP extends Plugin {
      async onEnable(){ window.__userPluginEnabled = true; }
      async onOpenSettings(){ window.__userPluginSettings = true; }
    }`;

  // Mock electron for the preload (Node side).
  const exposed = {};
  const mockElectron = {
    contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; window[k] = v; } },
    ipcRenderer: {
      invoke: async (channel, arg) => {
        if (channel === 'ggb-extend:get-plugin-list') {
          return { ok: true, plugins: [{ id: 'user-plugin', name: 'User Plugin', version: '1.0.0', author: 'x', description: 'd', main: 'index.js', enabled: true }], root: '/tmp/GGB_Plugins' };
        }
        if (channel === 'ggb-extend:read-plugin-source') return { ok: true, code: userPluginSrc };
        if (channel === 'ggb-extend:toggle-plugin') return { ok: true };
        return { ok: true };
      },
      send: () => {},
    },
    webFrame: {
      // Evaluate code in the jsdom "main world".
      executeJavaScript: async (code) => { const fn = new window.Function(code); return fn.call(window); },
    },
  };

  // Fake original preload to be chained.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ggb-rend2-'));
  const origPreload = path.join(tmp, 'orig.js');
  fs.writeFileSync(origPreload, "const {contextBridge}=require('electron'); contextBridge.exposeInMainWorld('ipc',{send(){}}); contextBridge.exposeInMainWorld('__fixturePreloadRan', true);");

  const origLoad = Module._load;
  Module._load = function (req, ...rest) { if (req === 'electron') return mockElectron; return origLoad.call(this, req, ...rest); };
  const savedArgv = process.argv.slice();
  process.argv = [...savedArgv, `--ggb-extend-chain-preload=${origPreload}`, '--ggb-extend-active=1'];
  const savedDoc = global.document, savedWin = global.window;
  global.document = window.document; global.window = window;
  global.KeyboardEvent = window.KeyboardEvent; global.CustomEvent = window.CustomEvent;
  // Neutralize Svelte transition rAF/insertRule artifacts in jsdom.
  global.requestAnimationFrame = () => 0; window.requestAnimationFrame = () => 0;
  try { const proto = window.CSSStyleSheet && window.CSSStyleSheet.prototype; if (proto) proto.insertRule = () => 0; } catch { /* noop */ }

  const swallow = (err) => { const m = err && err.message ? err.message : String(err); if (m.includes('insertRule') || m.includes('getComputedStyle')) return; throw err; };
  process.on('unhandledRejection', swallow);

  try {
    delete require.cache[require.resolve(PRELOAD)];
    require(PRELOAD);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    // allow async injectRuntime() (IPC + executeJavaScript + boot) to settle
    await new Promise((r) => setTimeout(r, 250));

    assert.strictEqual(window.__fixturePreloadRan, true, 'original preload chained');
    assert.ok(window.ggbExtendHost, 'bridge exposed');
    assert.strictEqual(typeof window.ggbExtendHost.readPluginSource, 'function', 'bridge has readPluginSource');

    assert.ok(window.__ggbExtendRuntime__, 'runtime booted (window.__ggbExtendRuntime__)');
    const list = window.__ggbExtendRuntime__.listPlugins();
    const ids = list.map((p) => p.id);
    assert.ok(ids.includes('panel-manager'), 'built-in panel plugin loaded');
    assert.ok(ids.includes('user-plugin'), 'fed user plugin loaded');
    assert.strictEqual(window.__userPluginEnabled, true, 'user plugin onEnable ran');

    // closed shadow host from the panel plugin
    const host = window.document.getElementById('ggb-extend-host-root');
    assert.ok(host, 'panel mounted a host element');
    assert.strictEqual(host.shadowRoot, null, 'panel host uses a CLOSED shadow root');

    await new Promise((r) => setTimeout(r, 40));
  } finally {
    Module._load = origLoad;
    process.argv = savedArgv;
    global.document = savedDoc; global.window = savedWin;
    process.removeListener('unhandledRejection', swallow);
  }
});
