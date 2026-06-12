'use strict';

/**
 * theme-i18n.test.js — P3-1 (theme tokens + change feed) and P3-5 (i18n).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;

function haveJsdom() { try { require.resolve('jsdom'); return true; } catch { return false; } }

function makeDom(bodyBg) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><body style="background-color:${bodyBg}"></body>`, { pretendToBeVisual: true });
  const g = global;
  const saved = {
    window: g.window, document: g.document, MutationObserver: g.MutationObserver,
    getComputedStyle: g.getComputedStyle, navigator: Object.getOwnPropertyDescriptor(g, 'navigator'),
  };
  g.window = dom.window; g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return {
    window: dom.window,
    restore: () => {
      g.window = saved.window; g.document = saved.document; g.MutationObserver = saved.MutationObserver;
      g.getComputedStyle = saved.getComputedStyle;
    },
  };
}

test('themeTokens: complete light/dark sets, host font included, no mode leakage', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const sdk = await import(sdkUrl);
  const { restore } = makeDom('rgb(255,255,255)');
  try {
    const light = sdk.themeTokens('light');
    const dark = sdk.themeTokens('dark');
    for (const tk of [light, dark]) {
      for (const key of ['surface', 'surfaceAlt', 'text', 'textSub', 'border', 'primary', 'fontFamily', 'backdrop', 'shadow']) {
        assert.ok(tk[key], `${tk.mode} token "${key}" present`);
      }
    }
    assert.notStrictEqual(light.surface, dark.surface, 'surfaces differ by mode');
    assert.notStrictEqual(light.text, dark.text, 'text differs by mode');
    // auto mode follows the sampled background (white body → light)
    assert.strictEqual(sdk.themeTokens().mode, 'light');
  } finally { restore(); }
});

test('detectThemeMode + onThemeChange: a background flip fires the callback once', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const sdk = await import(sdkUrl);
  const { window, restore } = makeDom('rgb(255,255,255)');
  try {
    assert.strictEqual(sdk.detectThemeMode(), 'light');
    const seen = [];
    const unsub = sdk.onThemeChange((m) => seen.push(m), { pollMs: 30, debounceMs: 10 });
    window.document.body.style.backgroundColor = 'rgb(20,20,24)'; // switch to dark
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(seen, ['dark'], 'fired exactly once with the new mode');
    unsub();
    window.document.body.style.backgroundColor = 'rgb(255,255,255)';
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(seen, ['dark'], 'no callbacks after unsubscribe');
  } finally { restore(); }
});

test('i18n: zh GeoGebra → Chinese strings; placeholders; English fallback', async () => {
  const sdk = await import(sdkUrl);
  const dicts = {
    en: { hello: 'Hello', count: '{0} plugins', onlyEn: 'EN only' },
    'zh-CN': { hello: '你好', count: '{0} 个插件' },
  };
  const zh = sdk.makeT(dicts, 'zh-CN');
  assert.strictEqual(zh('hello'), '你好');
  assert.strictEqual(zh('count', 3), '3 个插件');
  assert.strictEqual(zh('onlyEn'), 'EN only', 'missing zh key falls back to English');
  assert.strictEqual(zh('missing'), 'missing', 'unknown key falls back to the key');
  const en = sdk.makeT(dicts, 'en');
  assert.strictEqual(en('hello'), 'Hello');
});

test('i18n: getHostLocale prefers the applet language and normalizes zh variants', { skip: !haveJsdom() && 'jsdom not installed' }, async () => {
  const sdk = await import(sdkUrl);
  const { window, restore } = makeDom('rgb(255,255,255)');
  try {
    window.ggbApplet = { getLanguage: () => 'zh_CN' };
    assert.strictEqual(sdk.getHostLocale(), 'zh-CN');
    window.ggbApplet = { getLanguage: () => 'zh-TW' };
    assert.strictEqual(sdk.getHostLocale(), 'zh-CN', 'zh variants map to zh-CN');
    window.ggbApplet = { getLanguage: () => 'de' };
    assert.strictEqual(sdk.getHostLocale(), 'en', 'unsupported languages fall back to en');
    delete window.ggbApplet;
    window.document.documentElement.lang = 'zh';
    assert.strictEqual(sdk.getHostLocale(), 'zh-CN', 'document lang is the second source');
  } finally { restore(); }
});
