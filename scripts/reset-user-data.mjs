// Remove Neogebra user-data folders so you can start fresh. Targets the current
// app-support dir for: old GGB-Extend leftovers, the dev manager folder, and the
// (old + new) injected-GeoGebra plugin libraries.
//
//   node scripts/reset-user-data.mjs          # list what WOULD be removed
//   node scripts/reset-user-data.mjs --yes    # actually remove them
//
// This does NOT touch any GeoGebra app bundle — only Application Support data.
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, statSync } from 'node:fs';

function appSupportBase() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support');
  if (platform() === 'win32') return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return join(home, '.config');
}

const base = appSupportBase();

// Folder names this project has used over time (old → new).
const targets = [
  '@ggb-extend',           // oldest dev manager (pre-rename)
  '@neogebra',             // previous dev manager name
  'neogebra-loader',       // current manager name (remove to fully reset)
  'GeoGebra (GGB-Extend)', // old injected-GeoGebra plugin library
  'GeoGebra (NeoGebra)',   // current injected-GeoGebra plugin library
].map((n) => join(base, n));

const apply = process.argv.includes('--yes') || process.argv.includes('-y');

let found = 0;
for (const dir of targets) {
  if (!existsSync(dir)) continue;
  found++;
  let kind = 'dir';
  try { kind = statSync(dir).isDirectory() ? 'dir' : 'file'; } catch { /* ignore */ }
  if (apply) {
    try { rmSync(dir, { recursive: true, force: true }); console.log('removed   ', dir); }
    catch (e) { console.error('FAILED    ', dir, '-', e && e.message); }
  } else {
    console.log('would remove', `(${kind})`, dir);
  }
}

if (found === 0) {
  console.log('Nothing to remove — no Neogebra user-data folders found under:', base);
} else if (!apply) {
  console.log(`\n${found} folder(s) above. Re-run with --yes to delete them, then reinstall.`);
} else {
  console.log(`\nDone. Removed ${found} folder(s). Reinstall: add your GeoGebra and inject again.`);
}
