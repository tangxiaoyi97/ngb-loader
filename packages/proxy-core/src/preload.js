'use strict';

// Renderer preload: chains the host's original preload first, exposes a namespaced
// IPC bridge, then injects + boots the runtime in the main world.
// Everything is wrapped defensively — a failure here must not break GeoGebra.

const path = require('path');
const fs = require('fs');
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const TAG = '[GGB-Extend/preload]';
const DEBUG = process.env.GGB_EXTEND_DEBUG === '1' || process.env.GGB_EXTEND_DEBUG === 'true';
function dbg(...a) { if (DEBUG) console.log(TAG, ...a); }

function chainOriginalPreload() {
  const arg = process.argv.find((a) => a.startsWith('--ggb-extend-chain-preload='));
  if (!arg) return;
  const original = arg.slice('--ggb-extend-chain-preload='.length);
  if (!original) return;
  if (path.resolve(original) === path.resolve(__filename)) return; // never self-chain
  try {
    if (fs.existsSync(original)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      require(original);
      console.log(TAG, 'chained original preload:', original);
    }
  } catch (err) {
    console.error(TAG, 'original preload failed (continuing):', err && err.message);
  }
}

const api = {
  version: '0.2.0',
  getPlugins: () => ipcRenderer.invoke('ggb-extend:get-plugin-list'),
  togglePlugin: (id, enabled) => ipcRenderer.invoke('ggb-extend:toggle-plugin', { id, enabled }),
  openPluginFolder: () => ipcRenderer.invoke('ggb-extend:open-plugin-folder'),
  getSettings: () => ipcRenderer.invoke('ggb-extend:get-settings'),
  setSettings: (s) => ipcRenderer.invoke('ggb-extend:set-settings', s),
  // The runtime (main world) calls these to load plugin code & persist toggles.
  readPluginSource: async (id) => {
    const r = await ipcRenderer.invoke('ggb-extend:read-plugin-source', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'read failed');
    return r.code;
  },
  persistEnabled: (id, enabled) => ipcRenderer.invoke('ggb-extend:toggle-plugin', { id, enabled }),
};

function exposeBridge() {
  try {
    // With contextIsolation:true (GeoGebra's setting) this is the correct path.
    contextBridge.exposeInMainWorld('ggbExtendHost', api);
    console.log(TAG, 'bridge exposed as window.ggbExtendHost');
  } catch (err) {
    // Fallback for contextIsolation:false environments.
    try {
      // eslint-disable-next-line no-undef
      window.ggbExtendHost = api;
      console.warn(TAG, 'contextBridge unavailable, attached bridge directly');
    } catch (e2) {
      console.error(TAG, 'failed to expose bridge:', e2 && e2.message);
    }
  }
}

// Inject the runtime into the main world (so it can see window.ggbApplet), then boot it.

function loadRuntimeBundle() {
  const candidates = [
    path.join(__dirname, 'assets', 'runtime.bundle.js'),
    path.join(__dirname, '..', 'assets', 'runtime.bundle.js'),
    path.join(__dirname, '..', 'runtime', 'dist', 'runtime.bundle.js'), // dev
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8'); } catch { /* next */ }
  }
  return null;
}

async function injectRuntime() {
  const bundle = loadRuntimeBundle();
  if (!bundle) {
    console.warn(TAG, 'runtime bundle not found — run build:proxy. Panel/plugins unavailable.');
    return;
  }
  dbg('injecting runtime bundle');
  try {
    // 1) define window.__ggbExtendBoot__ in the main world
    await webFrame.executeJavaScript(bundle, false);

    // 2) fetch the installed plugin list (IPC, preload side)
    let installed = [];
    try {
      const res = await api.getPlugins();
      if (res && res.ok) {
        installed = (res.plugins || []).map((p) => ({
          id: p.id,
          enabled: p.enabled,
          manifest: { id: p.id, name: p.name, version: p.version, author: p.author, description: p.description, main: p.main, icon: p.icon || null },
        }));
      }
    } catch (e) { console.error(TAG, 'get-plugin-list failed:', e && e.message); }

    // 3) boot the runtime in the main world, handing it callbacks that bridge to
    //    the preload (the main world can't call ipcRenderer directly, but it CAN
    //    call window.ggbExtendHost which we exposed via contextBridge).
    // IMPORTANT: executeJavaScript serializes the script's RESULT back across the
    // context boundary. boot() returns a complex object (GgbCore/loader) that
    // can't be structured-cloned → "An object could not be cloned." So we must
    // NOT let the boot Promise be the script's completion value. Wrap in an IIFE
    // that kicks off boot and returns a plain undefined.
    const bootCall = `(function(){
      window.__ggbExtendBoot__({
        installed: ${JSON.stringify(installed)},
        host: window.ggbExtendHost,
        readSource: (id) => window.ggbExtendHost.readPluginSource(id),
        persistEnabled: (id, en) => window.ggbExtendHost.persistEnabled(id, en),
      }).catch((e) => console.error('[GGB-Extend] boot error', e && e.message));
      return undefined;
    })();`;
    await webFrame.executeJavaScript(bootCall, false);
    console.log(TAG, 'runtime boot kicked off (panel + plugins)');
  } catch (err) {
    console.error(TAG, 'runtime injection failed:', err && err.message);
  }
}

// Orchestrate (order matters).
(function run() {
  chainOriginalPreload(); // 1) host bridge first
  exposeBridge();         // 2) our bridge
  // 3) Inject + boot the runtime once the DOM is ready.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectRuntime, { once: true });
    } else {
      injectRuntime();
    }
  } else {
    setTimeout(injectRuntime, 0);
  }
})();
