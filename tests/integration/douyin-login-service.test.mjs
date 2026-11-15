import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {DouyinService} from '../../src/platforms/douyin/service.mjs';
import {DouyinLogin} from '../../src/platforms/douyin/login.mjs';

const T0 = 1700000000000;
const VALID_COOKIE = 'sessionid=abcdefgh12345678; sessionid_ss=abcdefgh12345678; ttwid=t; sid_tt=s; uid_tt=u';

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
    clear: () => { saved = null; }
  };
}

function response(payload) {
  return {
    ok: true,
    status: 200,
    headers: {get: () => 'application/json'},
    text: async () => JSON.stringify(payload)
  };
}

function harness({fetchImpl, store}) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now: () => T0});
  const login = new DouyinLogin({store, fetchImpl, now: () => T0});
  const service = new DouyinService({
    sessionManager,
    db,
    login,
    now: () => T0,
    client: {
      async fetchRoom() { throw new Error('not used'); },
      async checkRoom() { throw new Error('not used'); },
      buildWebSocketUrl() { return {url: 'wss://fake', headers: {}}; },
      cookieHeader() { return ''; }
    }
  });
  return {db, sessionManager, service, login};
}

test('a verified manual cookie is reflected as a verified login and a valid gift session', async () => {
  const store = memoryStore();
  const {service, sessionManager} = harness({
    store,
    fetchImpl: async () => response({status_code: 0, user: {nickname: '主播账号', uid: '42'}})
  });
  try {
    const result = await service.applyCookie(VALID_COOKIE);
    assert.equal(result.verified, true);
    const status = service.status();
    assert.equal(status.mode, 'web-session');
    assert.equal(status.login.state, 'logged_in');
    assert.equal(status.giftVerification.session, 'logged_in');
    assert.equal(status.capabilities.gifts, 'session-valid-gift-not-observed');
    assert.equal(status.capabilities.browserQrLogin, 'unavailable');
    assert.equal(status.browserLogin.supported, false);
    assert.equal(JSON.stringify(status).includes('sessionid'), false);
  } finally {
    await service.shutdown();
    await sessionManager.shutdown().catch(() => {});
  }
});

test('an invalid cookie is rejected and the service stays anonymous', async () => {
  const {service, sessionManager} = harness({
    store: memoryStore(),
    fetchImpl: async () => response({status_code: 8, status_msg: '用户未登录'})
  });
  try {
    await assert.rejects(service.applyCookie(VALID_COOKIE), (error) => error.code === 'DOUYIN_AUTH');
    const status = service.status();
    assert.equal(status.mode, 'anonymous');
    assert.equal(status.login.state, 'anonymous');
    assert.equal(status.capabilities.gifts, 'requires-login');
  } finally {
    await service.shutdown();
    await sessionManager.shutdown().catch(() => {});
  }
});

test('logout clears the login and returns the anonymous capability state', async () => {
  const store = memoryStore({
    cookie: VALID_COOKIE,
    user: {name: 'A'},
    verified: true,
    verifiedAt: T0,
    savedAt: 1
  });
  const {service, sessionManager} = harness({
    store,
    fetchImpl: async () => response({status_code: 0, user: {nickname: 'A'}})
  });
  try {
    assert.equal(service.status().login.state, 'logged_in');
    const result = await service.logout();
    assert.equal(result.login.state, 'anonymous');
    assert.equal(service.status().login.state, 'anonymous');
    assert.equal(service.status().capabilities.gifts, 'requires-login');
  } finally {
    await service.shutdown();
    await sessionManager.shutdown().catch(() => {});
  }
});
