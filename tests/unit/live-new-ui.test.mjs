import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * Structural guard for the "new recording" view after the simulator was
 * removed from the product UI.
 *
 * Behaviour is covered by the HTTP/manager integration tests. This file catches
 * the regressions that would silently break the requirement: the simulation
 * tab or hero button coming back, a default that is not a real platform, a
 * TikTok duplicate rule that is global instead of per room, or a translation
 * key that is used in the page but missing from a locale.
 */

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const historySource = read('src/web/js/pages/history.js');
const routesSource = read('src/server/routes.mjs');
const sessionManagerSource = read('src/platforms/shared/session-manager.mjs');
const pagesCss = read('src/web/styles/pages.css');
const dictionaries = {
  en: JSON.parse(read('src/web/i18n/en.json')),
  ja: JSON.parse(read('src/web/i18n/ja.json')),
  'zh-CN': JSON.parse(read('src/web/i18n/zh-CN.json'))
};
const LOCALES = Object.keys(dictionaries);

function valueAt(object, key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

function leafKeys(value, prefix = '') {
  const keys = [];
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) keys.push(...leafKeys(entry, path));
    else keys.push(path);
  }
  return keys;
}

function literalKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bt\(\s*`([a-zA-Z0-9_.${}]+)`/g)) {
    if (!match[1].includes('${')) keys.add(match[1]);
  }
  return [...keys];
}

test('the simulator is gone from the production live page', () => {
  assert.doesNotMatch(liveSource, /mockTab/);
  assert.doesNotMatch(liveSource, /mockNote/);
  assert.doesNotMatch(liveSource, /buildMockPanel/);
  assert.doesNotMatch(liveSource, /\/api\/simulate\/start/);
  assert.doesNotMatch(liveSource, /\/api\/simulate\/stop/);
  assert.doesNotMatch(liveSource, /simulationTitle/);
  assert.doesNotMatch(liveSource, /live\.hero\.start'/);
  assert.doesNotMatch(liveSource, /live\.hero\.startFailed'/);
  assert.doesNotMatch(liveSource, /sourceMode = 'mock'/);
  // No simulation-specific hero action remains.
  assert.doesNotMatch(liveSource, /function startButton\(/);
  assert.doesNotMatch(liveSource, /async function handleStart\(/);
});

test('the new-recording view starts on a real platform and lists all five', () => {
  assert.match(liveSource, /let sourceMode = 'bilibili'/);
  for (const tab of [
    'live.source.biliTab',
    'live.source.youtubeTab',
    'live.source.twitchTab',
    'live.source.douyinTab',
    'live.source.tiktokTab'
  ]) {
    assert.match(liveSource, new RegExp(tab.replaceAll('.', '\\.')));
  }
  // The card exists and no platform blocks starting another recording.
  assert.match(liveSource, /function renderSource\(\)/);
  assert.match(liveSource, /function buildBiliPanel/);
  assert.match(liveSource, /function buildYouTubePanel/);
  assert.match(liveSource, /function buildTwitchPanel/);
  assert.match(liveSource, /function buildDouyinPanel/);
  assert.match(liveSource, /function buildTikTokPanel/);
  assert.doesNotMatch(liveSource, /canStart = Boolean\(room\.isLive\) && !tiktokActiveRecording\(\)/);
});

test('the page exposes every background recording with its own stop action', () => {
  assert.match(liveSource, /function buildActiveRecordingsCard\(\)/);
  assert.match(liveSource, /live\.new\.activeTitle/);
  assert.match(liveSource, /live\.new\.recordingMessages/);
  assert.match(liveSource, /live\.new\.recordingViewers/);
  assert.match(liveSource, /live\.new\.open/);
  assert.match(liveSource, /live\.new\.stop/);
  assert.match(liveSource, /stopBackgroundRecording/);
  assert.match(liveSource, /\/api\/live\/recordings\/\$\{encodeURIComponent\(recording\.sessionId\)\}\/stop/);
  // Switching the platform tab only re-renders the source panel, never stops a
  // background recording.
  const tabHandler = liveSource.slice(
    liveSource.indexOf('function tabButton'),
    liveSource.indexOf('function renderSource')
  );
  assert.ok(tabHandler.length > 0);
  assert.doesNotMatch(tabHandler, /\/stop|stopSession|disconnect|api\.post/);
  assert.match(pagesCss, /\.live-recording-row/);
  assert.match(pagesCss, /\.live-recording-actions/);
  assert.match(pagesCss, /\.tiktok-active-recordings/);
});

test('every translation key used by the live page exists in all three locales', () => {
  const used = literalKeys(liveSource);
  assert.ok(used.length > 100, 'the scan found the live page keys');
  for (const locale of LOCALES) {
    for (const key of used) {
      const value = valueAt(dictionaries[locale], key);
      assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('removed simulation strings are gone while historical simulation data stays readable', () => {
  const removed = [
    'live.source.mockTab',
    'live.source.mockNote',
    'live.hero.start',
    'live.hero.starting',
    'live.hero.startFailed',
    'live.hero.simulationTitle'
  ];
  const historical = [
    'common.platform.mock',
    'status.simulated',
    'history.detail.simulatedNote',
    'live.hero.simulatedChip'
  ];
  for (const locale of LOCALES) {
    const keys = new Set(leafKeys(dictionaries[locale]));
    for (const key of removed) assert.equal(keys.has(key), false, `${locale} still has ${key}`);
    for (const key of historical) assert.ok(keys.has(key), `${locale} lost historical key ${key}`);
  }
  // Historical simulated sessions still render their badge and note.
  assert.match(historySource, /status\.simulated/);
  assert.match(historySource, /history\.detail\.simulatedNote/);

  // The simulator remains an internal fixture for the existing test suites.
  assert.match(routesSource, /path: '\/api\/simulate\/start'/);
  assert.match(routesSource, /path: '\/api\/simulate\/stop'/);
  assert.match(sessionManagerSource, /async startSimulation/);
  assert.match(sessionManagerSource, /new MockLiveSource/);
  // It is not advertised as a user-facing platform any more.
  assert.doesNotMatch(routesSource, /\{id: 'mock', label: 'Simulation'/);
});
