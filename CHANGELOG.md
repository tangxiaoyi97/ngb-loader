# Changelog

All notable changes to Neogebra are documented here. This changelog starts at the
1.8 stable preview; earlier internal iterations are not listed.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [2.0.0-beta]

Version bump to the 2.0 beta line (framework + desktop manager in lockstep via
sync-version). The AI assistant example graduates to 1.0.0 — its post-1.9 fixes
(console-channel logging, axes/grid guard, high-degree-implicit render warning,
markdown/LaTeX rendering, Gemini support) ship in this line.

## [1.9.0] — 附录 A: AI assistant — tool calls & GeoGebra interaction

### Tools (the GeoGebra interaction surface)
- Three new tools: `style_object` (color/opacity/thickness/point size/
  visibility/label/caption — out-of-range values are clamped, not bounced),
  `set_view` (coordinate window + axes/grid), and `evaluate_expression`
  (read-only CAS math via `evalCommandCAS` — no more throwaway objects for
  pure computation; a top-level-assignment guard keeps it side-effect free
  while `Solve(x^2 = 2, x)` still works).
- `create_object` now uses `evalCommandGetLabels` (atomic created-labels
  instead of a before/after list diff) and echoes the created objects' actual
  definitions/values back to the model — verification without spending another
  tool round on `get_object`.
- Every mutation runs with GeoGebra's error dialogs suppressed (a bad AI
  command surfaces as a tool error the model can read and fix, never a host
  popup) and marks ONE undo point — each agent action is user-undoable with
  a single Ctrl+Z.
- Failure messages are actionable ("check argument types / referenced
  objects…") instead of a bare "rejected".

### Agent loop
- Cancellable: checkpoints after every API response and before every tool;
  cancelling stops the plan immediately (the in-flight HTTP finishes in the
  background — host IPC abort is still future work).
- Budget steering: iterations raised 6 → 8; with two rounds left the model is
  told to wrap up; if the budget still runs out, the fallback message
  summarizes what was actually built so the user knows where things stand.

### Conversation UI
- A-2 (short term): Cancel button + live elapsed-seconds counter in the
  Thinking row.
- A-3: append-only rendering — new messages/chips are appended instead of
  rebuilding the whole transcript per tool call (no flicker; text selection
  survives an agent turn). Full rebuilds remain for expand/collapse/theme.
- A-4: the first user message auto-names the conversation (manual renames win).
- A-5: conversation rows no longer pass a branded backing-object name — the
  framework's neutral session-random names are used.
- Tool chips now carry the command/error in their tooltip.

### Tests
- New `ai-assistant.test.js` (skips when the example is absent): adversarial
  classifier suite locked in (scripts, prose, CJK, markdown, multi-command,
  risky gating), tool execution against a fake applet (labels, quiet errors,
  undo points, clamping, view validation, CAS), loop cancellation and budget
  summary. 152/153 green overall.

## [1.9.0] — Roadmap P2 + P3: trust boundaries + non-intrusive polish

### Security (P2)
- **P2-1 DNS 校验**: the SSRF guard now validates the RESOLVED address at the
  socket's own DNS lookup (hooked `lookup`), not just the hostname literal —
  public names rebinding to loopback/private/CGNAT/v4-mapped-IPv6 ranges are
  refused before any connection opens.
- **P2-2 调用方身份**: `net-fetch`/`net-approve` no longer trust the payload's
  self-reported pluginId. The preload obtains per-plugin random capability
  tokens over a channel NOT exposed on the page bridge; each plugin's
  `ctx.net.fetch` closes over its own token and the host verifies
  (webContents, pluginId, token) together. `read-plugin-source` entries are
  confined to the plugin's own directory.
- **P2-3 默认禁用**: dropping a folder into `GGB_Plugins` no longer executes
  code on next launch. Plugins are default-DISABLED with three states
  (new / enabled / disabled); the panel lists not-running plugins with a "new"
  badge and offers one-click Enable/Disable (enable of a not-loaded plugin
  takes effect next launch — the framework never prompts on its own).

### Network approvals: per-GGB isolation + panel management
- Approval records moved from the global `netApprovals` to
  `targets[<ggbId>].netApprovals[pluginId][host]` — approving a host in one
  GeoGebra no longer grants it in another. Legacy global records still apply
  as a read fallback and are carried into the per-target record on first write
  (seed-on-write migration), so upgrades keep earlier decisions.
- The panel's plugin detail page gained a network-permissions section:
  manifest-declared hosts with their recorded decision (Allowed / Blocked /
  Not requested yet) and a per-host Revoke that deletes the record — the next
  access re-prompts the user. Adding hosts is deliberately NOT offered: the
  declared list belongs to the plugin author; the user holds approve/revoke.
  (IPC: `net-approvals` read-only, `net-revoke` unauthenticated by design —
  revoking is the safe direction.)

### Polish (P3 — zero new UI in GeoGebra's own chrome)
- **P3-1 主题统一**: new SDK `themeTokens()` (complete light/dark set + host
  font) and `onThemeChange()` (shared-observer + slow poll). The net-approval
  modal, the panel, and the AI assistant consume tokens only — the hardcoded
  light values (white modals, `rgb(0,0,0)` titles) that glared in dark mode are
  gone, and open UIs follow theme switches live.
- **P3-2 字体与 ⋯ 菜单**: panel/modal use GeoGebra's own font family; hybrid
  rows now hide the native ⋯ stylebar (its menu operated on the hidden helper
  object and would have exposed framework internals).
- **P3-3 唤出手势**: gestures are configurable (persisted via plugin storage)
  with a backup gesture — triple-press Ctrl within 600ms — for keyboards
  without a right Shift. Both are on by default; the panel's About view has
  the toggles and refuses to turn both off. No new visual hints in GeoGebra.
- **P3-4 modal 无障碍**: the net-approval dialog defaults focus to Block,
  traps Tab, closes on Esc (= Block), and returns focus afterwards; Esc also
  closes the panel (reusing its focus-release path).
- **P3-5 i18n**: minimal SDK i18n (`getHostLocale()` from the applet language
  → document lang → browser; `makeT(dicts)`). Panel and net modal ship zh-CN
  and en and follow the host language.

## [1.9.0] — Roadmap P1: resilience against GeoGebra upgrades

The DOM-reverse-engineering layers become detectable, degradable, and gated by
a real-machine regression test.

### Added
- **P1-1 适配层**: new `ggb-dom-adapter` SDK module — ALL GeoGebra selectors,
  layout metrics, and node-locating functions live there, grouped into
  version-keyed profiles (classic6 today). Metrics are measured from a live
  native row when possible; profile constants are the fallback. `algebra-row`
  and `algebra-dock` contain no bare selectors or magic pixels anymore.
- **P1-2 自检降级**: `selfCheck()` probes the live DOM against the active
  profile. Broken row anatomy → native rows are NOT rendered (no backing object
  created; on hijack failure the helper object is removed so no raw row is left
  behind). The panel shows a single low-key adaptation notice
  (`runtime.domHealth()`); critical failure leaves zero visual traces.
- **P1-4 真机回归**: `npm run test:e2e:real` (macOS) injects a copy of
  `ggb-test/GeoGebra Classic 6.app`, mounts a fixture native row, and asserts
  pixel parity with a real row (height/left-edge/marble center ±2px, ball
  20×20±1) plus a screenshot diff against `tests/e2e/baselines/`. This is the
  regression gate when bumping GeoGebra.
- **P1-5 bundle 格式**: plugins can declare `"format": "iife"` and ship a
  pre-built bundle (esbuild `--format=iife --global-name=__exports.default`),
  evaluated with NO source transformation; `require('@neogebra/sdk')` maps to
  the injected SDK, everything else is refused. The regex `transformPluginSource`
  is demoted to a dev-only convenience. The AI assistant example now ships
  bundled (`examples/geogebra-ai-assistant/dist`).

### Changed
- **P1-3 共享 observer**: one `MutationObserver` per document (`shared-observer`
  SDK module), fanned out to subscribers — N rows/docks no longer mean N
  subtree observers. Verified: 6 rows → exactly 1 observer, released when the
  last consumer is destroyed.

## [1.9.0] — Roadmap P0: correctness + footprint governance

Goal: indistinguishable-from-stock. No data loss, no runtime residue, portable documents.

### Fixed
- **P0-1 持久化**: plugin `ctx.storage` is now host-backed (`HostStorage`) — settings
  and API keys survive GeoGebra restarts, namespaced per plugin in `state.json`
  via the existing get/set-settings IPC, with a write-through memory cache.
  Namespaces are obfuscated at rest so secrets never appear under readable key
  names in `state.json`.
- **P0-2 资源泄漏**: dock/native-row cleanup disposables are registered per
  creation (per activation), so repeated enable→disable cycles tear down every
  generation of UI — no DOM or listener growth.
- **P0-3 文档可移植**: framework helper objects no longer reach saved files. The
  SDK hooks the applet's export methods (`getBase64`/`getXML`/`getFileJSON`),
  removes helpers during serialization and recreates them after; rows survive
  the cycle. A `.ggb` saved with framework UI open opens clean in stock GeoGebra.
- **P0-4 并发写**: `state.json` writes are atomic (tmp + rename) with a `.bak`
  of the last valid file; read-modify-write goes through a cross-process lock,
  so concurrent GeoGebra instances can't clobber or corrupt state.
- **P0-7 钩子护栏**: plugin lifecycle hooks run under a 10s watchdog — a hanging
  `onLoad`/`onEnable` marks that plugin failed and the load chain continues; a
  hanging `onDisable` still runs its disposables.

### Changed (footprint governance)
- **P0-5 命名空间**: no branded identifiers in the page at runtime. The IPC
  bridge and boot entry live under session-random window keys (boot key deleted
  after use); `data-ngb-*` attributes, the `ngbUI` object prefix, and the panel
  host id are session-random and neutral; the runtime API is handed to plugins
  as `ctx.runtime` instead of `window.__ggbExtendRuntime__`;
  `window.__ggbExtendTheme__` is replaced by `detectThemeMode()` in the SDK.
  E2E hooks (`__ggbExtendReady__` etc.) exist only in test builds
  (`NGB_TEST_BUILD=1`) and are dead-code-eliminated from production bundles.
- **P0-6 静默**: the framework logs nothing to the host console (errors included)
  unless `GGB_EXTEND_DEBUG=1`; plugin `ctx.log` is gated by the same switch.

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
