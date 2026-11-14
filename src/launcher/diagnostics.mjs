import {spawn} from 'node:child_process';

/**
 * Failure presentation for a double-clicked executable.
 *
 * The Windows console disappears the moment the process exits, so a startup
 * failure must (a) print a human, localised explanation, (b) keep the window
 * open while the user reads it, and (c) leave a log file behind. Automation
 * (`--no-wait`, redirected stdio) must not be blocked by any of this.
 */

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

export function isInteractive({stdin = process.stdin} = {}) {
  return Boolean(stdin?.isTTY);
}

/**
 * Wait for any key / Enter. Only runs for an interactive console, so a service,
 * a test runner or a redirected pipe is never blocked.
 */
export function pauseForUser({stdin = process.stdin, stdout = process.stdout, enabled = true, prompt = ''} = {}) {
  if (!enabled || !isInteractive({stdin})) return Promise.resolve(false);
  if (prompt) stdout.write(`\n  ${prompt}\n`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        stdin.pause();
        stdin.removeListener('data', finish);
      } catch {
        /* ignore */
      }
      resolve(true);
    };
    try {
      stdin.resume();
      stdin.once('data', finish);
      stdin.once('error', finish);
    } catch {
      finish();
    }
  });
}

/**
 * Native message box, used only when there is no console to read (for example a
 * shortcut started with a hidden window). Best effort: if PowerShell is blocked
 * by policy the application still exits with its log file.
 */
export function showErrorDialog({title = 'LiveMemory', text = '', env = process.env, spawnImpl = spawn} = {}) {
  if (env.LIVE_MEMORY_ERROR_DIALOG === '0') return {shown: false, reason: 'disabled'};
  const safeText = String(text ?? '').slice(0, 3000);
  const encodedText = Buffer.from(safeText, 'utf8').toString('base64');
  const encodedTitle = Buffer.from(String(title), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))`,
    `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))`,
    "[void][System.Windows.Forms.MessageBox]::Show($text,$title,[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error)"
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand', encodedCommand
      ], {stdio: 'ignore', windowsHide: true, detached: false});
    } catch (error) {
      resolve({shown: false, reason: 'spawn-failed', error});
      return;
    }
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({shown: false, reason: 'timeout'});
    }, DIALOG_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (error) => done({shown: false, reason: 'error', error}));
    child.on('exit', (code) => done({shown: code === 0, reason: code === 0 ? 'closed' : `exit-${code}`}));
  });
}

export const __internal = {DIALOG_TIMEOUT_MS};
