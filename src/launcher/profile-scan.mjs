import {existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * Find existing LiveMemory data folders in other Windows user profiles.
 *
 * Older LiveMemory builds used a `requireAdministrator` manifest, so Windows
 * could run the elevated process under a different administrator account and
 * `%LOCALAPPDATA%` pointed at that account. The packaged EXE is now asInvoker,
 * but the conservative scan remains: before creating a new empty database, the
 * launcher checks whether exactly one existing LiveMemory database can be found
 * in the local user profiles. If there are several, it refuses to guess and asks
 * for `--data-dir`.
 */
export function findExistingUserDataDirs({
  env = process.env,
  usersRoot = null,
  platform = process.platform,
  access = existsSync,
  readdir = readdirSync
} = {}) {
  if (platform !== 'win32') return [];
  const root = usersRoot
    ?? (env.SystemDrive ? join(env.SystemDrive, 'Users') : (env.USERPROFILE ? resolve(env.USERPROFILE, '..') : 'C:\\Users'));
  const ignored = new Set(['public', 'default', 'default user', 'all users']);
  let entries = [];
  try {
    entries = readdir(root, {withFileTypes: true});
  } catch {
    return [];
  }
  const found = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name.toLowerCase())) continue;
    for (const base of [
      join(root, entry.name, 'AppData', 'Local', 'LiveMemory'),
      join(root, entry.name, 'AppData', 'Roaming', 'LiveMemory')
    ]) {
      try {
        if (access(join(base, 'database', 'livememory.db'))) found.add(base);
      } catch {
        /* unreadable profile: ignore it rather than guessing */
      }
    }
  }
  return [...found];
}
