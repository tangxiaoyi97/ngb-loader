// @neogebra/sdk — public entry point for plugin authors.
export { GgbCore, whenAppletReady } from './ggb-core.js';
export { Emitter } from './emitter.js';
export { mountInAlgebraView } from './algebra-dock.js';
export { createNativeRow } from './algebra-row.js';
export {
  Plugin,
  PluginContext,
  MemoryStorage,
  validateManifest,
  runLifecycle,
} from './plugin.js';

export const VERSION = '1.0.0';
