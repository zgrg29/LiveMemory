import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {findExistingUserDataDirs} from '../../src/launcher/profile-scan.mjs';

function profile(root, name, hasData = true) {
  const base = join(root, name, 'AppData', 'Local', 'LiveMemory');
  if (hasData) {
    mkdirSync(join(base, 'database'), {recursive: true});
    writeFileSync(join(base, 'database', 'livememory.db'), 'db');
  }
  return base;
}

test('finds existing LiveMemory data folders in local user profiles', () => {
  const temp = createTempDir();
  try {
    const alice = profile(temp.dir, 'Alice');
    profile(temp.dir, 'Bob', false);
    profile(temp.dir, 'Public');
    const found = findExistingUserDataDirs({
      usersRoot: temp.dir,
      env: {SystemDrive: 'C:'}
    });
    assert.deepEqual(found, [alice]);
  } finally {
    temp.cleanup();
  }
});

test('reports multiple profiles so the launcher can refuse to guess', () => {
  const temp = createTempDir();
  try {
    profile(temp.dir, 'Alice');
    profile(temp.dir, 'Bob');
    const found = findExistingUserDataDirs({usersRoot: temp.dir});
    assert.equal(found.length, 2);
  } finally {
    temp.cleanup();
  }
});

test('returns an empty list for a first run or an unreadable root', () => {
  const temp = createTempDir();
  try {
    assert.deepEqual(findExistingUserDataDirs({usersRoot: temp.dir}), []);
    assert.deepEqual(findExistingUserDataDirs({usersRoot: join(temp.dir, 'missing')}), []);
  } finally {
    temp.cleanup();
  }
});
