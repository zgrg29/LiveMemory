import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {probeInstance} from '../../src/launcher/instance.mjs';

function runtimeFileFor(temp, payload) {
  const runtimeFile = join(temp.dir, 'runtime.json');
  writeFileSync(runtimeFile, JSON.stringify(payload));
  return runtimeFile;
}

test('reports a healthy instance when the recorded URL answers as LiveMemory', async () => {
  const temp = createTempDir();
  const runtimeFile = runtimeFileFor(temp, {pid: 4242, port: 47800, url: 'http://127.0.0.1:47800/'});
  const calls = [];
  const result = await probeInstance({
    runtimeFile,
    lockPid: 4242,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {ok: true, status: 200, json: async () => ({status: 'ok', name: 'LiveMemory'})};
    }
  });
  assert.equal(result.running, true);
  assert.equal(result.reason, 'healthy');
  assert.equal(calls[0], 'http://127.0.0.1:47800/api/health');
  temp.cleanup();
});

test('treats an unreachable pid-reused lock as stale instead of "already running"', async () => {
  const temp = createTempDir();
  const runtimeFile = runtimeFileFor(temp, {pid: 4242, port: 47800, url: 'http://127.0.0.1:47800/'});
  const result = await probeInstance({
    runtimeFile,
    lockPid: 4242,
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'});
    }
  });
  assert.equal(result.running, false);
  assert.equal(result.reason, 'unreachable');
  temp.cleanup();
});

test('does not trust a foreign service on the recorded port', async () => {
  const temp = createTempDir();
  const runtimeFile = runtimeFileFor(temp, {pid: 4242, url: 'http://127.0.0.1:47800/'});
  const result = await probeInstance({
    runtimeFile,
    lockPid: 4242,
    fetchImpl: async () => ({ok: true, status: 200, json: async () => ({name: 'something-else'})})
  });
  assert.equal(result.running, false);
  assert.equal(result.reason, 'foreign-service');
  temp.cleanup();
});

test('a lock and runtime file that disagree are stale', async () => {
  const temp = createTempDir();
  const runtimeFile = runtimeFileFor(temp, {pid: 111, url: 'http://127.0.0.1:47800/'});
  const result = await probeInstance({runtimeFile, lockPid: 222, fetchImpl: async () => { throw new Error('should not be called'); }});
  assert.equal(result.running, false);
  assert.equal(result.reason, 'pid-mismatch');
  temp.cleanup();
});

test('missing runtime info means no running instance', async () => {
  const temp = createTempDir();
  const result = await probeInstance({runtimeFile: join(temp.dir, 'absent.json'), lockPid: 1});
  assert.equal(result.running, false);
  assert.equal(result.reason, 'no-runtime-info');
  temp.cleanup();
});
