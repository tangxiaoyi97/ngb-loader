# Neogebra Plugin Development Guide

This guide is for developers who want to write plugins for **Neogebra** — a
lightweight plugin framework for the GeoGebra desktop app.

It covers everything from a five‑minute "hello world" to the full SDK API,
debugging, and packaging a plugin for release.

---

## 1. How Neogebra works (the 60‑second model)

Neogebra has two separate parts:

1. **The framework (loader).** The Neogebra desktop manager *injects* a small
   proxy into a GeoGebra install once. From then on, every time that GeoGebra
   starts, the proxy boots a runtime inside the page that loads plugins.
2. **Plugins.** Plugins are **not** baked into GeoGebra. They live in a shared
   folder and are **loaded dynamically at every GeoGebra startup**.

Practical consequences for you as a plugin author:

- You never re‑inject to update a plugin. **Edit the plugin files, restart
  GeoGebra, done.**
- A plugin is a single JavaScript module that the runtime reads as source and
  evaluates in the page's main world (where `window.ggbApplet` lives).
- Plugins talk to GeoGebra through the **SDK** (`@neogebra/sdk`), which wraps the
  raw applet API with a modern, Promise‑based interface.

The plugin folder (shared by all injected GeoGebras of the same product):

```
macOS:    ~/Library/Application Support/GeoGebra (NeoGebra)/GGB_Plugins/
Windows:  %APPDATA%\GeoGebra (NeoGebra)\GGB_Plugins\
Linux:    ~/.config/GeoGebra (NeoGebra)/GGB_Plugins/
```

Each plugin is one subfolder:

```
GGB_Plugins/
  my-plugin/
    manifest.json
    src/
      index.js        ← the bundled plugin module
```

> Enable/disable state is per‑GeoGebra and stored in `state.json` next to the
> plugins — you don't manage it; the Neogebra manager does.

---

## 2. Quick start (hello world in 5 minutes)

### 2.1 Create the folder

```
my-plugin/
  manifest.json
  src/
    index.js
```

### 2.2 `manifest.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Draws a point when enabled.",
  "main": "src/index.js",
  "engines": { "ngbLoader": ">=1.0.0" }
}
```

### 2.3 `src/index.js`

```js
import { Plugin } from '@neogebra/sdk';

export default class MyPlugin extends Plugin {
  async onEnable(ctx) {
    // ctx.core is a ready GgbCore wrapping window.ggbApplet
    await ctx.core.objects.createPoint(0, 0, 'A');
    ctx.log.info('My Plugin enabled — created point A');
  }
}
```

### 2.4 Install it

Either use the Neogebra manager's **“+ Add plugin”** button and pick the
`my-plugin` folder, or copy the folder into `GGB_Plugins/` yourself.

### 2.5 Run it

Restart GeoGebra (or use **Launch (debug)** in the manager). Your plugin is
enabled by default; on startup it runs `onEnable` and a point `A` appears at the
origin. Press **Right‑Shift** in GeoGebra to open the plugin panel and confirm
it's listed.

That's a complete, working plugin.

---

## 3. The manifest

`manifest.json` describes your plugin to the framework.

| Field | Required | Type | Shown where | Description |
|-------|----------|------|-------------|-------------|
| `id` | yes | string | — | Unique id. Letters, digits, `-`, `_` only. Becomes the folder name and the key in `state.json`. |
| `name` | yes | string | panel list + detail, manager list | Display name. |
| `version` | yes | string | panel detail, manager list | Semver string, e.g. `"1.0.0"`. |
| `main` | yes | string | — | Path (relative to the plugin folder) to the JS entry module. Conventionally `src/index.js`. |
| `author` | no | string | panel detail, manager list | Your name. Defaults to `"unknown"`. |
| `description` | no | string | panel detail, manager list | One or two sentences about the plugin. |
| `icon` | no | string | panel list + detail, manager list | Path to an icon image relative to the plugin folder (e.g. `"icon.png"`). See below. |
| `engines.ngbLoader` | no | string | — | Semver range of the framework you target, e.g. `">=1.0.0"`. |
| `permissions` | no | object | — | Capability declarations. Currently `permissions.network: string[]` — hostnames the plugin may reach via `ctx.net.fetch`. See §7. |

Minimum valid manifest:

```json
{ "id": "x", "name": "X", "version": "1.0.0", "main": "src/index.js" }
```

### Plugin icon

Set `icon` to an image file in your plugin folder and it's shown next to your
plugin in both the in‑GeoGebra panel and the desktop manager:

```json
{ "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
  "main": "src/index.js", "icon": "icon.png" }
```

```
my-plugin/
  manifest.json
  icon.png        ← referenced by "icon"
  src/index.js
```

- Supported formats: PNG, JPG/JPEG, SVG, WebP, GIF.
- The path is relative to the plugin folder. A `data:` URI is also accepted.
- Keep it small (≤ 256 KB; ~64–128 px square looks best). Larger files are
  ignored.
- If `icon` is missing/invalid, the UI falls back to a colored square with the
  first two letters of the plugin name.

---

## 4. The plugin lifecycle

Your default export is a class (recommended — subclass `Plugin`) **or** a plain
object with the same hook names. All hooks are optional and may be `async`.

```js
import { Plugin } from '@neogebra/sdk';

export default class Example extends Plugin {
  async onLoad(ctx)        {}  // once, when the module is first loaded
  async onEnable(ctx)      {}  // each time it's switched on (and at startup if enabled)
  async onDisable(ctx)     {}  // each time it's switched off
  async onUnload(ctx)      {}  // once, on teardown (page unload / removal)
  async onOpenSettings(ctx){}  // when the user clicks "Settings" for this plugin
}
```

Lifecycle order on a normal run:

```
onLoad  →  onEnable        (startup, plugin enabled)
           onDisable  ⇄  onEnable    (user toggles off/on; takes effect after restart)
onUnload                   (GeoGebra closing)
```

Notes:

- **Setup hooks (`onLoad`, `onEnable`) propagate errors.** If they throw, the
  framework marks your plugin as failed and shows the error in the panel.
- **Teardown hooks (`onDisable`, `onUnload`) never throw.** Errors are logged and
  registered disposables still run, so one bad plugin can't break others.
- **`onOpenSettings`** is the single, framework‑provided way to surface a config
  UI. The panel shows a **Settings** button for every plugin; it is enabled only
  if your plugin overrides this hook. You render whatever UI you like (a DOM
  overlay, a dialog, etc.).

### Plain‑object form (no class)

```js
export default {
  async onEnable(ctx) { await ctx.core.objects.createPoint(1, 1, 'B'); },
};
```

### Plugin settings UI — you own it

Neogebra does **not** ship a settings-form template. The framework gives you a
single thing: an **entry point**. Every plugin row in the panel shows a
**Settings** button, and clicking it calls your `onOpenSettings(ctx)` hook. The
button is enabled only when your plugin overrides that hook (otherwise it shows
disabled, "No settings").

What the settings panel looks like and does is **100% up to you** — render any UI
you want from `onOpenSettings`: a DOM overlay, a dialog, a side sheet, a form,
anything. Tips:

- Mount your own element on `document.documentElement` (and remove it on close).
  Consider a high `z-index` and, if you want CSS isolation, a Shadow DOM.
- Match GeoGebra's theme: `window.__ggbExtendTheme__()` returns `'light'` or
  `'dark'` (exposed by the built-in panel).
- Persist user choices with `ctx.storage` (see §5).

```js
import { Plugin } from '@neogebra/sdk';

export default class MyPlugin extends Plugin {
  async onOpenSettings(ctx) {
    const theme = (window.__ggbExtendTheme__ && window.__ggbExtendTheme__()) || 'light';
    const bg = theme === 'dark' ? '#2b2d31' : '#fff';
    const fg = theme === 'dark' ? '#ececf0' : '#1d1d1f';

    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.4)';
    host.innerHTML = `
      <div style="background:${bg};color:${fg};border-radius:14px;padding:22px;min-width:280px;
                  font-family:Roboto,sans-serif">
        <h3 style="margin:0 0 12px">My Plugin settings</h3>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px">
          <input type="checkbox" id="opt"> Enable the thing
        </label>
        <div style="margin-top:16px;text-align:right">
          <button id="close" style="padding:8px 14px;border-radius:999px;border:none;
                  background:#6557d3;color:#fff;cursor:pointer">Done</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const opt = host.querySelector('#opt');
    opt.checked = ctx.storage.get('thingEnabled', false);
    opt.addEventListener('change', () => ctx.storage.set('thingEnabled', opt.checked));
    host.querySelector('#close').addEventListener('click', () => host.remove());
    host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
  }
}
```

---

## 5. The plugin context (`ctx`)

Every hook receives a `PluginContext`. It gives you what you need **without**
reaching for globals:

| Property | Type | Description |
|----------|------|-------------|
| `ctx.core` | `GgbCore` | A ready wrapper over `window.ggbApplet`. See §6. |
| `ctx.manifest` | object | Your normalized manifest. |
| `ctx.id` | string | Your plugin id. |
| `ctx.storage` | object | Scoped key/value storage: `get(key, fallback?)`, `set(key, value)`, `delete(key)`, `keys()`. |
| `ctx.net` | object | Guarded network access: `fetch(url, opts)`. Only manifest-declared + user-approved hosts. See §7. |
| `ctx.log` | object | Scoped logger: `info / warn / error`. Output is tagged `[plugin:<id>]`. |
| `ctx.registerDisposable(fn)` | method | Register a cleanup function; it runs automatically on disable/unload. |

> **Logging tip.** GeoGebra overrides `window.console.log`, so `ctx.log.info`
> (which uses `console.log`) may not appear in DevTools. Use `ctx.log.warn` /
> `console.warn` if you need to see output in the DevTools console during
> debugging.

### Automatic cleanup with `registerDisposable`

```js
async onEnable(ctx) {
  const off = ctx.core.on('add', (e) => ctx.log.warn('object added:', e.name));
  ctx.registerDisposable(off);            // unsubscribes on disable/unload

  const id = setInterval(() => {}, 1000);
  ctx.registerDisposable(() => clearInterval(id));
}
```

---

## 6. The SDK API (`@neogebra/sdk`)

Import what you need:

```js
import { Plugin, GgbCore, whenAppletReady, VERSION } from '@neogebra/sdk';
```

You normally only touch `Plugin` (to subclass) and `ctx.core` (a `GgbCore`). The
others are for advanced cases.

### 6.1 `GgbCore`

`ctx.core` is a ready `GgbCore`. It never hides the raw applet — `core.raw` is
always available for commands not yet wrapped.

| Member | Description |
|--------|-------------|
| `core.raw` | The underlying `window.ggbApplet`. Use any native method directly. |
| `core.objects` | The object sub‑API (below). |
| `core.on(type, handler)` | Subscribe to an event; returns an unsubscribe function. |
| `core.once(type, handler)` | Subscribe once. |
| `core.dispose()` | Tear down SDK listeners (call from `onUnload` if you created your own `GgbCore`). |

Events: `'add'`, `'remove'`, `'update'`, `'rename'`, `'clear'`, `'click'`.
Handlers receive `{ name }` (or `{ oldName, newName }` for `rename`).

### 6.2 `core.objects` — geometry, the Promise way

Every method returns a Promise.

| Method | Returns | Description |
|--------|---------|-------------|
| `eval(command)` | `boolean` | Run a raw GeoGebra command string, e.g. `"A=(1,2)"`. |
| `createPoint(x, y, name?)` | `string` | Create a free point; returns its name. |
| `createSegment(a, b, name?)` | `string` | Segment between two points/coords. |
| `getValue(name)` | `number` | Numeric value of an object/expression. |
| `getCoords(name)` | `{x,y,z}` | Coordinates of an object. |
| `setCoords(name, x, y, z?)` | `{x,y,z}` | Move an object; returns new coords. |
| `setVisible(name, visible)` | — | Show/hide an object. |
| `setColor(name, r, g, b)` | — | Set color (RGB 0–255). |
| `remove(name)` | — | Delete an object. |
| `list()` | `string[]` | Names of all objects in the construction. |
| `exists(name)` | `boolean` | Whether an object exists. |

Example — draw and color a triangle, then react to edits:

```js
async onEnable(ctx) {
  const { objects } = ctx.core;
  await objects.eval('A=(0,0)');
  await objects.eval('B=(4,0)');
  await objects.eval('C=(2,3)');
  await objects.eval('poly1=Polygon(A,B,C)');
  await objects.setColor('poly1', 101, 87, 211);

  const off = ctx.core.on('update', (e) => ctx.log.warn('moved:', e.name));
  ctx.registerDisposable(off);
}
```

### 6.3 Anything not wrapped → use `core.raw`

The wrapper is intentionally thin. For the full GeoGebra Apps API, call the raw
applet:

```js
ctx.core.raw.setAxesVisible(true, true);
ctx.core.raw.evalCommand('SetValue(n, 5)');
const xml = ctx.core.raw.getXML();
```

See GeoGebra's official Apps API reference for every available method.

### 6.4 `whenAppletReady(opts?)`

Resolves once `window.ggbApplet` is ready. You rarely need this — `ctx.core` is
already ready inside your hooks — but it's there for code that runs outside the
lifecycle.

### 6.5 Other exports (advanced)

The SDK also exports a few pieces you usually don't need directly:

| Export | Use |
|--------|-----|
| `Emitter` | The tiny event emitter `GgbCore` uses (`on/once/off/emit`). Handy if you want your own event bus. |
| `MemoryStorage` | The in-memory fallback used for `ctx.storage` in previews. |
| `validateManifest(manifest)` | Normalizes/validates a manifest object (the loader uses it). |
| `runLifecycle(instance, phase, ctx)` | Drives a lifecycle transition (framework-internal). |
| `VERSION` | The SDK version string. |

### 6.6 Network access (`ctx.net`)

Plugins run inside GeoGebra's page, where the Content-Security-Policy blocks
cross-origin requests — so a normal `fetch()` to an API will fail. Neogebra gives
you a **guarded** network channel instead: `ctx.net.fetch(url, opts)`. It runs in
the host process (no CSP), but only after passing a strict policy:

1. **You declare the hostnames** in your manifest under `permissions.network`.
2. **The user approves** each host on first use (a dialog appears; the choice is
   remembered).
3. **https only**, and private/loopback/cloud-metadata addresses are always
   blocked (no SSRF).

A request to a host you didn't declare, or that the user blocked, fails — it
never silently reaches the network.

Manifest:

```json
{
  "id": "ai-chat", "name": "AI Chat", "version": "1.0.0", "main": "src/index.js",
  "permissions": { "network": ["api.openai.com"] }
}
```

`ctx.net.fetch(url, opts)`:

| Option | Type | Default |
|--------|------|---------|
| `method` | `'GET'｜'POST'｜'PUT'｜'DELETE'｜'PATCH'` | `'GET'` |
| `headers` | object | — |
| `body` | string or JSON-serializable value (sent as JSON) | — |
| `timeoutMs` | number (1000–120000) | 60000 |

Returns `{ ok, status, statusText, headers, data, text, error }` — `data` is the
parsed JSON body (or `null`), `text` the raw body.

Example — an AI chat plugin (the plugin manages its own API key via `ctx.storage`,
the framework never sees it):

```js
import { Plugin } from '@neogebra/sdk';

export default class AiChat extends Plugin {
  async ask(ctx, prompt) {
    const key = ctx.storage.get('apiKey', '');         // user set this in your settings UI
    if (!key) { ctx.log.warn('No API key set'); return; }

    const res = await ctx.net.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },     // your key, your call
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] },
    });

    if (!res.ok) { ctx.log.error('AI request failed:', res.error || res.status); return; }
    return res.data.choices?.[0]?.message?.content;
  }
}
```

The first time this plugin calls `api.openai.com`, the user sees an
**“Allow network access?”** dialog naming your plugin and the host. If they allow,
it's remembered; if they block, the call returns `{ ok: false }`.

> **Keys & secrets stay with your plugin.** Neogebra deliberately does not manage
> API keys — store them with `ctx.storage` (set via your own settings UI) and put
> them in the `headers` you pass to `ctx.net.fetch`.

### 6.7 Docking a panel into GeoGebra (`ctx.ui`)

To put a panel **inside GeoGebra's UI** (rather than a floating overlay), use
`ctx.ui.mountInAlgebraView()`. The framework finds GeoGebra's algebra view (the
left column), appends a host below the object tree, and keeps it attached across
GeoGebra DOM rebuilds — so you don't write fragile DOM-probing yourself. If the
algebra view isn't available, it falls back to a floating panel automatically.

```js
async onEnable(ctx) {
  const dock = ctx.ui.mountInAlgebraView({ title: 'My Panel', collapsed: false });
  // Render your UI into dock.element (it lives in a Shadow DOM the framework owns).
  const root = dock.element;
  root.innerHTML = '<div style="padding:8px">Hello from the algebra view</div>';
  // dock is auto-destroyed when your plugin is disabled/unloaded.
}
```

`mountInAlgebraView(opts)` → controller:

| Member | Description |
|--------|-------------|
| `element` | The element to render into (inside a framework-owned Shadow DOM). |
| `isDocked()` | `true` when docked inside the algebra view; `false` if floating. |
| `collapsed()` / `setCollapsed(b)` | Read/toggle the collapsed state. |
| `reattach()` | Force a re-attach (rarely needed). |
| `destroy()` | Remove it (also runs automatically on disable/unload). |

Options: `{ title?, collapsed?, collapsible?, onDockChange?(docked) }`.

Match GeoGebra's theme with `window.__ggbExtendTheme__()` (`'light'`/`'dark'`).
Keep your own styles inside the Shadow DOM so they don't leak into GeoGebra.

---

## 7. A complete example plugin

A plugin with a settings popup that draws a heart at the origin (mirrors the
shipped `ggb-hello` example).

`manifest.json`:

```json
{
  "id": "heart-demo",
  "name": "Heart Demo",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Greets on startup and offers a 'draw a heart' settings button.",
  "main": "src/index.js",
  "engines": { "ngbLoader": ">=1.0.0" }
}
```

`src/index.js`:

```js
import { Plugin } from '@neogebra/sdk';

export default class HeartDemo extends Plugin {
  async onEnable(ctx) {
    this.ctx = ctx;
    ctx.log.warn('Heart Demo enabled. Open its Settings to draw a heart.');
  }

  // Called when the user clicks "Settings" for this plugin in the panel.
  async onOpenSettings(ctx) {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;' +
      'background:rgba(20,22,30,.4)';
    host.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:24px;font-family:Roboto,sans-serif;
                  box-shadow:0 16px 48px rgba(0,0,0,.3);text-align:center">
        <h2 style="margin:0 0 12px">Heart Demo</h2>
        <button id="draw" style="padding:10px 16px;border:none;border-radius:999px;
                 background:#6557d3;color:#fff;cursor:pointer">Draw a heart at (0,0)</button>
        <button id="close" style="margin-left:8px;padding:10px 16px;border-radius:999px;
                 border:1px solid #ddd;background:#fff;cursor:pointer">Close</button>
      </div>`;
    document.documentElement.appendChild(host);

    host.querySelector('#draw').onclick = async () => {
      // a heart curve via a raw GeoGebra command
      await ctx.core.objects.eval(
        'heart=Curve(16 sin(t)^3, 13 cos(t)-5 cos(2t)-2 cos(3t)-cos(4t), t, 0, 2pi)'
      );
      await ctx.core.objects.setColor('heart', 217, 59, 57);
    };
    host.querySelector('#close').onclick = () => host.remove();
  }
}
```

---

## 8. Build & bundle

The runtime loads your `main` file as a **single module source string**. So:

- A **single‑file plugin** (no imports beyond `@neogebra/sdk`) works as‑is —
  just ship `src/index.js`.
- A **multi‑file plugin** (you split code, use npm deps, or write TypeScript /
  Svelte / etc.) must be **bundled into one file** first.

The import `@neogebra/sdk` is special: the runtime injects the SDK at eval time,
so **keep it as an external** and do not bundle it.

Supported import/export forms (the loader rewrites these):

```js
import { Plugin, GgbCore } from '@neogebra/sdk';   // named
import Plugin from '@neogebra/sdk';                 // default (rare)
export default class X extends Plugin { /* ... */ } // class default export
export default { onEnable() {} };                   // object default export
```

Example esbuild bundle command (SDK kept external):

```bash
esbuild src/main.js \
  --bundle --format=esm --platform=browser \
  --external:@neogebra/sdk \
  --outfile=src/index.js
```

Then set `"main": "src/index.js"` in the manifest and ship the folder.

---

## 9. Debugging

- **Launch (debug).** In the Neogebra manager, use **Launch (debug)** instead of
  Launch GeoGebra — it opens GeoGebra with DevTools and verbose logging.
- **The plugin panel.** Press **Right‑Shift** in GeoGebra to open the panel. Each
  plugin shows its name, version, author, and a **Settings** button (enabled when
  you implement `onOpenSettings`). If a plugin failed to load, the panel shows
  the error.
- **Console output.** Because GeoGebra overrides `console.log`, prefer
  `console.warn` / `ctx.log.warn` for messages you want to see in DevTools.
- **Iterate fast.** Edit your plugin files in `GGB_Plugins/<id>/`, then restart
  GeoGebra. No re‑injection needed.
- **Check it's enabled for this GeoGebra.** Enable/disable is per‑GeoGebra. If
  your plugin doesn't run, confirm it's toggled on for *that* install in the
  manager (changes take effect after restart).

---

## 10. Distributing your plugin

A plugin is just a folder with a `manifest.json` and the bundled code. To share
it:

1. Bundle (if needed) so `main` is a single file.
2. Zip the plugin folder (the folder that contains `manifest.json`).
3. Users unzip it into their `GGB_Plugins/` folder, or use **“+ Add plugin”** in
   the Neogebra manager and select the unzipped folder. Restart GeoGebra.

There is no central registry yet — distribution is folder‑based.

---

## 11. Reference: minimal checklist

- [ ] Folder with `manifest.json` + `main` entry.
- [ ] `id` is unique, lowercase‑ish (`[a-z0-9-_]`).
- [ ] Default export is a `Plugin` subclass (or hook object).
- [ ] Single bundled `main` file; `@neogebra/sdk` kept external.
- [ ] Use `ctx.core` for GeoGebra, `ctx.registerDisposable` for cleanup.
- [ ] Implement `onOpenSettings` if you want a config button.
- [ ] Test via **Launch (debug)**; confirm in the **Right‑Shift** panel.

---

*Neogebra is an unofficial, third‑party tool and is not affiliated with or
endorsed by GeoGebra. It is provided for learning and personal use. Plugins are
made by their own authors.*
