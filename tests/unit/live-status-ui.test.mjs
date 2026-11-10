import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  captureStatusMeta,
  endReasonLabelKey,
  platformStatusMeta
} from '../../src/web/js/pages/shared.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(join(root, 'src/web/i18n', `${locale}.json`), 'utf8'));
}

function valueAt(object, key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

test('capture status never stays green after the platform reports an end', () => {
  assert.deepEqual(
    captureStatusMeta({status: 'live', platformStatus: null}),
    {label: 'status.live', tone: 'live', dot: true}
  );
  assert.deepEqual(
    captureStatusMeta({status: 'live', platformStatus: 'live'}),
    {label: 'status.live', tone: 'live', dot: true}
  );
  // Confirmation window: still capturing, but no longer presented as a green
  // "Live" badge.
  assert.deepEqual(
    captureStatusMeta({status: 'live', platformStatus: 'ending'}),
    {label: 'status.confirmingEnd', tone: 'warn', dot: true}
  );
  for (const platformStatus of ['ended', 'not_started', 'carousel']) {
    const meta = captureStatusMeta({status: 'live', platformStatus});
    assert.equal(meta.label, 'status.endingCapture');
    assert.notEqual(meta.tone, 'live');
  }
  assert.deepEqual(
    captureStatusMeta({status: 'ended', endReason: 'platform_ended', platformStatus: 'ended'}),
    {label: 'status.platformEnded', tone: 'neutral', dot: false}
  );
  assert.deepEqual(
    captureStatusMeta({status: 'ended', endReason: 'user', platformStatus: 'live'}),
    {label: 'status.manualStopped', tone: 'neutral', dot: false}
  );
  assert.deepEqual(
    captureStatusMeta({status: 'interrupted', platformStatus: 'ended'}),
    {label: 'status.captureInterrupted', tone: 'warn', dot: false}
  );
  assert.equal(captureStatusMeta({status: 'ended', endReason: null, platformStatus: null}).label, 'status.ended');
});

test('platform status has its own labels and never maps into the live tone by accident', () => {
  assert.deepEqual(platformStatusMeta('live'), {label: 'status.platformLive', tone: 'live', dot: true});
  assert.deepEqual(platformStatusMeta('ended'), {label: 'status.platformEnded', tone: 'neutral', dot: false});
  assert.deepEqual(platformStatusMeta('not_started'), {label: 'status.platformNotStarted', tone: 'neutral', dot: false});
  assert.deepEqual(platformStatusMeta('carousel'), {label: 'status.platformCarousel', tone: 'warn', dot: false});
  assert.deepEqual(platformStatusMeta('unknown'), {label: 'status.platformUnknown', tone: 'warn', dot: false});
  assert.deepEqual(platformStatusMeta('ending'), {label: 'status.platformEnding', tone: 'warn', dot: true});
  assert.equal(platformStatusMeta('something-new').label, 'status.platformUnknown');
});

test('end reasons stay distinguishable, including platform end versus user stop', () => {
  assert.equal(endReasonLabelKey('user'), 'history.endReason.user');
  assert.equal(endReasonLabelKey('platform_ended'), 'history.endReason.platformEnded');
  assert.equal(endReasonLabelKey('startup_recovery'), 'history.endReason.startupRecovery');
  assert.equal(endReasonLabelKey('shutdown'), 'history.endReason.shutdown');
  assert.equal(endReasonLabelKey('failed'), 'history.endReason.failed');
  assert.equal(endReasonLabelKey('not-a-reason'), 'history.endReason.unknown');
});

test('all lifecycle strings exist in Chinese, Japanese and English', () => {
  const keys = [
    'status.manualStopped',
    'status.captureInterrupted',
    'status.confirmingEnd',
    'status.endingCapture',
    'status.platformLive',
    'status.platformEnded',
    'status.platformNotStarted',
    'status.platformCarousel',
    'status.platformUnknown',
    'status.platformEnding',
    'status.platformPrefix',
    'history.detail.lifecycleTitle',
    'history.detail.captureStatus',
    'history.detail.platformStatus',
    'history.detail.lastLiveSeenAt',
    'history.detail.platformEndedAt',
    'history.detail.platformEndUnknown',
    'history.detail.platformEndUnknownNote',
    'history.detail.platformEndedTitle',
    'history.detail.platformEndedBody',
    'history.endReason.user',
    'history.endReason.platformEnded',
    'history.endReason.startupRecovery',
    'history.endReason.shutdown',
    'history.endReason.failed',
    'history.endReason.unknown',
    'live.hero.platformEndedNotice',
    'live.source.onlyLiveCanStart',
    'errors.bilibiliRoomNotLive',
    'errors.bilibiliRoomCarousel'
  ];
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const data = dictionary(locale);
    for (const key of keys) {
      const value = valueAt(data, key);
      assert.equal(typeof value, 'string', `${locale} missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
    }
  }
});

test('history and live pages render the platform state and the unknown-end note', () => {
  const history = read('src/web/js/pages/history.js');
  assert.match(history, /platformStatusChip\(session, t, \{force: true\}\)/);
  assert.match(history, /history\.detail\.platformEndUnknownNote/);
  assert.match(history, /history\.detail\.platformEndedBody/);
  assert.match(history, /endReasonLabelKey\(session\.endReason\)/);
  assert.match(history, /formatDuration\(session\.durationMs/);

  const live = read('src/web/js/pages/live.js');
  assert.match(live, /platformStatusChip\(session, t\)/);
  assert.match(live, /live\.hero\.platformEndedNotice/);
  assert.match(live, /status\.platformEnded/);
  assert.match(live, /onlyLiveCanStart/);

  const shared = read('src/web/js/pages/shared.js');
  assert.doesNotMatch(shared, /\.innerHTML\s*=/);
});
