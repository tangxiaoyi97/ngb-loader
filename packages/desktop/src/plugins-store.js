'use strict';

/**
 * Read/write the SHARED GeoGebra plugin library + state.json (single source of
 * truth for plugin enable/disable, read by the in-GeoGebra runtime at startup).
 *
 * All injected GeoGebras of the same product share ONE library at the proxy's
 * `userData/GGB_Plugins` — keyed by the proxy's productName "GeoGebra (NeoGebra)",
 * NOT this app's userData. Paths must match exactly or state silently diverges.
 */

const path = require('path');
const os = require('os');
const nodeFs = require('fs');

// Resolve a plugin's manifest `icon` (relative to its folder) into a data: URI
// so the renderer can display it. Returns null when unset/missing/too large/not
// an image. Mirrors the proxy-side helper used for the in-GeoGebra panel.
function iconToDataUri(dir, icon) {
  if (!icon || typeof icon !== 'string') return null;
  try {
    if (/^data:/i.test(icon)) return icon;
    const file = path.join(dir, icon);
    if (!nodeFs.existsSync(file)) return null;
    const buf = nodeFs.readFileSync(file);
    if (buf.length > 256 * 1024) return null;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif' : null;
    if (!mime) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function defaultFs() {
  try { return require('fs-extra'); } catch {
    const fsp = require('fs').promises; const fss = require('fs');
    return {
      existsSync: fss.existsSync,
      readdirSync: fss.readdirSync,
      pathExists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
      ensureDir: (p) => fsp.mkdir(p, { recursive: true }),
      readJson: async (p) => JSON.parse(await fsp.readFile(p, 'utf8')),
      writeJson: async (p, o, opt = {}) => fsp.writeFile(p, JSON.stringify(o, null, opt.spaces || 2)),
      readFileSync: fss.readFileSync,
    };
  }
}

/**
 * Resolve the shared GGB_Plugins root. Mirrors the proxy's userData location.
 * Honors an explicit override (tests) else derives per-platform from productName.
 */
function resolvePluginsRoot(override, platform = process.platform) {
  if (override) return override;
  const home = os.homedir();
  const product = 'GeoGebra (NeoGebra)';
  let userData;
  if (platform === 'darwin') userData = path.join(home, 'Library', 'Application Support', product);
  else if (platform === 'win32') userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), product);
  else userData = path.join(home, '.config', product);
  return path.join(userData, 'GGB_Plugins');
}

class PluginsStore {
  constructor({ root, fs, platform } = {}) {
    this.fs = fs || defaultFs();
    this.root = resolvePluginsRoot(root, platform);
    this.stateFile = path.join(this.root, 'state.json');
  }

  async readState() {
    if (await this.fs.pathExists(this.stateFile)) {
      try { return await this.fs.readJson(this.stateFile); } catch { /* fall through */ }
    }
    return { version: 1, enabled: {}, settings: {} };
  }

  async writeState(state) {
    await this.fs.ensureDir(this.root);
    await this.fs.writeJson(this.stateFile, state, { spaces: 2 });
    return state;
  }

  /** Read a plugin folder's manifest (normalized) or null. */
  readManifest(dir) {
    const mp = path.join(dir, 'manifest.json');
    if (!this.fs.existsSync(mp)) return null;
    try {
      const m = JSON.parse(this.fs.readFileSync(mp, 'utf8'));
      const id = m.id || path.basename(dir);
      return {
        id,
        name: m.name || id,
        version: m.version || '0.0.0',
        author: m.author || 'unknown',
        description: m.description || '',
        icon: iconToDataUri(dir, m.icon),
        builtin: !!m.builtin,
        dir,
      };
    } catch {
      return { id: path.basename(dir), name: path.basename(dir), broken: true, error: 'invalid manifest.json', dir };
    }
  }

  /** Enabled-map for a specific GGB id (per-target schema, back-compat flat). */
  targetEnabled(state, ggbId) {
    if (ggbId && state.targets && state.targets[ggbId] && state.targets[ggbId].enabled) {
      return state.targets[ggbId].enabled;
    }
    if (state.enabled && Object.keys(state.enabled).length) return state.enabled; // legacy
    return {};
  }

  /**
   * List installed plugins merged with enabled state FOR A GIVEN GGB id.
   * P2-3: default DISABLED — a plugin runs only after the user explicitly
   * enabled it for that GeoGebra (matches the runtime). Three states:
   *   true → enabled · false → user disabled · absent → 'new' (never decided)
   * Built-in plugins are bundled framework components and must stay listed as
   * enabled even if an old state file contains false for their id.
   */
  async list(ggbId) {
    const out = [];
    let entries = [];
    try { entries = this.fs.readdirSync(this.root, { withFileTypes: true }); } catch { return out; }
    const state = await this.readState();
    const enabled = this.targetEnabled(state, ggbId);
    for (const e of entries) {
      if (!e.isDirectory || !e.isDirectory()) continue;
      const m = this.readManifest(path.join(this.root, e.name));
      if (!m) continue;
      if (m.builtin) {
        m.enabled = true;
        m.status = 'enabled';
        out.push(m);
        continue;
      }
      const rec = enabled[m.id];
      m.enabled = rec === true;
      m.status = rec === true ? 'enabled' : rec === false ? 'disabled' : 'new';
      out.push(m);
    }
    return out;
  }

  /** Set a plugin's enabled flag for a specific GGB id (per-target). */
  async setEnabled(ggbId, id, enabled) {
    const state = await this.readState();
    if (!state.targets) state.targets = {};
    if (!state.targets[ggbId]) state.targets[ggbId] = { enabled: {} };
    if (!state.targets[ggbId].enabled) state.targets[ggbId].enabled = {};
    state.targets[ggbId].enabled[id] = !!enabled;
    state.version = 2;
    await this.writeState(state);
    return state.targets[ggbId].enabled;
  }
}

module.exports = { PluginsStore, resolvePluginsRoot, defaultFs };
