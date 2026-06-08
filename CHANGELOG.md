# Changelog

All notable changes to Neogebra are documented here. This changelog starts at the
1.8 stable preview; earlier internal iterations are not listed.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [1.8.0] — Stable preview

First public stable-preview release. Highlights: a framework container system that
lets plugins embed UI **inside** GeoGebra's algebra list, and an AI assistant
example plugin upgraded into a tool-using agent.

### Added — Framework

- **Native-row container system** (`ctx.ui.createNativeRow`). The framework asks
  GeoGebra to create a real object so it lays out a native algebra row, then takes
  over that row's content area and hands it to the plugin. Two modes:
  - `override` — clears the row and gives the plugin a blank, full-width canvas.
  - `hybrid` — keeps GeoGebra's native chrome (the ⋯ stylebar menu) and exposes a
    left **marble** plus the text area as plugin slots.
- **Marble as a first-class slot** (hybrid). `marble: { kind, color, filled, render }`:
  - `kind: 'native'` renders a **pixel-accurate GeoGebra ball** (18px content-box +
    1px border → 20px, full circle; solid = colour at 40% "ON", outline = "OFF").
  - `kind: 'custom'` lets the plugin draw any icon/element.
  - `onMarbleClick(api, e)` receives a control API: `toggleFilled/setFilled/isFilled`
    (switch semantics) and `expand/collapse/toggle/isExpanded/setExpanded`
    (framework-tracked, fires `onExpandedChange`). The same methods are mirrored on
    the handle.
- **Event isolation** — interaction events inside a container are kept from
  triggering GeoGebra's own select/edit/drag, while still working internally; the
  marble fires the plugin callback exactly once per click.
- **Native row metrics** — containers match a real GeoGebra object row (row height,
  58px marble panel, 68px content indent) for a seamless, native look, independent
  of what else is in the list.
- **`ctx.ui.theme()`** — exposes GeoGebra's own theme tokens (primary/selection/
  text/font) so plugin UI blends in and follows the host theme.
- Asynchronous-ready attach (waits for GeoGebra's applet API), self-healing
  re-hijack on tree rebuilds, and reroute of GeoGebra's delete back to the plugin
  so cleanup stays in sync.

### Added — Tooling

- **`npm run dev:install`** (`scripts/dev-install.mjs`) — installs a plugin from
  `examples/` into the shared GeoGebra plugin library for quick dev testing.
  `--all` installs every valid plugin in `examples/`; `--list` lists them.
- **`ggb-extend debug`** CLI command — launches the injected GeoGebra with
  DevTools open (`GGB_EXTEND_DEBUG=1`).

### Added — Example plugins

- **`container-playground`** — spawns `override` / `hybrid` / `switch` containers
  to demonstrate and stress-test the container API (modes, marble, theme).
- **`geogebra-ai-assistant`** — rebuilt as a tool-using **agent**:
  - OpenAI Responses API **native function calling** with a multi-turn agent loop.
  - GeoGebra **tools**: `list_objects`, `get_object`, `create_object`, `set_value`,
    `delete_object` — writes go through command-safety checks; delete is gated.
  - Lives as **hybrid conversation rows** in the algebra list; the marble expands/
    collapses the conversation. Supports **multiple conversations**.
  - **Custom conversation titles** (editable in settings, persisted).
  - **Debug mode** — logs messages, requests/responses, and tool calls to the
    console when enabled.
  - English UI, polished bubbles/composer/tool-chips.

### Changed

- SDK version is `1.8.0` (single source of truth: root `package.json` →
  `npm run sync-version`).

### Notes

- This is a **stable preview**: the container/marble API is considered stable for
  this line, but may still see refinement before a 2.0.
- The framework remains fully non-invasive — it never modifies GeoGebra's own
  files in place.
