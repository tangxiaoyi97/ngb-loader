'use strict';

/**
 * shared-observer.test.js — P1-3: ONE MutationObserver per document regardless
 * of subscriber count; dispatch fan-out; teardown when the last subscriber
 * leaves; integration with native rows (N rows → 1 observer).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const observerUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'shared-observer.js')).href;

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function makeDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, NodeFilter: g.NodeFilter };
  g.window = dom.window; g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver; g.NodeFilter = dom.window.NodeFilter;
  return { window: dom.window, restore: () => Object.assign(g, saved) };
}

test('many subscribers share exactly one observer; last unsubscribe disconnects it', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { subscribeDom, observerCount, subscriberCount } = await import(observerUrl);
  const { window, restore } = makeDom();
  try {
    const doc = window.document;
    const unsubs = [];
    for (let i = 0; i < 8; i += 1) unsubs.push(subscribeDom(() => {}, doc));
    assert.strictEqual(observerCount(doc), 1, '8 subscribers → 1 observer');
    assert.strictEqual(subscriberCount(doc), 8);
    for (const u of unsubs.slice(0, 7)) u();
    assert.strictEqual(observerCount(doc), 1, 'still one observer while a subscriber remains');
    unsubs[7]();
    assert.strictEqual(observerCount(doc), 0, 'last unsubscribe disconnects the observer');
    unsubs[7](); // double-unsubscribe is a no-op
    assert.strictEqual(subscriberCount(doc), 0);
  } finally { restore(); }
});

test('mutations are dispatched to all subscribers; one throwing does not break the rest', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { subscribeDom } = await import(observerUrl);
  const { window, restore } = makeDom();
  try {
    const doc = window.document;
    let aCalls = 0; let bCalls = 0;
    const u1 = subscribeDom(() => { aCalls += 1; throw new Error('boom'); }, doc);
    const u2 = subscribeDom((muts) => { bCalls += 1; assert.ok(muts.length >= 1); }, doc);
    doc.body.appendChild(doc.createElement('div'));
    await new Promise((r) => setTimeout(r, 20)); // let the observer flush
    assert.ok(aCalls >= 1, 'first subscriber notified');
    assert.ok(bCalls >= 1, 'second subscriber notified despite the first throwing');
    u1(); u2();
  } finally { restore(); }
});

test('N native rows share a single observer (the P1-3 acceptance check)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const { observerCount } = await import(observerUrl);
  const { window, restore } = makeDom();
  try {
    const doc = window.document;
    // Minimal fake GeoGebra (mirrors algebra-row.test.js).
    const av = doc.createElement('div');
    av.className = 'gwt-Tree algebraView';
    doc.body.appendChild(av);
    const objects = new Map();
    const ggb = {
      evalCommand(cmd) {
        const m = String(cmd).match(/^(\w+)\s*=\s*(.+)$/);
        if (!m) return false;
        const [, name, def] = m;
        if (objects.has(name)) return true;
        const item = doc.createElement('div'); item.className = 'avItem';
        const elem = doc.createElement('div'); elem.className = 'elem';
        const marble = doc.createElement('div'); marble.className = 'marblePanel';
        const text = doc.createElement('div'); text.className = 'elemText';
        const plain = doc.createElement('div'); plain.className = 'avPlainText';
        plain.setAttribute('aria-label', `${name} = ${def}`); plain.textContent = `${name} = ${def}`;
        text.appendChild(plain); elem.append(marble, text); item.appendChild(elem); av.appendChild(item);
        objects.set(name, item); return true;
      },
      setVisible() {}, setAuxiliary() {},
      deleteObject(name) { const r = objects.get(name); if (r && r.parentNode) r.parentNode.removeChild(r); objects.delete(name); },
      registerRemoveListener() {}, unregisterRemoveListener() {},
    };
    const { createNativeRow } = require('../../packages/sdk/src/algebra-row.js');
    const handles = [];
    for (let i = 0; i < 6; i += 1) handles.push(createNativeRow({ applet: ggb, name: `multi${i}` }));
    assert.ok(handles.every((h) => h.isAlive()), 'all rows attached');
    assert.strictEqual(observerCount(doc), 1, '6 rows → exactly 1 MutationObserver');
    for (const h of handles) h.destroy();
    assert.strictEqual(observerCount(doc), 0, 'destroying all rows releases the observer');
  } finally { restore(); }
});
