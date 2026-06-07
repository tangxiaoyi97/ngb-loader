// Promise/Emitter wrapper around the GeoGebra applet API. The raw applet stays
// reachable via `core.raw` for commands not yet wrapped.
import { Emitter } from './emitter.js';

const DEFAULT_TIMEOUT = 10000;

/** Resolve when window.ggbApplet (and its API) is ready. */
export function whenAppletReady({ timeout = DEFAULT_TIMEOUT, getApplet } = {}) {
  const read = getApplet || (() => (typeof window !== 'undefined' ? window.ggbApplet : null));
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const applet = read();
      // evalCommand is a good readiness probe — it exists once the API is wired.
      if (applet && typeof applet.evalCommand === 'function') return resolve(applet);
      if (Date.now() - start > timeout) {
        return reject(new Error('GeoGebra applet did not become ready in time'));
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

/** Promise-based object sub-API: create/query/modify/delete geometry. */
class ObjectsApi {
  constructor(core) { this._core = core; }

  get _ggb() { return this._core.raw; }

  /** Run a raw GeoGebra command (e.g. "A=(1,2)"). Resolves to the command's success. */
  async eval(command) {
    return Boolean(this._ggb.evalCommand(command));
  }

  /** Create a free point. Returns the created object's name. */
  async createPoint(x, y, name) {
    const label = name || this._core._uniqueName('P');
    const ok = this._ggb.evalCommand(`${label}=(${x},${y})`);
    if (!ok) throw new Error(`Failed to create point ${label}`);
    return label;
  }

  /** Create a line segment between two existing points (or coordinates). */
  async createSegment(a, b, name) {
    const label = name || this._core._uniqueName('seg');
    const ok = this._ggb.evalCommand(`${label}=Segment(${a},${b})`);
    if (!ok) throw new Error('Failed to create segment');
    return label;
  }

  /** Read a numeric value for an object/expression. */
  async getValue(name) {
    return this._ggb.getValue(name);
  }

  /** Read the (x,y[,z]) coordinates of an object. */
  async getCoords(name) {
    const x = this._ggb.getXcoord(name);
    const y = this._ggb.getYcoord(name);
    const z = this._ggb.getZcoord ? this._ggb.getZcoord(name) : 0;
    return { x, y, z };
  }

  /** Move an object to new coordinates. */
  async setCoords(name, x, y, z = 0) {
    if (this._ggb.setCoords) this._ggb.setCoords(name, x, y, z);
    else this._ggb.evalCommand(`SetCoords(${name},${x},${y})`);
    return this.getCoords(name);
  }

  /** Show/hide an object. */
  async setVisible(name, visible) {
    this._ggb.setVisible(name, !!visible);
  }

  /** Set an object's color (RGB 0-255). */
  async setColor(name, r, g, b) {
    this._ggb.setColor(name, r, g, b);
  }

  /** Delete an object by name. */
  async remove(name) {
    this._ggb.deleteObject(name);
  }

  /** List all object names currently in the construction. */
  async list() {
    const n = this._ggb.getObjectNumber();
    const names = [];
    for (let i = 0; i < n; i++) names.push(this._ggb.getObjectName(i));
    return names;
  }

  /** Whether an object with the given name exists. */
  async exists(name) {
    return Boolean(this._ggb.exists ? this._ggb.exists(name) : this._ggb.getObjectType(name));
  }
}

/** Top-level facade. Use `GgbCore.create()` to wait for the applet, or `new GgbCore(applet)` with a ready one. */
export class GgbCore {
  /**
   * @param {any} applet a ready window.ggbApplet
   */
  constructor(applet) {
    if (!applet) throw new Error('GgbCore requires a ready applet');
    this.raw = applet;
    this.events = new Emitter();
    this.objects = new ObjectsApi(this);
    this._counter = 0;
    this._registered = false;
    this._listenerHandles = [];
  }

  /** Async factory: resolves once the applet is ready. */
  static async create(opts = {}) {
    const applet = await whenAppletReady(opts);
    const core = new GgbCore(applet);
    core._wireEvents();
    return core;
  }

  _uniqueName(prefix) {
    this._counter += 1;
    return `${prefix}${Date.now().toString(36)}${this._counter}`;
  }

  /**
   * Bridge GeoGebra's register*Listener callbacks into our Emitter.
   * Events: 'add', 'remove', 'update', 'rename', 'clear', 'click'.
   */
  _wireEvents() {
    if (this._registered) return;
    const g = this.raw;
    const safe = (fn) => { try { fn(); } catch (e) { /* applet may lack some */ } };

    safe(() => g.registerAddListener && g.registerAddListener((name) => this.events.emit('add', { name })));
    safe(() => g.registerRemoveListener && g.registerRemoveListener((name) => this.events.emit('remove', { name })));
    safe(() => g.registerUpdateListener && g.registerUpdateListener((name) => this.events.emit('update', { name })));
    safe(() => g.registerRenameListener && g.registerRenameListener((oldName, newName) => this.events.emit('rename', { oldName, newName })));
    safe(() => g.registerClearListener && g.registerClearListener(() => this.events.emit('clear', {})));
    safe(() => g.registerClickListener && g.registerClickListener((name) => this.events.emit('click', { name })));
    this._registered = true;
  }

  /**
   * Subscribe to a construction event. Returns an unsubscribe function.
   * @param {'add'|'remove'|'update'|'rename'|'clear'|'click'} type
   */
  on(type, handler) {
    return this.events.on(type, handler);
  }

  once(type, handler) { return this.events.once(type, handler); }

  /** Tear down all SDK-level listeners (call from plugin onUnload). */
  dispose() {
    this.events.clear();
  }
}

export default GgbCore;
