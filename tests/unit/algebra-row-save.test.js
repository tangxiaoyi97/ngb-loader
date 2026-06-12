'use strict';

/**
 * algebra-row-save.test.js — P0-3: framework helper objects must never reach a
 * saved/exported document. The SDK hooks the applet's export methods and
 * removes helper objects for the duration of serialization, then recreates
 * them (rows stay alive — the save cycle is not a user deletion).
 */

const test = require('node:test');
const assert = require('node:assert');

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function makeDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter };
  g.window = window; g.document = window.document;
  g.MutationObserver = window.MutationObserver; g.NodeFilter = window.NodeFilter;
  return { window, restore: () => Object.assign(g, saved) };
}

// Fake applet: keeps an object map, renders algebra rows, and "serializes" by
// listing the current object names (so the test can see exactly what a saved
// .ggb would contain).
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
    const elem = d.createElement('div'); elem.className = 'elem';
    const marble = d.createElement('div'); marble.className = 'marblePanel';
    const text = d.createElement('div'); text.className = 'elemText';
    const plain = d.createElement('div'); plain.className = 'avPlainText';
    plain.setAttribute('aria-label', `${name} = ${def}`);
    plain.textContent = `${name} = ${def}`;
    text.appendChild(plain);
    elem.append(marble, text);
    item.appendChild(elem);
    av.appendChild(item);
    return item;
  }

  return {
    _av: av,
    _names: () => [...objects.keys()],
    evalCommand(cmd) {
      const m = String(cmd).match(/^(\w+)\s*=\s*(.+)$/);
      if (!m) return false;
      const [, name, def] = m;
      if (!objects.has(name)) objects.set(name, renderRow(name, def));
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
    // "Serialization": a stable snapshot of the construction's object names.
    getBase64(...args) {
      const cb = args.find((a) => typeof a === 'function');
      const payload = `ggb:${[...objects.keys()].sort().join(',')}`;
      if (cb) { cb(payload); return undefined; }
      return payload;
    },
    getXML(name) {
      if (typeof name === 'string') return `<element label="${name}"/>`;
      return `<construction>${[...objects.keys()].sort().join(',')}</construction>`;
    },
  };
}

test('saved document (getBase64) contains user objects but NO framework helpers', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  const { window, restore } = makeDom();
  try {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    ggb.evalCommand('userPoint=(1,2)'); // a real user object

    let removedFired = false;
    const handle = createNativeRow({ applet: ggb, name: 'helperRowA', onRemoved: () => { removedFired = true; } });
    assert.ok(handle.isAlive(), 'row attached');
    assert.ok(ggb._names().includes('helperRowA'), 'helper object exists in the live construction');

    // SYNC save
    const saved = ggb.getBase64();
    assert.ok(saved.includes('userPoint'), 'user object saved');
    assert.ok(!saved.includes('helperRowA'), 'helper object NOT in the saved document');

    // After saving, the helper is back and the row was not treated as deleted.
    assert.ok(ggb._names().includes('helperRowA'), 'helper recreated after save');
    assert.strictEqual(removedFired, false, 'save cycle did not fire onRemoved');
    handle.destroy();
  } finally { restore(); }
});

test('async getBase64(callback) form is sanitized too, and helpers restore after the callback', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { window, restore } = makeDom();
  try {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    ggb.evalCommand('slider1=1');
    const handle = createNativeRow({ applet: ggb, name: 'helperRowB' });

    const saved = await new Promise((resolve) => ggb.getBase64(resolve));
    assert.ok(saved.includes('slider1'), 'user object saved');
    assert.ok(!saved.includes('helperRowB'), 'helper object NOT in the async-saved document');
    assert.ok(ggb._names().includes('helperRowB'), 'helper recreated after the callback');
    handle.destroy();
  } finally { restore(); }
});

test('full-construction getXML is sanitized; single-object getXML(name) passes through', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  const { window, restore } = makeDom();
  try {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    ggb.evalCommand('f=x^2');
    const handle = createNativeRow({ applet: ggb, name: 'helperRowC' });

    const xml = ggb.getXML();
    assert.ok(xml.includes('f'), 'user object in construction XML');
    assert.ok(!xml.includes('helperRowC'), 'helper not in construction XML');
    assert.ok(ggb._names().includes('helperRowC'), 'helper recreated');

    // Single-object query is not a document export — untouched.
    assert.strictEqual(ggb.getXML('f'), '<element label="f"/>');
    handle.destroy();
  } finally { restore(); }
});

test('after destroy() the helper is unregistered: save hook becomes a pass-through', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  const { window, restore } = makeDom();
  try {
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    const handle = createNativeRow({ applet: ggb, name: 'helperRowD' });
    handle.destroy();
    assert.ok(!ggb._names().includes('helperRowD'), 'helper deleted on destroy');
    // Saving now must not resurrect the destroyed helper.
    ggb.getBase64();
    assert.ok(!ggb._names().includes('helperRowD'), 'destroyed helper not resurrected by a save');
  } finally { restore(); }
});

test('row survives a save cycle: still alive and re-attached to the recreated row', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { window, restore } = makeDom();
  try {
    const { createNativeRow, __internals } = require('../../packages/sdk/src/algebra-row.js');
    const ggb = makeFakeGgb(window);
    const handle = createNativeRow({ applet: ggb, name: 'helperRowE' });
    assert.ok(handle.isAlive());

    ggb.getBase64(); // save cycle: delete + recreate under the hood
    // The MutationObserver re-hijack is debounced (~150ms).
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(handle.isAlive(), 'row still alive after the save cycle');
    assert.ok(ggb._av.querySelector(`[${__internals.ROW_ATTR}="helperRowE"]`), 're-hijacked the recreated row');
    handle.destroy();
  } finally { restore(); }
});
