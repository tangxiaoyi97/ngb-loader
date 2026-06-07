// Stage sibling workspace packages into vendor/ before packing: electron-builder
// bundles a single package and won't bundle the @neogebra/injector-core and
// proxy-core symlinks cleanly, so main.js resolves them from vendor/ at runtime.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktop = join(__dirname, '..');
const repo = join(desktop, '..', '..');
// Vendor dir defaults to packages/desktop/vendor; override with GGBX_VENDOR_DIR
// (used in CI/sandboxes whose mount rejects nested copies into the package dir).
const vendor = process.env.GGBX_VENDOR_DIR || join(desktop, 'vendor');

const log = (...a) => console.log('[prepack]', ...a);

function copyDir(from, to) {
  if (!existsSync(from)) throw new Error(`missing source: ${from}`);
  // NOTE: we deliberately do NOT rmSync(to) here — some mounts choke on a
  // delete-then-recreate of the same path. prepack() clears vendor/ once up top.
  mkdirSync(to, { recursive: true });
  try {
    cpSync(from, to, { recursive: true, force: true });
  } catch (err) {
    // Fall back to the platform copy tool, which handles tricky mounts.
    if (process.platform === 'win32') {
      execFileSync('xcopy', [from, to, '/E', '/I', '/Y', '/Q'], { stdio: 'ignore' });
    } else {
      execFileSync('cp', ['-R', `${from}/.`, to], { stdio: 'ignore' });
    }
  }
}

/** Clear vendor/ once, tolerating mounts that restrict recursive removal. */
function clearVendor(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* mount quirk */ }
  // fallback: rename out of the way (best-effort), else leave & overwrite
  try {
    if (process.platform !== 'win32') execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
  } catch { /* leave it; copies below overwrite with force */ }
}

// 0) Clear any previous vendor/ once (subsequent copies use force-overwrite).
clearVendor(vendor);
mkdirSync(vendor, { recursive: true });

// 1) injector-core (source only — it just needs fs-extra, which we copy too)
const icSrc = join(repo, 'packages', 'injector-core');
const icDst = join(vendor, 'injector-core');
copyDir(join(icSrc, 'src'), join(icDst, 'src'));
copyDir(join(icSrc, 'bin'), join(icDst, 'bin'));
cpSync(join(icSrc, 'package.json'), join(icDst, 'package.json'));
log('vendored injector-core');

// 1b) fs-extra (injector-core's only runtime dep) — copy from root node_modules
const fsExtraSrc = join(repo, 'node_modules', 'fs-extra');
if (existsSync(fsExtraSrc)) {
  copyDir(fsExtraSrc, join(icDst, 'node_modules', 'fs-extra'));
  // fs-extra deps: graceful-fs, jsonfile, universalify
  for (const dep of ['graceful-fs', 'jsonfile', 'universalify', 'at-least-node']) {
    const d = join(repo, 'node_modules', dep);
    if (existsSync(d)) copyDir(d, join(icDst, 'node_modules', dep));
  }
  log('vendored fs-extra (+ deps)');
} else {
  log('WARNING: fs-extra not found in root node_modules; run npm install first');
}

// 2) assembled proxy (must be built first via build:proxy)
const proxySrc = join(repo, 'packages', 'proxy-core', 'dist');
if (!existsSync(join(proxySrc, 'main.js'))) {
  throw new Error('proxy-core/dist not built — run "npm run build:proxy" at repo root first');
}
copyDir(proxySrc, join(vendor, 'proxy-core'));
log('vendored proxy-core/dist');

log('done. vendor/ is ready for electron-builder.');
