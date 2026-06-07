/**
 * hello-plugin — a reference plugin for GGB-Extend.
 *
 * The framework loads this module's default export, constructs it with a
 * PluginContext, and drives onLoad → onEnable → onDisable → onUnload.
 */
import { Plugin } from '@neogebra/sdk';

export default class HelloPlugin extends Plugin {
  async onLoad(ctx) {
    ctx.log.info('loaded. SDK version available via ctx.');
    // Remember how many times we've been enabled across the session.
    this._enableCount = ctx.storage.get('enableCount', 0);
  }

  async onEnable(ctx) {
    const { core, storage, log } = ctx;

    this._enableCount += 1;
    storage.set('enableCount', this._enableCount);
    log.info(`enabled (#${this._enableCount}). Dropping a point…`);

    // Create a labelled point using the modern Promise API.
    const name = await core.objects.createPoint(2, 3, 'Hello');
    await core.objects.setColor(name, 91, 118, 216);
    this._pointName = name;

    // React to construction changes; auto-cleaned on disable.
    const off = core.on('add', ({ name: added }) => {
      if (added !== this._pointName) log.info('object added:', added);
    });
    ctx.registerDisposable(off);

    // Also clean up our own point when disabled.
    ctx.registerDisposable(async () => {
      try { await core.objects.remove(this._pointName); } catch { /* already gone */ }
    });
  }

  async onDisable(ctx) {
    ctx.log.info('disabled. (disposables run automatically.)');
  }

  async onUnload(ctx) {
    ctx.log.info('unloaded. goodbye.');
  }
}
