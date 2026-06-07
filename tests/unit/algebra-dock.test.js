'use strict';

/**
 * algebra-dock.test.js — mountInAlgebraView docks into a GeoGebra-like DOM,
 * falls back to floating when the algebra panel is absent, collapses, and
 * restores the host on destroy. Runs in jsdom.
 */
const test = require('node:test');
const assert = require('node:assert');

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function withDom(fn) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const g = global;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver, requestAnimationFrame: g.requestAnimationFrame, NodeFilter: g.NodeFilter, getComputedStyle: g.getComputedStyle };
  g.window = window; g.document = window.document;
  g.MutationObserver = window.MutationObserver;
  g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  g.getComputedStyle = window.getComputedStyle.bind(window);
  try { return fn(window); }
  finally { Object.assign(g, saved); }
}

// jsdom has no real layout; stub getBoundingClientRect per element via dataset.
function rectFor(el) {
  const r = el.__rect || { x: 0, y: 0, w: 0, h: 0 };
  return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y };
}

function buildGeoGebraDom(window) {
  const d = window.document;
  // canvas at x=388 (graphics column)
  const canvas = d.createElement('canvas');
  canvas.__rect = { x: 388, y: 53, w: 1236, h: 714 };
  d.body.appendChild(canvas);
  // LEFT dock column at x=0 (matches GeoGebra: .dockPanelParent)
  const column = d.createElement('div');
  column.className = 'dockPanelParent';
  column.__rect = { x: 0, y: 53, w: 380, h: 935 };
  // the object-tree container GeoGebra scrolls (we reserve space in it)
  const panel = d.createElement('div');
  panel.className = 'algebraPanel';
  panel.__rect = { x: 0, y: 53, w: 380, h: 935 };
  column.appendChild(panel);
  d.body.appendChild(column);
  // the GRAPHICS column at x=388 — must NOT be chosen
  const graphics = d.createElement('div');
  graphics.className = 'dockPanelParent';
  graphics.__rect = { x: 388, y: 53, w: 1236, h: 935 };
  d.body.appendChild(graphics);
  window.Element.prototype.getBoundingClientRect = function () { return rectFor(this); };
  Object.defineProperty(window, 'innerWidth', { value: 1624, configurable: true });
  return { canvas, column, panel, graphics };
}

test('docks into the LEFT dock column, pinned to the bottom, reserving tree space', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { mountInAlgebraView } = require('../../packages/sdk/src/algebra-dock.js');
    const { column, panel, graphics } = buildGeoGebraDom(window);
    const dock = mountInAlgebraView({ id: 'test' });
    assert.strictEqual(dock.isDocked(), true, 'should dock');
    assert.strictEqual(dock.host.parentNode, column, 'host appended into the LEFT dock column');
    assert.notStrictEqual(dock.host.parentNode, graphics, 'NOT the graphics column');
    assert.match(dock.host.style.position, /absolute/, 'absolutely positioned');
    assert.strictEqual(dock.host.style.bottom, '0px', 'pinned to the bottom');
    // GeoGebra layout is NOT made flex; we only reserve bottom space on the panel
    assert.strictEqual(panel.style.display, '', 'algebraPanel display untouched');
    assert.ok(panel.style.bottom && /px$/.test(panel.style.bottom), 'tree space reserved via bottom');
    dock.destroy();
    assert.ok(!dock.host.parentNode, 'host removed on destroy');
    assert.ok(!panel.style.bottom, 'reserved space restored on destroy');
  });
});

test('falls back to floating when there is no algebra column', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { mountInAlgebraView } = require('../../packages/sdk/src/algebra-dock.js');
    const c = window.document.createElement('canvas');
    c.__rect = { x: 0, y: 0, w: 1200, h: 700 };
    window.document.body.appendChild(c);
    window.Element.prototype.getBoundingClientRect = function () { return rectFor(this); };
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

    const dock = mountInAlgebraView({ id: 'float' });
    assert.strictEqual(dock.isDocked(), false, 'not docked');
    assert.strictEqual(dock.host.parentNode, window.document.documentElement, 'floats on <html>');
    assert.match(dock.host.style.position, /fixed/);
    dock.destroy();
  });
});

test('collapse shrinks the host height; setCollapsed toggles', { skip: !haveJsdom() && 'jsdom not installed' }, () => {
  withDom((window) => {
    const { mountInAlgebraView } = require('../../packages/sdk/src/algebra-dock.js');
    const { panel } = buildGeoGebraDom(window);
    const dock = mountInAlgebraView({ id: 'c', collapsed: true });
    assert.strictEqual(dock.collapsed(), true);
    const collapsedH = parseInt(dock.host.style.height, 10);
    assert.ok(collapsedH > 0 && collapsedH <= 40, 'collapsed = slim bar');
    assert.strictEqual(panel.style.bottom, `${collapsedH}px`, 'reserved space matches collapsed height');
    dock.setCollapsed(false);
    const expandedH = parseInt(dock.host.style.height, 10);
    assert.ok(expandedH > collapsedH, 'expands taller');
    dock.destroy();
  });
});
