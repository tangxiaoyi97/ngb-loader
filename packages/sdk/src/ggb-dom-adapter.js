// ggb-dom-adapter — the ONE place that knows GeoGebra's private DOM.
//
// Everything the framework reverse-engineered from GeoGebra Classic 6's live
// DOM lives here: selectors, layout metrics, and node-locating functions.
// Feature code (algebra-row / algebra-dock / self-check) must never contain a
// bare GeoGebra selector or a magic pixel constant — it asks this adapter.
//
// Versioning: selectors/metrics are grouped into PROFILES keyed by GeoGebra
// version. Adapting to a new GeoGebra release means adding a profile here —
// core logic stays untouched. Metrics are MEASURED from the live DOM whenever
// possible (a real row/marble is sampled at runtime); the profile constants are
// the fallback for headless environments and before the first row exists.

// ---------------------------------------------------------------------------
// Profiles

const CLASSIC6 = {
  id: 'classic6',
  // GeoGebra Classic 6.x (Electron desktop). The default profile.
  matches: (version) => !version || /^6\./.test(String(version)),
  selectors: {
    // The algebra object tree and one object row's anatomy:
    //   div.avItem > div.elem
    //     ├─ div.marblePanel                  (colour dot)
    //     ├─ div.checkboxPanel                (boolean rows only)
    //     ├─ div.elemText > .avPlainText      (the definition text)
    //     └─ div.algebraViewObjectStylebar    (the ⋯ menu)
    algebraView: '.algebraView, .gwt-Tree.algebraView',
    avItem: '.avItem',
    avItemClass: 'avItem',          // class TOKEN, for className walk-ups
    elem: '.elem',
    elemText: '.elemText',
    marblePanel: '.marblePanel',
    checkboxPanel: '.checkboxPanel',
    stylebar: '.algebraViewObjectStylebar',
    plainText: '.avPlainText',
    // Dock layout: each column is a .dockPanelParent; the algebra tree scroller
    // inside the left column is .algebraPanel.
    dockColumn: '.dockPanelParent',
    algebraPanel: '.algebraPanel',
  },
  metrics: {
    rowHeight: 48,        // a plain single-line object row
    ballPx: 18,           // marble ball content box (1px border → 20px rendered)
    ballBorderPx: 1,      // marble ball border width
    marblePanelPx: 58,    // native marble panel footprint (its own padding: 0 18px)
    contentIndentPx: 68,  // native content indent (58px marble + gap)
    rowRightPadPx: 40,    // room to clear the native ⋯ stylebar
  },
};

const PROFILES = [CLASSIC6];

let activeProfile = CLASSIC6;

/**
 * Pick the profile for a GeoGebra version string (e.g. applet.getVersion()).
 * Unknown versions keep the closest default (classic6) — the self-check below
 * is what decides whether that profile actually fits the live DOM.
 */
export function selectProfile(version) {
  activeProfile = PROFILES.find((p) => p.matches(version)) || CLASSIC6;
  measuredCache = new WeakMap(); // re-measure under the new profile
  return activeProfile;
}

export function getProfile() { return activeProfile; }

/** A selector (or class token) from the active profile. */
export function sel(name) { return activeProfile.selectors[name]; }

// ---------------------------------------------------------------------------
// Metrics: prefer live measurement over constants.

let measuredCache = new WeakMap(); // Document → measured metrics overlay

function plausible(v, lo, hi) { return Number.isFinite(v) && v >= lo && v <= hi; }

/**
 * Measure layout metrics from a REAL GeoGebra row in the live DOM (one we have
 * not hijacked). Returns only the values that pass sanity bounds; everything
 * else falls back to the profile constants. Cached per document.
 */
function measureFromDom(doc) {
  if (measuredCache.has(doc)) return measuredCache.get(doc);
  const out = {};
  try {
    const av = doc.querySelector(sel('algebraView'));
    if (av) {
      // Sample the first row that still has its native text (not one of ours).
      for (const item of av.querySelectorAll(sel('avItem'))) {
        if (!item.querySelector(sel('plainText'))) continue;
        const r = item.getBoundingClientRect();
        if (plausible(r.height, 30, 80)) out.rowHeight = Math.round(r.height);
        const marble = item.querySelector(sel('marblePanel'));
        if (marble) {
          const mr = marble.getBoundingClientRect();
          if (plausible(mr.width, 36, 90)) out.marblePanelPx = Math.round(mr.width);
        }
        break;
      }
    }
  } catch { /* headless */ }
  measuredCache.set(doc, out);
  return out;
}

/**
 * Effective metrics: profile constants overlaid with anything we could measure
 * from the live DOM. Safe to call any time (constants-only when headless).
 */
export function metrics() {
  const base = { ...activeProfile.metrics };
  let measured = {};
  if (typeof document !== 'undefined') measured = measureFromDom(document);
  Object.assign(base, measured);
  // Keep the derived indent consistent with whichever marble width is in effect
  // (profile gap = indent − marble width).
  if (measured.marblePanelPx) {
    const gap = activeProfile.metrics.contentIndentPx - activeProfile.metrics.marblePanelPx;
    base.contentIndentPx = measured.marblePanelPx + gap;
  }
  return base;
}

/** Drop cached measurements (e.g. after a perspective switch). */
export function invalidateMeasurements() { measuredCache = new WeakMap(); }

// ---------------------------------------------------------------------------
// Node-locating functions (the fragile know-how, centralized).

export function findAlgebraView() {
  if (typeof document === 'undefined') return null;
  return document.querySelector(sel('algebraView')) || null;
}

/** Walk up from a node to the enclosing row item (the unit GeoGebra lays out). */
export function closestAvItem(node, stopAt) {
  const token = sel('avItemClass');
  const re = new RegExp(`\\b${token}\\b`);
  let p = node;
  while (p && p !== stopAt) {
    const cls = `${(p.className && (p.className.baseVal || p.className)) || ''}`;
    if (re.test(cls)) return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Find the row GeoGebra just rendered for an object `name`, by its definition
 * text. Used ONLY at hijack time (before the text is cleared).
 */
export function findRowByName(av, name) {
  if (!av) return null;
  const labelled = av.querySelector(
    `${sel('plainText')}[aria-label^="${name} ="], ${sel('plainText')}[aria-label="${name}"]`,
  );
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

/**
 * The LEFT dock column (algebra side), distinguished from the graphics column
 * by x position relative to the main canvas.
 * @param {object} [opts] { excludeAttr } — skip columns inside our own hosts
 * @returns {{column:Element, algebraPanel:Element|null, rect:DOMRect}|null}
 */
export function findAlgebraColumn(opts = {}) {
  if (typeof document === 'undefined') return null;
  const canvas = findMainCanvasRect();
  const cutoff = canvas ? canvas.left - 8 : 9999;
  let best = null;
  for (const col of document.querySelectorAll(sel('dockColumn'))) {
    if (opts.excludeAttr && col.closest(`[${opts.excludeAttr}]`)) continue;
    const r = col.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) continue;
    if (r.left >= cutoff) continue;                 // skip the graphics column
    if (!best || r.left < best.r.left) best = { col, r };
  }
  if (!best) return null;
  const algebraPanel = best.col.querySelector(sel('algebraPanel'));
  return { column: best.col, algebraPanel: algebraPanel || null, rect: best.r };
}

export function findMainCanvasRect() {
  try {
    const rects = [...document.querySelectorAll('canvas')]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 200 && r.height > 150)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return rects[0] || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Self-check (P1-2): does the active profile actually fit the live DOM?
//
// Run before (or while) integrating with GeoGebra's UI. The contract:
//   ok          → full integration
//   rows broken → do NOT render native rows (a missing feature beats a
//                 misplaced skeleton on the host's UI)
//   view absent → row features unavailable entirely
// The check is honest about what it can't know yet: with no rows on screen,
// row anatomy is 'unknown' (not a failure).

export function selfCheck() {
  const checks = {
    algebraView: false,
    rowAnatomy: 'unknown', // 'ok' | 'broken' | 'unknown' (no rows to sample)
    dockColumn: false,
    metricsSane: true,
  };
  if (typeof document === 'undefined') {
    return { ok: false, critical: true, checks, summary: 'no DOM' };
  }
  const av = findAlgebraView();
  checks.algebraView = !!av;
  if (av) {
    const items = av.querySelectorAll(sel('avItem'));
    if (items.length > 0) {
      // Sample a native row (one with its definition text still in place).
      let sampled = null;
      for (const it of items) { if (it.querySelector(sel('plainText'))) { sampled = it; break; } }
      if (sampled) {
        const okAnatomy = !!(sampled.querySelector(sel('elemText')) && sampled.querySelector(sel('elem')));
        checks.rowAnatomy = okAnatomy ? 'ok' : 'broken';
        const r = sampled.getBoundingClientRect();
        // jsdom/headless rects are 0×0 — that's "unknown", not insane.
        if (r.height > 0 && !plausible(r.height, 24, 120)) checks.metricsSane = false;
      }
    }
  }
  checks.dockColumn = !!findAlgebraColumn();
  const ok = checks.algebraView && checks.rowAnatomy !== 'broken' && checks.metricsSane;
  const critical = !checks.algebraView;
  return {
    ok,
    critical,
    checks,
    summary: ok ? 'ok'
      : critical ? 'algebra view not found'
        : 'row anatomy mismatch — native rows disabled',
  };
}

/** Whether native-row integration should be attempted at all right now. */
export function rowsUsable() {
  const r = selfCheck();
  return r.ok || (r.checks.algebraView && r.checks.rowAnatomy === 'unknown');
}

export default {
  selectProfile, getProfile, sel, metrics, invalidateMeasurements,
  findAlgebraView, closestAvItem, findRowByName, findAlgebraColumn,
  findMainCanvasRect, selfCheck, rowsUsable,
};
