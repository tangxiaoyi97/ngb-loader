'use strict';

/** Installer micro-server: bridges the WebUI to @neogebra/injector-core over REST + WebSocket. */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const core = require('@neogebra/injector-core');

const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');
const WEB_PUBLIC = path.join(__dirname, '..', 'web', 'public');

/** Broadcast helper bound to a WebSocketServer. */
function makeBroadcaster(wss) {
  return (obj) => {
    const data = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try { client.send(data); } catch { /* ignore dead client */ }
      }
    }
  };
}

/** Resolve the prebuilt proxy folder to copy during injection, if present. */
function resolveProxyDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'proxy-core', 'dist'),
    path.join(__dirname, '..', '..', '..', 'packages', 'proxy-core', 'dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'main.js'))) return c;
  }
  return undefined; // engine falls back to inline proxy
}

function createApp({ broadcast }) {
  const app = express();
  app.use(express.json());

  // --- static WebUI (built bundle if available, else raw public/) ----
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
  } else {
    app.use(express.static(WEB_PUBLIC));
  }

  // --- API -----------------------------------------------------------
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: core.FRAMEWORK_VERSION }));

  app.get('/api/scan', (req, res) => {
    try {
      const platform = req.query.platform || process.platform;
      const targets = core.scan(platform);
      res.json({ ok: true, targets });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message) });
    }
  });

  app.get('/api/status', (req, res) => {
    try {
      const platform = req.query.platform || process.platform;
      const p = req.query.path;
      if (!p) return res.status(400).json({ ok: false, error: 'path required' });
      const target = core.describeTarget(path.resolve(p), platform);
      if (!target) return res.status(404).json({ ok: false, error: 'no install at path' });
      return res.json({ ok: true, target });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message) });
    }
  });

  const runOp = (opName) => async (req, res) => {
    const platform = (req.body && req.body.platform) || process.platform;
    const p = req.body && req.body.path;
    const dryRun = !!(req.body && req.body.dryRun);
    if (!p) return res.status(400).json({ ok: false, error: 'path required' });
    const target = core.describeTarget(path.resolve(p), platform);
    if (!target) return res.status(404).json({ ok: false, error: 'no install at path' });

    broadcast({ kind: 'op-start', op: opName, target: target.appBundle || target.resources });
    const onLog = (entry) => broadcast({ kind: 'log', op: opName, entry });
    try {
      const opts = { onLog, dryRun };
      if (opName === 'inject') opts.proxyDir = resolveProxyDir();
      const result = opName === 'inject'
        ? await core.inject(target, opts)
        : await core.uninstall(target, opts);
      broadcast({ kind: 'op-done', op: opName, result });
      return res.json({ ok: true, result });
    } catch (err) {
      broadcast({ kind: 'op-error', op: opName, error: String(err.message), code: err.code });
      return res.status(500).json({ ok: false, error: String(err.message), code: err.code });
    }
  };

  app.post('/api/inject', runOp('inject'));
  app.post('/api/uninstall', runOp('uninstall'));

  // SPA fallback
  app.get('*', (_req, res) => {
    const indexDist = path.join(WEB_DIST, 'index.html');
    const indexPub = path.join(WEB_PUBLIC, 'index.html');
    if (fs.existsSync(indexDist)) return res.sendFile(indexDist);
    if (fs.existsSync(indexPub)) return res.sendFile(indexPub);
    return res.status(404).send('WebUI not built. Run: npm --workspace @neogebra/installer run build:web');
  });

  return app;
}

/**
 * Start the installer server.
 * @param {object} [opts]
 * @param {number} [opts.port=4599]
 * @param {string} [opts.host='127.0.0.1']
 * @returns {Promise<{server: http.Server, port: number, url: string, close: ()=>Promise<void>}>}
 */
function start(opts = {}) {
  const port = opts.port || 4599;
  const host = opts.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    let wss;
    const server = http.createServer();
    wss = new WebSocketServer({ server, path: '/ws' });
    const broadcast = makeBroadcaster(wss);

    const app = createApp({ broadcast });
    server.on('request', app);

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ kind: 'hello', version: core.FRAMEWORK_VERSION }));
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      // eslint-disable-next-line no-console
      console.log(`\n  GGB-Extend installer running at ${url}\n  (Press Ctrl+C to stop)\n`);
      resolve({
        server,
        wss,
        port,
        url,
        close: () => new Promise((r) => { wss.close(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = start;
module.exports.start = start;
module.exports.createApp = createApp;
module.exports.makeBroadcaster = makeBroadcaster;
module.exports.resolveProxyDir = resolveProxyDir;
