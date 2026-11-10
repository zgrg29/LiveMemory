import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeChannelDetector} from '../../src/monitoring/detectors/youtube.mjs';

/**
 * YouTube channel detector against fixed local HTML. No real network request is
 * made; the shapes mirror the public channel/live/watch pages and the RSS feed.
 */

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const VIDEO = 'dQw4w9WgXcQ';

function channelPage(title = 'Alpha Channel') {
  const data = {
    metadata: {
      channelMetadataRenderer: {
        title,
        externalId: CHANNEL,
        canonicalBaseUrl: '/@alpha'
      }
    },
    contents: {}
  };
  return `<html><head><title>${title} - YouTube</title></head><body>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify({})};</script>
</body></html>`;
}

function watchPage({isLive = true, isUpcoming = false, channelId = CHANNEL} = {}) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId: VIDEO,
      title: 'Live broadcast',
      author: 'Alpha Channel',
      channelId,
      isLive,
      isLiveContent: true,
      isUpcoming
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          ...(isLive ? {isLiveNow: true} : {}),
          scheduledStartTime: String(Date.parse('2026-11-10T09:00:00.000Z') / 1000),
          startTimestamp: '2026-11-10T09:00:00.000Z'
        }
      }
    }
  };
  return `<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></body></html>`;
}

const RSS = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry><yt:channelId>${CHANNEL}</yt:channelId><yt:videoId>${VIDEO}</yt:videoId>
    <title>Live broadcast</title><published>2026-11-10T08:58:00+00:00</published>
    <updated>2026-11-10T09:00:00+00:00</updated></entry>
</feed>`;

function response(body, {status = 200, headers = {}} = {}) {
  return new Response(body, {status, headers});
}

function detectorWith(routes, {client = null, now = () => Date.parse('2026-11-10T09:05:00.000Z')} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return handler(String(url));
    }
    return response('not found', {status: 404});
  };
  const detector = new YouTubeChannelDetector({
    client: client ?? {getVideo: async () => { throw new Error('unexpected getVideo'); }},
    fetchImpl,
    now,
    pacer: null,
    baseUrl: 'https://www.youtube.com'
  });
  return {detector, calls};
}

test('resolve accepts @handle, channel URL and known video link', async () => {
  const {detector, calls} = detectorWith([
    ['/@alpha', () => response(channelPage())],
    [`/channel/${CHANNEL}`, () => response(channelPage())]
  ]);
  const fromHandle = await detector.resolve('https://www.youtube.com/@alpha');
  assert.equal(fromHandle.platform, 'youtube');
  assert.equal(fromHandle.targetKey, CHANNEL);
  assert.equal(fromHandle.displayName, 'Alpha Channel');
  assert.equal(fromHandle.broadcasterId, `youtube:${CHANNEL}`);
  assert.equal(fromHandle.meta.handle, '@alpha');
  assert.ok(calls[0].includes('/@alpha'));

  const fromChannel = await detector.resolve(`https://www.youtube.com/channel/${CHANNEL}`);
  assert.equal(fromChannel.targetKey, CHANNEL);

  const videoClient = {
    getVideo: async (videoId) => {
      assert.equal(videoId, VIDEO);
      return {
        videoId,
        channelId: CHANNEL,
        channelTitle: 'Alpha Channel',
        title: 'A broadcast',
        isLive: false,
        state: 'ended'
      };
    }
  };
  const {detector: videoDetector} = detectorWith(
    [[`/channel/${CHANNEL}`, () => response(channelPage())]],
    {client: videoClient}
  );
  const fromVideo = await videoDetector.resolve(`https://youtu.be/${VIDEO}`);
  assert.equal(fromVideo.targetKey, CHANNEL);
  assert.equal(fromVideo.meta.resolvedFromVideoId, VIDEO);
});

test('detect classifies live, upcoming and offline with one public page request', async () => {
  const live = detectorWith([[`/channel/${CHANNEL}/live`, () => response(watchPage())]]);
  const liveResult = await live.detector.detect({target_key: CHANNEL});
  assert.equal(liveResult.status, 'live');
  assert.equal(liveResult.videoId, VIDEO);
  assert.equal(liveResult.via, 'live-page');
  assert.equal(liveResult.startedAt, '2026-11-10T09:00:00.000Z');
  assert.equal(live.calls.length, 1);

  const upcoming = detectorWith([[`/channel/${CHANNEL}/live`, () => response(watchPage({isLive: false, isUpcoming: true}))]]);
  assert.equal((await upcoming.detector.detect({target_key: CHANNEL})).status, 'upcoming');

  const offline = detectorWith([[`/channel/${CHANNEL}/live`, () => response(channelPage())]]);
  assert.equal((await offline.detector.detect({target_key: CHANNEL})).status, 'offline');
});

test('rate limits and network errors surface as distinct monitor errors', async () => {
  const limited = detectorWith([[`/channel/${CHANNEL}/live`, () => response('slow down', {
    status: 429,
    headers: {'retry-after': '120'}
  })]]);
  await assert.rejects(
    () => limited.detector.detect({target_key: CHANNEL}),
    (error) => error.code === 'MONITOR_RATE_LIMITED' && error.details.retryAfterMs === 120000
  );

  const broken = detectorWith([[`/channel/${CHANNEL}/live`, () => { throw new Error('offline'); }]]);
  await assert.rejects(
    () => broken.detector.detect({target_key: CHANNEL}),
    (error) => error.code === 'MONITOR_NETWORK'
  );

  const restricted = detectorWith([[`/channel/${CHANNEL}/live`, () => response('Before you continue to YouTube https://consent.youtube.com/x')]]);
  await assert.rejects(
    () => restricted.detector.detect({target_key: CHANNEL}),
    (error) => error.code === 'MONITOR_RESTRICTED'
  );
});

test('a broken /live page falls back to RSS plus watch-page confirmation', async () => {
  const videos = new Map([
    [VIDEO, {videoId: VIDEO, channelId: CHANNEL, channelTitle: 'Alpha', isLive: true, state: 'live', title: 'Live'}]
  ]);
  const client = {
    getVideo: async (id) => {
      if (!videos.has(id)) throw Object.assign(new Error('missing'), {code: 'YOUTUBE_VIDEO_NOT_FOUND'});
      return videos.get(id);
    }
  };
  const {detector, calls} = detectorWith([
    [`/channel/${CHANNEL}/live`, () => response('<html><body>unexpected markup</body></html>')],
    ['/feeds/videos.xml', () => response(RSS)],
    ['/watch?v=', () => response(watchPage())]
  ], {client});
  const result = await detector.detect({target_key: CHANNEL});
  assert.equal(result.status, 'live');
  assert.equal(result.via, 'rss');
  assert.equal(calls.filter((url) => url.includes('/feeds/videos.xml')).length, 1);
  assert.ok(calls.every((url) => url.includes('/live') || url.includes('/feeds/')));
});

test('the RSS fallback never marks a video live without watch-page isLive evidence', async () => {
  const client = {
    getVideo: async (id) => ({
      videoId: id,
      channelId: CHANNEL,
      channelTitle: 'Alpha',
      isLive: false,
      state: 'ended'
    })
  };
  const {detector} = detectorWith([
    [`/channel/${CHANNEL}/live`, () => response('<html><body>unexpected markup</body></html>')],
    ['/feeds/videos.xml', () => response(RSS)],
    ['/watch?v=', () => response(watchPage({isLive: false}))]
  ], {client});
  const result = await detector.detect({target_key: CHANNEL});
  assert.equal(result.status, 'offline');
  assert.equal(result.via, 'rss');
});

test('an owner mismatch is never treated as this channel being live', async () => {
  const {detector} = detectorWith([
    [`/channel/${CHANNEL}/live`, () => response(watchPage({channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz'}))],
    ['/feeds/videos.xml', () => response('<?xml version="1.0"?><feed></feed>')]
  ]);
  await assert.rejects(
    () => detector.detect({target_key: CHANNEL}),
    (error) => error.code === 'MONITOR_PROTOCOL'
  );
});
