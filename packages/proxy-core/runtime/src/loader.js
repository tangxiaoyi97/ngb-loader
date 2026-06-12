// The plugin runtime loader (runs in GeoGebra's main world). All I/O is injected
// so it is unit-testable without Electron or a browser.

/**
 * Transform a plugin's authored ESM source into something we can evaluate with
 * `new Function`, mapping the SDK import to an injected `__sdk` and the default
 * export to a return value. This is intentionally small — it supports the import
 * shapes our SDK docs use, not arbitrary bundler syntax.
 *
 * Supported:
 *   import { Plugin, GgbCore } from '@neogebra/sdk';
 *   import Plugin from '@neogebra/sdk';            (rare)
 *   export default class X extends Plugin { ... }
 *   export default { onEnable() {} };
 */
export function transformPluginSource(source) {
  let code = String(source);

  // Map: import <named/default> from '@neogebra/sdk' (or legacy @ggb-extend/sdk)
  //   → const ... = __sdk
  code = code.replace(
    /import\s+([^;]*?)\s+from\s+['"]@(?:neogebra|ggb-extend)\/sdk['"]\s*;?/g,
    (_m, clause) => `const ${clause.trim()} = __sdk;`
  );
  // Bare side-effect import of the sdk → drop it
  code = code.replace(/import\s+['"]@(?:neogebra|ggb-extend)\/sdk['"]\s*;?/g, '');

  // Handle bundler output:  export { Foo as default, Bar };
  //   → assign default to __exports.default; drop the rest.
  code = code.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, inner) => {
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    const stmts = [];
    for (const p of parts) {
      const m = p.match(/^(\S+)\s+as\s+default$/);
      if (m) stmts.push(`__exports.default = ${m[1]};`);
      // named exports other than default are ignored (plugins only need default)
    }
    return stmts.join('\n');
  });

  // export default <expr>  →  __exports.default = <expr>
  code = code.replace(/export\s+default\s+/g, '__exports.default = ');
  // export const/let/var/function/class NAME  →  strip the keyword (keep decl).
  code = code.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');

  return code;
}

/**
 * Evaluate a plugin module. Returns its default export (the plugin class or
 * hook object).
 *
 * Two formats (P1-5):
 *  - 'iife' (PREFERRED for distribution): a pre-bundled IIFE that assigns its
 *    module exports to `__exports.default` (esbuild: --format=iife
 *    --global-name=__exports.default) and may `require('@neogebra/sdk')`
 *    (mapped to the injected SDK). NO source transformation is applied — large
 *    plugins never go through the regex rewriter.
 *  - 'esm' (dev convenience): authored ESM source rewritten by
 *    transformPluginSource. The regex transform can mis-fire on import/export
 *    look-alikes inside strings or comments, which is why bundled plugins must
 *    use 'iife'.
 *
 * @param {string} source raw plugin source
 * @param {object} sdk    the @neogebra/sdk module object
 * @param {object} [opts] { format: 'esm' | 'iife' }
 */
export function evaluatePlugin(source, sdk, opts = {}) {
  const format = opts.format === 'iife' ? 'iife' : 'esm';
  const exportsObj = {};
  if (format === 'iife') {
    // Map CommonJS-style sdk requires (esbuild `external` output) to the
    // injected SDK; everything else is refused (plugins are sandbox-bundled).
    const requireShim = (m) => {
      if (m === '@neogebra/sdk' || m === '@ggb-extend/sdk') return sdk;
      throw new Error(`Cannot require "${m}" — bundle all dependencies into the plugin`);
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('__sdk', '__exports', 'require', `${source}\n;return __exports;`);
    fn(sdk, exportsObj, requireShim);
    let def = exportsObj.default;
    // esbuild's --global-name assigns the module NAMESPACE object; unwrap its
    // default export when present.
    if (def && typeof def === 'object' && def.default !== undefined) def = def.default;
    return def;
  }
  const transformed = transformPluginSource(source);
  // `__sdk` and `__exports` are the only injected names.
  // eslint-disable-next-line no-new-func
  const fn = new Function('__sdk', '__exports', `${transformed}\n;return __exports;`);
  fn(sdk, exportsObj);
  return exportsObj.default;
}

/** Instantiate a plugin (class → new, plain object → as-is). */
export function instantiatePlugin(def, ctx) {
  if (!def) throw new Error('plugin has no default export');
  if (typeof def === 'function') {
    // class or factory
    try { return new def(ctx); } catch { return def(ctx); }
  }
  return def; // plain hooks object
}

// Watchdog for plugin lifecycle hooks: a hook that never settles (e.g. awaits a
// request that never resolves) must not stall the whole load chain — that would
// keep the panel and every later plugin from coming up, and visibly slow
// GeoGebra's startup. On timeout the plugin is marked failed and loading moves on.
export const DEFAULT_HOOK_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => { if (timer) clearTimeout(timer); });
}

export class PluginLoader {
  /**
   * @param {object} deps
   * @param {object} deps.sdk           the @neogebra/sdk module
   * @param {object} deps.core          a ready GgbCore (or null in headless)
   * @param {object} deps.host          the preload IPC bridge
   * @param {function} deps.makeStorage (pluginId) => PluginStorage
   * @param {function} [deps.getRuntime] () => runtime API exposed on ctx.runtime
   * @param {number}   [deps.hookTimeoutMs] watchdog for lifecycle hooks
   * @param {function} [deps.onLog]
   */
  constructor({ sdk, core, host, makeStorage, makeNet, getRuntime, hookTimeoutMs, onLog }) {
    this.sdk = sdk;
    this.core = core;
    this.host = host;
    this.makeStorage = makeStorage || (() => new sdk.MemoryStorage());
    // makeNet(pluginId, manifest) → { fetch(url, opts) } | null
    this.makeNet = makeNet || (() => null);
    this.getRuntime = getRuntime || (() => null);
    this.hookTimeoutMs = hookTimeoutMs === undefined ? DEFAULT_HOOK_TIMEOUT_MS : hookTimeoutMs;
    this.onLog = onLog || (() => {});
    /** @type {Map<string, object>} id → { manifest, instance, ctx, enabled, builtin, error } */
    this.loaded = new Map();
  }

  log(level, msg) { try { this.onLog({ level, msg, ts: Date.now() }); } catch { /* noop */ } }

  /** Run a lifecycle hook under the watchdog. */
  _lifecycle(instance, phase, ctx) {
    return withTimeout(
      this.sdk.runLifecycle(instance, phase, ctx),
      this.hookTimeoutMs,
      `${ctx && ctx.id ? ctx.id : 'plugin'}.${phase}`,
    );
  }

  /**
   * Load a single plugin descriptor. Evaluates + instantiates + runs onLoad.
   * If enabled, also runs onEnable. Errors are captured per-plugin (one bad
   * plugin must not break the others).
   * @param {object} d { id, manifest, source, enabled, builtin }
   */
  async loadOne(d) {
    const { sdk } = this;
    const manifest = sdk.validateManifest(d.manifest);
    const record = { manifest, instance: null, ctx: null, enabled: !!d.enabled, builtin: !!d.builtin, error: null };
    try {
      const def = evaluatePlugin(d.source, sdk, { format: manifest.format });
      // Each created dock/row registers its OWN cleanup disposable at creation
      // time. Disposables are consumed on every disable, so cleanup is tied to
      // the activation that created the UI: enable→disable→enable→disable tears
      // down each generation's docks/rows (no DOM or listener leaks across
      // repeated toggling).
      let ctx; // assigned below; the ui closures run only after instantiation
      const ui = {
        mountInAlgebraView: (uiOpts = {}) => {
          const dock = sdk.mountInAlgebraView(uiOpts);
          ctx.registerDisposable(() => { try { dock.destroy(); } catch { /* ignore */ } });
          return dock;
        },
        // Create a container that lives inside GeoGebra's algebra list as a
        // native object row (framework hijacks a real GeoGebra object row).
        // Accepts { mode:'override'|'hybrid', name?, onAttached?, onRemoved?,
        // onMarbleClick? } — all forwarded to the SDK.
        createNativeRow: (rowOpts = {}) => {
          const applet = this.core && this.core.raw ? this.core.raw : undefined;
          const rowHandle = sdk.createNativeRow(applet ? { ...rowOpts, applet } : rowOpts);
          ctx.registerDisposable(() => { try { rowHandle.destroy(); } catch { /* ignore */ } });
          return rowHandle;
        },
        // GeoGebra's own theme tokens (colors/font) so plugins can match the host.
        theme: () => (sdk.readGgbTheme ? sdk.readGgbTheme() : null),
      };
      ctx = new sdk.PluginContext({
        core: this.core,
        manifest,
        storage: this.makeStorage(manifest.id),
        host: this.host,
        net: this.makeNet(manifest.id, manifest),
        runtime: this.getRuntime(),
        ui,
      });
      const instance = instantiatePlugin(def, ctx);
      record.instance = instance;
      record.ctx = ctx;
      await this._lifecycle(instance, 'onLoad', ctx);
      if (record.enabled) await this._lifecycle(instance, 'onEnable', ctx);
      this.log('ok', `plugin loaded: ${manifest.id}${record.enabled ? ' (enabled)' : ''}`);
    } catch (err) {
      record.error = String(err && err.message ? err.message : err);
      this.log('error', `plugin failed: ${manifest.id} — ${record.error}`);
    }
    this.loaded.set(manifest.id, record);
    return record;
  }

  /**
   * Load many descriptors. Builtin plugins first, then the rest.
   * @param {Array} descriptors
   */
  async loadAll(descriptors) {
    const ordered = [...descriptors].sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
    for (const d of ordered) {
      // eslint-disable-next-line no-await-in-loop
      await this.loadOne(d);
    }
    return this.list();
  }

  /** Enable a loaded-but-disabled plugin (runs onEnable). */
  async enable(id) {
    const r = this.loaded.get(id);
    if (!r || r.enabled || r.error) return r;
    await this._lifecycle(r.instance, 'onEnable', r.ctx);
    r.enabled = true;
    this.log('ok', `enabled: ${id}`);
    return r;
  }

  /** Disable an enabled plugin (runs onDisable + disposables). */
  async disable(id) {
    const r = this.loaded.get(id);
    if (!r || !r.enabled) return r;
    if (r.builtin) { this.log('warn', `refusing to disable builtin: ${id}`); return r; }
    try {
      await this._lifecycle(r.instance, 'onDisable', r.ctx);
    } catch (err) {
      // Watchdog tripped: the hook hung, so runLifecycle's own finally (which
      // runs the disposables) never executed — run them here so the plugin's
      // UI is still torn down.
      this.log('error', `onDisable watchdog: ${id} — ${err && err.message}`);
      try { r.ctx.runDisposables(); } catch { /* ignore */ }
    }
    r.enabled = false;
    this.log('ok', `disabled: ${id}`);
    return r;
  }

  /** Invoke a plugin's onOpenSettings() (the panel's "设置" bridge). */
  async openSettings(id) {
    const r = this.loaded.get(id);
    if (!r || !r.instance) throw new Error(`plugin not loaded: ${id}`);
    if (!this.hasSettings(id)) { this.log('warn', `${id} has no settings UI`); return false; }
    await r.instance.onOpenSettings.call(r.instance, r.ctx);
    return true;
  }

  /**
   * Whether a plugin actually IMPLEMENTS a settings UI. The SDK's base Plugin
   * class provides a no-op onOpenSettings, so a plain `typeof === 'function'`
   * check is always true. We instead require the method to be OVERRIDDEN — i.e.
   * different from the base class's implementation.
   */
  hasSettings(id) {
    const r = this.loaded.get(id);
    if (!r || !r.instance) return false;
    const fn = r.instance.onOpenSettings;
    if (typeof fn !== 'function') return false;
    const baseFn = this.sdk.Plugin && this.sdk.Plugin.prototype && this.sdk.Plugin.prototype.onOpenSettings;
    return fn !== baseFn;
  }

  /** Serializable list for the panel UI. */
  list() {
    return [...this.loaded.values()].map((r) => ({
      id: r.manifest.id,
      name: r.manifest.name,
      version: r.manifest.version,
      author: r.manifest.author,
      description: r.manifest.description,
      icon: r.manifest.icon || null,
      enabled: r.enabled,
      builtin: r.builtin,
      hasSettings: this.hasSettings(r.manifest.id),
      error: r.error,
    }));
  }
}

export default PluginLoader;
