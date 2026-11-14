import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {probeWritable} from '../shared/write-probe.mjs';

/**
 * User data layout. Nothing is ever written next to the executable: the install
 * directory may be read-only (Program Files) and shared by every user.
 */
export function createPaths(dataDir) {
  const root = dataDir;
  return {
    root,
    config: join(root, 'config'),
    database: join(root, 'database'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
    exports: join(root, 'exports'),
    backups: join(root, 'backups'),
    runtime: join(root, 'runtime'),
    secrets: join(root, 'secrets'),
    app: join(root, 'app'),
    databaseFile: join(root, 'database', 'livememory.db'),
    settingsFile: join(root, 'config', 'settings.json'),
    runtimeFile: join(root, 'runtime', 'runtime.json'),
    lockFile: join(root, 'runtime', 'instance.lock'),
    errorFile: join(root, 'runtime', 'last-error.json')
  };
}

export function ensureDirectories(paths) {
  for (const directory of [
    paths.root,
    paths.config,
    paths.database,
    paths.logs,
    paths.cache,
    paths.exports,
    paths.backups,
    paths.runtime,
    paths.secrets
  ]) {
    mkdirSync(directory, {recursive: true});
  }
  return paths;
}

/**
 * Verify that we can actually create, write, read and remove files in the data
 * directory. `fs.accessSync(W_OK)` only checks existence on Windows, which is
 * exactly how a read-only folder used to pass startup and fail later on the
 * instance lock. The underlying filesystem error is re-thrown so the launcher
 * can explain the path, the code and the failing step.
 */
export function assertWritable(paths) {
  ensureDirectories(paths);
  const probe = probeWritable(paths.runtime);
  if (!probe.ok) {
    const error = probe.error ?? new Error(`write probe failed at ${probe.step}`);
    error.path = probe.dir;
    error.step = probe.step;
    error.code = probe.code ?? 'EWRITE';
    throw error;
  }
  return true;
}
