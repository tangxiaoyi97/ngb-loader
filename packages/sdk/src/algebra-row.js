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
  // NUMBER (not a boolean): a boolean renders a clickable checkbox that stays
  // interactive and toggles on click; a number is a static row with no controls,
  // which is what we want to take over. (Verified: number rows survive clicks +
  // redraws once hijacked.) We keep it out of the graphics view.
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

  function buildHost() {
    const h = document.createElement('div');
    h.setAttribute(CONTAINER_ATTR, objectName);
    h.style.cssText = 'all: initial; display: block; width: 100%; box-sizing: border-box;';
    const sh = h.attachShadow({ mode: 'closed' });
    const content = document.createElement('div');
    content.style.cssText = 'all: initial; display: block; width: 100%; box-sizing: border-box;';
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

  // Take over the row's content area: hide GeoGebra's own bits, free the row's
  // height so OUR content drives it, then inject our host.
  function hijackRow(targetRow) {
    if (!targetRow) return false;
    const content = targetRow.querySelector('.elemText') || targetRow;
    const elem = targetRow.querySelector('.elem') || targetRow;
    // Hide the parts GeoGebra owns so the row reads as a clean panel.
    for (const sel of ['.marblePanel', '.checkboxPanel', '.algebraViewObjectStylebar']) {
      const node = targetRow.querySelector(sel);
      if (node) setStyle(node, 'display', 'none');
    }
    targetRow.setAttribute(ROW_ATTR, objectName);
    // Free the row's parent chain from its one-line height constraints so the
    // row grows/shrinks with our content (GeoGebra sizes rows for a single line).
    for (const node of [targetRow, elem]) {
      setStyle(node, 'height', 'auto');
      setStyle(node, 'minHeight', '0');
      setStyle(node, 'maxHeight', 'none');
      setStyle(node, 'overflow', 'visible');
      setStyle(node, 'alignItems', 'stretch'); // if it's a flex row, let us stretch
    }
    // Let our content area span the full row width and height.
    setStyle(content, 'flex', '1');
    setStyle(content, 'width', '100%');
    setStyle(content, 'maxWidth', '100%');
    setStyle(content, 'height', 'auto');
    setStyle(content, 'minHeight', '0');
    setStyle(content, 'maxHeight', 'none');
    setStyle(content, 'overflow', 'visible');
    setStyle(content, 'padding', '0');
    // Clear GeoGebra's definition text and insert our host (build once, reuse).
    if (!host) { const built = buildHost(); host = built.h; shadow = built.sh; host.__content = built.content; }
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
    get element() { return host ? host.__content : null; },
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
