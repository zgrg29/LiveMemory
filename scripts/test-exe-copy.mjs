import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
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
 *
 * Some Windows configurations (Application Control / Smart App Control) refuse
 * to start a binary that was re-patched after the build, even when the patch only
 * lowers the requested execution level. Set `LIVE_MEMORY_TEST_ASINVOKER_EXE` to a
 * separately built asInvoker binary produced from the same sources. This helper
 * then still verifies the shipped EXE is requireAdministrator, verifies the
 * supplied binary is asInvoker, and verifies both binaries embed the same
 * `buildId` from `build/build-info.json` before copying. The release artifact is
 * never modified and the requested UAC level is never raised.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packagedBuildId() {
  const info = JSON.parse(readFileSync(resolve(ROOT, 'build', 'build-info.json'), 'utf8'));
  if (!info?.buildId) throw new Error('build/build-info.json is missing a buildId');
  return info.buildId;
}

function assertEmbeddedBuildId(bytes, expected, label) {
  const fragments = [
    Buffer.from(`"buildId": "${expected}"`, 'utf8'),
    Buffer.from(`\"buildId\": \"${expected}\"`, 'utf8')
  ];
  if (!fragments.some((fragment) => bytes.includes(fragment))) {
    throw new Error(`${label} does not embed buildId ${expected}`);
  }
}

export function prepareTestExe({source, target}) {
  const bytes = readFileSync(source);
  const shipped = manifestLevel(bytes);
  if (shipped !== 'requireAdministrator') {
    throw new Error(`expected a requireAdministrator release EXE, got ${shipped}`);
  }
  const expectedBuildId = packagedBuildId();
  const override = process.env.LIVE_MEMORY_TEST_ASINVOKER_EXE;
  if (override) {
    const prebuiltPath = resolve(override);
    const prebuilt = readFileSync(prebuiltPath);
    if (manifestLevel(prebuilt) !== 'asInvoker') {
      throw new Error(`LIVE_MEMORY_TEST_ASINVOKER_EXE must be an asInvoker build: ${prebuiltPath}`);
    }
    assertEmbeddedBuildId(bytes, expectedBuildId, 'shipped EXE');
    assertEmbeddedBuildId(prebuilt, expectedBuildId, 'prebuilt asInvoker build');
    mkdirSync(dirname(target), {recursive: true});
    copyFileSync(prebuiltPath, target);
    if (manifestLevel(readFileSync(target)) !== 'asInvoker') {
      throw new Error('failed to copy the prebuilt asInvoker test EXE');
    }
    return target;
  }
  setManifestLevel(bytes, 'asInvoker');
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, bytes);
  if (manifestLevel(readFileSync(target)) !== 'asInvoker') {
    throw new Error('failed to create the asInvoker test copy');
  }
  return target;
}
