// The bundled plugin runtime injected into GeoGebra's page; preload calls window.__ggbExtendBoot__.
import * as sdk from '@neogebra/sdk';
import { PluginLoader } from './loader.js';
// The builtin panel-manager plugin, imported as SOURCE text so the loader
// evaluates it through the exact same path as user plugins (dog-fooding).
// esbuild's `text` loader turns these into strings at build time.
import panelManifest from '../../builtin-plugins/panel-manager/manifest.json';
import panelSourceBundled from '../../builtin-plugins/panel-manager/dist/index.bundle.js';
// The panel icon, inlined as a data: URI at build time (esbuild 'dataurl'
// loader). The relative "icon.png" in the manifest can't be loaded from the
// GeoGebra page, so we override it with this.
import panelIconDataUri from '../../builtin-plugins/panel-manager/icon.png';

const TAG = '[GGB-Extend/runtime]';

function log(host, level, msg) {
  // eslint-disable-next-line no-console
  (console[level === 'error' ? 'error' : 'log'])(TAG, msg);
}

/**
 * Boot the runtime. Called by preload with Node-backed capabilities.
 * @param {object} opts
 * @param {Array}  opts.installed   [{ id, manifest, enabled }] user plugins (from IPC)
 * @param {function} opts.readSource async (id) => sourceString  (from IPC)
 * @param {object} opts.host        the preload bridge (window.ggbExtendHost)
 * @param {function} [opts.persistEnabled] async (id, enabled) => void (IPC)
 */
async function boot(opts = {}) {
  const host = opts.host || (typeof window !== 'undefined' ? window.ggbExtendHost : null);

  // 1) a ready GgbCore (best-effort). We DON'T block plugin loading on it: if the
  //    applet is already present we attach immediately; otherwise we load plugins
  //    now and let GgbCore.create resolve in the background (plugins that need the
  //    applet call sdk.whenAppletReady themselves).
  let core = null;
  const appletReady = typeof window !== 'undefined' && window.ggbApplet && typeof window.ggbApplet.evalCommand === 'function';
  if (appletReady) {
    try { core = await sdk.GgbCore.create({ timeout: 1000 }); } catch { /* ignore */ }
  }

  // 2) per-plugin storage backed by the host bridge settings, namespaced by id.
  const makeStorage = (pluginId) => {
    const mem = new sdk.MemoryStorage();
    return mem; // v0.2: in-memory; persistence can be layered via host later
  };

  const loader = new PluginLoader({
    sdk, core, host, makeStorage,
    onLog: (e) => log(host, e.level, e.msg),
  });

  // Publish a minimal runtime EARLY so plugins can read version/core during their
  // own onEnable (which runs inside loadAll below). Methods are attached after.
  const runtime = { isMock: false, version: sdk.VERSION, core, _loader: loader };
  window.__ggbExtendRuntime__ = runtime;

  // 3) assemble descriptors: builtin panel FIRST, then enabled user plugins.
  const descriptors = [{
    id: panelManifest.id,
    manifest: { ...panelManifest, icon: panelIconDataUri || panelManifest.icon },
    source: panelSourceBundled,
    enabled: true,
    builtin: true,
  }];

  // Track ids already present (the builtin panel) so a same-id DISK copy (the
  // desktop app seeds panel-manager onto disk so it shows in its list) is NOT
  // loaded twice — the bundled builtin wins.
  const seen = new Set(descriptors.map((d) => d.id));
  for (const p of (opts.installed || [])) {
    if (seen.has(p.id)) continue; // skip duplicate (e.g. seeded panel-manager)
    // A plugin DISABLED for this GeoGebra is not loaded at all: it must not run
    // (no onLoad/onEnable), must not appear in the panel list, and must not show
    // a detail/settings entry. Re-enabling takes effect on next GeoGebra launch.
    if (p.enabled === false) { seen.add(p.id); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const source = await opts.readSource(p.id);
      descriptors.push({ id: p.id, manifest: p.manifest, source, enabled: true, builtin: false });
      seen.add(p.id);
    } catch (err) {
      log(host, 'error', `could not read source for ${p.id}: ${err && err.message}`);
    }
  }

  await loader.loadAll(descriptors);

  // 4) attach the full runtime API the panel UI consumes (onto the early object).
  Object.assign(runtime, {
    listPlugins: () => loader.list(),
    enable: async (id) => { await loader.enable(id); if (opts.persistEnabled) await opts.persistEnabled(id, true); },
    disable: async (id) => { await loader.disable(id); if (opts.persistEnabled) await opts.persistEnabled(id, false); },
    openSettings: (id) => loader.openSettings(id),
    openPluginFolder: () => host && host.openPluginFolder && host.openPluginFolder(),
  });
  window.__ggbExtendReady__ = true;
  log(host, 'info', `runtime ready — ${loader.list().length} plugin(s) loaded`);
  return runtime;
}

// Expose boot for the preload to call.
if (typeof window !== 'undefined') {
  window.__ggbExtendBoot__ = boot;
}

export { boot, sdk, PluginLoader };
