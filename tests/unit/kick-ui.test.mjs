import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const routesSource = read('src/server/routes.mjs');
const buildSource = read('scripts/build-windows.mjs');
const locales = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

const KICK_SOURCE_KEYS = [
  'live.source.kickTab',
  'live.source.kickIntro',
  'live.source.kickNoLoginNote',
  'live.source.kickUnofficialNote',
  'live.source.kickLinkLabel',
  'live.source.kickLinkPlaceholder',
  'live.source.kickChatroom',
  'live.source.kickCaptureTitle',
  'live.source.kickActiveTitle',
  'live.source.kickTokenRefreshes',
  'live.source.kickCaptureNotCompleteNote',
  'live.source.kickPolicyBody'
];

const KICK_ERROR_KEYS = [
  'errors.kickLinkInvalid',
  'errors.kickRoomNotFound',
  'errors.kickRoomOffline',
  'errors.kickBlocked',
  'errors.kickRateLimit',
  'errors.kickNetwork',
  'errors.kickProtocol',
  'errors.kickConnectTimeout',
  'errors.kickSocketFailed',
  'errors.kickNotConfigured',
  'errors.kickStopped',
  'errors.kickError'
];

function get(dict, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), dict);
}

test('the live page has a Kick tab and a single no-login capture panel', () => {
  assert.match(liveSource, /kickTab/);
  assert.match(liveSource, /buildKickPanel/);
  assert.match(liveSource, /\/api\/kick\/status/);
  assert.match(liveSource, /\/api\/kick\/room/);
  assert.match(liveSource, /\/api\/kick\/connect/);
  assert.match(liveSource, /\/api\/kick\/disconnect/);
  assert.match(liveSource, /\/api\/kick\/retention\/apply/);
  assert.match(liveSource, /checkedKick/);
  assert.match(liveSource, /kickCaptureCard/);
  assert.match(liveSource, /kickTokenRefreshes/);
  assert.match(liveSource, /kickReasonText/);
  assert.match(liveSource, /kickAutoMonitor/);
});

test('the Kick panel offers the shared live monitor with translated inputs', () => {
  for (const locale of locales) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    assert.equal(typeof dict.monitoring.add.kickPlaceholder, 'string', `${locale} placeholder`);
    assert.equal(typeof dict.monitoring.add.kickLabel, 'string', `${locale} label`);
  }
  assert.match(liveSource, /autoMonitorToggle\('kick'/);
  assert.match(liveSource, /buildAutoMonitorSection\('kick'\)/);
});

test('the server registers Kick routes, capabilities and the unofficial flag', () => {
  assert.match(routesSource, /path: '\/api\/kick\/status'/);
  assert.match(routesSource, /path: '\/api\/kick\/room'/);
  assert.match(routesSource, /path: '\/api\/kick\/connect'/);
  assert.match(routesSource, /path: '\/api\/kick\/disconnect'/);
  assert.match(routesSource, /id: 'kick'/);
  assert.match(routesSource, /mode: 'anonymous-centrifugo'/);
  assert.match(routesSource, /unofficial: true/);
});

test('every shipped dictionary has the Kick UI and error keys', () => {
  for (const locale of locales) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    for (const key of [...KICK_SOURCE_KEYS, ...KICK_ERROR_KEYS]) {
      const value = get(dict, key);
      assert.equal(typeof value, 'string', `${locale} ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
    }
    assert.equal(get(dict, 'common.platform.kick'), 'Kick', `${locale} platform label`);
  }
});

test('the Windows build requires the Kick modules so the EXE cannot silently miss them', () => {
  for (const module of [
    'src/platforms/kick/adapter.mjs',
    'src/platforms/kick/errors.mjs',
    'src/platforms/kick/http.mjs',
    'src/platforms/kick/link.mjs',
    'src/platforms/kick/messages.mjs',
    'src/platforms/kick/service.mjs',
    'src/platforms/kick/transport.mjs',
    'src/monitoring/detectors/kick.mjs'
  ]) {
    assert.ok(buildSource.includes(module), `build requires ${module}`);
  }
});
