// Plugin lifecycle contract: onLoad/onEnable/onDisable/onUnload hooks driven by
// the framework, plus the PluginContext handed to each hook.

// ---------------------------------------------------------------------------
// Debug gating (quiet runtime). The framework is SILENT by default: no console
// output in the host's DevTools unless debugging was explicitly enabled (the
// preload forwards GGB_EXTEND_DEBUG, or a test flips it programmatically).
let SDK_DEBUG = false;
/** Enable/disable framework + plugin console logging (default: off). */
export function setDebug(v) { SDK_DEBUG = !!v; }
/** Whether debug logging is currently enabled. */
export function isDebug() { return SDK_DEBUG; }

export class PluginContext {
  /**
   * @param {object} opts
   * @param {import('./ggb-core.js').GgbCore} opts.core
   * @param {object} opts.manifest
   * @param {object} [opts.storage]  scoped key/value storage (sync get/set)
   * @param {object} [opts.host]     the preload IPC bridge
   * @param {object} [opts.net]      scoped network access: { fetch(url, opts) }
   * @param {object} [opts.ui]       UI mounting helpers: { mountInAlgebraView(opts) }
   * @param {object} [opts.runtime]  the framework runtime API (list/enable/disable…)
   */
  constructor({ core, manifest, storage, host, net, ui, runtime }) {
    this.core = core;
    this.manifest = manifest;
    this.id = manifest.id;
    this.storage = storage || new MemoryStorage();
    this.host = host || null;
    /** UI mounting helpers (mount a panel into GeoGebra's UI). */
    this.ui = ui || null;
    /** Guarded network access (only hosts declared in manifest.permissions.network
     *  and approved by the user). Undefined when no host bridge is present. */
    this.net = net || null;
    /** Framework runtime API (set by the loader; null in previews/tests). */
    this.runtime = runtime || null;
    /** @type {Array<() => void>} */
    this._disposables = [];
    this.log = makeLogger(manifest.id);
  }

  /** Register a cleanup function to run automatically on disable/unload. */
  registerDisposable(fn) {
    if (typeof fn === 'function') this._disposables.push(fn);
    return fn;
  }

  /** Run & clear all registered disposables (called by the framework). */
  runDisposables() {
    while (this._disposables.length) {
      const fn = this._disposables.pop();
      try { fn(); } catch (e) { this.log.error('disposable failed', e); }
    }
  }
}

/** Default in-memory storage (used in previews / when no host storage). */
export class MemoryStorage {
  constructor(initial) {
    this._m = new Map(initial ? Object.entries(initial) : undefined);
  }
  get(key, fallback = null) { return this._m.has(key) ? this._m.get(key) : fallback; }
  set(key, value) { this._m.set(key, value); return value; }
  delete(key) { this._m.delete(key); }
  keys() { return [...this._m.keys()]; }
}

// ---------------------------------------------------------------------------
// Persistent, host-backed storage. Sync read API (write-through memory cache),
// async persistence via an injected `persist(plainObject)` callback (the runtime
// wires this to the host bridge's set-settings IPC, namespaced by plugin id).
// Writes are serialized so out-of-order flushes can't clobber newer data.
export class HostStorage {
  /**
   * @param {object} opts
   * @param {object} [opts.initial]  decoded namespace contents loaded at boot
   * @param {function} opts.persist  async (plainObject) => void
   */
  constructor({ initial, persist } = {}) {
    this._m = new Map(initial ? Object.entries(initial) : undefined);
    this._persist = typeof persist === 'function' ? persist : null;
    this._chain = Promise.resolve();
  }
  get(key, fallback = null) { return this._m.has(key) ? this._m.get(key) : fallback; }
  set(key, value) { this._m.set(key, value); this._flush(); return value; }
  delete(key) { this._m.delete(key); this._flush(); }
  keys() { return [...this._m.keys()]; }
  _flush() {
    if (!this._persist) return this._chain;
    const snapshot = Object.fromEntries(this._m);
    this._chain = this._chain
      .then(() => this._persist(snapshot))
      .catch(() => { /* persistence is best-effort; cache stays authoritative */ });
    return this._chain;
  }
  /** Await all pending writes (tests / shutdown). */
  flush() { return this._chain; }
}

// --- namespace obfuscation -------------------------------------------------
// Plugin settings (which may include API keys) are not stored under readable
// key names in state.json. The whole namespace is serialized, XOR-mixed with a
// namespace-derived key and base64-encoded: { __v: 1, d: "<blob>" }. This is
// obfuscation (not encryption): it keeps secrets from appearing in plain sight
// when a user opens or shares state.json.
function textToBytes(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  // eslint-disable-next-line no-undef
  return Uint8Array.from(Buffer.from(s, 'utf8'));
}
function bytesToText(b) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(b);
  // eslint-disable-next-line no-undef
  return Buffer.from(b).toString('utf8');
}
function bytesToB64(bytes) {
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function xorMix(bytes, ns) {
  const key = textToBytes(`ns1:${ns}`);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ key[i % key.length];
  return out;
}

/** Encode a plugin's settings namespace for at-rest storage. */
export function encodeNamespace(obj, ns) {
  const json = JSON.stringify(obj || {});
  return { __v: 1, d: bytesToB64(xorMix(textToBytes(json), ns)) };
}

/**
 * Decode a stored namespace. Tolerates: undefined (→ {}), the encoded form,
 * and a legacy PLAIN object (pre-encoding) for forward migration.
 */
export function decodeNamespace(stored, ns) {
  if (!stored || typeof stored !== 'object') return {};
  if (stored.__v === 1 && typeof stored.d === 'string') {
    try {
      const parsed = JSON.parse(bytesToText(xorMix(b64ToBytes(stored.d), ns)));
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch { return {}; }
  }
  return { ...stored }; // legacy plain namespace
}

function makeLogger(id) {
  const tag = `[plugin:${id}]`;
  // Silent unless debug is on — the host console must stay clean (quiet runtime).
  // eslint-disable-next-line no-console
  return {
    info: (...a) => { if (SDK_DEBUG) console.log(tag, ...a); },
    warn: (...a) => { if (SDK_DEBUG) console.warn(tag, ...a); },
    error: (...a) => { if (SDK_DEBUG) console.error(tag, ...a); },
  };
}

/**
 * Base class for plugins. Subclass and override the hooks you need.
 * All hooks are optional and may be async.
 */
export class Plugin {
  /** @param {PluginContext} ctx */
  constructor(ctx) { this.ctx = ctx; }

  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async onLoad(ctx) {}
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async onEnable(ctx) {}
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async onDisable(ctx) {}
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async onUnload(ctx) {}

  /**
   * Optional: open this plugin's own settings/config UI. Called by the panel's
   * "设置" (Settings) button; the button is disabled if not implemented.
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async onOpenSettings(ctx) {}
}

/**
 * Validate & normalize a manifest object. Throws on hard errors.
 * Required: id, name, version, main. Optional: author, description, icon,
 * engines.ngbLoader (semver range), permissions[].
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
  const required = ['id', 'name', 'version', 'main'];
  for (const k of required) {
    if (!manifest[k]) throw new Error(`manifest missing required field: ${k}`);
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(manifest.id)) {
    throw new Error(`manifest.id "${manifest.id}" must be alphanumeric/dash/underscore`);
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    main: manifest.main,
    author: manifest.author || 'unknown',
    description: manifest.description || '',
    icon: manifest.icon || null,
    engines: manifest.engines || {},
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
    // 'iife' = pre-bundled (preferred for distribution; no source transform),
    // 'esm' = authored source rewritten by the dev-only transformer.
    format: manifest.format === 'iife' ? 'iife' : 'esm',
  };
}

/**
 * Drive a plugin instance (class instance or plain hook object) through a
 * lifecycle transition. Centralizes try/catch + disposable handling so the
 * framework (and tests) behave consistently.
 */
export async function runLifecycle(instance, phase, ctx) {
  const hook = instance && typeof instance[phase] === 'function' ? instance[phase].bind(instance) : null;
  if (phase === 'onDisable' || phase === 'onUnload') {
    // Teardown must be resilient: a failing hook should be logged, NOT thrown,
    // and disposables must run regardless. We never want teardown to break the
    // framework's ability to disable/unload other plugins.
    try {
      if (hook) await hook(ctx);
    } catch (err) {
      const log = (ctx && ctx.log) || console;
      log.error(`${phase} hook threw (continuing teardown):`, err && err.message ? err.message : err);
    } finally {
      ctx.runDisposables();
    }
    return;
  }
  // Setup phases (onLoad/onEnable) DO propagate errors so the framework can mark
  // the plugin as failed and surface it to the user.
  if (hook) await hook(ctx);
}

export default Plugin;
