import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {createLogger} from '../../src/server/logger.mjs';

/**
 * RC0 P0-5 security regression.
 *
 * Every test uses an isolated data directory under tests/.tmp and a real HTTP
 * server. No production database or live recording is touched.
 */

async function jsonRequest(base, path, {
  method = 'GET',
  body = undefined,
  cookie = null,
  origin = undefined,
  fetchSite = undefined,
  headers = {}
} = {}) {
  const requestHeaders = {...headers};
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (cookie) requestHeaders.cookie = cookie;
  if (origin !== undefined) requestHeaders.origin = origin;
  if (fetchSite) requestHeaders['sec-fetch-site'] = fetchSite;
  const response = await fetch(`${base}${path.replace(/^\//, '')}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {status: response.status, payload, headers: response.headers, text};
}

function bootstrapToken(server) {
  const hash = new URL(server.browserUrl).hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('lm_bootstrap');
}

async function exchange(server) {
  const token = bootstrapToken(server);
  assert.ok(token, 'server.browserUrl must carry a one-time bootstrap token');
  const response = await jsonRequest(server.url, 'api/auth/session', {method: 'POST', body: {token}});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/);
  return {token, cookie: setCookie.split(';')[0], setCookie};
}

function rawStatus({port, path = '/api/health', method = 'GET', headers = {}}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({host: '127.0.0.1', port, path, method, headers}, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function openSse(port, cookie = null) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events/stream',
      headers: cookie ? {cookie, accept: 'text/event-stream'} : {accept: 'text/event-stream'}
    }, (response) => {
      const status = response.statusCode;
      const type = response.headers['content-type'] ?? null;
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (status === 200 && text.includes('event: hello')) {
          request.destroy();
          response.destroy();
          resolve({status, type, text});
        }
      });
      response.on('end', () => resolve({status, type, text}));
    });
    request.on('error', reject);
    request.end();
  });
}

test('local API requires a browser session and rejects cross-site requests', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  const base = server.url;
  // The bootstrap token is one-time: establish the browser session once and
  // reuse its cookie across the subtests (multiple pages share the cookie).
  const {cookie} = await exchange(server);
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  await t.test('unauthenticated reads of personal data return 401', async () => {
    for (const path of [
      'api/bootstrap',
      'api/status',
      'api/settings',
      'api/viewers',
      'api/sessions',
      'api/storage/location',
      'api/backup/status',
      'api/ai/providers',
      'api/monitoring'
    ]) {
      const response = await jsonRequest(base, path);
      assert.equal(response.status, 401, path);
      assert.equal(response.payload?.error?.code, 'AUTH_REQUIRED', path);
    }
  });

  await t.test('unauthenticated writes and dangerous operations return 401', async () => {
    const cases = [
      ['PATCH', 'api/settings', {theme: 'dark'}],
      ['POST', 'api/simulate/start', {title: 'unauthorized'}],
      ['DELETE', 'api/sessions/ses_missing', {confirm: true}],
      ['POST', 'api/sessions/ses_missing/stop', {}],
      ['POST', 'api/storage/location', {targetDir: 'relative/path'}],
      ['POST', 'api/storage/clear', {mode: 'data', confirmText: 'DELETE'}],
      ['POST', 'api/backup/create', {path: 'relative.livememory'}],
      ['POST', 'api/backup/inspect', {path: 'C:\\backup.livememory'}],
      ['POST', 'api/backup/restore', {path: 'C:\\backup.livememory', confirmText: 'RESTORE'}],
      ['POST', 'api/backup/jobs/job_missing/cancel', {}],
      ['POST', 'api/backup/open', {}],
      ['POST', 'api/memory/viewers/viewer_missing/delete', {confirm: true}]
    ];
    for (const [method, path, body] of cases) {
      const response = await jsonRequest(base, path, {method, body});
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.payload?.error?.code, 'AUTH_REQUIRED', `${method} ${path}`);
    }
  });

  await t.test('SSE cannot bypass authentication', async () => {
    const response = await openSse(server.port);
    assert.equal(response.status, 401);
    assert.match(response.type ?? '', /application\/json/);
    assert.doesNotMatch(response.type ?? '', /event-stream/);
  });

  await t.test('forged Origin, Origin:null and cross-site fetch metadata are rejected', async () => {
    const forged = await jsonRequest(base, 'api/viewers', {cookie, origin: 'http://evil.example'});
    assert.equal(forged.status, 403);
    const nullOrigin = await jsonRequest(base, 'api/viewers', {cookie, origin: 'null'});
    assert.equal(nullOrigin.status, 403);
    const crossSite = await jsonRequest(base, 'api/viewers', {cookie, fetchSite: 'cross-site'});
    assert.equal(crossSite.status, 403);
  });

  await t.test('a malicious Host header is rejected before authentication', async () => {
    assert.equal(await rawStatus({port: server.port, headers: {host: 'evil.example'}}), 403);
  });

  await t.test('invalid session cookies and invalid bootstrap tokens are rejected', async () => {
    const badCookie = await jsonRequest(base, 'api/status', {cookie: 'lm_session=not-a-real-token'});
    assert.equal(badCookie.status, 401);
    const badToken = await jsonRequest(base, 'api/auth/session', {method: 'POST', body: {token: 'not-a-real-token'}});
    assert.equal(badToken.status, 401);
    assert.equal(badToken.payload?.error?.code, 'AUTH_REQUIRED');
  });

  await t.test('the browser URL uses a fragment, never a query parameter', async () => {
    assert.match(server.browserUrl, /#lm_bootstrap=/);
    assert.doesNotMatch(server.browserUrl, /\?lm_bootstrap=/);
    assert.doesNotMatch(server.url, /lm_bootstrap/);
    assert.ok(server.auth.status().sessionActive);
  });

  await t.test('a normal browser session completes core operations', async () => {
    const sessionStatus = await jsonRequest(base, 'api/auth/status', {cookie});
    assert.equal(sessionStatus.status, 200);
    assert.equal(sessionStatus.payload.authenticated, true);

    assert.equal((await jsonRequest(base, 'api/bootstrap', {cookie})).status, 200);
    assert.equal((await jsonRequest(base, 'api/viewers', {cookie})).status, 200);
    assert.equal((await jsonRequest(base, 'api/storage/location', {cookie})).status, 200);

    const settings = await jsonRequest(base, 'api/settings', {
      method: 'PATCH',
      cookie,
      body: {locale: 'ja', theme: 'dark'}
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.payload.effective.locale, 'ja');
    assert.equal(settings.payload.settings.theme, 'dark');

    const started = await jsonRequest(base, 'api/simulate/start', {
      method: 'POST',
      cookie,
      body: {title: 'P0-5 authorized session'}
    });
    assert.equal(started.status, 201, JSON.stringify(started.payload));
    const sessionId = started.payload.session.id;

    const current = await jsonRequest(base, 'api/sessions/current', {cookie});
    assert.equal(current.status, 200);
    assert.equal(current.payload.session.session.id, sessionId);

    const events = await jsonRequest(base, `api/events?sessionId=${encodeURIComponent(sessionId)}&limit=5`, {cookie});
    assert.equal(events.status, 200);

    const stream = await openSse(server.port, cookie);
    assert.equal(stream.status, 200);
    assert.match(stream.type ?? '', /event-stream/);
    assert.match(stream.text, /event: hello/);

    const stopped = await jsonRequest(base, `api/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      cookie,
      body: {}
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.payload.stopped, true);

    const archived = await jsonRequest(base, `api/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: 'POST',
      cookie,
      body: {archived: true}
    });
    assert.equal(archived.status, 200);

    const deleted = await jsonRequest(base, `api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      cookie,
      body: {confirm: true}
    });
    assert.equal(deleted.status, 200);
  });

  await t.test('dangerous routes still validate after authentication', async () => {
    const badLocation = await jsonRequest(base, 'api/storage/location', {
      method: 'POST',
      cookie,
      body: {targetDir: 'relative/path'}
    });
    assert.equal(badLocation.status, 400, JSON.stringify(badLocation.payload));
    assert.equal(badLocation.payload?.error?.code, 'RELOCATION_INVALID');

    const badClear = await jsonRequest(base, 'api/storage/clear', {
      method: 'POST',
      cookie,
      body: {mode: 'data', confirmText: 'WRONG'}
    });
    assert.equal(badClear.status, 400);
    assert.equal(badClear.payload?.error?.code, 'CONFIRM_TEXT_MISMATCH');

    const badDelete = await jsonRequest(base, 'api/sessions/ses_missing', {
      method: 'DELETE',
      cookie,
      body: {confirm: false}
    });
    assert.equal(badDelete.status, 400);
    assert.equal(badDelete.payload?.error?.code, 'DELETE_CONFIRM_REQUIRED');
  });

  await t.test('a valid session remains valid for multiple pages and SSE connections', async () => {
    const [first, second] = await Promise.all([
      openSse(server.port, cookie),
      openSse(server.port, cookie)
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const [readOne, readTwo] = await Promise.all([
      jsonRequest(base, 'api/status', {cookie}),
      jsonRequest(base, 'api/bootstrap', {cookie})
    ]);
    assert.equal(readOne.status, 200);
    assert.equal(readTwo.status, 200);
  });

  await t.test('invalidation rejects the old cookie immediately', async () => {
    assert.equal((await jsonRequest(base, 'api/status', {cookie})).status, 200);
    server.auth.invalidateSessions();
    const rejected = await jsonRequest(base, 'api/status', {cookie});
    assert.equal(rejected.status, 401);
    assert.equal(rejected.payload?.error?.code, 'AUTH_REQUIRED');
  });
});

test('restart invalidates old credentials and a new launch establishes a new session', async (t) => {
  const temp = createTempDir();
  const first = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  const {cookie: oldCookie, token: oldToken} = await exchange(first);
  assert.equal((await jsonRequest(first.url, 'api/status', {cookie: oldCookie})).status, 200);
  await first.close();

  const second = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await second.close();
    temp.cleanup();
  });

  const oldCookieResponse = await jsonRequest(second.url, 'api/status', {cookie: oldCookie});
  assert.equal(oldCookieResponse.status, 401);
  const oldTokenResponse = await jsonRequest(second.url, 'api/auth/session', {
    method: 'POST',
    body: {token: oldToken}
  });
  assert.equal(oldTokenResponse.status, 401);

  const fresh = await exchange(second);
  const freshStatus = await jsonRequest(second.url, 'api/status', {cookie: fresh.cookie});
  assert.equal(freshStatus.status, 200);
  const freshStream = await openSse(second.port, fresh.cookie);
  assert.equal(freshStream.status, 200);

  // One-time token: replaying the same launcher link after the exchange fails.
  const replay = await jsonRequest(second.url, 'api/auth/session', {
    method: 'POST',
    body: {token: fresh.token}
  });
  assert.equal(replay.status, 401);
});

test('provider keys and auth credentials are not written to logs or unrelated responses', async (t) => {
  const temp = createTempDir();
  const logger = createLogger({dir: join(temp.dir, 'logs')});
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en', logger});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const {cookie, token: bootstrap} = await exchange(server);
  const secret = 'sk-p0-5-provider-secret-1234567890';
  server.providerConfigStore.create({
    providerId: 'deepseek',
    regionId: 'global',
    modelId: 'deepseek-chat',
    name: 'P0-5 provider',
    apiKey: secret,
    pricingStatus: 'unknown'
  });

  const providers = await jsonRequest(server.url, 'api/ai/providers', {cookie});
  assert.equal(providers.status, 200);
  assert.doesNotMatch(providers.text, new RegExp(secret));
  assert.doesNotMatch(providers.text, new RegExp(bootstrap));

  const configText = readFileSync(join(temp.dir, 'config', 'ai-providers.json'), 'utf8');
  assert.doesNotMatch(configText, new RegExp(secret));

  // Failed auth attempts must not log the supplied token/cookie either.
  await jsonRequest(server.url, 'api/auth/session', {method: 'POST', body: {token: 'wrong-token-value'}});
  await jsonRequest(server.url, 'api/viewers', {cookie: 'lm_session=wrong-cookie-value'});
  const logFiles = readdirSync(join(temp.dir, 'logs')).filter((name) => name.endsWith('.log'));
  assert.ok(logFiles.length > 0);
  const allLogs = logFiles.map((name) => readFileSync(join(temp.dir, 'logs', name), 'utf8')).join('\n');
  assert.doesNotMatch(allLogs, new RegExp(secret));
  assert.doesNotMatch(allLogs, new RegExp(bootstrap));
  assert.doesNotMatch(allLogs, /wrong-cookie-value/);
  assert.doesNotMatch(allLogs, /wrong-token-value/);
  assert.doesNotMatch(allLogs, /lm_session=/);
  assert.doesNotMatch(allLogs, /Set-Cookie/i);
});
