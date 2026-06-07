'use strict';

// Proxy core that Electron boots instead of GeoGebra's real main.js: it patches
// BrowserWindow to inject our preload, registers IPC, then boots the original core.
// Safety contract: if ANY of our logic throws, we still boot the original core —
// GGB-Extend must never be the reason GeoGebra fails to start. Dependency-free
// (Node + Electron built-ins only) so it runs under any Electron the host ships.

const path = require('path');
const fs = require('fs');

// Resolve electron lazily & defensively; in a non-Electron context (unit tests)
// this may be a stub injected via global.__GGB_EXTEND_ELECTRON__.
function getElectron() {
  if (global.__GGB_EXTEND_ELECTRON__) return global.__GGB_EXTEND_ELECTRON__;
  // eslint-disable-next-line global-require
  return require('electron');
}

const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const TAG = '[GGB-Extend]';

// Debug mode: set GGB_EXTEND_DEBUG=1 (env) to open DevTools on each window and
// emit verbose logs. Invaluable for real-machine troubleshooting.
const DEBUG = process.env.GGB_EXTEND_DEBUG === '1' || process.env.GGB_EXTEND_DEBUG === 'true';
function dbg(...args) { if (DEBUG) console.log(TAG, ...args); }

function resolveCoreDir() {
  const folder = path.join(__dirname, '..', 'core');
  const asar = path.join(__dirname, '..', 'core.asar');
  if (fs.existsSync(folder)) return folder;
  if (fs.existsSync(asar)) return asar;
  // As an absolute last resort, maybe we are the only app (mis-injected).
  return folder;
}

function bootCore() {
  const coreDir = resolveCoreDir();
  let mainFile;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const pkg = require(path.join(coreDir, 'package.json'));
    mainFile = path.join(coreDir, pkg.main || 'main.js');
  } catch {
    mainFile = path.join(coreDir, 'main.js');
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  require(mainFile);
}

function pluginPaths(electron) {
  const userData = electron.app.getPath('userData');
  const root = path.join(userData, 'GGB_Plugins');
  const stateFile = path.join(root, 'state.json');
  return { userData, root, stateFile };
}

/**
 * Stable id for THIS GeoGebra install, so per-GGB plugin enable lists don't mix
 * (all injected GeoGebras share one plugin library + state.json, but each gets
 * its own enabled list keyed by this id). Mirrors the desktop registry's makeId.
 * The proxy lives at <bundle>.app/Contents/Resources/app, so we walk up to the
 * install root and hash it.
 */
// Stable id for THIS GeoGebra install. MUST match the desktop registry's
// makeId() exactly (see packages/desktop/src/registry.js) so per-install plugin
// state isolates correctly. Both hash the canonical install path (the .app
// bundle on macOS, the resources/install dir elsewhere) and DELIBERATELY exclude
// the version (it is detected at different times on the two sides and could
// diverge, which previously broke isolation).
function ggbId() {
  // __dirname = .../Resources/app, so the Resources dir is one up. Both this and
  // the desktop registry hash the SAME Resources dir → identical id on every
  // platform. (version is excluded on purpose; see note above.)
  const resources = path.resolve(__dirname, '..');
  // eslint-disable-next-line global-require
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(resources).digest('hex').slice(0, 12);
  return `ggb-${hash}`;
}

/**
 * Read the enabled-map for a specific GGB id from state.json. New schema:
 *   { version: 2, targets: { <ggbId>: { enabled: { pluginId: bool } } }, settings }
 * Back-compat: an old flat { enabled } is treated as the default for any id.
 */
function targetEnabled(state, id) {
  if (state.targets && state.targets[id] && state.targets[id].enabled) return state.targets[id].enabled;
  // migrate-on-read: old flat enabled applies until per-target is written
  if (state.enabled && Object.keys(state.enabled).length) return state.enabled;
  return {};
}

function setTargetEnabled(state, id, pluginId, enabled) {
  if (!state.targets) state.targets = {};
  if (!state.targets[id]) state.targets[id] = { enabled: {} };
  if (!state.targets[id].enabled) state.targets[id].enabled = {};
  state.targets[id].enabled[pluginId] = !!enabled;
  state.version = 2;
  return state;
}

function ensurePluginEnv(electron) {
  const p = pluginPaths(electron);
  try {
    fs.mkdirSync(p.root, { recursive: true });
    if (!fs.existsSync(p.stateFile)) {
      fs.writeFileSync(p.stateFile, JSON.stringify({ version: 1, enabled: {}, settings: {} }, null, 2));
    }
  } catch (err) {
    console.error(TAG, 'failed to prepare plugin dir:', err && err.message);
  }
  return p;
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { version: 1, enabled: {}, settings: {} };
  }
}

function writeState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    console.error(TAG, 'failed to persist state:', err && err.message);
    return false;
  }
}

/**
 * Read a single plugin's manifest.json and normalize it.
 * Returns null if the directory is not a valid plugin.
 */
function readPluginManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { id: path.basename(dir), name: path.basename(dir), broken: true, error: 'invalid manifest.json' };
  }
  const id = manifest.id || path.basename(dir);
  return {
    id,
    name: manifest.name || id,
    version: manifest.version || '0.0.0',
    author: manifest.author || 'unknown',
    description: manifest.description || '',
    main: manifest.main || 'index.js',
    icon: iconToDataUri(dir, manifest.icon),
    dir,
    broken: false,
  };
}

// Resolve a plugin's manifest `icon` (a path relative to the plugin folder) into
// a data: URI so the panel — which runs in the page and can't read file:// — can
// display it. Returns null when unset, missing, too large, or not an image.
function iconToDataUri(dir, icon) {
  if (!icon || typeof icon !== 'string') return null;
  try {
    if (/^data:/i.test(icon)) return icon;
    const file = path.join(dir, icon);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    if (buf.length > 256 * 1024) return null; // keep IPC payloads small
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif' : null;
    if (!mime) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/**
 * Enumerate plugins on disk and merge their enabled state.
 */
function listPlugins(p, id) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(p.root, { withFileTypes: true });
  } catch {
    return out;
  }
  const state = readState(p.stateFile);
  const enabled = targetEnabled(state, id || ggbId());
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(p.root, e.name);
    const m = readPluginManifest(dir);
    if (!m) continue;
    // Default to ENABLED per THIS GGB: a freshly dropped-in plugin runs without
    // the user flipping it on. Only an explicit `false` for this GGB disables.
    m.enabled = enabled[m.id] !== false;
    out.push(m);
  }
  return out;
}

function registerIpc(electron) {
  const { ipcMain, shell } = electron;
  const p = ensurePluginEnv(electron);

  const handle = (channel, fn) => {
    // Guard against double-registration if main.js is required twice.
    try { ipcMain.removeHandler && ipcMain.removeHandler(channel); } catch { /* noop */ }
    ipcMain.handle(channel, fn);
  };

  const myGgbId = ggbId();

  handle('ggb-extend:get-ggb-id', async () => ({ ok: true, id: myGgbId }));

  handle('ggb-extend:get-plugin-list', async () => {
    return { ok: true, plugins: listPlugins(p, myGgbId), root: p.root, ggbId: myGgbId };
  });

  handle('ggb-extend:toggle-plugin', async (_evt, { id, enabled }) => {
    const state = readState(p.stateFile);
    setTargetEnabled(state, myGgbId, id, enabled);
    const ok = writeState(p.stateFile, state);
    return { ok, id, enabled: !!enabled, ggbId: myGgbId };
  });

  handle('ggb-extend:open-plugin-folder', async () => {
    try {
      await shell.openPath(p.root);
      return { ok: true, path: p.root };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  handle('ggb-extend:get-settings', async () => {
    const state = readState(p.stateFile);
    return { ok: true, settings: state.settings || {} };
  });

  handle('ggb-extend:set-settings', async (_evt, settings) => {
    const state = readState(p.stateFile);
    state.settings = Object.assign({}, state.settings, settings || {});
    const ok = writeState(p.stateFile, state);
    return { ok, settings: state.settings };
  });

  // Read a plugin's source bundle so the renderer can evaluate it in-page.
  handle('ggb-extend:read-plugin-source', async (_evt, { id }) => {
    const plugins = listPlugins(p);
    const plugin = plugins.find((x) => x.id === id);
    if (!plugin) return { ok: false, error: 'plugin not found' };
    const entry = path.join(plugin.dir, plugin.main);
    try {
      const code = fs.readFileSync(entry, 'utf8');
      return { ok: true, id, code, manifest: plugin };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  console.log(TAG, 'IPC channels registered. Plugins dir:', p.root);
  return p;
}

/**
 * Replace electron.BrowserWindow with a subclass that rewrites webPreferences
 * before construction so OUR preload is injected and the original preload is
 * preserved via a chain handoff.
 *
 * We must avoid weakening the host's security posture: we keep contextIsolation
 * exactly as the host set it (GeoGebra uses contextIsolation:true) and only add
 * our preload. The preload itself uses webFrame.executeJavaScriptInMainWorld so
 * it can reach `window.ggbApplet` even under context isolation.
 */
function patchBrowserWindow(electron) {
  const OriginalBW = electron.BrowserWindow;
  if (!OriginalBW || OriginalBW.__ggbExtendPatched) return;

  // Make patched constructor that normalizes options then calls super.
  class PatchedBrowserWindow extends OriginalBW {
    constructor(options = {}) {
      let usedPatched = true;
      try {
        const patched = PatchedBrowserWindow.__rewriteOptions(options);
        super(patched);
      } catch (err) {
        // Never block window creation because of us.
        usedPatched = false;
        console.error(TAG, 'option rewrite failed, using original options:', err && err.message);
        super(options);
      }
      // In debug mode, open DevTools so panel-injection logs are visible.
      if (DEBUG) {
        try {
          dbg('window created (patched=' + usedPatched + '); opening DevTools');
          this.webContents.openDevTools({ mode: 'detach' });
        } catch (e) { /* some windows can't open devtools; ignore */ }
      }
    }

    static __rewriteOptions(options) {
      const opts = Object.assign({}, options);
      const wp = Object.assign({}, opts.webPreferences || {});

      // Preserve the host's original preload by chaining.
      // Strategy: we set OUR preload as the active one, and pass the original
      // preload path to our preload via an additionalArguments switch, so our
      // preload can require()/load it after we set ourselves up.
      const originalPreload = wp.preload || '';
      const extra = Array.isArray(wp.additionalArguments) ? wp.additionalArguments.slice() : [];
      if (originalPreload) {
        extra.push(`--ggb-extend-chain-preload=${originalPreload}`);
      }
      extra.push('--ggb-extend-active=1');
      wp.additionalArguments = extra;

      // Inject our preload. (Electron supports exactly one preload per window;
      // chaining is handled inside our preload.)
      wp.preload = PRELOAD_PATH;

      // Sandbox must be OFF for our preload to use Node `require` + webFrame.
      // GeoGebra already runs with sandbox disabled (nodeIntegration:false,
      // contextIsolation:true). We only force sandbox:false if it was truthy,
      // and we DO NOT touch contextIsolation/nodeIntegration.
      if (wp.sandbox === true) {
        console.warn(TAG, 'host requested sandbox:true; disabling for preload injection');
      }
      wp.sandbox = false;

      opts.webPreferences = wp;
      return opts;
    }
  }

  // Copy static methods (getAllWindows, fromId, fromWebContents, etc.).
  Object.getOwnPropertyNames(OriginalBW)
    .filter((k) => typeof OriginalBW[k] === 'function' && !(k in PatchedBrowserWindow))
    .forEach((k) => {
      try { PatchedBrowserWindow[k] = OriginalBW[k].bind(OriginalBW); } catch { /* noop */ }
    });

  PatchedBrowserWindow.__ggbExtendPatched = true;
  PatchedBrowserWindow.__original = OriginalBW;

  // Install our patched class so the host's `require('electron').BrowserWindow`
  // returns ours. Modern Electron (e.g. v38) exposes `BrowserWindow` as a
  // non-configurable getter on the electron exports object, so BOTH
  // Object.defineProperty AND direct assignment fail. We therefore try, in order:
  //
  //   1. Object.defineProperty (works on older/dev builds)
  //   2. direct assignment      (works on some builds)
  //   3. **module-loader hook**  (works everywhere): intercept require('electron')
  //      and hand back a shallow clone whose BrowserWindow is ours.
  //
  // Returns true if the active `require('electron').BrowserWindow` is ours.
  function verify() {
    try { return require('electron').BrowserWindow === PatchedBrowserWindow; } catch { return false; }
  }

  let installed = false;

  // Attempt 1 + 2 on the live exports object.
  try {
    Object.defineProperty(electron, 'BrowserWindow', {
      configurable: true, enumerable: true, get() { return PatchedBrowserWindow; },
    });
    installed = verify();
  } catch { /* fall through */ }
  if (!installed) {
    try { electron.BrowserWindow = PatchedBrowserWindow; installed = verify(); } catch { /* fall through */ }
  }

  // Attempt 3: the bulletproof one — patch the CJS loader so every future
  // require('electron') returns a proxy view with our BrowserWindow.
  if (!installed) {
    try {
      // eslint-disable-next-line global-require
      const Module = require('module');
      const realElectron = electron;
      const view = new Proxy(realElectron, {
        get(t, prop) {
          if (prop === 'BrowserWindow') return PatchedBrowserWindow;
          return Reflect.get(t, prop);
        },
      });
      if (!Module.__ggbExtendElectronHook) {
        const origLoad = Module._load;
        Module._load = function (request, parent, isMain) {
          const resolved = origLoad.call(this, request, parent, isMain);
          if (request === 'electron') return Module.__ggbExtendElectronView || resolved;
          return resolved;
        };
        Module.__ggbExtendElectronHook = true;
      }
      Module.__ggbExtendElectronView = view;
      installed = verify();
    } catch (err) {
      console.error(TAG, 'module-loader hook failed:', err && err.message);
    }
  }

  if (installed) {
    console.log(TAG, 'BrowserWindow patched (preload chaining active).');
  } else {
    console.error(TAG, 'FAILED to install patched BrowserWindow — panel will not load.');
  }
  PatchedBrowserWindow.__installed = installed;
}

function applyHooks() {
  const electron = getElectron();
  // 1) Patch window creation BEFORE the host creates any window.
  patchBrowserWindow(electron);
  // 2) Register IPC. We do it now (channels are safe to register pre-ready),
  //    but app.getPath('userData') requires app to exist — which it does here.
  try {
    registerIpc(electron);
  } catch (err) {
    console.error(TAG, 'IPC registration failed:', err && err.message);
  }
}

function start() {
  console.log('\n%s %s', TAG, 'proxy core starting…');
  try {
    applyHooks();
  } catch (err) {
    console.error(TAG, 'hook installation failed (continuing to boot core):', err && err.stack);
  }
  // Hand control to GeoGebra. This must always run.
  bootCore();
}

// Export internals for unit testing; auto-start only when run as the entry.
module.exports = {
  TAG,
  PRELOAD_PATH,
  resolveCoreDir,
  bootCore,
  pluginPaths,
  ensurePluginEnv,
  readState,
  writeState,
  readPluginManifest,
  listPlugins,
  registerIpc,
  patchBrowserWindow,
  applyHooks,
  start,
};

// When Electron loads this as the app entry (require.main === module), start.
// In unit tests we require it as a library, so this stays dormant.
if (require.main === module || process.env.GGB_EXTEND_AUTOSTART === '1') {
  start();
}
