# Writing GGB-Extend Plugins (v0.2 runtime)

A plugin is a folder with a `manifest.json` and an entry module that default-exports
a class extending `Plugin`. The **runtime** (injected into GeoGebra) loads enabled
plugins on startup, runs their lifecycle, and bridges a "设置" (Settings) button in
the panel to each plugin's `onOpenSettings()`.

## Architecture (how plugins actually run)

```
GeoGebra starts
  → proxy main.js patches BrowserWindow, injects preload.js
    → preload.js injects runtime.bundle.js into the page's main world
       (runtime = SDK + plugin loader + the built-in panel plugin)
    → preload reads the installed-plugin list + each plugin's source over IPC
    → runtime.boot(): loads the built-in panel FIRST, then enabled user plugins
       - evaluates each plugin's source with the SDK injected
       - runs onLoad → onEnable
    → the runtime API is handed to plugins as ctx.runtime; the panel lists all loaded plugins
```

The **panel itself is a built-in plugin** (`panel-manager`), loaded through the exact
same path as user plugins — it's just flagged `builtin` so it always loads and can't
be disabled. It appears in the plugin list (marked 内置).

## Minimal plugin

```
my-plugin/
  manifest.json
  src/index.js
```

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "you",
  "description": "...",
  "main": "src/index.js",
  "engines": { "ngbLoader": ">=0.2.0" }
}
```

```js
import { Plugin } from '@ggb-extend/sdk';

export default class MyPlugin extends Plugin {
  async onEnable(ctx) {
    // ctx.core   → GgbCore (Promise/Emitter wrapper over window.ggbApplet)
    // ctx.log    → scoped logger
    // ctx.storage→ scoped key/value storage
    await ctx.core?.objects.createPoint(1, 2, 'A');
    ctx.core?.on('add', ({ name }) => ctx.log.info('added', name));
  }

  async onDisable(ctx) { /* disposables run automatically */ }

  // OPTIONAL — the panel shows a "设置" button for plugins that implement this.
  async onOpenSettings(ctx) {
    // open your own config UI (e.g. a dialog in a closed shadow root)
  }
}
```

## Lifecycle hooks (all optional, all may be async)

| hook | when |
|------|------|
| `onLoad(ctx)` | once, when the plugin module is first loaded |
| `onEnable(ctx)` | when switched on (and on startup if enabled) |
| `onDisable(ctx)` | when switched off (disposables run automatically after) |
| `onUnload(ctx)` | once, on teardown |
| `onOpenSettings(ctx)` | when the user clicks "设置" in the panel for this plugin |

The **settings bridge** means plugins don't each need their own hotkey/menu — they
just implement `onOpenSettings`, and the panel provides the entry point.

## Supported source syntax

The runtime loader evaluates your source after a light transform. It supports:

- `import { Plugin, GgbCore } from '@ggb-extend/sdk';`
- `export default class X extends Plugin { ... }` or `export default { onEnable(){} }`
- bundler output `export { X as default };` (so you can pre-bundle with esbuild)

It does **not** support arbitrary npm imports at runtime — bundle those into a single
file first (external: `@ggb-extend/sdk`), or keep dependencies inline.

## Installing a plugin (manually)

Drop the plugin folder into the GGB-Extend plugins directory, then restart GeoGebra
(or use the manager's 调试启动). The panel's "打开文件夹" button opens this directory:

- macOS: `~/Library/Application Support/GeoGebra (NeoGebra)/GGB_Plugins/`
- Windows: `%APPDATA%/GeoGebra (NeoGebra)/GGB_Plugins/`
- Linux: `~/.config/GeoGebra (NeoGebra)/GGB_Plugins/`

## Reference plugins

- `ggb-hello/` — greets on startup, reports loader + plugin versions, and shows a
  rainbow "Hello" settings popup with version + git commit. Install it with
  `node ggb-hello/install-to-ggb.mjs`.
- `examples/hello-plugin/` — a smaller example used by the SDK tests.
- `packages/proxy-core/builtin-plugins/panel-manager/` — the built-in panel itself,
  the canonical example of a full plugin (Svelte UI + lifecycle + settings).

## Types

`packages/sdk/types/ggb-extend.d.ts` covers the SDK + a curated subset of the native
applet API. Point your editor at it for IntelliSense.
