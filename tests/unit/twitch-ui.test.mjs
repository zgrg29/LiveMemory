import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const historySource = read('src/web/js/pages/history.js');
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

test('the live page exposes a Twitch source tab and uses every Twitch API route', () => {
  assert.match(liveSource, /twitchTab/);
  assert.match(liveSource, /buildTwitchPanel/);
  assert.match(liveSource, /\/api\/twitch\/status/);
  assert.match(liveSource, /\/api\/twitch\/channel/);
  assert.match(liveSource, /\/api\/twitch\/connect/);
  assert.match(liveSource, /\/api\/twitch\/retention\/apply/);
  assert.match(liveSource, /twitchAutoMonitor/);
  assert.match(liveSource, /checkedTwitch/);
  assert.doesNotMatch(liveSource, /innerHTML/);
});

test('Twitch UI never renders an unknown Bits amount as zero fiat money', () => {
  assert.match(liveSource, /event\.amountDisplay/);
  assert.match(liveSource, /Bits Cheers carry a count, not a fiat amount/);
  assert.match(liveSource, /event\.type === 'super_chat'[\s\S]{0,500}else if \(event\.amountDisplay\)/);
});

test('all three locales carry the same Twitch UI and error keys', () => {
  const required = [
    'common.platform.twitch',
    'live.source.twitchTab',
    'live.source.twitchIntro',
    'live.source.twitchCheck',
    'live.source.twitchStart',
    'live.source.twitchAnonymousNote',
    'live.source.twitchIdentityNote',
    'live.source.twitchMoneyNote',
    'live.source.twitchCapabilityNote',
    'live.source.twitchPolicyTitle',
    'errors.twitchLinkInvalid',
    'errors.twitchChannelNotFound',
    'errors.twitchChannelOffline',
    'errors.twitchChatUnavailable',
    'errors.twitchRateLimit',
    'errors.twitchNetwork',
    'errors.twitchConnectTimeout',
    'errors.twitchError',
    'monitoring.add.twitchPlaceholder',
    'monitoring.add.twitchLabel'
  ];
  const keys = Object.fromEntries(Object.entries(dictionaries).map(([locale, dict]) => [locale, new Set(leafKeys(dict))]));
  for (const locale of Object.keys(dictionaries)) {
    for (const key of required) {
      assert.ok(keys[locale].has(key), `${locale} is missing ${key}`);
    }
  }
});

test('history search accepts the Twitch platform filter', () => {
  assert.match(historySource, /value: 'twitch'/);
  assert.match(read('src/analytics/sessions/history-search.mjs'), /'twitch'/);
});

test('Twitch HTTP routes and Windows build modules are present', () => {
  for (const route of ['/api/twitch/status', '/api/twitch/channel', '/api/twitch/connect', '/api/twitch/disconnect']) {
    assert.ok(routesSource.includes(route), route);
  }
  for (const module of [
    'src/platforms/twitch/adapter.mjs',
    'src/platforms/twitch/client.mjs',
    'src/platforms/twitch/irc.mjs',
    'src/platforms/twitch/link.mjs',
    'src/platforms/twitch/mapper.mjs',
    'src/platforms/twitch/service.mjs',
    'src/monitoring/detectors/twitch.mjs'
  ]) {
    assert.ok(buildSource.includes(module), module);
  }
});
