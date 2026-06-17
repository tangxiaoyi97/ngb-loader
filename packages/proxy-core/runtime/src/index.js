// The bundled plugin runtime injected into GeoGebra's page. The preload replaces
// the BOOT_KEY placeholder below with a session-random key, evaluates this
// bundle, then calls window[key](opts) — so no branded global ever exists in the
// page (clean namespace), and the key is deleted right after boot is invoked.
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

// Test-build gating (esbuild define): E2E hooks (readiness flags, programmatic
// toggles) exist ONLY in test builds; production bundles carry none of them.
// NOTE: the `typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__`
// expression must appear INLINE at each site (no intermediate const) so esbuild
// can constant-fold it and dead-code-eliminate the hook blocks in production.
// The `typeof` guard keeps unbundled unit-test imports working.

// Replaced by the preload at injection time with a session-random key.
const BOOT_KEY = '@@NGB_BOOT_KEY@@';

// Quiet runtime: the framework logs NOTHING on the host console unless debug
// was explicitly enabled (preload forwards GGB_EXTEND_DEBUG via boot opts).
let DEBUG = false;

function log(level, msg) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  (console[level === 'error' ? 'error' : 'log'])('[runtime]', msg);
}

/**
 * Boot the runtime. Called by preload with Node-backed capabilities.
 * @param {object} opts
 * @param {Array}  opts.installed   [{ id, manifest, enabled }] user plugins (from IPC)
 * @param {function} opts.readSource async (id) => sourceString  (from IPC)
 * @param {object} opts.host        the preload IPC bridge
 * @param {function} [opts.persistEnabled] async (id, enabled) => void (IPC)
 * @param {boolean}  [opts.debug]   enable framework console logging
 */
async function boot(opts = {}) {
  const host = opts.host || null;
  DEBUG = !!opts.debug;
  try { sdk.setDebug(DEBUG); } catch { /* older sdk */ }

  // 1) a ready GgbCore (best-effort). We DON'T block plugin loading on it: if the
  //    applet is already present we attach immediately; otherwise we load plugins
  //    now and let GgbCore.create resolve in the background (plugins that need the
  //    applet call sdk.whenAppletReady themselves).
  let core = null;
  const appletReady = typeof window !== 'undefined' && window.ggbApplet && typeof window.ggbApplet.evalCommand === 'function';
  if (appletReady) {
    try { core = await sdk.GgbCore.create({ timeout: 1000 }); } catch { /* ignore */ }
  }

  // Pick the DOM-adapter profile for this GeoGebra version (P1-1). Unknown
  // versions keep the default profile; the self-check below is what gates
  // actual DOM integration.
  try {
    const ver = core && core.raw && typeof core.raw.getVersion === 'function' ? core.raw.getVersion() : null;
    if (sdk.selectProfile) sdk.selectProfile(ver);
  } catch { /* keep default profile */ }

  // 2) per-plugin PERSISTENT storage, backed by the host bridge's settings IPC
  //    (state.json `settings[pluginId]`), namespaced by plugin id with a
  //    write-through memory cache. Namespaces are obfuscated at rest so API keys
  //    and other secrets never appear under readable key names in state.json.
  //    Loaded ONCE here; HostStorage serializes its own writes.
  let settingsSnapshot = {};
  const canPersist = !!(host && typeof host.getSettings === 'function' && typeof host.setSettings === 'function');
  if (canPersist) {
    try {
      const r = await host.getSettings();
      if (r && r.ok && r.settings && typeof r.settings === 'object') settingsSnapshot = r.settings;
    } catch (err) { log('error', `get-settings failed: ${err && err.message}`); }
  }
  const makeStorage = (pluginId) => {
    if (!canPersist) return new sdk.MemoryStorage();
    return new sdk.HostStorage({
      initial: sdk.decodeNamespace(settingsSnapshot[pluginId], pluginId),
      persist: async (obj) => {
        const res = await host.setSettings({ [pluginId]: sdk.encodeNamespace(obj, pluginId) });
        if (!res || !res.ok) throw new Error('set-settings rejected');
      },
    });
  };

  // 2b) scoped network access. Each plugin gets ctx.net.fetch bound to its own id.
  // The host enforces the security policy (manifest-declared host + user approval
  // + SSRF block); here we just surface a clean API and, on first use of a host,
  // ask the user to approve, then retry.
  // Each plugin's net.fetch closes over ITS OWN capability token (P2-2): the
  // host verifies (sender, pluginId, token) together, so a plugin (or any page
  // code reaching the bridge) cannot borrow another plugin's approved hosts by
  // self-reporting a different pluginId.
  const netTokens = (opts.netTokens && typeof opts.netTokens === 'object') ? opts.netTokens : {};
  const makeNet = (pluginId, manifest) => {
    if (!host || typeof host.netFetch !== 'function') return null;
    const token = netTokens[pluginId];
    const fetch = async (url, fetchOpts = {}) => {
      const request = { pluginId, token, url, method: fetchOpts.method, headers: fetchOpts.headers, body: fetchOpts.body, bodyBase64: fetchOpts.bodyBase64, timeoutMs: fetchOpts.timeoutMs };
      let res = await host.netFetch(request);
      if (res && res.needsApproval && typeof host.netApprove === 'function') {
        const allow = await confirmNetAccess(manifest, res.host);
        await host.netApprove(pluginId, res.host, allow, token);
        if (!allow) return { ok: false, status: 0, error: `User denied network access to ${res.host}` };
        res = await host.netFetch(request); // retry once after approval
      }
      return res;
    };
    return { fetch };
  };

  // Runtime API object. Created EARLY so plugins can read version/core during
  // their own onEnable (which runs inside loadAll below); methods are attached
  // after. Plugins receive it as ctx.runtime — it is NOT published on window
  // (clean namespace; test builds expose it for E2E only).
  const runtime = { isMock: false, version: sdk.VERSION, core };

  const loader = new PluginLoader({
    sdk, core, host, makeStorage, makeNet,
    getRuntime: () => runtime,
    onLog: (e) => log(e.level, e.msg),
  });

  // eslint-disable-next-line no-undef
  if (typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__ && typeof window !== 'undefined') {
    runtime._loader = loader;
    window.__ggbExtendRuntime__ = runtime;
  }

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
    // A plugin not ENABLED for this GeoGebra is not loaded at all: it must not
    // run (no onLoad/onEnable) AND must not appear in the in-GeoGebra panel.
    // Discovering/enabling/disabling plugins is the desktop manager's job — the
    // in-app panel only shows what's actually running and stays read-only.
    if (p.enabled !== true) { seen.add(p.id); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const source = await opts.readSource(p.id);
      descriptors.push({ id: p.id, manifest: p.manifest, source, enabled: true, builtin: false });
      seen.add(p.id);
    } catch (err) {
      log('error', `could not read source for ${p.id}: ${err && err.message}`);
    }
  }

  await loader.loadAll(descriptors);

  // 4) attach the runtime API the panel UI consumes (onto the early object).
  // The in-GeoGebra panel is READ-ONLY: it lists what is actually running and
  // opens a plugin's own settings. Enabling/disabling plugins belongs to the
  // desktop manager (takes effect on next launch), so no enable/disable here.
  Object.assign(runtime, {
    listPlugins: () => loader.list(),
    // Fresh DOM self-check (P1-2) — evaluated on demand (e.g. each panel open),
    // never cached, so it reflects the CURRENT DOM.
    domHealth: () => { try { return sdk.selfCheck(); } catch { return { ok: true }; } },
    // Network permissions for the panel: manifest-declared hosts + this GGB's
    // recorded approve/block decisions. Revoking deletes the record — the next
    // access re-prompts the user.
    netPermissions: async (id) => {
      if (!host || typeof host.netApprovals !== 'function') return { declared: [], approvals: {} };
      try {
        const r = await host.netApprovals(id);
        if (r && r.ok) return { declared: r.declared || [], approvals: r.approvals || {} };
      } catch { /* fall through */ }
      return { declared: [], approvals: {} };
    },
    revokeNetApproval: async (id, hostname) => {
      if (!host || typeof host.netRevoke !== 'function') return { ok: false };
      try { return await host.netRevoke(id, hostname); } catch { return { ok: false }; }
    },
    openSettings: (id) => loader.openSettings(id),
    openPluginFolder: () => host && host.openPluginFolder && host.openPluginFolder(),
    // Open a URL in the user's real browser (not an Electron window).
    openExternal: (url) => host && host.openExternal && host.openExternal(url),
  });
  // eslint-disable-next-line no-undef
  if (typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__ && typeof window !== 'undefined') window.__ggbExtendReady__ = true;
  log('info', `runtime ready — ${loader.list().length} plugin(s) loaded`);
  return runtime;
}

// Net-approval modal strings (P3-5: follow the host language).
const NET_MODAL_DICTS = {
  en: {
    title: 'Allow network access?',
    wants: 'The plugin {0} wants to connect to:',
    warn: 'Only allow hosts you trust. The plugin can send data to this host.',
    block: 'Block',
    allow: 'Allow',
  },
  'zh-CN': {
    title: '允许网络访问？',
    wants: '插件 {0} 想要连接：',
    warn: '只允许你信任的主机。该插件可以向此主机发送数据。',
    block: '拒绝',
    allow: '允许',
  },
};

/**
 * Ask the user to approve a plugin's network access to a host. Theme-token
 * styled modal (host font, light/dark) in a closed Shadow DOM. Keyboard
 * complete (P3-4): focus starts on Block (the safe default), Tab cycles inside
 * the dialog, Esc = Block; focus is returned to GeoGebra afterwards.
 * Resolves true (Allow) / false (Block).
 */
function confirmNetAccess(manifest, host) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const tk = sdk.themeTokens ? sdk.themeTokens() : null;
    const T = tk || { surface: '#fff', surfaceAlt: '#f4f5f9', text: '#1d1d1f', textSub: '#5b616e', border: '#e3e6ee', backdrop: 'rgba(20,22,30,.4)', primary: '#6557d3', primaryText: '#fff', shadow: '0 16px 48px rgba(0,0,0,.35)', fontFamily: "'Roboto',-apple-system,sans-serif" };
    const t = sdk.makeT ? sdk.makeT(NET_MODAL_DICTS) : (k) => NET_MODAL_DICTS.en[k] || k;

    const prevFocus = document.activeElement;
    const hostEl = document.createElement('div');
    hostEl.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    document.documentElement.appendChild(hostEl);
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const done = (v) => {
      hostEl.remove();
      // Return focus to GeoGebra so the canvas responds immediately (P3-4).
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); else if (document.body) document.body.focus({ preventScroll: true }); } catch { /* ignore */ }
      resolve(v);
    };

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;inset:0;background:${T.backdrop};display:grid;place-items:center;font-family:${T.fontFamily}`;
    const pluginLabel = `<b style="color:${T.text}">${escapeHtml(manifest.name || manifest.id)}</b>`;
    // Escape the translated sentence FIRST, then splice the (already escaped)
    // plugin label into the placeholder slot.
    const wantsHtml = escapeHtml(t('wants', '\u0001')).replace('\u0001', pluginLabel);
    wrap.innerHTML = `
      <div role="dialog" aria-modal="true" style="background:${T.surface};color:${T.text};border:1px solid ${T.border};border-radius:16px;padding:22px;width:min(420px,90vw);box-shadow:${T.shadow}">
        <h3 style="margin:0 0 10px;font-size:16px;font-weight:500">${escapeHtml(t('title'))}</h3>
        <p style="margin:0 0 6px;font-size:13px;line-height:1.55;color:${T.textSub}">
          ${wantsHtml}
        </p>
        <div style="font-size:13px;font-weight:500;background:${T.surfaceAlt};border:1px solid ${T.border};border-radius:8px;padding:8px 11px;margin:0 0 12px;word-break:break-all">${escapeHtml(host)}</div>
        <p style="margin:0 0 16px;font-size:11.5px;color:${T.textSub}">${escapeHtml(t('warn'))}</p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="nx-deny" style="appearance:none;cursor:pointer;font-size:13px;padding:8px 14px;border-radius:999px;border:1px solid ${T.border};background:${T.surface};color:${T.text};font-family:inherit">${escapeHtml(t('block'))}</button>
          <button id="nx-allow" style="appearance:none;cursor:pointer;font-size:13px;padding:8px 14px;border-radius:999px;border:none;background:${T.primary};color:${T.primaryText};font-family:inherit">${escapeHtml(t('allow'))}</button>
        </div>
      </div>`;
    shadow.appendChild(wrap);
    const denyBtn = wrap.querySelector('#nx-deny');
    const allowBtn = wrap.querySelector('#nx-allow');
    denyBtn.addEventListener('click', () => done(false));
    allowBtn.addEventListener('click', () => done(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    // Keyboard: Esc = Block (safe default); Tab is trapped between the buttons.
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const order = [denyBtn, allowBtn];
        const i = order.indexOf(shadow.activeElement);
        const next = e.shiftKey ? (i <= 0 ? order.length - 1 : i - 1) : (i >= order.length - 1 ? 0 : i + 1);
        try { order[next].focus(); } catch { /* ignore */ }
      }
    });
    // Safe default: keyboard focus starts on Block.
    try { denyBtn.focus(); } catch { /* ignore */ }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Expose boot for the preload to call, under the injection-time random key.
// If the placeholder was not replaced (direct evaluation outside the preload),
// the placeholder string itself is the key — still nothing branded on window.
if (typeof window !== 'undefined') {
  window[BOOT_KEY] = boot;
}

export { boot, sdk, PluginLoader };
