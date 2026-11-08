import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YouTubeApi,
  YouTubeApiError,
  YOUTUBE_ERRORS,
  QUOTA_COST,
  normalizeVideo,
  normalizeChatPage,
  mapApiError
} from '../../src/platforms/youtube/api.mjs';

/** Minimal fake fetch: records the request and returns a prepared response. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({url: String(url), init});
    const result = await handler(String(url), init);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => JSON.stringify(result.body ?? {})
    };
  };
  impl.calls = calls;
  return impl;
}

const LIVE_VIDEO = {
  id: 'vid12345678',
  snippet: {
    title: 'Late night chat',
    channelId: 'UC_CHANNEL',
    channelTitle: 'Streamer',
    liveBroadcastContent: 'live',
    publishedAt: '2026-11-08T10:00:00.000Z'
  },
  liveStreamingDetails: {
    actualStartTime: '2026-11-08T10:00:00.000Z',
    concurrentViewers: '1234',
    activeLiveChatId: 'CHAT-1'
  },
  status: {privacyStatus: 'public'}
};

test('an API key is sent as a query parameter, not as a bearer token', async () => {
  const fetchImpl = fakeFetch(() => ({status: 200, body: {items: [LIVE_VIDEO]}}));
  const api = new YouTubeApi({apiKey: 'AIzaTESTKEY000000000000000000000000000', fetchImpl});
  const video = await api.videos({videoId: 'vid12345678'});
  assert.equal(video.isLive, true);
  const requested = new URL(fetchImpl.calls[0].url);
  assert.equal(requested.searchParams.get('key'), 'AIzaTESTKEY000000000000000000000000000');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test('an OAuth access token is sent as a bearer token and no key is added', async () => {
  const fetchImpl = fakeFetch(() => ({status: 200, body: {items: [LIVE_VIDEO]}}));
  const api = new YouTubeApi({accessToken: 'ya29.token', apiKey: 'AIzaSHOULDNOTBEUSED000000000000000000', fetchImpl});
  await api.videos({videoId: 'vid12345678'});
  const requested = new URL(fetchImpl.calls[0].url);
  assert.equal(requested.searchParams.get('key'), null);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer ya29.token');
});

test('without any credential the request fails locally with a clear code', async () => {
  const api = new YouTubeApi({accessToken: null, fetchImpl: fakeFetch(() => ({status: 200, body: {}}))});
  await assert.rejects(() => api.videos({videoId: 'vid12345678'}), (error) => {
    assert.equal(error.code, YOUTUBE_ERRORS.AUTH_REQUIRED);
    assert.equal(error.messageKey, 'errors.youtubeAuthRequired');
    return true;
  });
});

test('quota units are counted at the official cost', async () => {
  const fetchImpl = fakeFetch((url) => (url.includes('/liveChat/')
    ? {status: 200, body: {items: [], pollingIntervalMillis: 5000}}
    : {status: 200, body: {items: [LIVE_VIDEO]}}));
  const api = new YouTubeApi({apiKey: 'AIzaTESTKEY000000000000000000000000000', fetchImpl});
  await api.videos({videoId: 'vid12345678'});
  assert.equal(api.quotaUsed, QUOTA_COST.videosList);
  await api.liveChatMessages({liveChatId: 'CHAT-1'});
  assert.equal(api.quotaUsed, QUOTA_COST.videosList + QUOTA_COST.liveChatMessagesList);
  assert.equal(api.quotaRemaining, api.quotaLimit - api.quotaUsed);
});

test('Google error reasons become stable, translatable application codes', () => {
  const cases = [
    [{code: 403, errors: [{reason: 'quotaExceeded'}]}, YOUTUBE_ERRORS.QUOTA_EXCEEDED],
    [{code: 403, errors: [{reason: 'dailyLimitExceeded'}]}, YOUTUBE_ERRORS.QUOTA_EXCEEDED],
    [{code: 403, errors: [{reason: 'keyInvalid'}]}, YOUTUBE_ERRORS.API_KEY_INVALID],
    [{code: 403, errors: [{reason: 'rateLimitExceeded'}]}, YOUTUBE_ERRORS.RATE_LIMITED],
    [{code: 403, errors: [{reason: 'liveChatEnded'}]}, YOUTUBE_ERRORS.CHAT_ENDED],
    [{code: 403, errors: [{reason: 'liveChatDisabled'}]}, YOUTUBE_ERRORS.CHAT_DISABLED],
    [{code: 403, errors: [{reason: 'forbidden'}]}, YOUTUBE_ERRORS.FORBIDDEN],
    [{code: 404, errors: [{reason: 'videoNotFound'}]}, YOUTUBE_ERRORS.VIDEO_NOT_FOUND],
    [{code: 404, errors: [{reason: 'liveChatNotFound'}]}, YOUTUBE_ERRORS.CHAT_NOT_FOUND]
  ];
  for (const [error, expected] of cases) {
    const mapped = mapApiError({status: error.code, payload: {error}, path: '/videos'});
    assert.equal(mapped.code, expected, error.errors[0].reason);
  }
  assert.equal(mapApiError({status: 401, payload: {error: {}}}).code, YOUTUBE_ERRORS.AUTH_REQUIRED);
});

test('an HTTP error surfaces as a YouTubeApiError with a message key', async () => {
  const fetchImpl = fakeFetch(() => ({
    status: 403,
    body: {error: {code: 403, errors: [{reason: 'quotaExceeded'}], message: 'quota'}}
  }));
  const api = new YouTubeApi({apiKey: 'AIzaTESTKEY000000000000000000000000000', fetchImpl});
  await assert.rejects(() => api.videos({videoId: 'vid12345678'}), (error) => {
    assert.ok(error instanceof YouTubeApiError);
    assert.equal(error.code, YOUTUBE_ERRORS.QUOTA_EXCEEDED);
    assert.equal(error.messageKey, 'errors.youtubeQuota');
    return true;
  });
});

test('a network failure is reported as a network error, never as an empty page', async () => {
  const api = new YouTubeApi({
    apiKey: 'AIzaTESTKEY000000000000000000000000000',
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  await assert.rejects(() => api.videos({videoId: 'vid12345678'}), (error) => {
    assert.equal(error.code, YOUTUBE_ERRORS.NETWORK);
    return true;
  });
});

test('video metadata distinguishes live, upcoming, ended and ordinary videos', () => {
  assert.equal(normalizeVideo(LIVE_VIDEO).state, 'live');
  assert.equal(normalizeVideo({...LIVE_VIDEO, liveStreamingDetails: {actualEndTime: '2026-11-08T12:00:00.000Z'}}).state, 'ended');
  assert.equal(normalizeVideo({
    ...LIVE_VIDEO,
    snippet: {...LIVE_VIDEO.snippet, liveBroadcastContent: 'upcoming'},
    liveStreamingDetails: {scheduledStartTime: '2026-11-09T10:00:00.000Z'}
  }).state, 'upcoming');
  assert.equal(normalizeVideo({
    id: 'uploaded',
    snippet: {title: 'Normal upload', liveBroadcastContent: 'none'},
    liveStreamingDetails: {},
    status: {privacyStatus: 'public'}
  }).state, 'video');
  assert.equal(normalizeVideo(null), null);
});

test('chat pages keep the server polling interval and offline timestamp', () => {
  const page = normalizeChatPage({
    items: [{id: 'a'}],
    nextPageToken: 'next',
    pollingIntervalMillis: 4000,
    offlineAt: '2026-11-08T12:00:00.000Z'
  });
  assert.equal(page.nextPageToken, 'next');
  assert.equal(page.pollingIntervalMillis, 4000);
  assert.equal(page.offlineAt, Date.parse('2026-11-08T12:00:00.000Z'));
  const empty = normalizeChatPage(null);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pollingIntervalMillis, null);
});
