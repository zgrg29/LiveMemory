import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {buildBrowserArgs, decodeFramePayload, parseDevToolsActivePort, findBrowserExecutable} from '../../src/platforms/tiktok/browser-relay.mjs';
import {chatMessage, webcastResponse} from '../helpers/tiktok-frames.mjs';
import {SettingsStore, normalizeSettings, SETTINGS_KEYS} from '../../src/server/settings-store.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const routesSource = read('src/server/routes.mjs');
const buildSource = read('scripts/build-windows.mjs');
const dictionaries = {
  en: JSON.parse(read('src/web/i18n/en.json')),
  ja: JSON.parse(read('src/web/i18n/ja.json')),
  'zh-CN': JSON.parse(read('src/web/i18n/zh-CN.json'))
};

function leafKeys(value, prefix = '') {
  const keys = [];
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) keys.push(...leafKeys(entry, path));
    else keys.push(path);
  }
  return keys;
}

test('the live page exposes a TikTok tab and uses every TikTok API route', () => {
  assert.match(liveSource, /tiktokTab/);
  assert.match(liveSource, /buildTikTokPanel/);
  assert.match(liveSource, /\/api\/tiktok\/status/);
  assert.match(liveSource, /\/api\/tiktok\/room/);
  assert.match(liveSource, /\/api\/tiktok\/connect/);
  assert.match(liveSource, /\/api\/tiktok\/transport/);
  assert.match(liveSource, /\/api\/tiktok\/retention\/apply/);
  assert.match(liveSource, /tiktokAutoMonitor/);
  assert.match(liveSource, /checkedTikTok/);
  assert.doesNotMatch(liveSource, /innerHTML/);
});

test('the TikTok panel states the trade-offs instead of hiding them', () => {
  assert.match(liveSource, /live\.source\.tiktokSignerNote/);
  assert.match(liveSource, /live\.source\.tiktokBrowserNote/);
  assert.match(liveSource, /live\.source\.tiktokNoPaidPlan/);
  assert.match(liveSource, /live\.source\.tiktokGiftNote/);
  assert.match(liveSource, /live\.source\.tiktokCapabilityNote/);
});

test('all three locales carry the same TikTok UI and error keys', () => {
  const required = [
    'common.platform.tiktok',
    'live.source.tiktokTab',
    'live.source.tiktokIntro',
    'live.source.tiktokCheck',
    'live.source.tiktokStart',
    'live.source.tiktokTransportTitle',
    'live.source.tiktokTransportAuto',
    'live.source.tiktokTransportSigner',
    'live.source.tiktokTransportBrowser',
    'live.source.tiktokSignerNote',
    'live.source.tiktokBrowserNote',
    'live.source.tiktokMetadataNote',
    'live.source.tiktokIdentityNote',
    'live.source.tiktokGiftNote',
    'live.source.tiktokCapabilityNote',
    'live.source.tiktokNoPaidPlan',
    'live.source.tiktokPolicyTitle',
    'errors.tiktokLinkInvalid',
    'errors.tiktokRoomNotFound',
    'errors.tiktokRoomOffline',
    'errors.tiktokLoginRequired',
    'errors.tiktokRateLimit',
    'errors.tiktokNetwork',
    'errors.tiktokProtocol',
    'errors.tiktokSignerUnavailable',
    'errors.tiktokSignerPremiumRequired',
    'errors.tiktokBrowserUnavailable',
    'errors.tiktokError',
    'monitoring.add.tiktokPlaceholder',
    'monitoring.add.tiktokLabel'
  ];
  const keys = Object.fromEntries(Object.entries(dictionaries).map(([locale, dict]) => [locale, new Set(leafKeys(dict))]));
  const sets = Object.values(keys);
  for (const locale of Object.keys(dictionaries)) {
    for (const key of required) {
      assert.ok(keys[locale].has(key), `${locale} is missing ${key}`);
    }
  }
  // The three dictionaries must stay identical in shape.
  const reference = [...sets[0]].sort();
  for (const set of sets.slice(1)) {
    assert.deepEqual([...set].sort(), reference);
  }
});

test('the TikTok HTTP routes and Windows build modules are present', () => {
  for (const route of [
    '/api/tiktok/status',
    '/api/tiktok/transport',
    '/api/tiktok/room',
    '/api/tiktok/connect',
    '/api/tiktok/disconnect',
    '/api/tiktok/retention/apply'
  ]) {
    assert.ok(routesSource.includes(route), route);
  }
  for (const module of [
    'src/platforms/tiktok/adapter.mjs',
    'src/platforms/tiktok/browser-relay.mjs',
    'src/platforms/tiktok/client.mjs',
    'src/platforms/tiktok/link.mjs',
    'src/platforms/tiktok/messages.mjs',
    'src/platforms/tiktok/protobuf.mjs',
    'src/platforms/tiktok/service.mjs',
    'src/platforms/tiktok/signer.mjs',
    'src/platforms/tiktok/transports.mjs',
    'src/monitoring/detectors/tiktok.mjs'
  ]) {
    assert.ok(buildSource.includes(module), module);
  }
});

test('the browser relay launches a dedicated profile and never disables browser security', () => {
  const args = buildBrowserArgs({profileDir: 'C:\\tmp\\lm-profile', liveUrl: 'https://www.tiktok.com/@creator/live'});
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.ok(args.includes('https://www.tiktok.com/@creator/live'));
  assert.equal(args.some((arg) => arg === '--no-sandbox' || arg === '--disable-web-security'), false);
  assert.deepEqual(parseDevToolsActivePort('12345\n/devtools/browser/abc\n'), {port: 12345, wsPath: '/devtools/browser/abc'});
  assert.equal(parseDevToolsActivePort('0\n/devtools/browser/abc'), null);
  assert.equal(parseDevToolsActivePort('12345\n/nope'), null);
});

test('a browser relay frame is gzip protobuf and decodes to real message payloads', () => {
  const payload = webcastResponse({messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: '55'}), msgId: 55n}]});
  const gz = gzipSync(payload);
  const decoded = decodeFramePayload(gz.toString('base64'));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].method, 'WebcastChatMessage');
  const raw = decodeFramePayload(payload.toString('base64'));
  assert.equal(raw.length, 1);
  assert.deepEqual(decodeFramePayload(''), []);
  assert.deepEqual(decodeFramePayload(Buffer.from('not protobuf').toString('base64')), []);
});

test('a browser executable is only accepted from known install paths', () => {
  const found = findBrowserExecutable({platform: 'win32', env: {ProgramFiles: 'C:\\Program Files'}, fileExists: (path) => path.endsWith('chrome.exe')});
  assert.ok(found.endsWith('chrome.exe'));
  const missing = findBrowserExecutable({platform: 'win32', env: {}, fileExists: () => false});
  assert.equal(missing, null);
});

test('the TikTok transport preference is validated and persisted', () => {
  assert.ok(SETTINGS_KEYS.includes('tiktokTransport'));
  assert.equal(normalizeSettings({}).tiktokTransport, 'auto');
  assert.equal(normalizeSettings({tiktokTransport: 'browser'}).tiktokTransport, 'browser');
  assert.equal(normalizeSettings({tiktokTransport: 'nope'}).tiktokTransport, 'auto');
  const temp = createTempDir('tiktok-settings-');
  try {
    const store = new SettingsStore({file: new URL('settings.json', `file:///${temp.dir.replace(/\\/g, '/')}/`).pathname.replace(/^\//, '')});
    store.load();
    assert.equal(store.get().tiktokTransport, 'auto');
    const updated = store.update({tiktokTransport: 'signer'});
    assert.equal(updated.tiktokTransport, 'signer');
    assert.throws(() => store.update({tiktokTransport: 'paid'}), (error) => error.code === 'SETTINGS_INVALID');
  } finally {
    temp.cleanup();
  }
});
