import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync, writeFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {acquireInstanceLock, isProcessAlive, readRuntimeInfo} from '../../src/launcher/lock.mjs';

test('acquires and releases the single instance lock', () => {
  const temp = createTempDir();
  const lockFile = join(temp.dir, 'runtime', 'instance.lock');
  const lock = acquireInstanceLock({lockFile});
  assert.equal(lock.acquired, true);
  assert.ok(existsSync(lockFile));
  lock.update({url: 'http://127.0.0.1:49999/'});
  lock.release();
  assert.equal(existsSync(lockFile), false);
  temp.cleanup();
});

test('a second instance is refused while the owning process is alive', () => {
  const temp = createTempDir();
  const lockFile = join(temp.dir, 'instance.lock');
  const first = acquireInstanceLock({lockFile});
  assert.equal(first.acquired, true);
  const second = acquireInstanceLock({lockFile});
  assert.equal(second.acquired, false);
  assert.equal(second.existing.pid, process.pid);
  first.release();
  temp.cleanup();
});

test('a stale lock from a dead process is taken over', () => {
  const temp = createTempDir();
  const lockFile = join(temp.dir, 'instance.lock');
  writeFileSync(lockFile, JSON.stringify({pid: 2147483646, startedAt: new Date().toISOString(), url: null}));
  const lock = acquireInstanceLock({lockFile});
  assert.equal(lock.acquired, true);
  assert.equal(lock.stale, true);
  lock.release();
  temp.cleanup();
});

test('a corrupt lock file is treated as stale', () => {
  const temp = createTempDir();
  const lockFile = join(temp.dir, 'instance.lock');
  writeFileSync(lockFile, 'not json');
  const lock = acquireInstanceLock({lockFile});
  assert.equal(lock.acquired, true);
  lock.release();
  temp.cleanup();
});

test('process liveness detection rejects nonsense pids', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(null), false);
});

test('runtime info is null when missing and parsed when present', () => {
  const temp = createTempDir();
  const runtimeFile = join(temp.dir, 'runtime.json');
  assert.equal(readRuntimeInfo(runtimeFile), null);
  writeFileSync(runtimeFile, JSON.stringify({pid: 1, port: 47800, url: 'http://127.0.0.1:47800/'}));
  const info = readRuntimeInfo(runtimeFile);
  assert.equal(info.port, 47800);
  temp.cleanup();
});
