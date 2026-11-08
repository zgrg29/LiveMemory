import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeLiveChatAdapter, checkRecordable} from '../../src/platforms/youtube/adapter.mjs';
import {YOUTUBE_ERRORS} from '../../src/platforms/youtube/api.mjs';
import {CONNECTION_STATE} from '../../src/platforms/shared/adapter.mjs';

const VIDEO = {
  videoId: 'vid12345678',
  title: 'Live now',
  channelId: 'UC_CHANNEL',
  channelTitle: 'Streamer',
  state: 'live',
  isLive: true,
  actualStartTime: '2026-11-08T10:00:00.000Z',
  actualEndTime: null,
  concurrentViewers: 42,
  activeLiveChatId: 'CHAT-1',
  chatAvailable: true
};

function chatMessage(id, text, {channelId = 'UC_A', name = 'A', type = 'textMessageEvent'} = {}) {
  return {
    id,
    snippet: {
      type,
      publishedAt: '2026-11-08T10:00:01.000Z',
      displayMessage: text,
      textMessageDetails: {messageText: text},
      authorChannelId: {value: channelId}
    },
    authorDetails: {channelId, displayName: name}
  };
}

function fakeApi({pages = [], videos = VIDEO, quotaLimit = 10000} = {}) {
  const api = {
    quotaUsed: 0,
    quotaLimit,
    get quotaRemaining() {
      return Math.max(0, this.quotaLimit - this.quotaUsed);
    },
    chatCalls: [],
    async videos() {
      api.quotaUsed += 1;
      if (videos instanceof Error) throw videos;
      return typeof videos === 'function' ? videos() : videos;
    },
    async liveChatMessages({pageToken}) {
      api.chatCalls.push(pageToken);
      if (api.quotaRemaining < 5) {
        throw Object.assign(new Error('quota'), {code: YOUTUBE_ERRORS.QUOTA_EXCEEDED});
      }
      api.quotaUsed += 5;
      const next = pages.shift();
      if (!next) return {items: [], nextPageToken: null, pollingIntervalMillis: 10, offlineAt: null};
      if (next instanceof Error) throw next;
      return {pollingIntervalMillis: 10, offlineAt: null, nextPageToken: null, items: [], ...next};
    }
  };
  return api;
}

function fastOptions(extra = {}) {
  return {pollIntervalMs: 10, minPollIntervalMs: 5, maxPollIntervalMs: 20, backoffBaseMs: 5, metadataIntervalMs: 60000, ...extra};
}

function waitFor(predicate, {timeoutMs = 2000, intervalMs = 5} = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, intervalMs);
    timer.unref?.();
  });
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

test('only a live broadcast with an active chat can be recorded', () => {
  assert.equal(checkRecordable(VIDEO), null);
  assert.equal(checkRecordable({...VIDEO, state: 'video', isLive: false}).code, 'YOUTUBE_NOT_LIVE_VIDEO');
  assert.equal(checkRecordable({...VIDEO, state: 'upcoming', isLive: false}).code, 'YOUTUBE_NOT_LIVE_UPCOMING');
  assert.equal(checkRecordable({...VIDEO, state: 'ended', isLive: false}).code, 'YOUTUBE_NOT_LIVE_ENDED');
  assert.equal(checkRecordable({...VIDEO, activeLiveChatId: null, chatAvailable: false}).code, YOUTUBE_ERRORS.CHAT_DISABLED);
  assert.equal(checkRecordable(null).code, YOUTUBE_ERRORS.VIDEO_NOT_FOUND);
});

test('an ordinary video is rejected with a translatable reason before any chat call', async () => {
  const api = fakeApi({videos: {...VIDEO, state: 'video', isLive: false}});
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, api, ...fastOptions()});
  await assert.rejects(() => adapter.start({}), (error) => {
    assert.equal(error.code, 'YOUTUBE_NOT_LIVE_VIDEO');
    assert.equal(error.messageKey, 'errors.youtubeNotLive');
    return true;
  });
  assert.equal(api.chatCalls.length, 0);
});

test('a live broadcast streams chat, keeps the page token and honours the server interval', async () => {
  const api = fakeApi({
    pages: [
      {items: [chatMessage('m1', 'hello 😂', {name: 'Alice'})], nextPageToken: 'PAGE-2'},
      {items: [chatMessage('m2', 'second', {channelId: 'UC_B', name: 'Bob'})], nextPageToken: 'PAGE-3'}
    ]
  });
  const events = [];
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, api, ...fastOptions()});
  await adapter.start({onEvent: (draft) => events.push(draft)});
  assert.equal(adapter.state, CONNECTION_STATE.CONNECTED);
  assert.equal(events.length, 1);
  assert.equal(events[0].viewer_uid, 'UC_A');
  assert.equal(events[0].content, 'hello 😂');
  assert.equal(adapter.pollingIntervalMs, 10);

  await waitFor(() => events.length >= 2);
  assert.equal(events[1].viewer_uid, 'UC_B');
  assert.equal(api.chatCalls[0], null);
  assert.equal(api.chatCalls[1], 'PAGE-2');
  await adapter.stop();
  assert.equal(adapter.state, CONNECTION_STATE.STOPPED);
});

test('the chat offline marker ends the recording instead of polling forever', async () => {
  const api = fakeApi({
    pages: [{items: [chatMessage('m1', 'bye')], offlineAt: Date.parse('2026-11-08T11:00:00.000Z')}]
  });
  const endings = [];
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, api, ...fastOptions()});
  await adapter.start({onEvent: () => {}, onEnd: (info) => endings.push(info)});
  await waitFor(() => endings.length === 1);
  assert.equal(endings[0].reason, 'chat_ended');
  assert.equal(adapter.ended, true);
  await adapter.stop();
});

test('a short network failure reconnects and never ends the session', async () => {
  const networkError = Object.assign(new Error('offline'), {code: YOUTUBE_ERRORS.NETWORK});
  const api = fakeApi({
    pages: [
      {items: [chatMessage('m1', 'first')], nextPageToken: 'P2'},
      networkError,
      {items: [chatMessage('m2', 'after reconnect', {channelId: 'UC_C', name: 'C'})], nextPageToken: 'P3'}
    ]
  });
  const events = [];
  const endings = [];
  const states = [];
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, api, ...fastOptions()});
  await adapter.start({
    onEvent: (draft) => events.push(draft),
    onEnd: (info) => endings.push(info),
    onStateChange: (change) => states.push(change.state)
  });
  await waitFor(() => events.length >= 2);
  assert.equal(endings.length, 0);
  assert.ok(states.includes(CONNECTION_STATE.RECONNECTING));
  assert.equal(adapter.failures, 0);
  await adapter.stop();
});

test('an exhausted quota stops the poller with a clear reason', async () => {
  const api = fakeApi({
    quotaLimit: 5,
    pages: [{items: [chatMessage('m1', 'one')], nextPageToken: 'P2'}]
  });
  const endings = [];
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, video: VIDEO, api, ...fastOptions()});
  await adapter.start({onEvent: () => {}, onEnd: (info) => endings.push(info)});
  await waitFor(() => endings.length === 1);
  assert.equal(endings[0].reason, 'quota');
  await adapter.stop();
});

test('stopping the adapter clears its timer so no further requests are made', async () => {
  const api = fakeApi({pages: [{items: [], nextPageToken: 'P2'}]});
  const adapter = new YouTubeLiveChatAdapter({videoId: VIDEO.videoId, api, ...fastOptions()});
  await adapter.start({onEvent: () => {}});
  await adapter.stop();
  const calls = api.chatCalls.length;
  await sleep(40);
  assert.equal(api.chatCalls.length, calls);
  assert.equal(adapter.started, false);
});
