'use strict';

// Cross-platform discovery of GeoGebra (Electron) installs. Produces a
// normalized "target" descriptor of the shape:
//   {
//     appBundle:  '/Applications/GeoGebra Classic 6.app',   // macOS .app (null on win)
//     resources:  '<...>/Contents/Resources' | '<...>/resources',
//     kind:       'asar' | 'folder',          // packaged vs. unpacked
//     entry:      '<resources>/app.asar' | '<resources>/app',
//     coreTarget: '<resources>/core.asar' | '<resources>/core',
//     state:      'pristine' | 'injected' | 'unknown',
//     version:    '6.0.920' | null,
//     platform:   'darwin' | 'win32' | 'linux'
//   }

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Name of the proxy package we drop in, used to recognize our own injection. */
const PROXY_PKG_NAME = 'ggb-extend-proxy';

/* ------------------------------------------------------------------ *
 * Low-level filesystem helpers (sync, dependency-free)
 * ------------------------------------------------------------------ */

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Candidate root enumeration per platform
 * ------------------------------------------------------------------ */

/**
 * Return a list of directories that *might* contain a GeoGebra install.
 * These are roots — we still glob for "GeoGebra*" inside them.
 */
function candidateRoots(platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'darwin') {
    return [
      '/Applications',
      path.join(home, 'Applications'),
    ];
  }
  if (platform === 'win32') {
    const roots = [];
    // Per-user install (no admin needed) — GeoGebra's NSIS installer defaults here.
    if (env.LOCALAPPDATA) {
      roots.push(path.join(env.LOCALAPPDATA, 'Programs'));
      roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'geogebra-classic'));
    }
    // Machine-wide installs (need admin to modify).
    if (env.ProgramFiles) roots.push(env.ProgramFiles);
    if (env['ProgramFiles(x86)']) roots.push(env['ProgramFiles(x86)']);
    // Fallbacks if the env vars are missing (rare). Use the real drive from
    // SystemDrive when available, defaulting to C:.
    const sysDrive = (env.SystemDrive || 'C:').replace(/\\+$/, '');
    roots.push(`${sysDrive}\\Program Files`);
    roots.push(`${sysDrive}\\Program Files (x86)`);
    // De-duplicate while preserving order.
    return [...new Set(roots)];
  }
  // linux / other
  return [
    '/opt',
    '/usr/lib',
    '/usr/local',
    path.join(home, '.local', 'share'),
  ];
}

/** Case-insensitive "starts with geogebra" match on a directory name. */
function looksLikeGeoGebra(name) {
  return /^geogebra/i.test(name);
}

/**
 * Shallow-scan a root directory for entries whose name starts with "GeoGebra".
 * Returns absolute paths. Never throws.
 */
function scanRoot(root) {
  if (!isDir(root)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && looksLikeGeoGebra(e.name))
    .map((e) => path.join(root, e.name));
}

/* ------------------------------------------------------------------ *
 * Resolve a single path into a normalized target
 * ------------------------------------------------------------------ */

/**
 * Given any path the user/scanner found (an .app bundle, an install dir, or a
 * Resources dir directly), locate the Electron resources directory.
 */
function resolveResourcesDir(inputPath, platform = process.platform) {
  if (!inputPath) return null;

  // The path may already BE a resources dir.
  if (isDir(path.join(inputPath, '..')) && /resources$/i.test(path.basename(inputPath))) {
    if (exists(path.join(inputPath, 'app')) || exists(path.join(inputPath, 'app.asar')) ||
        exists(path.join(inputPath, 'core')) || exists(path.join(inputPath, 'core.asar'))) {
      return inputPath;
    }
  }

  if (platform === 'darwin') {
    // macOS: /path/GeoGebra*.app/Contents/Resources
    const candidate = path.join(inputPath, 'Contents', 'Resources');
    if (isDir(candidate)) return candidate;
    // Maybe they pointed straight at Contents
    if (isDir(path.join(inputPath, 'Resources'))) {
      return path.join(inputPath, 'Resources');
    }
  }

  // Windows / Linux: install dir contains a "resources" folder directly.
  const winLike = path.join(inputPath, 'resources');
  if (isDir(winLike)) return winLike;

  return null;
}

/**
 * Inspect a resources directory and classify it. Returns a partial target
 * (without appBundle/version) or null if it doesn't look like an Electron app.
 */
function classifyResources(resources) {
  if (!isDir(resources)) return null;

  const appFolder = path.join(resources, 'app');
  const appAsar = path.join(resources, 'app.asar');
  const coreFolder = path.join(resources, 'core');
  const coreAsar = path.join(resources, 'core.asar');

  const hasAppFolder = isDir(appFolder);
  const hasAppAsar = isFile(appAsar);
  const hasCoreFolder = isDir(coreFolder);
  const hasCoreAsar = isFile(coreAsar);

  // Determine whether the original payload is packed (asar) or unpacked (folder).
  // We look at whichever the *core* (real app) is, falling back to the app entry.
  // `kind` describes the ORIGINAL payload type (asar vs unpacked folder).
  // Priority rule: once injected, a `core*` exists and the core's type is the
  // source of truth (our proxy is always an unpacked `app/` folder, so the
  // presence of an `app/` folder must NOT force kind='folder').
  let kind = null;
  if (hasCoreAsar) kind = 'asar';            // injected, original was packaged
  else if (hasCoreFolder) kind = 'folder';   // injected, original was unpacked
  else if (hasAppAsar) kind = 'asar';        // pristine, packaged
  else if (hasAppFolder) kind = 'folder';    // pristine, unpacked

  if (!kind) return null; // not an electron app we recognize

  // `entry` = where the bootable original currently is. After injection that is
  // the core; before injection it is the app.
  const coreExistsForEntry = hasCoreAsar || hasCoreFolder;
  const entry = coreExistsForEntry
    ? (kind === 'asar' ? coreAsar : coreFolder)
    : (kind === 'asar' ? appAsar : appFolder);
  const coreTarget = kind === 'asar' ? coreAsar : coreFolder;

  // Detect current injection state.
  // injected   => a `core(.asar)` exists (we renamed original there) AND an
  //               `app(.asar)` proxy exists whose package.json is ours.
  // pristine   => only the original `app(.asar)` exists, no core.
  let state = 'unknown';
  const coreExists = hasCoreFolder || hasCoreAsar;
  const appExists = hasAppFolder || hasAppAsar;

  if (coreExists && appExists) {
    state = 'injected';
  } else if (appExists && !coreExists) {
    state = 'pristine';
  } else if (coreExists && !appExists) {
    // core present but no app proxy — half-injected / broken
    state = 'unknown';
  }

  // Refine: confirm the proxy is *ours* when an app folder proxy is present.
  let proxyIsOurs = false;
  if (hasAppFolder) {
    const pkg = readJsonSafe(path.join(appFolder, 'package.json'));
    if (pkg && (pkg.name === PROXY_PKG_NAME || pkg.ggbExtend === true)) {
      proxyIsOurs = true;
    }
  }

  return {
    resources,
    kind,
    entry,
    coreTarget,
    state,
    proxyIsOurs,
    has: {
      appFolder: hasAppFolder,
      appAsar: hasAppAsar,
      coreFolder: hasCoreFolder,
      coreAsar: hasCoreAsar,
    },
  };
}

/** Try to read a human version string from the install. */
function readVersion(resources, classified) {
  // Prefer the core (original) package.json once injected; otherwise the app one.
  const candidates = [];
  if (classified.has.coreFolder) candidates.push(path.join(resources, 'core', 'package.json'));
  if (classified.has.appFolder) candidates.push(path.join(resources, 'app', 'package.json'));
  for (const c of candidates) {
    const pkg = readJsonSafe(c);
    if (pkg && pkg.version) return pkg.version;
  }
  return null;
}

/** Derive the .app bundle path (macOS) from a resources dir, if applicable. */
function deriveAppBundle(resources, platform = process.platform) {
  if (platform !== 'darwin') return null;
  // resources = <bundle>.app/Contents/Resources
  const contents = path.dirname(resources);
  const bundle = path.dirname(contents);
  if (/\.app$/i.test(bundle)) return bundle;
  return null;
}

/**
 * Turn any input path into a fully-normalized target descriptor, or null.
 */
function describeTarget(inputPath, platform = process.platform) {
  const resources = resolveResourcesDir(inputPath, platform);
  if (!resources) return null;
  const classified = classifyResources(resources);
  if (!classified) return null;
  return {
    appBundle: deriveAppBundle(resources, platform),
    resources: classified.resources,
    kind: classified.kind,
    entry: classified.entry,
    coreTarget: classified.coreTarget,
    state: classified.state,
    proxyIsOurs: classified.proxyIsOurs,
    has: classified.has,
    version: readVersion(resources, classified),
    platform,
  };
}

/**
 * Auto-scan the whole machine for GeoGebra installs. Returns an array of
 * normalized targets (possibly empty).
 */
function scan(platform = process.platform, env = process.env) {
  const found = [];
  const seen = new Set();
  const consider = (hit) => {
    const target = describeTarget(hit, platform);
    if (target && !seen.has(target.resources)) {
      seen.add(target.resources);
      found.push(target);
    }
  };
  for (const root of candidateRoots(platform, env)) {
    // A root may itself BE an install dir (e.g. Windows
    // %LOCALAPPDATA%\Programs\geogebra-classic), so try it directly…
    consider(root);
    // …and also scan one level down for "GeoGebra*" entries (the common case on
    // macOS /Applications and Windows Program Files).
    for (const hit of scanRoot(root)) consider(hit);
  }
  return found;
}

module.exports = {
  PROXY_PKG_NAME,
  // helpers (exported for testing)
  exists,
  isDir,
  isFile,
  readJsonSafe,
  candidateRoots,
  looksLikeGeoGebra,
  scanRoot,
  resolveResourcesDir,
  classifyResources,
  deriveAppBundle,
  // public API
  describeTarget,
  scan,
};
