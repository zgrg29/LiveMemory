import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  AUTH_COOKIE,
  createAuthService,
  isPublicApiPath,
  parseCookies
} from '../../src/server/auth.mjs';

function deterministicBytes() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return createHash('sha256').update(`token-${counter}`).digest().subarray(0, size);
  };
}

function cookieValue(setCookie) {
  const match = new RegExp(`${AUTH_COOKIE}=([^;]+)`).exec(setCookie);
  return match?.[1] ?? null;
}

function requestWithCookie(cookie) {
  return {headers: {cookie: `${AUTH_COOKIE}=${cookie}`}};
}

test('a bootstrap token is one-time and yields an HttpOnly SameSite=Strict cookie', () => {
  let clock = 1_000;
  const auth = createAuthService({now: () => clock, randomBytesImpl: deterministicBytes()});
  const browserUrl = auth.browserUrl('http://127.0.0.1:48000/');
  assert.match(browserUrl, /#lm_bootstrap=/);
  assert.doesNotMatch(browserUrl, /\?lm_bootstrap=/);
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');

  const exchanged = auth.exchange(token);
  assert.equal(exchanged.ok, true);
  assert.match(exchanged.cookie, /HttpOnly/);
  assert.match(exchanged.cookie, /SameSite=Strict/);
  assert.match(exchanged.cookie, /Path=\//);
  assert.doesNotMatch(exchanged.cookie, /Secure/);

  const cookie = cookieValue(exchanged.cookie);
  assert.ok(cookie);
  assert.deepEqual(auth.authenticate(requestWithCookie(cookie)), {ok: true, enabled: true});

  assert.equal(auth.exchange(token).ok, false);
  assert.equal(auth.exchange(token).reason, 'used');
  clock += 1;
  assert.deepEqual(auth.authenticate(requestWithCookie(cookie)), {ok: true, enabled: true});
});

test('an expired bootstrap link and an expired session are rejected', () => {
  let clock = 10_000;
  const auth = createAuthService({
    now: () => clock,
    randomBytesImpl: deterministicBytes(),
    bootstrapTtlMs: 1000,
    sessionTtlMs: 2000
  });
  const token = new URL(auth.browserUrl('http://127.0.0.1:48000/')).hash.replace(/^#lm_bootstrap=/, '');
  clock += 1500;
  const expiredBootstrap = auth.exchange(token);
  assert.equal(expiredBootstrap.ok, false);
  assert.equal(expiredBootstrap.reason, 'expired');

  const fresh = createAuthService({
    now: () => clock,
    randomBytesImpl: deterministicBytes(),
    bootstrapTtlMs: 1000,
    sessionTtlMs: 2000
  });
  const freshToken = new URL(fresh.browserUrl('http://127.0.0.1:48000/')).hash.replace(/^#lm_bootstrap=/, '');
  const exchanged = fresh.exchange(freshToken);
  const cookie = cookieValue(exchanged.cookie);
  clock += 2500;
  const expiredSession = fresh.authenticate(requestWithCookie(cookie));
  assert.equal(expiredSession.ok, false);
  assert.equal(expiredSession.reason, 'expired');
});

test('wrong cookies, missing cookies and invalidated sessions disclose nothing', () => {
  const auth = createAuthService({now: () => 1000, randomBytesImpl: deterministicBytes()});
  assert.equal(auth.authenticate({headers: {}}).ok, false);
  assert.equal(auth.authenticate(requestWithCookie('wrong')).ok, false);
  auth.invalidateSessions();
  assert.equal(auth.authenticate(requestWithCookie('wrong')).ok, false);
  assert.equal(auth.status().sessionActive, false);
});

test('auth can be disabled only for in-process test fixtures', () => {
  const auth = createAuthService({enabled: false});
  assert.equal(auth.enabled, false);
  assert.deepEqual(auth.authenticate({headers: {}}), {ok: true, enabled: false});
  assert.equal(auth.exchange('anything').ok, false);
  assert.equal(auth.browserUrl('http://127.0.0.1:48000/'), 'http://127.0.0.1:48000/');
});

test('public API paths are limited to health and the auth handshake', () => {
  assert.equal(isPublicApiPath('/api/health'), true);
  assert.equal(isPublicApiPath('/api/auth/status'), true);
  assert.equal(isPublicApiPath('/api/auth/session'), true);
  for (const path of [
    '/api/bootstrap',
    '/api/status',
    '/api/viewers',
    '/api/settings',
    '/api/events/stream',
    '/api/storage/location',
    '/api/sessions/x/stop'
  ]) {
    assert.equal(isPublicApiPath(path), false, path);
  }
});

test('cookie parsing ignores malformed fragments and keeps valid names', () => {
  const cookies = parseCookies('a=1; broken; lm_session=abc; =empty');
  assert.equal(cookies.a, '1');
  assert.equal(cookies[AUTH_COOKIE], 'abc');
  assert.equal(cookies[''], undefined);
});
