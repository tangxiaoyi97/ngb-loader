// Mount a plugin panel INTO GeoGebra's algebra view (left column), pinned to the
// bottom, so it looks native. The framework owns the fragile DOM-locating so
// plugins don't reinvent it.
//
// Strategy (from the real GeoGebra Classic 6 DOM, verified):
//   - GeoGebra's left column is `.dockPanelParent` at x≈0 (the graphics column is
//     another `.dockPanelParent` at x>0). We anchor on the LEFT one.
//   - The object tree lives in `.algebraPanel` (position:relative; overflow:auto),
//     which is laid out by GWT with absolute positioning. We DO NOT change its
//     flex/display — that breaks GeoGebra's layout. Instead we:
//       * append our host as an ABSOLUTELY positioned child of the left column,
//         pinned to the bottom (left/right/bottom: 0), and
//       * reserve space for it by setting `.algebraPanel { bottom: <hostHeight> }`
//         so the tree shrinks and stays fully visible above the panel.
//   - Collapsed = a slim title bar (just the header). Expanded = up to ~45% tall.
//   - A debounced MutationObserver re-attaches across GeoGebra DOM rebuilds.
//   - Falls back to a floating panel if the algebra column isn't present.
//   - All host DOM mutations are reverted on destroy.

const HOST_ATTR = 'data-ngb-dock';
const COLLAPSED_H = 33;       // title-bar height when collapsed
const EXPANDED_FRAC = 0.45;   // expanded height as a fraction of the column
const EXPANDED_MIN = 220;
const EXPANDED_MAX = 460;

function findMainCanvasRect() {
  try {
    const rects = [...document.querySelectorAll('canvas')]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 200 && r.height > 150)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return rects[0] || null;
  } catch { return null; }
}

// The LEFT dock column (algebra side). Distinguished from the graphics column by
// x position. Returns { column, algebraPanel } or null.
function findAlgebraColumn() {
  if (typeof document === 'undefined') return null;
  const canvas = findMainCanvasRect();
  const cutoff = canvas ? canvas.left - 8 : 9999;
  let best = null;
  for (const col of document.querySelectorAll('.dockPanelParent')) {
    if (col.closest(`[${HOST_ATTR}]`)) continue;
    const r = col.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) continue;
    if (r.left >= cutoff) continue;                 // skip the graphics column
    if (!best || r.left < best.r.left) best = { col, r };
  }
  if (!best) return null;
  const algebraPanel = best.col.querySelector('.algebraPanel');
  return { column: best.col, algebraPanel: algebraPanel || null, rect: best.r };
}

export function mountInAlgebraView(opts = {}) {
  const id = opts.id || `ngb-dock-${Math.random().toString(36).slice(2, 8)}`;
  let collapsed = !!opts.collapsed;

  if (typeof document === 'undefined') {
    return { element: null, host: null, shadow: null, isDocked: () => false, setCollapsed() {}, collapsed: () => false, reattach() {}, destroy() {} };
  }

  const host = document.createElement('div');
  host.setAttribute(HOST_ATTR, id);
  const shadow = host.attachShadow({ mode: 'closed' });
  const content = document.createElement('div');
  content.style.cssText = 'all: initial; display: block; width: 100%; height: 100%; box-sizing: border-box;';
  shadow.appendChild(content);

  let column = null;            // the left dock column we're inside
  let algebraPanel = null;      // GeoGebra's tree container we reserve space in
  let savedPanelBottom = null;  // its original inline `bottom` to restore
  let docked = false;

  const hostHeight = () => (collapsed ? COLLAPSED_H : clamp(Math.round((column ? column.getBoundingClientRect().height : 600) * EXPANDED_FRAC), EXPANDED_MIN, EXPANDED_MAX));

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function applyDockedStyle() {
    const h = hostHeight();
    host.style.cssText = `all: initial; position: absolute; left: 0; right: 0; bottom: 0; height: ${h}px; z-index: 5; box-sizing: border-box; pointer-events: auto;`;
    // reserve space so the object tree doesn't sit under us
    if (algebraPanel) algebraPanel.style.bottom = `${h}px`;
  }

  function applyFloatingStyle() {
    const c = findMainCanvasRect();
    const right = c ? Math.max(12, window.innerWidth - c.right + 12) : 18;
    const h = collapsed ? COLLAPSED_H : 420;
    host.style.cssText = `all: initial; position: fixed; right: ${right}px; bottom: 22px; width: min(360px, calc(100vw - 36px)); height: ${h}px; z-index: 2147483600; box-sizing: border-box; pointer-events: auto;`;
  }

  function restorePanelSpace() {
    if (algebraPanel) {
      if (savedPanelBottom === null || savedPanelBottom === '') algebraPanel.style.removeProperty('bottom');
      else algebraPanel.style.bottom = savedPanelBottom;
    }
    algebraPanel = null;
    savedPanelBottom = null;
  }

  function attach() {
    const found = findAlgebraColumn();
    if (found && found.column) {
      // switching columns / panel → restore the old one first
      if (algebraPanel && algebraPanel !== found.algebraPanel) restorePanelSpace();
      column = found.column;
      if (found.algebraPanel && algebraPanel !== found.algebraPanel) {
        algebraPanel = found.algebraPanel;
        savedPanelBottom = algebraPanel.style.bottom || '';
      }
      if (host.parentNode !== column) column.appendChild(host);
      applyDockedStyle();
      docked = true;
    } else {
      restorePanelSpace();
      column = null;
      if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
      applyFloatingStyle();
      docked = false;
    }
  }

  // Debounced re-attach: GeoGebra rebuilds its DOM a lot during boot, which would
  // otherwise cause flicker. Coalesce bursts and skip work when nothing changed.
  let observer = null;
  let timer = null;
  let lastSig = '';
  const signature = () => {
    const r = column ? column.getBoundingClientRect() : null;
    return `${docked}|${host.isConnected}|${r ? `${Math.round(r.left)},${Math.round(r.height)}` : 'none'}`;
  };
  const scheduleReattach = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const wasDocked = docked;
      // re-attach only if our host fell out, or the column geometry changed
      if (!host.isConnected || signature() !== lastSig || !docked) {
        attach();
        lastSig = signature();
      }
      if (wasDocked !== docked && typeof opts.onDockChange === 'function') {
        try { opts.onDockChange(docked); } catch { /* ignore */ }
      }
    }, 120);
  };
  try {
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // ignore mutations we caused (inside our own host)
        if (m.target && m.target.closest && m.target.closest(`[${HOST_ATTR}]`)) continue;
        if ([...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1)) { scheduleReattach(); break; }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch { /* unavailable in tests */ }

  attach();
  lastSig = signature();

  return {
    element: content,
    host,
    shadow,
    isDocked: () => docked,
    collapsed: () => collapsed,
    setCollapsed(v) {
      collapsed = !!v;
      if (docked) applyDockedStyle(); else applyFloatingStyle();
    },
    reattach: attach,
    destroy() {
      try { if (observer) observer.disconnect(); } catch { /* ignore */ }
      if (timer) clearTimeout(timer);
      restorePanelSpace();
      if (host.parentNode) host.parentNode.removeChild(host);
    },
  };
}

export default mountInAlgebraView;
