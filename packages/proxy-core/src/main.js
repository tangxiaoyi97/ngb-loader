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
// QUIET RUNTIME: outside debug mode the framework logs NOTHING — errors included
// (fail-safe behavior is unchanged; only the reporting is gated).
const DEBUG = process.env.GGB_EXTEND_DEBUG === '1' || process.env.GGB_EXTEND_DEBUG === 'true';
function dbg(...args) { if (DEBUG) console.log(TAG, ...args); }
function dbgErr(...args) { if (DEBUG) console.error(TAG, ...args); }

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

// ---------------------------------------------------------------------------
// Network approvals — PER-GGB isolated (like the enabled lists): approving a
// host for a plugin in one GeoGebra must not grant it in another. New schema:
//   targets[<ggbId>].netApprovals[pluginId][host] = true|false
// Back-compat: the old GLOBAL `state.netApprovals[pluginId]` is used as a
// read fallback while THIS ggb has no record for that plugin, and is copied
// into the per-target record on first write (seed-on-write migration) so an
// upgrade doesn't silently drop a user's earlier decisions.

/** Read the approval map for (ggbId, pluginId). Falls back to legacy global. */
function targetApprovals(state, id, pluginId) {
  const t = state.targets && state.targets[id] && state.targets[id].netApprovals;
  if (t && t[pluginId]) return t[pluginId];
  return (state.netApprovals && state.netApprovals[pluginId]) || {};
}

/** Ensure (and return) the per-target approval record, seeding from legacy. */
function ensureTargetApprovals(state, id, pluginId) {
  if (!state.targets) state.targets = {};
  if (!state.targets[id]) state.targets[id] = { enabled: {} };
  if (!state.targets[id].netApprovals) state.targets[id].netApprovals = {};
  if (!state.targets[id].netApprovals[pluginId]) {
    const legacy = (state.netApprovals && state.netApprovals[pluginId]) || {};
    state.targets[id].netApprovals[pluginId] = { ...legacy };
  }
  state.version = 2;
  return state.targets[id].netApprovals[pluginId];
}

function setTargetApproval(state, id, pluginId, host, allow) {
  ensureTargetApprovals(state, id, pluginId)[host] = !!allow;
  return state;
}

/** Revoke = delete the record → the next access asks the user again. */
function revokeTargetApproval(state, id, pluginId, host) {
  const rec = ensureTargetApprovals(state, id, pluginId);
  delete rec[host];
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
    dbgErr('failed to prepare plugin dir:', err && err.message);
  }
  return p;
}

// ---------------------------------------------------------------------------
// state.json concurrency safety. Multiple injected GeoGebra instances share one
// state.json, so: reads fall back to the last-known-good .bak instead of
// resetting; writes are ATOMIC (tmp + rename) with a .bak of the previous valid
// file; and read-modify-write cycles go through updateState(), which holds a
// cross-process lock (atomic mkdir) and re-reads fresh state inside it — so two
// instances flipping toggles concurrently can't clobber each other or ever
// leave a half-written JSON behind.

function defaultState() { return { version: 1, enabled: {}, settings: {} }; }

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(`${stateFile}.bak`, 'utf8'));
    } catch {
      return defaultState();
    }
  }
}

function writeState(stateFile, state) {
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    const json = JSON.stringify(state, null, 2);
    // Keep a backup of the previous VALID file before replacing it.
    try {
      const cur = fs.readFileSync(stateFile, 'utf8');
      JSON.parse(cur);
      fs.writeFileSync(`${tmp}.bak`, cur);
      fs.renameSync(`${tmp}.bak`, `${stateFile}.bak`);
    } catch { /* no previous valid file — nothing to back up */ }
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, stateFile); // atomic on POSIX & modern Windows
    return true;
  } catch (err) {
    dbgErr('failed to persist state:', err && err.message);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

const LOCK_STALE_MS = 5000;

function acquireStateLock(stateFile, timeoutMs = 2000) {
  const lock = `${stateFile}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock); // atomic create-or-fail, works cross-process
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true }); // crashed holder
          continue;
        }
      } catch { /* raced with the holder's release — retry */ }
      if (Date.now() - start > timeoutMs) return false;
      sleepSync(15 + Math.floor(Math.random() * 25));
    }
  }
}

function releaseStateLock(stateFile) {
  try { fs.rmSync(`${stateFile}.lock`, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Locked read-modify-write: re-reads the CURRENT state under a cross-process
 * lock, applies `mutate(state)`, persists atomically. Returns the new state,
 * or null if the write failed.
 */
function updateState(stateFile, mutate) {
  const locked = acquireStateLock(stateFile);
  if (!locked) dbgErr('state lock unavailable — proceeding unlocked (best effort)');
  try {
    const state = readState(stateFile);
    mutate(state);
    return writeState(stateFile, state) ? state : null;
  } finally {
    if (locked) releaseStateLock(stateFile);
  }
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** Normalize a hostname (strip brackets, lowercase). */
function normHost(h) { return String(h || '').replace(/^\[|\]$/g, '').toLowerCase(); }

/**
 * SSRF guard: reject loopback, private, link-local, and cloud-metadata targets
 * even over https, so a plugin can't reach the local machine or an internal
 * network. We only allow public hostnames; raw private/reserved IPs are blocked.
 */
function isBlockedHost(hostname) {
  const h = normHost(hostname);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true; // cloud metadata
  // IPv6 loopback / link-local / unique-local (literal forms)
  if (h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4 literals in private/reserved ranges
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) return isBlockedIp(h);
  return false;
}

/**
 * P2-1: range check for a RESOLVED IP address (what the socket actually
 * connects to). The hostname-literal check above can be bypassed by a public
 * DNS name that resolves into a private network (DNS rebinding) — this is the
 * authoritative check, run on the result of the DNS lookup itself.
 */
function isBlockedIp(ip) {
  const s = normHost(ip);
  // IPv4 (also handles IPv4-mapped IPv6 like ::ffff:127.0.0.1)
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // loopback
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 169 && b === 254) return true;            // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true;                          // multicast/reserved
    return false;
  }
  // IPv6
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;          // unspecified / loopback
    if (s.startsWith('fe80:')) return true;              // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
    if (s.startsWith('::ffff:')) return true;            // v4-mapped not caught above → block
    return false;
  }
  return true; // unparseable → refuse
}

/**
 * Perform a guarded HTTP request on behalf of a plugin. Security checks (in
 * order): https only → host allowed by the plugin's manifest → host approved by
 * the user → not an SSRF target. The caller (IPC handler) supplies the plugin's
 * declared hosts and the user-approval check.
 * @param {object} request { url, method, headers, body, timeoutMs }
 * @param {object} ctx { declaredHosts:Set<string>, isApproved:(host)=>boolean, pluginId }
 */
function netFetch(request = {}, ctx = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(String(request.url || '')); }
    catch { resolve({ ok: false, status: 0, error: 'Invalid request URL' }); return; }

    if (target.protocol !== 'https:') {
      resolve({ ok: false, status: 0, error: 'Only https:// URLs are allowed' }); return;
    }
    const host = normHost(target.hostname);
    const declared = ctx.declaredHosts || new Set();
    if (!declared.has(host)) {
      resolve({ ok: false, status: 0, code: 'ENOTDECLARED', error: `Plugin "${ctx.pluginId}" did not declare network access to ${host} (add it to manifest permissions.network)` });
      return;
    }
    if (typeof ctx.isApproved === 'function' && !ctx.isApproved(host)) {
      resolve({ ok: false, status: 0, code: 'ENEEDSAPPROVAL', needsApproval: true, host, pluginId: ctx.pluginId, error: `User has not approved ${host} for "${ctx.pluginId}"` });
      return;
    }
    if (isBlockedHost(host)) {
      resolve({ ok: false, status: 0, error: `Blocked host (private/loopback/metadata): ${host}` }); return;
    }

    const method = String(request.method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      resolve({ ok: false, status: 0, error: `Method not allowed: ${method}` }); return;
    }

    // Body may be a string / JSON-serializable value (sent as text), OR raw
    // binary supplied as base64 via `request.bodyBase64` (for multipart uploads
    // like audio transcription — IPC structured-clone can't carry a Blob, and a
    // utf8 string would corrupt binary, so the plugin base64-encodes the bytes).
    let body;            // string body
    let bodyBuf;         // Buffer body (binary)
    const MAX_BODY = 25 * 1024 * 1024; // allow audio clips; Whisper caps at 25MB
    if (request.bodyBase64 !== undefined && request.bodyBase64 !== null && method !== 'GET') {
      try { bodyBuf = Buffer.from(String(request.bodyBase64), 'base64'); }
      catch { resolve({ ok: false, status: 0, error: 'Invalid base64 body' }); return; }
      if (bodyBuf.length > MAX_BODY) { resolve({ ok: false, status: 0, error: 'Request body too large' }); return; }
    } else if (request.body !== undefined && request.body !== null && method !== 'GET') {
      body = typeof request.body === 'string' ? request.body : (() => {
        try { return JSON.stringify(request.body); } catch { return undefined; }
      })();
      if (body === undefined) { resolve({ ok: false, status: 0, error: 'Body must be a string or JSON-serializable' }); return; }
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) { resolve({ ok: false, status: 0, error: 'Request body too large' }); return; }
    }

    const headers = Object.assign({}, request.headers || {});
    for (const k of Object.keys(headers)) {
      if (/^(host|content-length)$/i.test(k)) delete headers[k];
    }
    if (bodyBuf !== undefined) {
      // Binary: caller MUST set its own Content-Type (e.g. multipart boundary).
      headers['Content-Length'] = bodyBuf.length;
    } else if (body !== undefined) {
      if (!Object.keys(headers).some((k) => /^content-type$/i.test(k))) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const https = ctx._https || require('https');
    const dns = require('dns');
    // P2-1: validate the RESOLVED address, not just the hostname literal. The
    // socket's own lookup is hooked so the IP that gets connected to is the IP
    // that was checked (no separate-resolve TOCTOU); DNS-rebinding names that
    // resolve into private/reserved ranges are refused.
    const baseLookup = ctx._dnsLookup || dns.lookup;
    const guardedLookup = (host, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      baseLookup(host, options, (err, address, family) => {
        if (err) { cb(err); return; }
        // options.all → array of {address, family}
        const addrs = Array.isArray(address) ? address.map((a) => a.address) : [address];
        const bad = addrs.find((a) => isBlockedIp(a));
        if (bad) {
          cb(new Error(`Blocked: ${host} resolves to a private/reserved address (${bad})`));
          return;
        }
        cb(null, address, family);
      });
    };
    const req = https.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      lookup: guardedLookup,
      timeout: Math.max(1000, Math.min(Number(request.timeoutMs) || 60000, 120000)),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 8 * 1024 * 1024) chunks.push(chunk);
        else req.destroy(new Error('Response body too large'));
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          data, text,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err && err.message ? err.message : String(err) }));
    if (bodyBuf !== undefined) req.write(bodyBuf);
    else if (body !== undefined) req.write(body);
    req.end();
  });
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
    format: manifest.format === 'iife' ? 'iife' : 'esm',
    icon: iconToDataUri(dir, manifest.icon),
    builtin: !!manifest.builtin,
    permissions: {
      network: Array.isArray(manifest.permissions && manifest.permissions.network)
        ? manifest.permissions.network.map((h) => String(h)) : [],
    },
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
    // Built-in plugins are bundled framework components and must stay enabled,
    // even if an old state file contains false for their id.
    if (m.builtin) {
      m.enabled = true;
      m.status = 'enabled';
      out.push(m);
      continue;
    }
    // P2-3: default DISABLED. A plugin only runs after the user explicitly
    // enabled it for THIS GeoGebra — dropping a folder into GGB_Plugins must
    // never execute code on next launch by itself. Three states:
    //   true → enabled · false → user disabled · absent → 'new' (never decided)
    const rec = enabled[m.id];
    m.enabled = rec === true;
    m.status = rec === true ? 'enabled' : rec === false ? 'disabled' : 'new';
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

  // P2-2: per-plugin capability tokens. `ggb-extend:net-fetch` used to trust the
  // payload's self-reported pluginId — any code in the renderer could borrow
  // another plugin's approved hosts. Now the PRELOAD (not the page) obtains a
  // random token per plugin over a channel that is NOT exposed on the page
  // bridge; the runtime hands each plugin a net.fetch closure carrying only its
  // own token, and the handlers below verify (sender, pluginId, token) together.
  // eslint-disable-next-line global-require
  const crypto2 = require('crypto');
  const netTokens = new Map(); // `${webContentsId}:${pluginId}` → token

  const verifyNetCaller = (evt, pluginId, token) => {
    const senderId = evt && evt.sender ? evt.sender.id : -1;
    const expected = netTokens.get(`${senderId}:${pluginId}`);
    return !!expected && typeof token === 'string' && token === expected;
  };

  handle('ggb-extend:issue-net-tokens', async (evt) => {
    const senderId = evt && evt.sender ? evt.sender.id : -1;
    const tokens = {};
    for (const plugin of listPlugins(p, myGgbId)) {
      const t = crypto2.randomBytes(16).toString('hex');
      netTokens.set(`${senderId}:${plugin.id}`, t);
      tokens[plugin.id] = t;
    }
    // Drop this window's tokens when it goes away.
    try {
      evt.sender.once('destroyed', () => {
        for (const k of [...netTokens.keys()]) if (k.startsWith(`${senderId}:`)) netTokens.delete(k);
      });
    } catch { /* test stubs */ }
    return { ok: true, tokens };
  });

  handle('ggb-extend:get-ggb-id', async () => ({ ok: true, id: myGgbId }));

  handle('ggb-extend:get-plugin-list', async () => {
    return { ok: true, plugins: listPlugins(p, myGgbId), root: p.root, ggbId: myGgbId };
  });

  handle('ggb-extend:toggle-plugin', async (_evt, { id, enabled }) => {
    const next = updateState(p.stateFile, (state) => setTargetEnabled(state, myGgbId, id, enabled));
    return { ok: !!next, id, enabled: !!enabled, ggbId: myGgbId };
  });

  handle('ggb-extend:open-plugin-folder', async () => {
    try {
      await shell.openPath(p.root);
      return { ok: true, path: p.root };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  // Open an external link in the user's default browser (NOT an Electron window).
  // Only http(s) is allowed, so a plugin can't trigger file:// or app-scheme opens.
  handle('ggb-extend:open-external', async (_evt, { url } = {}) => {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http(s) links can be opened' };
      await shell.openExternal(u.href);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  handle('ggb-extend:get-settings', async () => {
    const state = readState(p.stateFile);
    return { ok: true, settings: state.settings || {} };
  });

  handle('ggb-extend:set-settings', async (_evt, settings) => {
    const next = updateState(p.stateFile, (state) => {
      state.settings = Object.assign({}, state.settings, settings || {});
    });
    return { ok: !!next, settings: next ? next.settings : null };
  });

  // Guarded network request for a plugin. The plugin must (a) present its own
  // capability token (P2-2 — the payload's pluginId alone proves nothing),
  // (b) declare the host in its manifest permissions.network, and (c) have the
  // user's approval for it (persisted in state.json under netApprovals).
  // SSRF targets are blocked at both the hostname and the resolved-IP layer.
  handle('ggb-extend:net-fetch', async (evt, request = {}) => {
    const pluginId = request.pluginId;
    if (!verifyNetCaller(evt, pluginId, request.token)) {
      return { ok: false, status: 0, code: 'EBADCALLER', error: 'Caller identity check failed (invalid plugin token)' };
    }
    const plugin = listPlugins(p).find((x) => x.id === pluginId);
    if (!plugin) return { ok: false, status: 0, error: 'unknown plugin' };
    const declaredHosts = new Set((plugin.permissions && plugin.permissions.network ? plugin.permissions.network : []).map(normHost));
    const state = readState(p.stateFile);
    const approvals = targetApprovals(state, myGgbId, pluginId); // per-GGB isolated
    return netFetch(request, {
      pluginId,
      declaredHosts,
      isApproved: (host) => approvals[host] === true,
    });
  });

  // Record the user's decision to allow a plugin to reach a host (persisted,
  // per-GGB). Same caller check: a plugin must not grant approvals to another.
  handle('ggb-extend:net-approve', async (evt, { pluginId, host, allow, token } = {}) => {
    if (!pluginId || !host) return { ok: false, error: 'pluginId and host required' };
    if (!verifyNetCaller(evt, pluginId, token)) {
      return { ok: false, code: 'EBADCALLER', error: 'Caller identity check failed (invalid plugin token)' };
    }
    const next = updateState(p.stateFile, (state) => {
      setTargetApproval(state, myGgbId, pluginId, normHost(host), allow);
    });
    return { ok: !!next };
  });

  // Approval status for the panel's network-permissions section: the manifest's
  // declared hosts plus this GGB's recorded decisions. Read-only metadata.
  handle('ggb-extend:net-approvals', async (_evt, { pluginId } = {}) => {
    if (!pluginId) return { ok: false, error: 'pluginId required' };
    const plugin = listPlugins(p, myGgbId).find((x) => x.id === pluginId);
    const declared = plugin && plugin.permissions && Array.isArray(plugin.permissions.network)
      ? plugin.permissions.network.map(normHost) : [];
    const state = readState(p.stateFile);
    return { ok: true, pluginId, declared, approvals: { ...targetApprovals(state, myGgbId, pluginId) } };
  });

  // Revoke a recorded decision (panel action). Deliberately UNauthenticated by
  // plugin token: revoking is the safe direction (the next access re-prompts
  // the user), and the panel acts for the user, not for a plugin.
  handle('ggb-extend:net-revoke', async (_evt, { pluginId, host } = {}) => {
    if (!pluginId || !host) return { ok: false, error: 'pluginId and host required' };
    const next = updateState(p.stateFile, (state) => {
      revokeTargetApproval(state, myGgbId, pluginId, normHost(host));
    });
    return { ok: !!next };
  });

  // Read a plugin's source bundle so the renderer can evaluate it in-page.
  // P2-2: the entry is resolved and confined to the plugin's own directory —
  // a manifest `main` like "../../somewhere" must not read outside it.
  handle('ggb-extend:read-plugin-source', async (_evt, { id }) => {
    const plugins = listPlugins(p);
    const plugin = plugins.find((x) => x.id === id);
    if (!plugin) return { ok: false, error: 'plugin not found' };
    const dirResolved = path.resolve(plugin.dir);
    const entry = path.resolve(dirResolved, plugin.main);
    if (entry !== dirResolved && !entry.startsWith(dirResolved + path.sep)) {
      return { ok: false, error: 'invalid plugin main path' };
    }
    try {
      const code = fs.readFileSync(entry, 'utf8');
      return { ok: true, id, code, manifest: plugin };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  dbg('IPC channels registered. Plugins dir:', p.root);
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
        if (process.env.GGB_EXTEND_DEBUG === '1' || process.env.GGB_EXTEND_DEBUG === 'true') {
          console.error(TAG, 'option rewrite failed, using original options:', err && err.message);
        }
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
        dbg('host requested sandbox:true; disabling for preload injection');
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
      dbgErr('module-loader hook failed:', err && err.message);
    }
  }

  if (installed) {
    dbg('BrowserWindow patched (preload chaining active).');
  } else {
    dbgErr('FAILED to install patched BrowserWindow — panel will not load.');
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
    dbgErr('IPC registration failed:', err && err.message);
  }
}

function start() {
  dbg('proxy core starting…');
  try {
    applyHooks();
  } catch (err) {
    dbgErr('hook installation failed (continuing to boot core):', err && err.stack);
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
  updateState,
  acquireStateLock,
  releaseStateLock,
  readPluginManifest,
  listPlugins,
  netFetch,
  isBlockedHost,
  isBlockedIp,
  targetApprovals,
  setTargetApproval,
  revokeTargetApproval,
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
