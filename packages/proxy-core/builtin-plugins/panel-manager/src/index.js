// Built-in plugin that provides the Right-Shift plugin panel.
import { Plugin } from '@neogebra/sdk';
import App from './Panel.svelte';

const HOST_ID = 'ggb-extend-host-root';
const DEBOUNCE_MS = 250;

export default class PanelManager extends Plugin {
  async onEnable(ctx) {
    if (typeof document === 'undefined') return;
    this._mount(ctx);
    this._installHotkey(ctx);
    // signal readiness for E2E / diagnostics
    try {
      window.__ggbExtendReady__ = true;
      document.dispatchEvent(new CustomEvent('ggb-extend:ready'));
    } catch { /* noop */ }
    ctx.log.info('panel mounted (closed shadow DOM). Press Right-Shift to toggle.');
  }

  async onDisable(ctx) {
    // builtin won't normally be disabled, but clean up just in case.
    if (this._teardownHotkey) this._teardownHotkey();
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
    const runtime = (typeof window !== 'undefined' && window.__ggbExtendRuntime__) || makeMockRuntime();

    const app = new App({
      target: mountPoint,
      props: { runtime, open: false, theme: detectTheme(), requestClose: () => this._controller.close() },
    });
    // Re-detect theme when the panel opens (GeoGebra theme may have changed).
    this._refreshTheme = () => { try { app.$set({ theme: detectTheme() }); } catch (e) { /* noop */ } };
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
    // expose for tests / programmatic toggle
    window.__ggbExtendToggle__ = () => this._controller.toggle();
    window.__ggbExtendPanel__ = this._controller;
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

  _installHotkey() {
    let last = 0;
    const onKeyDown = (event) => {
      const isRightShift = event.key === 'Shift'
        && event.location === (typeof KeyboardEvent !== 'undefined' ? KeyboardEvent.DOM_KEY_LOCATION_RIGHT : 2);
      if (!isRightShift) return;
      const now = Date.now();
      if (now - last < DEBOUNCE_MS) return;
      last = now;
      this._controller.toggle();
    };
    document.addEventListener('keydown', onKeyDown, true);
    this._teardownHotkey = () => document.removeEventListener('keydown', onKeyDown, true);
  }
}

/**
 * Detect GeoGebra's current theme (light/dark) by sampling the page background
 * luminance. GeoGebra doesn't expose a theme flag, so we read the computed body
 * background; dark themes have low luminance. Returns 'light' | 'dark'.
 */
function detectTheme() {
  try {
    const probe = document.body || document.documentElement;
    const bg = getComputedStyle(probe).backgroundColor || 'rgb(255,255,255)';
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s));
      // transparent background → assume light (GeoGebra default canvas is white)
      if (a === 0) return 'light';
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum < 0.5 ? 'dark' : 'light';
    }
  } catch (e) { /* noop */ }
  return 'light';
}

// expose for other plugins (e.g. ggb-hello) to match the theme
if (typeof window !== 'undefined') window.__ggbExtendTheme__ = detectTheme;

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
