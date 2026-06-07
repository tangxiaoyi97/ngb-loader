// Bundle the desktop renderer (React) into renderer/dist/.
// CSP-safe: no external CDNs; everything is bundled into app.bundle.js.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'dist');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

mkdirSync(dist, { recursive: true });
copyFileSync(join(__dirname, 'index.html'), join(dist, 'index.html'));

const options = {
  entryPoints: [join(__dirname, 'src', 'App.jsx')],
  bundle: true,
  format: 'iife',
  outfile: join(dist, 'app.bundle.js'),
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  loader: { '.jsx': 'jsx' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[desktop-renderer] watching…');
} else {
  await build(options);
  console.log('[desktop-renderer] built dist/app.bundle.js');
}
