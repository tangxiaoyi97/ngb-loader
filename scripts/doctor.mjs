#!/usr/bin/env node
// Environment & installation diagnostic for GGB-Extend.
//   node scripts/doctor.mjs [--path "/Applications/GeoGebra Classic 6.app"]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..');

// ANSI
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const ok = (s) => col('32', s);
const bad = (s) => col('31', s);
const warn = (s) => col('33', s);
const dim = (s) => col('2', s);
const head = (s) => col('1', s);
const PASS = ok('✓'); const FAIL = bad('✗'); const WARN = warn('!');

function line(sym, label, detail) {
  console.log(`  ${sym} ${label}${detail ? dim('  — ' + detail) : ''}`);
}

const args = process.argv.slice(2);
const pathArg = args.includes('--path') ? args[args.indexOf('--path') + 1] : null;
const platformArg = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : process.platform;

let core;
try {
  core = require(join(repo, 'packages', 'injector-core', 'src', 'index.js'));
} catch (e) {
  console.error(bad('Cannot load injector-core: ' + e.message));
  process.exit(1);
}

async function main() {
  console.log(head('\nGGB-Extend doctor\n'));

  // --- Node version ---
  console.log(head('Environment'));
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 18 ? PASS : FAIL, `Node ${process.versions.node}`, major >= 18 ? '' : 'need >= 18');
  line(PASS, `Platform ${process.platform} (${process.arch})`);

  // --- Build artifacts ---
  console.log(head('\nBuild artifacts'));
  const proxyDist = join(repo, 'packages', 'proxy-core', 'dist');
  const proxyMain = join(proxyDist, 'main.js');
  const runtimeBundle = join(proxyDist, 'assets', 'runtime.bundle.js');
  line(existsSync(proxyMain) ? PASS : WARN, 'assembled proxy', existsSync(proxyMain) ? proxyDist : 'run: npm run build:proxy');
  line(existsSync(runtimeBundle) ? PASS : WARN, 'runtime bundle (SDK + loader + panel)', existsSync(runtimeBundle) ? sizeOf(runtimeBundle) : 'run: npm run build:proxy');

  // --- Locate GeoGebra ---
  console.log(head('\nGeoGebra installation'));
  let targets = [];
  if (pathArg) {
    const t = core.describeTarget(pathArg, platformArg);
    if (t) targets = [t];
    else line(FAIL, 'No install at --path', pathArg);
  } else {
    targets = core.scan(platformArg);
  }
  if (targets.length === 0 && !pathArg) {
    line(WARN, 'No installs auto-detected', 'pass --path "/Applications/GeoGebra Classic 6.app"');
  }
  for (const t of targets) {
    const stateSym = t.state === 'pristine' ? ok('pristine') : t.state === 'injected' ? col('36', 'injected') : warn(t.state);
    console.log(`  • ${t.appBundle || t.resources}`);
    line(PASS, `state: ${stateSym}`, `${t.kind} · GeoGebra ${t.version || '?'}`);
    if (t.state === 'injected') line(t.proxyIsOurs ? PASS : WARN, `proxy is ours: ${t.proxyIsOurs ? 'yes' : 'unknown'}`);

    // macOS signing inspection
    if (process.platform === 'darwin' && t.appBundle) {
      try {
        const info = await core.macos.signatureInfo(t.appBundle);
        line(info.signed ? PASS : WARN, `code signature: ${info.signed ? 'present' : 'none/ad-hoc'}`);
        const a = await core.macos.assess(t.appBundle);
        line(a.accepted ? PASS : WARN, `Gatekeeper assess: ${a.accepted ? 'accepted' : 'not accepted'}`,
          a.accepted ? '' : 'after inject, doctor re-checks; ad-hoc sign is applied automatically');
      } catch { /* tools missing */ }
    }
  }

  // --- Next steps ---
  console.log(head('\nNext steps'));
  if (targets.length && targets[0].state === 'pristine') {
    console.log(dim('  Preview:  ') + `node packages/injector-core/bin/ggb-extend.js inject --dry-run --path ${q(targets[0].appBundle)}`);
    console.log(dim('  Install:  ') + `node packages/injector-core/bin/ggb-extend.js inject --path ${q(targets[0].appBundle)}`);
  } else if (targets.length && targets[0].state === 'injected') {
    console.log(dim('  Launch GeoGebra and press Right-Shift to open the panel.'));
    console.log(dim('  Debug:    ') + `GGB_EXTEND_DEBUG=1 open ${q(targets[0].appBundle)}`);
    console.log(dim('  Remove:   ') + `node packages/injector-core/bin/ggb-extend.js uninstall --path ${q(targets[0].appBundle)}`);
  } else {
    console.log(dim('  Build first:  npm run build:panel && npm run build:proxy'));
  }
  console.log('');
}

function sizeOf(p) { try { return `${(statSync(p).size / 1024).toFixed(1)} KB`; } catch { return ''; } }
function q(s) { return s && /\s/.test(s) ? `"${s}"` : s; }

main().catch((e) => { console.error(bad(String(e))); process.exit(1); });
