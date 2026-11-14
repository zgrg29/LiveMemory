import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * HTTP lifecycle of persistent monitoring targets. The YouTube channel page is
 * served locally so no real platform request is made; the recording adapter is
 * not started because the fake channel is offline for the whole API test.
 */

const CHANNEL = 'UCabcdefghijklmnopqrstuv';

function channelPage() {
  const data = {
    metadata: {
      channelMetadataRenderer: {
        title: 'Alpha Channel',
        externalId: CHANNEL,
        canonicalBaseUrl: '/@alpha'
      }
    },
    contents: {}
  };
  return `<html><head><title>Alpha Channel - YouTube</title>
<meta property="og:title" content="Alpha Channel"></head><body>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify({})};</script>
</body></html>`;
}

async function startFakeWeb() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/@alpha') || req.url.startsWith(`/channel/${CHANNEL}`)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end(channelPage());
      return;
    }
    res.writeHead(404, {'content-type': 'text/plain'});
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('monitoring targets can be added, paused, resumed, inspected and deleted', async (t) => {
  const fake = await startFakeWeb();
  const temp = createTempDir();
  let server = await startServer({auth: false,
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

  const created = await request(`${base}api/monitoring`, {
    method: 'POST',
    body: {platform: 'youtube', input: 'https://www.youtube.com/@alpha'}
  });
  const createdBody = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const target = createdBody.target;
  assert.equal(target.platform, 'youtube');
  assert.equal(target.targetKey, CHANNEL);
  assert.equal(target.displayName, 'Alpha Channel');
  assert.equal(target.state, 'waiting');
  assert.equal(target.enabled, true);
  assert.equal(target.broadcasterId, `youtube:${CHANNEL}`);

  const duplicate = await request(`${base}api/monitoring`, {
    method: 'POST',
    body: {platform: 'youtube', input: CHANNEL}
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'MONITOR_TARGET_EXISTS');

  const list = await (await request(`${base}api/monitoring`)).json();
  assert.equal(list.targets.length, 1);
  assert.equal(list.summary.total, 1);
  assert.equal(list.summary.waiting, 1);
  assert.equal(list.targets[0].id, target.id);

  const status = await (await request(`${base}api/status`)).json();
  assert.equal(status.monitoring.enabled, true);
  assert.equal(status.monitoring.summary.total, 1);

  // A manual check goes through the detector and leaves the target waiting
  // because the fake channel page has no live player.
  const checked = await request(`${base}api/monitoring/${target.id}/check`, {method: 'POST', body: {}});
  assert.equal(checked.status, 200);
  const checkedBody = await checked.json();
  assert.equal(checkedBody.target.state, 'waiting');
  assert.ok(checkedBody.target.lastCheckAt > 0);
  assert.ok(fake.requests.some((url) => url.includes(`/channel/${CHANNEL}/live`)));

  const paused = await request(`${base}api/monitoring/${target.id}`, {
    method: 'PATCH',
    body: {action: 'pause'}
  });
  const pausedBody = await paused.json();
  assert.equal(pausedBody.target.state, 'paused');
  assert.equal(pausedBody.target.enabled, false);

  const refused = await request(`${base}api/monitoring/${target.id}/check`, {method: 'POST', body: {}});
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'MONITOR_TARGET_PAUSED');

  const resumed = await request(`${base}api/monitoring/${target.id}`, {
    method: 'PATCH',
    body: {action: 'resume'}
  });
  const resumedBody = await resumed.json();
  assert.equal(resumedBody.target.state, 'waiting');
  assert.equal(resumedBody.target.enabled, true);

  const sessions = await (await request(`${base}api/monitoring/${target.id}/sessions`)).json();
  assert.deepEqual(sessions.sessions, []);

  const noConfirm = await request(`${base}api/monitoring/${target.id}`, {method: 'DELETE', body: {}});
  assert.equal(noConfirm.status, 400);
  assert.equal((await noConfirm.json()).error.code, 'DELETE_CONFIRM_REQUIRED');

  const deleted = await request(`${base}api/monitoring/${target.id}`, {
    method: 'DELETE',
    body: {confirm: true}
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, true);
  const empty = await (await request(`${base}api/monitoring`)).json();
  assert.equal(empty.targets.length, 0);

  // The target is gone, but the server remains healthy.
  assert.equal((await request(`${base}api/health`)).status, 200);
});

test('enabled targets survive a restart and are recovered without a live session', async (t) => {
  const fake = await startFakeWeb();
  const temp = createTempDir();
  let server = await startServer({auth: false,
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
  const created = await (await request(`${server.url}api/monitoring`, {
    method: 'POST',
    body: {platform: 'youtube', input: '@alpha'}
  })).json();
  const id = created.target.id;
  await server.close();

  server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    youtubeWebBase: fake.base
  });
  const restored = await (await request(`${server.url}api/monitoring`)).json();
  assert.equal(restored.targets.length, 1);
  assert.equal(restored.targets[0].id, id);
  assert.equal(restored.targets[0].state, 'waiting');
  assert.equal(restored.targets[0].activeSessionId, null);
  assert.equal(restored.targets[0].enabled, true);
});
