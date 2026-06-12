// Dependency-free, browser-safe EventEmitter used across the SDK.
import { isDebug } from './plugin.js';

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {string} type
   * @param {(payload:any)=>void} handler
   * @returns {() => void}
   */
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  /** Subscribe once; auto-removes after the first emit. */
  once(type, handler) {
    const wrap = (payload) => {
      this.off(type, wrap);
      handler(payload);
    };
    return this.on(type, wrap);
  }

  /** Remove a specific handler (or all handlers for a type if handler omitted). */
  off(type, handler) {
    const set = this._listeners.get(type);
    if (!set) return;
    if (!handler) { set.clear(); return; }
    set.delete(handler);
  }

  /** Emit an event to all current subscribers. Errors are isolated. */
  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try { handler(payload); } catch (err) {
        // Quiet runtime: only report listener errors when debug is on.
        // eslint-disable-next-line no-console
        if (isDebug()) console.error(`[sdk] listener for "${type}" threw:`, err);
      }
    }
  }

  /** Remove every listener (used on plugin unload). */
  clear() { this._listeners.clear(); }
}
