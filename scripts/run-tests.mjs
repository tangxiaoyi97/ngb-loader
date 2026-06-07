// Version-proof unit test launcher: Node's `--test` arg handling varies across
// majors, so we discover test files ourselves and pass explicit paths to the runner.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..');
const unitDir = join(repo, 'tests', 'unit');

const files = readdirSync(unitDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(unitDir, f))
  .sort();

if (files.length === 0) {
  console.error('No test files found in tests/unit/');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: repo,
});
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => { console.error(err); process.exit(1); });
