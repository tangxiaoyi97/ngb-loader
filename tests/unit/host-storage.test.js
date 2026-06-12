'use strict';

/**
 * host-storage.test.js — P0-1: persistent, host-backed plugin storage.
 *
 * Verifies: write-through persistence via the injected persist callback,
 * cross-"restart" rehydration (a second instance constructed from the persisted
 * snapshot sees the first instance's data), serialized writes, and the at-rest
 * obfuscation (no plain key names / values in what gets persisted).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sdkUrl = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'sdk', 'src', 'index.js')).href;

test('HostStorage: set() persists write-through; a new instance rehydrates from the snapshot', async () => {
  const sdk = await import(sdkUrl);

  // Simulated state.json settings store (what the host IPC writes into).
  const store = {};
  const makeStorage = (pluginId) => new sdk.HostStorage({
    initial: sdk.decodeNamespace(store[pluginId], pluginId),
    persist: async (obj) => { store[pluginId] = sdk.encodeNamespace(obj, pluginId); },
  });

  // "First run": plugin saves an API key + a title.
  const s1 = makeStorage('ai-assistant');
  s1.set('apiKey', 'sk-secret-123');
  s1.set('conversationTitle', '二次函数');
  assert.strictEqual(s1.get('apiKey'), 'sk-secret-123', 'sync read-back from cache');
  await s1.flush();

  // "Restart": a fresh instance built from the persisted store.
  const s2 = makeStorage('ai-assistant');
  assert.strictEqual(s2.get('apiKey'), 'sk-secret-123', 'API key survives restart');
  assert.strictEqual(s2.get('conversationTitle'), '二次函数', 'unicode value survives');

  // delete() also persists.
  s2.delete('apiKey');
  await s2.flush();
  const s3 = makeStorage('ai-assistant');
  assert.strictEqual(s3.get('apiKey', null), null, 'deletion persisted');
  assert.deepStrictEqual(s3.keys(), ['conversationTitle']);
});

test('HostStorage: namespaces are isolated per plugin id', async () => {
  const sdk = await import(sdkUrl);
  const store = {};
  const mk = (id) => new sdk.HostStorage({
    initial: sdk.decodeNamespace(store[id], id),
    persist: async (obj) => { store[id] = sdk.encodeNamespace(obj, id); },
  });
  const a = mk('plugin-a'); a.set('k', 'va'); await a.flush();
  const b = mk('plugin-b'); b.set('k', 'vb'); await b.flush();
  assert.strictEqual(mk('plugin-a').get('k'), 'va');
  assert.strictEqual(mk('plugin-b').get('k'), 'vb');
});

test('HostStorage: writes are serialized (later set wins despite slow earlier persist)', async () => {
  const sdk = await import(sdkUrl);
  const writes = [];
  const s = new sdk.HostStorage({
    persist: async (obj) => {
      // First write is slow; if writes were not serialized it would land last
      // and clobber the second one.
      const isFirst = writes.length === 0;
      writes.push(JSON.stringify(obj));
      if (isFirst) await new Promise((r) => setTimeout(r, 40));
    },
  });
  s.set('v', 1);
  s.set('v', 2);
  await s.flush();
  assert.strictEqual(writes.length, 2);
  assert.match(writes[writes.length - 1], /"v":2/, 'final persisted snapshot has the last value');
});

test('encodeNamespace: secrets do not appear in plain sight at rest', async () => {
  const sdk = await import(sdkUrl);
  const ns = { apiKey: 'sk-super-secret-token', endpoint: 'https://api.example.com' };
  const enc = sdk.encodeNamespace(ns, 'ai-assistant');
  const flat = JSON.stringify(enc);
  assert.ok(!flat.includes('apiKey'), 'key name not readable');
  assert.ok(!flat.includes('sk-super-secret-token'), 'secret value not readable');
  assert.strictEqual(enc.__v, 1);
  // round-trip
  assert.deepStrictEqual(sdk.decodeNamespace(enc, 'ai-assistant'), ns);
});

test('decodeNamespace: tolerates undefined, garbage, and legacy plain objects', async () => {
  const sdk = await import(sdkUrl);
  assert.deepStrictEqual(sdk.decodeNamespace(undefined, 'x'), {});
  assert.deepStrictEqual(sdk.decodeNamespace(null, 'x'), {});
  assert.deepStrictEqual(sdk.decodeNamespace({ __v: 1, d: '!!!not-base64' }, 'x'), {});
  // legacy plain namespace (pre-encoding) is passed through for migration
  assert.deepStrictEqual(sdk.decodeNamespace({ old: 'value' }, 'x'), { old: 'value' });
});
