# Desktop app icons

Drop app icons here for packaging (optional — electron-builder uses a default if absent):

- `icon.icns` — macOS (1024×1024 source recommended)
- `icon.ico` — Windows
- `icon.png` — Linux (512×512)

Generate all three from a single 1024×1024 PNG, e.g. with `electron-icon-builder`:

```bash
npx electron-icon-builder --input=./logo-1024.png --output=./assets
```

Until you add them, `npm run dist` still works and produces an app with the
stock Electron icon.
