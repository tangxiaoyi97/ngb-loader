'use strict';

// The desktop app's business logic (Electron-independent): composes the Registry
// with injector-core and exposes the high-level actions the IPC layer calls.

const path = require('path');
const { PluginsStore } = require('./plugins-store');

class Manager {
  /**
   * @param {object} deps
   * @param {import('./registry').Registry} deps.registry
   * @param {object} deps.injector  the @neogebra/injector-core module (or a fake)
   * @param {string} [deps.platform] override platform for detection (tests)
   * @param {function} [deps.onLog]  forwarded to inject/uninstall
   * @param {object} [deps.pluginsStore] override the shared plugin store (tests)
   */
  constructor({ registry, injector, platform, onLog, pluginsStore }) {
    this.registry = registry;
    this.injector = injector;
    this.platform = platform || process.platform;
    this.onLog = onLog || (() => {});
    // The shared plugin library + state.json — the single source of truth for
    // plugin enable/disable, shared by all injected GeoGebras and the runtime.
    this.plugins = pluginsStore || new PluginsStore({ platform: this.platform });
  }

  /** Detected installs on the machine (for the "add" picker). */
  scan() {
    return this.injector.scan(this.platform);
  }

  /** Describe a path; returns normalized target or null. */
  describe(p) {
    return this.injector.describeTarget(path.resolve(p), this.platform);
  }

  /**
   * Validate a path is a GeoGebra/Electron install, then register it.
   * @returns {{entry, created, target}}
   */
  async addByPath(p) {
    const target = this.describe(p);
    if (!target) {
      const err = new Error(`No GeoGebra/Electron install found at: ${p}`);
      err.code = 'ENOTGGB';
      throw err;
    }
    const { entry, created } = await this.registry.add({
      path: target.appBundle || p,        // human-readable path stored on the entry
      idPath: target.resources,           // canonical anchor for the id (matches proxy ggbId)
      version: target.version,
    });
    return { entry, created, target };
  }

  async removeEntry(id, { restoreFirst = false } = {}) {
    if (restoreFirst) {
      try { await this.restore(id); } catch { /* best-effort */ }
    }
    return this.registry.remove(id);
  }

  /** Registered GGBs, each merged with its live injection state. */
  listEntries() {
    return this.registry.list().map((e) => {
      let target = null;
      try { target = this.describe(e.path); } catch { /* path may be gone */ }
      return {
        ...e,
        backupDirResolved: this.registry.resolveBackupDir(e),
        live: target
          ? { state: target.state, kind: target.kind, version: target.version, exists: true }
          : { state: 'missing', exists: false },
      };
    });
  }

  /**
   * Inject a registered GGB. Uses its resolved backup dir so a copy of the
   * original is stored outside the app.
   * @param {string} id
   * @param {object} [opts] proxyDir, skipSign, dryRun
   */
  async inject(id, opts = {}) {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`no entry: ${id}`);
    const target = this.describe(entry.path);
    if (!target) { const e = new Error('GeoGebra path is missing'); e.code = 'EMISSING'; throw e; }

    const backupDir = this.registry.resolveBackupDir(entry);
    const res = await this.injector.inject(target, {
      onLog: this.onLog,
      proxyDir: opts.proxyDir,
      skipSign: opts.skipSign,
      dryRun: opts.dryRun,
      backupDir: backupDir || undefined,
    });
    // persist the backup dir actually used
    if (backupDir && entry.backupDir !== backupDir) {
      await this.registry.update(id, { backupDir });
    }
    return res;
  }

  /** Restore (uninstall) a registered GGB. */
  async restore(id, opts = {}) {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`no entry: ${id}`);
    const target = this.describe(entry.path);
    if (!target) { const e = new Error('GeoGebra path is missing'); e.code = 'EMISSING'; throw e; }
    const backupDir = this.registry.resolveBackupDir(entry);
    return this.injector.uninstall(target, {
      onLog: this.onLog,
      skipSign: opts.skipSign,
      dryRun: opts.dryRun,
      backupDir: backupDir || undefined,
    });
  }

  /**
   * Compute the OS executable path to launch a registered GeoGebra.
   * macOS: <bundle>.app/Contents/MacOS/<exe>; Windows/Linux: the install's exe.
   */
  launchTarget(id) {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`no entry: ${id}`);
    return resolveExecutable(entry.path, this.platform);
  }

  // Plugins live in ONE shared library (all injected GeoGebras share it), so
  // these operate on the shared state.json — the same file the runtime reads.

  /** List installed plugins (shared files) with enabled state FOR a given GGB. */
  async listPlugins(ggbId) {
    return this.plugins.list(ggbId);
  }

  /** Enable/disable a plugin for a specific GGB (per-target state.json). */
  async setPluginEnabled(ggbId, pluginId, enabled) {
    return this.plugins.setEnabled(ggbId, pluginId, enabled);
  }

  /** The shared plugins folder path (for "open folder"). */
  pluginsRoot() { return this.plugins.root; }

  /**
   * Install (or update) a plugin into the shared library by copying a source
   * folder. Returns the installed manifest. Plugins are loaded dynamically from
   * the library at GeoGebra startup, so updating a plugin is just re-copying its
   * files here and restarting GeoGebra.
   * @param {string} sourceDir absolute path to a folder containing manifest.json
   */
  async installPluginFromFolder(sourceDir) {
    const fs = require('fs-extra');
    const mp = path.join(sourceDir, 'manifest.json');
    if (!fs.existsSync(mp)) { const e = new Error('No manifest.json in that folder'); e.code = 'ENOMANIFEST'; throw e; }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); }
    catch { const e = new Error('manifest.json is not valid JSON'); e.code = 'EBADMANIFEST'; throw e; }
    const id = manifest.id || path.basename(sourceDir);
    if (manifest.builtin) { const e = new Error('Cannot install a built-in plugin'); e.code = 'EBUILTIN'; throw e; }

    const dest = path.join(this.pluginsRoot(), id);
    await fs.ensureDir(this.pluginsRoot());
    await fs.remove(dest);
    await fs.copy(sourceDir, dest, { overwrite: true });
    this.onLog({ level: 'ok', msg: `Installed plugin "${id}"`, ts: Date.now() });
    return { id, name: manifest.name || id, dir: dest };
  }

  getSettings() { return this.registry.getSettings(); }
  async setSettings(patch) { return this.registry.setSettings(patch); }
}

/**
 * Resolve the launchable executable for a GeoGebra install.
 * macOS .app: read CFBundleExecutable from Info.plist (fallback to folder name).
 */
function resolveExecutable(installPath, platform = process.platform) {
  const fs = require('fs');
  if (platform === 'darwin' && /\.app$/i.test(installPath)) {
    const macosDir = path.join(installPath, 'Contents', 'MacOS');
    // Prefer the name declared in Info.plist.
    try {
      const plist = fs.readFileSync(path.join(installPath, 'Contents', 'Info.plist'), 'utf8');
      const m = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      if (m && m[1]) {
        const exe = path.join(macosDir, m[1]);
        if (fs.existsSync(exe)) return exe;
      }
    } catch { /* fall through */ }
    // Fallback: first file in MacOS/.
    try {
      const files = fs.readdirSync(macosDir);
      if (files[0]) return path.join(macosDir, files[0]);
    } catch { /* fall through */ }
    return path.join(macosDir, path.basename(installPath).replace(/\.app$/i, ''));
  }
  // Windows / Linux: the install path itself may be the exe, or contain one.
  return installPath;
}

module.exports = { Manager, resolveExecutable };
