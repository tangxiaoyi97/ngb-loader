// Build the panel-manager plugin, then the runtime.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = (file) => execFileSync('node', [file], { stdio: 'inherit' });

run(join(__dirname, 'builtin-plugins', 'panel-manager', 'build.mjs'));
run(join(__dirname, 'runtime', 'build.mjs'));
console.log('[build-runtime] panel-manager + runtime built');
