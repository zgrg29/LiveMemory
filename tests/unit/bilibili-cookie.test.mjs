import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {
  CookieStore,
  extractLoginCookies,
  hasSessionCookie,
  sanitizeCookie
} from '../../src/platforms/bilibili/cookie-store.mjs';

const COOKIE = 'SESSDATA=secret-session-value; bili_jct=csrf-token; DedeUserID=12345; buvid3=device-1; unrelated=1';

test('login cookies come from both Set-Cookie and the redirect URL', () => {
  const cookie = extractLoginCookies({
    setCookies: [
      'SESSDATA=abc123; Path=/; HttpOnly',
      'bili_jct=csrf; Path=/',
      'IGNORED=1; Path=/'
    ],
    url: 'https://passport.biligame.com/crossDomain?DedeUserID=777&buvid3=dev'
  });
  assert.equal(hasSessionCookie(cookie), true);
  assert.match(cookie, /SESSDATA=abc123/);
  assert.match(cookie, /bili_jct=csrf/);
  assert.match(cookie, /DedeUserID=777/);
  assert.match(cookie, /buvid3=dev/);
  assert.equal(cookie.includes('IGNORED'), false);
});

test('a cookie without SESSDATA is not considered logged in', () => {
  assert.equal(hasSessionCookie('bili_jct=csrf'), false);
  assert.equal(hasSessionCookie('SESSDATA=; bili_jct=x'), false);
  assert.equal(hasSessionCookie('SESSDATA=value'), true);
});

test('only known credential names are kept', () => {
  assert.equal(sanitizeCookie('SESSDATA=a; tracking=1; bili_jct=b'), 'SESSDATA=a; bili_jct=b');
});

test('the credential file is encrypted and the status never exposes the cookie', () => {
  const temp = createTempDir();
  const store = new CookieStore({dir: temp.dir});
  const info = store.save({cookie: COOKIE, uid: '12345', name: 'Tester', now: 1_700_000_000_000});
  assert.equal(info.uid, '12345');
  const file = join(temp.dir, 'bilibili-login.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes('secret-session-value'), false);
  assert.equal(raw.includes('SESSDATA='), false);
  assert.equal(raw.includes('csrf-token'), false);
  const status = store.status();
  assert.equal(status.stored, true);
  assert.equal(status.uid, '12345');
  assert.equal('cookie' in status, false);

  const reopened = new CookieStore({dir: temp.dir});
  const loaded = reopened.load();
  assert.equal(loaded.cookie, COOKIE);
  assert.equal(reopened.cookie(), COOKIE);
  assert.equal(reopened.clear(), true);
  assert.equal(reopened.status().stored, false);
  temp.cleanup();
});

test('a cookie without SESSDATA is refused instead of being stored', () => {
  const temp = createTempDir();
  const store = new CookieStore({dir: temp.dir});
  assert.throws(() => store.save({cookie: 'bili_jct=only'}), /SESSDATA/);
  temp.cleanup();
});

test('an unreadable or tampered store returns null instead of throwing', () => {
  const temp = createTempDir();
  const store = new CookieStore({dir: temp.dir});
  store.save({cookie: COOKIE, uid: '1', name: 'x'});
  const file = join(temp.dir, 'bilibili-login.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.payload = Buffer.from('tampered').toString('base64');
  writeFileSync(file, JSON.stringify(json));
  assert.equal(new CookieStore({dir: temp.dir}).load(), null);
  temp.cleanup();
});
