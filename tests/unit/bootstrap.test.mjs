import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {writeFileSync, mkdirSync, existsSync, readFileSync} from 'node:fs';
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

test('the failure text is localised in all ten languages and mentions the log file', () => {
  const codes = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];
  assert.deepEqual(Object.keys(bootstrap.MESSAGES), codes);
  for (const locale of codes) {
    const text = bootstrap.buildFatalText({
      locale,
      error: Object.assign(new Error('disk on fire'), {code: 'EIO'}),
      logFile: 'C:/logs/bootstrap.log',
      step: 'app-root.extract',
      dataDir: 'C:/data',
      appRoot: null
    });
    assert.ok(text.includes('C:/logs/bootstrap.log'), locale);
    assert.ok(text.includes('EIO'), locale);
    assert.ok(text.includes('app-root.extract'), locale);
    for (const key of Object.keys(bootstrap.MESSAGES.en)) {
      assert.equal(typeof bootstrap.MESSAGES[locale][key], 'string', `${locale}.${key}`);
      assert.ok(bootstrap.MESSAGES[locale][key].trim().length > 0, `${locale}.${key} is empty`);
    }
    // Placeholders are identical to the English set in every language.
    const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const key of Object.keys(bootstrap.MESSAGES.en)) {
      assert.equal(placeholders(bootstrap.MESSAGES[locale][key]), placeholders(bootstrap.MESSAGES.en[key]), `${locale}.${key}`);
    }
  }
});

test('bootstrap locale selection understands every shipped language family', () => {
  assert.equal(bootstrap.pickLocale({env: {LIVE_MEMORY_LANG: 'ja'}}), 'ja');
  assert.equal(bootstrap.pickLocale({env: {}, settingsText: JSON.stringify({locale: 'en'})}), 'en');
  assert.equal(bootstrap.pickLocale({env: {}, settingsText: 'not json', intlLocale: 'zh-CN'}), 'zh-CN');
  assert.deepEqual(
    ['de-DE', 'fr-FR', 'ko-KR', 'es-419', 'pt-PT', 'zh-HK', 'zh-Hant', 'id-ID', 'th-TH']
      .map((tag) => bootstrap.pickLocale({env: {}, intlLocale: tag})),
    ['de', 'fr', 'ko', 'es', 'pt-BR', 'zh-TW', 'zh-TW', 'id', 'en']
  );
  assert.equal(bootstrap.normalizeLocale('zh-MO'), 'zh-TW');
  assert.equal(bootstrap.normalizeLocale('in-ID'), 'id');
});

test('a reused extraction with modified files is detected and re-extracted', async () => {
  const temp = createTempDir();
  const target = join(temp.dir, 'app', 'hash');
  const assets = new Map([
    ['src/a.mjs', 'export const a = 1;'],
    ['src/ai/batching/tokens.mjs', 'export const budget = 24000;']
  ]);
  const manifest = {
    hash: 'hash',
    version: '0.13.2',
    files: ['src/a.mjs', 'src/ai/batching/tokens.mjs'],
    fileHashes: {},
    build: {buildId: 'abc1234.12345678', commit: 'abc1234'}
  };
  for (const [name, value] of assets) {
    manifest.fileHashes[name] = createHash('sha256').update(Buffer.from(value)).digest('hex');
  }
  const getAsset = (name) => {
    if (!assets.has(name)) throw new Error(`missing asset ${name}`);
    return Buffer.from(assets.get(name));
  };
  await bootstrap.extractAtomically({target, manifest, getAsset});
  assert.equal(bootstrap.verifyTree(target, manifest).ok, true);
  // Simulate the old build's module surviving in a cache directory.
  writeFileSync(join(target, 'src', 'ai', 'batching', 'tokens.mjs'), 'export const budget = 8000;');
  assert.equal(bootstrap.verifyTree(target, manifest).ok, false);
  const records = [];
  const result = await bootstrap.ensureAppRoot({
    candidates: [target],
    manifest,
    getAsset,
    log: {record: (step, detail) => records.push({step, detail})}
  });
  assert.equal(result.reused, false);
  assert.ok(records.some((entry) => entry.step === 'app-root.stale'));
  assert.equal(
    readFileSync(join(target, 'src', 'ai', 'batching', 'tokens.mjs'), 'utf8'),
    'export const budget = 24000;'
  );
  const marker = bootstrap.readMarker(target);
  assert.equal(marker.buildId, 'abc1234.12345678');
  temp.cleanup();
});
