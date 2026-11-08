import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';

const require = createRequire(import.meta.url);
const bootstrap = require('../../scripts/sea-bootstrap.cjs');

test('bootstrap module does not run itself outside a SEA binary', () => {
  assert.equal(typeof bootstrap.ensureAppRoot, 'function');
  assert.equal(typeof bootstrap.markerMatches, 'function');
});

test('extraction candidates always stay inside per-user folders', () => {
  const candidates = bootstrap.appRootCandidates({
    home: 'C:/Users/Test/AppData/Local/LiveMemory',
    hash: 'abc123',
    temp: 'C:/Users/Test/AppData/Local/Temp',
    env: {}
  });
  assert.equal(candidates[0], join('C:/Users/Test/AppData/Local/LiveMemory', 'app', 'abc123'));
  for (const candidate of candidates) {
    assert.ok(candidate.includes('app'));
    assert.equal(candidate.includes('Program Files'), false);
  }
});

test('a completed extraction is reused only when the marker matches every file', () => {
  const temp = createTempDir();
  const root = join(temp.dir, 'app');
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'a.mjs'), 'a');
  const manifest = {hash: 'h1', files: ['src/a.mjs']};
  const good = {hash: 'h1', files: 1};
  assert.equal(bootstrap.markerMatches(good, manifest, {root}), true);
  assert.equal(bootstrap.markerMatches({hash: 'h2', files: 1}, manifest, {root}), false);
  assert.equal(bootstrap.markerMatches({hash: 'h1', files: 2}, manifest, {root}), false);
  writeFileSync(join(root, 'src', 'a.mjs'), 'a');
  const missing = {hash: 'h1', files: 1};
  const otherManifest = {hash: 'h1', files: ['src/missing.mjs']};
  assert.equal(bootstrap.markerMatches(missing, otherManifest, {root}), false);
  temp.cleanup();
});

test('extraction writes a marker and is safe to repeat', async () => {
  const temp = createTempDir();
  const target = join(temp.dir, 'app', 'hash');
  const assets = new Map([
    ['manifest', 'x'],
    ['src/a.mjs', 'export const a = 1;'],
    ['src/web/index.html', '<!doctype html><title>LiveMemory</title>']
  ]);
  const manifest = {hash: 'hash', version: '0.1.0', files: ['src/a.mjs', 'src/web/index.html']};
  const getAsset = (name) => {
    if (!assets.has(name)) throw new Error(`missing asset ${name}`);
    return Buffer.from(assets.get(name));
  };
  await bootstrap.extractAtomically({target, manifest, getAsset});
  assert.ok(existsSync(join(target, 'src', 'a.mjs')));
  assert.ok(existsSync(join(target, 'src', 'web', 'index.html')));
  const marker = bootstrap.readMarker(target);
  assert.equal(marker.hash, 'hash');
  assert.equal(marker.files, 2);
  await bootstrap.extractAtomically({target, manifest, getAsset});
  assert.ok(existsSync(join(target, 'src', 'a.mjs')));
  temp.cleanup();
});

test('extraction rejects path traversal inside the manifest', async () => {
  const temp = createTempDir();
  const target = join(temp.dir, 'app', 'hash');
  await assert.rejects(
    bootstrap.extractAtomically({
      target,
      manifest: {hash: 'h', files: ['../escape.mjs']},
      getAsset: () => Buffer.from('x')
    }),
    /unsafe asset path/
  );
  temp.cleanup();
});

test('the failure text is localised and mentions the log file', () => {
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const text = bootstrap.buildFatalText({
      locale,
      error: Object.assign(new Error('disk on fire'), {code: 'EIO'}),
      logFile: 'C:/logs/bootstrap.log',
      step: 'app-root.extract',
      dataDir: 'C:/data',
      appRoot: null
    });
    assert.ok(text.includes('C:/logs/bootstrap.log'));
    assert.ok(text.includes('EIO'));
    assert.ok(text.includes('app-root.extract'));
    assert.ok(text.includes(bootstrap.MESSAGES[locale].title));
  }
});

test('locale selection prefers env, then saved settings, then the OS locale', () => {
  assert.equal(bootstrap.pickLocale({env: {LIVE_MEMORY_LANG: 'ja'}}), 'ja');
  assert.equal(bootstrap.pickLocale({env: {}, settingsText: JSON.stringify({locale: 'en'})}), 'en');
  assert.equal(bootstrap.pickLocale({env: {}, settingsText: 'not json', intlLocale: 'zh-CN'}), 'zh-CN');
  assert.equal(bootstrap.pickLocale({env: {}, intlLocale: 'de-DE'}), 'en');
});
