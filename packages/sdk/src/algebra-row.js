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

const CONTAINER_ATTR = 'data-ngb-container';   // marks the content node we own
const ROW_ATTR = 'data-ngb-row';               // marks the .avItem row we own
const MARBLE_ATTR = 'data-ngb-marble';         // marks the marble host we own
const NAME_PREFIX = 'ngbUI';

// Layout constants, all in px. These are GeoGebra Classic 6 metrics measured
// against the live DOM — do NOT change without re-measuring against GeoGebra.
const NATIVE_ROW_HEIGHT = 48;  // a plain single-line object row
const NATIVE_BALL_PX = 18;     // marble ball content box (1px border → 20px rendered)
const BALL_BORDER_PX = 1;      // marble ball border width
const MARBLE_HOST_PX = NATIVE_BALL_PX + 2 * BALL_BORDER_PX; // 20px host around the ball
const MARBLE_PANEL_PX = 58;    // native marble panel footprint (its own padding: 0 18px)
const CONTENT_INDENT_PX = 68;  // native content indent (58px marble + gap)
const ROW_RIGHT_PAD_PX = 40;   // room to clear the native ⋯ stylebar
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

function findAlgebraView() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('.algebraView') || document.querySelector('.gwt-Tree.algebraView') || null;
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

// Walk up from a node to the enclosing `.avItem` row (the unit GeoGebra lays out).
function closestAvItem(node, stopAt) {
  let p = node;
  while (p && p !== stopAt) {
    const cls = `${(p.className && (p.className.baseVal || p.className)) || ''}`;
    if (/\bavItem\b/.test(cls)) return p;
    p = p.parentElement;
  }
  return null;
}

// Find the row GeoGebra just rendered for `name`, by its definition text. We use
// this ONLY at hijack time (before we clear the text); afterwards we rely on our
// own data-attr + saved reference.
function findRowByName(av, name) {
  if (!av) return null;
  // The definition lives in `.avPlainText[aria-label^="name ="]` or as text.
  const labelled = av.querySelector(`.avPlainText[aria-label^="${name} ="], .avPlainText[aria-label="${name}"]`);
  if (labelled) { const row = closestAvItem(labelled, av); if (row) return row; }
  // Fallback: text walk.
  let walker;
  try { walker = document.createTreeWalker(av, NodeFilter.SHOW_TEXT, null); } catch { return null; }
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent && n.textContent.includes(name)) {
      const row = closestAvItem(n.parentElement, av);
      return row || n.parentElement;
    }
  }
  return null;
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
  return [
    'display:block', 'box-sizing:content-box',
    `width:${NATIVE_BALL_PX}px`, `height:${NATIVE_BALL_PX}px`,
    `min-width:${NATIVE_BALL_PX}px`, `min-height:${NATIVE_BALL_PX}px`,
    'flex:0 0 auto', 'border-radius:50%',
    `border:${BALL_BORDER_PX}px solid ${color}`,
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
  let observer = null;
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
  const ISOLATED_EVENTS = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'contextmenu', 'keydown', 'keyup', 'keypress', 'input', 'change',
    'focusin', 'focusout', 'wheel', 'touchstart', 'touchend',
  ];
  function isolateEvents(hostEl) {
    const stop = (e) => { e.stopPropagation(); };
    for (const type of ISOLATED_EVENTS) {
      // Bubble phase on the host: fires after our inner handlers, before the row.
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
    content.style.cssText = css;
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
    const panel = targetRow.querySelector('.marblePanel');
    if (!panel) return;
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
      width: `${MARBLE_PANEL_PX}px`,
      minWidth: `${MARBLE_PANEL_PX}px`,
      height: '100%',
      left: '0px',     // keep it pinned at the row's left edge
    });
    // Build (once) a host the plugin renders its marble content into.
    if (!marbleHost) {
      const built = buildHost(true);   // inline host with event isolation
      marbleHost = built.h;
      marbleHost.__content = built.content;
      marbleHost.setAttribute(MARBLE_ATTR, objectName);
      // Host sized to the 20px rendered ball (18px content + 2px border), centered;
      // flex:0 0 auto so the panel's flex layout can't squish the circle.
      marbleHost.style.cssText = `all: initial; display: flex; align-items: center; justify-content: center; width: ${MARBLE_HOST_PX}px; height: ${MARBLE_HOST_PX}px; flex: 0 0 auto; box-sizing: border-box;`;
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
    panel.__ngbSwallow = swallow;
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
    // Hide everything GeoGebra owns so the row reads as a clean panel.
    for (const sel of ['.marblePanel', '.checkboxPanel', '.algebraViewObjectStylebar']) {
      const node = targetRow.querySelector(sel);
      if (node) setStyle(node, 'display', 'none');
    }
    for (const node of [targetRow, elem]) {
      setStyles(node, {
        height: 'auto',
        minHeight: `${NATIVE_ROW_HEIGHT}px`,
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
    // Keep the marble + ⋯ stylebar (native). Only the boolean checkbox (if any) is
    // hidden — our backing object is a number, so usually there's none.
    const checkbox = targetRow.querySelector('.checkboxPanel');
    if (checkbox) setStyle(checkbox, 'display', 'none');
    wireMarble(targetRow);

    for (const node of [targetRow, elem]) {
      setStyles(node, {
        height: 'auto',
        minHeight: `${NATIVE_ROW_HEIGHT}px`,
        maxHeight: 'none',
        overflow: 'visible',
      });
    }
    setStyles(content, {
      height: 'auto',
      minHeight: `${NATIVE_ROW_HEIGHT}px`,
      maxHeight: 'none',
      overflow: 'visible',
      boxSizing: 'border-box',
      padding: '0',
      paddingLeft: `${CONTENT_INDENT_PX}px`,   // match native indent (58px marble + gap)
      paddingRight: `${ROW_RIGHT_PAD_PX}px`,   // clear the native ⋯ stylebar
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
    const content = targetRow.querySelector('.elemText') || targetRow;
    const elem = targetRow.querySelector('.elem') || targetRow;

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
    if (observer) { try { observer.disconnect(); } catch { /* ignore */ } observer = null; }
    if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
    if (marbleNode) {
      try {
        if (marbleNode.__ngbSwallow) {
          for (const t of ['pointerdown', 'mousedown']) marbleNode.removeEventListener(t, marbleNode.__ngbSwallow, true);
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
    createObject();

    try {
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.target && m.target.closest && m.target.closest(`[${CONTAINER_ATTR}]`)) continue;
          scheduleReattach();
          break;
        }
      });
      const root = findAlgebraView() || document.body || document.documentElement;
      if (root) observer.observe(root, { childList: true, subtree: true });
    } catch { /* unavailable in tests */ }

    // Reroute GeoGebra's own delete back to the plugin: if the user deletes this
    // object (or undo removes it), tear our container down too.
    try {
      if (typeof applet.registerRemoveListener === 'function') {
        removeListener = (name) => {
          if (name === objectName) { alive = false; if (typeof opts.onRemoved === 'function') { try { opts.onRemoved(); } catch { /* ignore */ } } cleanupDom(); }
        };
        applet.registerRemoveListener(removeListener);
      }
    } catch { /* ignore */ }

    // Initial hijack. GeoGebra renders asynchronously, so retry briefly.
    let tries = 0;
    (function tryAttach() {
      if (destroyed) return;
      if (attach()) return;
      if (tries++ < 40) setTimeout(tryAttach, 60);
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
      // Remove the helper object we created (best effort; ignore if user already did).
      try { if (applet && applet.deleteObject) applet.deleteObject(objectName); } catch { /* ignore */ }
      alive = false;
      row = null; contentNode = null; host = null; shadow = null;
    },
  };
}

export default createNativeRow;
