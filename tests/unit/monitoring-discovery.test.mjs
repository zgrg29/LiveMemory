import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelIdentity,
  parseChannelLivePage,
  parseChannelRss,
  parseYouTubeChannelInput
} from '../../src/monitoring/youtube-discovery.mjs';
import {
  classifyMonitorError,
  derivePublicState,
  initialCheckDelay,
  retryDelay,
  summarizeTargets
} from '../../src/monitoring/model.mjs';
import {MONITOR_POLICY, MONITOR_STATE} from '../../src/monitoring/constants.mjs';

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const OTHER = 'UCzzzzzzzzzzzzzzzzzzzzzz';
const VIDEO = 'dQw4w9WgXcQ';

function channelPage({channelId = CHANNEL, title = 'Alpha Channel', handle = '@alpha'} = {}) {
  const data = {
    metadata: {
      channelMetadataRenderer: {
        title,
        externalId: channelId,
        canonicalBaseUrl: `/${String(handle).replace(/^@\/?/, '@')}`
      }
    },
    contents: {
      // A recommended channel id appears before/around the metadata. It must
      // never be mistaken for the followed channel.
      twoColumnBrowseResultsRenderer: {tabs: [{tabRenderer: {title: 'Home', content: {}}}]}
    }
  };
  return `<html><head><title>${title} - YouTube</title><meta property="og:title" content="${title}"></head><body>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify({})};</script>
</body></html>`;
}

function watchPage({
  videoId = VIDEO,
  channelId = CHANNEL,
  isLive = true,
  isUpcoming = false,
  isLiveContent = true,
  title = 'Live now',
  channelTitle = 'Alpha Channel',
  start = '2026-11-10T09:00:00.000Z',
  viewers = '1,234'
} = {}) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId,
      title,
      author: channelTitle,
      channelId,
      isLive,
      isLiveContent,
      isUpcoming
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          ...(isLive ? {isLiveNow: true} : {}),
          ...(start ? {startTimestamp: start} : {})
        }
      }
    }
  };
  const initial = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{
              videoPrimaryInfoRenderer: {
                viewCount: {videoViewCountRenderer: {viewCount: {simpleText: `${viewers} watching`}}}
              }
            }]
          }
        }
      }
    }
  };
  return `<html><head><title>${title} - YouTube</title></head><body>
<script>var ytInitialData = ${JSON.stringify(initial)};</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>
</body></html>`;
}

test('YouTube channel input accepts channel URL, @handle, channel id and video link', () => {
  assert.deepEqual(parseYouTubeChannelInput(`https://www.youtube.com/channel/${CHANNEL}`), {
    kind: 'channel',
    channelId: CHANNEL,
    normalizedUrl: `https://www.youtube.com/channel/${CHANNEL}`
  });
  assert.equal(parseYouTubeChannelInput('https://youtube.com/@alpha').kind, 'handle');
  assert.equal(parseYouTubeChannelInput('@alpha').handle, '@alpha');
  assert.equal(parseYouTubeChannelInput(CHANNEL).channelId, CHANNEL);
  assert.equal(parseYouTubeChannelInput(`https://youtu.be/${VIDEO}`).videoId, VIDEO);
  assert.equal(parseYouTubeChannelInput(`https://www.youtube.com/live/${VIDEO}?feature=share`).kind, 'video');
  assert.equal(parseYouTubeChannelInput(`https://www.youtube.com/channel/${CHANNEL}/live`).kind, 'channel');
  assert.equal(parseYouTubeChannelInput(`https://www.youtube.com/@alpha/streams`).handle, '@alpha');
  assert.equal(parseYouTubeChannelInput('https://www.youtube.com/c/alpha').kind, 'legacy');
  assert.equal(parseYouTubeChannelInput('https://www.youtube.com/user/alpha').legacy, 'alpha');
});

test('YouTube channel input rejects playlists, clips and foreign hosts', () => {
  for (const input of [
    '',
    '   ',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/clip/Ugkx123',
    'https://vimeo.com/channels/alpha',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@'
  ]) {
    assert.throws(() => parseYouTubeChannelInput(input), (error) => error.code === 'MONITOR_INVALID_INPUT', input);
  }
});

test('channel identity prefers externalId over recommended channelId values', () => {
  const html = channelPage();
  const identity = parseChannelIdentity(html);
  assert.equal(identity.channelId, CHANNEL);
  assert.equal(identity.title, 'Alpha Channel');
  assert.equal(identity.handle, '@alpha');
  assert.equal(identity.canonicalUrl, 'https://www.youtube.com/@alpha');

  const withRecommendation = html.replace(
    '"contents":',
    `"recommended":{"channelId":"${OTHER}"},"contents":`
  );
  assert.equal(parseChannelIdentity(withRecommendation).channelId, CHANNEL);
  assert.equal(parseChannelIdentity('<html>nothing</html>'), null);
});

test('live page classification distinguishes live, upcoming, ended, offline and wrong owner', () => {
  const live = parseChannelLivePage(watchPage(), {channelId: CHANNEL});
  assert.equal(live.kind, 'live');
  assert.equal(live.videoId, VIDEO);
  assert.equal(live.title, 'Live now');
  assert.equal(live.concurrentViewers, 1234);
  assert.equal(live.startedAt, '2026-11-10T09:00:00.000Z');

  const upcoming = parseChannelLivePage(
    watchPage({isLive: false, isUpcoming: true}),
    {channelId: CHANNEL}
  );
  assert.equal(upcoming.kind, 'upcoming');

  const ended = parseChannelLivePage(
    watchPage({isLive: false, isLiveContent: true}),
    {channelId: CHANNEL}
  );
  assert.equal(ended.kind, 'offline');
  assert.equal(ended.reason, 'ended');

  const vod = parseChannelLivePage(
    watchPage({isLive: false, isLiveContent: false, start: null}),
    {channelId: CHANNEL}
  );
  assert.equal(vod.kind, 'offline');
  assert.equal(vod.reason, 'not_live');

  // When /live serves the channel page, the channel is not broadcasting.
  const offline = parseChannelLivePage(channelPage(), {channelId: CHANNEL});
  assert.equal(offline.kind, 'offline');
  assert.equal(offline.page, 'channel');

  // A watch page for another channel must never become this target's live.
  const mismatch = parseChannelLivePage(watchPage({channelId: OTHER}), {channelId: CHANNEL});
  assert.equal(mismatch.kind, 'invalid');
  assert.equal(mismatch.reason, 'owner_mismatch');

  const restricted = parseChannelLivePage(
    '<html>Before you continue to YouTube <a href="https://consent.youtube.com/x">here</a></html>',
    {channelId: CHANNEL}
  );
  assert.equal(restricted.kind, 'restricted');

  const broken = parseChannelLivePage('<html><body>temporary page</body></html>', {channelId: CHANNEL});
  assert.equal(broken.kind, 'invalid');
});

test('RSS parsing keeps only recent entries of the requested channel', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
    <author><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>
    <entry><yt:channelId>${CHANNEL}</yt:channelId><yt:videoId>${VIDEO}</yt:videoId>
      <title>Live now</title><published>2026-11-10T11:55:00+00:00</published>
      <updated>2026-11-10T11:56:00+00:00</updated></entry>
    <entry><yt:channelId>${CHANNEL}</yt:channelId><yt:videoId>bbbbbbbbbbb</yt:videoId>
      <title>Old video</title><published>2026-11-01T10:00:00+00:00</published>
      <updated>2026-11-01T10:01:00+00:00</updated></entry>
    <entry><yt:channelId>${OTHER}</yt:channelId><yt:videoId>ccccccccccc</yt:videoId>
      <title>Other</title><published>2026-11-10T11:59:00+00:00</published>
      <updated>2026-11-10T11:59:30+00:00</updated></entry>
  </feed>`;
  const parsed = parseChannelRss(xml, {now, maxAgeMs: 6 * 60 * 60 * 1000});
  assert.equal(parsed.channelId, CHANNEL);
  // The third entry belongs to another channel and is filtered out.
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.recent.map((entry) => entry.videoId), [VIDEO]);
  assert.equal(parseChannelRss('<html>not a feed</html>', {now}).entries.length, 0);
});

test('scheduler delays stay inside their bounds and errors back off exponentially', () => {
  const policy = MONITOR_POLICY.bilibili;
  for (let index = 0; index < 50; index += 1) {
    const value = retryDelay({policy, random: () => index / 50});
    assert.ok(value >= policy.minMs * 0.87 - 1 && value <= policy.maxMs * 1.13 + 1, `offline delay ${value}`);
  }
  const first = retryDelay({policy, kind: 'error', failures: 1, random: () => 0.5});
  const second = retryDelay({policy, kind: 'error', failures: 2, random: () => 0.5});
  const capped = retryDelay({policy, kind: 'error', failures: 20, random: () => 0.5});
  assert.ok(second > first);
  assert.ok(capped <= policy.errorMaxMs * 1.1);
  assert.equal(retryDelay({policy, kind: 'rate_limited', retryAfterMs: 120000, random: () => 0.5}), 120000);
  assert.equal(retryDelay({policy, kind: 'rate_limited', retryAfterMs: 9900000}), 30 * 60 * 1000);
  const initial = initialCheckDelay('mon_target', {now: T0, random: () => 0});
  assert.ok(initial >= 1000 && initial <= 50000);
});

const T0 = Date.parse('2026-11-10T12:00:00.000Z');

test('public monitor state derives reconnecting/paused without changing the base lifecycle', () => {
  assert.equal(derivePublicState({state: MONITOR_STATE.RECORDING, enabled: true, recordingState: 'reconnecting'}), 'reconnecting');
  assert.equal(derivePublicState({state: MONITOR_STATE.RECORDING, enabled: true, recordingState: 'connected'}), 'recording');
  assert.equal(derivePublicState({state: MONITOR_STATE.WAITING, enabled: false}), 'paused');
  assert.equal(derivePublicState({state: MONITOR_STATE.RECORDING, enabled: false, recordingState: 'connected'}), 'recording');
  assert.equal(derivePublicState({state: MONITOR_STATE.ERROR, enabled: true}), 'error');
});

test('error classification preserves rate limits and never becomes offline', () => {
  assert.deepEqual(classifyMonitorError({code: 'YOUTUBE_WEB_NETWORK'}), {code: 'MONITOR_NETWORK', retryAfterMs: null});
  assert.equal(classifyMonitorError({code: 'YOUTUBE_RATE_LIMITED', details: {retryAfterMs: 123}}).code, 'MONITOR_RATE_LIMITED');
  assert.equal(classifyMonitorError({code: 'YOUTUBE_WEB_RESTRICTED'}).code, 'MONITOR_BLOCKED');
  assert.equal(classifyMonitorError({code: 'YOUTUBE_NOT_LIVE'}).code, 'MONITOR_OFFLINE_RACE');
  assert.equal(classifyMonitorError({code: 'YOUTUBE_CHAT_DISABLED'}).code, 'MONITOR_CHAT_UNAVAILABLE');
  assert.equal(classifyMonitorError({code: 'MONITOR_PROTOCOL'}).code, 'MONITOR_PROTOCOL');
  assert.equal(classifyMonitorError({code: 'SOMETHING_NEW'}).code, 'MONITOR_UNKNOWN');
});

test('summary counts recording up even when the underlying connection reconnects', () => {
  assert.deepEqual(summarizeTargets([
    {enabled: true, state: 'recording'},
    {enabled: true, state: 'reconnecting'},
    {enabled: true, state: 'waiting'},
    {enabled: false, state: 'paused'},
    {enabled: true, state: 'error'}
  ]), {total: 5, enabled: 4, recording: 2, waiting: 1, error: 1, paused: 1});
});
