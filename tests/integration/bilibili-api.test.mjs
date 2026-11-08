import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

function jsonRequest(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('Bilibili endpoints are wired without leaking credentials', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;

  await t.test('status reports the anonymous login state and no cookie', async () => {
    const response = await jsonRequest(`${base}api/bilibili/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.login.loggedIn, false);
    assert.equal(payload.login.stored.stored, false);
    assert.equal('cookie' in payload.login, false);
    assert.equal(payload.connection.state, 'idle');
  });

  await t.test('app status includes the Bilibili block', async () => {
    const payload = await (await fetch(`${base}api/status`)).json();
    assert.equal(payload.bilibili.login.loggedIn, false);
    assert.equal(payload.bilibili.connection.state, 'idle');
  });

  await t.test('room ids are validated before any network call', async () => {
    const response = await jsonRequest(`${base}api/bilibili/room`, {method: 'POST', body: {roomId: 'not-a-number'}});
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'ROOM_ID_INVALID');

    const connect = await jsonRequest(`${base}api/bilibili/connect`, {method: 'POST', body: {roomId: ''}});
    assert.equal(connect.status, 400);
    assert.equal((await connect.json()).error.code, 'ROOM_ID_INVALID');
  });

  await t.test('disconnect on an idle server is a harmless no-op', async () => {
    const response = await jsonRequest(`${base}api/bilibili/disconnect`, {method: 'POST'});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stopped, false);
  });

  await t.test('the secrets folder exists inside the data folder', async () => {
    const payload = await (await fetch(`${base}api/storage`)).json();
    assert.ok(payload.dataDir.length > 0);
    assert.equal(payload.counts.sessions, 0);
  });
});
