'use strict';

/**
 * terminal.test.js — the on-disk log mirror. We don't actually spawn a GUI
 * terminal in CI; we verify append/banner write the file and openTail is
 * non-throwing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TerminalLog } = require('../../packages/desktop/src/terminal');

test('append + banner write formatted lines to the log file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-term-'));
  const t = new TerminalLog(dir);
  t.banner('Inject');
  t.append({ level: 'ok', msg: 'hello world', ts: Date.now() });
  t.append({ level: 'warn', msg: 'careful' });
  const text = fs.readFileSync(t.file, 'utf8');
  assert.match(text, /===== Inject/);
  assert.match(text, /OK\s+hello world/);
  assert.match(text, /WARN\s+careful/);
});

test('banner truncates a previous session (no stale DONE sentinel)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-term3-'));
  const t = new TerminalLog(dir);
  t.banner('Inject');
  t.append({ level: 'ok', msg: 'first run' });
  t.done(true);
  assert.match(fs.readFileSync(t.file, 'utf8'), /__NEOGEBRA_DONE__/);
  // a new session must start clean — old DONE gone
  t.banner('Restore');
  const text = fs.readFileSync(t.file, 'utf8');
  assert.ok(!text.includes('__NEOGEBRA_DONE__'), 'old sentinel cleared');
  assert.ok(!text.includes('first run'), 'old content cleared');
  assert.match(text, /===== Restore/);
});

test('done() writes the sentinel the terminal watches for', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-term4-'));
  const t = new TerminalLog(dir);
  t.banner('Inject');
  t.done(true);
  assert.match(fs.readFileSync(t.file, 'utf8'), /__NEOGEBRA_DONE__\n?$/);
});

test('openTail is non-throwing and ensures the file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-term2-'));
  const t = new TerminalLog(dir);
  const r = t.openTail(); // may spawn nothing useful in CI, but must not throw
  assert.ok(r && typeof r.ok === 'boolean');
  assert.ok(fs.existsSync(t.file), 'log file created');
});
