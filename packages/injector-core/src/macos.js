'use strict';

/**
 * macOS code-signing & quarantine handling.
 *
 * Modifying a code-signed .app's Contents/Resources/ (rename payload, add proxy)
 * breaks its signature, so the OS may refuse to launch it or Electron's
 * integrity check may fail. Fix: clear the quarantine flag and ad-hoc re-sign
 * (`codesign --force --deep --sign -` + `xattr -dr com.apple.quarantine`).
 *
 * Best-effort and optional: failures are reported but never throw by default
 * (unneeded on unsigned/dev builds; the caller may lack Xcode CLI tools). Shells
 * out to `codesign`, `xattr`, `spctl`; no-op on non-darwin platforms.
 */

const { execFile } = require('child_process');

/** Promisified execFile that resolves { code, stdout, stderr } and never rejects. */
function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err || null,
      });
    });
  });
}

/** Is a tool available on PATH? */
async function hasTool(tool) {
  const res = await run('/usr/bin/which', [tool]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

/**
 * Report the current signature status of a bundle.
 * @returns {Promise<{signed:boolean, raw:string}>}
 */
async function signatureInfo(appBundle) {
  const res = await run('/usr/bin/codesign', ['-dv', appBundle]);
  // codesign prints signing info to stderr; exit 0 => has a signature.
  const signed = res.code === 0;
  return { signed, raw: (res.stderr || res.stdout || '').trim() };
}

/**
 * Remove the com.apple.quarantine xattr recursively (so Gatekeeper won't nag
 * about a freshly modified bundle). Best-effort.
 */
async function clearQuarantine(appBundle, log = () => {}) {
  const res = await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appBundle]);
  if (res.code === 0) log.ok ? log.ok('Cleared quarantine attribute') : log('cleared quarantine');
  else log.warn ? log.warn('Could not clear quarantine (may be none): ' + res.stderr.trim()) : log('no quarantine');
  return res.code === 0;
}

/**
 * Ad-hoc re-sign the WHOLE bundle so its signature matches the modified
 * contents. `--deep --force --sign -` re-signs every nested binary with an
 * ad-hoc identity ("-"), which is enough to satisfy local Gatekeeper for an app
 * the user already trusts on their own machine.
 *
 * @returns {Promise<{ok:boolean, reason?:string, output?:string}>}
 */
async function adhocResign(appBundle, log = () => {}) {
  if (!(await hasTool('codesign'))) {
    return { ok: false, reason: 'codesign not found (install Xcode command line tools: xcode-select --install)' };
  }
  const step = log.step || log;
  step('Re-signing bundle (ad-hoc) so the modified app passes integrity checks…');
  const res = await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle]);
  if (res.code === 0) {
    (log.ok || log)('Ad-hoc re-sign complete');
    return { ok: true, output: res.stderr.trim() };
  }
  (log.warn || log)('Ad-hoc re-sign failed: ' + (res.stderr || res.stdout).trim());
  return { ok: false, reason: (res.stderr || res.stdout).trim() };
}

/**
 * Verify the bundle would be accepted for execution (informational).
 */
async function assess(appBundle) {
  const res = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', appBundle]);
  return { accepted: res.code === 0, raw: (res.stderr || res.stdout || '').trim() };
}

/**
 * High-level: make a freshly-modified macOS .app launchable again.
 * Clears quarantine, then ad-hoc re-signs. Both best-effort.
 *
 * @param {string} appBundle path to the .app
 * @param {object} [log] a logger ({step,ok,warn,...}) or a plain function
 * @param {object} [opts]
 * @param {boolean} [opts.resign=true]
 * @param {boolean} [opts.clearQuarantine=true]
 * @returns {Promise<{quarantineCleared:boolean, resign:{ok:boolean,reason?:string}}>}
 */
async function repairSignature(appBundle, log = () => {}, opts = {}) {
  const doResign = opts.resign !== false;
  const doQuarantine = opts.clearQuarantine !== false;
  const result = { quarantineCleared: false, resign: { ok: false, reason: 'skipped' } };

  if (process.platform !== 'darwin') {
    return result; // no-op off macOS
  }
  if (doQuarantine) result.quarantineCleared = await clearQuarantine(appBundle, log);
  if (doResign) result.resign = await adhocResign(appBundle, log);
  return result;
}

module.exports = {
  run,
  hasTool,
  signatureInfo,
  clearQuarantine,
  adhocResign,
  assess,
  repairSignature,
};
