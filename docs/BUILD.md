# Building & Packaging Neogebra

This document explains how to build the Neogebra desktop manager into a
distributable application (DMG/ZIP on macOS, NSIS installer on Windows, AppImage
on Linux).

Packaging is done with [electron-builder](https://www.electron.build/).

---

## Prerequisites

- **Node.js 18+** and npm.
- A clean `npm install` at the repo root (the desktop app's native/runtime
  dependencies must be present so electron-builder can resolve the Electron
  version).
- **Build on the target OS** where possible:
  - macOS DMG/ZIP must be built on macOS.
  - Windows NSIS is best built on Windows.
  - Linux AppImage on Linux.

---

## One‑time setup

```bash
git clone https://github.com/tangxiaoyi97/ngb-loader
cd ngb-loader
npm install
```

---

## Build steps

Packaging has two phases: **build the app's own code**, then **package**.

### 1. Build the app code

```bash
npm run build:desktop
```

This runs:

- `build:proxy` — assembles the in‑page proxy + runtime + built‑in panel into
  `packages/proxy-core/dist/`.
- the desktop renderer build — bundles the React manager UI into
  `packages/desktop/renderer/dist/app.bundle.js`.

### 2. Stage vendored dependencies (prepack)

```bash
npm --workspace @neogebra/desktop run prepack:assets
```

electron-builder packages a single npm package, but the desktop app depends on
two sibling pieces that don't bundle cleanly as workspace symlinks:

- `@neogebra/injector-core` (the detect/inject/restore engine), and
- the assembled proxy (`packages/proxy-core/dist`, including the panel).

`prepack` copies them into `packages/desktop/vendor/`:

```
packages/desktop/vendor/
  injector-core/      ← engine source + its node_modules (fs-extra & deps)
  proxy-core/         ← the assembled proxy (main.js, preload.js, assets/, builtin-plugins/)
```

`main.js` resolves `injector-core` from `vendor/` at runtime, and
`extraResources` ships `vendor/proxy-core` as `proxy-core` inside the packaged
app so it can be copied into GeoGebra during injection.

> The `dist`/`pack` scripts below run `prepack:assets` for you — you only need to
> run it manually when debugging the vendor step.

### 3. Package

Build installers for the current platform:

```bash
npm --workspace @neogebra/desktop run dist
```

Or a quick unpacked build (no installer, fastest to test):

```bash
npm --workspace @neogebra/desktop run pack
```

Artifacts are written to **`packages/desktop/release/`**.

---

## What gets built (per platform)

Configured in `packages/desktop/package.json` under the `build` field:

| Platform | Targets | Icon |
|----------|---------|------|
| macOS | `dmg`, `zip` (arm64 + x64) | `assets/icon.icns` |
| Windows | `nsis` installer (x64) | `assets/icon.ico` |
| Linux | `AppImage` | (png set) |

Key config values:

- `appId`: `org.neogebra.manager`
- `productName`: `Neogebra`
- `directories.output`: `release`
- `directories.buildResources`: `assets`
- `extraResources`: `vendor/proxy-core → proxy-core`

---

## Icons

The app icons live in `packages/desktop/assets/`:

- `icon.icns` — macOS (a real multi‑resolution ICNS container, 16–1024 px).
- `icon.ico` — Windows (multi‑size: 16/32/48/64/128/256).
- `icon.png` — 1024×1024 master (also used for Linux).
- `icon.svg` — vector source.

### Regenerating icons from the SVG/PNG master

If you change the artwork, regenerate the platform icons from a 1024×1024 PNG
master (`icon.png`).

**macOS (native, recommended):**

```bash
mkdir icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s   icon.png --out icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon.png --out icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o assets/icon.icns
```

**Cross‑platform (ImageMagick + icnsutil):**

```bash
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
pip install icnsutil   # then compose a real .icns from resized PNGs
```

> Note: a plain PNG renamed to `.icns` is **not** a valid ICNS and will fail or
> render wrong in a macOS build. Always produce a real ICNS container.

---

## Code signing & notarization (macOS)

The shipped config uses **ad‑hoc / unsigned** packaging:

```json
"mac": { "hardenedRuntime": false, "identity": null }
```

Fine for personal/local use. For public distribution, sign and notarize with an
Apple Developer ID:

1. Set `"identity"` to your Developer ID Application certificate name.
2. Set `"hardenedRuntime": true` and provide entitlements.
3. Configure notarization (`afterSign` with `@electron/notarize`).

See the electron-builder code‑signing docs for the current recipe.

> Separately: when Neogebra **injects** into a GeoGebra install, it clears the
> quarantine attribute and **ad‑hoc re‑signs that GeoGebra bundle** so it keeps
> launching after modification. That is independent of signing the Neogebra app
> itself.

---

## Troubleshooting

- **"Cannot compute electron version from installed node modules"** — run a clean
  `npm install` so `electron` is resolvable; build from the repo with
  dependencies present.
- **"author is missed in package.json"** — already set in
  `packages/desktop/package.json`; if you fork, keep an `author` field.
- **Proxy/panel missing in the packaged app** — ensure you ran `build:desktop`
  (so `packages/proxy-core/dist` exists) before packaging; `prepack` throws if
  the proxy isn't built.
- **macOS icon looks wrong / build fails on icon** — regenerate a real `.icns`
  (see above); don't rename a PNG.

---

## Clean build from scratch

```bash
npm run clean
npm install
npm run build:desktop
npm --workspace @neogebra/desktop run dist
```
