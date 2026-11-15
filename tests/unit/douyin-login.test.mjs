import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinLogin, QR_STATE} from '../../src/platforms/douyin/login.mjs';
import {DouyinCookieStore, hasDouyinSession, sanitizeDouyinCookie} from '../../src/platforms/douyin/cookie-store.mjs';

function response(body, {status = 200, contentType = 'application/json', setCookies = [], location = null} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'location') return location;
        return null;
      },
      getSetCookie: () => setCookies
    },
    text: async () => body
  };
}

function memoryStore() {
  let saved = null;
  return {
    load: () => saved,
    save: ({cookie, user}) => {
      saved = {cookie, user, savedAt: 1};
      return {savedAt: 1};
    },
    status: () => ({stored: Boolean(saved), user: saved?.user ?? null, savedAt: saved?.savedAt ?? null}),
    clear: () => { saved = null; }
  };
}

test('anonymous status is honest: not logged in and no cookie is exposed', () => {
  const login = new DouyinLogin({store: memoryStore()});
  const status = login.status();
  assert.equal(status.loggedIn, false);
  assert.equal(status.qr, null);
  assert.equal(JSON.stringify(status).includes('sessionid'), false);
  assert.equal(login.loginState, 'anonymous');
});

test('a risk-control HTML answer to the QR request is reported as blocked, never as a QR code', async () => {
  const login = new DouyinLogin({
    store: memoryStore(),
    fetchImpl: async () => response('<html>安全验证</html>', {contentType: 'text/html'})
  });
  await assert.rejects(login.startQr(), (error) => (
    error.code === 'DOUYIN_LOGIN_BLOCKED' && error.details?.reason === 'risk_control'
  ));
  assert.equal(login.status().blocked.reason, 'risk_control');
  assert.equal(login.loginState, 'blocked');
});

test('a JSON QR answer exposes only the scannable payload and an expiry', async () => {
  const login = new DouyinLogin({
    store: memoryStore(),
    now: () => 1000,
    fetchImpl: async () => response(JSON.stringify({
      data: {token: 'tok-1', qrcode_index_url: 'https://www.douyin.com/login?token=tok-1'}
    }))
  });
  const qr = await login.startQr();
  assert.equal(qr.token, 'tok-1');
  assert.equal(qr.url, 'https://www.douyin.com/login?token=tok-1');
  assert.equal(qr.state, QR_STATE.WAITING);
  assert.ok(qr.expiresAt > 1000);
});

test('a confirmed QR login follows the redirect chain, keeps sessionid and stores it locally', async () => {
  const store = memoryStore();
  let clock = 1000;
  const calls = [];
  const login = new DouyinLogin({
    store,
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/get_qrcode/')) {
        return response(JSON.stringify({data: {token: 'tok-2', qrcode_index_url: 'https://www.douyin.com/login?token=tok-2'}}));
      }
      if (url.includes('/check_qrconnect/')) {
        return response(JSON.stringify({data: {status: 2, redirect_url: 'https://www.douyin.com/passport/sso/callback?ticket=x'}}));
      }
      if (url.includes('/passport/sso/callback')) {
        return response('', {
          contentType: 'text/html',
          setCookies: ['sessionid=abcdefgh12345678; Path=/; Domain=.douyin.com', 'ttwid=tt-1; Path=/'],
          location: 'https://www.douyin.com/'
        });
      }
      return response('', {contentType: 'text/html', setCookies: ['sessionid_ss=abcdefgh12345678; Path=/']});
    }
  });
  await login.startQr();
  clock = 3000;
  const result = await login.pollQr();
  assert.equal(result.state, QR_STATE.SUCCESS);
  assert.equal(login.loggedIn, true);
  assert.match(store.load().cookie, /sessionid=abcdefgh12345678/);
  assert.match(store.load().cookie, /ttwid=tt-1/);
  assert.ok(calls.some((url) => url.includes('/passport/sso/callback')));
});

test('an expired QR is reported as expired and cannot be used for a success', async () => {
  let clock = 1000;
  const login = new DouyinLogin({
    store: memoryStore(),
    now: () => clock,
    fetchImpl: async () => response(JSON.stringify({data: {token: 'tok-3', qrcode_index_url: 'https://x'}}))
  });
  await login.startQr();
  clock = 1000 + 5 * 60 * 1000;
  const result = await login.pollQr();
  assert.equal(result.state, QR_STATE.EXPIRED);
  assert.equal(login.loggedIn, false);
});

test('a stored session is checked against the public page and expiry is explicit', async () => {
  const store = memoryStore();
  store.save({cookie: 'sessionid=abcdefgh12345678; ttwid=t', user: null});
  const login = new DouyinLogin({
    store,
    fetchImpl: async () => response('{"user_is_login":0}', {contentType: 'text/html'})
  });
  const result = await login.verify();
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('the explicit cookie fallback requires a session id and keeps only known names', async () => {
  const store = memoryStore();
  const login = new DouyinLogin({store});
  await assert.rejects(login.applyCookie('ttwid=abc'), (error) => error.code === 'DOUYIN_AUTH');
  const ok = await login.applyCookie('sessionid=abcdefgh12345678; sessionid_ss=abcdefgh12345678; evil=<script>; ttwid=t');
  assert.equal(ok.loggedIn, true);
  const saved = store.load().cookie;
  assert.match(saved, /sessionid=/);
  assert.equal(saved.includes('evil'), false);
  assert.equal(saved.includes('<script>'), false);
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
