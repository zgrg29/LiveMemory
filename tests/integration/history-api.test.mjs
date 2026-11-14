import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {createSession, endSession, getSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';

/**
 * HTTP-level history management: search, archive, stop through both endpoints,
 * permanent delete and the viewer drill-down.
 *
 * This is an automated local-server test (no external network). The only live
 * capture involved is the built-in simulator.
 */

const T0 = Date.parse('2026-11-09T10:00:00.000Z');

function jsonRequest(base, path, {method = 'GET', body} = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function seedHistory(db) {
  const broadcasterId = 'youtube:UC_HTTP';
  upsertBroadcaster(db, {
    id: broadcasterId,
    platform: 'youtube',
    platformUid: 'UC_HTTP',
    displayName: 'HTTP Channel',
    identity: 'verified',
    seenAt: T0,
    now: T0
  });
  const session = createSession(db, {
    platform: 'youtube',
    platformRoomId: 'http-video',
    roomTitle: 'HTTP 测试直播 English',
    broadcasterName: 'HTTP Channel',
    broadcasterId,
    broadcasterIdentity: 'verified',
    startedAt: T0,
    now: T0
  });
  const ingest = new EventIngest({db, now: () => T0 + 1000});
  ingest.record({
    session_id: session.id,
    platform: 'youtube',
    event_type: 'chat',
    viewer_uid: 'UC_HTTP_VIEWER',
    display_name: 'HTTP Viewer',
    occurred_at: T0 + 1000,
    content: 'hello from history',
    external_id: 'http-1'
  });
  ingest.record({
    session_id: session.id,
    platform: 'youtube',
    event_type: 'chat',
    viewer_uid: 'UC_HTTP_VIEWER',
    display_name: 'HTTP Viewer',
    occurred_at: T0 + 2000,
    content: 'second message',
    external_id: 'http-2'
  });
  endSession(db, session.id, {status: 'ended', endedAt: T0 + 3000, reason: 'adapter_end'});
  return session;
}

test('history HTTP API: search, archive, stop (both endpoints), delete and viewer drill-down', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const session = seedHistory(server.db);

  /* ----------------------------------------------------------------- search */

  const search = await (await fetch(`${base}api/history/search?q=HTTP%20%E6%B5%8B%E8%AF%95&includeArchived=1`)).json();
  assert.equal(search.total, 1);
  assert.equal(search.sessions[0].id, session.id);
  assert.equal(search.sessions[0].match.title, true);
  assert.equal(search.sessions[0].match.broadcaster, false);
  assert.equal(search.sessions[0].archived, false);

  const broadcasterSearch = await (await fetch(`${base}api/history/search?q=HTTP%20Channel&includeArchived=1`)).json();
  assert.equal(broadcasterSearch.total, 1);
  assert.equal(broadcasterSearch.sessions[0].match.broadcaster, true);

  const viewerSearch = await (await fetch(`${base}api/history/search?q=HTTP%20Viewer&scope=viewer&includeArchived=1`)).json();
  assert.equal(viewerSearch.total, 1);
  assert.equal(viewerSearch.sessions[0].matchedViewers[0].viewerId, 'youtube:UC_HTTP_VIEWER');
  assert.equal(viewerSearch.sessions[0].matchedViewers[0].messageCount, 2);

  const titleOnly = await (await fetch(`${base}api/history/search?q=HTTP&scope=title`)).json();
  assert.equal(titleOnly.total, 1);
  const filteredOut = await (await fetch(`${base}api/history/search?q=HTTP&platform=bilibili`)).json();
  assert.equal(filteredOut.total, 0);
  const filteredIn = await (await fetch(`${base}api/history/search?q=HTTP&platform=youtube&status=ended`)).json();
  assert.equal(filteredIn.total, 1);

  /* ---------------------------------------------------------------- archive */

  assert.equal((await fetch(`${base}api/history/search?q=HTTP`)).status, 200);
  const archiveResponse = await jsonRequest(base, `api/sessions/${session.id}/archive`, {
    method: 'POST',
    body: {archived: true}
  });
  assert.equal(archiveResponse.status, 200);
  const archived = await archiveResponse.json();
  assert.equal(archived.session.archived, true);
  assert.equal(archived.session.status, 'ended');
  assert.equal((await (await fetch(`${base}api/history/search?q=HTTP`)).json()).total, 0);
  const withArchived = await (await fetch(`${base}api/history/search?q=HTTP&includeArchived=1`)).json();
  assert.equal(withArchived.total, 1);
  assert.equal(withArchived.sessions[0].archived, true);
  const unarchive = await (await jsonRequest(base, `api/sessions/${session.id}/archive`, {
    method: 'POST',
    body: {archived: false}
  })).json();
  assert.equal(unarchive.session.archived, false);

  /* ----------------------------------------------------- viewer drill-down */

  const detail = await (await fetch(`${base}api/sessions/${session.id}/viewers/youtube:UC_HTTP_VIEWER`)).json();
  assert.equal(detail.participation.messageCount, 2);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].content, 'hello from history');
  assert.equal(detail.viewer.platformUid, 'UC_HTTP_VIEWER');

  /* -------------------------------------------------- stop through detail */

  const start = await jsonRequest(base, 'api/simulate/start', {
    method: 'POST',
    body: {title: 'Unique First Sim', speed: 'calm'}
  });
  assert.equal(start.status, 201);
  const live = (await start.json()).session;
  // A running capture cannot be archived or deleted.
  const archiveLive = await jsonRequest(base, `api/sessions/${live.id}/archive`, {
    method: 'POST',
    body: {archived: true}
  });
  assert.equal(archiveLive.status, 409);
  assert.equal((await archiveLive.json()).error.code, 'SESSION_ARCHIVE_LIVE');
  const deleteLive = await jsonRequest(base, `api/sessions/${live.id}`, {
    method: 'DELETE',
    body: {confirm: true}
  });
  assert.equal(deleteLive.status, 409);
  assert.equal((await deleteLive.json()).error.code, 'SESSION_STILL_RECORDING');

  const stopDetail = await jsonRequest(base, `api/sessions/${live.id}/stop`, {method: 'POST', body: {}});
  assert.equal(stopDetail.status, 200);
  const stopped = await stopDetail.json();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.session.status, 'ended');
  assert.equal(stopped.session.endReason, 'user');
  assert.equal((await (await fetch(`${base}api/live/recordings`)).json()).count, 0);
  const stopAgain = await jsonRequest(base, `api/sessions/${live.id}/stop`, {method: 'POST', body: {}});
  assert.equal(stopAgain.status, 409);
  assert.equal((await stopAgain.json()).error.code, 'SESSION_NOT_ACTIVE');

  /* ---------------------------------------------------- stop through list */

  const startAgain = await jsonRequest(base, 'api/simulate/start', {
    method: 'POST',
    body: {title: 'Unique Second Sim', speed: 'calm'}
  });
  assert.equal(startAgain.status, 201);
  const live2 = (await startAgain.json()).session;
  const stopList = await jsonRequest(base, `api/live/recordings/${live2.id}/stop`, {method: 'POST', body: {}});
  assert.equal(stopList.status, 200);
  assert.equal((await stopList.json()).session.endReason, 'user');
  assert.equal((await (await fetch(`${base}api/live/recordings`)).json()).count, 0);

  /* --------------------------------------------------------------- delete */

  const noConfirm = await jsonRequest(base, `api/sessions/${live.id}`, {method: 'DELETE', body: {}});
  assert.equal(noConfirm.status, 400);
  assert.equal((await noConfirm.json()).error.code, 'DELETE_CONFIRM_REQUIRED');

  const deletedResponse = await jsonRequest(base, `api/sessions/${live.id}`, {
    method: 'DELETE',
    body: {confirm: true}
  });
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.sessionId, live.id);
  assert.equal((await fetch(`${base}api/sessions/${live.id}`)).status, 404);
  assert.equal((await fetch(`${base}api/live/recordings`)).status, 200);
  assert.equal(getSession(server.db, live.id), null);

  const afterDelete = await (await fetch(`${base}api/history/search?q=Unique%20First%20Sim&includeArchived=1`)).json();
  assert.equal(afterDelete.total, 0);
  const viewerAfter = await fetch(`${base}api/sessions/${live.id}/viewers/youtube:UC_HTTP_VIEWER`);
  assert.equal(viewerAfter.status, 404);

  // The unrelated seeded session is untouched.
  assert.equal((await fetch(`${base}api/sessions/${session.id}`)).status, 200);
});
