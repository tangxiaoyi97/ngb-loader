'use strict';

// @neogebra/injector-core — public surface of the injection engine (no network/UI).
const detect = require('./detect');
const engine = require('./engine');
const macos = require('./macos');

module.exports = {
  // detection
  scan: detect.scan,
  describeTarget: detect.describeTarget,
  // operations
  inject: engine.inject,
  uninstall: engine.uninstall,
  // diagnostics / types
  EngineError: engine.EngineError,
  MANIFEST_NAME: engine.MANIFEST_NAME,
  FRAMEWORK_VERSION: engine.FRAMEWORK_VERSION,
  // macOS signing helpers
  macos,
  // namespaced access for advanced callers / tests
  detect,
  engine,
};
