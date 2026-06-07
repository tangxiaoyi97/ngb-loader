// The bundled plugin runtime injected into GeoGebra's page; preload calls window.__ggbExtendBoot__.
import * as sdk from '@neogebra/sdk';
import { PluginLoader } from './loader.js';
// The builtin panel-manager plugin, imported as SOURCE text so the loader
// evaluates it through the exact same path as user plugins (dog-fooding).
// esbuild's `text` loader turns these into strings at build time.
import panelManifest from '../../builtin-plugins/panel-manager/manifest.json';
import panelSourceBundled from '../../builtin-plugins/panel-manager/dist/index.bundle.js';
// The panel icon, inlined as a data: URI at build time (esbuild 'dataurl' loader). The relative "icon.png" in the manifest can't be loaded from the
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

  // 2b) scoped network access. Each plugin gets ctx.net.fetch bound to its own id.
  // The host enforces the security policy (manifest-declared host + user approval
  // + SSRF block); here we just surface a clean API and, on first use of a host,
  // ask the user to approve, then retry.
  const makeNet = (pluginId, manifest) => {
    if (!host || typeof host.netFetch !== 'function') return null;
    const fetch = async (url, opts = {}) => {
      const request = { pluginId, url, method: opts.method, headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs };
      let res = await host.netFetch(request);
      if (res && res.needsApproval && typeof host.netApprove === 'function') {
        const allow = await confirmNetAccess(manifest, res.host);
        await host.netApprove(pluginId, res.host, allow);
        if (!allow) return { ok: false, status: 0, error: `User denied network access to ${res.host}` };
        res = await host.netFetch(request); // retry once after approval
      }
      return res;
    };
    return { fetch };
  };

  const loader = new PluginLoader({
    sdk, core, host, makeStorage, makeNet,
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

/**
 * Ask the user to approve a plugin's network access to a host. Theme-aware modal
 * in a closed Shadow DOM. Resolves true (Allow) / false (Block).
 */
function confirmNetAccess(manifest, host) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const theme = (typeof window !== 'undefined' && typeof window.__ggbExtendTheme__ === 'function')
      ? window.__ggbExtendTheme__() : 'light';
    const dark = theme === 'dark';
    const bg = dark ? '#2b2d31' : '#fff';
    const fg = dark ? '#ececf0' : '#1d1d1f';
    const sub = dark ? '#b7bcc7' : '#5b616e';
    const border = dark ? 'rgba(255,255,255,.12)' : '#e3e6ee';

    const hostEl = document.createElement('div');
    hostEl.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    document.documentElement.appendChild(hostEl);
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const done = (v) => { hostEl.remove(); resolve(v); };

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;inset:0;background:rgba(20,22,30,.4);display:grid;place-items:center;font-family:'Roboto',-apple-system,sans-serif`;
    wrap.innerHTML = `
      <div style="background:${bg};color:${fg};border:1px solid ${border};border-radius:16px;padding:22px;width:min(420px,90vw);box-shadow:0 16px 48px rgba(0,0,0,.35)">
        <h3 style="margin:0 0 10px;font-size:16px;font-weight:500">Allow network access?</h3>
        <p style="margin:0 0 6px;font-size:13px;line-height:1.55;color:${sub}">
          The plugin <b style="color:${fg}">${escapeHtml(manifest.name || manifest.id)}</b> wants to connect to:
        </p>
        <div style="font-size:13px;font-weight:500;background:${dark ? 'rgba(255,255,255,.06)' : '#f4f5f9'};border:1px solid ${border};border-radius:8px;padding:8px 11px;margin:0 0 12px;word-break:break-all">${escapeHtml(host)}</div>
        <p style="margin:0 0 16px;font-size:11.5px;color:${sub}">Only allow hosts you trust. The plugin can send data to this host.</p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="nx-deny" style="appearance:none;cursor:pointer;font-size:13px;padding:8px 14px;border-radius:999px;border:1px solid ${border};background:${bg};color:${fg};font-family:inherit">Block</button>
          <button id="nx-allow" style="appearance:none;cursor:pointer;font-size:13px;padding:8px 14px;border-radius:999px;border:none;background:#6557d3;color:#fff;font-family:inherit">Allow</button>
        </div>
      </div>`;
    shadow.appendChild(wrap);
    wrap.querySelector('#nx-allow').addEventListener('click', () => done(true));
    wrap.querySelector('#nx-deny').addEventListener('click', () => done(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Expose boot for the preload to call.
if (typeof window !== 'undefined') {
  window.__ggbExtendBoot__ = boot;
}

export { boot, sdk, PluginLoader };
