'use strict';

// Renderer preload: chains the host's original preload first, exposes a namespaced
// IPC bridge, then injects + boots the runtime in the main world.
// Everything is wrapped defensively — a failure here must not break GeoGebra.
//
// Clean-namespace contract: nothing branded is left in the page. The IPC bridge
// and the runtime boot function live under SESSION-RANDOM window keys; the boot
// key is deleted immediately after use. Diagnostics are SILENT unless
// GGB_EXTEND_DEBUG is set (quiet runtime).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const DEBUG = process.env.GGB_EXTEND_DEBUG === '1' || process.env.GGB_EXTEND_DEBUG === 'true';
// Test mode (E2E/integration harnesses): exposes stable aliases for assertions.
const TEST_MODE = process.env.GGB_EXTEND_TEST === '1';
const TAG = '[preload]';
function dbg(...a) { if (DEBUG) console.log(TAG, ...a); }
function dbgErr(...a) { if (DEBUG) console.error(TAG, ...a); }

// Session-random keys (non-semantic, unguessable; regenerated every launch).
const HOST_KEY = `_${crypto.randomBytes(9).toString('hex')}`;
const BOOT_KEY = `_${crypto.randomBytes(9).toString('hex')}`;

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
      dbg('chained original preload:', original);
    }
  } catch (err) {
    dbgErr('original preload failed (continuing):', err && err.message);
  }
}

const api = {
  version: '0.2.0',
  getPlugins: () => ipcRenderer.invoke('ggb-extend:get-plugin-list'),
  togglePlugin: (id, enabled) => ipcRenderer.invoke('ggb-extend:toggle-plugin', { id, enabled }),
  openPluginFolder: () => ipcRenderer.invoke('ggb-extend:open-plugin-folder'),
  openExternal: (url) => ipcRenderer.invoke('ggb-extend:open-external', { url }),
  getSettings: () => ipcRenderer.invoke('ggb-extend:get-settings'),
  setSettings: (s) => ipcRenderer.invoke('ggb-extend:set-settings', s),
  netFetch: (request) => ipcRenderer.invoke('ggb-extend:net-fetch', request),
  netApprove: (pluginId, host, allow, token) => ipcRenderer.invoke('ggb-extend:net-approve', { pluginId, host, allow, token }),
  netApprovals: (pluginId) => ipcRenderer.invoke('ggb-extend:net-approvals', { pluginId }),
  netRevoke: (pluginId, host) => ipcRenderer.invoke('ggb-extend:net-revoke', { pluginId, host }),
  // The runtime (main world) calls these to load plugin code & persist toggles.
  readPluginSource: async (id) => {
    const r = await ipcRenderer.invoke('ggb-extend:read-plugin-source', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || 'read failed');
    return r.code;
  },
  persistEnabled: (id, enabled) => ipcRenderer.invoke('ggb-extend:toggle-plugin', { id, enabled }),
};

function exposeBridge() {
  const expose = (key) => {
    try {
      // With contextIsolation:true (GeoGebra's setting) this is the correct path.
      contextBridge.exposeInMainWorld(key, api);
      return true;
    } catch (err) {
      // Fallback for contextIsolation:false environments.
      try {
        // eslint-disable-next-line no-undef
        window[key] = api;
        dbg('contextBridge unavailable, attached bridge directly');
        return true;
      } catch (e2) {
        dbgErr('failed to expose bridge:', e2 && e2.message);
        return false;
      }
    }
  };
  const ok = expose(HOST_KEY);
  if (ok) dbg('bridge exposed (random key)');
  // Stable alias for test harnesses only — never present in production runs.
  if (TEST_MODE) expose('ggbExtendHost');
  return ok;
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
  let bundle = loadRuntimeBundle();
  if (!bundle) {
    dbgErr('runtime bundle not found — run build:proxy. Panel/plugins unavailable.');
    return;
  }
  // Hand the runtime its session-random boot key (no branded global in the page).
  bundle = bundle.split('@@NGB_BOOT_KEY@@').join(BOOT_KEY);
  dbg('injecting runtime bundle');
  try {
    // 1) define window[BOOT_KEY] in the main world
    await webFrame.executeJavaScript(bundle, false);

    // 2) fetch the installed plugin list (IPC, preload side)
    let installed = [];
    try {
      const res = await api.getPlugins();
      if (res && res.ok) {
        installed = (res.plugins || []).map((p) => ({
          id: p.id,
          enabled: p.enabled,
          status: p.status, // 'enabled' | 'disabled' | 'new' (P2-3)
          manifest: { id: p.id, name: p.name, version: p.version, author: p.author, description: p.description, main: p.main, format: p.format, icon: p.icon || null },
        }));
      }
    } catch (e) { dbgErr('get-plugin-list failed:', e && e.message); }

    // 2b) per-plugin capability tokens (P2-2). Fetched over a channel that is
    // NOT exposed on the page bridge, then handed to the runtime which closes
    // each plugin's net.fetch over its own token — page code cannot mint or
    // harvest tokens for other plugins through the bridge surface.
    let netTokens = {};
    try {
      const tk = await ipcRenderer.invoke('ggb-extend:issue-net-tokens');
      if (tk && tk.ok && tk.tokens) netTokens = tk.tokens;
    } catch (e) { dbgErr('issue-net-tokens failed:', e && e.message); }

    // 3) boot the runtime in the main world, handing it callbacks that bridge to
    //    the preload (the main world can't call ipcRenderer directly, but it CAN
    //    call the bridge we exposed via contextBridge under HOST_KEY).
    // IMPORTANT: executeJavaScript serializes the script's RESULT back across the
    // context boundary. boot() returns a complex object (GgbCore/loader) that
    // can't be structured-cloned → "An object could not be cloned." So we must
    // NOT let the boot Promise be the script's completion value. Wrap in an IIFE
    // that kicks off boot, scrubs the one-shot boot key, and returns undefined.
    const bootCall = `(function(){
      var boot = window[${JSON.stringify(BOOT_KEY)}];
      try { delete window[${JSON.stringify(BOOT_KEY)}]; } catch (e) {}
      var host = window[${JSON.stringify(HOST_KEY)}];
      boot({
        installed: ${JSON.stringify(installed)},
        netTokens: ${JSON.stringify(netTokens)},
        host: host,
        debug: ${JSON.stringify(DEBUG)},
        readSource: function(id) { return host.readPluginSource(id); },
        persistEnabled: function(id, en) { return host.persistEnabled(id, en); },
      }).catch(function(e){ if (${JSON.stringify(DEBUG)}) console.error('[runtime] boot error', e && e.message); });
      return undefined;
    })();`;
    await webFrame.executeJavaScript(bootCall, false);
    dbg('runtime boot kicked off (panel + plugins)');
  } catch (err) {
    dbgErr('runtime injection failed:', err && err.message);
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
