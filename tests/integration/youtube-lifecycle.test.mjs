import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * P0-4 end-to-end lifecycle test.
 *
 * A fake public YouTube web endpoint lets the test switch between healthy,
 * rate-limited, 5xx, malformed-200, stale-continuation and ended states while
 * the real HTTP server, SessionManager, adapter, EventIngest and SQLite stay
 * unchanged. It proves that:
 *
 * - temporary failures keep the same live session, messages and viewers;
 * - a reconnect resumes the current session and dedupes replayed messages;
 * - a confirmed platform end closes the session exactly once;
 * - a user stop is a separate, immediate path.
 */

const VIDEO = 'anonLIFE001';
const VIDEO2 = 'anonLIFE002';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 15000, interval = 20} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

const CONFIG = {
  INNERTUBE_API_KEY: 'AIzaFAKE_WEB_KEY',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20990101.00.00',
      gl: 'US',
      hl: 'en',
      visitorData: 'VISITOR_TEST'
    }
  }
};

function textRenderer(id, text, channelId = 'UC_A') {
  return {
    liveChatTextMessageRenderer: {
      id,
      timestampUsec: String((Date.now() + Number(id.replace(/\D/g, '') || 0)) * 1000),
      authorName: {simpleText: channelId},
      authorExternalChannelId: channelId,
      authorBadges: [],
      message: {runs: [{text}]}
    }
  };
}

function watchHtml(videoId, state) {
  const ended = state.watchState === 'ended';
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId,
      title: 'Lifecycle test',
      author: 'Test Channel',
      channelId: 'UC_TEST_CHANNEL',
      isLive: !ended,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: !ended,
          startTimestamp: '2026-11-08T09:00:00.000Z',
          ...(ended ? {endTimestamp: '2026-11-08T10:00:00.000Z'} : {})
        }
      }
    }
  };
  return `<html><script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify({})};</script></html>`;
}

function chatHtml(state) {
  const actions = state.openCount > 1 ? [textRenderer('msg-1', 'duplicate replay')] : [];
  const initial = {
    contents: {
      liveChatRenderer: {
        continuations: [{invalidationContinuationData: {continuation: 'CONT-0', timeoutMs: 40}}],
        actions
      }
    }
  };
  return `<html><script>ytcfg.set(${JSON.stringify(CONFIG)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></html>`;
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(body);
}

async function startFakeWeb(videoId) {
  const state = {
    videoId,
    watchState: 'live',
    pollMode: 'normal',
    pollCount: 0,
    openCount: 0
  };
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({method: req.method, path: url.pathname});
    if (req.method === 'GET' && url.pathname === '/watch') {
      return html(res, watchHtml(videoId, state));
    }
    if (req.method === 'GET' && url.pathname === '/live_chat') {
      state.openCount += 1;
      return html(res, chatHtml(state));
    }
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      state.pollCount += 1;
      if (state.pollMode === '429') {
        return json(res, 429, {error: {code: 429}}, {'retry-after': '0'});
      }
      if (state.pollMode === '500') {
        return json(res, 500, {error: {code: 500}});
      }
      if (state.pollMode === 'stale') {
        state.pollMode = 'normal';
        return json(res, 400, {error: {code: 400}});
      }
      if (state.pollMode === 'invalid') {
        return json(res, 200, {});
      }
      const id = `msg-${state.pollCount}`;
      return json(res, 200, {
        continuationContents: {
          liveChatContinuation: {
            continuations: [{
              invalidationContinuationData: {continuation: `CONT-${state.pollCount}`, timeoutMs: 40}
            }],
            actions: [{
              addChatItemAction: {
                item: textRenderer(id, `message ${state.pollCount}`, state.pollCount % 2 === 0 ? 'UC_A' : 'UC_B')
              }
            }]
          }
        }
      });
    }
    return json(res, 404, {error: {code: 404}});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function fakeLogger(records) {
  const push = (level) => (record) => records.push({level, ...record});
  return {info: push('info'), warn: push('warn'), debug: push('debug'), error: push('error')};
}

function request(url, {method = 'GET', body = null} = {}) {
  return fetch(url, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

const ADAPTER_OPTIONS = Object.freeze({
  minPollIntervalMs: 10,
  maxPollIntervalMs: 40,
  metadataIntervalMs: 50,
  backoffBaseMs: 10,
  maxBackoffMs: 40,
  rateLimitMinBackoffMs: 10,
  maxRetryAfterMs: 100,
  maxConsecutiveFailures: 4,
  endConfirmDelayMs: 10,
  endProbeMinIntervalMs: 10
});

async function launch(videoId) {
  const fake = await startFakeWeb(videoId);
  const temp = createTempDir();
  const records = [];
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    youtubeWebBase: fake.base,
    youtubeAdapterOptions: ADAPTER_OPTIONS,
    logger: fakeLogger(records)
  });
  return {fake, temp, records, server, base: server.url};
}

async function summary(base, sessionId) {
  return (await fetch(`${base}api/sessions/${encodeURIComponent(sessionId)}`)).json();
}

async function youtubeStatus(base) {
  return (await fetch(`${base}api/youtube/status`)).json();
}

async function eventRows(base, sessionId) {
  const body = await (await fetch(`${base}api/events?sessionId=${encodeURIComponent(sessionId)}&limit=500`)).json();
  return body.events ?? [];
}

test('temporary failures keep one live session, then a confirmed platform end closes it once', async (t) => {
  const env = await launch(VIDEO);
  t.after(async () => {
    await env.server.close();
    env.temp.cleanup();
    await env.fake.close();
  });
  const {base, fake} = env;

  const connectResponse = await request(`${base}api/youtube/connect`, {
    method: 'POST',
    body: {url: `https://youtu.be/${VIDEO}`}
  });
  assert.equal(connectResponse.status, 201);
  const connected = await connectResponse.json();
  const sessionId = connected.session.id;

  await waitFor(async () => (await summary(base, sessionId)).stats.messages >= 3);
  const healthy = await summary(base, sessionId);
  assert.equal(healthy.session.status, 'live');

  // HTTP 429: bounded retries, still the same live session.
  fake.state.pollMode = '429';
  const rateLimited = await waitFor(async () => {
    const status = await youtubeStatus(base);
    return status.connection.state === 'failed' && status.connection.detail?.failures >= 4 ? status : null;
  });
  assert.equal(rateLimited.connection.detail.retrying, true);
  assert.equal(rateLimited.connection.detail.sessionPreserved, true);
  assert.ok(rateLimited.connection.detail.retryInMs >= 10);
  const duringOutage = await summary(base, sessionId);
  assert.equal(duringOutage.session.status, 'live');
  assert.equal(duringOutage.session.endReason, null);
  await sleep(120);
  assert.equal((await summary(base, sessionId)).stats.messages, duringOutage.stats.messages,
    'no messages are invented or lost while the transport is down');
  const recordings = await (await fetch(`${base}api/live/recordings`)).json();
  assert.ok(recordings.recordings.some((recording) => recording.sessionId === sessionId));

  // HTTP 500 and a malformed 200 also stay transient.
  fake.state.pollMode = '500';
  await waitFor(async () => {
    const status = await youtubeStatus(base);
    return status.connection.detail?.lastFailureCode === 'YOUTUBE_WEB_NETWORK'
      || status.connection.detail?.lastFailureCode === 'YOUTUBE_WEB_RESPONSE_INVALID';
  });
  fake.state.pollMode = 'invalid';
  await waitFor(async () => {
    const status = await youtubeStatus(base);
    return status.connection.detail?.lastFailureCode === 'YOUTUBE_WEB_RESPONSE_INVALID';
  });
  const stillLive = await summary(base, sessionId);
  assert.equal(stillLive.session.status, 'live');
  assert.equal(stillLive.stats.messages, duringOutage.stats.messages);

  // Recovery continues in the same session. A stale continuation forces a
  // chat-page reopen which replays msg-1; dedupe must absorb it.
  fake.state.pollMode = 'normal';
  await waitFor(async () => {
    const status = await youtubeStatus(base);
    return status.connection.state === 'connected' && status.connection.detail.failures === 0;
  });
  fake.state.pollMode = 'stale';
  await waitFor(async () => (await summary(base, sessionId)).stats.messages > healthy.stats.messages);
  const recovered = await summary(base, sessionId);
  assert.equal(recovered.session.status, 'live');
  assert.equal(recovered.session.id, sessionId);
  assert.ok(recovered.stats.activeViewers >= 2, 'viewer identities survive the outage');
  assert.ok(fake.state.openCount >= 2, 'the stale continuation required a chat-page reopen');
  const sessionCount = env.server.db.prepare(
    'SELECT COUNT(*) AS count FROM sessions WHERE platform_room_id = ?'
  ).get(VIDEO).count;
  assert.equal(sessionCount, 1, 'reconnecting must not create a second session');
  const rows = env.server.db.prepare(
    'SELECT external_id FROM events WHERE session_id = ?'
  ).all(sessionId);
  const ids = rows.map((row) => row.external_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'replayed messages must not be inserted twice');
  assert.equal(rows.length, recovered.stats.eventCount);

  // A confirmed platform end: the chat response is invalid and the watch page
  // says ended twice. The session ends with a platform reason, once.
  const beforeEnd = await summary(base, sessionId);
  fake.state.pollMode = 'invalid';
  fake.state.watchState = 'ended';
  const ended = await waitFor(async () => {
    const current = await summary(base, sessionId);
    return current.session.status === 'ended' ? current : null;
  });
  assert.equal(ended.session.endReason, 'platform_ended');
  assert.equal(ended.session.platformStatus, 'ended');
  assert.equal(ended.session.platformEndQuality, 'poll');
  assert.ok(ended.session.platformEndedAt > 0);
  assert.equal(ended.stats.eventCount, beforeEnd.stats.eventCount);
  assert.equal(ended.stats.messages, beforeEnd.stats.messages);
  assert.equal(ended.stats.activeViewers, beforeEnd.stats.activeViewers);
  assert.equal(env.server.db.prepare(
    'SELECT COUNT(*) AS count FROM sessions WHERE platform_room_id = ?'
  ).get(VIDEO).count, 1);
  const endLogs = env.records.filter((record) => record.event === 'youtube.anonymous.ended');
  assert.equal(endLogs.length, 1, 'onEnd must fire exactly once');
  const finalPollCount = fake.state.pollCount;
  await sleep(250);
  assert.equal(fake.state.pollCount, finalPollCount, 'no polling after a confirmed end');
  assert.equal((await summary(base, sessionId)).session.status, 'ended');
});

test('a user stop closes the capture immediately without a platform end', async (t) => {
  const env = await launch(VIDEO2);
  t.after(async () => {
    await env.server.close();
    env.temp.cleanup();
    await env.fake.close();
  });
  const {base} = env;
  const connectResponse = await request(`${base}api/youtube/connect`, {
    method: 'POST',
    body: {url: `https://youtu.be/${VIDEO2}`}
  });
  assert.equal(connectResponse.status, 201);
  const {session} = await connectResponse.json();
  await waitFor(async () => (await summary(base, session.id)).stats.messages >= 2);
  const before = await summary(base, session.id);

  const response = await request(`${base}api/youtube/disconnect`, {
    method: 'POST',
    body: {sessionId: session.id}
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.stopped, true);
  const after = await summary(base, session.id);
  assert.equal(after.session.status, 'ended');
  assert.equal(after.session.endReason, 'user');
  assert.ok(after.stats.eventCount >= before.stats.eventCount, 'a user stop keeps collected data');
  assert.ok(after.session.endedAt > 0);
  assert.equal(after.session.platformStatus, null, 'a user stop is not a platform end');
  const status = await youtubeStatus(base);
  assert.equal(status.connection.state, 'idle');
});
