import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Temporary data directories live inside the repository (tests/.tmp, ignored by
 * git) so tests never touch the user's real LiveMemory folder.
 */
export function createTempDir(prefix = 'lm-') {
  const root = join(process.cwd(), 'tests', '.tmp');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, {recursive: true, force: true});
    }
  };
}
