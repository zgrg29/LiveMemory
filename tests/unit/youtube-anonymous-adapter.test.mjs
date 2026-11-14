import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeAnonymousLiveChatAdapter} from '../../src/platforms/youtube/anonymous/adapter.mjs';
import {YouTubeApiError, YOUTUBE_ERRORS} from '../../src/platforms/youtube/errors.mjs';

const LIVE = {
  videoId: 'anonLIVE001',
  title: 'Live',
  channelTitle: 'Channel',
  state: 'live',
  isLive: true,
  concurrentViewers: 10
};

const ACTION = {
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id: 'm1',
        timestampUsec: '1794145000000000',
        authorName: {simpleText: 'Alice'},
        authorExternalChannelId: 'UC_A',
        message: {runs: [{text: 'hello'}]}
      }
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(30);
  }
}

function stale() {
  return new YouTubeApiError(YOUTUBE_ERRORS.WEB_STALE, {
    messageKey: 'errors.youtubeWebStale',
    httpStatus: 409
  });
}

test('a stale continuation re-opens the public chat page without ending the session', async () => {
  let opens = 0;
  let polls = 0;
  const events = [];
  const client = {
    async getVideo() {
      return LIVE;
    },
    async openChat() {
      opens += 1;
      return {
        continuation: `CONT-${opens}`,
        actions: opens === 1 ? [ACTION] : [],
        timeoutMs: 20,
        gl: 'HK',
        config: {}
      };
    },
    async poll() {
      polls += 1;
      if (polls === 1) throw stale();
      return {actions: [ACTION], continuation: `NEXT-${polls}`, timeoutMs: 50, ended: false};
    }
  };
  const adapter = new YouTubeAnonymousLiveChatAdapter({
    videoId: LIVE.videoId,
    video: LIVE,
    client,
    options: {
      minPollIntervalMs: 10,
      maxPollIntervalMs: 50,
      metadataIntervalMs: 60000,
      backoffBaseMs: 10,
      maxBackoffMs: 50,
      maxConsecutiveFailures: 8
    }
  });
  const ended = [];
  await adapter.start({
    onEvent: (event) => events.push(event),
    onEnd: (info) => ended.push(info)
  });
  await waitFor(() => events.length >= 2 && adapter.state === 'connected');
  assert.equal(opens, 2, 'the chat page was reopened after the stale continuation');
  assert.equal(ended.length, 0, 'a stale continuation is not a stream end');
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.detail.mode, 'web');
  assert.equal(snapshot.detail.identityComplete, 2);
  await adapter.stop();
});

test('transient network errors back off and recover without ending the session', async () => {
  let polls = 0;
  const events = [];
  const client = {
    async getVideo() {
      return LIVE;
    },
    async openChat() {
      return {continuation: 'C', actions: [], timeoutMs: 20, gl: 'US', config: {}};
    },
    async poll() {
      polls += 1;
      if (polls === 1) {
        throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_NETWORK, {
          messageKey: 'errors.youtubeWebNetwork',
          httpStatus: 502
        });
      }
      return {actions: [ACTION], continuation: 'NEXT', timeoutMs: 50, ended: false};
    }
  };
  const adapter = new YouTubeAnonymousLiveChatAdapter({
    videoId: LIVE.videoId,
    video: LIVE,
    client,
    options: {
      minPollIntervalMs: 10,
      maxPollIntervalMs: 50,
      metadataIntervalMs: 60000,
      backoffBaseMs: 10,
      maxBackoffMs: 50,
      maxConsecutiveFailures: 8
    }
  });
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => events.length >= 1 && adapter.state === 'connected');
  assert.equal(adapter.snapshot().detail.failures, 0);
  assert.equal(ended.length, 0);
  await adapter.stop();
});
