'use strict';

/**
 * dom-adapter.test.js — P1-1/P1-2: the centralized GeoGebra DOM adapter
 * (profiles, metrics fallback, locators) and the self-check that gates
 * integration / drives graceful degradation.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const adapterUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'ggb-dom-adapter.js')).href;

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function withDom(html, fn) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const g = global;
  const saved = { window: g.window, document: g.document, NodeFilter: g.NodeFilter, getComputedStyle: g.getComputedStyle };
  g.window = dom.window; g.document = dom.window.document; g.NodeFilter = dom.window.NodeFilter;
  try { return fn(dom.window); } finally { Object.assign(g, saved); }
}

const GOOD_ROW = `
  <div class="dockPanelParent" style="width:300px;height:600px">
    <div class="algebraPanel">
      <div class="gwt-Tree algebraView">
        <div class="avItem"><div class="elem">
          <div class="marblePanel"></div>
          <div class="elemText"><div class="avPlainText" aria-label="a = 1">a = 1</div></div>
        </div></div>
      </div>
    </div>
  </div>`;

const BROKEN_ROW = `
  <div class="gwt-Tree algebraView">
    <div class="avItem"><div class="someNewLayout">
      <div class="avPlainText" aria-label="a = 1">a = 1</div>
    </div></div>
  </div>`;

test('profile selection: classic6 is the default and matches 6.x', async () => {
  const adapter = await import(adapterUrl);
  assert.strictEqual(adapter.selectProfile('6.0.871.0').id, 'classic6');
  assert.strictEqual(adapter.selectProfile(null).id, 'classic6');
  assert.strictEqual(adapter.selectProfile('99.0').id, 'classic6', 'unknown versions keep the default profile');
  assert.strictEqual(adapter.getProfile().id, 'classic6');
});

test('metrics: profile constants when nothing can be measured (headless-safe)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const adapter = await import(adapterUrl);
  withDom('<!doctype html><body></body>', () => {
    const m = adapter.metrics();
    assert.strictEqual(m.rowHeight, 48);
    assert.strictEqual(m.ballPx, 18);
    assert.strictEqual(m.marblePanelPx, 58);
    assert.strictEqual(m.contentIndentPx, 68);
  });
});

test('selfCheck: ok on a healthy classic6 DOM', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const adapter = await import(adapterUrl);
  withDom(`<!doctype html><body>${GOOD_ROW}</body>`, () => {
    const r = adapter.selfCheck();
    assert.strictEqual(r.checks.algebraView, true);
    assert.strictEqual(r.checks.rowAnatomy, 'ok');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(adapter.rowsUsable(), true);
  });
});

test('selfCheck: broken row anatomy is detected (and rows become unusable)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const adapter = await import(adapterUrl);
  withDom(`<!doctype html><body>${BROKEN_ROW}</body>`, () => {
    const r = adapter.selfCheck();
    assert.strictEqual(r.checks.algebraView, true);
    assert.strictEqual(r.checks.rowAnatomy, 'broken');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.critical, false, 'view exists, so not critical — but no row rendering');
    assert.strictEqual(adapter.rowsUsable(), false);
  });
});

test('selfCheck: missing algebra view is critical; empty view is unknown (not a failure)', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const adapter = await import(adapterUrl);
  withDom('<!doctype html><body><p>not geogebra</p></body>', () => {
    const r = adapter.selfCheck();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.critical, true);
  });
  withDom('<!doctype html><body><div class="gwt-Tree algebraView"></div></body>', () => {
    const r = adapter.selfCheck();
    assert.strictEqual(r.checks.rowAnatomy, 'unknown');
    assert.strictEqual(r.ok, true, 'no rows yet — assume the profile until proven otherwise');
    assert.strictEqual(adapter.rowsUsable(), true);
  });
});

test('locators: findRowByName + closestAvItem via the active profile', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const adapter = await import(adapterUrl);
  withDom(`<!doctype html><body>${GOOD_ROW}</body>`, (window) => {
    const av = adapter.findAlgebraView();
    assert.ok(av, 'algebra view found');
    const row = adapter.findRowByName(av, 'a');
    assert.ok(row && /\bavItem\b/.test(row.className), 'row located by aria-label');
    const text = window.document.querySelector('.avPlainText');
    assert.strictEqual(adapter.closestAvItem(text, av), row, 'walk-up reaches the same row');
  });
});
