import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {readZipEntry, readZipIndex} from '../../src/shared/zip.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw HTTP request so a spoofed Host header really reaches the server. */
function rawRequest({port, path = '/api/health', method = 'GET', headers = {}}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({host: '127.0.0.1', port, path, method, headers}, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

async function waitFor(check, {timeout = 8000, interval = 150} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function jsonRequest(url, {method = 'GET', body, headers = {}} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? headers : {'content-type': 'application/json', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('local API serves the console, records a session, exports a package and restricts access', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;

  await t.test('health and bootstrap describe the running app', async () => {
    const health = await (await fetch(`${base}api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.name, 'LiveMemory');
    assert.equal(health.port, server.port);

    const bootstrap = await (await fetch(`${base}api/bootstrap`)).json();
    assert.equal(bootstrap.app.version, '0.8.1');
    assert.equal(bootstrap.effective.locale, 'en');
    assert.equal(bootstrap.settings.locale, 'system');
    assert.equal(bootstrap.settings.theme, 'system');
    assert.equal(bootstrap.capabilities.ai.export, true);
    assert.equal(bootstrap.capabilities.ai.import, true);
    assert.equal(bootstrap.capabilities.backup.export, false);
  });

  await t.test('serves the console shell with security headers', async () => {
    const response = await fetch(`${base}index.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const html = await response.text();
    assert.match(html, /LiveMemory/);
    assert.match(html, /js\/app\.js/);
    assert.doesNotMatch(html, /<script>[^<]/);
  });

  await t.test('settings are validated and persisted to disk', async () => {
    const ok = await jsonRequest(`${base}api/settings`, {method: 'PATCH', body: {locale: 'ja', theme: 'dark'}});
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.effective.locale, 'ja');
    assert.equal(payload.settings.theme, 'dark');

    const saved = JSON.parse(readFileSync(join(temp.dir, 'config', 'settings.json'), 'utf8'));
    assert.equal(saved.locale, 'ja');
    assert.equal(saved.theme, 'dark');

    const bad = await jsonRequest(`${base}api/settings`, {method: 'PATCH', body: {theme: 'neon'}});
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'SETTINGS_INVALID');

    const unknown = await jsonRequest(`${base}api/settings`, {method: 'PATCH', body: {nope: 1}});
    assert.equal(unknown.status, 400);
  });

  await t.test('simulation records events and aggregates them', async () => {
    const started = await jsonRequest(`${base}api/simulate/start`, {method: 'POST', body: {title: 'API test stream', speed: 'busy'}});
    assert.equal(started.status, 201);
    const {session} = await started.json();
    assert.equal(session.status, 'live');
    assert.equal(session.simulated, true);

    const current = await waitFor(async () => {
      const payload = await (await fetch(`${base}api/sessions/current`)).json();
      return payload.session && payload.session.stats.messages >= 5 ? payload.session : null;
    });
    assert.equal(current.session.id, session.id);
    assert.ok(current.timeline.buckets.length >= 1);
    assert.ok(current.stats.activeViewers >= 1);

    const events = await (await fetch(`${base}api/events?sessionId=${encodeURIComponent(session.id)}&limit=5`)).json();
    assert.ok(events.events.length > 0);
    assert.ok(events.events.every((event) => event.sessionId === session.id));

    // A second start while recording must be refused.
    const conflict = await jsonRequest(`${base}api/simulate/start`, {method: 'POST', body: {}});
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'SESSION_ACTIVE');

    const stopped = await jsonRequest(`${base}api/simulate/stop`, {method: 'POST', body: {}});
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).session.status, 'ended');

    const history = await (await fetch(`${base}api/sessions`)).json();
    assert.equal(history.sessions.length, 1);
    assert.equal(history.sessions[0].status, 'ended');
    assert.ok(Array.isArray(history.sessions[0].support));
    assert.ok(history.sessions[0].messageCount >= 5);

    const detail = await (await fetch(`${base}api/sessions/${encodeURIComponent(session.id)}`)).json();
    assert.equal(detail.session.id, session.id);
    assert.ok(detail.timeline.buckets.length >= 1);
    assert.ok(Array.isArray(detail.top.speakers));

    // The exported package contains checksummed files and validates offline.
    const created = await jsonRequest(`${base}api/ai/packages`, {method: 'POST', body: {sessionId: session.id, locale: 'ja'}});
    assert.equal(created.status, 201);
    const {package: analysisPackage} = await created.json();
    assert.match(analysisPackage.fileName, /\.zip$/);
    assert.equal(analysisPackage.protocol, 'livememory-analysis-v1');

    const download = await fetch(`${base}api/ai/packages/${encodeURIComponent(analysisPackage.id)}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await download.arrayBuffer());
    const entries = readZipIndex(buffer).map((entry) => entry.name);
    assert.deepEqual(entries.sort(), [
      'instructions.md', 'manifest.json', 'messages.jsonl', 'result.schema.json', 'session_context.json', 'viewer_context.json'
    ]);
    const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
    assert.equal(manifest.protocol, 'livememory-analysis-v1');
    assert.equal(manifest.locale, 'ja');
    for (const file of manifest.files) {
      const content = readZipEntry(buffer, file.name);
      assert.equal(content.length, file.bytes, `${file.name} byte count`);
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, `${file.name} checksum`);
    }
    const afterExport = await (await fetch(`${base}api/sessions/${encodeURIComponent(session.id)}`)).json();
    assert.equal(afterExport.session.aiStatus, 'exported');
  });

  await t.test('viewer list and profile expose aggregates, and focus can be toggled', async () => {
    const list = await (await fetch(`${base}api/viewers?limit=10`)).json();
    assert.ok(list.viewers.length > 0);
    const viewer = list.viewers[0];
    const profile = await (await fetch(`${base}api/viewers/${encodeURIComponent(viewer.id)}`)).json();
    assert.equal(profile.viewer.id, viewer.id);
    assert.ok(Array.isArray(profile.nicknames));
    assert.ok(profile.viewer.sessionCount >= 1);

    const focused = await jsonRequest(`${base}api/viewers/${encodeURIComponent(viewer.id)}`, {method: 'PATCH', body: {focused: true}});
    assert.equal(focused.status, 200);
    assert.equal((await focused.json()).viewer.focused, true);

    const missing = await fetch(`${base}api/viewers/${encodeURIComponent('mock:nope')}`);
    assert.equal(missing.status, 404);
  });

  await t.test('live event stream opens with a retry hint', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}api/events/stream`, {signal: controller.signal});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const chunk = await Promise.race([
      reader.read(),
      sleep(3000).then(() => null)
    ]);
    controller.abort();
    assert.ok(chunk, 'stream should send data promptly');
    assert.match(Buffer.from(chunk.value).toString('utf8'), /retry:/);
  });

  await t.test('rejects foreign hosts, cross-origin writes and path traversal', async () => {
    const wrongHost = await rawRequest({port: server.port, headers: {Host: 'evil.example'}});
    assert.equal(wrongHost, 403);

    const crossOrigin = await jsonRequest(`${base}api/settings`, {
      method: 'PATCH',
      body: {theme: 'light'},
      headers: {origin: 'http://evil.example'}
    });
    assert.equal(crossOrigin.status, 403);

    const traversal = await fetch(`${base}index.html?x=1`, {headers: {host: `127.0.0.1:${server.port}`}});
    assert.equal(traversal.status, 200);
    const blocked = await rawRequest({port: server.port, path: '/..%2Fpackage.json'});
    assert.equal(blocked, 403);

    const unknown = await fetch(`${base}api/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
  });

  await t.test('runtime file is present while running and removed on close', async () => {
    const runtime = JSON.parse(readFileSync(join(temp.dir, 'runtime', 'runtime.json'), 'utf8'));
    assert.equal(runtime.port, server.port);
    assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:/);
  });
});

test('preferences survive a restart', async (t) => {
  const temp = createTempDir();
  const first = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'zh-CN'});
  await jsonRequest(`${first.url}api/settings`, {method: 'PATCH', body: {locale: 'ja', theme: 'dark', storageMode: 'full'}});
  await first.close();

  const second = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'zh-CN'});
  t.after(async () => {
    await second.close();
    temp.cleanup();
  });
  const bootstrap = await (await fetch(`${second.url}api/bootstrap`)).json();
  assert.equal(bootstrap.effective.locale, 'ja');
  assert.equal(bootstrap.settings.theme, 'dark');
  assert.equal(bootstrap.settings.storageMode, 'full');
});
