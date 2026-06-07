/** Bundle the React wizard into web/dist/. */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = join(__dirname, 'public');
const dist = join(__dirname, 'dist');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

mkdirSync(dist, { recursive: true });
for (const f of readdirSync(pub)) copyFileSync(join(pub, f), join(dist, f));

const options = {
  entryPoints: [join(__dirname, 'src', 'App.jsx')],
  bundle: true,
  format: 'iife',
  outfile: join(dist, 'app.bundle.js'),
  platform: 'browser',
  target: ['chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  loader: { '.jsx': 'jsx' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[installer-web] watching…');
} else {
  await build(options);
  console.log('[installer-web] built dist/app.bundle.js');
}
