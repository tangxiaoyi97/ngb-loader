// @neogebra/sdk — public entry point for plugin authors.
export { GgbCore, whenAppletReady } from './ggb-core.js';
export { Emitter } from './emitter.js';
export { mountInAlgebraView } from './algebra-dock.js';
export { createNativeRow, readGgbTheme, detectThemeMode } from './algebra-row.js';
export {
  selectProfile, getProfile, metrics as domMetrics, selfCheck, rowsUsable,
} from './ggb-dom-adapter.js';
export { subscribeDom, observerCount } from './shared-observer.js';
export { themeTokens, onThemeChange } from './host-theme.js';
export { getHostLocale, makeT } from './i18n.js';
export {
  Plugin,
  PluginContext,
  MemoryStorage,
  HostStorage,
  encodeNamespace,
  decodeNamespace,
  setDebug,
  isDebug,
  validateManifest,
  runLifecycle,
} from './plugin.js';

export const VERSION = '2.0.0-beta';
