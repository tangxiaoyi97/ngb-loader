'use strict';

/**
 * E2E fixture "core" — a stand-in for GeoGebra's real main.js.
 *
 * It behaves like GeoGebra in the ways that matter for our injection:
 *   - registers an `app://` file protocol (GeoGebra uses one)
 *   - creates a BrowserWindow with contextIsolation:true and its OWN preload
 *   - loads an HTML page that defines a fake `window.ggbApplet`
 *
 * When wrapped by the GGB-Extend proxy, the proxy should patch BrowserWindow,
 * inject our preload (chaining this fixture's preload), and the panel should
 * mount. The E2E test then asserts `window.__ggbExtendReady__ === true`.
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('path');

// Match GeoGebra: register a privileged custom scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-core.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    console.log('[fixture] page loaded');
  });
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app', (request, callback) => {
    const url = request.url.slice('app://'.length);
    callback({ path: path.normalize(path.join(__dirname, url)) });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
