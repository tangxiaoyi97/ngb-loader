// Bundle the runtime (SDK + loader + built-in panel-manager) into dist/runtime.bundle.js.
// Prereq: the panel-manager must be built first (its build.mjs) so its dist bundle exists.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelBundle = join(__dirname, '..', 'builtin-plugins', 'panel-manager', 'dist', 'index.bundle.js');
if (!existsSync(panelBundle)) {
  throw new Error('panel-manager not built — run its build.mjs first');
}
mkdirSync(join(__dirname, 'dist'), { recursive: true });

await build({
  entryPoints: [join(__dirname, 'src', 'index.js')],
  bundle: true,
  format: 'iife',
  outfile: join(__dirname, 'dist', 'runtime.bundle.js'),
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'none',
  // E2E hooks are compiled in ONLY for test builds (NGB_TEST_BUILD=1) and
  // dead-code eliminated from production bundles.
  define: { __NGB_TEST_BUILD__: process.env.NGB_TEST_BUILD === '1' ? 'true' : 'false' },
  loader: {
    '.bundle.js': 'text', // import the panel-manager bundle as a string
    '.png': 'dataurl',    // inline the built-in panel icon as a data: URI
  },
  logLevel: 'info',
});
console.log('[runtime] built dist/runtime.bundle.js');
