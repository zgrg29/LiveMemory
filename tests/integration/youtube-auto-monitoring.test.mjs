import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * End-to-end automatic YouTube monitoring against a local fake public web.
 *
 * It exercises the real channel detector, the real anonymous chat adapter, the
 * real monitoring scheduler and the real SessionManager/EventIngest. Nothing is
 * downloaded and no real YouTube request is made.
 */

const CHANNEL = `UC${'a'.repeat(22)}`;
const VIDEO_1 = 'autoLive001';
const VIDEO_2 = 'autoLive002';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 20000, interval = 100} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function request(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function channelHtml() {
  const data = {
    metadata: {
      channelMetadataRenderer: {
        title: 'Auto Channel',
        externalId: CHANNEL,
        canonicalBaseUrl: '/@auto'
      }
    },
    contents: {}
  };
  return `<html><head><title>Auto Channel - YouTube</title>
<meta property="og:title" content="Auto Channel"></head><body>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify({})};</script>
</body></html>`;
}

function watchHtml(videoId, ended = false) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId,
      title: `Auto broadcast ${videoId}`,
      author: 'Auto Channel',
      channelId: CHANNEL,
      isLive: !ended,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: !ended,
          startTimestamp: '2026-11-10T09:00:00.000Z',
          ...(ended ? {endTimestamp: '2026-11-10T10:00:00.000Z'} : {})
        }
      }
    }
  };
  return `<html><body><script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script></body></html>`;
}

const CONFIG = {
  INNERTUBE_API_KEY: 'AIzaFAKE_WEB_KEY',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {
    client: {clientName: 'WEB', clientVersion: '2.20990101.00.00', gl: 'US', hl: 'en', visitorData: 'VISITOR_AUTO'}
  }
};

function chatHtml(videoId) {
  const initial = {
    contents: {
      liveChatRenderer: {
        continuations: [{
          invalidationContinuationData: {continuation: `CONT-${videoId}-0`, timeoutMs: 800}
        }],
        actions: [{
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: `initial-${videoId}`,
                timestampUsec: '1794145000000000',
                authorName: {simpleText: 'Auto Viewer'},
                authorExternalChannelId: 'UC_AUTO_VIEWER',
                authorBadges: [],
                message: {runs: [{text: 'hello from auto monitoring'}]}
              }
            }
          }
        }]
      }
    }
  };
  return `<html><body><script>ytcfg.set(${JSON.stringify(CONFIG)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startFakeWeb() {
  const state = {live: true, ended: false, videoId: VIDEO_1, polls: 0};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const respond = (status, body, type = 'application/json') => {
      res.writeHead(status, {'content-type': type});
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/@auto') return respond(200, channelHtml(), 'text/html');
    if (req.method === 'GET' && url.pathname === '/watch') {
      return respond(200, watchHtml(state.videoId, state.ended), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === `/channel/${CHANNEL}/live`) {
      return respond(200, state.live ? watchHtml(state.videoId, state.ended) : channelHtml(), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === `/channel/${CHANNEL}`) {
      return respond(200, channelHtml(), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/live_chat') {
      return respond(200, chatHtml(state.videoId), 'text/html');
    }
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      const body = JSON.parse(await readBody(req) || '{}');
      state.polls += 1;
      if (state.ended) return respond(200, JSON.stringify({continuationContents: {}}));
      return respond(200, JSON.stringify({
        continuationContents: {
          liveChatContinuation: {
            continuations: [{
              invalidationContinuationData: {continuation: String(body.continuation ?? 'CONT'), timeoutMs: 800}
            }],
            actions: []
          }
        }
      }));
    }
    return respond(404, JSON.stringify({error: {code: 404}}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('a YouTube channel is monitored across two independent broadcasts', async (t) => {
  const fake = await startFakeWeb();
  const temp = createTempDir();
  const server = await startServer({auth: false,
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

  const created = await (await request(`${base}api/monitoring`, {
    method: 'POST',
    body: {platform: 'youtube', input: 'https://www.youtube.com/@auto'}
  })).json();
  const target = created.target;
  assert.equal(target.targetKey, CHANNEL);
  assert.equal(target.displayName, 'Auto Channel');

  const checked = await request(`${base}api/monitoring/${target.id}/check`, {method: 'POST', body: {}});
  if (checked.status !== 200) {
    assert.fail(`check failed: ${checked.status} ${JSON.stringify(await checked.json())}`);
  }

  const recordings = await waitFor(async () => {
    const payload = await (await request(`${base}api/live/recordings`)).json();
    return payload.recordings.length === 1 ? payload : null;
  });
  const session1 = recordings.recordings[0].sessionId;
  assert.equal(recordings.recordings[0].monitorTargetId, target.id);
  assert.equal(recordings.recordings[0].platformRoomId, VIDEO_1);

  const events = await waitFor(async () => {
    const payload = await (await request(`${base}api/events?sessionId=${session1}&limit=50`)).json();
    return payload.events.length > 0 ? payload.events : null;
  });
  assert.ok(events.some((event) => event.content === 'hello from auto monitoring'));

  const row = await (await request(`${base}api/sessions/${session1}`)).json();
  assert.equal(row.session.monitorTargetId, target.id);
  assert.equal(row.session.broadcasterId, `youtube:${CHANNEL}`);
  assert.equal(row.session.platformRoomId, VIDEO_1);

  // The fake chat reports an end. The adapter ends the capture; the target must
  // return to waiting without losing the session.
  fake.state.ended = true;
  const waiting = await waitFor(async () => {
    const payload = await (await request(`${base}api/monitoring`)).json();
    const current = payload.targets.find((entry) => entry.id === target.id);
    return current?.state === 'waiting' ? current : null;
  }, {timeout: 25000});
  assert.equal(waiting.activeSessionId, null);
  assert.equal(waiting.lastSessionId, session1);
  const ended = await (await request(`${base}api/sessions/${session1}`)).json();
  assert.notEqual(ended.session.status, 'live');

  // Second broadcast: a new video id, a new independent session, same target.
  fake.state.ended = false;
  fake.state.live = true;
  fake.state.videoId = VIDEO_2;
  const second = await request(`${base}api/monitoring/${target.id}/check`, {method: 'POST', body: {}});
  assert.equal(second.status, 200);
  const recordings2 = await waitFor(async () => {
    const payload = await (await request(`${base}api/live/recordings`)).json();
    return payload.recordings.length === 1 && payload.recordings[0].sessionId !== session1 ? payload : null;
  });
  const session2 = recordings2.recordings[0].sessionId;
  assert.notEqual(session2, session1);
  assert.equal(recordings2.recordings[0].platformRoomId, VIDEO_2);

  const targetSessions = await (await request(`${base}api/monitoring/${target.id}/sessions?limit=10`)).json();
  assert.equal(targetSessions.sessions.length, 2);
  assert.deepEqual(new Set(targetSessions.sessions.map((entry) => entry.id)), new Set([session1, session2]));

  const after = await (await request(`${base}api/monitoring`)).json();
  const current = after.targets.find((entry) => entry.id === target.id);
  assert.equal(current.state, 'recording');
  assert.equal(current.activeSessionId, session2);
  assert.equal(after.summary.recording, 1);
});
