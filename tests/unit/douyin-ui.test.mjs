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
  assert.ok(douyinKeys.length >= 90, `expected the full Douyin key set, got ${douyinKeys.length}`);
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

test('the live page wires the browser login flow and never paints platform text as HTML', () => {
  const source = readFileSync('src/web/js/pages/live.js', 'utf8');
  assert.match(source, /live\.source\.douyinTab/);
  assert.match(source, /buildDouyinPanel/);
  assert.match(source, /'\/api\/douyin\/room'/);
  assert.match(source, /'\/api\/douyin\/connect'/);
  assert.match(source, /'\/api\/douyin\/login\/browser\/start'/);
  assert.match(source, /'\/api\/douyin\/login\/browser\/status'/);
  assert.match(source, /'\/api\/douyin\/login\/browser\/cancel'/);
  assert.match(source, /'\/api\/douyin\/login\/check'/);
  assert.match(source, /'\/api\/douyin\/login\/cookie'/);
  assert.match(source, /'\/api\/douyin\/login\/logout'/);
  assert.match(source, /douyinCookieStep\$\{index\}/);
  assert.equal(source.includes('/api/douyin/login/qrcode'), false);
  assert.equal(source.includes('/api/douyin/login/poll'), false);
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
    '/api/douyin/login/browser/start',
    '/api/douyin/login/browser/status',
    '/api/douyin/login/browser/cancel',
    '/api/douyin/login/check',
    '/api/douyin/login/logout',
    '/api/douyin/login/cookie'
  ]) {
    assert.ok(routes.includes(path), `missing route ${path}`);
  }
  assert.equal(routes.includes('/api/douyin/login/qrcode'), false);
  assert.equal(routes.includes('/api/douyin/login/poll'), false);
  const index = readFileSync('src/server/index.mjs', 'utf8');
  assert.match(index, /new DouyinService/);
  assert.match(index, /dataDir: paths\.root/);
  assert.match(index, /instance\.douyin\?\.shutdown\(\)/);
});

test('the Cookie help is a complete 12-step tutorial in all three languages', () => {
  for (const locale of LOCALES) {
    for (let index = 1; index <= 12; index += 1) {
      const key = `live.source.douyinCookieStep${index}`;
      const text = flat[locale][key];
      assert.ok(typeof text === 'string' && text.trim().length > 10, `${locale} ${key}`);
    }
    assert.match(flat[locale]['live.source.douyinCookieHelpTitle'], /cookie/i);
    assert.match(flat[locale]['live.source.douyinCookieStep2'], /live\.douyin\.com/);
    assert.match(flat[locale]['live.source.douyinCookieStep4'], /F12/);
    assert.match(flat[locale]['live.source.douyinCookieStep5'], /Network/i);
    assert.match(flat[locale]['live.source.douyinCookieStep8'], /Headers/i);
    assert.match(flat[locale]['live.source.douyinCookieStep9'], /Request Headers/i);
    assert.match(flat[locale]['live.source.douyinCookieStep11'], /sessionid/);
    assert.match(flat[locale]['live.source.douyinCookieHelpBrowserDiff'], /Firefox/);
    assert.match(flat[locale]['live.source.douyinCookieHelpSecurity'], /AES-256-GCM|encrypted|暗号化|加密/);
  }
});

test('login states and gift verification are distinct in the UI copy', () => {
  for (const locale of LOCALES) {
    assert.ok(flat[locale]['live.source.douyinLoginStateSavedUnverified']);
    assert.ok(flat[locale]['live.source.douyinLoginStateExpired']);
    assert.ok(flat[locale]['live.source.douyinLoginStateBlocked']);
    assert.ok(flat[locale]['live.source.douyinGiftStep1']);
    assert.ok(flat[locale]['live.source.douyinGiftStep4']);
    assert.match(flat[locale]['live.source.douyinGiftLadderNote'], /未观测|未観測|not observed/i);
    assert.ok(flat[locale]['errors.douyinCookieFormat']);
    assert.ok(flat[locale]['errors.douyinCookieIncomplete']);
    assert.ok(flat[locale]['errors.douyinBrowserUnavailable']);
  }
});

test('monitoring knows Douyin as a first-class platform', () => {
  const constants = readFileSync('src/monitoring/constants.mjs', 'utf8');
  assert.match(constants, /'bilibili', 'youtube', 'twitch', 'douyin'/);
  assert.match(constants, /douyin: Object\.freeze/);
  const manager = readFileSync('src/monitoring/manager.mjs', 'utf8');
  assert.match(manager, /DouyinRoomDetector/);
  assert.match(manager, /row\.platform === 'douyin'/);
});

test('the Windows build requires the browser-login and Douyin modules', () => {
  const build = readFileSync('scripts/build-windows.mjs', 'utf8');
  for (const module of [
    'src/platforms/douyin/adapter.mjs',
    'src/platforms/douyin/browser-login.mjs',
    'src/platforms/douyin/messages.mjs',
    'src/platforms/douyin/protobuf.mjs',
    'src/platforms/douyin/sign.mjs',
    'src/platforms/douyin/vendor/sign.js',
    'src/monitoring/detectors/douyin.mjs'
  ]) {
    assert.ok(build.includes(module), `build is missing ${module}`);
  }
});
