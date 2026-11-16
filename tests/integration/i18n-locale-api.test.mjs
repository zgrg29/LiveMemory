import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * P39 / I18N-M0 API contract: the bootstrap locale list is generated from the
 * shared registry and the browser can import the exact same module. Tests use an
 * isolated data directory and never touch the user's real profile.
 */

function bootstrapToken(server) {
  const hash = new URL(server.browserUrl).hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('lm_bootstrap');
}

async function request(base, path, {method = 'GET', body, cookie} = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {response, payload, text};
}

async function authenticate(server) {
  const token = bootstrapToken(server);
  assert.ok(token, 'browserUrl must carry the one-time token');
  const {response, payload} = await request(server.url, 'api/auth/session', {method: 'POST', body: {token}});
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get('set-cookie').split(';')[0];
}

test('bootstrap locales come from the shared registry and survive a restart', async (t) => {
  const temp = createTempDir();
  let server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'zh-HK'});
  let firstClosed = false;
  t.after(async () => {
    if (!firstClosed) await server.close();
    temp.cleanup();
  });

  try {
    const cookie = await authenticate(server);
    const {response, payload} = await request(server.url, 'api/bootstrap', {cookie});
    assert.equal(response.status, 200);
    assert.deepEqual(payload.locales.available.map((entry) => entry.code), ['zh-CN', 'ja', 'en']);
    assert.deepEqual(payload.locales.available.map((entry) => entry.nativeName), ['简体中文', '日本語', 'English']);
    assert.equal(payload.locales.default, 'en');
    assert.equal(payload.locales.system, 'zh-HK');
    // A Traditional Chinese system without a zh-TW dictionary degrades to the
    // installed Chinese resource instead of failing.
    assert.equal(payload.effective.locale, 'zh-CN');

    for (const entry of payload.locales.available) {
      const dictionary = await request(server.url, `i18n/${entry.code}.json`);
      assert.equal(dictionary.response.status, 200, entry.code);
      assert.match(dictionary.response.headers.get('content-type'), /application\/json/);
      assert.equal(dictionary.payload.settings.language.zh, '简体中文');
    }

    const shared = await fetch(`${server.url}shared/locales.mjs`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get('content-type'), /text\/javascript/);
    const sharedSource = await shared.text();
    assert.match(sharedSource, /export const LOCALE_REGISTRY/);
    assert.match(sharedSource, /export const AVAILABLE_LOCALES/);

    const updated = await request(server.url, 'api/settings', {
      method: 'PATCH',
      cookie,
      body: {locale: 'ja'}
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.settings.locale, 'ja');
    assert.equal(updated.payload.effective.locale, 'ja');

    const invalid = await request(server.url, 'api/settings', {
      method: 'PATCH',
      cookie,
      body: {locale: 'ko-KR'}
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, 'SETTINGS_INVALID');

    const bootstrapAgain = await request(server.url, 'api/bootstrap', {cookie});
    assert.equal(bootstrapAgain.payload.settings.locale, 'ja');
  } finally {
    await server.close();
    firstClosed = true;
  }

  // Restart with a different system locale: the saved user preference wins.
  const restarted = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'de-DE'});
  try {
    const cookie = await authenticate(restarted);
    const {payload} = await request(restarted.url, 'api/bootstrap', {cookie});
    assert.equal(payload.settings.locale, 'ja');
    assert.equal(payload.effective.locale, 'ja');
    assert.equal(payload.locales.system, 'de-DE');
  } finally {
    await restarted.close();
  }
});

test('an unsupported system locale resolves to the default language', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'de-DE'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const cookie = await authenticate(server);
  const {payload} = await request(server.url, 'api/bootstrap', {cookie});
  assert.equal(payload.effective.locale, 'en');
  assert.equal(payload.locales.default, 'en');
});
