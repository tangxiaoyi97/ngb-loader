// Built-in plugin that provides the Right-Shift plugin panel.
import { Plugin, themeTokens, onThemeChange, detectThemeMode, makeT } from '@neogebra/sdk';
import App from './Panel.svelte';

// Panel UI strings (P3-5: follow the host language).
const PANEL_DICTS = {
  en: {
    sub: 'Plugins',
    tabPlugins: 'Plugins',
    tabAbout: 'About',
    countOne: '1 plugin',
    countMany: '{0} plugins',
    refresh: 'Refresh',
    adaptNote: "This GeoGebra version isn't fully adapted yet — in-view integrations are disabled to keep GeoGebra untouched.",
    emptyTitle: 'No plugins yet.',
    emptyHint: 'Add them in the Neogebra manager.',
    badgeNew: 'new',
    badgeBuiltin: 'built-in',
    enable: 'Enable',
    disable: 'Disable',
    pendingRestart: 'Enabled — takes effect after GeoGebra restarts.',
    openSettings: 'Open settings',
    noSettings: 'No settings',
    back: '‹ Plugins',
    hintShift: 'Right-Shift to toggle',
    hintCtrl: 'Triple-press Ctrl to toggle',
    gestureTitle: 'Panel gesture',
    gestureRightShift: 'Right-Shift',
    gestureTripleCtrl: 'Press Ctrl three times quickly',
    gestureNote: 'At least one gesture always stays on, so the panel can be opened.',
    aboutDesc: "A lightweight, non-invasive plugin framework for GeoGebra. It boots through a proxy layer and never modifies GeoGebra's own files in place.",
    netTitle: 'Network access',
    netApproved: 'Allowed',
    netBlocked: 'Blocked',
    netNotAsked: 'Not requested yet',
    netRevoke: 'Revoke',
    netNote: 'Hosts come from the plugin manifest. Decisions apply to THIS GeoGebra only; after revoking, the plugin will ask again on next access.',
  },
  'zh-CN': {
    sub: '插件',
    tabPlugins: '插件',
    tabAbout: '关于',
    countOne: '1 个插件',
    countMany: '{0} 个插件',
    refresh: '刷新',
    adaptNote: '当前 GeoGebra 版本尚未完全适配——内嵌集成已停用，以保持 GeoGebra 原样。',
    emptyTitle: '还没有插件。',
    emptyHint: '请在 Neogebra 管理器中添加。',
    badgeNew: '新',
    badgeBuiltin: '内置',
    enable: '启用',
    disable: '停用',
    pendingRestart: '已启用——重启 GeoGebra 后生效。',
    openSettings: '打开设置',
    noSettings: '无设置项',
    back: '‹ 插件',
    hintShift: '按右 Shift 唤出',
    hintCtrl: '连按三次 Ctrl 唤出',
    gestureTitle: '唤出手势',
    gestureRightShift: '右 Shift',
    gestureTripleCtrl: '快速连按三次 Ctrl',
    gestureNote: '至少保留一种手势开启，确保面板始终可以唤出。',
    aboutDesc: '一个轻量、非侵入的 GeoGebra 插件框架。它通过代理层启动，绝不就地修改 GeoGebra 自身文件。',
    netTitle: '网络权限',
    netApproved: '已允许',
    netBlocked: '已拒绝',
    netNotAsked: '尚未请求',
    netRevoke: '撤销',
    netNote: '域名来自插件 manifest 声明。决定仅对当前 GeoGebra 生效；撤销后插件下次访问会重新询问。',
  },
};

// Test-build gating (esbuild define): E2E hooks exist ONLY in test builds. The
// `typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__` expression
// must appear INLINE at each site (no intermediate const) so esbuild can
// constant-fold and dead-code-eliminate the hook blocks in production builds.

// Session-random, neutral host id (clean namespace — no framework branding in
// the live DOM). Module-scoped so a remount in the same session finds it.
const HOST_ID = `h${Math.random().toString(36).slice(2, 10)}`;
const DEBOUNCE_MS = 250;

export default class PanelManager extends Plugin {
  async onEnable(ctx) {
    if (typeof document === 'undefined') return;
    // P3-3: configurable summon gestures (persisted via ctx.storage). Defaults:
    // both Right-Shift AND triple-Ctrl active, so compact keyboards without a
    // right Shift still have a way in. The UI refuses to turn both off.
    this._gestures = {
      rightShift: ctx.storage.get('gesture.rightShift', true) !== false,
      tripleCtrl: ctx.storage.get('gesture.tripleCtrl', true) !== false,
    };
    this._mount(ctx);
    this._installHotkey(ctx);
    // P3-1: follow host theme switches live (not just on open).
    this._unsubTheme = onThemeChange((mode) => {
      try { this._app && this._app.$set({ theme: mode, hostFont: themeTokens(mode).fontFamily }); } catch { /* noop */ }
    });
    // eslint-disable-next-line no-undef
    if (typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__) {
      // E2E readiness signals — stripped from production builds.
      try {
        window.__ggbExtendReady__ = true;
        window.__ggbExtendPanelHost__ = this._host;
        document.dispatchEvent(new CustomEvent('ggb-extend:ready'));
      } catch { /* noop */ }
    }
    ctx.log.info('panel mounted (closed shadow DOM). Press Right-Shift to toggle.');
  }

  async onDisable(ctx) {
    // builtin won't normally be disabled, but clean up just in case.
    if (this._teardownHotkey) this._teardownHotkey();
    if (this._unsubTheme) { this._unsubTheme(); this._unsubTheme = null; }
    if (this._host && this._host.remove) this._host.remove();
    this._app = null; this._host = null;
  }

  /** The panel's own settings = a quick "about" toggle (demonstrates the bridge). */
  async onOpenSettings() {
    if (this._controller) { this._controller.open(); this._app.$set({ open: true, view: 'settings' }); }
  }

  _mount(ctx) {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    document.documentElement.appendChild(hostEl);
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const mountPoint = document.createElement('div');
    shadow.appendChild(mountPoint);

    // Runtime API the panel talks to (list plugins / toggle / open settings).
    // Provided by the loader via ctx (no window global — clean namespace);
    // the mock keeps plain-browser previews working.
    const runtime = (ctx && ctx.runtime) || makeMockRuntime();

    const t = makeT(PANEL_DICTS);
    const tokens = themeTokens();
    const app = new App({
      target: mountPoint,
      props: {
        runtime,
        open: false,
        theme: tokens.mode,
        hostFont: tokens.fontFamily, // P3-2: panel uses GeoGebra's font
        t,                           // P3-5: host-language strings
        gestures: { ...this._gestures },
        onGesturesChange: (g) => this._setGestures(ctx, g),
        requestClose: () => this._controller.close(),
      },
    });
    // Re-detect theme when the panel opens (GeoGebra theme may have changed).
    this._refreshTheme = () => { try { app.$set({ theme: detectThemeMode() }); } catch (e) { /* noop */ } };
    this._host = hostEl;
    this._shadow = shadow;
    this._app = app;
    this._visible = false;
    this._controller = {
      open: () => {
        this._visible = true;
        hostEl.style.pointerEvents = 'auto';
        if (this._refreshTheme) this._refreshTheme();
        app.$set({ open: true });
      },
      close: () => {
        this._visible = false;
        // Stop intercepting pointer events immediately (don't wait for the
        // close transition) so GeoGebra is interactive again right away.
        hostEl.style.pointerEvents = 'none';
        app.$set({ open: false });
        // CRITICAL: when the panel closes, focus may still be trapped on a
        // button/tab inside the (closed) shadow DOM. If we don't release it,
        // GeoGebra's canvas won't receive keyboard/pointer input until the user
        // clicks or presses a key again — the reported bug. Blur the trapped
        // element and hand focus back to the GeoGebra document.
        this._releaseFocus();
      },
      toggle: () => (this._visible ? this._controller.close() : this._controller.open()),
    };
    // eslint-disable-next-line no-undef
    if (typeof __NGB_TEST_BUILD__ !== 'undefined' && __NGB_TEST_BUILD__) {
      // expose for E2E tests / programmatic toggle — stripped from production
      window.__ggbExtendToggle__ = () => this._controller.toggle();
      window.__ggbExtendPanel__ = this._controller;
    }
  }

  /**
   * Release keyboard/pointer focus that may be trapped inside the (closed) shadow
   * DOM after the panel closes, and return it to GeoGebra so the canvas responds
   * to input immediately. Without this, the user has to click or press a key
   * again before GeoGebra reacts.
   */
  _releaseFocus() {
    try {
      // 1) Blur whatever is focused inside our shadow root. With a CLOSED shadow,
      //    document.activeElement points at the host, so reach in via the stored
      //    shadow root to find and blur the real inner active element.
      const inner = this._shadow && this._shadow.activeElement;
      if (inner && typeof inner.blur === 'function') inner.blur();
      // The host itself may be the document's activeElement — blur it too.
      const ae = document.activeElement;
      if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();

      // 2) Hand focus back to GeoGebra. It listens on its canvas/applet; focus
      //    that if we can find it, otherwise fall back to body. Use
      //    preventScroll so the page doesn't jump.
      const ggb = document.querySelector(
        'canvas, .EuclidianPanel canvas, [id^="ggbApplet"] canvas, #ggbApplet, .applet_scaler',
      );
      const tgt = ggb || document.body;
      if (tgt && typeof tgt.focus === 'function') tgt.focus({ preventScroll: true });
    } catch (e) { /* best-effort */ }
  }

  /** Persist + apply a gesture config change (from the panel's About view). */
  _setGestures(ctx, g) {
    // Never allow BOTH gestures off — the panel must stay reachable.
    const next = {
      rightShift: !!g.rightShift,
      tripleCtrl: !!g.tripleCtrl,
    };
    if (!next.rightShift && !next.tripleCtrl) next.rightShift = true;
    this._gestures = next;
    try {
      ctx.storage.set('gesture.rightShift', next.rightShift);
      ctx.storage.set('gesture.tripleCtrl', next.tripleCtrl);
    } catch { /* preview without storage */ }
    try { this._app.$set({ gestures: { ...next } }); } catch { /* noop */ }
  }

  _installHotkey() {
    let last = 0;
    let ctrlPresses = [];
    const toggle = () => {
      const now = Date.now();
      if (now - last < DEBOUNCE_MS) return;
      last = now;
      this._controller.toggle();
    };
    const onKeyDown = (event) => {
      // P3-4: Esc closes the open panel (focus is handed back by close()).
      if (event.key === 'Escape' && this._visible) {
        event.preventDefault();
        event.stopPropagation();
        this._controller.close();
        return;
      }
      const g = this._gestures || { rightShift: true, tripleCtrl: true };
      // Primary gesture: Right-Shift.
      if (g.rightShift && event.key === 'Shift'
        && event.location === (typeof KeyboardEvent !== 'undefined' ? KeyboardEvent.DOM_KEY_LOCATION_RIGHT : 2)) {
        toggle();
        return;
      }
      // Backup gesture (P3-3): three Ctrl presses within 600ms, nothing between.
      if (g.tripleCtrl && event.key === 'Control') {
        const now = Date.now();
        ctrlPresses = ctrlPresses.filter((ts) => now - ts < 600);
        ctrlPresses.push(now);
        if (ctrlPresses.length >= 3) { ctrlPresses = []; toggle(); }
        return;
      }
      ctrlPresses = []; // any other key breaks the chain
    };
    document.addEventListener('keydown', onKeyDown, true);
    this._teardownHotkey = () => document.removeEventListener('keydown', onKeyDown, true);
  }
}

/** Fallback runtime for plain-browser preview (no real plugins loaded). */
function makeMockRuntime() {
  const plugins = [
    { id: 'panel-manager', name: 'Plugin Panel', version: '0.2.0', author: 'Neogebra', description: 'Built-in panel (toggle with Right-Shift).', enabled: true, builtin: true, hasSettings: true, error: null },
    { id: 'hello-plugin', name: 'Hello', version: '0.1.0', author: 'Neogebra', description: 'Example plugin that greets on startup.', enabled: true, builtin: false, hasSettings: true, error: null },
  ];
  return {
    isMock: true,
    listPlugins: () => plugins,
    enable: (id) => { const p = plugins.find((x) => x.id === id); if (p) p.enabled = true; },
    disable: (id) => { const p = plugins.find((x) => x.id === id); if (p && !p.builtin) p.enabled = false; },
    openSettings: (id) => console.log('[mock] openSettings', id),
    openPluginFolder: () => console.log('[mock] open plugin folder'),
  };
}
