'use strict';

/**
 * Persistent store for the desktop manager's multi-GeoGebra state (registry.json).
 *
 * Shape of registry.json:
 * {
 *   "version": 1,
 *   "settings": { "defaultBackupDir": "/Users/x/GGB-Backups" },
 *   "entries": {
 *     "<id>": {
 *       "id": "ggb-6-0-570-ab12cd",
 *       "label": "GeoGebra Classic 6",
 *       "path": "/Applications/GeoGebra Classic 6.app",
 *       "addedAt": "ISO",
 *       "backupDir": "/Users/x/GGB-Backups/ggb-6-0-570-ab12cd",
 *       "plugins": { "hello-plugin": true }
 *     }
 *   }
 * }
 */

const path = require('path');
const crypto = require('crypto');

function defaultFs() {
  try { return require('fs-extra'); } catch {
    const fsp = require('fs').promises;
    return {
      pathExists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
      ensureDir: (p) => fsp.mkdir(p, { recursive: true }),
      readJson: async (p) => JSON.parse(await fsp.readFile(p, 'utf8')),
      writeJson: async (p, o, opt = {}) => fsp.writeFile(p, JSON.stringify(o, null, opt.spaces || 2)),
      remove: (p) => fsp.rm(p, { recursive: true, force: true }),
    };
  }
}

const EMPTY = () => ({ version: 1, settings: {}, entries: {} });

/**
 * Stable id for a GeoGebra install, derived ONLY from its Resources directory
 * (NOT its version). This MUST match the proxy's ggbId() exactly so per-install
 * plugin state isolates correctly — see packages/proxy-core/src/main.js, which
 * hashes the same Resources dir. The version is deliberately excluded because it
 * is detected at different times on the two sides and could diverge.
 * @param {string} resourcesDir  the install's Resources directory
 */
function makeId(resourcesDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(resourcesDir)).digest('hex').slice(0, 12);
  return `ggb-${hash}`;
}

class Registry {
  /**
   * @param {string} file absolute path to registry.json
   * @param {object} [fs] fs-extra-like implementation (injectable for tests)
   */
  constructor(file, fs) {
    this.file = file;
    this.fs = fs || defaultFs();
    this.data = EMPTY();
  }

  async load() {
    if (await this.fs.pathExists(this.file)) {
      try { this.data = normalize(await this.fs.readJson(this.file)); }
      catch { this.data = EMPTY(); }
    } else {
      this.data = EMPTY();
    }
    return this.data;
  }

  async save() {
    await this.fs.ensureDir(path.dirname(this.file));
    await this.fs.writeJson(this.file, this.data, { spaces: 2 });
    return this.data;
  }

  getSettings() { return { ...this.data.settings }; }
  async setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    await this.save();
    return this.getSettings();
  }

  list() { return Object.values(this.data.entries); }
  get(id) { return this.data.entries[id] || null; }
  findByPath(p) {
    const abs = path.resolve(p);
    return this.list().find((e) => path.resolve(e.path) === abs) || null;
  }

  /**
   * Add (or return existing) entry for a GeoGebra path.
   * @returns {{entry: object, created: boolean}}
   */
  async add({ path: ggbPath, idPath, label, version, backupDir }) {
    if (!ggbPath) throw new Error('add() requires a path');
    const existing = this.findByPath(ggbPath);
    if (existing) return { entry: existing, created: false };

    // Hash the Resources dir (idPath) so the id matches the proxy's ggbId(); fall
    // back to the install path only if a resources dir wasn't provided.
    const id = makeId(idPath || ggbPath);
    const entry = {
      id,
      label: label || path.basename(ggbPath).replace(/\.app$/i, ''),
      path: path.resolve(ggbPath),
      version: version || null,
      addedAt: new Date().toISOString(),
      backupDir: backupDir || null,
      plugins: {},
    };
    this.data.entries[id] = entry;
    await this.save();
    return { entry, created: true };
  }

  async update(id, patch) {
    const e = this.data.entries[id];
    if (!e) throw new Error(`no entry: ${id}`);
    // plugins is merged, not replaced
    if (patch.plugins) patch.plugins = { ...e.plugins, ...patch.plugins };
    this.data.entries[id] = { ...e, ...patch };
    await this.save();
    return this.data.entries[id];
  }

  async remove(id) {
    const existed = !!this.data.entries[id];
    delete this.data.entries[id];
    await this.save();
    return existed;
  }

  setPluginEnabled(id, pluginId, enabled) {
    const e = this.data.entries[id];
    if (!e) throw new Error(`no entry: ${id}`);
    e.plugins[pluginId] = !!enabled;
    return this.save().then(() => e.plugins);
  }

  /** Compute the per-entry backup dir, honoring an explicit value or the default. */
  resolveBackupDir(entry) {
    if (entry.backupDir) return entry.backupDir;
    const base = this.data.settings.defaultBackupDir;
    if (!base) return null;
    return path.join(base, entry.id);
  }
}

/** Ensure a loaded object has all required keys. */
function normalize(obj) {
  const out = EMPTY();
  if (obj && typeof obj === 'object') {
    out.version = obj.version || 1;
    out.settings = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
    out.entries = obj.entries && typeof obj.entries === 'object' ? obj.entries : {};
  }
  // guarantee each entry has a plugins object
  for (const e of Object.values(out.entries)) {
    if (!e.plugins || typeof e.plugins !== 'object') e.plugins = {};
  }
  return out;
}

module.exports = { Registry, makeId, defaultFs };
