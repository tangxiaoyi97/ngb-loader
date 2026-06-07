/**
 * mount.js — panel bootstrap (Main World entry point)
 * ===================================================
 * This module is bundled by esbuild into a single IIFE (`panel.bundle.js`) and
 * evaluated inside GeoGebra's page by our preload. It runs in the page's main
 * world, so it can see `window.ggbApplet` and `window.ggbExtendHost`.
 *
 * Responsibilities:
 *   - Create a single host <div> with a CLOSED Shadow DOM so GeoGebra's CSS can
 *     never leak into our panel and vice-versa.
 *   - Mount the Svelte <App/> inside the shadow root.
 *   - Install the Right-Shift hotkey (with debounce) to toggle visibility.
 *   - Provide the panel a small, safe host API object.
 *
 * Idempotent: re-evaluating the bundle won't create duplicate hosts.
 */

import App from './App.svelte';
import { KEY } from './lib/store.js';

const HOST_ID = 'ggb-extend-host-root';
const GLOBAL_FLAG = '__ggbExtendPanelMounted__';

function makeHostApi() {
  // Wrap the preload bridge with graceful fallbacks so the panel also works in a
  // plain-browser preview (no Electron) using mock data.
  const host = (typeof window !== 'undefined' && window.ggbExtendHost) || null;
  const mock = !host;
  const mockState = {
    plugins: [
      { id: 'hello-plugin', name: 'Hello Plugin', version: '0.1.0', author: 'GGB-Extend', description: 'A friendly demo plugin that drops a point on the canvas.', enabled: true },
      { id: 'grid-tools', name: 'Grid Tools', version: '0.2.1', author: 'community', description: 'Snapping & custom grid helpers.', enabled: false },
    ],
    settings: { opacity: 0.92, hotkey: 'RightShift', theme: 'dark' },
  };

  return {
    isMock: mock,
    async getPlugins() {
      if (host) return host.getPlugins();
      return { ok: true, plugins: mockState.plugins, root: '(mock)/GGB_Plugins' };
    },
    async togglePlugin(id, enabled) {
      if (host) return host.togglePlugin(id, enabled);
      const p = mockState.plugins.find((x) => x.id === id);
      if (p) p.enabled = enabled;
      return { ok: true, id, enabled };
    },
    async openPluginFolder() {
      if (host) return host.openPluginFolder();
      console.log('[GGB-Extend] (mock) open plugin folder');
      return { ok: true, path: '(mock)' };
    },
    async getSettings() {
      if (host) return host.getSettings();
      return { ok: true, settings: mockState.settings };
    },
    async setSettings(s) {
      if (host) return host.setSettings(s);
      Object.assign(mockState.settings, s);
      return { ok: true, settings: mockState.settings };
    },
    getApplet() {
      return (typeof window !== 'undefined' && window.ggbApplet) || null;
    },
  };
}

function createHost() {
  if (typeof document === 'undefined') return null;
  if (window[GLOBAL_FLAG]) return window[GLOBAL_FLAG];

  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  // Keep the host itself invisible to layout; the panel positions itself.
  hostEl.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  document.documentElement.appendChild(hostEl);

  // CLOSED shadow root — strongest isolation. We keep the handle in closure.
  const shadow = hostEl.attachShadow({ mode: 'closed' });

  const mountPoint = document.createElement('div');
  mountPoint.style.cssText = 'pointer-events: none;';
  shadow.appendChild(mountPoint);

  const hostApi = makeHostApi();

  const app = new App({
    target: mountPoint,
    props: { hostApi },
  });

  const controller = { hostEl, shadow, app, hostApi, visible: false };
  window[GLOBAL_FLAG] = controller;
  return controller;
}

/* ------------------------- Right-Shift hotkey ------------------------- */

function installHotkey(controller) {
  if (!controller) return;
  let lastToggle = 0;
  const DEBOUNCE_MS = 250;

  const onKeyDown = (event) => {
    // Precise Right-Shift detection per spec.
    const isRightShift =
      event.key === 'Shift' &&
      event.location === (typeof KeyboardEvent !== 'undefined'
        ? KeyboardEvent.DOM_KEY_LOCATION_RIGHT
        : 2);
    if (!isRightShift) return;

    const now = Date.now();
    if (now - lastToggle < DEBOUNCE_MS) return; // debounce repeats / chatter
    lastToggle = now;

    controller.visible = !controller.visible;
    controller.app.$set({ open: controller.visible });
    // Let the panel capture pointer events only when open.
    controller.hostEl.style.pointerEvents = controller.visible ? 'auto' : 'none';
  };

  // Capture phase on document so we win even if the page stops propagation.
  document.addEventListener('keydown', onKeyDown, true);

  // Also expose a programmatic toggle for tests / menu integration.
  window.__ggbExtendToggle__ = () => onKeyDown({ key: 'Shift', location: 2 });
}

/* ------------------------------- run ------------------------------- */

(function bootstrap() {
  try {
    const controller = createHost();
    installHotkey(controller);
    // Signal readiness (used by E2E smoke test).
    if (typeof window !== 'undefined') {
      window.__ggbExtendReady__ = true;
      document.dispatchEvent(new CustomEvent('ggb-extend:ready', { detail: { key: KEY } }));
    }
    // eslint-disable-next-line no-console
    console.log('[GGB-Extend] panel mounted (closed shadow DOM). Press Right-Shift to toggle.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[GGB-Extend] panel bootstrap failed:', err);
  }
})();
