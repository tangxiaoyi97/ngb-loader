// Remove generated build artifacts so the next build is fresh. Importantly deletes
// packages/desktop/vendor, which if stale can shadow the dev proxy and inject an OLD build.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const targets = [
  'packages/desktop/vendor',
  'packages/desktop/renderer/dist',
  'packages/desktop/release',
  'packages/proxy-core/dist',
  'packages/proxy-core/runtime/dist',
  'packages/proxy-core/builtin-plugins/panel-manager/dist',
  'packages/panel/dist',
  'packages/installer/web/dist',
];

for (const t of targets) {
  try { rmSync(join(root, t), { recursive: true, force: true }); console.log('[clean] removed', t); }
  catch (e) { console.log('[clean] skip', t, '(' + (e.code || e.message) + ')'); }
}
console.log('[clean] done. Run `npm run build` to rebuild.');
