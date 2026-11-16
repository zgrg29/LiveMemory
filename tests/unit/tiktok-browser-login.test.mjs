import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokBrowserLogin, TIKTOK_LOGIN_STATES} from '../../src/platforms/tiktok/browser-login.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function futureSeconds() {
  return Math.floor(Date.now() / 1000) + 3600;
}

class FakeSession {
  constructor({cookies = [], dom = {}, ready = {}, launchError = null} = {}) {
    this.cookies = cookies;
    this.dom = dom;
    this.ready = ready;
    this.launchError = launchError;
    this.alive = false;
    this.launches = 0;
    this.closes = 0;
    this.navigations = [];
    this.onClose = () => {};
  }

  async launch() {
    this.launches += 1;
    if (this.launchError) throw this.launchError;
    this.alive = true;
    return this;
  }

  isAlive() {
    return this.alive;
  }

  async getCookies() {
    return this.cookies;
  }

  async evaluate() {
    return this.dom;
  }

  async navigate(url) {
    this.navigations.push(url);
  }

  async waitForReady() {
    return {closed: false, loginRequired: false, events: 0, roomEnterStatus: 200, ...this.ready};
  }

  async close() {
    this.closes += 1;
    this.alive = false;
  }
}

function harness({session = new FakeSession(), dataDir = null, isCaptureActive = null} = {}) {
  const temp = dataDir ? null : createTempDir('tiktok-login-');
  const dir = dataDir ?? temp.dir;
  let terminated = 0;
  const login = new TikTokBrowserLogin({
    dataDir: dir,
    logger: null,
    browserPath: 'C:\\fake\\chrome.exe',
    sessionFactory: () => session,
    isCaptureActive,
    terminateBrowser: async () => {
      terminated += 1;
      return true;
    },
    pollIntervalMs: 100000,
    loggedInPollIntervalMs: 100000
  });
  return {
    login,
    session,
    dir,
    temp,
    terminated: () => terminated,
    cleanup: async () => {
      await login.shutdown().catch(() => {});
      temp?.cleanup();
    }
  };
}

function loggedInSession(extra = {}) {
  return new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false},
    ...extra
  });
}

test('a session cookie plus an official profile page becomes logged in', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'secret-cookie-value', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false}
  })});
  try {
    const started = await ctx.login.start();
    assert.equal(started.state, TIKTOK_LOGIN_STATES.WAITING);
    assert.equal(ctx.session.launches, 1);
    const checked = await ctx.login.checkNow();
    assert.equal(checked.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(checked.verifiedBy, 'page_profile');
    assert.equal(JSON.stringify(checked).includes('secret-cookie-value'), false, 'cookie values never reach status');
    assert.ok(checked.cookieNames.includes('sessionid'));
  } finally {
    await ctx.cleanup();
  }
});

test('no cookie stays waiting and an expired cookie is reported as expired', async () => {
  const ctx = harness();
  try {
    await ctx.login.start();
    assert.equal((await ctx.login.checkNow()).state, TIKTOK_LOGIN_STATES.WAITING);
    ctx.session.cookies = [{name: 'sessionid', value: 'x', expires: Math.floor(Date.now() / 1000) - 10}];
    const expired = await ctx.login.checkNow();
    assert.equal(expired.state, TIKTOK_LOGIN_STATES.EXPIRED);
  } finally {
    await ctx.cleanup();
  }
});

test('a live-room verification separates login success from event delivery', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false},
    ready: {loginRequired: false, events: 0, roomEnterStatus: 200}
  })});
  try {
    await ctx.login.start({uniqueId: 'creator'});
    const status = await ctx.login.verify({uniqueId: 'creator', timeoutMs: 100});
    assert.equal(status.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(status.capture.state, 'connected_no_events');
    assert.equal(status.capture.eventsReceived, 0);
    assert.equal(ctx.session.navigations.some((url) => url.includes('/@creator/live')), true);
    ctx.session.ready = {loginRequired: false, events: 3, roomEnterStatus: 200};
    const withEvents = await ctx.login.verify({uniqueId: 'creator', timeoutMs: 100});
    assert.equal(withEvents.capture.state, 'events_received');
  } finally {
    await ctx.cleanup();
  }
});

test('a cookie plus a 403 room entry is a room refusal, not a login failure', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false},
    ready: {loginRequired: false, roomRefused: true, events: 0, roomEnterStatus: 403}
  })});
  try {
    await ctx.login.start({uniqueId: 'creator'});
    const status = await ctx.login.verify({uniqueId: 'creator', timeoutMs: 100});
    assert.equal(status.state, TIKTOK_LOGIN_STATES.LOGGED_IN, 'a room 403 must not erase a valid login');
    assert.equal(status.capture.state, 'platform_refused');
    assert.equal(status.roomAccess.state, 'refused');
    assert.equal(status.roomAccess.status, 403);
  } finally {
    await ctx.cleanup();
  }
});

test('real events win over a room-entry 403', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false},
    ready: {loginRequired: false, roomRefused: true, events: 4, roomEnterStatus: 403}
  })});
  try {
    await ctx.login.start({uniqueId: 'creator'});
    const status = await ctx.login.verify({uniqueId: 'creator', timeoutMs: 100});
    assert.equal(status.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(status.capture.state, 'events_received');
    assert.equal(status.capture.eventsReceived, 4);
    assert.equal(status.roomAccess.state, 'refused', 'the room warning is kept next to the working events');
  } finally {
    await ctx.cleanup();
  }
});

test('an unconfirmed room is not reported as a working connection', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
    dom: {hasProfileLink: true, hasLoginLink: false},
    ready: {loginRequired: false, events: 0, roomEnterStatus: null, timedOut: true}
  })});
  try {
    await ctx.login.start({uniqueId: 'creator'});
    const status = await ctx.login.verify({uniqueId: 'creator', timeoutMs: 100});
    assert.equal(status.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(status.capture.state, 'room_unconfirmed');
    assert.equal(status.capture.eventsReceived, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('logging in again in the same window clears an expired state', async () => {
  const ctx = harness({session: new FakeSession({
    cookies: [{name: 'sessionid', value: 'x', expires: Math.floor(Date.now() / 1000) - 10}],
    dom: {hasProfileLink: true, hasLoginLink: false}
  })});
  try {
    await ctx.login.start();
    const expired = await ctx.login.checkNow();
    assert.equal(expired.state, TIKTOK_LOGIN_STATES.EXPIRED);

    ctx.session.cookies = [{name: 'sessionid', value: 'fresh', expires: futureSeconds()}];
    const relogged = await ctx.login.checkNow();
    assert.equal(relogged.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(relogged.captureActive, false);
  } finally {
    await ctx.cleanup();
  }
});

test('a second start reuses the in-flight login task and does not launch two browsers', async () => {
  const ctx = harness();
  try {
    const [first, second] = await Promise.all([ctx.login.start(), ctx.login.start()]);
    assert.equal(ctx.session.launches, 1);
    assert.ok(['opening', 'waiting'].includes(first.state));
    assert.ok(['opening', 'waiting'].includes(second.state));
    assert.equal(ctx.login.status().state, TIKTOK_LOGIN_STATES.WAITING);
  } finally {
    await ctx.cleanup();
  }
});

test('cancel closes only the owned browser and returns to idle', async () => {
  const ctx = harness();
  try {
    await ctx.login.start();
    const status = await ctx.login.cancel();
    assert.equal(status.state, TIKTOK_LOGIN_STATES.IDLE);
    assert.equal(ctx.session.closes >= 1, true);
    assert.equal(ctx.terminated() >= 1, true);
  } finally {
    await ctx.cleanup();
  }
});

test('a persisted login survives a restart but a missing profile is not called logged in', async () => {
  const temp = createTempDir('tiktok-login-persist-');
  try {
    const first = new TikTokBrowserLogin({
      dataDir: temp.dir,
      browserPath: 'C:\\fake\\chrome.exe',
      terminateBrowser: async () => true,
      pollIntervalMs: 100000
    });
    // Simulate a completed login by writing through the public state machine.
    const session = new FakeSession({
      cookies: [{name: 'sessionid', value: 'x', expires: futureSeconds()}],
      dom: {hasProfileLink: true, hasLoginLink: false}
    });
    first.sessionFactory = () => session;
    await first.start();
    await first.checkNow();
    assert.equal(first.status().state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    await first.shutdown();

    const second = new TikTokBrowserLogin({
      dataDir: temp.dir,
      browserPath: 'C:\\fake\\chrome.exe',
      terminateBrowser: async () => true,
      pollIntervalMs: 100000
    });
    assert.equal(second.status().state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(second.status().restoredFromDisk, true);
    assert.equal(second.status().revalidationRequired, true, 'an old marker alone must require revalidation');

    const fresh = loggedInSession({ready: {loginRequired: false, events: 2, roomEnterStatus: 200}});
    second.sessionFactory = () => fresh;
    const verified = await second.verify({uniqueId: 'creator', timeoutMs: 50});
    assert.equal(verified.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(verified.capture.state, 'events_received');
    assert.equal(verified.capture.eventsReceived, 2);
    assert.equal(verified.revalidationRequired, false, 'real event delivery clears the revalidation flag');

    await second.logout();
    assert.equal(second.status().state, TIKTOK_LOGIN_STATES.IDLE);
  } finally {
    temp.cleanup();
  }
});

test('verifying without a room link reports the missing input without poisoning the login', async () => {
  const ctx = harness({session: loggedInSession()});
  try {
    await ctx.login.start();
    const loggedIn = await ctx.login.checkNow();
    assert.equal(loggedIn.state, TIKTOK_LOGIN_STATES.LOGGED_IN);

    const verified = await ctx.login.verify({timeoutMs: 50});
    assert.equal(verified.state, TIKTOK_LOGIN_STATES.LOGGED_IN, 'a missing room is not a login failure');
    assert.equal(verified.capture.state, 'needs_room');
    assert.equal(verified.capture.reason, 'unique_id_required');
    assert.equal(verified.browserOpen, true);
    assert.equal(verified.error, null);
  } finally {
    await ctx.cleanup();
  }
});

test('closing the login window keeps the account logged in and marks revalidation', async () => {
  const ctx = harness({session: loggedInSession()});
  try {
    await ctx.login.start();
    await ctx.login.checkNow();
    const closed = await ctx.login.cancel();
    assert.equal(closed.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(closed.browserOpen, false);
    assert.ok(closed.loginWindowClosedAt > 0);
    assert.equal(closed.revalidationRequired, true);
    assert.equal(closed.captureActive, false);
    assert.equal(ctx.terminated() >= 1, true);
  } finally {
    await ctx.cleanup();
  }
});

test('closing the login page during an active capture does not terminate the owned browser', async () => {
  const capture = {active: false};
  const ctx = harness({session: loggedInSession(), isCaptureActive: () => capture.active});
  try {
    await ctx.login.start();
    await ctx.login.checkNow();
    capture.active = true;
    const before = ctx.terminated();
    const closed = await ctx.login.cancel();
    assert.equal(closed.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(closed.browserOpen, false);
    assert.equal(closed.captureActive, true);
    assert.equal(ctx.terminated(), before, 'the capture tab must keep its browser process');
  } finally {
    await ctx.cleanup();
  }
});

test('logout is refused while a capture is active instead of killing the recording', async () => {
  const capture = {active: false};
  const ctx = harness({session: loggedInSession(), isCaptureActive: () => capture.active});
  try {
    await ctx.login.start();
    await ctx.login.checkNow();
    capture.active = true;
    const status = await ctx.login.logout();
    assert.equal(status.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(status.error.code, 'TIKTOK_CAPTURE_ACTIVE');
    assert.equal(status.error.reason, 'stop_capture_first');
    assert.equal(ctx.terminated(), 0);
  } finally {
    await ctx.cleanup();
  }
});

test('capture evidence updates the login badge; room refusal and login expiry stay separate', async () => {
  const ctx = harness({session: loggedInSession()});
  try {
    await ctx.login.start();
    await ctx.login.checkNow();
    const delivered = ctx.login.markCaptureVerified({eventsReceived: 3, roomEnterStatus: 200});
    assert.equal(delivered.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(delivered.verifiedBy, 'live_room');
    assert.equal(delivered.capture.state, 'events_received');
    assert.equal(delivered.capture.eventsReceived, 3);

    const refused = ctx.login.markCaptureRefused({roomEnterStatus: 403, reason: 'room_enter_403'});
    assert.equal(refused.state, TIKTOK_LOGIN_STATES.LOGGED_IN, 'room access is not the login state');
    assert.equal(refused.capture.state, 'platform_refused');
    assert.equal(refused.capture.roomEnterStatus, 403);
    assert.equal(refused.roomAccess.state, 'refused');
    assert.equal(refused.revalidationRequired, false);

    const expired = ctx.login.markCaptureLoginRequired({roomEnterStatus: null, reason: 'login_required'});
    assert.equal(expired.state, TIKTOK_LOGIN_STATES.EXPIRED);
    assert.equal(expired.capture.state, 'login_required');
    assert.equal(expired.revalidationRequired, true);
  } finally {
    await ctx.cleanup();
  }
});

test('no data directory is reported as unavailable instead of a fake login', () => {
  const login = new TikTokBrowserLogin({dataDir: null, browserPath: 'C:\\fake\\chrome.exe'});
  const status = login.status();
  assert.equal(status.state, TIKTOK_LOGIN_STATES.IDLE);
  assert.equal(status.supported, false);
  assert.equal(status.profile, null);
});
