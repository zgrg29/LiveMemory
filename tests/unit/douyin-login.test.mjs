import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinLogin, LOGIN_STATES, diagnoseCookie} from '../../src/platforms/douyin/login.mjs';
import {DouyinCookieStore, hasDouyinSession, sanitizeDouyinCookie} from '../../src/platforms/douyin/cookie-store.mjs';

const VALID_COOKIE = 'sessionid=abcdefgh12345678; sessionid_ss=abcdefgh12345678; ttwid=t; sid_tt=s; uid_tt=u';

function response(body, {status = 200, contentType = 'application/json'} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        return null;
      }
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function memoryStore(seed = null) {
  let saved = seed;
  return {
    load: () => saved,
    save: ({cookie, user, verified = null, verifiedAt = null, reason = null}) => {
      saved = {cookie, user, verified, verifiedAt, reason, savedAt: 1};
      return {savedAt: 1};
    },
    status: () => ({
      stored: Boolean(saved),
      user: saved?.user ?? null,
      savedAt: saved?.savedAt ?? null,
      verified: saved?.verified ?? null,
      verifiedAt: saved?.verifiedAt ?? null
    }),
    clear: () => { saved = null; },
    raw: () => saved
  };
}

function validPayload(name = '测试账号') {
  return {status_code: 0, user: {nickname: name, uid: '1234567890'}};
}

test('diagnoseCookie separates format, incomplete and expired values', () => {
  assert.equal(diagnoseCookie('').code, 'DOUYIN_COOKIE_FORMAT');
  assert.equal(diagnoseCookie('not a cookie').code, 'DOUYIN_COOKIE_FORMAT');
  assert.equal(diagnoseCookie('ttwid=abc').code, 'DOUYIN_COOKIE_INCOMPLETE');
  assert.equal(diagnoseCookie('sessionid=short; ttwid=t').code, 'DOUYIN_COOKIE_INCOMPLETE');
  const expired = diagnoseCookie('sessionid=abcdefgh12345678; ttwid=t; sid_guard=x|1000000000|y', {
    now: Date.UTC(2026, 0, 1)
  });
  assert.equal(expired.code, 'DOUYIN_LOGIN_EXPIRED');
  const ok = diagnoseCookie(`Cookie: ${VALID_COOKIE}`);
  assert.equal(ok.ok, true);
  assert.match(ok.cookie, /sessionid=abcdefgh12345678/);
  assert.doesNotMatch(ok.cookie, /^Cookie:/);
});

test('anonymous status is honest and never exposes a cookie', () => {
  const login = new DouyinLogin({store: memoryStore()});
  const status = login.status();
  assert.equal(status.loggedIn, false);
  assert.equal(status.state, LOGIN_STATES.ANONYMOUS);
  assert.equal(status.cookiePresent, false);
  assert.equal(JSON.stringify(status).includes('sessionid'), false);
  assert.equal(JSON.stringify(status).includes('abcdefgh'), false);
});

test('a valid cookie is saved only after Douyin confirms the session', async () => {
  const store = memoryStore();
  let calls = 0;
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => {
      calls += 1;
      return response(validPayload());
    }
  });
  const result = await login.applyCookie(VALID_COOKIE);
  assert.equal(calls, 1);
  assert.equal(result.verified, true);
  assert.equal(result.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(login.loggedIn, true);
  assert.equal(store.raw().verified, true);
  assert.equal(store.raw().user.name, '测试账号');
  assert.equal(JSON.stringify(login.status()).includes('sessionid'), false);
});

test('a definitive not-logged-in answer is a failure, not a saved login', async () => {
  const store = memoryStore();
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => response({status_code: 8, status_msg: '用户未登录'})
  });
  await assert.rejects(login.applyCookie(VALID_COOKIE), (error) => error.code === 'DOUYIN_AUTH');
  assert.equal(login.loggedIn, false);
  assert.equal(store.raw(), null);
});

test('a missing companion cookie on an invalid session is reported as incomplete', async () => {
  const login = new DouyinLogin({
    store: memoryStore(),
    fetchImpl: async () => response({status_code: 8, status_msg: '用户未登录'})
  });
  await assert.rejects(
    login.applyCookie('sessionid=abcdefgh12345678'),
    (error) => error.code === 'DOUYIN_COOKIE_INCOMPLETE'
  );
});

test('an expired sid_guard is rejected before any network request', async () => {
  let calls = 0;
  const login = new DouyinLogin({
    store: memoryStore(),
    now: () => Date.UTC(2026, 10, 15),
    fetchImpl: async () => {
      calls += 1;
      return response(validPayload());
    }
  });
  await assert.rejects(
    login.applyCookie('sessionid=abcdefgh12345678; ttwid=t; sid_guard=x|1000000000|y'),
    (error) => error.code === 'DOUYIN_LOGIN_EXPIRED'
  );
  assert.equal(calls, 0);
});

test('a platform refusal saves the cookie as unverified instead of claiming success', async () => {
  const store = memoryStore();
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => response({data: {error_code: 4031, description: '安全风险'}})
  });
  const result = await login.applyCookie(VALID_COOKIE);
  assert.equal(result.verified, false);
  assert.equal(result.savedUnverified, true);
  assert.equal(result.state, LOGIN_STATES.SAVED_UNVERIFIED);
  assert.equal(login.loggedIn, false);
  assert.equal(login.sessionAvailable, true);
  assert.equal(store.raw().verified, null);
});

test('a network error saves the cookie as unverified and can be re-checked later', async () => {
  const store = memoryStore();
  let offline = true;
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => {
      if (offline) throw new Error('offline');
      return response(validPayload());
    }
  });
  const result = await login.applyCookie(VALID_COOKIE);
  assert.equal(result.savedUnverified, true);
  assert.equal(result.warningKey, 'errors.douyinCookieNetwork');
  offline = false;
  const checked = await login.checkStored();
  assert.equal(checked.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(store.raw().verified, true);
});

test('checking a stored invalid session marks it expired and keeps that state visible', async () => {
  const store = memoryStore({
    cookie: VALID_COOKIE,
    user: null,
    verified: null,
    verifiedAt: null,
    savedAt: 1
  });
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => response({status_code: 8, status_msg: '用户未登录'})
  });
  const checked = await login.checkStored();
  assert.equal(checked.state, LOGIN_STATES.INVALID);
  assert.equal(login.loggedIn, false);
  assert.equal(login.sessionAvailable, false);
  assert.equal(store.raw().verified, false);
});

test('an inconclusive re-check keeps the previous verified state and says so', async () => {
  const store = memoryStore({
    cookie: VALID_COOKIE,
    user: {name: 'A'},
    verified: true,
    verifiedAt: 1,
    savedAt: 1
  });
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => response('<html>安全验证</html>', {contentType: 'text/html'})
  });
  const checked = await login.checkStored();
  assert.equal(checked.inconclusive, true);
  assert.equal(checked.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(login.loggedIn, true);
  assert.equal(login.sessionAvailable, true);
});

test('logout clears the encrypted store and returns to anonymous', async () => {
  const store = memoryStore({
    cookie: VALID_COOKIE,
    user: {name: 'A'},
    verified: true,
    verifiedAt: 1,
    savedAt: 1
  });
  const login = new DouyinLogin({store});
  assert.equal(login.loggedIn, true);
  await login.logout();
  assert.equal(login.loggedIn, false);
  assert.equal(login.state, LOGIN_STATES.ANONYMOUS);
  assert.equal(store.raw(), null);
});

test('cookie helpers never accept a short or absent session id', () => {
  assert.equal(hasDouyinSession('ttwid=abc'), false);
  assert.equal(hasDouyinSession('sessionid=short'), false);
  assert.equal(hasDouyinSession('sessionid=abcdefgh12345678'), true);
  assert.equal(sanitizeDouyinCookie('SESSIONID=x; ttwid=t'), 'ttwid=t');
});

test('the encrypted cookie store refuses to save a cookie without a session', () => {
  const store = new DouyinCookieStore({store: memoryStore()});
  assert.throws(() => store.save({cookie: 'ttwid=abc'}), /session/);
});

test('the cookie store keeps the verified flag but never returns the cookie', () => {
  const inner = memoryStore();
  const store = new DouyinCookieStore({store: inner});
  store.save({cookie: VALID_COOKIE, user: {name: 'A'}, verified: true, verifiedAt: 5, now: 5});
  assert.equal(inner.raw().verified, true);
  const status = store.status();
  assert.equal(status.verified, true);
  assert.equal(JSON.stringify(status).includes('sessionid'), false);
});
