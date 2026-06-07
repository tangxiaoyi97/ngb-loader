// Compile the panel-manager plugin (with its Svelte UI) into dist/index.bundle.js.
import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, 'dist'), { recursive: true });

await build({
  entryPoints: [join(__dirname, 'src', 'index.js')],
  bundle: true,
  format: 'esm',
  outfile: join(__dirname, 'dist', 'index.bundle.js'),
  platform: 'browser',
  target: ['chrome110'],
  minify: false,
  // The SDK is provided by the runtime loader at eval time — keep the import.
  external: ['@neogebra/sdk'],
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  logLevel: 'info',
});
console.log('[panel-manager] built dist/index.bundle.js');
