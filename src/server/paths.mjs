import {join} from 'node:path';
import {mkdirSync, accessSync, constants, rmSync} from 'node:fs';

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
    paths.runtime
  ]) {
    mkdirSync(directory, {recursive: true});
  }
  return paths;
}

/**
 * Verify that we can actually create and remove files in the data directory.
 * Throws the underlying filesystem error so the launcher can explain which path
 * failed instead of pretending recording will work.
 */
export function assertWritable(paths) {
  ensureDirectories(paths);
  const probe = join(paths.runtime, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(probe, {recursive: true});
    accessSync(probe, constants.W_OK);
  } finally {
    rmSync(probe, {recursive: true, force: true});
  }
  return true;
}
