// shared-observer — ONE MutationObserver per document, fanned out to
// subscribers (P1-3). Native rows and docks used to each mount their own
// subtree observer on the whole tree; with many rows that becomes an observer
// storm that can visibly slow GeoGebra. Here the framework watches the tree
// once and dispatches the same mutation batch to every subscriber; subscribers
// keep their own (already debounced) reaction logic.

const registries = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

function registryFor(doc) {
  let reg = registries.get(doc);
  if (!reg) {
    reg = { observer: null, subs: new Set() };
    registries.set(doc, reg);
  }
  return reg;
}

/**
 * Subscribe to DOM mutations (childList, subtree) of the whole document.
 * The first subscriber creates the single observer; the last one leaving
 * disconnects it. Subscriber errors are isolated.
 *
 * @param {(mutations: MutationRecord[]) => void} cb
 * @param {Document} [doc]
 * @returns {() => void} unsubscribe
 */
export function subscribeDom(cb, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !registries || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const reg = registryFor(d);
  if (!reg.observer) {
    try {
      reg.observer = new MutationObserver((mutations) => {
        for (const fn of [...reg.subs]) {
          try { fn(mutations); } catch { /* subscriber errors are isolated */ }
        }
      });
      reg.observer.observe(d.documentElement || d.body || d, { childList: true, subtree: true });
    } catch {
      reg.observer = null;
      return () => {};
    }
  }
  reg.subs.add(cb);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    reg.subs.delete(cb);
    if (reg.subs.size === 0 && reg.observer) {
      try { reg.observer.disconnect(); } catch { /* ignore */ }
      reg.observer = null;
    }
  };
}

/** Number of live observers for a document (tests/diagnostics). */
export function observerCount(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !registries) return 0;
  const reg = registries.get(d);
  return reg && reg.observer ? 1 : 0;
}

/** Number of subscribers for a document (tests/diagnostics). */
export function subscriberCount(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !registries) return 0;
  const reg = registries.get(d);
  return reg ? reg.subs.size : 0;
}

export default subscribeDom;
