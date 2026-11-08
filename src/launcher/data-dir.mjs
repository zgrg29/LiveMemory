import {join, resolve} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {probeWritable} from '../shared/write-probe.mjs';

/**
 * User data directory resolution.
 *
 * Never write next to the executable: the install folder may be read-only
 * (Program Files) and is shared between Windows accounts.
 *
 * Order on Windows: explicit --data-dir / LIVE_MEMORY_DATA_DIR, then
 * %LOCALAPPDATA%\LiveMemory, %APPDATA%\LiveMemory, the user profile and finally
 * the per-user temp folder. The first folder that passes a *real* write probe
 * (create + write + read + delete) wins; the launcher warns when it had to move
 * away from the default location so the user knows where data will live.
 *
 * An explicitly requested folder is still strict: if it is not writable the
 * launcher reports the failing path and the Windows error code instead of
 * silently writing somewhere else.
 */

export {probeWritable};

export function candidateDataDirs({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  temp = tmpdir()
} = {}) {
  const candidates = [];
  // The packaged executable knows its intended default folder (usually
  // %LOCALAPPDATA%\LiveMemory). It is a *preference*, not an instruction: if it
  // turns out to be read-only the launcher may fall back instead of refusing to
  // start. Only `--data-dir` / LIVE_MEMORY_DATA_DIR are treated as explicit.
  if (env.LIVE_MEMORY_DEFAULT_DATA_DIR) candidates.push(resolve(env.LIVE_MEMORY_DEFAULT_DATA_DIR));
  const explicit = env.LIVE_MEMORY_DATA_DIR;
  if (explicit) candidates.push(resolve(explicit));
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'LiveMemory'));
    if (env.APPDATA) candidates.push(join(env.APPDATA, 'LiveMemory'));
  } else if (platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'LiveMemory'));
  } else {
    if (env.XDG_DATA_HOME) candidates.push(join(env.XDG_DATA_HOME, 'livememory'));
    candidates.push(join(home, '.local', 'share', 'livememory'));
  }
  candidates.push(join(home, 'LiveMemory'));
  // Last resort: the per-user temp folder is always writable on a healthy
  // Windows account, so the application can still start and explain itself.
  candidates.push(join(temp, 'LiveMemory'));
  return [...new Set(candidates.map((item) => resolve(item)))];
}

function describeAttempt(probe) {
  return {
    dir: probe.dir,
    ok: probe.ok,
    ...(probe.ok ? {} : {code: probe.code ?? 'unknown', step: probe.step ?? null})
  };
}

/**
 * @returns {{dir:string, explicit:boolean, fallback:boolean, attempts:Array<{dir:string, ok:boolean, code?:string, step?:string}>}}
 * @throws when an explicitly requested directory is not writable, or when no
 *   candidate location can be written to at all.
 */
export function resolveDataDir({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  temp = tmpdir(),
  requested = null,
  probe = probeWritable
} = {}) {
  const explicitDir = requested ?? env.LIVE_MEMORY_DATA_DIR ?? null;
  if (explicitDir) {
    const dir = resolve(explicitDir);
    const result = probe(dir);
    if (!result.ok) {
      const error = new Error(result.error?.message ?? `data folder is not writable (${result.step ?? 'probe'})`);
      error.code = result.code ?? 'EWRITE';
      error.path = dir;
      error.step = result.step ?? null;
      error.attempts = [describeAttempt(result)];
      throw error;
    }
    return {dir, explicit: true, fallback: false, attempts: [describeAttempt(result)]};
  }

  const attempts = [];
  const candidates = candidateDataDirs({env, platform, home, temp});
  for (const dir of candidates) {
    const result = probe(dir);
    attempts.push(describeAttempt(result));
    if (result.ok) {
      return {dir, explicit: false, fallback: dir !== candidates[0], attempts};
    }
  }
  const error = new Error('no writable data directory');
  error.code = 'ENOENT';
  error.attempts = attempts;
  throw error;
}
