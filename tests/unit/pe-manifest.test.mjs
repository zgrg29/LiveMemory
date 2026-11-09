import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifestLevel, readManifest, setManifestLevel} from '../../scripts/pe-manifest.mjs';

test('the Node runtime manifest can be switched to requireAdministrator in memory', {skip: process.platform !== 'win32'}, () => {
  const buffer = readFileSync(process.execPath);
  const original = readManifest(buffer).text;
  assert.match(original, /<assembly/);
  assert.ok(['asInvoker', 'highestAvailable', 'requireAdministrator'].includes(manifestLevel(buffer)));
  const changed = setManifestLevel(buffer, 'requireAdministrator');
  assert.match(changed, /level="requireAdministrator"/);
  assert.equal(manifestLevel(buffer), 'requireAdministrator');
  const manifest = readManifest(buffer);
  assert.ok(manifest.size > 0);
  assert.ok(manifest.capacity >= manifest.size);
});
