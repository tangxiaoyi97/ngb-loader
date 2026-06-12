'use strict';

/**
 * state-concurrency.test.js — P0-4: state.json atomic writes + cross-process
 * read-modify-write safety.
 *
 * Verifies: tmp+rename atomic write, .bak fallback on a corrupted file, and a
 * multi-process stress run (several children doing locked updateState cycles
 * concurrently) ending with valid JSON and ZERO lost updates.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');

const MAIN = path.join(__dirname, '..', '..', 'packages', 'proxy-core', 'src', 'main.js');
const proxy = require(MAIN);

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-state-'));
  return path.join(dir, 'state.json');
}

test('writeState is atomic: no .tmp leftovers, file always valid JSON', () => {
  const stateFile = tmpState();
  assert.ok(proxy.writeState(stateFile, { version: 1, enabled: { a: true }, settings: {} }));
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(parsed.enabled.a, true);
  const leftovers = fs.readdirSync(path.dirname(stateFile)).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'no temp files left behind');
});

test('readState falls back to .bak when state.json is corrupted', () => {
  const stateFile = tmpState();
  proxy.writeState(stateFile, { version: 1, enabled: {}, settings: { keep: 'me' } });
  // Second write creates the .bak of the first; then corrupt the live file.
  proxy.writeState(stateFile, { version: 1, enabled: {}, settings: { keep: 'me', more: 1 } });
  fs.writeFileSync(stateFile, '{"version":1,"enab'); // half-written JSON
  const recovered = proxy.readState(stateFile);
  assert.strictEqual(recovered.settings.keep, 'me', 'recovered from .bak instead of resetting');
});

test('updateState holds a lock: re-reads fresh state so updates are not lost in-process', () => {
  const stateFile = tmpState();
  proxy.writeState(stateFile, { version: 1, enabled: {}, settings: {} });
  for (let i = 0; i < 20; i += 1) {
    proxy.updateState(stateFile, (s) => { s.settings[`k${i}`] = i; });
  }
  const final = proxy.readState(stateFile);
  for (let i = 0; i < 20; i += 1) assert.strictEqual(final.settings[`k${i}`], i);
});

test('multi-process stress: concurrent updateState loses no updates and never corrupts', async () => {
  const stateFile = tmpState();
  proxy.writeState(stateFile, { version: 1, enabled: {}, settings: {} });

  const WORKERS = 4;
  const WRITES = 12;
  const workerSrc = `
    const proxy = require(${JSON.stringify(MAIN)});
    const stateFile = process.argv[2];
    const id = process.argv[3];
    for (let i = 0; i < ${WRITES}; i += 1) {
      const ok = proxy.updateState(stateFile, (s) => { s.settings['w' + id + '_' + i] = true; });
      if (!ok) { console.error('write failed', id, i); process.exit(1); }
    }
  `;
  const workerFile = path.join(path.dirname(stateFile), 'worker.js');
  fs.writeFileSync(workerFile, workerSrc);

  const children = [];
  for (let w = 0; w < WORKERS; w += 1) {
    children.push(new Promise((resolve, reject) => {
      cp.execFile(process.execPath, [workerFile, stateFile, String(w)], (err, _o, stderr) => {
        if (err) reject(new Error(`worker ${w} failed: ${stderr}`)); else resolve();
      });
    }));
  }
  await Promise.all(children);

  // Always-valid JSON…
  const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // …and ZERO lost updates across all workers.
  for (let w = 0; w < WORKERS; w += 1) {
    for (let i = 0; i < WRITES; i += 1) {
      assert.strictEqual(final.settings[`w${w}_${i}`], true, `update w${w}_${i} survived`);
    }
  }
});
