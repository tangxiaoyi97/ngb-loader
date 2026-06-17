// Create a container that lives INSIDE GeoGebra's algebra list as if it were one
// of the user's own object rows. The framework "hijacks" a real GeoGebra object
// row: it asks GeoGebra to create an object (so GeoGebra lays out a native row),
// then takes over that row's content area and hands it to a plugin.
//
// Why this works (verified against GeoGebra Classic 6's live DOM):
//   - evalCommand("<name>=1") makes GeoGebra render a native row:
//       div.avItem > div.elem
//         ├─ div.marblePanel            (color dot)
//         ├─ div.elemText               ← the content area we take over
//         └─ div.algebraViewObjectStylebar (the ⋯ menu)
//     (We use a NUMBER, not a boolean: a boolean adds a clickable checkbox that
//     stays interactive and toggles on click; a number row has no controls.)
//   - Hijacked number rows survive clicks AND redraws (verified): clearing
//     `.elemText` does not make GeoGebra rebuild the row, so the takeover is
//     stable and does NOT flicker.
//   - We still keep a lightweight observer: if GeoGebra rebuilds the whole tree
//     (e.g. perspective switch) and our marked node falls out of the DOM, we
//     re-hijack ONCE. We key off our own data-attr + node reference, never text.
//   - The object stays a real GeoGebra object: delete/undo keep working. We
//     reroute GeoGebra's own remove event back to the plugin so cleanup is sync.
//
// This module is generic. It knows nothing about any specific plugin.
//
// P1: all GeoGebra selectors/metrics/locators come from the ggb-dom-adapter
// (version-profiled, runtime-measured); DOM watching goes through the shared
// observer; and degradation is graceful — if GeoGebra's anatomy doesn't match
// the profile, NO row is rendered and the helper object is removed (a missing
// feature, never a misplaced skeleton).

import {
  sel, metrics as adapterMetrics, findAlgebraView, findRowByName, selfCheck,
} from './ggb-dom-adapter.js';
import { subscribeDom } from './shared-observer.js';

// Session-random, neutral markers (clean namespace): no framework branding in
// the live DOM or in GeoGebra object names, and no stable strings another
// script (or a curious user) could key off. Regenerated each page load; all
// internal lookups go through these constants. Exported via __internals for
// unit tests only.
const SESSION_TOKEN = `x${Math.random().toString(36).slice(2, 8)}`;
const CONTAINER_ATTR = `data-${SESSION_TOKEN}c`;   // marks the content node we own
const ROW_ATTR = `data-${SESSION_TOKEN}r`;         // marks the .avItem row we own
const MARBLE_ATTR = `data-${SESSION_TOKEN}m`;      // marks the marble host we own
// Helper-object name prefix: neutral + random (GeoGebra labels must start with
// a letter). These objects never reach saved files (see helper registry below).
const NAME_PREFIX = `u${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 4) || 'q'}`;
// Neutral keys for expando properties we must hang on GeoGebra's own nodes.
const SWALLOW_KEY = `__${SESSION_TOKEN}s`;

// Layout metrics come from the adapter (profile constants, overlaid with live
// measurements when a real row is available). Only presentation constants that
// are OURS (not GeoGebra's) stay here.
const FILLED_ALPHA = 0.4;      // "visible/ON" ball: object colour at 40%
const BALL_OFF_FILL = '#ffffff';        // "OFF" ball fill (outline look)
const DEFAULT_MARBLE_COLOR = 'rgb(101,87,210)'; // fallback when no theme primary

// Theme fallbacks used when GeoGebra's stylesheet isn't present (e.g. headless).
const THEME_FALLBACK = {
  primary: '#6557D2', primaryVariant: '#F3F0FF', dark: '#5145A8',
  light: '#F3F0FF', selection: 'rgba(101,87,210,0.2)',
  text: 'rgb(28,28,31)', fontFamily: 'geogebra-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif',
};

function getApplet(opts) {
  if (opts && opts.applet) return opts.applet;
  if (typeof window !== 'undefined' && window.ggbApplet) return window.ggbApplet;
  return null;
}

// ---------------------------------------------------------------------------
// Helper-object registry + save-path hook (portable documents).
//
// Our native rows are backed by REAL GeoGebra objects, which would otherwise be
// serialized into .ggb files the user saves and shares — leaking framework
// artifacts into documents opened on machines without the framework. To keep
// saved files indistinguishable from stock, we hook the applet's export
// methods (getBase64 / getXML / getFileJSON): before serialization all helper
// objects are deleted, after it they are recreated, and each row re-hijacks
// its rebuilt DOM via its existing observer. Row remove-listeners consult
// `isHelperSuspended` so the save-time deletion is NOT treated as the user
// deleting the row.
const SAVE_HOOK_METHODS = ['getBase64', 'getXML', 'getFileJSON'];
const RESTORE_SAFETY_MS = 5000;
const appletHelpers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

function helperReg(applet) {
  if (!appletHelpers || !applet) return null;
  let reg = appletHelpers.get(applet);
  if (!reg) {
    reg = { names: new Set(), suspended: false };
    appletHelpers.set(applet, reg);
    installSaveHook(applet, reg);
  }
  return reg;
}

function registerHelperObject(applet, name) {
  const reg = helperReg(applet);
  if (reg) reg.names.add(name);
}

function unregisterHelperObject(applet, name) {
  const reg = appletHelpers && applet ? appletHelpers.get(applet) : null;
  if (reg) reg.names.delete(name);
}

/** True while a save-time delete/recreate cycle is in flight for this object. */
export function isHelperSuspended(applet, name) {
  const reg = appletHelpers && applet ? appletHelpers.get(applet) : null;
  return !!(reg && reg.suspended && reg.names.has(name));
}

function recreateHelper(applet, name) {
  try {
    if (applet.evalCommand(`${name}=1`)) {
      try { applet.setVisible && applet.setVisible(name, false); } catch { /* ignore */ }
      try { applet.setAuxiliary && applet.setAuxiliary(name, false); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function installSaveHook(applet, reg) {
  for (const method of SAVE_HOOK_METHODS) {
    const orig = applet[method];
    if (typeof orig !== 'function') continue;
    // eslint-disable-next-line no-loop-func
    applet[method] = function sanitizedExport(...args) {
      // Nothing to hide / re-entrant call during a cycle → pass through.
      if (!reg.names.size || reg.suspended) return orig.apply(this, args);
      // getXML('objName') queries a single object — not a document export.
      if (method === 'getXML' && args.length > 0 && typeof args[0] === 'string') {
        return orig.apply(this, args);
      }
      const names = [...reg.names];
      reg.suspended = true;
      for (const n of names) { try { applet.deleteObject(n); } catch { /* ignore */ } }
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        for (const n of names) recreateHelper(applet, n);
        reg.suspended = false;
      };
      // Async form (getBase64(cb) / getBase64(flag, cb)): restore once the
      // callback fires (serialization finished), with a safety timer in case
      // it never does.
      const cbIndex = args.findIndex((a) => typeof a === 'function');
      if (cbIndex >= 0) {
        const userCb = args[cbIndex];
        const patched = args.slice();
        patched[cbIndex] = (...cbArgs) => {
          try { return userCb(...cbArgs); } finally { restore(); }
        };
        try {
          return orig.apply(this, patched);
        } finally {
          setTimeout(restore, RESTORE_SAFETY_MS);
        }
      }
      // Sync form: serialize while helpers are gone, then restore immediately.
      try { return orig.apply(this, args); } finally { restore(); }
    };
  }
}

// Read GeoGebra's own theme so plugins can match it (and follow theme changes).
// GeoGebra exposes a small set of CSS custom properties on :root; we also sample
// computed text color/font from the live algebra view as sensible fallbacks.
// Returns a flat object of tokens; safe to call any time (defaults if headless).
export function readGgbTheme() {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return { ...THEME_FALLBACK };
  try {
    const root = getComputedStyle(document.documentElement);
    const v = (name, def) => { const x = root.getPropertyValue(name).trim(); return x || def; };
    const av = findAlgebraView();
    const avCs = av ? getComputedStyle(av) : null;
    return {
      primary: v('--ggb-primary-color', THEME_FALLBACK.primary),
      primaryVariant: v('--ggb-primary-variant-color', THEME_FALLBACK.primaryVariant),
      dark: v('--ggb-dark-color', THEME_FALLBACK.dark),
      light: v('--ggb-light-color', THEME_FALLBACK.light),
      selection: v('--ggb-selection-color', THEME_FALLBACK.selection),
      text: (avCs && avCs.color) || THEME_FALLBACK.text,
      fontFamily: (avCs && avCs.fontFamily) || THEME_FALLBACK.fontFamily,
    };
  } catch { return { ...THEME_FALLBACK }; }
}

// Detect GeoGebra's current light/dark mode by sampling the page background
// luminance (GeoGebra exposes no theme flag). Replaces the former
// window.__ggbExtendTheme__ global (clean namespace). Returns 'light' | 'dark'.
export function detectThemeMode() {
  try {
    const probe = document.body || document.documentElement;
    const bg = getComputedStyle(probe).backgroundColor || 'rgb(255,255,255)';
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s));
      if (a === 0) return 'light'; // transparent → GeoGebra's default light canvas
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? 'dark' : 'light';
    }
  } catch { /* headless */ }
  return 'light';
}

let uidCounter = 0;
function uniqueObjectName() {
  uidCounter += 1;
  return `${NAME_PREFIX}${Date.now().toString(36)}${uidCounter}`;
}

// Turn a hex/rgb colour into an rgba() with the given alpha (for the 40% fill).
function toAlpha(c, a) {
  const s = String(c || '').trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
  m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; const r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16); return `rgba(${r},${g},${b},${a})`; }
  m = s.match(/^rgb\(([^)]+)\)$/i);
  if (m) return `rgba(${m[1].trim()},${a})`;
  return s; // already rgba or a keyword — use as-is
}

function toKebab(s) { return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`); }

// cssText for the Shadow-DOM host wrapper and its inner content node.
//   inline=false (override / content host): full-width block that fills `.elemText`.
//   inline=true  (hybrid marble host):       inline-flex so it flows in the native
//                slot beside the absolutely-positioned marble + stylebar.
function hostCss(inline) {
  return inline
    ? 'all: initial; display: inline-flex; align-items: center; box-sizing: border-box;'
    : 'all: initial; display: block; width: 100%; box-sizing: border-box;';
}

// cssText for the native ball — 1:1 with GeoGebra's marble. CRITICAL: GeoGebra
// uses box-sizing:CONTENT-box with width:18px + 1px border → 20×20 rendered. We
// must match content-box (border-box would render only 18px — 2px too small).
// flex:0 0 auto + min-* so flex parents can't squish it into an ellipse.
function nativeBallCss(color, filled) {
  const M = adapterMetrics();
  return [
    'display:block', 'box-sizing:content-box',
    `width:${M.ballPx}px`, `height:${M.ballPx}px`,
    `min-width:${M.ballPx}px`, `min-height:${M.ballPx}px`,
    'flex:0 0 auto', 'border-radius:50%',
    `border:${M.ballBorderPx}px solid ${color}`,
    `background:${filled ? toAlpha(color, FILLED_ALPHA) : BALL_OFF_FILL}`,
  ].join(';');
}

export function createNativeRow(opts = {}) {
  // Only bail for a TRUE headless environment (no DOM). We must NOT bail just
  // because the applet isn't ready yet at call time — GeoGebra wires its API
  // asynchronously, so we wait for it below.
  if (typeof document === 'undefined') {
    return {
      kind: 'row', element: null, host: null, shadow: null, objectName: null,
      isDocked: () => false, isAlive: () => false, reattach() {}, destroy() {},
    };
  }

  const objectName = opts.name || uniqueObjectName();
  // 'override' = clear the whole content area, full takeover (default).
  // 'hybrid'   = keep the native row chrome (marble dot + ⋯ menu); route the
  //              marble click to opts.onMarbleClick and fill only the text area.
  const mode = opts.mode === 'hybrid' ? 'hybrid' : 'override';
  // Marble config (hybrid only): { kind:'native'|'custom', color, filled, render(el) }.
  const marbleCfg = (opts.marble && typeof opts.marble === 'object') ? opts.marble : {};
  const marbleKind = marbleCfg.kind === 'custom' ? 'custom' : 'native';
  let marbleFilled = !!marbleCfg.filled;        // native ball: solid (ON) vs outline (OFF)
  let marbleColor = marbleCfg.color || null;    // resolved against theme at render time
  let expanded = !!opts.expanded;               // framework-tracked expand state
  let applet = getApplet(opts);  // may be null/not-ready now; resolved in waitForApplet()
  let row = null;            // the .avItem we hijacked
  let contentNode = null;    // the .elemText we took over
  let host = null;           // our element placed inside contentNode
  let shadow = null;
  let alive = false;
  let destroyed = false;
  let removeListener = null;
  let unsubscribe = null;   // shared-observer subscription
  let reattachTimer = null;

  const appletReady = (a) => !!(a && typeof a.evalCommand === 'function');

  // Ask GeoGebra to create a real object so it renders a native row. We use a
  // NUMBER for BOTH modes: it's static (no checkbox) and never draws on the
  // graphics view. (A visible object would render a marble dot, but visible
  // objects also draw on the canvas — not what we want.) For hybrid we don't rely
  // on a native marble at all: the empty marble slot is cleared and handed to the
  // plugin (see hijackRow → handle.marble).
  function createObject() {
    let created = false;
    try { created = Boolean(applet.evalCommand(`${objectName}=1`)); } catch { created = false; }
    if (created) {
      try { applet.setVisible && applet.setVisible(objectName, false); } catch { /* ignore */ }
      try { applet.setAuxiliary && applet.setAuxiliary(objectName, false); } catch { /* ignore */ }
      // Keep this helper out of any saved/exported document (see save hook above).
      registerHelperObject(applet, objectName);
    }
    return created;
  }

  // Keep interaction events INSIDE the container. GeoGebra registers listeners on
  // the algebra view / row and stops propagation mid-bubble to select or edit the
  // object (verified: it swallows mousedown/click/dblclick). Our host sits inside
  // that row, so an event from our UI would bubble up and trigger GeoGebra. We
  // stop propagation at our host (bubble phase, before the event reaches the row)
  // so GeoGebra's listeners never see it — while the event still works normally
  // inside our own Shadow DOM (its handlers already ran before this host).
  //
  // IMPORTANT (text selection): GeoGebra's algebra view sets `user-select: none`
  // and calls preventDefault on `selectstart`/`mousedown` to stop the user from
  // selecting object text. Our content inherits that, so plugin UIs (chat bubbles,
  // inputs) became un-selectable. We DON'T want to swallow `selectstart` (that is
  // the very event GeoGebra abuses to block selection): instead we let it through
  // our host UNtouched, stop it from reaching GeoGebra, and re-enable selection in
  // CSS on the content node (see buildHost). The net effect: selection works
  // inside our UI, GeoGebra never sees the event.
  const ISOLATED_EVENTS = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'contextmenu', 'keydown', 'keyup', 'keypress', 'input', 'change',
    'focusin', 'focusout', 'wheel', 'touchstart', 'touchend',
    'selectstart', 'selectionchange', 'copy', 'cut', 'paste',
  ];
  function isolateEvents(hostEl) {
    const stop = (e) => { e.stopPropagation(); };
    for (const type of ISOLATED_EVENTS) {
      // Bubble phase on the host: fires after our inner handlers, before the row.
      // We only stopPropagation (NOT preventDefault), so the browser's native
      // text-selection / clipboard behaviour inside our Shadow DOM is preserved.
      hostEl.addEventListener(type, stop);
    }
  }

  // Build a Shadow-DOM host (closed) with an inner content node and event
  // isolation. Returns { h: host, sh: shadow root, content: inner node }.
  function buildHost(inline = false) {
    const css = hostCss(inline);
    const h = document.createElement('div');
    h.setAttribute(CONTAINER_ATTR, objectName);
    h.style.cssText = css;
    const sh = h.attachShadow({ mode: 'closed' });
    const content = document.createElement('div');
    // Re-enable text selection inside our UI: GeoGebra's algebra view forces
    // `user-select: none` on its rows and our content would inherit it. We opt
    // back in here (the content host is a Shadow root, so this does not leak out
    // and re-enable selection of GeoGebra's own object rows). Individual plugin
    // elements can still opt out with their own `user-select: none`.
    const selectable = 'user-select: text; -webkit-user-select: text; cursor: auto;';
    content.style.cssText = `${css} ${selectable}`;
    sh.appendChild(content);
    isolateEvents(h);
    return { h, sh, content };
  }

  // Inline styles we set on GeoGebra's nodes, remembered so destroy() can restore
  // the row to its original look. Map<element, {prop: originalValue}>.
  const styledNodes = new Map();
  function setStyle(node, prop, value) {
    if (!node) return;
    if (!styledNodes.has(node)) styledNodes.set(node, {});
    const rec = styledNodes.get(node);
    if (!(prop in rec)) rec[prop] = node.style[prop]; // remember original once
    node.style[prop] = value;
  }
  function setStyles(node, props) {
    for (const prop of Object.keys(props)) setStyle(node, prop, props[prop]);
  }
  function restoreStyledNodes() {
    for (const [node, rec] of styledNodes) {
      for (const prop of Object.keys(rec)) {
        if (rec[prop] === '') node.style.removeProperty(toKebab(prop));
        else node.style[prop] = rec[prop];
      }
    }
    styledNodes.clear();
  }

  // hybrid: turn the native (empty) marble slot into a PLUGIN-CONTROLLED area.
  // We clear GeoGebra's marble, mount our own Shadow-DOM host there for the plugin
  // to render into (dot, icon, status light…), isolate events so GeoGebra's
  // show/hide never runs, and still call opts.onMarbleClick for convenience.
  let marbleHandler = null;
  let marbleNode = null;       // the GeoGebra .marblePanel we took over
  let marbleHost = null;       // our host inside it
  function wireMarble(targetRow) {
    const panel = targetRow.querySelector(sel('marblePanel'));
    if (!panel) return;
    const M = adapterMetrics();
    marbleNode = panel;
    // The native marble is hidden (setVisible false → 0x0) which collapses the
    // panel. Restore the panel to GeoGebra's NATIVE marble footprint (58px wide,
    // its own `padding: 0 18px`) so our dot lands exactly where a native marble
    // would, and the row reads identically to a native object row.
    setStyles(panel, {
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${M.marblePanelPx}px`,
      minWidth: `${M.marblePanelPx}px`,
      height: '100%',
      left: '0px',     // keep it pinned at the row's left edge
    });
    // Build (once) a host the plugin renders its marble content into.
    if (!marbleHost) {
      const hostPx = M.ballPx + 2 * M.ballBorderPx; // rendered ball box
      const built = buildHost(true);   // inline host with event isolation
      marbleHost = built.h;
      marbleHost.__content = built.content;
      marbleHost.setAttribute(MARBLE_ATTR, objectName);
      // Host sized to the rendered ball (content + border), centered;
      // flex:0 0 auto so the panel's flex layout can't squish the circle.
      marbleHost.style.cssText = `all: initial; display: flex; align-items: center; justify-content: center; width: ${hostPx}px; height: ${hostPx}px; flex: 0 0 auto; box-sizing: border-box;`;
      built.content.style.cssText = 'all: initial; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; box-sizing: border-box;';
    }
    panel.textContent = '';            // remove GeoGebra's own (hidden) marble dot
    panel.appendChild(marbleHost);
    renderMarble();
    // Click routing. We must (a) keep GeoGebra from seeing ANY of these (so it
    // doesn't select/drag the row), but (b) fire the plugin callback exactly ONCE
    // per click. So pointerdown/mousedown are only swallowed; the callback runs on
    // 'click' alone (otherwise a single physical click would toggle 2-3 times —
    // the "expand then snap back" bug).
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); };
    marbleHandler = (e) => {
      swallow(e);
      if (typeof opts.onMarbleClick === 'function') { try { opts.onMarbleClick(marbleApi, e); } catch { /* ignore */ } }
    };
    panel[SWALLOW_KEY] = swallow;
    for (const t of ['pointerdown', 'mousedown']) panel.addEventListener(t, swallow, true);
    panel.addEventListener('click', marbleHandler, true);
  }

  // Render the marble's content: a pixel-accurate GeoGebra ball ('native') or the
  // plugin's own element ('custom'). Native ball metrics captured from GeoGebra:
  // 18×18 box, 1px solid border in the object colour, full circle; SOLID = colour
  // at 40% (the "visible/ON" look), OUTLINE = white fill + colour border ("OFF").
  function renderMarble() {
    const content = marbleHost && marbleHost.__content;
    if (!content) return;
    content.innerHTML = '';
    if (marbleKind === 'custom' && typeof marbleCfg.render === 'function') {
      try { marbleCfg.render(content, { filled: marbleFilled, expanded }); } catch { /* ignore */ }
      return;
    }
    const ball = document.createElement('span');
    ball.style.cssText = nativeBallCss(resolveMarbleColor(), marbleFilled);
    content.appendChild(ball);
  }

  // Resolve the ball colour: explicit opts.marble.color, else the host theme's
  // primary, else a sensible default.
  function resolveMarbleColor() {
    if (marbleColor) return marbleColor;
    try {
      const t = (typeof opts.theme === 'function') ? opts.theme() : null;
      if (t && t.primary) return t.primary;
    } catch { /* ignore */ }
    return DEFAULT_MARBLE_COLOR;
  }

  // Control object passed to onMarbleClick (and mirrored on the handle). Lets the
  // plugin flip the ball and drive expand/collapse without touching framework DOM.
  const marbleApi = {
    isFilled: () => marbleFilled,
    setFilled(v) { marbleFilled = !!v; renderMarble(); },
    toggleFilled() { marbleFilled = !marbleFilled; renderMarble(); return marbleFilled; },
    isExpanded: () => expanded,
    setExpanded(v) { setExpandedState(!!v); },
    expand() { setExpandedState(true); },
    collapse() { setExpandedState(false); },
    toggle() { setExpandedState(!expanded); return expanded; },
  };
  // Track expand state in the framework; notify the plugin so it re-renders its
  // own content. (The framework owns the state + the marble; the plugin owns what
  // "expanded" looks like in `element`.)
  function setExpandedState(v) {
    const next = !!v;
    if (next === expanded) return;
    expanded = next;
    renderMarble();
    if (typeof opts.onExpandedChange === 'function') { try { opts.onExpandedChange(expanded, marbleApi); } catch { /* ignore */ } }
  }

  // Apply the layout styles for 'override' mode: free the row chain so OUR content
  // drives the height, and give the content area the whole row (no native marble/
  // stylebar to dodge). Keep a native-matching MIN height so a short panel still
  // reads like a real row (not shorter); taller content expands past it.
  function applyOverrideLayout(targetRow, elem, content) {
    const M = adapterMetrics();
    // Hide everything GeoGebra owns so the row reads as a clean panel.
    for (const s of [sel('marblePanel'), sel('checkboxPanel'), sel('stylebar')]) {
      const node = targetRow.querySelector(s);
      if (node) setStyle(node, 'display', 'none');
    }
    for (const node of [targetRow, elem]) {
      setStyles(node, {
        height: 'auto',
        minHeight: `${M.rowHeight}px`,
        maxHeight: 'none',
        overflow: 'visible',
        alignItems: 'stretch',
        lineHeight: 'normal',
        padding: '0',
      });
    }
    setStyles(content, {
      flex: '1',
      width: '100%',
      maxWidth: '100%',
      height: 'auto',
      minHeight: '0',
      maxHeight: 'none',
      overflow: 'visible',
      padding: '0',
    });
  }

  // Apply the layout styles for 'hybrid' mode: we OWN the marble (a fixed panel
  // pinned left) and the ⋯ menu stays pinned right. GeoGebra's native content
  // padding (≈68px left, reserved for its own marble) is wrong for us, so we take
  // over the content box: indent past our marble on the left, leave room for the ⋯
  // menu on the right, fill the rest, and vertically center.
  function applyHybridLayout(targetRow, elem, content) {
    const M = adapterMetrics();
    // Keep the marble (plugin-controlled). The boolean checkbox AND the native
    // ⋯ stylebar are hidden: the ⋯ menu would operate on the hidden helper
    // object behind this row — opening it would expose framework internals
    // (P3-2). The right padding still reserves the native footprint so the row
    // reads identically.
    for (const s of [sel('checkboxPanel'), sel('stylebar')]) {
      const node = targetRow.querySelector(s);
      if (node) setStyle(node, 'display', 'none');
    }
    wireMarble(targetRow);

    for (const node of [targetRow, elem]) {
      setStyles(node, {
        height: 'auto',
        minHeight: `${M.rowHeight}px`,
        maxHeight: 'none',
        overflow: 'visible',
      });
    }
    setStyles(content, {
      height: 'auto',
      minHeight: `${M.rowHeight}px`,
      maxHeight: 'none',
      overflow: 'visible',
      boxSizing: 'border-box',
      padding: '0',
      paddingLeft: `${M.contentIndentPx}px`,   // match native indent (marble + gap)
      paddingRight: `${M.rowRightPadPx}px`,    // clear the native ⋯ stylebar
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    });
  }

  // Take over the row. In 'override' we clear the whole content area and control
  // everything. In 'hybrid' we keep the native chrome (marble + ⋯ menu), route
  // the marble click to the plugin, and only fill the text area with our content.
  function hijackRow(targetRow) {
    if (!targetRow) return false;
    // Graceful degradation: the row MUST match the profile's anatomy. Falling
    // back to styling the row itself produced misplaced skeletons on unknown
    // GeoGebra versions — refuse instead (no render beats a wrong render).
    const content = targetRow.querySelector(sel('elemText'));
    const elem = targetRow.querySelector(sel('elem'));
    if (!content || !elem) return false;

    if (mode === 'override') applyOverrideLayout(targetRow, elem, content);
    else applyHybridLayout(targetRow, elem, content);

    targetRow.setAttribute(ROW_ATTR, objectName);

    // Insert our host into the content area (build once, reuse). The CONTENT host
    // always fills its box (block, 100% wide) in BOTH modes — `.elemText` is the
    // box, and we want the plugin UI to fill it. (Only the separate MARBLE host is
    // inline/small.) Earlier this was inline in hybrid, which collapsed the UI to
    // ~11px.
    if (!host) { const built = buildHost(false); host = built.h; shadow = built.sh; host.__content = built.content; }
    content.textContent = '';
    content.appendChild(host);
    row = targetRow;
    contentNode = content;
    const wasAlive = alive;
    alive = true;
    // Notify on the first successful attach (and on re-attach after a rebuild),
    // so the plugin can render into element once it exists.
    if (!wasAlive && typeof opts.onAttached === 'function') { try { opts.onAttached(); } catch { /* ignore */ } }
    return true;
  }

  function attach() {
    const av = findAlgebraView();
    if (!av) { alive = false; return false; }
    // Already hijacked and still attached? Nothing to do.
    if (row && av.contains(row) && contentNode && contentNode.contains(host)) { alive = true; return true; }
    // Prefer re-finding our marked row (survives across our own mutations).
    let target = av.querySelector(`[${ROW_ATTR}="${objectName}"]`);
    if (!target) target = findRowByName(av, objectName);
    return hijackRow(target);
  }

  // Lightweight watcher: only act if our owned node fell out of the DOM (full
  // tree rebuild). Debounced; ignores mutations inside our own host.
  function scheduleReattach() {
    if (reattachTimer) return;
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      const stillThere = host && host.isConnected && row && row.isConnected;
      if (!stillThere) attach();
    }, 150);
  }

  function cleanupDom() {
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
    if (marbleNode) {
      try {
        if (marbleNode[SWALLOW_KEY]) {
          for (const t of ['pointerdown', 'mousedown']) marbleNode.removeEventListener(t, marbleNode[SWALLOW_KEY], true);
        }
        if (marbleHandler) marbleNode.removeEventListener('click', marbleHandler, true);
      } catch { /* ignore */ }
    }
    if (marbleHost && marbleHost.parentNode) marbleHost.parentNode.removeChild(marbleHost);
    marbleNode = null; marbleHandler = null; marbleHost = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  // Runs once the applet is ready: create the object, wire the observer + the
  // remove listener, then hijack the rendered row (retrying as GeoGebra paints).
  function start() {
    if (destroyed) return;

    // Graceful degradation: if the live DOM contradicts the profile (rows exist
    // but their anatomy doesn't match), do NOT create a backing object at all —
    // it would show up as an unhijacked raw row in the algebra list.
    const health = selfCheck();
    if (health.checks.rowAnatomy === 'broken' || !health.checks.metricsSane) return;

    createObject();

    // Single shared observer (P1-3): one watcher per document, fanned out.
    unsubscribe = subscribeDom((mutations) => {
      for (const m of mutations) {
        if (m.target && m.target.closest && m.target.closest(`[${CONTAINER_ATTR}]`)) continue;
        scheduleReattach();
        break;
      }
    });

    // Reroute GeoGebra's own delete back to the plugin: if the user deletes this
    // object (or undo removes it), tear our container down too.
    try {
      if (typeof applet.registerRemoveListener === 'function') {
        removeListener = (name) => {
          if (name !== objectName) return;
          // A save-time delete/recreate cycle is NOT a user deletion: keep the
          // handle alive; the observer re-hijacks the rebuilt row afterwards.
          if (isHelperSuspended(applet, objectName)) { scheduleReattach(); return; }
          alive = false;
          if (typeof opts.onRemoved === 'function') { try { opts.onRemoved(); } catch { /* ignore */ } }
          cleanupDom();
        };
        applet.registerRemoveListener(removeListener);
      }
    } catch { /* ignore */ }

    // Initial hijack. GeoGebra renders asynchronously, so retry briefly. If the
    // retry budget runs out (row never matched the profile), remove the backing
    // object so the user is not left looking at an unhijacked raw row.
    const budget = (opts.attachRetry && opts.attachRetry.tries) || 40;
    const interval = (opts.attachRetry && opts.attachRetry.intervalMs) || 60;
    let tries = 0;
    (function tryAttach() {
      if (destroyed) return;
      if (attach()) return;
      if (tries++ < budget) { setTimeout(tryAttach, interval); return; }
      unregisterHelperObject(applet, objectName);
      try { if (applet && applet.deleteObject) applet.deleteObject(objectName); } catch { /* ignore */ }
      cleanupDom();
    })();
  }

  // Wait for the applet's API to be wired (GeoGebra does this asynchronously),
  // then start. If it never arrives, the handle simply stays inert (no crash);
  // the caller decided to use a row, so we do NOT silently fall back here.
  (function waitForApplet() {
    if (destroyed) return;
    if (!appletReady(applet)) applet = getApplet(opts);
    if (appletReady(applet)) { start(); return; }
    setTimeout(waitForApplet, 80);
  })();

  return {
    kind: 'row',
    mode,
    get element() { return host ? host.__content : null; },
    // hybrid only: the left marble area, a plugin-controlled slot (null in override).
    get marble() { return marbleHost ? marbleHost.__content : null; },
    get host() { return host; },
    get shadow() { return shadow; },
    objectName,
    isDocked: () => alive,
    isAlive: () => alive,
    reattach: attach,
    // Marble + expand control (hybrid). Mirror of the api passed to onMarbleClick.
    isFilled: () => marbleFilled,
    setFilled(v) { marbleFilled = !!v; renderMarble(); },
    toggleFilled() { marbleFilled = !marbleFilled; renderMarble(); return marbleFilled; },
    setMarbleColor(c) { marbleColor = c || null; renderMarble(); },
    isExpanded: () => expanded,
    setExpanded(v) { setExpandedState(!!v); },
    expand() { setExpandedState(true); },
    collapse() { setExpandedState(false); },
    toggleExpanded() { setExpandedState(!expanded); return expanded; },
    destroy() {
      destroyed = true;
      cleanupDom();
      restoreStyledNodes(); // put GeoGebra's row styles back the way we found them
      try { if (removeListener && applet && applet.unregisterRemoveListener) applet.unregisterRemoveListener(removeListener); } catch { /* ignore */ }
      unregisterHelperObject(applet, objectName);
      // Remove the helper object we created (best effort; ignore if user already did).
      try { if (applet && applet.deleteObject) applet.deleteObject(objectName); } catch { /* ignore */ }
      alive = false;
      row = null; contentNode = null; host = null; shadow = null;
    },
  };
}

// Internal constants exposed for unit tests ONLY (session-random by design —
// production code and plugins must never rely on these names).
export const __internals = { CONTAINER_ATTR, ROW_ATTR, MARBLE_ATTR, NAME_PREFIX };

export default createNativeRow;
