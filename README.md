# Neogebra

**A lightweight, non‑invasive plugin framework for the GeoGebra desktop app.**

Neogebra lets you install plugins into GeoGebra Classic (the Electron desktop
build) without modifying any of GeoGebra's own code. A small desktop manager
*injects* a proxy layer into a GeoGebra install, and from then on GeoGebra loads
your plugins on demand. The original app is always backed up and a one‑click
restore puts everything back, byte‑for‑byte.

> **Version:** 1.0.0 · macOS & Windows · Repository:
> <https://github.com/tangxiaoyi97/ngb-loader>

---

## What you get

- **A desktop manager** to add your GeoGebra installs, inject/restore the
  framework, and turn plugins on/off per install.
- **A plugin runtime** injected into GeoGebra. The plugin panel (toggle with
  **Right‑Shift**) is itself a built‑in plugin.
- **A developer SDK** (`@neogebra/sdk`) that wraps GeoGebra's applet API with a
  modern, Promise‑based interface and a clean plugin lifecycle.
- **A native‑row container system** (`ctx.ui.createNativeRow`) that lets plugins
  embed UI **inside** GeoGebra's algebra list — in `override` mode (a blank
  full‑row canvas) or `hybrid` mode (keeps the native ⋯ menu, plus a pixel‑accurate
  GeoGebra **marble** and the text area as plugin slots, with a click API for
  toggle/expand). UI matches the host's look and theme.
- **Per‑install version isolation:** plugin files are shared globally, but
  on/off state is tracked per GeoGebra install.
- **Example plugins:** a container playground, and an AI assistant that runs as a
  tool‑using agent (function calling + GeoGebra tools) living right in the algebra
  list.

---

## How it works

Electron resolves `Resources/app/` **before** `Resources/app.asar`. Neogebra
uses this:

```
  PRISTINE                         INJECTED
  Resources/                       Resources/
    app.asar   (original)   ──►       core.asar          (renamed original, untouched)
                                      core.asar.unpacked (native modules, moved alongside)
                                      app/               (our proxy: main.js + preload.js + runtime)
                                      .ggb-extend.json   (injection manifest, for clean uninstall)
```

(For the unpacked‑folder build of GeoGebra, drop the `.asar` suffix: `app/ → core/`.)

1. The **injector** renames the original payload to `core(.asar)` and installs a
   tiny **proxy** as `app/`.
2. On launch, Electron boots the proxy `main.js`, which patches `BrowserWindow`
   to inject a `preload.js` (chaining GeoGebra's own preload, preserving
   `contextIsolation`), registers plugin IPC, then hands control to the original
   `core` (wrapped in `try/catch` so it can never brick GeoGebra).
3. The **runtime** in the page reads the shared `GGB_Plugins` folder and loads
   each enabled plugin dynamically. The panel mounts inside a **closed Shadow
   DOM** so GeoGebra's CSS can't leak in or out.

Plugins are **loaded dynamically at every startup** — they are never baked into
GeoGebra. To update a plugin, replace its files and restart GeoGebra.

---

## Install & run (from source)

Requirements: Node.js 18+ and a desktop GeoGebra Classic install.

```bash
git clone https://github.com/tangxiaoyi97/ngb-loader
cd ngb-loader
npm install

# build everything (proxy runtime + desktop renderer) and launch the manager
npm run desktop
```

In the manager: **Add GeoGebra**, then **Inject framework**, then **Launch
GeoGebra**. Press **Right‑Shift** inside GeoGebra to open the plugin panel.

### Useful scripts

| Command | What it does |
|---------|--------------|
| `npm run desktop` | Build proxy + renderer, then launch the manager (dev). |
| `npm run build` | Build the proxy runtime + panel. |
| `npm run build:desktop` | Build proxy + the desktop renderer bundle. |
| `npm test` | Run the unit test suite. |
| `npm run doctor` | Diagnose a GeoGebra install / injection state. |
| `npm run clean` | Remove build artifacts (`dist/`, `vendor/`). |
| `npm run cli -- scan` | The injection engine CLI (advanced / headless use). |

---

## Packaging a distributable app

See **[docs/BUILD.md](docs/BUILD.md)** for full, per‑platform instructions. In
short:

```bash
npm install
npm run build:desktop                                  # build proxy + renderer
npm --workspace @neogebra/desktop run dist             # electron-builder → installers
```

Output (DMG/ZIP on macOS, NSIS on Windows, AppImage on Linux) lands in
`packages/desktop/release/`.

---

## Writing plugins

Start with **[docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md)** — a full
guide covering the manifest, the lifecycle, the SDK API, debugging, and
packaging. A minimal plugin:

```js
import { Plugin } from '@neogebra/sdk';

export default class MyPlugin extends Plugin {
  async onEnable(ctx) {
    await ctx.core.objects.createPoint(0, 0, 'A');
  }
}
```

A complete reference plugin lives in `examples/hello-plugin/`.

---

## Monorepo layout

```
packages/
  injector-core/   Cross-platform detect + inject/uninstall engine, and the CLI
  proxy-core/      The proxy that boots before GeoGebra (main.js + preload.js)
                   and the in-page runtime + built-in panel-manager plugin
  desktop/         The Electron desktop manager (React renderer + main process)
  sdk/             Developer SDK: GgbCore wrapper, plugin lifecycle, TS types
  installer/       (Legacy) Express + WebSocket browser-based install wizard
examples/
  hello-plugin/    A complete reference plugin
tests/unit/        Unit & integration tests (no GUI required)
docs/              Guides & architecture notes
scripts/           build-proxy.mjs, run-tests.mjs, doctor.mjs, clean.mjs
```

---

## Documentation

| Doc | For |
|-----|-----|
| [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md) | Plugin authors — complete SDK & lifecycle guide. |
| [docs/BUILD.md](docs/BUILD.md) | Packaging the desktop app for each platform. |
| [docs/DESKTOP.md](docs/DESKTOP.md) | The desktop manager internals. |
| [docs/PLUGINS.md](docs/PLUGINS.md) | The plugin runtime & loader internals. |
| [docs/MANUAL-ACCEPTANCE.md](docs/MANUAL-ACCEPTANCE.md) | Manual acceptance test steps. |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Automated verification notes. |

---

## Safety guarantees

- **Reversible** — every destructive step is a rename; a restore returns the
  original tree exactly (verified with SHA‑256 round‑trip tests).
- **Idempotent** — re‑running inject refreshes the proxy instead of
  double‑renaming.
- **Fail‑safe boot** — if any Neogebra logic throws, control still passes to the
  original GeoGebra core.
- **Refuses ambiguity** — if it finds a `core` it didn't create, it stops rather
  than risk data loss.
- **`.unpacked` aware** — native‑module folders (`app.asar.unpacked`) are
  moved/restored alongside the asar.
- **macOS signing** — injection clears quarantine and ad‑hoc re‑signs the bundle
  so Gatekeeper/Electron integrity checks still pass.

---

## License & disclaimer

MIT — see [LICENSE](LICENSE).

Neogebra is an **unofficial, third‑party** tool and is **not affiliated with or
endorsed by GeoGebra**. It is provided for **learning and personal use**. Thanks
to GeoGebra for its open Apps API. Plugins are made by their own authors; content
from third‑party plugins that is not authored by this project's author is not the
responsibility of this project.
