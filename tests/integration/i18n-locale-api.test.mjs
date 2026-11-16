import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * P40 / I18N-M1 API contract: the bootstrap locale list is generated from the
 * shared registry, the browser imports the exact same module, and the ten
 * interface languages are persisted/restored while the AI output subset stays
 * separate. Tests use an isolated data directory and never touch the user's real
 * profile.
 */

const TEN_CODES = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];
const TEN_NAMES = [
  '简体中文', '日本語', 'English', '한국어', 'Español',
  'Português (Brasil)', '繁體中文', 'Français', 'Deutsch', 'Bahasa Indonesia'
];

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

test('bootstrap locales expose all ten languages and survive a restart', async (t) => {
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
    assert.deepEqual(payload.locales.available.map((entry) => entry.code), TEN_CODES);
    assert.deepEqual(payload.locales.available.map((entry) => entry.nativeName), TEN_NAMES);
    assert.equal(payload.locales.default, 'en');
    assert.equal(payload.locales.system, 'zh-HK');
    // P40: a Traditional Chinese system now resolves to the shipped zh-TW.
    assert.equal(payload.effective.locale, 'zh-TW');
    // The AI output list is the aiOutput subset, never the ten UI languages.
    assert.deepEqual(payload.locales.aiOutput.map((entry) => entry.code), ['zh-CN', 'ja', 'en']);

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
    assert.match(sharedSource, /export const AI_OUTPUT_LOCALES/);

    for (const locale of ['ko', 'de', 'pt-BR', 'zh-TW']) {
      const updated = await request(server.url, 'api/settings', {
        method: 'PATCH',
        cookie,
        body: {locale}
      });
      assert.equal(updated.response.status, 200, locale);
      assert.equal(updated.payload.settings.locale, locale);
      assert.equal(updated.payload.effective.locale, locale);
      const reloaded = await request(server.url, 'api/bootstrap', {cookie});
      assert.equal(reloaded.payload.effective.locale, locale, `${locale} must persist`);
    }

    const backToJa = await request(server.url, 'api/settings', {
      method: 'PATCH',
      cookie,
      body: {locale: 'ja'}
    });
    assert.equal(backToJa.payload.effective.locale, 'ja');

    const invalid = await request(server.url, 'api/settings', {
      method: 'PATCH',
      cookie,
      body: {locale: 'th-TH'}
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

test('a legacy three-language setting keeps working after the upgrade', async (t) => {
  const temp = createTempDir();
  // Exactly what a pre-P40 install has on disk.
  const {writeFileSync, mkdirSync} = await import('node:fs');
  const {join} = await import('node:path');
  mkdirSync(join(temp.dir, 'config'), {recursive: true});
  writeFileSync(join(temp.dir, 'config', 'settings.json'), JSON.stringify({locale: 'zh-CN', theme: 'dark'}));
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'ja-JP'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const cookie = await authenticate(server);
  const {payload} = await request(server.url, 'api/bootstrap', {cookie});
  assert.equal(payload.settings.locale, 'zh-CN');
  assert.equal(payload.effective.locale, 'zh-CN');
  assert.equal(payload.settings.theme, 'dark');
});

test('system locale resolution covers every shipped language family', async (t) => {
  const temp = createTempDir();
  const cases = [
    ['de-DE', 'de'],
    ['fr-FR', 'fr'],
    ['ko-KR', 'ko'],
    ['es-419', 'es'],
    ['pt-PT', 'pt-BR'],
    ['zh-Hant', 'zh-TW'],
    ['id-ID', 'id'],
    ['th-TH', 'en']
  ];
  for (const [systemLocale, expected] of cases) {
    const server = await startServer({dataDir: temp.dir, port: 0, systemLocale});
    try {
      const cookie = await authenticate(server);
      const {payload} = await request(server.url, 'api/bootstrap', {cookie});
      assert.equal(payload.effective.locale, expected, systemLocale);
      assert.equal(payload.locales.system, systemLocale);
    } finally {
      await server.close();
    }
  }
  temp.cleanup();
});
