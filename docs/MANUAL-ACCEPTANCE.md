# Manual Acceptance Guide (real Mac)

This is the hands-on checklist to validate GGB-Extend on your own machine — the
final layer the sandbox can't do (it can't launch a GUI). Follow it top to bottom.
Each step says **what to run**, **what you should see**, and **what to send me if it
doesn't**.

> ⏱ ~10 minutes. You'll inject into a copy of GeoGebra, confirm the panel opens,
> then uninstall and confirm GeoGebra is back to stock.

---

## 0. Prerequisites

```bash
node -v          # need >= 18
xcode-select -p  # should print a path; if not: xcode-select --install
```

`xcode-select` matters because injection ad-hoc **re-signs** the modified app
(otherwise macOS may refuse to launch a signed app whose contents changed).

> 💡 **Strongly recommended:** test on a **copy** first, not your primary install:
> ```bash
> cp -R "/Applications/GeoGebra Classic 6.app" ~/Desktop/GGB-Test.app
> ```
> Then use `~/Desktop/GGB-Test.app` as the `--path` everywhere below.

---

## 1. Build

```bash
cd <path-to>/ggb-ext
npm install
npm run build          # = build:panel + build:proxy
```

**Expect:**
```
[panel] built dist/panel.bundle.js
[build:proxy] bundled panel.bundle.js
[build:proxy] proxy assembled at .../packages/proxy-core/dist
```

**If it fails:** send the full terminal output of `npm run build`.

---

## 2. Doctor (pre-flight)

```bash
npm run doctor -- --path "$HOME/Desktop/GGB-Test.app"
```

**Expect:** Node ✓, all build artifacts ✓, the app listed with `state: pristine`,
and on macOS a `code signature: present` line. It prints the exact inject command.

**If "No install at --path":** double-check the path (drag the `.app` onto the
terminal to paste its exact path). Send me the doctor output.

---

## 3. Dry run (no changes)

```bash
node packages/injector-core/bin/ggb-extend.js inject --dry-run \
  --path "$HOME/Desktop/GGB-Test.app"
```

**Expect** a plan like:
```
→ 1. Rename app → core
→ 2. Install proxy at .../Resources/app
→ 3. Write manifest .ggb-extend.json
(dry run — nothing was written)
```

(Your install may show `app.asar → core.asar` instead — that's the packaged layout
and is equally fine.)

---

## 4. Inject

```bash
node packages/injector-core/bin/ggb-extend.js inject \
  --path "$HOME/Desktop/GGB-Test.app"
```

**Expect:**
```
→ Renaming app → core (safe backup)            (or app.asar → core.asar)
→ Installing proxy folder (app/)
→ Copying proxy payload from .../proxy-core/dist
→ Re-signing bundle (ad-hoc) …                 (macOS only)
✓ Cleared quarantine attribute                 (macOS only)
✓ Ad-hoc re-sign complete                       (macOS only)
✓ Injection complete. GeoGebra will now boot through GGB-Extend.
```

**If you see `EPERM` / permission denied:** the app is in a protected location.
Either use the `~/Desktop` copy (recommended) or re-run with `sudo`.

**If `codesign` errors:** re-run with `--skip-sign` to inject without re-signing,
then see the troubleshooting note in §8 about `xattr`/Gatekeeper.

---

## 5. Launch & open the panel  ⭐ the key check

```bash
open "$HOME/Desktop/GGB-Test.app"
```

1. GeoGebra should start **normally** (same as always).
2. Press the **right-hand Shift key**. A dark, glassy panel should slide in from
   the right titled **GGB-Extend**.
3. It shows **0 installed** (no plugins yet) with **Refresh** / **Open folder**
   buttons, and a **Settings** tab (opacity slider, hotkey display).
4. Press **Right-Shift** again (or click ✕ / the backdrop) — it slides away.

**This is the acceptance bar.** If the panel appears and toggles, the whole
injection + patch + preload + Shadow-DOM stack works on your machine. 🎉

### If GeoGebra won't launch, or the panel doesn't appear

Run it from the terminal with debug on so we can see logs:

```bash
GGB_EXTEND_DEBUG=1 "$HOME/Desktop/GGB-Test.app/Contents/MacOS/GeoGebra Classic 6"
```

- This opens **DevTools** automatically and prints `[GGB-Extend]` logs to the
  terminal.
- In DevTools **Console**, look for `[GGB-Extend/preload]` lines:
  `chained original preload`, `bridge exposed`, `panel injected into main world`,
  and finally `panel mounted (closed shadow DOM)`.

**Send me:**
1. The full terminal output (it includes proxy + renderer logs).
2. A screenshot of the DevTools **Console** tab.
3. If GeoGebra showed an OS dialog ("damaged", "can't be opened"), a screenshot of it.

---

## 6. Try a plugin (optional but nice)

```bash
# open the plugins folder (or click "Open folder" in the panel)
open "$HOME/Library/Application Support/GeoGebra (NeoGebra)/GGB_Plugins" 2>/dev/null \
 || open "$HOME/Library/Application Support/GeoGebra/GGB_Plugins"

# copy the bundled example into it:
cp -R "<path-to>/ggb-ext/examples/hello-plugin" \
      "$HOME/Library/Application Support/GeoGebra/GGB_Plugins/"
```

Back in the panel: **Refresh** → you should see **Hello Plugin** with a toggle.

> Note: the **runtime loader** that actually executes a plugin's code when you
> flip the toggle is the next milestone (the IPC + SDK pieces are done and tested;
> wiring the panel toggle → load/run is pending). For now the panel will list and
> persist the toggle state.

---

## 7. Uninstall & verify restore

```bash
node packages/injector-core/bin/ggb-extend.js uninstall \
  --path "$HOME/Desktop/GGB-Test.app"
open "$HOME/Desktop/GGB-Test.app"     # should launch as plain stock GeoGebra
```

**Expect:** `✓ Uninstall complete. GeoGebra restored to its original state.`
The `Resources/` folder should have `app` (or `app.asar`) back and **no** `core`
and **no** `.ggb-extend.json`.

Confirm with doctor:
```bash
npm run doctor -- --path "$HOME/Desktop/GGB-Test.app"   # state: pristine
```

---

## 8. macOS troubleshooting cheatsheet

| Symptom | Cause | Fix |
|---|---|---|
| "App is damaged and can't be opened" | Signed app modified; signature invalid | Re-run inject (it ad-hoc re-signs). Or manually: `codesign --force --deep --sign - "<app>"` then `xattr -dr com.apple.quarantine "<app>"` |
| "Can't be opened because Apple cannot check it" | Quarantine + Gatekeeper | `xattr -dr com.apple.quarantine "<app>"`, then right-click → Open once |
| `codesign: command not found` | No Xcode CLT | `xcode-select --install`, or inject with `--skip-sign` and clear quarantine manually |
| `EPERM` during inject | App in `/Applications` (protected) | Use a `~/Desktop` copy, or `sudo` the inject command |
| GeoGebra launches but no panel on Right-Shift | preload/panel issue | Relaunch with `GGB_EXTEND_DEBUG=1` (see §5) and send Console logs |
| Left-Shift opens it too | (shouldn't) wrong key location | Send me your keyboard layout; detection uses `KeyboardEvent.location === RIGHT` |

---

## What to capture for any bug report

1. `npm run doctor -- --path "<app>"` output
2. Terminal output of the failing command
3. For panel/runtime issues: `GGB_EXTEND_DEBUG=1` launch output + DevTools Console screenshot
4. Your macOS version (`sw_vers`) and chip (Intel/Apple Silicon)
5. GeoGebra version (doctor prints it)

Paste those back here and I'll iterate on the fix.
