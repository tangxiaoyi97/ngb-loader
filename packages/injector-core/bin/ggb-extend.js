#!/usr/bin/env node
'use strict';

// ggb-extend — command line interface for the injection engine (see printHelp).
const path = require('path');
const fs = require('fs');
const core = require('../src/index');

/**
 * Locate the prebuilt full proxy (packages/proxy-core/dist) so that, by default,
 * we inject the complete proxy WITH the panel — not the minimal inline fallback.
 * Returns a path or undefined (engine then uses the inline proxy).
 */
function resolveDefaultProxyDir() {
  const candidates = [
    // CLI lives at packages/injector-core/bin → ../../proxy-core/dist
    path.join(__dirname, '..', '..', 'proxy-core', 'dist'),
    // when published/installed differently
    path.join(__dirname, '..', '..', '..', 'packages', 'proxy-core', 'dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'main.js'))) return c;
  }
  return undefined;
}

/* ----------------------------- tiny ansi ----------------------------- */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const LEVEL_FMT = {
  info: (m) => `${dim('•')} ${m}`,
  step: (m) => `${cyan('→')} ${m}`,
  ok: (m) => `${green('✓')} ${m}`,
  warn: (m) => `${yellow('!')} ${m}`,
  error: (m) => `${red('✗')} ${m}`,
};

function logEntry(entry) {
  const fmt = LEVEL_FMT[entry.level] || ((m) => m);
  console.log(fmt(entry.msg));
}

/* --------------------------- arg parsing ----------------------------- */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-sign') args.skipSign = true; // macOS: don't re-sign/clear quarantine
    else if (a === '--json') args.json = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--path') args.path = argv[++i];
    else if (a === '--proxy') args.proxy = argv[++i];
    else if (a === '--platform') args.platform = argv[++i]; // dev/test override
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`${bold('ggb-extend')} — GeoGebra plugin framework installer (v${core.FRAMEWORK_VERSION})

${bold('Commands')}
  scan                      List detected GeoGebra installations
  status                    Show the injection state of a target
  inject                    Inject the GGB-Extend proxy (takes over launch)
  uninstall                 Restore GeoGebra to its original state
  gui                       Launch the graphical web installer

${bold('Options')}
  --path <dir>              Target a specific install (.app, install dir, or Resources)
  --proxy <dir>             Use a prebuilt proxy folder instead of the inline one
  --dry-run                 Plan the operation without changing any files
  --skip-sign               macOS: skip ad-hoc re-sign + quarantine clear
  --json                    Machine-readable output (scan/status)
  --yes, -y                 Skip confirmation prompts
  --port <n>                Port for the gui command (default 4599)
  --help, -h                Show this help

${bold('Examples')}
  ggb-extend scan
  ggb-extend inject --dry-run
  ggb-extend inject --path "/Applications/GeoGebra Classic 6.app"
  ggb-extend uninstall
`);
}

/* ----------------------- target resolution --------------------------- */
function resolveTarget(args) {
  const platform = args.platform || process.platform;
  if (args.path) {
    const t = core.describeTarget(path.resolve(args.path), platform);
    if (!t) {
      throw new core.EngineError(`No GeoGebra/Electron install found at: ${args.path}`, 'ENOTFOUND');
    }
    return [t];
  }
  return core.scan(platform);
}

function describeState(t) {
  const stateColor = t.state === 'pristine' ? green : t.state === 'injected' ? cyan : yellow;
  return `${stateColor(t.state.padEnd(9))} ${dim(t.kind.padEnd(7))} ${t.version || '?'}  ${t.appBundle || t.resources}`;
}

/* ----------------------------- commands ------------------------------ */
async function cmdScan(args) {
  const targets = core.scan();
  if (args.json) {
    console.log(JSON.stringify(targets, null, 2));
    return 0;
  }
  if (targets.length === 0) {
    console.log(yellow('No GeoGebra installations found in the usual locations.'));
    console.log(dim('Tip: pass --path to point at a custom install.'));
    return 1;
  }
  console.log(bold(`Found ${targets.length} GeoGebra install(s):\n`));
  console.log(`  ${dim('STATE'.padEnd(9))} ${dim('KIND'.padEnd(7))} ${dim('VERSION')}  ${dim('LOCATION')}`);
  targets.forEach((t) => console.log('  ' + describeState(t)));
  return 0;
}

async function cmdStatus(args) {
  const targets = resolveTarget(args);
  if (args.json) { console.log(JSON.stringify(targets, null, 2)); return 0; }
  if (targets.length === 0) { console.log(yellow('No target found.')); return 1; }
  targets.forEach((t) => {
    console.log(bold(t.appBundle || t.resources));
    console.log(`  state:   ${t.state}`);
    console.log(`  layout:  ${t.kind}`);
    console.log(`  version: ${t.version || 'unknown'}`);
    console.log(`  resources: ${dim(t.resources)}`);
    if (t.state === 'injected') console.log(`  proxy is ours: ${t.proxyIsOurs ? green('yes') : yellow('unknown')}`);
    console.log('');
  });
  return 0;
}

function pickSingle(targets) {
  if (targets.length === 0) {
    throw new core.EngineError('No GeoGebra install found. Use --path to specify one.', 'ENOTFOUND');
  }
  if (targets.length > 1) {
    const list = targets.map((t) => `   - ${t.appBundle || t.resources}`).join('\n');
    throw new core.EngineError(
      `Multiple installs found. Disambiguate with --path:\n${list}`,
      'EMULTI'
    );
  }
  return targets[0];
}

async function cmdInject(args) {
  const target = pickSingle(resolveTarget(args));
  // Default to the full prebuilt proxy (with panel); --proxy overrides; if neither
  // is available the engine falls back to the minimal inline proxy.
  const proxyDir = args.proxy ? path.resolve(args.proxy) : resolveDefaultProxyDir();
  console.log(bold(`\nInjecting GGB-Extend into:`));
  console.log('  ' + (target.appBundle || target.resources));
  if (proxyDir) console.log(dim('  proxy: ' + proxyDir));
  else console.log(yellow('  proxy: inline fallback (panel NOT bundled — run "npm run build" first)'));
  console.log('');
  const res = await core.inject(target, {
    onLog: logEntry,
    dryRun: args.dryRun,
    skipSign: args.skipSign,
    proxyDir,
  });
  if (res.dryRun) console.log(dim('\n(dry run — nothing was written)'));
  return 0;
}

async function cmdUninstall(args) {
  const target = pickSingle(resolveTarget(args));
  console.log(bold(`\nUninstalling GGB-Extend from:`));
  console.log('  ' + (target.appBundle || target.resources) + '\n');
  const res = await core.uninstall(target, { onLog: logEntry, dryRun: args.dryRun, skipSign: args.skipSign });
  if (res.reason === 'not-injected') return 0;
  if (res.dryRun) console.log(dim('\n(dry run — nothing was written)'));
  return 0;
}

async function cmdGui(args) {
  // Delegate to the installer package if it's available in the monorepo.
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const start = require('@neogebra/installer/server/index.js');
    await start({ port: args.port || 4599 });
    return 0;
  } catch (err) {
    console.error(red('Could not launch the GUI installer.'));
    console.error(dim(String(err && err.message)));
    console.error('Run it directly with:  npm --workspace @neogebra/installer run start');
    return 1;
  }
}

/* ------------------------------- main -------------------------------- */
async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.help || !cmd) { printHelp(); return cmd ? 0 : 0; }

  try {
    switch (cmd) {
      case 'scan': return await cmdScan(args);
      case 'status': return await cmdStatus(args);
      case 'inject': return await cmdInject(args);
      case 'uninstall': return await cmdUninstall(args);
      case 'gui': return await cmdGui(args);
      default:
        console.error(red(`Unknown command: ${cmd}`));
        printHelp();
        return 2;
    }
  } catch (err) {
    if (err instanceof core.EngineError) {
      console.error(`\n${red('Error')} [${err.code}] ${err.message}`);
    } else {
      console.error(`\n${red('Unexpected error:')} ${err && err.stack ? err.stack : err}`);
    }
    return 1;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
