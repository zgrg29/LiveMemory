import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {isAdministrator} from '../../src/launcher/admin.mjs';

function fakeSpawn(outcome) {
  return () => {
    const child = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (outcome instanceof Error) child.emit('error', outcome);
      else child.emit('exit', outcome);
    }, 1);
    return child;
  };
}

test('a successful elevated session check is true', async () => {
  assert.equal(await isAdministrator({platform: 'win32', spawnImpl: fakeSpawn(0)}), true);
});

test('a non-elevated session check is false', async () => {
  assert.equal(await isAdministrator({platform: 'win32', spawnImpl: fakeSpawn(2)}), false);
});

test('a missing check binary is unknown, not a false accusation', async () => {
  assert.equal(await isAdministrator({
    platform: 'win32',
    spawnImpl: fakeSpawn(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
  }), null);
});

test('non-Windows platforms are always considered usable', async () => {
  assert.equal(await isAdministrator({platform: 'linux'}), true);
});
