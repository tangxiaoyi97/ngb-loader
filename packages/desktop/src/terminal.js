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

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildPosixTailScript(file) {
  const logFile = shQuote(file);
  const doneMark = shQuote(DONE_MARK);
  return `#!/bin/sh
clear
echo "Neogebra — following log (finishes when done)"
echo "------------------------------------------------------"
log_file=${logFile}
done_mark=${doneMark}
fifo="\${TMPDIR:-/tmp}/neogebra-tail.$$"
tail_pid=

cleanup() {
  if [ -n "$tail_pid" ]; then kill "$tail_pid" >/dev/null 2>&1; fi
  rm -f "$fifo"
}
trap cleanup EXIT INT TERM

mkfifo "$fifo" || exit 1
tail -n +1 -F "$log_file" > "$fifo" 2>/dev/null &
tail_pid=$!

while IFS= read -r line; do
  case "$line" in
    *"$done_mark"*) break ;;
    *) printf '%s\\n' "$line" ;;
  esac
done < "$fifo"

cleanup
trap - EXIT INT TERM
exit 0
`;
}

function buildPowerShellTailScript(file) {
  const logFile = psQuote(file);
  const doneMark = psQuote(DONE_MARK);
  return `$ErrorActionPreference = 'SilentlyContinue'
Write-Host 'Neogebra - following log (finishes when done)'
Write-Host '------------------------------------------------------'
$Path = ${logFile}
$Done = ${doneMark}
$Position = 0

while ($true) {
  if (Test-Path -LiteralPath $Path) {
    $Stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [void]$Stream.Seek($Position, [System.IO.SeekOrigin]::Begin)
      $Reader = [System.IO.StreamReader]::new($Stream)
      try {
        while (-not $Reader.EndOfStream) {
          $Line = $Reader.ReadLine()
          if ($Line -like "*$Done*") { exit 0 }
          Write-Output $Line
        }
        $Position = $Stream.Position
      } finally {
        $Reader.Dispose()
      }
    } finally {
      if ($Stream) { $Stream.Dispose() }
    }
  }
  Start-Sleep -Milliseconds 200
}
`;
}

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
        // Tail through a FIFO so the shell can kill tail immediately after the
        // sentinel. Then let the .command shell exit cleanly. Do not close this
        // Terminal window via AppleScript from inside the same Terminal session:
        // macOS will warn that sh/osascript are still running.
        const sh = path.join(this.dir, 'neogebra-tail.command');
        fs.writeFileSync(sh, buildPosixTailScript(f));
        fs.chmodSync(sh, 0o755);
        execFile('open', ['-a', 'Terminal', sh], (err) => { /* ignore */ });
        return { ok: true };
      }
      if (process.platform === 'win32') {
        // Avoid `Get-Content -Wait | ...`; breaking the consumer can leave the
        // producer alive. Poll appended bytes directly and exit the cmd window
        // when the sentinel appears.
        const ps1 = path.join(this.dir, 'neogebra-tail.ps1');
        fs.writeFileSync(ps1, buildPowerShellTailScript(f));
        const safePs1 = ps1.replace(/"/g, '""');
        const cmd = `start "Neogebra log" cmd /c powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${safePs1}"`;
        spawn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: 'ignore', windowsHide: false, shell: false }).unref();
        return { ok: true };
      }
      // Linux: same FIFO strategy as macOS; terminals close when the shell exits.
      const tailCmd = buildPosixTailScript(f);
      const candidates = [
        ['gnome-terminal', ['--', 'bash', '-lc', tailCmd]],
        ['konsole', ['-e', 'bash', '-lc', tailCmd]],
        ['xterm', ['-e', 'bash', '-lc', tailCmd]],
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

module.exports = {
  TerminalLog,
  DONE_MARK,
  _internals: { buildPosixTailScript, buildPowerShellTailScript, shQuote, psQuote },
};
