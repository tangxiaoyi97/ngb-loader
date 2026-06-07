'use strict';

// Mirror log entries to a file and open the OS terminal to tail it live, so
// inject/restore output shows in a real terminal window.
//   macOS:   Terminal.app runs `tail -f <logfile>`
//   Windows: cmd runs PowerShell `Get-Content -Wait <logfile>`
//   Linux:   tries common terminals (gnome-terminal/konsole/xterm) with `tail -f`

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// Sentinel line written when an operation finishes; the terminal tail watches
// for it and then exits on its own.
const DONE_MARK = '__NEOGEBRA_DONE__';

class TerminalLog {
  /** @param {string} dir folder to keep the log file in (e.g. app.getPath('logs')) */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'neogebra.log');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  /** Append a formatted log line. Safe to call often. */
  append(entry) {
    try {
      const ts = new Date(entry && entry.ts ? entry.ts : Date.now()).toLocaleTimeString();
      const level = (entry && entry.level ? entry.level : 'info').toUpperCase().padEnd(5);
      const msg = entry && entry.msg != null ? entry.msg : '';
      fs.appendFileSync(this.file, `[${ts}] ${level} ${msg}\n`);
    } catch { /* best-effort */ }
  }

  /**
   * Start a fresh session: TRUNCATE the log (so a newly opened terminal doesn't
   * immediately see the previous run's DONE sentinel) and write a header.
   */
  banner(title) {
    try { fs.writeFileSync(this.file, `===== ${title} — ${new Date().toLocaleString()} =====\n`); } catch { /* ignore */ }
  }

  /**
   * Mark the current operation finished. Writes a sentinel line that the tailing
   * terminal watches for, so the terminal window closes itself when done.
   */
  done(ok = true) {
    try { fs.appendFileSync(this.file, `\n${ok ? 'Done.' : 'Finished with errors.'} (you can close this window)\n${DONE_MARK}\n`); } catch { /* ignore */ }
  }

  /**
   * Open the OS terminal tailing the log file. Returns { ok, error }.
   * Best-effort and non-throwing.
   */
  openTail() {
    try { if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, ''); } catch { /* ignore */ }
    const f = this.file;
    try {
      if (process.platform === 'darwin') {
        // Read the log in a shell loop (NOT `tail -f | sed`, because tail -f keeps
        // blocking after sed exits). When we see the sentinel we kill tail and
        // close THIS Terminal window via AppleScript — matched by the window's
        // TTY, with `saving no` so macOS doesn't pop a "process running" prompt
        // (that prompt is what kept the window open).
        const sh = path.join(this.dir, 'neogebra-tail.command');
        fs.writeFileSync(sh,
          `#!/bin/sh\n` +
          `clear\n` +
          `echo "Neogebra — following log (auto-closes when finished)"\n` +
          `echo "------------------------------------------------------"\n` +
          `tty_dev=$(tty)\n` +
          `# follow the file, printing new lines, until the sentinel appears\n` +
          `tail -n +1 -F "${f}" 2>/dev/null | while IFS= read -r line; do\n` +
          `  case "$line" in\n` +
          `    *${DONE_MARK}*) break ;;\n` +
          `    *) printf '%s\\n' "$line" ;;\n` +
          `  esac\n` +
          `done\n` +
          `# stop the lingering tail first so the window has no "busy" process,\n` +
          `# then close this exact window. Find the target window id first (don't\n` +
          `# close while iterating), then close by id with no save prompt.\n` +
          `pkill -P $$ tail >/dev/null 2>&1\n` +
          `/usr/bin/osascript \\\n` +
          `  -e "tell application \\"Terminal\\"" \\\n` +
          `  -e "set wid to missing value" \\\n` +
          `  -e "repeat with w in windows" \\\n` +
          `  -e "repeat with t in tabs of w" \\\n` +
          `  -e "if tty of t is \\"$tty_dev\\" then set wid to id of w" \\\n` +
          `  -e "end repeat" \\\n` +
          `  -e "end repeat" \\\n` +
          `  -e "if wid is not missing value then close (every window whose id is wid) saving no" \\\n` +
          `  -e "end tell" >/dev/null 2>&1\n` +
          `exit 0\n`);
        fs.chmodSync(sh, 0o755);
        execFile('open', ['-a', 'Terminal', sh], (err) => { /* ignore */ });
        return { ok: true };
      }
      if (process.platform === 'win32') {
        // PowerShell follows the file and breaks out of the loop on the sentinel,
        // then the window closes (cmd /c, not /k).
        const ps = `Get-Content -Path '${f.replace(/'/g, "''")}' -Wait -Tail 1000 | ForEach-Object { Write-Output $_; if ($_ -match '${DONE_MARK}') { break } }`;
        const cmd = `start "Neogebra log" cmd /c powershell -NoLogo -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`;
        spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: false, shell: false }).unref();
        return { ok: true };
      }
      // Linux: read loop that breaks on the sentinel (tail -F | while read),
      // then the terminal closes when its command returns. We also kill the
      // lingering tail so it doesn't keep the window alive.
      const tailCmd = `tail -n +1 -F "${f}" 2>/dev/null | while IFS= read -r line; do case "$line" in *${DONE_MARK}*) break;; *) printf '%s\\n' "$line";; esac; done; pkill -P $$ tail 2>/dev/null; exit 0`;
      const candidates = [
        ['gnome-terminal', ['--', 'bash', '-lc', tailCmd]],
        ['konsole', ['-e', 'bash', '-lc', tailCmd]],
        ['xterm', ['-e', `bash -lc '${tailCmd}'`]],
      ];
      const tryNext = (i) => {
        if (i >= candidates.length) return;
        const [bin, args] = candidates[i];
        const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => tryNext(i + 1));
        child.unref();
      };
      tryNext(0);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  }
}

module.exports = { TerminalLog };
