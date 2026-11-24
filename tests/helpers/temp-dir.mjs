import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Temporary data directories live inside the repository (tests/.tmp, ignored by
 * git) so tests never touch the user's real LiveMemory folder.
 */
export function createTempDir(prefix = 'lm-') {
  // A managed workspace may deny DELETE_CHILD even to its owner. Windows
  // credential ACL tests can use an isolated OS temp root without changing
  // production ACLs or weakening their assertions.
  const root = process.env.LIVEMEMORY_TEST_TMP_ROOT || join(process.cwd(), 'tests', '.tmp');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, {recursive: true, force: true});
    }
  };
}
