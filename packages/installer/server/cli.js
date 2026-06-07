#!/usr/bin/env node
'use strict';

/**
 * cli.js — launch the installer server and open the browser.
 */
const start = require('./index.js');
const { spawn } = require('child_process');

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args = [];
  if (platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* user can open manually */ });
    child.unref();
  } catch { /* ignore */ }
}

const portArg = process.argv.indexOf('--port');
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4599;
const noOpen = process.argv.includes('--no-open');

start({ port }).then(({ url }) => {
  if (!noOpen) openBrowser(url);
}).catch((err) => {
  console.error('Failed to start installer:', err.message);
  process.exit(1);
});
