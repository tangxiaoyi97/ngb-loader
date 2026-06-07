// Plugin lifecycle contract: onLoad/onEnable/onDisable/onUnload hooks driven by
// the framework, plus the PluginContext handed to each hook.
export class PluginContext {
  /**
   * @param {object} opts
   * @param {import('./ggb-core.js').GgbCore} opts.core
   * @param {object} opts.manifest
   * @param {object} [opts.storage]  scoped key/value storage (sync get/set)
   * @param {object} [opts.host]     the preload bridge (window.ggbExtendHost)
   */
  constructor({ core, manifest, storage, host }) {
    this.core = core;
    this.manifest = manifest;
    this.id = manifest.id;
    this.storage = storage || new MemoryStorage();
    this.host = host || null;
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
  constructor() { this._m = new Map(); }
  get(key, fallback = null) { return this._m.has(key) ? this._m.get(key) : fallback; }
  set(key, value) { this._m.set(key, value); return value; }
  delete(key) { this._m.delete(key); }
  keys() { return [...this._m.keys()]; }
}

function makeLogger(id) {
  const tag = `[plugin:${id}]`;
  // eslint-disable-next-line no-console
  return {
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
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
