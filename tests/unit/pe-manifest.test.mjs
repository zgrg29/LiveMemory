import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifestLevel, readManifest, setManifestLevel} from '../../scripts/pe-manifest.mjs';

test('the manifest helper can still produce an asInvoker test copy', {skip: process.platform !== 'win32'}, () => {
  const buffer = readFileSync(process.execPath);
  const original = readManifest(buffer).text;
  assert.match(original, /<assembly/);
  assert.ok(['asInvoker', 'highestAvailable', 'requireAdministrator'].includes(manifestLevel(buffer)));
  const changed = setManifestLevel(buffer, 'asInvoker');
  assert.match(changed, /level="asInvoker"/);
  assert.equal(manifestLevel(buffer), 'asInvoker');
  const manifest = readManifest(buffer);
  assert.ok(manifest.size > 0);
  assert.ok(manifest.capacity >= manifest.size);
});

test('the Windows build script ships requireAdministrator and verifies the final EXE', () => {
  const build = readFileSync(new URL('../../scripts/build-windows.mjs', import.meta.url), 'utf8');
  assert.match(build, /setManifestLevel\(binary, 'requireAdministrator'\)/);
  assert.match(build, /failed to apply requireAdministrator manifest/);
  assert.match(build, /final EXE manifest is not requireAdministrator/);
  assert.doesNotMatch(build, /setManifestLevel\(binary, 'asInvoker'\)/);
});
