import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  buildSummary,
  describeBuild,
  readBuildInfo,
  readGitCommit
} from '../../src/shared/build-info.mjs';

test('development runs read the Git commit without spawning git', () => {
  const commit = readGitCommit();
  assert.match(String(commit), /^[0-9a-f]{7,64}$/i);
});

test('packaged build identity prefers the verified bootstrap environment', () => {
  const info = readBuildInfo({
    env: {
      LIVE_MEMORY_APP_ROOT: 'C:/app/hash',
      LIVE_MEMORY_BUILD_ID: 'abc1234.12345678',
      LIVE_MEMORY_BUILD_COMMIT: 'abc1234567890',
      LIVE_MEMORY_BUILD_SHORT: 'abc1234',
      LIVE_MEMORY_BUILD_VERSION: '0.13.2',
      LIVE_MEMORY_BUILD_TIME: '2026-11-12T08:00:00.000Z',
      LIVE_MEMORY_BUILD_SOURCE_HASH: '12345678deadbeef',
      LIVE_MEMORY_ASSET_HASH: 'asset123',
      LIVE_MEMORY_BUILD_VERIFY: 'ok'
    }
  });
  assert.equal(info.mode, 'packaged');
  assert.equal(info.buildId, 'abc1234.12345678');
  assert.equal(info.commit, 'abc1234567890');
  assert.equal(info.version, '0.13.2');
  assert.equal(info.verified, true);
  assert.match(describeBuild(info), /abc1234/);
  assert.match(describeBuild(info), /asset123/);
  assert.equal(buildSummary(info).appRoot, undefined);
});

test('a packaged build-info.json is used when the environment is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-build-info-'));
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({
    version: '0.13.2',
    commit: 'deadbeefcafe',
    shortCommit: 'deadbee',
    builtAt: '2026-11-12T09:00:00.000Z',
    sourceHash: 'sourcehash12345678',
    assetHash: 'assethash',
    buildId: 'deadbee.sourcehash'
  }), 'utf8');
  const info = readBuildInfo({env: {}, appRoot: dir, sourceRoot: dir});
  assert.equal(info.buildId, 'deadbee.sourcehash');
  assert.equal(info.commit, 'deadbeefcafe');
  assert.equal(info.mode, 'packaged');
  assert.equal(info.infoFile, join(dir, 'build-info.json'));
});
