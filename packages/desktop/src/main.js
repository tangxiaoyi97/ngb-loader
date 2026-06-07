'use strict';

// Electron main process: constructs the Manager, registers IPC channels, and
// provides native dialogs. Real logic lives in manager.js / registry.js.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// Pin the userData folder name (dev + packaged) so the manager's data always
// lives in ".../neogebra-loader" — not the package's scoped name (@neogebra/…).
// Must run before any app.getPath('userData').
app.setName('neogebra-loader');

// Resolve injector-core whether we're running from the monorepo (workspace
// symlink) or from a packaged app (vendored into ./vendor/injector-core).
function loadInjector() {
  const candidates = [
    '@neogebra/injector-core',                       // dev: workspace symlink
    path.join(__dirname, '..', 'vendor', 'injector-core', 'src', 'index.js'), // packed
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error('Cannot locate @neogebra/injector-core (dev symlink or vendor/).');
}
const injector = loadInjector();
const { Registry } = require('./registry');
const { Manager } = require('./manager');

let win = null;
let manager = null;

/** Where the prebuilt proxy lives. In DEV we MUST prefer the freshly-built
 *  monorepo dist (so rebuilds take effect); a stale vendor/ from a past
 *  packaging attempt must NOT shadow it. When packaged, use the bundled copy. */
function resolveProxyDir() {
  const devDist = path.join(__dirname, '..', '..', 'proxy-core', 'dist');
  const packaged = [
    path.join(process.resourcesPath || '', 'proxy-core'),   // electron-builder extraResources
    path.join(__dirname, '..', 'vendor', 'proxy-core'),     // vendored fallback
  ];
  const order = app.isPackaged ? [...packaged, devDist] : [devDist, ...packaged];
  for (const c of order) {
    if (c && fs.existsSync(path.join(c, 'main.js'))) return c;
  }
  return undefined;
}

const { TerminalLog } = require('./terminal');
let termLog = null;
function getTermLog() {
  if (!termLog) {
    let dir;
    try { dir = app.getPath('logs'); } catch { dir = path.join(app.getPath('userData'), 'logs'); }
    termLog = new TerminalLog(dir);
  }
  return termLog;
}

function sendLog(entry) {
  if (win && !win.isDestroyed()) win.webContents.send('ggbx:log', entry);
  // also mirror to the on-disk log so a system terminal can tail it live
  try { getTermLog().append(entry); } catch { /* ignore */ }
}

/**
 * Locate the bundled panel-manager builtin plugin (manifest + compiled bundle),
 * so we can seed it into the on-disk plugin library on first run.
 */
function resolveBuiltinPanel() {
  const proxyDir = resolveProxyDir();
  const candidates = [
    // alongside the assembled proxy (packaged or vendored)
    proxyDir && path.join(proxyDir, 'builtin-plugins', 'panel-manager'),
    // monorepo dev: the compiled bundle lives here
    path.join(__dirname, '..', '..', 'proxy-core', 'builtin-plugins', 'panel-manager'),
  ].filter(Boolean);
  for (const c of candidates) {
    const manifest = path.join(c, 'manifest.json');
    const bundle = path.join(c, 'dist', 'index.bundle.js');
    if (fs.existsSync(manifest) && fs.existsSync(bundle)) {
      const icon = path.join(c, 'icon.png');
      return { dir: c, manifest, bundle, icon: fs.existsSync(icon) ? icon : null };
    }
  }
  return null;
}

/**
 * Seed the built-in panel-manager into the SHARED GGB_Plugins library so it shows
 * up in the manager's plugin list like any plugin (flagged builtin/locked).
 *
 * IMPORTANT: this MUST write to the exact same folder the in-GeoGebra runtime and
 * the desktop PluginsStore read — that is keyed by the proxy's productName
 * ("GeoGebra (NeoGebra)"), NOT this app's own userData. We get it from the
 * PluginsStore so the paths can never diverge.
 */
function seedBuiltinPlugins(pluginsRoot) {
  try {
    const found = resolveBuiltinPanel();
    if (!found) { console.warn('[neogebra] builtin panel not found to seed'); return; }
    const root = path.join(pluginsRoot, 'panel-manager');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(found.manifest, 'utf8'));
    manifest.main = 'src/index.js';
    manifest.builtin = true;
    if (found.icon) { manifest.icon = 'icon.png'; fs.copyFileSync(found.icon, path.join(root, 'icon.png')); }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.copyFileSync(found.bundle, path.join(root, 'src', 'index.js'));
    console.log('[neogebra] seeded built-in panel →', root);
  } catch (err) {
    console.error('[neogebra] failed to seed builtin panel:', err && err.message);
  }
}

function createManager() {
  const registry = new Registry(path.join(app.getPath('userData'), 'registry.json'));
  return registry.load().then(async () => {
    const m = new Manager({ registry, injector, onLog: sendLog });
    // Seed into the SHARED plugins root the manager/runtime actually use.
    seedBuiltinPlugins(m.pluginsRoot());
    // Give backups a sensible default so injection never blocks the user. They
    // can change it in Settings. (~/Documents/Neogebra Backups)
    if (!registry.getSettings().defaultBackupDir) {
      const def = path.join(app.getPath('documents'), 'Neogebra Backups');
      try { fs.mkdirSync(def, { recursive: true }); } catch { /* ignore */ }
      await registry.setSettings({ defaultBackupDir: def });
    }
    return m;
  });
}

function registerIpc() {
  const wrap = (fn) => async (_evt, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: String(err && err.message), code: err && err.code }; }
  };

  ipcMain.handle('ggbx:scan', wrap(async () => manager.scan()));
  ipcMain.handle('ggbx:list', wrap(async () => manager.listEntries()));
  ipcMain.handle('ggbx:add', wrap(async (p) => manager.addByPath(p)));
  ipcMain.handle('ggbx:remove', wrap(async (id, opts) => manager.removeEntry(id, opts)));
  ipcMain.handle('ggbx:inject', wrap(async (id, opts) => {
    getTermLog().banner('Inject');
    const proxyDir = resolveProxyDir();
    sendLog({ level: proxyDir ? 'info' : 'warn', msg: proxyDir ? `Using proxy: ${proxyDir}` : 'No prebuilt proxy found — panel will NOT be available (run "npm run build:proxy")', ts: Date.now() });
    try { const r = await manager.inject(id, { proxyDir, ...opts }); getTermLog().done(true); return r; }
    catch (e) { getTermLog().done(false); throw e; }
  }));
  ipcMain.handle('ggbx:restore', wrap(async (id, opts) => {
    getTermLog().banner('Restore');
    try { const r = await manager.restore(id, opts); getTermLog().done(true); return r; }
    catch (e) { getTermLog().done(false); throw e; }
  }));
  // Open the OS terminal tailing the live log file.
  ipcMain.handle('ggbx:openTerminal', wrap(async () => {
    const r = getTermLog().openTail();
    if (!r.ok) { const e = new Error(r.error || 'Could not open a terminal'); throw e; }
    return { file: getTermLog().file };
  }));
  // Plugins are a single shared library (one state.json). The manager IS the
  // control center for enable/disable.
  ipcMain.handle('ggbx:listPlugins', wrap(async (ggbId) => manager.listPlugins(ggbId)));
  ipcMain.handle('ggbx:setPlugin', wrap(async (ggbId, pluginId, enabled) => manager.setPluginEnabled(ggbId, pluginId, enabled)));
  ipcMain.handle('ggbx:openPluginsFolder', wrap(async () => { await shell.openPath(manager.pluginsRoot()); return manager.pluginsRoot(); }));
  // Add/update a plugin by picking its source folder, then copy into the library.
  ipcMain.handle('ggbx:addPlugin', wrap(async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Select a plugin folder (must contain manifest.json)',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const installed = await manager.installPluginFromFolder(res.filePaths[0]);
    return { canceled: false, installed };
  }));

  // Launch a managed GeoGebra (optionally in debug mode → opens DevTools + verbose logs).
  ipcMain.handle('ggbx:launch', wrap(async (id, { debug = false } = {}) => {
    const exe = manager.launchTarget(id);
    if (!fs.existsSync(exe)) { const e = new Error('找不到可执行文件: ' + exe); e.code = 'ENOEXE'; throw e; }
    const env = { ...process.env };
    if (debug) env.GGB_EXTEND_DEBUG = '1';
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env });
    child.unref();
    return { launched: true, exe, debug };
  }));
  ipcMain.handle('ggbx:getSettings', wrap(async () => manager.getSettings()));
  ipcMain.handle('ggbx:setSettings', wrap(async (patch) => manager.setSettings(patch)));

  // Native pickers
  ipcMain.handle('ggbx:pickApp', wrap(async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Select GeoGebra',
      properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory'],
      filters: [{ name: 'Applications', extensions: ['app', 'exe'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  }));
  ipcMain.handle('ggbx:pickFolder', wrap(async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  }));
  ipcMain.handle('ggbx:openPath', wrap(async (p) => { await shell.openPath(p); return p; }));
  ipcMain.handle('ggbx:openExternal', wrap(async (url) => { await shell.openExternal(url); return url; }));
  ipcMain.handle('ggbx:appInfo', wrap(async () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node })));
}

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    title: 'Neogebra',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f4f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  if (process.env.GGBX_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  manager = await createManager();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
