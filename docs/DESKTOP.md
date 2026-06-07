# GGB-Extend Desktop Manager (v0.2)

A standalone Electron app to manage **multiple** GeoGebra installs from one place:
add install paths, inject / restore each independently, choose a backup folder,
and manage each install's plugins. No terminal needed once it's packaged.

> This supersedes the command-line installer for end users. The CLI
> (`packages/injector-core`) still exists and shares the same engine.

---

## What it does

- **Home = a list of managed GeoGebra installs.** Each card shows status
  (未注入 / 已注入 / 路径丢失), version, and path, with per-install
  注入 / 还原 / 插件 / 移除 buttons.
- **Add GeoGebra** via a native file picker (validates it's a real install).
- **Default backup folder**: before injecting, you pick a folder; the manager
  **copies the original payload there** (per-install subfolder) so restore works
  even if the in-app `core` is ever lost. (Engine still also keeps the in-app
  `core` — dual safety.)
- **Per-install plugin management**: expand a card to toggle that install's
  plugins (persisted in the manager's `registry.json`).
- **Live log drawer** during inject/restore.

State lives in `app.getPath('userData')/registry.json`.

---

## Run in development

```bash
# from the repo root
npm install
npm run build:proxy            # assemble the proxy (with the panel) the app injects
npm --workspace @ggb-extend/desktop run build:renderer
npm run desktop                # launches Electron (needs electron installed)
#   tip: GGBX_DEVTOOLS=1 npm run desktop   # opens DevTools
```

> `npm run desktop` requires the `electron` dev dependency to be installed. In a
> network-restricted environment the Electron binary download may be blocked; run
> it on a normal machine.

### Preview the UI without Electron

The renderer ships a mock bridge, so you can explore the interface in a plain
browser (with sample data, buttons wired to the mock):

```bash
open packages/desktop/renderer/dist/index.html
```

---

## Package a standalone app (.app / .exe)

```bash
npm install
npm run build:proxy
npm --workspace @ggb-extend/desktop run dist
#   → packages/desktop/release/  (DMG + zip on macOS, NSIS on Windows)
```

`dist` runs three steps:
1. `build:renderer` — bundles the React UI
2. `prepack:assets` — **vendors** injector-core (+fs-extra) and the assembled
   proxy into `packages/desktop/vendor/` so they're inside the packaged app
3. `electron-builder` — produces the installer(s) in `release/`

> **macOS note:** the app is built unsigned/ad-hoc (`identity: null`) for local
> use. The *manager itself* may need a right-click → Open the first time. The
> GeoGebra installs it modifies are ad-hoc re-signed automatically by the engine
> (same as the CLI).

### Icons
Optional — see `packages/desktop/assets/README.md`. Without them you get the
stock Electron icon.

---

## Architecture (how the pieces fit)

```
packages/desktop/
  src/
    main.js        Electron main: wires IPC, native dialogs, loads injector
    preload.js     contextBridge → window.ggbx (secure, no Node in renderer)
    registry.js    registry.json persistence (multi-GGB) — unit-tested
    manager.js     business logic: scan/add/inject/restore/plugins — unit-tested
  renderer/
    src/App.jsx    management-center UI (React, inline-styled, CSP-safe)
    src/GgbCard.jsx, LogDrawer.jsx, ui.js
  scripts/prepack.mjs   vendors engine + proxy for packaging
  vendor/          (generated) injector-core + proxy-core, bundled into the app
```

The engine (`injector-core`) gains a `backupDir` option for "copy the original
out before in-place injecting", with disaster-recovery restore from that backup.

---

## Tests

The desktop logic is covered without Electron:

```bash
npm test    # includes registry.test.js, manager.test.js, backup.test.js
```
