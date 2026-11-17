import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {startServer} from '../../src/server/index.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {createKuaishouFetch, comment, feed, KUAISHOU_T0} from '../fixtures/kuaishou.mjs';

/**
 * Kuaishou HTTP API -> KuaishouService -> KuaishouAdapter (fake H5 fetch) ->
 * SQLite. No Kuaishou request is made. Feed/page shapes follow the G1 research
 * samples, so URL parsing, identity scoping, dedupe, multi-room isolation,
 * platform end, retention and the AI package are covered without claiming a new
 * live acceptance.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 5000, interval = 20, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${label}`);
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

const ROOMS = {
  alpha: {liveStreamId: 'L1', title: 'Alpha live'},
  beta: {liveStreamId: 'L2', title: 'Beta live'},
  offline: {},
  unknown: {generic: true},
  limited: {rateLimited: true}
};

function fakeFeeds() {
  return {
    L1: [
      feed({cursor: 'a1', feeds: [
        comment({userId: 12345, userName: '观众A', content: 'alpha one', time: KUAISHOU_T0 + 1}),
        comment({userId: 67890, userName: '观众B', content: 'alpha two', time: KUAISHOU_T0 + 2}),
        {type: 'gift', content: '', time: KUAISHOU_T0 + 3, author: {userId: 12345, userName: '观众A'}}
      ]}),
      feed({cursor: 'a2', feeds: [
        comment({userId: 12345, userName: '观众A', content: 'alpha one', time: KUAISHOU_T0 + 1}),
        comment({userId: 12345, userName: '观众A', content: 'alpha three', time: KUAISHOU_T0 + 4})
      ]})
    ],
    L2: [
      feed({cursor: 'b1', feeds: [
        comment({userId: 12345, userName: '观众A', content: 'beta one', time: KUAISHOU_T0 + 5})
      ]})
    ]
  };
}

async function startHarness(t, {
  enabled = true,
  feeds = fakeFeeds(),
  rooms = ROOMS,
  access = enabled
    ? {enabled: true, status: 'internal-authorized', authorizationRequired: false}
    : {enabled: false, status: 'authorization-required', authorizationRequired: true}
} = {}) {
  const temp = createTempDir('kuaishou-service-');
  const fetchImpl = createKuaishouFetch({rooms, feeds});
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    env: {},
    kuaishouAccess: access,
    kuaishouFetchImpl: fetchImpl,
    kuaishouAdapterOptions: {
      pollIntervalMs: 20,
      statusIntervalMs: 600000,
      maxConsecutiveFailures: 4,
      maxBackoffMs: 50
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  return {server, base: server.url, temp, fetchImpl};
}

async function events(server, sessionId) {
  return server.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY rowid').all(sessionId);
}

test('without authorisation the API exposes the preview, parses links offline and refuses collection', async (t) => {
  let networkCalls = 0;
  const temp = createTempDir('kuaishou-disabled-');
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    env: {},
    kuaishouAccess: {enabled: false, status: 'authorization-required', authorizationRequired: true},
    kuaishouFetchImpl: async () => {
      networkCalls += 1;
      throw new Error('no network request is allowed while collection is disabled');
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;

  const bootstrap = await (await jsonRequest(`${base}api/bootstrap`)).json();
  const capability = bootstrap.capabilities.platforms.find((entry) => entry.id === 'kuaishou');
  assert.equal(capability.state, 'preview');
  assert.equal(capability.captureEnabled, false);
  assert.equal(capability.authorizationRequired, true);
  assert.deepEqual(capability.events, ['chat']);
  assert.equal(capability.gifts, 'not-observed');
  assert.equal(capability.likes, 'not-observed');

  const status = await (await jsonRequest(`${base}api/kuaishou/status`)).json();
  assert.equal(status.available, true);
  assert.equal(status.access.enabled, false);
  assert.equal(status.access.authorizationRequired, true);
  assert.equal(status.transport.requiresLogin, false);
  assert.equal(status.transport.authorizationRequired, true);
  assert.equal(status.capabilities.chat, 'verified-research-sample');
  assert.equal(status.capabilities.gifts, 'not-observed');
  assert.equal(status.capabilities.likes, 'not-observed');
  assert.equal(status.capabilities.stableUserId, 'unproven');
  assert.equal(status.capabilities.captureWithoutAuthorization, false);
  assert.equal(status.policy.policy, 'kuaishou-raw-content');
  assert.equal(status.policy.days, 30);

  const parsed = await jsonRequest(`${base}api/kuaishou/room`, {
    method: 'POST',
    body: {url: 'https://live.kuaishou.com/u/alpha'}
  });
  assert.equal(parsed.status, 200);
  const room = (await parsed.json()).room;
  assert.equal(room.eid, 'alpha');
  assert.equal(room.recordable, false);
  assert.equal(room.liveStatus, 'unknown');
  assert.equal(room.reason, 'KUAISHOU_AUTHORIZATION_REQUIRED');
  assert.equal(room.authorization.enabled, false);

  const invalid = await jsonRequest(`${base}api/kuaishou/room`, {
    method: 'POST',
    body: {url: 'https://www.kuaishou.com/short-video/3xabc'}
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.messageKey, 'errors.kuaishouLinkInvalid');

  const refused = await jsonRequest(`${base}api/kuaishou/connect`, {
    method: 'POST',
    body: {url: 'https://live.kuaishou.com/u/alpha'}
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.messageKey, 'errors.kuaishouAuthorizationRequired');

  const retention = await (await jsonRequest(`${base}api/kuaishou/retention/apply`, {method: 'POST'})).json();
  assert.equal(retention.status.policy, 'kuaishou-raw-content');
  assert.equal(retention.status.days, 30);
  assert.equal(networkCalls, 0, 'the disabled service never touched the network');
});

test('with authorisation, room lookup, chat storage, dedupe and gift omission work end to end', async (t) => {
  const {base, server} = await startHarness(t);
  const status = await (await jsonRequest(`${base}api/kuaishou/status`)).json();
  assert.equal(status.access.enabled, true);
  assert.equal(status.transport.authorizationRequired, false);

  const live = await jsonRequest(`${base}api/kuaishou/room`, {
    method: 'POST',
    body: {url: 'https://live.kuaishou.com/u/alpha'}
  });
  assert.equal(live.status, 200);
  const liveRoom = (await live.json()).room;
  assert.equal(liveRoom.isLive, true);
  assert.equal(liveRoom.liveStreamId, 'L1');
  assert.equal(liveRoom.recordable, true);

  const offline = await jsonRequest(`${base}api/kuaishou/room`, {method: 'POST', body: {url: 'offline'}});
  assert.equal(offline.status, 200);
  assert.equal((await offline.json()).room.isLive, false);

  const unknown = await jsonRequest(`${base}api/kuaishou/room`, {method: 'POST', body: {url: 'unknown'}});
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).room.liveStatus, 'unknown');

  const limited = await jsonRequest(`${base}api/kuaishou/room`, {method: 'POST', body: {url: 'limited'}});
  assert.equal(limited.status, 200);
  assert.equal((await limited.json()).room.liveStatus, 'rate_limited');

  const started = await jsonRequest(`${base}api/kuaishou/connect`, {
    method: 'POST',
    body: {url: 'https://live.kuaishou.com/u/alpha'}
  });
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  const payload = await started.json();
  const sessionId = payload.session.id;
  assert.equal(payload.session.platform, 'kuaishou');
  assert.equal(payload.session.platformRoomId, 'alpha');
  assert.ok(['normal', 'waiting_events'].includes(payload.connection.category));

  await waitFor(async () => (await events(server, sessionId)).length >= 3, {label: 'chat rows'});
  const rows = await events(server, sessionId);
  assert.equal(rows.length, 3, 'the duplicate replay and the gift do not add rows');
  assert.ok(rows.every((row) => row.event_type === 'chat'));
  assert.ok(rows.every((row) => row.external_id === null), 'no message id is invented');
  assert.ok(rows.every((row) => row.source_quality === 'unknown'));
  assert.deepEqual(rows.map((row) => row.content).sort(), ['alpha one', 'alpha three', 'alpha two']);
  const expectedUid = (raw) => `kuaishou:h5:${raw}@${sessionId}`;
  assert.deepEqual(
    [...new Set(rows.map((row) => row.viewer_id))].sort(),
    [expectedUid(12345), expectedUid(67890)]
  );

  const summary = await (await jsonRequest(`${base}api/sessions/${sessionId}`)).json();
  assert.equal(summary.stats.messages, 3);
  assert.equal(summary.stats.giftEvents, 0, 'Kuaishou gifts are not claimed');

  const capture = await (await jsonRequest(`${base}api/kuaishou/status`)).json();
  assert.equal(capture.capture.chats, 3);
  assert.ok(capture.capture.duplicates >= 1, 'a replayed message is counted as a duplicate, never inserted again');
  assert.equal(capture.capture.ignored, 1);
  assert.equal(capture.capture.identity.mode, 'session-provisional');
  assert.equal(capture.capture.identity.stableUserId, 'unproven');
});

test('two Kuaishou rooms record independently and stopping one leaves the other alive', async (t) => {
  const {base, server} = await startHarness(t);
  const alpha = await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'alpha'}});
  const beta = await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'beta'}});
  assert.equal(alpha.status, 201);
  assert.equal(beta.status, 201);
  const alphaPayload = await alpha.json();
  const betaPayload = await beta.json();
  assert.notEqual(alphaPayload.session.id, betaPayload.session.id);

  await waitFor(async () => (await events(server, alphaPayload.session.id)).length >= 3);
  await waitFor(async () => (await events(server, betaPayload.session.id)).length >= 1);
  const alphaRows = await events(server, alphaPayload.session.id);
  const betaRows = await events(server, betaPayload.session.id);
  assert.deepEqual(betaRows.map((row) => row.content), ['beta one']);
  // The same raw platform id in two rooms is not merged: identity is session-scoped.
  assert.ok(alphaRows.every((row) => row.viewer_id.endsWith(`@${alphaPayload.session.id}`)));
  assert.ok(betaRows.every((row) => row.viewer_id.endsWith(`@${betaPayload.session.id}`)));

  const status = await (await jsonRequest(`${base}api/kuaishou/status`)).json();
  assert.equal(status.recordings.length, 2);
  assert.ok(status.recordings.every((row) => row.connection.state === 'connected'));

  const stopped = await (await jsonRequest(`${base}api/kuaishou/disconnect`, {
    method: 'POST',
    body: {sessionId: alphaPayload.session.id}
  })).json();
  assert.equal(stopped.stopped, true);
  const before = (await events(server, alphaPayload.session.id)).length;
  await sleep(150);
  assert.equal((await events(server, alphaPayload.session.id)).length, before, 'a stopped room accepts no late event');

  const remaining = await (await jsonRequest(`${base}api/live/recordings`)).json();
  assert.equal(remaining.recordings.filter((row) => row.platform === 'kuaishou').length, 1);
  const second = await (await jsonRequest(`${base}api/kuaishou/disconnect`, {
    method: 'POST',
    body: {sessionId: betaPayload.session.id}
  })).json();
  assert.equal(second.stopped, true);
});

test('the same raw user id is never merged across two Kuaishou sessions', async (t) => {
  const {base, server} = await startHarness(t);
  const first = await (await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'alpha'}})).json();
  await waitFor(async () => (await events(server, first.session.id)).length >= 3);
  await (await jsonRequest(`${base}api/kuaishou/disconnect`, {
    method: 'POST',
    body: {sessionId: first.session.id}
  })).json();

  const second = await (await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'alpha'}})).json();
  await waitFor(async () => (await events(server, second.session.id)).length >= 2);
  const firstRows = await events(server, first.session.id);
  const secondRows = await events(server, second.session.id);
  const firstViewer = firstRows.find((row) => row.viewer_uid.startsWith('h5:12345@')).viewer_id;
  const secondViewer = secondRows.find((row) => row.viewer_uid.startsWith('h5:12345@')).viewer_id;
  assert.notEqual(firstViewer, secondViewer);
  assert.match(firstViewer, new RegExp(`@${first.session.id}$`));
  assert.match(secondViewer, new RegExp(`@${second.session.id}$`));

  const viewers = server.db.prepare("SELECT id, platform_uid FROM viewers WHERE platform = 'kuaishou' ORDER BY id").all();
  assert.ok(viewers.some((row) => row.id === firstViewer));
  assert.ok(viewers.some((row) => row.id === secondViewer));
  assert.notEqual(
    server.db.prepare('SELECT platform_uid FROM viewers WHERE id = ?').get(firstViewer).platform_uid,
    server.db.prepare('SELECT platform_uid FROM viewers WHERE id = ?').get(secondViewer).platform_uid
  );
});

test('a platform end (result 601) closes the session and keeps the captured chat', async (t) => {
  const {base, server} = await startHarness(t, {
    feeds: {
      L1: [
        feed({feeds: [comment({content: 'before end', time: KUAISHOU_T0 + 1})]}),
        feed({result: 601, error_msg: '直播已停止'})
      ]
    }
  });
  const started = await (await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'alpha'}})).json();
  const sessionId = started.session.id;
  await waitFor(async () => {
    const row = server.db.prepare('SELECT status, end_reason FROM sessions WHERE id = ?').get(sessionId);
    return row?.status === 'ended';
  }, {label: 'session ended by feed result 601'});
  const rows = await events(server, sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'before end');
  const status = await (await jsonRequest(`${base}api/kuaishou/status`)).json();
  assert.equal(status.recordings.length, 0);
});

test('a Kuaishou session exports the same platform-agnostic AI package', async (t) => {
  const {base, server, temp} = await startHarness(t);
  const started = await (await jsonRequest(`${base}api/kuaishou/connect`, {method: 'POST', body: {url: 'alpha'}})).json();
  const sessionId = started.session.id;
  await waitFor(async () => (await events(server, sessionId)).length >= 3);
  await jsonRequest(`${base}api/kuaishou/disconnect`, {method: 'POST', body: {sessionId}});

  const result = await buildAnalysisPackage({
    db: server.db,
    sessionId,
    locale: 'en',
    exportsDir: join(temp.dir, 'exports'),
    now: Date.now()
  });
  assert.ok(result);
  const {manifest, messages, names} = await inspectAnalysisPackage(result.absolutePath);
  assert.equal(manifest.session_id, sessionId);
  assert.equal(manifest.counts.messages, 3);
  const parsed = messages.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 3);
  assert.ok(parsed.every((line) => line.message_id === null || line.message_id === undefined));
  assert.ok(parsed.every((line) => line.viewer_id.includes('@' + sessionId)));
  assert.ok(names.includes('session_context.json'));
  const sessionContext = JSON.parse(
    readZipEntry(readFileSync(result.absolutePath), 'session_context.json').toString('utf8')
  );
  assert.equal(sessionContext.session.platform, 'kuaishou');
  assert.equal(sessionContext.session.broadcaster_id, 'kuaishou:alpha');
  assert.ok(manifest.counts.viewers >= 2);
});
