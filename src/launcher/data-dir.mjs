import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {mkdirSync, accessSync, constants} from 'node:fs';

/**
 * User data directory resolution.
 *
 * Never write next to the executable: the install folder may be read-only
 * (Program Files) and is shared between Windows accounts.
 *
 * Order: explicit --data-dir / LIVE_MEMORY_DATA_DIR, then
 * %LOCALAPPDATA%\LiveMemory, then %APPDATA%\LiveMemory, then the home folder.
 */
export function candidateDataDirs({env = process.env, platform = process.platform, home = homedir()} = {}) {
  const candidates = [];
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
  return [...new Set(candidates.map((item) => resolve(item)))];
}

/** Check writability without leaving anything behind on success. */
export function probeWritable(directory) {
  try {
    mkdirSync(directory, {recursive: true});
    accessSync(directory, constants.W_OK);
    return {ok: true, error: null};
  } catch (error) {
    return {ok: false, error};
  }
}

/**
 * @returns {{dir:string, explicit:boolean, attempts:Array<{dir:string, ok:boolean, code?:string}>}}
 * @throws when an explicitly requested directory is not writable
 */
export function resolveDataDir({env = process.env, platform = process.platform, home = homedir(), requested = null} = {}) {
  const explicitDir = requested ?? env.LIVE_MEMORY_DATA_DIR ?? null;
  if (explicitDir) {
    const dir = resolve(explicitDir);
    const probe = probeWritable(dir);
    if (!probe.ok) {
      const error = new Error(probe.error?.message ?? 'not writable');
      error.code = probe.error?.code ?? 'EWRITE';
      error.path = dir;
      throw error;
    }
    return {dir, explicit: true, attempts: [{dir, ok: true}]};
  }
  const attempts = [];
  for (const dir of candidateDataDirs({env, platform, home})) {
    const probe = probeWritable(dir);
    attempts.push({dir, ok: probe.ok, ...(probe.ok ? {} : {code: probe.error?.code ?? 'unknown'})});
    if (probe.ok) return {dir, explicit: false, attempts};
  }
  const error = new Error('no writable data directory');
  error.code = 'ENOENT';
  error.attempts = attempts;
  throw error;
}
