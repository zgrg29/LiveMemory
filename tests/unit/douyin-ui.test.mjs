import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const LOCALES = ['zh-CN', 'ja', 'en'];
const dictionaries = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  JSON.parse(readFileSync(`src/web/i18n/${locale}.json`, 'utf8'))
]));

function flatten(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

const flat = Object.fromEntries(LOCALES.map((locale) => [locale, flatten(dictionaries[locale])]));
const douyinKeys = Object.keys(flat['zh-CN']).filter((key) => /douyin/i.test(key)).sort();

function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test('all three locales expose the same Douyin keys with no empty strings', () => {
  assert.ok(douyinKeys.length >= 60, `expected the full Douyin key set, got ${douyinKeys.length}`);
  for (const locale of LOCALES) {
    const keys = Object.keys(flat[locale]).filter((key) => /douyin/i.test(key)).sort();
    assert.deepEqual(keys, douyinKeys, `${locale} has a different Douyin key set`);
    for (const key of keys) {
      assert.equal(typeof flat[locale][key], 'string');
      assert.ok(flat[locale][key].trim().length > 0, `${locale} ${key} is empty`);
    }
  }
});

test('Douyin placeholders are identical across locales', () => {
  for (const key of douyinKeys) {
    const expected = placeholders(flat['zh-CN'][key]);
    for (const locale of ['ja', 'en']) {
      assert.deepEqual(placeholders(flat[locale][key]), expected, `${locale} ${key}`);
    }
  }
});

test('the live page exposes a Douyin tab that calls only the Douyin endpoints', () => {
  const source = readFileSync('src/web/js/pages/live.js', 'utf8');
  assert.match(source, /live\.source\.douyinTab/);
  assert.match(source, /buildDouyinPanel/);
  assert.match(source, /'\/api\/douyin\/room'/);
  assert.match(source, /'\/api\/douyin\/connect'/);
  assert.match(source, /'\/api\/douyin\/login\/qrcode'/);
  assert.match(source, /'\/api\/douyin\/login\/poll'/);
  assert.match(source, /'\/api\/douyin\/retention\/apply'/);
  assert.equal(source.includes('innerHTML'), false, 'platform text must never be written as HTML');
});

test('the server wires every Douyin route behind the authenticated API', () => {
  const routes = readFileSync('src/server/routes.mjs', 'utf8');
  for (const path of [
    '/api/douyin/status',
    '/api/douyin/room',
    '/api/douyin/connect',
    '/api/douyin/disconnect',
    '/api/douyin/retention/apply',
    '/api/douyin/login/qrcode',
    '/api/douyin/login/poll',
    '/api/douyin/login/check',
    '/api/douyin/login/logout',
    '/api/douyin/login/cookie'
  ]) {
    assert.ok(routes.includes(path), `missing route ${path}`);
  }
  const index = readFileSync('src/server/index.mjs', 'utf8');
  assert.match(index, /new DouyinService/);
  assert.match(index, /platforms: \['douyin'\]/);
});

test('monitoring knows Douyin as a first-class platform', () => {
  const constants = readFileSync('src/monitoring/constants.mjs', 'utf8');
  assert.match(constants, /'bilibili', 'youtube', 'twitch', 'douyin'/);
  assert.match(constants, /douyin: Object\.freeze/);
  const manager = readFileSync('src/monitoring/manager.mjs', 'utf8');
  assert.match(manager, /DouyinRoomDetector/);
  assert.match(manager, /row\.platform === 'douyin'/);
});

test('the Windows build requires the Douyin modules and the signature asset', () => {
  const build = readFileSync('scripts/build-windows.mjs', 'utf8');
  for (const module of [
    'src/platforms/douyin/adapter.mjs',
    'src/platforms/douyin/messages.mjs',
    'src/platforms/douyin/protobuf.mjs',
    'src/platforms/douyin/sign.mjs',
    'src/platforms/douyin/vendor/sign.js',
    'src/monitoring/detectors/douyin.mjs'
  ]) {
    assert.ok(build.includes(module), `build is missing ${module}`);
  }
});
