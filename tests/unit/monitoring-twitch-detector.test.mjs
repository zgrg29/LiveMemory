import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchChannelDetector, twitchMonitorError} from '../../src/monitoring/detectors/twitch.mjs';
import {liveCycleKey} from '../../src/monitoring/model.mjs';
import {TwitchError, TWITCH_ERRORS} from '../../src/platforms/twitch/errors.mjs';

const T0 = 1700000000000;

function channel(overrides = {}) {
  return {
    login: 'xqc',
    channelId: '71092938',
    displayName: 'xQc',
    title: 'LIVE',
    game: 'Just Chatting',
    isLive: true,
    streamId: 'stream-1',
    startedAt: T0,
    viewers: 1000,
    checkedAt: T0,
    ...overrides
  };
}

test('resolve stores the login as target key and the channel id as stable identity', async () => {
  const detector = new TwitchChannelDetector({client: {getChannel: async () => channel()}, now: () => T0});
  const resolved = await detector.resolve('https://twitch.tv/xQc');
  assert.equal(resolved.platform, 'twitch');
  assert.equal(resolved.targetKey, 'xqc');
  assert.equal(resolved.platformUid, '71092938');
  assert.equal(resolved.broadcasterId, 'twitch:71092938');
  assert.equal(resolved.broadcasterIdentity.identity, 'verified');
  assert.equal(resolved.meta.streamId, 'stream-1');
});

test('detect maps a live channel to a live observation with a stable cycle key', async () => {
  const detector = new TwitchChannelDetector({client: {getChannel: async () => channel()}, now: () => T0});
  const observation = await detector.detect({target_key: 'xqc', platform_uid: '71092938'});
  assert.equal(observation.status, 'live');
  assert.equal(observation.login, 'xqc');
  assert.equal(observation.channelId, '71092938');
  assert.equal(observation.channelTitle, 'xQc');
  assert.equal(observation.viewers, 1000);
  assert.equal(observation.liveStartedAt, T0);
  assert.equal(liveCycleKey('twitch', {target_key: 'xqc'}, observation), 'twitch:xqc:stream-1');
});

test('detect maps an offline channel to offline without inventing a stream id', async () => {
  const detector = new TwitchChannelDetector({
    client: {getChannel: async () => channel({isLive: false, streamId: null, viewers: null})},
    now: () => T0
  });
  const observation = await detector.detect({target_key: 'xqc', platform_uid: '71092938'});
  assert.equal(observation.status, 'offline');
  assert.equal(observation.streamId, null);
  assert.equal(liveCycleKey('twitch', {target_key: 'xqc'}, observation), null);
});

test('monitor errors keep their meaning', () => {
  const notFound = twitchMonitorError(new TwitchError(TWITCH_ERRORS.CHANNEL_NOT_FOUND, {httpStatus: 404}));
  assert.equal(notFound.code, 'MONITOR_NOT_FOUND');
  const rate = twitchMonitorError(new TwitchError(TWITCH_ERRORS.RATE_LIMITED, {
    httpStatus: 429,
    retryAfterMs: 30000
  }));
  assert.equal(rate.code, 'MONITOR_RATE_LIMITED');
  assert.equal(rate.details.retryAfterMs, 30000);
  const network = twitchMonitorError(new TwitchError(TWITCH_ERRORS.NETWORK, {httpStatus: 502}));
  assert.equal(network.code, 'MONITOR_NETWORK');
  const invalid = twitchMonitorError(new TwitchError(TWITCH_ERRORS.LINK_INVALID, {httpStatus: 400}));
  assert.equal(invalid.code, 'MONITOR_INVALID_INPUT');
});
