# Verification Protocol

Because CI / headless containers cannot launch GeoGebra's real GUI, GGB‑Extend is
verified in **two complementary layers**, matching the agreed plan:

1. **Automated unit tests + simulated dry‑runs** (fast, run everywhere, no GUI).
2. **Playwright + Xvfb E2E smoke test** (real Electron + Chromium, headless).

Final acceptance is a manual launch of the real injected GeoGebra on a developer Mac.

---

## Layer 1 — Unit & integration (`npm test`)

Run with the built‑in Node test runner (no extra deps beyond `fs-extra`, `ws`, `jsdom`):

```bash
npm test          # node --test tests/unit/*.test.js
```

Coverage (33 tests):

| Area | File | What it proves |
|------|------|----------------|
| Detection | `detect.test.js` | macOS `.app`, Windows `resources/`, asar vs folder, pristine/injected state |
| Engine | `engine.test.js` | inject/uninstall for **folder** and **asar**, `.unpacked` sibling moves, **byte‑identical** restore (SHA‑256), idempotency, dry‑run, ambiguous‑state refusal |
| Proxy core | `proxy.test.js` | `BrowserWindow` monkey‑patch, **preload chaining**, `contextIsolation` preserved, sandbox disabled, all 6 IPC channels + JSON persistence |
| SDK | `sdk.test.js` | `GgbCore` object API + event bridge against a mock applet, manifest validation, **the example plugin run through its full lifecycle**, resilient teardown |
| Installer server | `installer-server.test.js` | real Express + WebSocket: scan/status/inject/uninstall over HTTP with **live log streaming**, error codes |
| Renderer | `renderer-integration.test.js` | the **real preload + compiled panel** in jsdom: original preload chained, `window.ggbExtendHost` exposed, panel mounts a **closed** Shadow DOM, hotkey wired |

Additionally, the engine was exercised against a **real copy of GeoGebra Classic 6**:
inject → simulated boot (proxy successfully `require`s the untouched 25 KB original
`core/main.js`) → uninstall → SHA‑256 confirms the restored `app/main.js` is identical
to the original, with zero leftovers.

---

## Layer 2 — Playwright + Xvfb E2E (`npm run test:e2e`)

This launches a **real Electron app** through Playwright's `_electron` API and asserts
the panel actually mounts in a real Chromium renderer.

### Prerequisites

```bash
npm i -D playwright electron
npx playwright install        # browser deps (Linux)
```

### Run

```bash
# Linux (headless) — wrap with a virtual display:
xvfb-run -a node tests/e2e/run-e2e.mjs

# macOS:
node tests/e2e/run-e2e.mjs
```

### What it does

1. Builds the panel + assembles the proxy (`proxy-core/dist`).
2. Assembles an **injected** app on disk:
   `…/Resources/app/` = the proxy, `…/Resources/core/` = a **fake‑GeoGebra Electron
   fixture** (`tests/e2e/fixture-app/`) that registers an `app://` protocol, uses
   `contextIsolation: true`, its own preload, and defines `window.ggbApplet` — i.e. it
   behaves like GeoGebra in every way that matters to the injection.
3. Launches Electron pointed at the proxy; the proxy patches `BrowserWindow`, injects
   our preload (chaining the fixture's), and boots the fixture.
4. Asserts in the renderer's **main world**:
   - `window.__fixturePreloadRan === true` → original preload was chained
   - `window.ggbExtendHost` present → our bridge injected
   - `window.ggbApplet` visible → main‑world access works
   - the closed Shadow‑DOM host element mounted
   - `window.__ggbExtendReady__ === true` → panel mounted
   - Right‑Shift toggle installed

### Exit codes

- `0` pass · `1` fail · `2` **skip** (Playwright/Electron not installed — so CI without a
  GUI never blocks on it).

> Swapping the fixture for the **real GeoGebra**: point the harness's `core/` at a real
> injected install instead of the fixture. The fixture exists so the E2E is runnable in
> CI where the multi‑hundred‑MB GeoGebra binary isn't present.

---

## Layer 3 — Manual acceptance (developer Mac)

```bash
npm run build:panel && npm run build:proxy
node packages/injector-core/bin/ggb-extend.js inject --path "/Applications/GeoGebra Classic 6.app"
open "/Applications/GeoGebra Classic 6.app"
# → press Right-Shift; the glass panel slides in. Verify plugins list / toggles / settings.
node packages/injector-core/bin/ggb-extend.js uninstall --path "/Applications/GeoGebra Classic 6.app"
# → relaunch; GeoGebra is back to stock.
```

> Replacing this file: drop your own `verification_protocol.md` into `docs/` and adjust
> `tests/e2e/run-e2e.mjs` accordingly — the harness is structured to accept a custom
> assertion script.
