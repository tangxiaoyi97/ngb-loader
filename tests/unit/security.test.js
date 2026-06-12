'use strict';

/**
 * security.test.js — P2: SSRF DNS-resolution guard (P2-1), IPC caller-identity
 * tokens (P2-2), plugin-source path confinement (P2-2), and default-disabled
 * new plugins (P2-3), exercised through the real registerIpc handlers with a
 * stubbed electron.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const proxy = require('../../packages/proxy-core/src/main.js');

// --- P2-1: resolved-IP range checks ----------------------------------------

test('isBlockedIp: private/reserved ranges are blocked, public addresses pass', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::',
    'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.strictEqual(proxy.isBlockedIp(ip), true, `${ip} must be blocked`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5']) {
    assert.strictEqual(proxy.isBlockedIp(ip), false, `${ip} must be allowed`);
  }
});

test('P2-1: a public hostname RESOLVING to a private IP is refused at the socket lookup', async () => {
  // evil.example.com is declared + approved (passes every literal check), but
  // DNS rebinding points it at 127.0.0.1 — the hooked lookup must refuse.
  let connected = false;
  const fakeHttps = {
    request(options, _cb) {
      const handlers = {};
      return {
        on(ev, fn) { handlers[ev] = fn; return this; },
        write() {},
        destroy() {},
        end() {
          // Simulate the socket performing the lookup via options.lookup.
          options.lookup(options.hostname, {}, (err) => {
            if (err) { handlers.error && handlers.error(err); return; }
            connected = true; // would have opened a connection
          });
        },
      };
    },
  };
  const res = await proxy.netFetch(
    { url: 'https://evil.example.com/steal', method: 'GET' },
    {
      pluginId: 'p1',
      declaredHosts: new Set(['evil.example.com']),
      isApproved: () => true,
      _https: fakeHttps,
      _dnsLookup: (host, _opts, cb) => cb(null, '127.0.0.1', 4), // DNS rebinding
    },
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /private\/reserved/i, 'lookup-level block reported');
  assert.strictEqual(connected, false, 'no connection was opened');
});

// --- registerIpc harness -----------------------------------------------------

function makeIpcHarness() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-sec-'));
  const handlers = {};
  const electron = {
    app: { getPath: () => userData },
    shell: { openPath: async () => '' },
    ipcMain: {
      handle: (ch, fn) => { handlers[ch] = fn; },
      removeHandler: () => {},
    },
  };
  proxy.registerIpc(electron);
  const root = path.join(userData, 'GGB_Plugins');
  const evt = (senderId) => ({ sender: { id: senderId, once: () => {} } });
  const addPlugin = (id, manifest = {}) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', main: 'index.js', ...manifest }));
    fs.writeFileSync(path.join(dir, 'index.js'), '// plugin');
    return dir;
  };
  return { handlers, evt, addPlugin, root, userData };
}

test('P2-2: net-fetch refuses a self-reported pluginId without that plugin\'s token', async () => {
  const { handlers, evt, addPlugin } = makeIpcHarness();
  addPlugin('victim', { permissions: { network: ['api.example.com'] } });
  addPlugin('attacker', { permissions: { network: [] } });

  const issued = await handlers['ggb-extend:issue-net-tokens'](evt(1));
  assert.ok(issued.ok && issued.tokens.victim && issued.tokens.attacker, 'tokens issued per plugin');
  assert.notStrictEqual(issued.tokens.victim, issued.tokens.attacker);

  // attacker self-reports pluginId "victim": no token / its own token / garbage
  for (const token of [undefined, issued.tokens.attacker, 'deadbeef']) {
    const r = await handlers['ggb-extend:net-fetch'](evt(1), { pluginId: 'victim', token, url: 'https://api.example.com/x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'EBADCALLER', `forged caller rejected (token=${token})`);
  }

  // the right token from a DIFFERENT webContents is also rejected
  const cross = await handlers['ggb-extend:net-fetch'](evt(2), { pluginId: 'victim', token: issued.tokens.victim, url: 'https://api.example.com/x' });
  assert.strictEqual(cross.code, 'EBADCALLER', 'token is bound to the issuing webContents');

  // the legitimate caller passes identity and reaches the approval layer
  const ok = await handlers['ggb-extend:net-fetch'](evt(1), { pluginId: 'victim', token: issued.tokens.victim, url: 'https://api.example.com/x' });
  assert.notStrictEqual(ok.code, 'EBADCALLER');
  assert.strictEqual(ok.code, 'ENEEDSAPPROVAL', 'identity ok → flow proceeds to user approval');
});

test('P2-2: net-approve requires the plugin\'s own token (no cross-plugin grants)', async () => {
  const { handlers, evt, addPlugin } = makeIpcHarness();
  addPlugin('victim', { permissions: { network: ['api.example.com'] } });
  const issued = await handlers['ggb-extend:issue-net-tokens'](evt(1));

  const forged = await handlers['ggb-extend:net-approve'](evt(1), { pluginId: 'victim', host: 'api.example.com', allow: true, token: 'bogus' });
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.code, 'EBADCALLER');

  const legit = await handlers['ggb-extend:net-approve'](evt(1), { pluginId: 'victim', host: 'api.example.com', allow: true, token: issued.tokens.victim });
  assert.strictEqual(legit.ok, true);

  // approval recorded → the legitimate fetch now passes the approval gate
  // (and fails later at the actual network layer, which is fine for this test)
  const after = await handlers['ggb-extend:net-fetch'](evt(1), { pluginId: 'victim', token: issued.tokens.victim, url: 'https://api.example.com/x', timeoutMs: 1000 });
  assert.notStrictEqual(after.code, 'ENEEDSAPPROVAL', 'approval persisted');
});

test('P2-2: read-plugin-source confines the entry to the plugin directory', async () => {
  const { handlers, evt, addPlugin, root } = makeIpcHarness();
  fs.writeFileSync(path.join(root, '..', 'secret.txt'), 'top secret');
  addPlugin('sneaky', { main: '../../secret.txt' });
  const r = await handlers['ggb-extend:read-plugin-source'](evt(1), { id: 'sneaky' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid plugin main path/);

  addPlugin('honest', { main: 'index.js' });
  const ok = await handlers['ggb-extend:read-plugin-source'](evt(1), { id: 'honest' });
  assert.strictEqual(ok.ok, true);
});

test('P2-3: a freshly dropped-in plugin is NOT enabled (and is marked new)', async () => {
  const { handlers, evt, addPlugin } = makeIpcHarness();
  addPlugin('dropped');
  const list = await handlers['ggb-extend:get-plugin-list'](evt(1));
  const p = list.plugins.find((x) => x.id === 'dropped');
  assert.strictEqual(p.enabled, false, 'default disabled — no code runs without consent');
  assert.strictEqual(p.status, 'new');

  await handlers['ggb-extend:toggle-plugin'](evt(1), { id: 'dropped', enabled: true });
  const after = await handlers['ggb-extend:get-plugin-list'](evt(1));
  assert.strictEqual(after.plugins.find((x) => x.id === 'dropped').enabled, true);
  assert.strictEqual(after.plugins.find((x) => x.id === 'dropped').status, 'enabled');
});

// --- per-GGB approval isolation (follow-up to P2) ----------------------------

test('netApprovals are per-GGB: helpers isolate targets and migrate legacy data', () => {
  // Pure-state helpers (the IPC layer always passes its own ggbId).
  const state = { version: 2, targets: {}, netApprovals: { ai: { 'api.example.com': true } } }; // legacy global

  // Read fallback: no per-target record yet → legacy global applies.
  assert.strictEqual(proxy.targetApprovals(state, 'ggb-A', 'ai')['api.example.com'], true);

  // First WRITE on ggb-A seeds from legacy, then records the new decision.
  proxy.setTargetApproval(state, 'ggb-A', 'ai', 'cdn.example.com', true);
  const a = proxy.targetApprovals(state, 'ggb-A', 'ai');
  assert.strictEqual(a['api.example.com'], true, 'legacy decision carried over (seed-on-write)');
  assert.strictEqual(a['cdn.example.com'], true);

  // ggb-B is untouched: still reads legacy only.
  const b = proxy.targetApprovals(state, 'ggb-B', 'ai');
  assert.strictEqual(b['api.example.com'], true);
  assert.strictEqual(b['cdn.example.com'], undefined, 'isolation: B does not see A\'s approval');

  // Revoke on A deletes the record there; B keeps its legacy view.
  proxy.revokeTargetApproval(state, 'ggb-A', 'ai', 'api.example.com');
  assert.strictEqual(proxy.targetApprovals(state, 'ggb-A', 'ai')['api.example.com'], undefined, 'revoked on A');
  assert.strictEqual(proxy.targetApprovals(state, 'ggb-B', 'ai')['api.example.com'], true, 'B unaffected');
});

test('net-approvals/net-revoke IPC: panel can inspect and revoke; revoked host re-prompts', async () => {
  const { handlers, evt, addPlugin } = makeIpcHarness();
  addPlugin('ai', { permissions: { network: ['api.example.com', 'cdn.example.com'] } });
  const issued = await handlers['ggb-extend:issue-net-tokens'](evt(1));
  const token = issued.tokens.ai;

  // approve one host
  await handlers['ggb-extend:net-approve'](evt(1), { pluginId: 'ai', host: 'api.example.com', allow: true, token });

  // panel inspection: declared hosts + recorded decisions
  const info = await handlers['ggb-extend:net-approvals'](evt(1), { pluginId: 'ai' });
  assert.strictEqual(info.ok, true);
  assert.deepStrictEqual(info.declared, ['api.example.com', 'cdn.example.com']);
  assert.strictEqual(info.approvals['api.example.com'], true);
  assert.strictEqual(info.approvals['cdn.example.com'], undefined, 'undeclared decision absent');

  // approved host passes the approval gate
  let r = await handlers['ggb-extend:net-fetch'](evt(1), { pluginId: 'ai', token, url: 'https://api.example.com/x', timeoutMs: 1000 });
  assert.notStrictEqual(r.code, 'ENEEDSAPPROVAL');

  // revoke → record gone → next access asks the user again
  const rev = await handlers['ggb-extend:net-revoke'](evt(1), { pluginId: 'ai', host: 'api.example.com' });
  assert.strictEqual(rev.ok, true);
  const after = await handlers['ggb-extend:net-approvals'](evt(1), { pluginId: 'ai' });
  assert.strictEqual(after.approvals['api.example.com'], undefined, 'record deleted');
  r = await handlers['ggb-extend:net-fetch'](evt(1), { pluginId: 'ai', token, url: 'https://api.example.com/x' });
  assert.strictEqual(r.code, 'ENEEDSAPPROVAL', 're-prompts after revoke');

  // a recorded BLOCK shows up as false (and is revocable the same way)
  await handlers['ggb-extend:net-approve'](evt(1), { pluginId: 'ai', host: 'cdn.example.com', allow: false, token });
  const blocked = await handlers['ggb-extend:net-approvals'](evt(1), { pluginId: 'ai' });
  assert.strictEqual(blocked.approvals['cdn.example.com'], false);
});
