'use strict';

/**
 * The injection/uninstall engine for GGB-Extend.
 *
 * "Dual ASAR/folder route-redirection" technique:
 *
 *   pristine:                 injected:
 *   Resources/                Resources/
 *     app.asar  (original) ->   core.asar          (renamed original)
 *                               app/               (our proxy: package.json+main.js)
 *                               core.asar.bak?     (optional safety copy ref)
 *                               .ggb-extend.json   (injection manifest)
 *
 *   For the unpacked-folder variant, s/.asar//.
 *
 * CRITICAL: Electron's loader resolves `Resources/app` (folder) BEFORE
 * `Resources/app.asar`. So once we rename the original to `core*` and drop a
 * folder named `app`, Electron boots OUR proxy, which then `require()`s the
 * original core. No binary patching, fully non-invasive.
 */

const path = require('path');

const MANIFEST_NAME = '.ggb-extend.json';
const FRAMEWORK_VERSION = '2.0.0-beta';

/* ------------------------------------------------------------------ *
 * fs abstraction — defaults to fs-extra if present, else node:fs
 * ------------------------------------------------------------------ */

function defaultFs() {
  try {
    // fs-extra gives us copy/move/remove/ensureDir with promises.
    // eslint-disable-next-line global-require
    return require('fs-extra');
  } catch {
    // Minimal shim over node:fs/promises so the engine still runs without the dep.
    // eslint-disable-next-line global-require
    const fsp = require('fs').promises;
    // eslint-disable-next-line global-require
    const fss = require('fs');
    return {
      pathExists: async (p) => {
        try { await fsp.access(p); return true; } catch { return false; }
      },
      ensureDir: (p) => fsp.mkdir(p, { recursive: true }),
      move: (a, b, opts = {}) => fsp.rename(a, b).catch(async (err) => {
        if (err.code === 'EXDEV') {
          // cross-device: fall back to copy+remove
          await fsp.cp(a, b, { recursive: true, force: !!opts.overwrite });
          await fsp.rm(a, { recursive: true, force: true });
        } else { throw err; }
      }),
      copy: (a, b, opts = {}) => fsp.cp(a, b, { recursive: true, force: opts.overwrite !== false }),
      remove: (p) => fsp.rm(p, { recursive: true, force: true }),
      readFile: fsp.readFile,
      writeFile: fsp.writeFile,
      readJson: async (p) => JSON.parse(await fsp.readFile(p, 'utf8')),
      writeJson: async (p, obj, opts = {}) =>
        fsp.writeFile(p, JSON.stringify(obj, null, opts.spaces || 2)),
      chmod: fsp.chmod,
      stat: fsp.stat,
      statSync: fss.statSync,
      existsSync: fss.existsSync,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function noopLog() {}

/**
 * Make a structured logger. Each emitted entry is `{ level, msg, ts }` and is
 * also mirrored to the raw callback as a formatted string for terminal display.
 */
function makeLogger(onLog = noopLog) {
  const emit = (level, msg) => {
    const entry = { level, msg, ts: Date.now() };
    try { onLog(entry); } catch { /* never let logging crash the engine */ }
    return entry;
  };
  return {
    info: (m) => emit('info', m),
    step: (m) => emit('step', m),
    ok: (m) => emit('ok', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EngineError';
    this.code = code || 'EENGINE';
  }
}

/* ------------------------------------------------------------------ *
 * Manifest helpers
 * ------------------------------------------------------------------ */

function manifestPath(resources) {
  return path.join(resources, MANIFEST_NAME);
}

async function readManifest(fs, resources) {
  const mp = manifestPath(resources);
  if (await fs.pathExists(mp)) {
    try { return await fs.readJson(mp); } catch { return null; }
  }
  return null;
}

async function writeManifest(fs, resources, data) {
  await fs.writeJson(manifestPath(resources), data, { spaces: 2 });
}

/* ------------------------------------------------------------------ *
 * Proxy payload
 * ------------------------------------------------------------------ */

/**
 * The proxy is a tiny folder Electron boots instead of the real app. We can
 * either copy it from a prebuilt directory (proxyDir) or synthesize a minimal
 * inline version (used as a safe fallback / for tests).
 */
function inlineProxyPackageJson() {
  return {
    name: 'ggb-extend-proxy',
    productName: 'GeoGebra (NeoGebra)',
    version: FRAMEWORK_VERSION,
    main: 'main.js',
    ggbExtend: true,
    private: true,
  };
}

function inlineProxyMainJs() {
  // Kept intentionally tiny & dependency-free. The full-featured proxy lives in
  // packages/proxy-core and is normally shipped via `proxyDir`; this inline copy
  // guarantees the engine can always produce a *bootable* proxy.
  return `'use strict';
// GGB-Extend minimal bootstrap proxy (inline fallback).
// Hands control to the original GeoGebra core after best-effort patching.
const path = require('path');
const fs = require('fs');

function loadCore() {
  const coreDir = fs.existsSync(path.join(__dirname, '..', 'core'))
    ? path.join(__dirname, '..', 'core')
    : path.join(__dirname, '..', 'core.asar');
  let main;
  try {
    const pkg = require(path.join(coreDir, 'package.json'));
    main = path.join(coreDir, pkg.main || 'main.js');
  } catch (e) {
    main = path.join(coreDir, 'main.js');
  }
  require(main);
}

try {
  loadCore();
} catch (err) {
  // Never brick the host app: if our layer fails, still try to boot core.
  console.error('[GGB-Extend] bootstrap failed, booting core directly:', err);
  try { loadCore(); } catch (e2) { console.error('[GGB-Extend] core boot failed:', e2); }
}
`;
}

/**
 * Write/refresh the proxy folder at `dest`.
 * If `proxyDir` is provided and exists, copy it; else synthesize inline.
 */
async function placeProxy(fs, dest, proxyDir, log) {
  await fs.ensureDir(dest);
  if (proxyDir && (await fs.pathExists(proxyDir))) {
    log.step(`Copying proxy payload from ${proxyDir}`);
    await fs.copy(proxyDir, dest, { overwrite: true });
  } else {
    log.step('Writing inline proxy payload (package.json + main.js)');
    await fs.writeJson(path.join(dest, 'package.json'), inlineProxyPackageJson(), { spaces: 2 });
    await fs.writeFile(path.join(dest, 'main.js'), inlineProxyMainJs());
  }
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/**
 * Best-effort writability probe. Returns { writable, reason }.
 * We DON'T throw here; callers decide whether to escalate (sudo / UAC).
 */
async function checkWritable(fs, resources) {
  const probe = path.join(resources, `.ggb-extend-write-test-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.remove(probe);
    return { writable: true };
  } catch (err) {
    return { writable: false, reason: err.code || err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Core operations: inject & uninstall
 * ------------------------------------------------------------------ */

/**
 * Inject the proxy into a normalized target (from detect.describeTarget()).
 *
 * @param {object} target  normalized target descriptor
 * @param {object} [opts]
 * @param {object} [opts.fs]        fs implementation (defaults to fs-extra/shim)
 * @param {function} [opts.onLog]   log callback (entry => void)
 * @param {string} [opts.proxyDir]  path to a prebuilt proxy folder to copy
 * @param {string} [opts.backupDir] if set, COPY the original payload here before
 *                                  the in-place rename (an extra safety copy that
 *                                  survives even if the in-app `core` is lost).
 *                                  The desktop manager passes a per-GGB folder.
 * @param {boolean}[opts.dryRun]    if true, plan only — perform no fs mutations
 * @returns {Promise<object>}       result with { changed, plan, manifest }
 */
async function inject(target, opts = {}) {
  const fs = opts.fs || defaultFs();
  const log = makeLogger(opts.onLog);
  const dryRun = !!opts.dryRun;

  if (!target || !target.resources) {
    throw new EngineError('Invalid target: missing resources directory', 'EBADTARGET');
  }

  const { resources, kind } = target;
  const isAsar = kind === 'asar';
  // `appPath` is the ORIGINAL entry Electron currently boots (file for asar,
  // folder for unpacked). We rename this to `corePath`.
  const appPath = path.join(resources, isAsar ? 'app.asar' : 'app');
  const corePath = path.join(resources, isAsar ? 'core.asar' : 'core');
  // `proxyPath` is where OUR proxy lives. It is ALWAYS the folder `app/`,
  // because Electron resolves `Resources/app/` before `Resources/*.asar`.
  // For the folder layout proxyPath === appPath (we rename the original away
  // first, then drop the proxy folder back in its place). For the asar layout
  // proxyPath (app/) is a *different* path than appPath (app.asar).
  const proxyPath = path.join(resources, 'app');
  const bakPath = `${appPath}.bak`;

  log.info(`Target: ${resources}`);
  log.info(`Layout: ${isAsar ? 'packaged (asar)' : 'unpacked (folder)'}  •  GeoGebra ${target.version || 'unknown'}`);

  const plan = [];

  // --- Already injected? -------------------------------------------------
  const existingManifest = await readManifest(fs, resources);
  const coreExists = await fs.pathExists(corePath);
  const appExists = await fs.pathExists(appPath);

  if ((existingManifest || (coreExists && target.proxyIsOurs)) && coreExists) {
    log.warn('Target already injected — refreshing proxy assets only (idempotent).');
    plan.push({ action: 'refresh-proxy', dest: proxyPath });
    if (!dryRun) {
      // Refresh the proxy folder contents in place (folder `app/` for both layouts).
      await placeProxy(fs, proxyPath, opts.proxyDir, log);
      const manifest = existingManifest || baselineManifest(target, { appPath, corePath, bakPath });
      manifest.lastInjectedAt = new Date().toISOString();
      manifest.frameworkVersion = FRAMEWORK_VERSION;
      await writeManifest(fs, resources, manifest);
      log.ok('Proxy refreshed.');
      return { changed: true, plan, manifest, alreadyInjected: true };
    }
    return { changed: false, plan, alreadyInjected: true, dryRun: true };
  }

  // --- Sanity: we must have an original app to redirect -------------------
  if (!appExists) {
    throw new EngineError(
      `Original entry not found at ${appPath}. Cannot inject.`,
      'ENOAPP'
    );
  }
  if (coreExists) {
    // core exists but no manifest and proxy isn't ours -> ambiguous/broken state
    throw new EngineError(
      `Found existing '${path.basename(corePath)}' but no GGB-Extend manifest. ` +
      `Refusing to overwrite to avoid data loss. Inspect ${resources} manually.`,
      'EAMBIGUOUS'
    );
  }

  // --- Permission probe ---------------------------------------------------
  if (!dryRun) {
    const perm = await checkWritable(fs, resources);
    if (!perm.writable) {
      throw new EngineError(
        `No write permission in ${resources} (${perm.reason}). ` +
        `Re-run with elevated privileges (sudo on macOS/Linux, "Run as administrator" on Windows).`,
        'EPERM'
      );
    }
  }

  // --- Build the plan -----------------------------------------------------
  plan.push({ action: 'rename', from: appPath, to: corePath, note: 'preserve original as core' });
  plan.push({ action: 'place-proxy', dest: proxyPath, note: 'install GGB-Extend proxy' });
  plan.push({ action: 'write-manifest', path: manifestPath(resources) });

  if (dryRun) {
    log.info('Dry run — no changes will be made. Planned steps:');
    plan.forEach((s, i) => log.step(`  ${i + 1}. ${describeStep(s)}`));
    return { changed: false, plan, dryRun: true };
  }

  // --- Execute ------------------------------------------------------------
  // 0) Optional external backup: COPY the pristine payload to backupDir BEFORE
  //    we touch anything. This is a belt-and-suspenders copy used by the desktop
  //    manager so restore is possible even if the in-app `core` is later deleted.
  let backupInfo = null;
  if (opts.backupDir) {
    backupInfo = await copyExternalBackup(fs, { resources, isAsar, appPath, backupDir: opts.backupDir }, log);
  }

  // 1) Rename original app(.asar) -> core(.asar)
  log.step(`Renaming ${path.basename(appPath)} → ${path.basename(corePath)} (safe backup)`);
  await fs.move(appPath, corePath, { overwrite: false });

  // For the asar variant there may be an app.asar.unpacked sibling — move it too.
  if (isAsar) {
    const unpackedSrc = path.join(resources, 'app.asar.unpacked');
    const unpackedDst = path.join(resources, 'core.asar.unpacked');
    if (await fs.pathExists(unpackedSrc)) {
      log.step('Renaming app.asar.unpacked → core.asar.unpacked');
      await fs.move(unpackedSrc, unpackedDst, { overwrite: false });
    }
  }

  // 2) Drop the proxy where Electron will find it first (a *folder* named app).
  //    Even for the asar variant, the proxy is an unpacked folder — Electron
  //    resolves `Resources/app` before `Resources/*.asar`, so this works for both.
  //    (For asar, proxyPath=app/ differs from the now-renamed core.asar.)
  log.step('Installing proxy folder (app/)');
  await placeProxy(fs, proxyPath, opts.proxyDir, log);

  // 3) Write the manifest describing exactly what we changed, for clean uninstall.
  const manifest = baselineManifest(target, { appPath, corePath, bakPath });
  if (backupInfo) manifest.externalBackup = backupInfo;
  await writeManifest(fs, resources, manifest);

  // 4) macOS: a signed .app no longer matches its signature after we changed
  //    Resources/. Clear quarantine + ad-hoc re-sign so it stays launchable.
  //    Best-effort: opt out with opts.skipSign === true.
  const sign = await maybeRepairMacSignature(target, opts, log);
  if (sign) manifest.macSign = sign;

  log.ok('Injection complete. GeoGebra will now boot through GGB-Extend.');
  return { changed: true, plan, manifest, macSign: sign };
}

/**
 * Copy the pristine original payload (app or app.asar + its .unpacked sibling)
 * into `backupDir`. Returns a descriptor recorded in the manifest, or throws on
 * a hard failure (we WANT inject to abort if the safety copy can't be made).
 */
async function copyExternalBackup(fs, { resources, isAsar, appPath, backupDir }, log) {
  log.step(`Backing up original to ${backupDir}`);
  await fs.ensureDir(backupDir);

  const entryName = isAsar ? 'app.asar' : 'app';
  const destEntry = path.join(backupDir, entryName);

  // Refuse to clobber an existing different backup silently.
  if (await fs.pathExists(destEntry)) {
    log.warn(`Backup already exists at ${destEntry} — leaving it as-is (not overwriting).`);
  } else {
    await fs.copy(appPath, destEntry, { overwrite: false });
  }

  const files = [entryName];
  if (isAsar) {
    const unpackedSrc = path.join(resources, 'app.asar.unpacked');
    if (await fs.pathExists(unpackedSrc)) {
      const destUnpacked = path.join(backupDir, 'app.asar.unpacked');
      if (!(await fs.pathExists(destUnpacked))) {
        log.step('Backing up app.asar.unpacked');
        await fs.copy(unpackedSrc, destUnpacked, { overwrite: false });
      }
      files.push('app.asar.unpacked');
    }
  }

  log.ok('External backup complete.');
  return { dir: backupDir, kind: isAsar ? 'asar' : 'folder', files, at: new Date().toISOString() };
}

/**
 * Restore the original payload FROM an external backup into the resources dir.
 * Used by uninstall when the in-app `core` is missing. Returns true on success.
 */
async function restoreFromExternalBackup(fs, { resources, isAsar, appPath, backupDir }, log) {
  const entryName = isAsar ? 'app.asar' : 'app';
  const srcEntry = path.join(backupDir, entryName);
  if (!(await fs.pathExists(srcEntry))) return false;

  log.step(`Restoring ${entryName} from external backup ${backupDir}`);
  if (await fs.pathExists(appPath)) await fs.remove(appPath);
  await fs.copy(srcEntry, appPath, { overwrite: true });

  if (isAsar) {
    const srcUnpacked = path.join(backupDir, 'app.asar.unpacked');
    if (await fs.pathExists(srcUnpacked)) {
      const dstUnpacked = path.join(resources, 'app.asar.unpacked');
      if (await fs.pathExists(dstUnpacked)) await fs.remove(dstUnpacked);
      await fs.copy(srcUnpacked, dstUnpacked, { overwrite: true });
    }
  }
  log.ok('Restored from external backup.');
  return true;
}

/**
 * Run macOS signature repair when appropriate. Returns the result object or null.
 * Never throws — signing problems are surfaced as warnings, not failures.
 */
async function maybeRepairMacSignature(target, opts, log) {
  if (opts.skipSign === true) return null;
  // Signing must run on a real macOS HOST (we shell out to codesign/xattr). The
  // target's *declared* platform may be 'darwin' for cross-platform tests, so we
  // gate on the actual runtime platform, not target.platform.
  if (process.platform !== 'darwin') return null;
  if (!target.appBundle) return null; // need a .app bundle to sign
  try {
    // eslint-disable-next-line global-require
    const macos = require('./macos');
    return await macos.repairSignature(target.appBundle, log, {
      resign: opts.resign !== false,
      clearQuarantine: opts.clearQuarantine !== false,
    });
  } catch (err) {
    log.warn(`macOS signature repair skipped: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function baselineManifest(target, paths) {
  return {
    framework: 'ggb-extend',
    frameworkVersion: FRAMEWORK_VERSION,
    injectedAt: new Date().toISOString(),
    lastInjectedAt: new Date().toISOString(),
    platform: target.platform,
    kind: target.kind,
    geogebraVersion: target.version || null,
    resources: target.resources,
    renamed: {
      original: path.basename(paths.appPath),
      to: path.basename(paths.corePath),
    },
  };
}

function describeStep(s) {
  switch (s.action) {
    case 'rename': return `Rename ${path.basename(s.from)} → ${path.basename(s.to)}`;
    case 'place-proxy': return `Install proxy at ${s.dest}`;
    case 'refresh-proxy': return `Refresh proxy at ${s.dest}`;
    case 'write-manifest': return `Write manifest ${path.basename(s.path)}`;
    default: return s.action;
  }
}

/**
 * Uninstall: restore the original layout and remove all GGB-Extend artifacts.
 *
 * @param {object} target  normalized target descriptor (re-detect before calling)
 * @param {object} [opts]  same shape as inject opts (fs, onLog, dryRun)
 */
async function uninstall(target, opts = {}) {
  const fs = opts.fs || defaultFs();
  const log = makeLogger(opts.onLog);
  const dryRun = !!opts.dryRun;

  if (!target || !target.resources) {
    throw new EngineError('Invalid target: missing resources directory', 'EBADTARGET');
  }
  const { resources, kind } = target;
  const isAsar = kind === 'asar';
  // Original entry path to restore TO (file for asar, folder for unpacked).
  const appPath = path.join(resources, isAsar ? 'app.asar' : 'app');
  const corePath = path.join(resources, isAsar ? 'core.asar' : 'core');
  // Our proxy always lives in the folder `app/` (see inject()). For the folder
  // layout proxyPath === appPath; for asar they differ.
  const proxyPath = path.join(resources, 'app');

  const coreExists = await fs.pathExists(corePath);

  // If the in-app `core` is gone, try recovering from an external backup before
  // giving up. The backup dir comes from opts.backupDir or the manifest.
  if (!coreExists) {
    const manifest = await readManifest(fs, resources);
    const backupDir = opts.backupDir || (manifest && manifest.externalBackup && manifest.externalBackup.dir);
    // When recovering, the on-disk core is gone so we can't re-detect the layout.
    // Trust the manifest's recorded kind (falls back to current detection).
    const recoverIsAsar = manifest && manifest.externalBackup
      ? manifest.externalBackup.kind === 'asar'
      : (manifest && manifest.kind ? manifest.kind === 'asar' : isAsar);
    const recoverAppPath = path.join(resources, recoverIsAsar ? 'app.asar' : 'app');
    if (backupDir && (await fs.pathExists(backupDir)) && !dryRun) {
      log.warn('In-app core missing — attempting recovery from external backup.');
      if (await fs.pathExists(proxyPath)) await fs.remove(proxyPath);
      const ok = await restoreFromExternalBackup(
        fs, { resources, isAsar: recoverIsAsar, appPath: recoverAppPath, backupDir }, log
      );
      if (ok) {
        const mp = manifestPath(resources);
        if (await fs.pathExists(mp)) await fs.remove(mp);
        await maybeRepairMacSignature(target, opts, log);
        log.ok('Uninstall complete (restored from external backup).');
        return { changed: true, restoredFrom: 'external-backup' };
      }
    }
    log.warn('Nothing to uninstall — no core backup found (already pristine?).');
    return { changed: false, reason: 'not-injected' };
  }

  const plan = [
    { action: 'remove', path: proxyPath, note: 'remove proxy folder' },
    { action: 'rename', from: corePath, to: appPath, note: 'restore original' },
    { action: 'remove', path: manifestPath(resources), note: 'remove manifest' },
  ];

  if (dryRun) {
    log.info('Dry run — no changes will be made. Planned restore:');
    plan.forEach((s, i) => log.step(`  ${i + 1}. ${s.action} ${s.path || `${path.basename(s.from)}→${path.basename(s.to)}`}`));
    return { changed: false, plan, dryRun: true };
  }

  if (!dryRun) {
    const perm = await checkWritable(fs, resources);
    if (!perm.writable) {
      throw new EngineError(
        `No write permission in ${resources} (${perm.reason}). Re-run elevated.`,
        'EPERM'
      );
    }
  }

  // 1) Remove our proxy folder (app/) if present.
  if (await fs.pathExists(proxyPath)) {
    log.step(`Removing proxy ${path.basename(proxyPath)}/`);
    await fs.remove(proxyPath);
  }
  // For the asar layout, also clear any leftover `app.asar` that isn't the core
  // (defensive — normally there is none, since the original was renamed).
  if (isAsar && appPath !== proxyPath && (await fs.pathExists(appPath))) {
    log.step(`Removing stray ${path.basename(appPath)}`);
    await fs.remove(appPath);
  }

  // 2) Restore original core(.asar) -> app(.asar)
  log.step(`Restoring ${path.basename(corePath)} → ${path.basename(appPath)}`);
  await fs.move(corePath, appPath, { overwrite: false });

  if (isAsar) {
    const unpackedSrc = path.join(resources, 'core.asar.unpacked');
    const unpackedDst = path.join(resources, 'app.asar.unpacked');
    if (await fs.pathExists(unpackedSrc)) {
      log.step('Restoring core.asar.unpacked → app.asar.unpacked');
      await fs.move(unpackedSrc, unpackedDst, { overwrite: false });
    }
  }

  // 3) Remove manifest + any stray bak.
  const mp = manifestPath(resources);
  if (await fs.pathExists(mp)) await fs.remove(mp);

  // macOS: we modified the bundle again by restoring it, and the inject step had
  // re-signed it ad-hoc. Re-sign once more so the restored bundle is internally
  // consistent and launchable. (If you prefer the pristine vendor signature,
  // reinstall GeoGebra; we can't reconstruct Apple's original signature.)
  const sign = await maybeRepairMacSignature(target, opts, log);

  log.ok('Uninstall complete. GeoGebra restored to its original state.');
  return { changed: true, plan, macSign: sign };
}

module.exports = {
  EngineError,
  MANIFEST_NAME,
  FRAMEWORK_VERSION,
  // internals (exported for tests)
  defaultFs,
  makeLogger,
  manifestPath,
  readManifest,
  writeManifest,
  inlineProxyPackageJson,
  inlineProxyMainJs,
  copyExternalBackup,
  restoreFromExternalBackup,
  placeProxy,
  checkWritable,
  // public API
  inject,
  uninstall,
};
