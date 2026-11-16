import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {BrowserSession, buildBrowserArgs, decodeFramePayload, parseDevToolsActivePort, findBrowserExecutable} from '../../src/platforms/tiktok/browser-relay.mjs';
import {chatMessage, fetchResult, pushFrame, webcastResponse} from '../helpers/tiktok-frames.mjs';
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
  assert.match(liveSource, /\/api\/tiktok\/login\/status/);
  assert.match(liveSource, /\/api\/tiktok\/login\/start/);
  assert.match(liveSource, /\/api\/tiktok\/login\/verify/);
  assert.match(liveSource, /\/api\/tiktok\/login\/cancel/);
  assert.match(liveSource, /\/api\/tiktok\/login\/logout/);
  assert.match(liveSource, /\/api\/tiktok\/room/);
  assert.match(liveSource, /\/api\/tiktok\/connect/);
  assert.match(liveSource, /\/api\/tiktok\/transport/);
  assert.match(liveSource, /\/api\/tiktok\/retention\/apply/);
  assert.match(liveSource, /tiktokAutoMonitor/);
  assert.match(liveSource, /checkedTikTok/);
  assert.match(liveSource, /tiktokVerificationSummary/);
  assert.match(liveSource, /tiktokVerifyResultBlock/);
  assert.match(liveSource, /tiktokErrorText/);
  assert.match(liveSource, /tiktokLoginWindowClosedCapture/);
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
    'live.source.tiktokLoginTitle',
    'live.source.tiktokLoginOpen',
    'live.source.tiktokLoginVerify',
    'live.source.tiktokLoginCancel',
    'live.source.tiktokLoginStateIdle',
    'live.source.tiktokLoginStateWaiting',
    'live.source.tiktokLoginStateVerifying',
    'live.source.tiktokLoginStateLoggedIn',
    'live.source.tiktokLoginStateExpired',
    'live.source.tiktokLoginStateRefused',
    'live.source.tiktokLoginStateUnavailable',
    'live.source.tiktokLoginVerifyNeedsRoom',
    'live.source.tiktokLoginVerifyResultTitle',
    'live.source.tiktokLoginVerifyEvents',
    'live.source.tiktokLoginVerifyRoomEnter',
    'live.source.tiktokLoginVerifyCheckedAt',
    'live.source.tiktokLoginVerifyReason',
    'live.source.tiktokLoginCaptureNeedsRoom',
    'live.source.tiktokLoginCaptureError',
    'live.source.tiktokLoginRevalidation',
    'live.source.tiktokLoginWindowClosedCapture',
    'live.source.tiktokLoginLogoutBusy',
    'live.source.tiktokVerificationTitle',
    'live.source.tiktokVerificationAccount',
    'live.source.tiktokVerificationRoom',
    'live.source.tiktokVerificationConnection',
    'live.source.tiktokVerificationEvents',
    'live.source.tiktokVerificationRecording',
    'live.source.tiktokVerificationNotChecked',
    'live.source.tiktokVerificationNotConnected',
    'live.source.tiktokVerificationNoEvents',
    'live.source.tiktokVerificationEventsCount',
    'live.source.tiktokVerificationNotRecording',
    'live.source.tiktokVerificationRecordingActive',
    'live.source.tiktokReasonRoomEnter403',
    'live.source.tiktokReasonNoSessionCookie',
    'live.source.tiktokReasonBrowserClosed',
    'live.source.tiktokReasonUniqueIdRequired',
    'live.source.tiktokReasonSessionExpired',
    'live.source.tiktokReasonCaptureActive',
    'live.source.tiktokReasonBrowserDidNotStart',
    'live.source.tiktokReasonPageTarget',
    'live.source.tiktokReasonPageClosed',
    'live.source.tiktokReasonNavigateFailed',
    'live.source.tiktokReasonProfileNotOwned',
    'live.source.tiktokReasonLaunchFailed',
    'live.source.tiktokReasonLoginInProgress',
    'live.source.tiktokErrorReasonDetail',
    'live.source.tiktokCaptureTitle',
    'live.source.tiktokCaptureStateConnected',
    'live.source.tiktokCaptureStateRateLimited',
    'live.source.tiktokCaptureStateNeedsAction',
    'live.source.tiktokCaptureStateIdle',
    'live.source.tiktokCaptureStateRoomRefused',
    'live.source.tiktokCaptureStateRoomUnconfirmed',
    'live.source.tiktokCaptureRoomUnconfirmed',
    'live.source.tiktokCaptureRoomRefusedButEvents',
    'live.source.tiktokLoginRoomAccessRefused',
    'live.source.tiktokLoginCaptureRoomUnconfirmed',
    'live.source.tiktokVerificationRecordingFailed',
    'live.source.tiktokVerificationRecordingUnconfirmed',
    'live.source.tiktokVerificationRecordingNotStartedFailed',
    'errors.tiktokRoomRefused',
    'live.source.tiktokCaptureLastMessage',
    'live.source.tiktokCaptureReconnects',
    'live.source.tiktokCaptureLastFailure',
    'live.source.tiktokCapturePossibleGap',
    'live.tabs.stateRateLimited',
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

test('every literal TikTok UI key used by the live page exists in all three locales', () => {
  const used = new Set();
  for (const match of liveSource.matchAll(/['"]((?:live\.source|errors)\.tiktok[A-Za-z0-9_.]+)['"]/g)) used.add(match[1]);
  assert.ok(used.has('live.source.tiktokCaptureStateIdle'), 'the idle capture key is actually referenced');
  for (const locale of Object.keys(dictionaries)) {
    const keys = new Set(leafKeys(dictionaries[locale]));
    for (const key of used) assert.ok(keys.has(key), `${locale} is missing ${key}`);
  }
});

test('the TikTok HTTP routes and Windows build modules are present', () => {
  for (const route of [
    '/api/tiktok/status',
    '/api/tiktok/login/status',
    '/api/tiktok/login/start',
    '/api/tiktok/login/verify',
    '/api/tiktok/login/cancel',
    '/api/tiktok/login/logout',
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
    'src/platforms/tiktok/browser-launch.mjs',
    'src/platforms/tiktok/browser-login.mjs',
    'src/platforms/tiktok/browser-relay.mjs',
    'src/platforms/tiktok/client.mjs',
    'src/platforms/tiktok/link.mjs',
    'src/platforms/tiktok/messages.mjs',
    'src/platforms/tiktok/protobuf.mjs',
    'src/platforms/tiktok/rate-budget.mjs',
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

test('a real PushFrame envelope is decoded instead of treating it as a batch', () => {
  const batch = fetchResult({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'p-1', content: 'push frame'}), msgId: 901n}]
  });
  const gz = gzipSync(batch);
  const frame = pushFrame({payload: gz, logId: 42n});
  const decoded = decodeFramePayload(frame.toString('base64'));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].method, 'WebcastChatMessage');
  assert.equal(decoded[0].envelopeMsgId, '901');
  // Non-event control frames must be ignored, not parsed as an empty batch.
  assert.deepEqual(decodeFramePayload(pushFrame({payloadType: 'hb', payload: Buffer.from([0x08, 0x01])}).toString('base64')), []);
  assert.deepEqual(decodeFramePayload(pushFrame({payloadType: 'ack', payload: Buffer.from('-')}).toString('base64')), []);
  // Uncompressed payloads are accepted too.
  const raw = decodeFramePayload(pushFrame({payload: batch}).toString('base64'));
  assert.equal(raw.length, 1);
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

test('the browser session waits for frames after a room-entry 403 instead of failing immediately', async () => {
  const session = new BrowserSession({refusedGraceMs: 10, loginWaitMs: 500, now: Date.now});
  session.cdp = {closed: false};
  session.closed = false;
  session.roomEnterStatus = 403;
  session.roomEnterAt = Date.now() - 100;
  const refused = await session.waitForReady({timeoutMs: 300});
  assert.equal(refused.roomRefused, true);
  assert.equal(refused.loginRequired, false, 'a room 403 is not a login failure');
  assert.equal(refused.events, 0);

  session.decodedCount = 2;
  const withEvents = await session.waitForReady({timeoutMs: 50});
  assert.equal(withEvents.roomRefused, true, 'the warning is preserved');
  assert.equal(withEvents.events, 2, 'real frames win over the HTTP refusal');

  session.roomEnterStatus = 200;
  session.decodedCount = 0;
  const roomOk = await session.waitForReady({timeoutMs: 50});
  assert.equal(roomOk.roomRefused, false);
  assert.equal(roomOk.roomEnterStatus, 200);
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
