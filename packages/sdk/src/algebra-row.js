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
const NAME_PREFIX = 'ngbUI';

function getApplet(opts) {
  if (opts && opts.applet) return opts.applet;
  if (typeof window !== 'undefined' && window.ggbApplet) return window.ggbApplet;
  return null;
}

function findAlgebraView() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('.algebraView') || document.querySelector('.gwt-Tree.algebraView') || null;
}

const DEFAULT_ROW_HEIGHT = 40; // px fallback ≈ a GeoGebra Classic 6 object row

// Measure a real native row so our container matches the host's row height
// exactly. Prefers a normal object row; falls back to the always-present
// "Input…" row (.avInputItem); then to a constant.
function nativeRowHeight(av) {
  try {
    const root = av || findAlgebraView();
    if (root) {
      // 1) a normal object row (not ours, not the input row)
      for (const item of root.querySelectorAll('.avItem')) {
        if (item.hasAttribute('data-ngb-row')) continue;
        if (item.querySelector('.avInputItem') || item.closest('.avInputItem')) continue;
        const h = Math.round(item.getBoundingClientRect().height);
        if (h >= 24 && h <= 80) return h;
      }
      // 2) the "Input…" row is always there and is one native row tall
      const input = root.querySelector('.avInputItem') || document.querySelector('.avInputItem');
      if (input) {
        const h = Math.round(input.getBoundingClientRect().height);
        if (h >= 24 && h <= 80) return h;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_ROW_HEIGHT;
}

// Read GeoGebra's own theme so plugins can match it (and follow theme changes).
// GeoGebra exposes a small set of CSS custom properties on :root; we also sample
// computed text color/font from the live algebra view as sensible fallbacks.
// Returns a flat object of tokens; safe to call any time (defaults if headless).
export function readGgbTheme() {
  const fallback = {
    primary: '#6557D2', primaryVariant: '#F3F0FF', dark: '#5145A8',
    light: '#F3F0FF', selection: 'rgba(101,87,210,0.2)',
    text: 'rgb(28,28,31)', fontFamily: 'geogebra-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif',
  };
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  try {
    const root = getComputedStyle(document.documentElement);
    const v = (name, def) => { const x = root.getPropertyValue(name).trim(); return x || def; };
    const av = findAlgebraView();
    const avCs = av ? getComputedStyle(av) : null;
    return {
      primary: v('--ggb-primary-color', fallback.primary),
      primaryVariant: v('--ggb-primary-variant-color', fallback.primaryVariant),
      dark: v('--ggb-dark-color', fallback.dark),
      light: v('--ggb-light-color', fallback.light),
      selection: v('--ggb-selection-color', fallback.selection),
      text: (avCs && avCs.color) || fallback.text,
      fontFamily: (avCs && avCs.fontFamily) || fallback.fontFamily,
    };
  } catch { return fallback; }
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

  function buildHost(inline = false) {
    const h = document.createElement('div');
    h.setAttribute(CONTAINER_ATTR, objectName);
    // override: full-width block. hybrid: inline so it flows in the native text
    // slot (alongside the absolutely-positioned marble + stylebar) without forcing
    // its own box and re-breaking GeoGebra's layout.
    h.style.cssText = inline
      ? 'all: initial; display: inline-flex; align-items: center; box-sizing: border-box;'
      : 'all: initial; display: block; width: 100%; box-sizing: border-box;';
    const sh = h.attachShadow({ mode: 'closed' });
    const content = document.createElement('div');
    content.style.cssText = inline
      ? 'all: initial; display: inline-flex; align-items: center; box-sizing: border-box;'
      : 'all: initial; display: block; width: 100%; box-sizing: border-box;';
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
  function restoreStyledNodes() {
    for (const [node, rec] of styledNodes) {
      for (const prop of Object.keys(rec)) {
        if (rec[prop] === '') node.style.removeProperty(toKebab(prop));
        else node.style[prop] = rec[prop];
      }
    }
    styledNodes.clear();
  }
  function toKebab(s) { return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`); }

  // hybrid: turn the native (empty) marble slot into a PLUGIN-CONTROLLED area.
  // We clear GeoGebra's marble, mount our own Shadow-DOM host there for the plugin
  // to render into (dot, icon, status light…), isolate events so GeoGebra's
  // show/hide never runs, and still call opts.onMarbleClick for convenience.
  let marbleHandler = null;
  let marbleNode = null;       // the GeoGebra .marblePanel we took over
  let marbleHost = null;       // our host inside it
  let marbleShadow = null;
  function wireMarble(targetRow) {
    const panel = targetRow.querySelector('.marblePanel');
    if (!panel) return;
    marbleNode = panel;
    // The native marble is hidden (setVisible false → 0x0) which collapses the
    // panel. Restore the panel to GeoGebra's NATIVE marble footprint (58px wide,
    // its own `padding: 0 18px`) so our dot lands exactly where a native marble
    // would, and the row reads identically to a native object row.
    setStyle(panel, 'cursor', 'pointer');
    setStyle(panel, 'display', 'flex');
    setStyle(panel, 'alignItems', 'center');
    setStyle(panel, 'justifyContent', 'center');
    setStyle(panel, 'width', '58px');
    setStyle(panel, 'minWidth', '58px');
    setStyle(panel, 'height', '100%');
    setStyle(panel, 'left', '0px');     // keep it pinned at the row's left edge
    // Build (once) a host the plugin renders its marble content into.
    if (!marbleHost) {
      const built = buildHost(true);   // inline host with event isolation
      marbleHost = built.h;
      marbleShadow = built.sh;
      marbleHost.__content = built.content;
      marbleHost.setAttribute('data-ngb-marble', objectName);
      // give the host a clickable footprint even before the plugin draws into it
      marbleHost.style.cssText = 'all: initial; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; box-sizing: border-box;';
      built.content.style.cssText = 'all: initial; display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; box-sizing: border-box;';
    }
    panel.textContent = '';            // remove GeoGebra's own (hidden) marble dot
    panel.appendChild(marbleHost);
    // Click routing. We must (a) keep GeoGebra from seeing ANY of these (so it
    // doesn't select/drag the row), but (b) fire the plugin callback exactly ONCE
    // per click. So pointerdown/mousedown are only swallowed; the callback runs on
    // 'click' alone (otherwise a single physical click would toggle 2-3 times —
    // the "expand then snap back" bug).
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); };
    marbleHandler = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (typeof opts.onMarbleClick === 'function') { try { opts.onMarbleClick(e); } catch { /* ignore */ } }
    };
    panel.__ngbSwallow = swallow;
    for (const t of ['pointerdown', 'mousedown']) panel.addEventListener(t, swallow, true);
    panel.addEventListener('click', marbleHandler, true);
  }

  // Take over the row. In 'override' we clear the whole content area and control
  // everything. In 'hybrid' we keep the native chrome (marble + ⋯ menu), route
  // the marble click to the plugin, and only fill the text area with our content.
  function hijackRow(targetRow) {
    if (!targetRow) return false;
    const content = targetRow.querySelector('.elemText') || targetRow;
    const elem = targetRow.querySelector('.elem') || targetRow;

    if (mode === 'override') {
      // Hide everything GeoGebra owns so the row reads as a clean panel.
      for (const sel of ['.marblePanel', '.checkboxPanel', '.algebraViewObjectStylebar']) {
        const node = targetRow.querySelector(sel);
        if (node) setStyle(node, 'display', 'none');
      }
    } else {
      // hybrid: keep the marble + the ⋯ stylebar menu (native). Only the boolean
      // checkbox (if any) is hidden — our backing object is a number, so usually
      // there's none. Route the marble click to the plugin.
      const checkbox = targetRow.querySelector('.checkboxPanel');
      if (checkbox) setStyle(checkbox, 'display', 'none');
      wireMarble(targetRow);
    }

    targetRow.setAttribute(ROW_ATTR, objectName);

    const rowH = nativeRowHeight(targetRow.closest('.algebraView'));
    if (mode === 'override') {
      // Full takeover: free the row chain so OUR content drives the height, and
      // give the content area the whole row (no native marble/stylebar to dodge).
      // Keep a native-matching MIN height so a short panel still reads like a real
      // row (not shorter); taller content expands past it.
      for (const node of [targetRow, elem]) {
        setStyle(node, 'height', 'auto');
        setStyle(node, 'minHeight', `${rowH}px`);
        setStyle(node, 'maxHeight', 'none');
        setStyle(node, 'overflow', 'visible');
        setStyle(node, 'alignItems', 'stretch');
        setStyle(node, 'lineHeight', 'normal');
        setStyle(node, 'padding', '0');
      }
      setStyle(content, 'flex', '1');
      setStyle(content, 'width', '100%');
      setStyle(content, 'maxWidth', '100%');
      setStyle(content, 'height', 'auto');
      setStyle(content, 'minHeight', '0');
      setStyle(content, 'maxHeight', 'none');
      setStyle(content, 'overflow', 'visible');
      setStyle(content, 'padding', '0');
    } else {
      // hybrid: we now OWN the marble (a fixed 28px panel pinned left) and the ⋯
      // menu stays pinned right. GeoGebra's native content padding (≈68px left,
      // reserved for its own marble) is wrong for us, so we take over the content
      // box: indent past our marble on the left, leave room for the ⋯ menu on the
      // right, fill the rest, and vertically center.
      for (const node of [targetRow, elem]) {
        setStyle(node, 'height', 'auto');
        setStyle(node, 'minHeight', `${rowH}px`);
        setStyle(node, 'maxHeight', 'none');
        setStyle(node, 'overflow', 'visible');
      }
      setStyle(content, 'height', 'auto');
      setStyle(content, 'minHeight', `${rowH}px`);
      setStyle(content, 'maxHeight', 'none');
      setStyle(content, 'overflow', 'visible');
      setStyle(content, 'boxSizing', 'border-box');
      setStyle(content, 'padding', '0');
      setStyle(content, 'paddingLeft', '68px');   // match native indent (58px marble + gap)
      setStyle(content, 'paddingRight', '40px');  // clear the native ⋯ stylebar
      setStyle(content, 'display', 'flex');
      setStyle(content, 'flexDirection', 'column');
      setStyle(content, 'justifyContent', 'center');
    }

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
    marbleNode = null; marbleHandler = null; marbleHost = null; marbleShadow = null;
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
