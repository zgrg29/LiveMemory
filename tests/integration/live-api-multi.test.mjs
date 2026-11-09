import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * HTTP-level concurrency test with two independent public-web YouTube streams.
 *
 * A local fake web server reproduces the public watch/chat pages for two
 * different channel ids. It is an automated simulation of the transport, not a
 * real YouTube capture. The test exercises the real adapters, ingest pipeline,
 * SQLite reads and HTTP APIs used by the tabbed live page.
 */

const VIDEO_A = 'multiA00001';
const VIDEO_B = 'multiB00001';
const CHANNEL_A = 'UC_MULTI_CHANNEL_A';
const CHANNEL_B = 'UC_MULTI_CHANNEL_B';
const SHARED_UID = 'UC_SHARED_VIEWER';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 20000, interval = 150} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function jsonRequest(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)});
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(body);
}

const config = {
  INNERTUBE_API_KEY: 'AIzaFAKE_WEB_KEY',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20990101.00.00',
      gl: 'US',
      hl: 'en',
      visitorData: 'VISITOR_MULTI'
    }
  }
};

function watchHtml(video) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId: video.id,
      title: video.title,
      author: video.channelName,
      channelId: video.channelId,
      isLive: true,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: true,
          startTimestamp: '2026-11-09T09:00:00.000Z'
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
                viewCount: {videoViewCountRenderer: {viewCount: {simpleText: '321 watching now'}}}
              }
            }]
          }
        }
      }
    }
  };
  return `<html><body><script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></body></html>`;
}

function textAction({id, uid, name, text, timestampUsec}) {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          timestampUsec: String(timestampUsec),
          authorName: {simpleText: name},
          authorExternalChannelId: uid,
          authorBadges: [],
          message: {runs: [{text}]}
        }
      }
    }
  };
}

function buildInitialActions(video) {
  const actions = [];
  let timestamp = 1794145000000000;
  let counter = 0;
  const speak = (uid, name, count, prefix) => {
    for (let index = 0; index < count; index += 1) {
      counter += 1;
      timestamp += 1000;
      actions.push(textAction({
        id: `${prefix}-${counter}`,
        uid,
        name,
        text: `${prefix} message ${counter}`,
        timestampUsec: timestamp
      }));
    }
  };
  if (video.key === 'a') {
    speak('UC_MULTI_TOP', 'Top Viewer', 5, 'a-top');
    speak('UC_MULTI_SECOND', 'Second Viewer', 3, 'a-second');
    speak('UC_MULTI_TWIN_A', 'Same Name', 2, 'a-twin-a');
    speak('UC_MULTI_TWIN_B', 'Same Name', 2, 'a-twin-b');
    speak(SHARED_UID, 'Shared Viewer', 1, 'a-shared');
    for (let index = 0; index < 118; index += 1) {
      speak(`UC_MULTI_${String(index).padStart(3, '0')}`, `Viewer ${index}`, 1, 'a-viewer');
    }
  } else {
    for (let index = 0; index < 12; index += 1) {
      speak(`UC_MULTI_B_${String(index).padStart(3, '0')}`, `B Viewer ${index}`, 1, 'b-viewer');
    }
    speak(SHARED_UID, 'Shared Viewer', 1, 'b-shared');
  }
  return actions;
}

function chatHtml(video) {
  const initial = {
    contents: {
      liveChatRenderer: {
        continuations: [{
          invalidationContinuationData: {
            continuation: `CONT-${video.key.toUpperCase()}-0`,
            timeoutMs: 2000
          }
        }],
        actions: buildInitialActions(video)
      }
    }
  };
  return `<html><body><script>ytcfg.set(${JSON.stringify(config)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startFakeWeb() {
  const videos = new Map([
    [VIDEO_A, {key: 'a', id: VIDEO_A, channelId: CHANNEL_A, channelName: 'Multi Channel A', title: 'Multi stream A'}],
    [VIDEO_B, {key: 'b', id: VIDEO_B, channelId: CHANNEL_B, channelName: 'Multi Channel B', title: 'Multi stream B'}]
  ]);
  let releaseB = false;
  let bExtraSent = false;
  const polls = {a: 0, b: 0};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const videoId = url.searchParams.get('v');
    const video = videos.get(videoId);
    if (req.method === 'GET' && url.pathname === '/watch' && video) return html(res, watchHtml(video));
    if (req.method === 'GET' && url.pathname === '/live_chat' && video) return html(res, chatHtml(video));
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        body = {};
      }
      const continuation = String(body.continuation ?? '');
      if (continuation.startsWith('CONT-A')) {
        polls.a += 1;
        return json(res, 200, {
          continuationContents: {
            liveChatContinuation: {
              continuations: [{invalidationContinuationData: {continuation, timeoutMs: 2000}}],
              actions: []
            }
          }
        });
      }
      if (continuation.startsWith('CONT-B')) {
        polls.b += 1;
        const actions = [];
        if (releaseB && !bExtraSent) {
          bExtraSent = true;
          actions.push(textAction({
            id: 'b-live-after-a-stop',
            uid: 'UC_MULTI_B_LIVE',
            name: 'B Late Viewer',
            text: 'arrived while A was stopped',
            timestampUsec: 1794146000000000
          }));
        }
        return json(res, 200, {
          continuationContents: {
            liveChatContinuation: {
              continuations: [{invalidationContinuationData: {continuation, timeoutMs: 1000}}],
              actions
            }
          }
        });
      }
      return json(res, 200, {});
    }
    return json(res, 404, {error: {code: 404}});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    polls,
    releaseB() { releaseB = true; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function liveRecordings(base) {
  return jsonRequest(`${base}api/live/recordings`).then((response) => response.json());
}

test('two YouTube broadcasts record concurrently, switch independently and survive a restart', async (t) => {
  const fake = await startFakeWeb();
  const temp = createTempDir();
  let server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    youtubeWebBase: fake.base
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
    await fake.close();
  });
  const base = server.url;

  const connect = async (videoId) => {
    const response = await jsonRequest(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url: `https://youtu.be/${videoId}`}
    });
    return {status: response.status, payload: await response.json()};
  };

  const aConnect = await connect(VIDEO_A);
  const bConnect = await connect(VIDEO_B);
  assert.equal(aConnect.status, 201, JSON.stringify(aConnect.payload));
  assert.equal(bConnect.status, 201, JSON.stringify(bConnect.payload));
  const sessionA = aConnect.payload.session.id;
  const sessionB = bConnect.payload.session.id;
  assert.notEqual(sessionA, sessionB);

  await t.test('the recordings endpoint lists both independent live tasks', async () => {
    const payload = await waitFor(async () => {
      const value = await liveRecordings(base);
      const states = value.recordings.map((recording) => recording.connection.state);
      return value.count === 2 && states.every((state) => state === 'connected') ? value : null;
    });
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.recordings.map((recording) => recording.sessionId).sort(), [sessionA, sessionB].sort());
    assert.ok(payload.recordings.every((recording) => recording.platform === 'youtube'));
    assert.ok(payload.recordings.every((recording) => recording.broadcasterId.startsWith('youtube:UC_MULTI_CHANNEL_')));
    assert.equal(payload.connection, 'connected');
  });

  await t.test('each stream ingests only its own events', async () => {
    const eventsA = await waitFor(async () => {
      const body = await (await fetch(`${base}api/events?sessionId=${sessionA}&limit=500`)).json();
      return body.events.length >= 131 ? body.events : null;
    });
    const eventsB = await waitFor(async () => {
      const body = await (await fetch(`${base}api/events?sessionId=${sessionB}&limit=500`)).json();
      return body.events.length >= 13 ? body.events : null;
    });
    assert.ok(eventsA.every((event) => event.sessionId === sessionA));
    assert.ok(eventsB.every((event) => event.sessionId === sessionB));
    assert.ok(eventsA.some((event) => event.viewerId === 'youtube:UC_MULTI_TOP'));
    assert.equal(eventsB.some((event) => event.viewerId === 'youtube:UC_MULTI_TOP'), false);
    assert.ok(eventsB.some((event) => event.viewerId === 'youtube:UC_MULTI_B_000'));

    const summaryA = await (await fetch(`${base}api/sessions/${sessionA}`)).json();
    const summaryB = await (await fetch(`${base}api/sessions/${sessionB}`)).json();
    assert.equal(summaryA.stats.messages, 131);
    assert.equal(summaryB.stats.messages, 13);
    assert.notEqual(summaryA.session.broadcasterId, summaryB.session.broadcasterId);
  });

  await t.test('closing the browser event stream does not stop any recording', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}api/events/stream`, {signal: controller.signal});
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await sleep(300);
    const payload = await liveRecordings(base);
    assert.equal(payload.count, 2);
    assert.ok(payload.recordings.every((recording) => recording.connection.state === 'connected'));
    const summaryA = await (await fetch(`${base}api/sessions/${sessionA}`)).json();
    const summaryB = await (await fetch(`${base}api/sessions/${sessionB}`)).json();
    assert.equal(summaryA.session.status, 'live');
    assert.equal(summaryB.session.status, 'live');
  });

  await t.test('starting the same live room twice is refused without touching the other recording', async () => {
    const duplicate = await connect(VIDEO_A);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.payload.error.code, 'SESSION_DUPLICATE_ROOM');
    assert.equal(duplicate.payload.error.details.sessionId, sessionA);
    const payload = await liveRecordings(base);
    assert.equal(payload.count, 2);
    assert.ok(payload.recordings.some((recording) => recording.sessionId === sessionA));
    assert.ok(payload.recordings.some((recording) => recording.sessionId === sessionB));
  });

  await t.test('the leaderboard exposes the top 100 with stable identity ranks and search', async () => {
    const leaderboard = await (await fetch(`${base}api/sessions/${sessionA}/top-viewers?limit=100`)).json();
    assert.equal(leaderboard.limit, 100);
    assert.equal(leaderboard.total, 123);
    assert.equal(leaderboard.viewers.length, 100);
    assert.equal(leaderboard.viewers[0].rank, 1);
    assert.equal(leaderboard.viewers[0].viewerId, 'youtube:UC_MULTI_TOP');
    assert.equal(leaderboard.viewers[0].messageCount, 5);
    assert.equal(leaderboard.viewers[1].viewerId, 'youtube:UC_MULTI_SECOND');
    assert.equal(leaderboard.viewers[1].messageCount, 3);
    assert.equal(leaderboard.viewers.at(-1).rank, 100);
    assert.ok(leaderboard.viewers.every((row) => row.viewerId.startsWith('youtube:')));

    const twins = leaderboard.viewers.filter((row) => row.nickname === 'Same Name');
    assert.equal(twins.length, 2);
    assert.deepEqual(twins.map((row) => row.viewerId).sort(), ['youtube:UC_MULTI_TWIN_A', 'youtube:UC_MULTI_TWIN_B']);

    const search = await (await fetch(`${base}api/sessions/${sessionA}/top-viewers?limit=100&query=Top`)).json();
    assert.equal(search.viewers.length, 1);
    assert.equal(search.viewers[0].rank, 1);

    const again = await (await fetch(`${base}api/sessions/${sessionA}/top-viewers?limit=100`)).json();
    assert.deepEqual(
      leaderboard.viewers.map((row) => row.viewerId),
      again.viewers.map((row) => row.viewerId)
    );

    const summary = await (await fetch(`${base}api/sessions/${sessionA}?topLimit=100`)).json();
    assert.equal(summary.top.speakers.length, 100);

    // Ranking is session-scoped: B has its own much smaller list.
    const leaderboardB = await (await fetch(`${base}api/sessions/${sessionB}/top-viewers?limit=100`)).json();
    assert.equal(leaderboardB.total, 13);
    assert.equal(leaderboardB.viewers.length, 13);
  });

  await t.test('a shared platform identity keeps two separate broadcaster contexts', async () => {
    const scopedA = await (await fetch(`${base}api/viewers/youtube:${SHARED_UID}?broadcasterId=youtube:${CHANNEL_A}`)).json();
    const scopedB = await (await fetch(`${base}api/viewers/youtube:${SHARED_UID}?broadcasterId=youtube:${CHANNEL_B}`)).json();
    assert.equal(scopedA.scope.messageCount, 1);
    assert.equal(scopedB.scope.messageCount, 1);
    assert.equal(scopedA.viewer.messageCount, 2);
    assert.equal(scopedA.broadcasters.length, 2);
    assert.deepEqual(
      scopedA.broadcasters.map((row) => row.id).sort(),
      [`youtube:${CHANNEL_A}`, `youtube:${CHANNEL_B}`].sort()
    );
  });

  await t.test('stopping A leaves B connected and still ingesting', async () => {
    const stopped = await jsonRequest(`${base}api/live/recordings/${sessionA}/stop`, {method: 'POST', body: {}});
    assert.equal(stopped.status, 200);
    const stoppedPayload = await stopped.json();
    assert.equal(stoppedPayload.stopped, true);
    assert.equal(stoppedPayload.session.status, 'ended');

    const afterStop = await liveRecordings(base);
    assert.equal(afterStop.count, 1);
    assert.equal(afterStop.recordings[0].sessionId, sessionB);
    assert.equal(afterStop.recordings[0].connection.state, 'connected');

    const before = await (await fetch(`${base}api/sessions/${sessionB}`)).json();
    fake.releaseB();
    const after = await waitFor(async () => {
      const value = await (await fetch(`${base}api/sessions/${sessionB}`)).json();
      return value.stats.messages > before.stats.messages ? value : null;
    });
    assert.equal(after.session.status, 'live');
    assert.ok(after.stats.messages >= 14);
    const eventsB = await (await fetch(`${base}api/events?sessionId=${sessionB}&limit=100`)).json();
    assert.ok(eventsB.events.some((event) => event.viewerId === 'youtube:UC_MULTI_B_LIVE'));

    const summaryA = await (await fetch(`${base}api/sessions/${sessionA}`)).json();
    assert.equal(summaryA.session.status, 'ended');
    assert.equal(summaryA.stats.messages, 131);
    assert.ok(fake.polls.b >= 1);
  });

  await t.test('stopping B ends the last recording', async () => {
    const response = await jsonRequest(`${base}api/live/recordings/${sessionB}/stop`, {method: 'POST', body: {}});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session.status, 'ended');
    const payload = await liveRecordings(base);
    assert.equal(payload.count, 0);
    assert.equal(payload.connection, 'idle');
  });

  await t.test('a restart marks any live row interrupted and never re-creates a recording', async () => {
    const again = await connect(VIDEO_A);
    assert.equal(again.status, 201);
    const liveSession = again.payload.session.id;
    await waitFor(async () => {
      const body = await (await fetch(`${base}api/events?sessionId=${liveSession}&limit=5`)).json();
      return body.events.length > 0;
    });

    await server.close();
    server = await startServer({
      dataDir: temp.dir,
      port: 0,
      systemLocale: 'en',
      youtubeWebBase: fake.base
    });
    const restarted = server.url;
    const payload = await (await fetch(`${restarted}api/live/recordings`)).json();
    assert.equal(payload.count, 0);
    assert.equal(payload.connection, 'idle');
    const session = await (await fetch(`${restarted}api/sessions/${liveSession}`)).json();
    assert.equal(session.session.status, 'interrupted');
    const all = await (await fetch(`${restarted}api/sessions?limit=20`)).json();
    assert.equal(all.sessions.length, 3);
  });
});
