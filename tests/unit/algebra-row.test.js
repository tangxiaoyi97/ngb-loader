'use strict';

/**
 * algebra-row.test.js — createNativeRow hijacks a GeoGebra-rendered object row.
 * We fake a minimal ggbApplet whose evalCommand("name=true") appends an .avItem
 * row (mirroring GeoGebra Classic 6's structure), then assert the framework
 * takes over the .elemText content area, hides GeoGebra's own bits, reroutes the
 * remove event, and cleans up on destroy. Runs in jsdom.
 */
const test = require('node:test');
const assert = require('node:assert');

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function withDom(fn) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter, setTimeout: g.setTimeout };
  g.window = window; g.document = window.document;
  g.MutationObserver = window.MutationObserver;
  g.NodeFilter = window.NodeFilter;
  try { return fn(window); }
  finally { Object.assign(g, saved); }
}

// A fake GeoGebra applet: keeps a list of objects and renders rows into an
// `.algebraView` exactly like GeoGebra does (avItem > elem > marble/checkbox/
// elemText/stylebar). evalCommand("<name>=true") creates a boolean row.
function makeFakeGgb(window) {
  const d = window.document;
  const av = d.createElement('div');
  av.className = 'gwt-Tree algebraView';
  d.body.appendChild(av);
  const objects = new Map();
  const removeListeners = [];

  function renderRow(name, def) {
    const item = d.createElement('div');
    item.className = 'avItem';
    const elem = d.createElement('div'); elem.className = 'elem checkboxElem';
    const marble = d.createElement('div'); marble.className = 'marblePanel';
    const checkbox = d.createElement('div'); checkbox.className = 'checkboxPanel';
    const text = d.createElement('div'); text.className = 'elemText noPadding';
    const plain = d.createElement('div'); plain.className = 'avPlainText av-focusablePart';
    plain.setAttribute('aria-label', `${name} = ${def}`);
    plain.textContent = `${name} = ${def}`;
    text.appendChild(plain);
    const stylebar = d.createElement('div'); stylebar.className = 'algebraViewObjectStylebar';
    elem.append(marble, checkbox, text, stylebar);
    item.appendChild(elem);
    av.appendChild(item);
    return item;
  }

  return {
    _av: av,
    evalCommand(cmd) {
      const m = String(cmd).match(/^(\w+)\s*=\s*(.+)$/);
      if (!m) return false;
      const [, name, def] = m;
      if (!objects.has(name)) { const row = renderRow(name, def); objects.set(name, row); }
      return true;
    },
    setVisible() {},
    setAuxiliary() {},
    deleteObject(name) {
      const row = objects.get(name);
      if (row && row.parentNode) row.parentNode.removeChild(row);
      objects.delete(name);
      for (const fn of removeListeners) { try { fn(name); } catch { /* ignore */ } }
    },
    registerRemoveListener(fn) { removeListeners.push(fn); },
    unregisterRemoveListener(fn) { const i = removeListeners.indexOf(fn); if (i >= 0) removeListeners.splice(i, 1); },
    _fireRemove(name) { for (const fn of removeListeners) fn(name); },
  };
}

test('hijacks a native object row: takes over .elemText, hides GeoGebra bits', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    const handle = createNativeRow({ applet: ggb, name: 'ngbUItest' });

    assert.ok(handle.isAlive(), 'should be alive after hijacking the rendered row');
    assert.strictEqual(handle.objectName, 'ngbUItest');
    // our content node is inside the row's .elemText
    assert.ok(handle.element, 'exposes a content element');
    const row = ggb._av.querySelector('[data-ngb-row="ngbUItest"]');
    assert.ok(row, 'row is marked as ours');
    // GeoGebra's own bits are hidden
    assert.strictEqual(row.querySelector('.marblePanel').style.display, 'none');
    assert.strictEqual(row.querySelector('.checkboxPanel').style.display, 'none');
    assert.strictEqual(row.querySelector('.algebraViewObjectStylebar').style.display, 'none');
    // the original definition text is gone (we cleared .elemText and put our host)
    assert.ok(!row.textContent.includes('ngbUItest = true'), 'GeoGebra text replaced');
    assert.ok(row.querySelector('[data-ngb-container="ngbUItest"]'), 'our host is mounted');

    handle.destroy();
    assert.ok(!handle.isAlive(), 'not alive after destroy');
    assert.ok(!ggb._av.querySelector('[data-ngb-row="ngbUItest"]'), 'row removed (object deleted) on destroy');
  });
});

test('hybrid mode: keeps marble + stylebar, routes marble click to plugin, prevents native', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    // Simulate GeoGebra's own marble handler (native show/hide).
    let nativeMarbleRan = false;
    let pluginMarbleRan = false;
    const handle = createNativeRow({
      applet: ggb, name: 'ngbHyb', mode: 'hybrid',
      onMarbleClick: () => { pluginMarbleRan = true; },
    });
    assert.strictEqual(handle.mode, 'hybrid');
    const row = ggb._av.querySelector('[data-ngb-row="ngbHyb"]');
    const marble = row.querySelector('.marblePanel');
    const stylebar = row.querySelector('.algebraViewObjectStylebar');
    // marble + stylebar are KEPT (not hidden) in hybrid mode
    assert.notStrictEqual(marble.style.display, 'none', 'marble kept');
    assert.notStrictEqual(stylebar.style.display, 'none', 'stylebar (⋯ menu) kept');
    // our content host still mounted in the text area
    assert.ok(row.querySelector('[data-ngb-container="ngbHyb"]'), 'content host mounted');

    // Attach a native handler AFTER ours to confirm ours stops propagation/default.
    marble.addEventListener('click', () => { nativeMarbleRan = true; });
    marble.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.ok(pluginMarbleRan, 'plugin onMarbleClick fired');
    assert.ok(!nativeMarbleRan, 'native marble behavior prevented (stopImmediatePropagation)');
    handle.destroy();
  });
});

test('hybrid mode: exposes a plugin-controlled marble slot (override has none)', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    const hy = createNativeRow({ applet: ggb, name: 'ngbMarbleSlot', mode: 'hybrid' });
    assert.ok(hy.marble, 'hybrid exposes a marble slot element');
    // plugin can render into it
    const dot = window.document.createElement('span');
    hy.marble.appendChild(dot);
    assert.ok(hy.marble.contains(dot), 'plugin content mounts in the marble slot');
    hy.destroy();

    const ov = createNativeRow({ applet: ggb, name: 'ngbNoMarble', mode: 'override' });
    assert.strictEqual(ov.marble, null, 'override has no marble slot');
    ov.destroy();
  });
});

test('readGgbTheme returns GeoGebra tokens (or safe fallbacks)', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom(() => {
    const { readGgbTheme } = require('../../packages/sdk/src/algebra-row.js');
    const t = readGgbTheme();
    assert.ok(t && typeof t === 'object');
    // fallbacks must be present even without GeoGebra's stylesheet in jsdom
    assert.ok(/^#|rgb/.test(t.primary), 'primary color present');
    assert.ok(t.fontFamily && t.fontFamily.length > 0, 'fontFamily present');
    assert.ok(t.selection, 'selection token present');
  });
});

test('frees the row height so content drives it, and restores styles on destroy', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    // Pre-set a one-line height constraint like GeoGebra would.
    const seedRow = () => ggb._av.querySelector('.avItem');
    const handle = createNativeRow({ applet: ggb, name: 'ngbUIh' });
    const row = ggb._av.querySelector('[data-ngb-row="ngbUIh"]');
    const elem = row.querySelector('.elem');
    const content = row.querySelector('.elemText');

    // Height: content can grow (height:auto) but the row keeps a native-matching
    // MIN height so a short row isn't shorter than GeoGebra's own rows.
    assert.strictEqual(row.style.height, 'auto');
    assert.match(row.style.minHeight, /^\d+px$/, 'row has a px min-height (native-matching)');
    assert.strictEqual(row.style.overflow, 'visible');
    assert.match(elem.style.minHeight, /^\d+px$/, 'elem has a px min-height');
    assert.strictEqual(content.style.height, 'auto');

    handle.destroy();
    // After destroy the inline styles we added are gone (restored to original '').
    assert.strictEqual(row.style.height, '');
    assert.strictEqual(row.style.minHeight, '');
    assert.strictEqual(content.style.height, '');
  });
});

test('isolates events: clicks inside the container do not reach GeoGebra (the row), but work internally', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    const handle = createNativeRow({ applet: ggb, name: 'ngbUIevt' });
    const row = ggb._av.querySelector('[data-ngb-row="ngbUIevt"]');

    // Simulate GeoGebra's mid-bubble listener on the .avItem row.
    let geogebraSawIt = false;
    row.addEventListener('click', () => { geogebraSawIt = true; });

    // Put an interactive element inside our content and listen on it.
    let buttonSawIt = false;
    const btn = window.document.createElement('button');
    btn.addEventListener('click', () => { buttonSawIt = true; });
    handle.element.appendChild(btn);

    // Click the button — event bubbles out of the (closed) shadow toward the row.
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));

    assert.ok(buttonSawIt, 'our own button handler still fires');
    assert.ok(!geogebraSawIt, "GeoGebra's row listener does NOT fire (event isolated at the host)");
    handle.destroy();
  });
});

test('reroutes GeoGebra remove: deleting the object tears the container down', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    let removedCbRan = false;
    const handle = createNativeRow({ applet: ggb, name: 'ngbUIremove', onRemoved: () => { removedCbRan = true; } });
    assert.ok(handle.isAlive());

    // Simulate the user deleting the object in GeoGebra.
    ggb.deleteObject('ngbUIremove');
    assert.ok(removedCbRan, 'onRemoved callback fired');
    assert.ok(!handle.isAlive(), 'container marked dead after GeoGebra removed the object');
  });
});

test('no applet yet → handle waits (not alive), destroy stops polling, never throws', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom(() => {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    // No applet provided and no window.ggbApplet: it must NOT fall back to inert
    // immediately (GeoGebra wires its API late) — it waits. It just never attaches.
    const handle = createNativeRow({ applet: null });
    assert.strictEqual(handle.isAlive(), false);
    assert.strictEqual(handle.element, null);
    assert.ok(handle.objectName, 'still has a backing object name so the caller keeps the row');
    assert.doesNotThrow(() => handle.destroy()); // stops the waitForApplet poll
  });
});

test('applet arrives late → handle attaches once it becomes ready', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  // async-aware DOM setup (withDom is sync-only): keep globals live across awaits.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter };
  g.window = window; g.document = window.document; g.MutationObserver = window.MutationObserver; g.NodeFilter = window.NodeFilter;
  try {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    // Expose the applet on window only AFTER creating the handle, simulating
    // GeoGebra's async API wiring. waitForApplet polls window.ggbApplet.
    const handle = createNativeRow({ name: 'ngbUIlate' }); // no applet passed
    assert.strictEqual(handle.isAlive(), false, 'not attached before applet exists');
    window.ggbApplet = ggb;
    await new Promise((r) => setTimeout(r, 320)); // past poll (80ms) + attach retries (60ms)
    assert.ok(handle.isAlive(), 'attached after applet became available');
    assert.ok(ggb._av.querySelector('[data-ngb-row="ngbUIlate"]'), 'hijacked the row');
    handle.destroy();
  } finally {
    Object.assign(g, saved);
  }
});
