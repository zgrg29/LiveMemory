import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchService} from '../../src/platforms/twitch/service.mjs';

function channel(overrides = {}) {
  return {
    login: 'xqc',
    channelId: '71092938',
    displayName: 'xQc',
    title: 'LIVE',
    game: 'Just Chatting',
    isLive: true,
    streamId: 'stream-1',
    startedAt: 1700000000000,
    viewers: 12345,
    checkedAt: 1700000001000,
    ...overrides
  };
}

function fakeSessionManager() {
  return {
    calls: [],
    result: null,
    status() {
      return {recordings: []};
    },
    async startPlatform(options) {
      this.calls.push(options);
      if (this.result) return this.result;
      return {started: true, session: {id: 'ses_twitch_1'}};
    },
    async stopPlatform(platform, options) {
      return {stopped: true, session: {id: options.sessionId ?? 'ses_twitch_1'}};
    }
  };
}

test('checkChannel returns live metadata and the stable channel id', async () => {
  const service = new TwitchService({
    sessionManager: fakeSessionManager(),
    client: {getChannel: async () => channel()}
  });
  const result = await service.checkChannel('https://www.twitch.tv/xQc');
  assert.equal(result.login, 'xqc');
  assert.equal(result.channelId, '71092938');
  assert.equal(result.displayName, 'xQc');
  assert.equal(result.isLive, true);
  assert.equal(result.recordable, true);
  assert.equal(result.reason, null);
  assert.equal(result.liveUrl, 'https://www.twitch.tv/xqc');
});

test('checkChannel reports offline instead of pretending it is recordable', async () => {
  const service = new TwitchService({
    sessionManager: fakeSessionManager(),
    client: {getChannel: async () => channel({isLive: false, streamId: null})}
  });
  const result = await service.checkChannel('xqc');
  assert.equal(result.isLive, false);
  assert.equal(result.recordable, false);
  assert.equal(result.reason, 'TWITCH_CHANNEL_OFFLINE');
});

test('connect uses the stable channel id for duplicate detection and broadcaster identity', async () => {
  const manager = fakeSessionManager();
  const service = new TwitchService({
    sessionManager: manager,
    client: {getChannel: async () => channel()}
  });
  const result = await service.connect('xqc');
  assert.equal(result.session.id, 'ses_twitch_1');
  assert.equal(manager.calls.length, 1);
  const call = manager.calls[0];
  assert.equal(call.platform, 'twitch');
  assert.equal(call.platformRoomId, '71092938');
  assert.equal(call.broadcasterUid, '71092938');
  assert.equal(call.broadcasterName, 'xQc');
  assert.equal(call.roomTitle, 'LIVE');
  assert.equal(call.meta.login, 'xqc');
  assert.equal(call.meta.mode, 'anonymous-irc');
  assert.equal(call.sourceQuality, 'estimated');
});

test('an offline channel is refused before a session is created', async () => {
  const manager = fakeSessionManager();
  const service = new TwitchService({
    sessionManager: manager,
    client: {getChannel: async () => channel({isLive: false, streamId: null})}
  });
  await assert.rejects(service.connect('xqc'), {code: 'TWITCH_CHANNEL_OFFLINE'});
  assert.equal(manager.calls.length, 0);
});

test('a duplicate room is reported with the existing session id', async () => {
  const manager = fakeSessionManager();
  manager.result = {
    started: false,
    duplicate: {reason: 'duplicate_room', sessionId: 'ses_old', session: {id: 'ses_old'}}
  };
  const service = new TwitchService({
    sessionManager: manager,
    client: {getChannel: async () => channel()}
  });
  await assert.rejects(service.connect('xqc'), (error) => {
    assert.equal(error.code, 'SESSION_DUPLICATE_ROOM');
    assert.equal(error.details.sessionId, 'ses_old');
    return true;
  });
});

test('status states the anonymous evidence boundaries instead of overclaiming', () => {
  const service = new TwitchService({sessionManager: fakeSessionManager(), db: null});
  const status = service.status();
  assert.equal(status.mode, 'anonymous-irc');
  assert.equal(status.capabilities.requiresLogin, false);
  assert.equal(status.capabilities.eventSub, 'requires-oauth-not-configured');
  assert.equal(status.capabilities.bits, 'parsed-not-verified');
  assert.equal(status.capabilities.giftedSubscriptions, 'parsed-not-verified');
});
