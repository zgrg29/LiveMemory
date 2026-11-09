import {spawn} from 'node:child_process';

/**
 * Best-effort administrator check for the packaged EXE.
 *
 * The EXE manifest requests administrator rights, so Windows elevates before
 * any code runs. This check is a defensive fallback for environments where the
 * manifest is bypassed or the process token is filtered; it is deliberately
 * not used by development `node` runs.
 */
export function isAdministrator({
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 4000
} = {}) {
  if (platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl('net.exe', ['session'], {stdio: 'ignore', windowsHide: true});
    } catch {
      finish(null);
      return;
    }
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code === 0));
  });
}
