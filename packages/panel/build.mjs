/**
 * build.mjs — compile the Svelte panel into a single self-contained IIFE.
 *
 * Output: dist/panel.bundle.js  (also copied into proxy-core/assets by the
 * top-level build:proxy script). The bundle has NO external dependencies and is
 * safe to `webFrame.executeJavaScript()` inside GeoGebra's page.
 */
import { build, context } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

mkdirSync(join(__dirname, 'dist'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(__dirname, 'src', 'mount.js')],
  bundle: true,
  format: 'iife',
  outfile: join(__dirname, 'dist', 'panel.bundle.js'),
  platform: 'browser',
  target: ['chrome110'], // Electron ships a modern Chromium
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  // Compile-time flag so the bundle can branch on preview vs. injected.
  define: {
    'import.meta.env.PREVIEW': JSON.stringify(false),
  },
  plugins: [
    esbuildSvelte({
      // No preprocess needed — components use plain CSS/JS (no TS/SCSS).
      compilerOptions: {
        // Plain Svelte components (NOT customElement) — we mount manually into a
        // shadow root we control, which is simpler & smaller than the CE wrapper.
        css: 'injected',
        compatibility: { componentApi: 4 },
        dev,
      },
    }),
  ],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[panel] watching for changes…');
} else {
  await build(options);
  console.log('[panel] built dist/panel.bundle.js');
}
