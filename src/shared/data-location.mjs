import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {homedir} from 'node:os';

/**
 * Persistent pointer to the active data folder.
 *
 * The pointer is deliberately NOT stored inside the database: the launcher has
 * to find the database before it can open it. It also must survive moving the
 * data folder to another disk. On Windows it lives in
 * `%LOCALAPPDATA%\LiveMemory\data-location.json` with a mirror in
 * `%APPDATA%\LiveMemory\data-location.json` so deleting the default data folder
 * by hand does not silently make the app create a new empty database.
 *
 * An unavailable target is an error, never a reason to fall back to defaults.
 */

export const LOCATION_FILE_NAME = 'data-location.json';
const MAX_PATH_LENGTH = 2048;

export function defaultLocationDirs({env = process.env, platform = process.platform, home = homedir()} = {}) {
  if (env.LIVE_MEMORY_LOCATION_DIR) {
    return [resolve(String(env.LIVE_MEMORY_LOCATION_DIR))];
  }
  if (platform === 'win32') {
    const dirs = [];
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'LiveMemory'));
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'LiveMemory'));
    if (dirs.length === 0) dirs.push(join(home, '.livememory'));
    return [...new Set(dirs.map((dir) => resolve(dir)))];
  }
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'LiveMemory')];
  }
  const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, '.config');
  return [join(base, 'livememory')];
}

export function locationFileCandidates(options = {}) {
  return defaultLocationDirs(options).map((dir) => join(dir, LOCATION_FILE_NAME));
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Number(raw.version) !== 1) return null;
  const dataDir = typeof raw.dataDir === 'string' ? raw.dataDir.trim() : '';
  if (!dataDir || dataDir.length > MAX_PATH_LENGTH || dataDir.includes('\u0000')) return null;
  // A relative path would resolve against the process working directory and is
  // not a stable launch location.
  if (!isAbsolute(dataDir)) return null;
  return {
    version: 1,
    dataDir: resolve(dataDir),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  };
}

/**
 * Read the first valid pointer. Invalid/corrupt files are ignored (the next
 * candidate is tried) and never cause a silent fallback to an empty database.
 * @returns {{dataDir:string, pointerFile:string, updatedAt:string|null}|null}
 */
export function readDataLocation(options = {}) {
  const {readFile = readFileSync, exists = existsSync} = options;
  for (const file of locationFileCandidates(options)) {
    if (!exists(file)) continue;
    try {
      const record = normalizeRecord(JSON.parse(readFile(file, 'utf8')));
      if (record) return {...record, pointerFile: file};
    } catch {
      // Try the mirror. A corrupt pointer must not erase data.
    }
  }
  return null;
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, file);
}

/**
 * Persist the active data folder. Returns the files that were written.
 * The write is atomic per file; the primary is written first so a crash while
 * updating the mirror can only leave a stale (not invalid) backup.
 */
export function writeDataLocation(dataDir, options = {}) {
  if (!isAbsolute(String(dataDir ?? ''))) {
    throw new Error('data location must be an absolute path');
  }
  const normalized = resolve(String(dataDir));
  const record = {
    version: 1,
    dataDir: normalized,
    updatedAt: new Date(options.now ?? Date.now()).toISOString()
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const files = [];
  let firstError = null;
  for (const file of locationFileCandidates(options)) {
    try {
      writeAtomic(file, text);
      files.push(file);
    } catch (error) {
      error.pointerFile = file;
      if (!firstError) firstError = error;
      // The mirror is a resilience aid. One successful location is enough for
      // the launcher to find the data again; only a total failure is fatal.
    }
  }
  if (files.length === 0) throw firstError ?? new Error('could not write the data location record');
  return {dataDir: normalized, files, updatedAt: record.updatedAt};
}

/** Remove the pointer(s). Used by `--forget-data-location`. */
export function clearDataLocation(options = {}) {
  const removed = [];
  for (const file of locationFileCandidates(options)) {
    try {
      if (existsSync(file)) {
        rmSync(file, {force: true});
        removed.push(file);
      }
    } catch {
      // Best effort: an unremovable pointer is reported by the launcher error.
    }
  }
  return removed;
}

export const __internal = {normalizeRecord, MAX_PATH_LENGTH};
