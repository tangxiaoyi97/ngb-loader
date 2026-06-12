'use strict';

/**
 * proxy.test.js — verify the proxy core's behavior with a MOCK electron.
 *
 * We can't run a real Electron main process headlessly here, so we inject a
 * faithful electron stub via global.__GGB_EXTEND_ELECTRON__ and assert:
 *   - BrowserWindow is monkey-patched (subclass) and rewrites webPreferences
 *   - the original preload is preserved via the chain switch
 *   - our preload is force-injected, sandbox disabled, contextIsolation untouched
 *   - IPC handlers are registered and behave (list/toggle/open/settings)
 *   - plugin env + state persistence works on a temp userData dir
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const PROXY_MAIN = path.join(__dirname, '..', '..', 'packages', 'proxy-core', 'src', 'main.js');

/* ---------- a faithful-enough electron stub ---------- */
function makeElectronStub(userDataDir) {
  const handlers = new Map();
  const openedPaths = [];
  let BW = class FakeBrowserWindow {
    constructor(options) { this.options = options; FakeBrowserWindow.instances.push(this); }
  };
  BW.instances = [];
  BW.getAllWindows = () => BW.instances;
  BW.fromId = (id) => BW.instances[id] || null;

  return {
    app: {
      getPath: (name) => (name === 'userData' ? userDataDir : os.tmpdir()),
      on: () => {},
      whenReady: () => Promise.resolve(),
      getLocale: () => 'en',
    },
    BrowserWindow: BW,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    ipcMain: {
      handle(channel, fn) { handlers.set(channel, fn); },
      removeHandler(channel) { handlers.delete(channel); },
      on() {},
    },
    shell: { openPath: async (p) => { openedPaths.push(p); return ''; } },
    // test helpers
    __handlers: handlers,
    __openedPaths: openedPaths,
    __invoke: (channel, arg) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('no handler for ' + channel);
      return fn({}, arg);
    },
  };
}

function freshUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-userdata-'));
}

function loadProxyFresh(electron) {
  global.__GGB_EXTEND_ELECTRON__ = electron;
  delete require.cache[require.resolve(PROXY_MAIN)];
  // eslint-disable-next-line global-require
  return require(PROXY_MAIN);
}

/* ------------------------------------------------------------------ */

test('patchBrowserWindow installs a patched subclass', () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  proxy.patchBrowserWindow(electron);
  assert.ok(electron.BrowserWindow.__ggbExtendPatched, 'BrowserWindow should be flagged patched');
  assert.ok(electron.BrowserWindow.__original, 'should retain original reference');
  // static methods preserved
  assert.strictEqual(typeof electron.BrowserWindow.getAllWindows, 'function');
});

test('patched BrowserWindow rewrites webPreferences (inject preload, chain original, sandbox off)', () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  proxy.patchBrowserWindow(electron);

  const win = new electron.BrowserWindow({
    width: 800,
    webPreferences: {
      preload: '/orig/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wp = win.options.webPreferences;
  // our preload injected
  assert.strictEqual(wp.preload, proxy.PRELOAD_PATH);
  // original preload chained via additionalArguments
  assert.ok(wp.additionalArguments.some((a) => a === '--ggb-extend-chain-preload=/orig/preload.js'));
  assert.ok(wp.additionalArguments.some((a) => a === '--ggb-extend-active=1'));
  // contextIsolation + nodeIntegration untouched (host security preserved)
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(wp.nodeIntegration, false);
  // sandbox forced off so our preload can use require + webFrame
  assert.strictEqual(wp.sandbox, false);
  // non-webPreferences options preserved
  assert.strictEqual(win.options.width, 800);
});

test('patches via module-loader hook when BrowserWindow is non-configurable (Electron 38+)', () => {
  // Reproduce Electron 38: `require('electron').BrowserWindow` is a
  // NON-configurable getter, so defineProperty AND assignment both fail. The
  // proxy must fall back to hooking the module loader.
  const Module = require('node:module');
  const electron = makeElectronStub(freshUserData());
  const RealBW = electron.BrowserWindow;
  // Rebuild electron with a locked-down BrowserWindow.
  const locked = Object.assign({}, electron);
  Object.defineProperty(locked, 'BrowserWindow', {
    configurable: false, enumerable: true, get() { return RealBW; },
  });

  // Clear any loader hook a previous test may have installed, so the proxy
  // re-installs against THIS test's loader/view.
  delete Module.__ggbExtendElectronHook;
  delete Module.__ggbExtendElectronView;

  // Make require('electron') return the locked object.
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return locked;
    return origLoad.call(this, request, ...rest);
  };

  try {
    const proxy = loadProxyFresh(locked);
    proxy.patchBrowserWindow(locked);
    const live = require('electron').BrowserWindow;
    assert.strictEqual(live.__ggbExtendPatched, true, 'require(electron).BrowserWindow must be patched');
    assert.strictEqual(live.__installed, true, 'install flag should be true');

    // And a window created through it gets our preload.
    const win = new live({ webPreferences: { preload: '/orig/p.js', contextIsolation: true } });
    assert.strictEqual(win.options.webPreferences.preload, proxy.PRELOAD_PATH);
    assert.ok(win.options.webPreferences.additionalArguments.some((a) => a === '--ggb-extend-chain-preload=/orig/p.js'));
  } finally {
    // Restore loader + clear the proxy's installed hook so other tests are clean.
    Module._load = origLoad;
    delete Module.__ggbExtendElectronHook;
    delete Module.__ggbExtendElectronView;
  }
});

test('patch is idempotent (no double wrap)', () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  proxy.patchBrowserWindow(electron);
  const first = electron.BrowserWindow;
  proxy.patchBrowserWindow(electron);
  assert.strictEqual(electron.BrowserWindow, first, 'second patch should be a no-op');
});

test('windows with no webPreferences still get our preload', () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  proxy.patchBrowserWindow(electron);
  const win = new electron.BrowserWindow({});
  assert.strictEqual(win.options.webPreferences.preload, proxy.PRELOAD_PATH);
  // no original preload -> no chain switch
  assert.ok(!win.options.webPreferences.additionalArguments.some((a) => a.startsWith('--ggb-extend-chain-preload=')));
});

test('registerIpc creates plugin dir + state file and registers channels', () => {
  const userData = freshUserData();
  const electron = makeElectronStub(userData);
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);

  assert.ok(fs.existsSync(p.root), 'GGB_Plugins dir created');
  assert.ok(fs.existsSync(p.stateFile), 'state.json created');
  for (const ch of [
    'ggb-extend:get-plugin-list',
    'ggb-extend:toggle-plugin',
    'ggb-extend:open-plugin-folder',
    'ggb-extend:get-settings',
    'ggb-extend:set-settings',
    'ggb-extend:net-fetch',
    'ggb-extend:net-approve',
    'ggb-extend:read-plugin-source',
  ]) {
    assert.ok(electron.__handlers.has(ch), 'channel registered: ' + ch);
  }
});

test('get-plugin-list reads manifests; toggle persists state', async () => {
  const userData = freshUserData();
  const electron = makeElectronStub(userData);
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);

  // drop a fake plugin on disk
  const pluginDir = path.join(p.root, 'hello-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'hello-plugin', name: 'Hello', version: '1.2.3', author: 'me', description: 'hi', main: 'index.js',
  }));
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'console.log("hello plugin")');

  const list1 = await electron.__invoke('ggb-extend:get-plugin-list');
  assert.strictEqual(list1.ok, true);
  assert.strictEqual(list1.plugins.length, 1);
  assert.strictEqual(list1.plugins[0].id, 'hello-plugin');
  // P2-3: a freshly dropped-in plugin is DISABLED until the user enables it.
  assert.strictEqual(list1.plugins[0].enabled, false, 'defaults to disabled');
  assert.strictEqual(list1.plugins[0].status, 'new', 'undecided plugins are marked new');

  // toggle ON persists, then OFF again
  const on = await electron.__invoke('ggb-extend:toggle-plugin', { id: 'hello-plugin', enabled: true });
  assert.strictEqual(on.ok, true);
  const listOn = await electron.__invoke('ggb-extend:get-plugin-list');
  assert.strictEqual(listOn.plugins[0].enabled, true, 'enabled after explicit toggle');

  const toggled = await electron.__invoke('ggb-extend:toggle-plugin', { id: 'hello-plugin', enabled: false });
  assert.strictEqual(toggled.ok, true);
  assert.ok(toggled.ggbId, 'toggle returns the ggbId it wrote');
  const state = JSON.parse(fs.readFileSync(p.stateFile, 'utf8'));
  assert.strictEqual(state.targets[toggled.ggbId].enabled['hello-plugin'], false);

  const list2 = await electron.__invoke('ggb-extend:get-plugin-list');
  assert.strictEqual(list2.plugins[0].enabled, false, 'disabled reflected after toggle');
});

test('built-in plugins stay enabled in proxy plugin lists', async () => {
  const userData = freshUserData();
  const electron = makeElectronStub(userData);
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);

  const pluginDir = path.join(p.root, 'panel-manager');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'panel-manager',
    name: 'Plugin Panel',
    version: '1.0.0',
    author: 'Neogebra',
    main: 'index.js',
    builtin: true,
  }));

  let list = await electron.__invoke('ggb-extend:get-plugin-list');
  let panel = list.plugins.find((x) => x.id === 'panel-manager');
  assert.strictEqual(panel.enabled, true, 'built-in panel is enabled on first sight');
  assert.strictEqual(panel.status, 'enabled');

  await electron.__invoke('ggb-extend:toggle-plugin', { id: 'panel-manager', enabled: false });
  list = await electron.__invoke('ggb-extend:get-plugin-list');
  panel = list.plugins.find((x) => x.id === 'panel-manager');
  assert.strictEqual(panel.enabled, true, 'stale false state cannot disable a built-in plugin');
  assert.strictEqual(panel.status, 'enabled');
});

test('open-plugin-folder calls shell.openPath with the plugins root', async () => {
  const userData = freshUserData();
  const electron = makeElectronStub(userData);
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);
  const res = await electron.__invoke('ggb-extend:open-plugin-folder');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(electron.__openedPaths, [p.root]);
});

test('settings round-trip through IPC', async () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  proxy.registerIpc(electron);
  await electron.__invoke('ggb-extend:set-settings', { opacity: 0.7, theme: 'midnight' });
  const got = await electron.__invoke('ggb-extend:get-settings');
  assert.strictEqual(got.settings.opacity, 0.7);
  assert.strictEqual(got.settings.theme, 'midnight');
});

test('netFetch enforces https + declared host + user approval + SSRF block', async () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);

  const declaredHosts = new Set(['api.openai.com']);
  const approved = { 'api.openai.com': true };
  const ctx = { pluginId: 'ai', declaredHosts, isApproved: (h) => approved[h] === true };

  // non-https → rejected
  let r = await proxy.netFetch({ url: 'http://api.openai.com/v1/x' }, ctx);
  assert.strictEqual(r.ok, false); assert.match(r.error, /https/);

  // host NOT declared in the manifest → rejected (ENOTDECLARED)
  r = await proxy.netFetch({ url: 'https://evil.example.com/x' }, ctx);
  assert.strictEqual(r.code, 'ENOTDECLARED');

  // declared but NOT yet approved → needsApproval
  r = await proxy.netFetch({ url: 'https://api.openai.com/v1/x' }, { pluginId: 'ai', declaredHosts, isApproved: () => false });
  assert.strictEqual(r.needsApproval, true);
  assert.strictEqual(r.host, 'api.openai.com');

  // declared + approved but a bad method → rejected
  r = await proxy.netFetch({ url: 'https://api.openai.com/v1/x', method: 'TRACE' }, ctx);
  assert.strictEqual(r.ok, false); assert.match(r.error, /Method not allowed/);
});

test('isBlockedHost blocks loopback/private/metadata, allows public', () => {
  const proxy = loadProxyFresh(makeElectronStub(freshUserData()));
  for (const h of ['localhost', '127.0.0.1', '::1', '169.254.169.254', '10.1.2.3', '192.168.0.5', '172.16.9.9', 'metadata.google.internal']) {
    assert.strictEqual(proxy.isBlockedHost(h), true, `should block ${h}`);
  }
  for (const h of ['api.openai.com', 'example.com', '8.8.8.8']) {
    assert.strictEqual(proxy.isBlockedHost(h), false, `should allow ${h}`);
  }
});

test('net-fetch IPC path: reads manifest perms + approvals, and SSRF still wins', async () => {
  const electron = makeElectronStub(freshUserData());
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);

  // a plugin that declares a host, plus user approval persisted via the IPC
  fs.mkdirSync(path.join(p.root, 'ai'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'ai', 'manifest.json'),
    JSON.stringify({ id: 'ai', name: 'AI', version: '1.0.0', main: 'index.js', permissions: { network: ['127.0.0.1'] } }));
  fs.writeFileSync(path.join(p.root, 'ai', 'index.js'), 'export default {}');

  // P2-2: obtain the plugin's capability token first (callers must prove identity)
  const issued = await electron.__invoke('ggb-extend:issue-net-tokens');
  const token = issued.tokens.ai;
  assert.ok(token, 'token issued for the plugin');

  // without a token → EBADCALLER (self-reported pluginId proves nothing)
  let res = await electron.__invoke('ggb-extend:net-fetch', { pluginId: 'ai', url: 'https://api.openai.com/x' });
  assert.strictEqual(res.code, 'EBADCALLER');

  // undeclared host → ENOTDECLARED (manifest perms read correctly through IPC)
  res = await electron.__invoke('ggb-extend:net-fetch', { pluginId: 'ai', token, url: 'https://api.openai.com/x' });
  assert.strictEqual(res.code, 'ENOTDECLARED');

  // declared but not approved → needsApproval
  res = await electron.__invoke('ggb-extend:net-fetch', { pluginId: 'ai', token, url: 'https://127.0.0.1/x' });
  assert.strictEqual(res.needsApproval, true);

  // approve it (persists to state.json) → now SSRF guard blocks loopback
  await electron.__invoke('ggb-extend:net-approve', { pluginId: 'ai', host: '127.0.0.1', allow: true, token });
  res = await electron.__invoke('ggb-extend:net-fetch', { pluginId: 'ai', token, url: 'https://127.0.0.1/x' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Blocked host/);
});

test('read-plugin-source returns code for the plugin entry', async () => {
  const userData = freshUserData();
  const electron = makeElectronStub(userData);
  const proxy = loadProxyFresh(electron);
  const p = proxy.registerIpc(electron);
  const dir = path.join(p.root, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', main: 'main.js' }));
  fs.writeFileSync(path.join(dir, 'main.js'), 'export const x = 42;');
  const res = await electron.__invoke('ggb-extend:read-plugin-source', { id: 'demo' });
  assert.strictEqual(res.ok, true);
  assert.match(res.code, /x = 42/);
});

test.after(() => { delete global.__GGB_EXTEND_ELECTRON__; });
