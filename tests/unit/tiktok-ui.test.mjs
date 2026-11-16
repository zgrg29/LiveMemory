import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SettingsStore, normalizeSettings, SETTINGS_KEYS} from '../../src/server/settings-store.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const routesSource = read('src/server/routes.mjs');
const buildSource = read('scripts/build-windows.mjs');
const settingsSource = read('src/server/settings-store.mjs');
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

test('the TikTok panel is a single no-login capture flow', () => {
  assert.match(liveSource, /tiktokTab/);
  assert.match(liveSource, /buildTikTokPanel/);
  assert.match(liveSource, /\/api\/tiktok\/status/);
  assert.match(liveSource, /\/api\/tiktok\/room/);
  assert.match(liveSource, /\/api\/tiktok\/connect/);
  assert.match(liveSource, /\/api\/tiktok\/disconnect/);
  assert.match(liveSource, /\/api\/tiktok\/retention\/apply/);
  assert.match(liveSource, /tiktokAutoMonitor/);
  assert.match(liveSource, /checkedTikTok/);
  assert.match(liveSource, /tiktokStateSummary/);
  assert.match(liveSource, /tiktokErrorText/);

  // The retired browser relay, login and channel picker must be gone from the
  // user-facing page: no login routes, no transport switch, no login wording.
  assert.doesNotMatch(liveSource, /\/api\/tiktok\/login\//);
  assert.doesNotMatch(liveSource, /\/api\/tiktok\/transport/);
  assert.doesNotMatch(liveSource, /tiktokLogin/);
  assert.doesNotMatch(liveSource, /tiktokTransport/);
  assert.doesNotMatch(liveSource, /tiktokVerifyResult/);
  assert.doesNotMatch(liveSource, /innerHTML/);
});

test('the TikTok panel states the trade-offs instead of hiding them', () => {
  assert.match(liveSource, /live\.source\.tiktokUnofficialNote/);
  assert.match(liveSource, /live\.source\.tiktokNoLoginNote/);
  assert.match(liveSource, /live\.source\.tiktokNoPaidPlan/);
  assert.match(liveSource, /live\.source\.tiktokGiftNote/);
  assert.match(liveSource, /live\.source\.tiktokCapabilityNote/);
  assert.match(liveSource, /live\.source\.tiktokCaptureNotCompleteNote/);
});

test('the TikTok panel keeps room, connection, events and recording separate', () => {
  // Four distinct rows, each fed by its own source of truth.
  assert.match(liveSource, /live\.source\.tiktokVerificationRoom/);
  assert.match(liveSource, /live\.source\.tiktokVerificationConnection/);
  assert.match(liveSource, /live\.source\.tiktokVerificationEvents/);
  assert.match(liveSource, /live\.source\.tiktokVerificationRecording/);
  // "Recording" is only reported when a session exists ...
  assert.match(liveSource, /const recording = tiktokActiveRecording\(\)/);
  assert.match(liveSource, /live\.source\.tiktokStateRecordingOff/);
  // ... and events are counted from decoded messages, not from frames.
  assert.match(liveSource, /counters\.chats/);
  assert.match(liveSource, /counters\.gifts/);
});

test('all three locales carry the same TikTok UI and error keys', () => {
  const required = [
    'common.platform.tiktok',
    'live.source.tiktokTab',
    'live.source.tiktokIntro',
    'live.source.tiktokNoLoginNote',
    'live.source.tiktokUnofficialNote',
    'live.source.tiktokCheck',
    'live.source.tiktokStart',
    'live.source.tiktokStop',
    'live.source.tiktokStopped',
    'live.source.tiktokAlreadyRecording',
    'live.source.tiktokMetadataNote',
    'live.source.tiktokIdentityNote',
    'live.source.tiktokGiftNote',
    'live.source.tiktokCapabilityNote',
    'live.source.tiktokNoPaidPlan',
    'live.source.tiktokPolicyTitle',
    'live.source.tiktokPolicyBody',
    'live.source.tiktokApplyRetention',
    'live.source.tiktokVerificationTitle',
    'live.source.tiktokVerificationRoom',
    'live.source.tiktokVerificationConnection',
    'live.source.tiktokVerificationEvents',
    'live.source.tiktokVerificationRecording',
    'live.source.tiktokVerificationEventsCount',
    'live.source.tiktokVerificationNoEvents',
    'live.source.tiktokStateRoomChecked',
    'live.source.tiktokStateRoomNotChecked',
    'live.source.tiktokStateConnected',
    'live.source.tiktokStateNotConnected',
    'live.source.tiktokStateRecordingOn',
    'live.source.tiktokStateRecordingOff',
    'live.source.tiktokStateRecordingFailed',
    'live.source.tiktokStateRecordingReconnecting',
    'live.source.tiktokStateRecordingUnconfirmed',
    'live.source.tiktokCaptureTitle',
    'live.source.tiktokCaptureStateConnected',
    'live.source.tiktokCaptureStateWaitingEvents',
    'live.source.tiktokCaptureStateRateLimited',
    'live.source.tiktokCaptureStateNeedsAction',
    'live.source.tiktokCaptureStateIdle',
    'live.source.tiktokCaptureLastMessage',
    'live.source.tiktokCaptureReconnects',
    'live.source.tiktokCaptureLastFailure',
    'live.source.tiktokCapturePossibleGap',
    'live.source.tiktokCaptureTechnical',
    'live.source.tiktokTechnicalProtocol',
    'live.source.tiktokTechnicalFrames',
    'live.source.tiktokTechnicalExtras',
    'live.source.tiktokReasonSocket',
    'live.source.tiktokReasonRoomOffline',
    'live.source.tiktokReasonRoomChanged',
    'live.source.tiktokReasonNotConfigured',
    'live.source.tiktokReasonIdle',
    'live.source.tiktokErrorReasonDetail',
    'errors.tiktokLinkInvalid',
    'errors.tiktokRoomNotFound',
    'errors.tiktokRoomOffline',
    'errors.tiktokRateLimit',
    'errors.tiktokNetwork',
    'errors.tiktokProtocol',
    'errors.tiktokConnectTimeout',
    'errors.tiktokSocketFailed',
    'errors.tiktokNotConfigured',
    'errors.tiktokStopped',
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
    // Removed transports must not leave dead strings behind.
    for (const removed of ['live.source.tiktokLoginTitle', 'live.source.tiktokTransportAuto', 'errors.tiktokLoginRequired', 'errors.tiktokSignerUnavailable', 'errors.tiktokBrowserUnavailable']) {
      assert.equal(keys[locale].has(removed), false, `${locale} still has ${removed}`);
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

test('the TikTok HTTP routes and Windows build modules match the unified capture', () => {
  for (const route of [
    '/api/tiktok/status',
    '/api/tiktok/room',
    '/api/tiktok/connect',
    '/api/tiktok/disconnect',
    '/api/tiktok/retention/apply'
  ]) {
    assert.ok(routesSource.includes(route), route);
  }
  for (const removed of ['/api/tiktok/login/status', '/api/tiktok/login/start', '/api/tiktok/login/verify', '/api/tiktok/login/cancel', '/api/tiktok/login/logout', '/api/tiktok/transport']) {
    assert.equal(routesSource.includes(removed), false, `${removed} must be gone`);
  }
  for (const module of [
    'src/platforms/tiktok/client.mjs',
    'src/platforms/tiktok/errors.mjs',
    'src/platforms/tiktok/legacy-cleanup.mjs',
    'src/platforms/tiktok/link.mjs',
    'src/platforms/tiktok/local-adapter.mjs',
    'src/platforms/tiktok/messages.mjs',
    'src/platforms/tiktok/protobuf.mjs',
    'src/platforms/tiktok/service.mjs',
    'src/platforms/tiktok/state.mjs',
    'src/platforms/tiktok/webcast.mjs',
    'src/monitoring/detectors/tiktok.mjs'
  ]) {
    assert.ok(buildSource.includes(module), module);
  }
  for (const removed of ['tiktok/browser-relay.mjs', 'tiktok/browser-login.mjs', 'tiktok/browser-launch.mjs', 'tiktok/signer.mjs', 'tiktok/rate-budget.mjs', 'tiktok/transports.mjs', 'tiktok/adapter.mjs']) {
    assert.equal(buildSource.includes(removed), false, `${removed} must not be packaged`);
  }
});

test('the TikTok channel preference is gone instead of silently ignored', () => {
  assert.equal(SETTINGS_KEYS.includes('tiktokTransport'), false);
  assert.equal(typeof normalizeSettings({}).tiktokTransport, 'undefined');
  assert.doesNotMatch(settingsSource, /tiktokTransport/);
  const temp = createTempDir('tiktok-settings-');
  try {
    const file = `${temp.dir}\\settings.json`;
    const store = new SettingsStore({file});
    store.load();
    assert.equal(typeof store.get().tiktokTransport, 'undefined');
    // A stale client that still sends the removed field must be rejected, not
    // silently accepted as another channel choice.
    assert.throws(() => store.update({tiktokTransport: 'browser'}), (error) => error.code === 'SETTINGS_INVALID');
    assert.equal(typeof store.get().tiktokTransport, 'undefined');
  } finally {
    temp.cleanup();
  }
});
