'use strict';

/**
 * installer-server.test.js — integration test for the installer micro-server.
 *
 * Spins up the real Express+WS server on an ephemeral port, builds a throwaway
 * fake GeoGebra app, then drives scan/status/inject/uninstall over HTTP while
 * asserting the WebSocket streams log entries. No GUI / no real GeoGebra needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const WebSocket = require('ws');

const start = require('../../packages/installer/server/index.js');

function buildFakeMacApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-srv-'));
  const resources = path.join(root, 'GeoGebra Classic 6.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app', 'package.json'),
    JSON.stringify({ name: 'GeoGebra', version: '6.0.920', main: 'main.js' }));
  fs.writeFileSync(path.join(resources, 'app', 'main.js'), '// real');
  return { appBundle: path.join(root, 'GeoGebra Classic 6.app'), resources };
}

async function json(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json() };
}

test('installer server: health, status, inject (with WS logs), uninstall', async (t) => {
  const srv = await start({ port: 0 }); // 0 => ephemeral port
  const base = srv.url;
  const { appBundle, resources } = buildFakeMacApp();

  t.after(async () => { await srv.close(); });

  // health
  const h = await json(`${base}/api/health`);
  assert.strictEqual(h.body.ok, true);

  // status (pristine)
  const s = await json(`${base}/api/status?platform=darwin&path=${encodeURIComponent(appBundle)}`);
  assert.strictEqual(s.body.ok, true);
  assert.strictEqual(s.body.target.state, 'pristine');

  // Open WS and collect log entries during inject.
  const wsUrl = base.replace('http', 'ws') + '/ws';
  const ws = new WebSocket(wsUrl);
  const logs = [];
  const opEvents = [];
  await new Promise((res) => ws.on('open', res));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.kind === 'log') logs.push(m.entry);
    if (m.kind && m.kind.startsWith('op-')) opEvents.push(m.kind);
  });

  // inject
  const inj = await json(`${base}/api/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: appBundle, platform: 'darwin' }),
  });
  assert.strictEqual(inj.body.ok, true);
  assert.strictEqual(inj.body.result.changed, true);

  // give the WS a tick to flush
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(logs.length >= 3, `expected streamed logs, got ${logs.length}`);
  assert.ok(opEvents.includes('op-start'));
  assert.ok(opEvents.includes('op-done'));

  // on-disk effect
  assert.ok(fs.existsSync(path.join(resources, 'core')), 'core created');
  assert.ok(fs.existsSync(path.join(resources, 'app', 'package.json')), 'proxy installed');

  // status now injected
  const s2 = await json(`${base}/api/status?platform=darwin&path=${encodeURIComponent(appBundle)}`);
  assert.strictEqual(s2.body.target.state, 'injected');

  // uninstall
  const un = await json(`${base}/api/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: appBundle, platform: 'darwin' }),
  });
  assert.strictEqual(un.body.ok, true);
  assert.ok(!fs.existsSync(path.join(resources, 'core')), 'core removed on uninstall');

  ws.close();
});

test('installer server: 404 for unknown path, 400 for missing path', async (t) => {
  const srv = await start({ port: 0 });
  t.after(async () => { await srv.close(); });
  const base = srv.url;

  const notFound = await json(`${base}/api/status?platform=darwin&path=${encodeURIComponent('/nope/none.app')}`);
  assert.strictEqual(notFound.status, 404);

  const missing = await json(`${base}/api/inject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.strictEqual(missing.status, 400);
});
