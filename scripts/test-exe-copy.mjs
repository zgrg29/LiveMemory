import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {manifestLevel, setManifestLevel} from './pe-manifest.mjs';

/**
 * Create the test-only EXE copy used by automated verification.
 *
 * RC0-ADMIN-MANIFEST ships dist/LiveMemory.exe as `requireAdministrator`, so
 * Windows shows the standard UAC prompt on double-click. An automated,
 * non-interactive session cannot accept that prompt, and the verification
 * scripts must not try to bypass UAC. They therefore run the identical packaged
 * binary with an asInvoker copy in `tests/.tmp/`.
 *
 * The shipped EXE is never modified: this helper reads it, checks that it really
 * is requireAdministrator, patches only the in-memory bytes, and writes the copy.
 * Real UAC acceptance remains a manual user check.
 */
export function prepareTestExe({source, target}) {
  const bytes = readFileSync(source);
  const shipped = manifestLevel(bytes);
  if (shipped !== 'requireAdministrator') {
    throw new Error(`expected a requireAdministrator release EXE, got ${shipped}`);
  }
  setManifestLevel(bytes, 'asInvoker');
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, bytes);
  if (manifestLevel(readFileSync(target)) !== 'asInvoker') {
    throw new Error('failed to create the asInvoker test copy');
  }
  return target;
}
