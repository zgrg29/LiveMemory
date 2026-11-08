import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {candidateDataDirs, probeWritable, resolveDataDir} from '../../src/launcher/data-dir.mjs';

test('Windows data directory order prefers LOCALAPPDATA', () => {
  const dirs = candidateDataDirs({
    platform: 'win32',
    env: {LOCALAPPDATA: 'C:/Users/Test/AppData/Local', APPDATA: 'C:/Users/Test/AppData/Roaming'},
    home: 'C:/Users/Test'
  });
  assert.equal(dirs[0], 'C:\\Users\\Test\\AppData\\Local\\LiveMemory');
  assert.equal(dirs[1], 'C:\\Users\\Test\\AppData\\Roaming\\LiveMemory');
  assert.ok(dirs.at(-1).endsWith('LiveMemory'));
});

test('an explicit --data-dir is used as is', () => {
  const temp = createTempDir();
  const target = join(temp.dir, 'custom');
  const resolved = resolveDataDir({platform: 'win32', env: {}, requested: target});
  assert.equal(resolved.dir, target);
  assert.equal(resolved.explicit, true);
  assert.equal(probeWritable(target).ok, true);
  temp.cleanup();
});

test('an unwritable explicit data directory is reported, never silently replaced', () => {
  const temp = createTempDir();
  const filePath = join(temp.dir, 'not-a-dir');
  writeFileSync(filePath, 'x');
  assert.throws(() => resolveDataDir({platform: 'win32', env: {}, requested: filePath}), (error) => {
    assert.equal(error.path, filePath);
    return true;
  });
  temp.cleanup();
});

test('falls back to the next candidate when one is unusable', () => {
  const temp = createTempDir();
  const filePath = join(temp.dir, 'locked');
  writeFileSync(filePath, 'x');
  const fallback = join(temp.dir, 'fallback');
  const resolved = resolveDataDir({
    platform: 'win32',
    env: {LOCALAPPDATA: filePath, APPDATA: temp.dir},
    home: temp.dir
  });
  assert.ok(resolved.dir.startsWith(temp.dir));
  assert.ok(resolved.attempts.length >= 2);
  assert.equal(resolved.attempts[0].ok, false);
  temp.cleanup();
});

test('reports when no candidate is writable', () => {
  const temp = createTempDir();
  const filePath = join(temp.dir, 'locked');
  writeFileSync(filePath, 'x');
  assert.throws(() => resolveDataDir({
    platform: 'linux',
    env: {XDG_DATA_HOME: filePath},
    home: filePath
  }), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.ok(Array.isArray(error.attempts));
    return true;
  });
  temp.cleanup();
});
