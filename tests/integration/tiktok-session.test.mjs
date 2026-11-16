import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {TikTokBrowserRelay, decodeFramePayload} from '../../src/platforms/tiktok/browser-relay.mjs';
import {TIKTOK_LOGIN_STATES} from '../../src/platforms/tiktok/browser-login.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers, viewerCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {chatMessage, fetchResult, giftMessage, pushFrame, roomUserSeqMessage} from '../helpers/tiktok-frames.mjs';

/**
 * TikTok signer transport → mapper → EventIngest → SQLite → AI package.
 *
 * The signer is deterministic: no real TikTok request is made. The frames use
 * the same protobuf field numbers as the real payloads captured during the
 * feasibility check (see docs/PLATFORM_RESEARCH_TIKTOK_2026-11.md).
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function frame(messages, cursor = 'c1') {
  return {
    messages: messages.map((entry) => ({method: entry.method, payload: entry.payload, envelopeMsgId: null})),
    cursor,
    internalExt: 'ext',
    fetchInterval: 0,
    pushServer: null,
    routeParams: new Map(),
    needsAck: false
  };
}

class FakeSigner {
  constructor(queue) {
    this.queue = queue;
    this.calls = 0;
    this.mode = 'community-signer';
  }

  async connect({cursor = null} = {}) {
    this.calls += 1;
    const index = Math.min(this.calls - 1, this.queue.length - 1);
    const batch = this.queue[index];
    if (typeof batch === 'function') return {fetchResult: batch({cursor, call: this.calls})};
    return {fetchResult: batch};
  }
}

/**
 * A stand-in for the real BrowserSession. It emits already-decoded Webcast
 * messages through `onFrame`, exactly like the real CDP page listener does.
 */
class FakeBrowserSession {
  constructor({frames = [], ready = {}, launchError = null} = {}) {
    this.frames = frames;
    this.ready = ready;
    this.launchError = launchError;
    this.alive = false;
    this.closed = false;
    this.onFrame = () => {};
    this.onClose = () => {};
    this.navigations = [];
    this.cookies = [{name: 'sessionid', value: 'x', expires: Math.floor(Date.now() / 1000) + 3600}];
  }

  async launch() {
    if (this.launchError) throw this.launchError;
    this.alive = true;
    return this;
  }

  isAlive() {
    return this.alive && !this.closed;
  }

  requiresLogin() {
    return Boolean(this.ready.loginRequired);
  }

  roomAccessRefused() {
    return Boolean(this.ready.roomRefused);
  }

  async waitForReady() {
    if (!this.alive || this.ready.loginRequired) {
      return {closed: false, loginRequired: Boolean(this.ready.loginRequired), roomRefused: Boolean(this.ready.roomRefused), events: 0, roomEnterStatus: null, ...this.ready};
    }
    for (const message of this.frames) {
      if (!this.alive) break;
      this.onFrame(message);
    }
    return {closed: false, loginRequired: false, roomRefused: Boolean(this.ready.roomRefused), events: this.frames.length, roomEnterStatus: 200, ...this.ready};
  }

  async navigate(url) {
    this.navigations.push(url);
  }

  async getCookies() {
    return this.cookies;
  }

  async evaluate() {
    return {hasProfileLink: true, hasLoginLink: false};
  }

  async close() {
    this.closed = true;
    this.alive = false;
  }
}

function fakeBrowserLogin({state = TIKTOK_LOGIN_STATES.LOGGED_IN, profileOwned = true, marks = []} = {}) {
  const login = {
    state,
    profileOwned,
    setCaptureActiveProvider(fn) {
      this.captureProvider = fn;
    },
    status() {
      return {
        state: this.state,
        supported: true,
        browserOpen: false,
        profile: this.profileOwned ? {owned: true, path: 'C:\\tmp\\tiktok-profile'} : null,
        verifiedAt: T0,
        verifiedBy: 'live_room',
        capture: null,
        roomAccess: this.roomAccess ?? {state: 'unknown', status: null, at: null},
        error: null,
        revalidationRequired: false,
        captureActive: Boolean(this.captureProvider?.())
      };
    },
    markCaptureVerified(info) {
      marks.push({type: 'verified', ...info});
      this.state = TIKTOK_LOGIN_STATES.LOGGED_IN;
      return this.status();
    },
    markCaptureLoginRequired(info) {
      marks.push({type: 'login_required', ...info});
      this.state = TIKTOK_LOGIN_STATES.EXPIRED;
      return this.status();
    },
    markCaptureRefused(info) {
      marks.push({type: 'refused', ...info});
      this.roomAccess = {state: 'refused', status: info.roomEnterStatus ?? 403, at: T0};
      return this.status();
    },
    markCaptureUnconfirmed(info) {
      marks.push({type: 'unconfirmed', ...info});
      return this.status();
    },
    markCaptureStopped(info) {
      marks.push({type: 'stopped', ...info});
      return this.status();
    },
    markCaptureFailed(info) {
      marks.push({type: 'failed', ...info});
      return this.status();
    },
    async verify() {
      return this.status();
    },
    async cancel() {
      return this.status();
    },
    async logout() {
      return this.status();
    },
    async shutdown() {}
  };
  return login;
}

function harness({queue, settings = {}, browserLogin = null, browserRelay = null, signerOverride = null} = {}) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const settingsStore = {get: () => ({storageMode: 'compact', ...settings})};
  const sessionManager = new SessionManager({
    db,
    settings: settingsStore,
    now
  });
  const client = {
    async resolveRoom(uniqueId) {
      const id = typeof uniqueId === 'string' ? uniqueId : uniqueId?.uniqueId;
      return {
        uniqueId: id,
        roomId: id === 'creator' ? '900001' : '900002',
        anchorUid: id === 'creator' ? '111' : '222',
        anchorName: id === 'creator' ? 'Creator One' : 'Creator Two',
        isLive: true,
        status: 2,
        title: `${id} live`,
        startedAt: T0,
        checkedAt: T0
      };
    },
    async checkRoom(input) {
      const id = typeof input === 'string' ? input : input?.uniqueId;
      const room = await this.resolveRoom(id);
      return {...room, liveUrl: `https://www.tiktok.com/@${id}/live`};
    },
    async fetchRoomInfo() {
      return {roomId: '900001', isLive: true, title: 'Creator One live', anchorUid: '111', anchorName: 'Creator One', startedAt: T0};
    },
    async fetchGiftCatalog() {
      return new Map([['56560', {id: '56560', name: 'My First Rose', diamondCount: 1}]]);
    }
  };
  const signer = signerOverride ?? new FakeSigner(queue ?? [frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'chat-1', content: 'Hello 世界 😂'})}])]);
  const service = new TikTokService({
    sessionManager,
    db,
    settings: settingsStore,
    client,
    signer,
    browserLogin,
    browserRelay,
    now,
    adapterOptions: {
      pollIntervalMs: 10,
      statusIntervalMs: 100000,
      watchdogCheckMs: 100000,
      streakFlushMs: 100000
    }
  });
  return {db, sessionManager, service, client, signer, now};
}

test('a TikTok live room records chat, stable viewer identity and gift display value', async () => {
  const {db, sessionManager, service, now} = harness({
    queue: [
      frame([
        {method: 'WebcastChatMessage', payload: chatMessage({msgId: 'chat-1', userId: '4242', nickname: 'Alice', content: 'Hello 世界 😂'})},
        {method: 'WebcastChatMessage', payload: chatMessage({msgId: 'chat-1', userId: '4242', nickname: 'Alice', content: 'Hello 世界 😂'})},
        {method: 'WebcastGiftMessage', payload: giftMessage({msgId: 'gift-1', userId: '4242', nickname: 'Alice', giftName: 'Rose', diamonds: 2, repeatCount: 3, repeatEnd: 1})},
        {method: 'WebcastRoomUserSeqMessage', payload: roomUserSeqMessage({viewerCount: 15})}
      ])
    ]
  });
  const dir = createTempDir('tiktok-session-');
  try {
    const result = await service.connect('creator');
    const sessionId = result.session.id;
    assert.equal(result.session.platform, 'tiktok');
    assert.equal(result.room.isLive, true);
    assert.ok(['connected', 'reconnecting', 'rate_limited'].includes(result.connection?.state));

    await waitFor(() => Number(getSession(db, sessionId).message_count) >= 1);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c >= 2);

    const liveStatus = service.status();
    const liveRecording = liveStatus.recordings.find((recording) => recording.sessionId === sessionId);
    assert.ok(liveRecording?.capture, 'the live status exposes the adapter capture state');
    assert.ok(liveRecording.capture.lastEventAt > 0, 'last real event time is exposed');
    assert.equal(liveRecording.capture.category, 'normal');
    assert.ok(liveStatus.capture, 'the latest capture is exposed at the top level');
    assert.ok(Object.hasOwn(liveStatus, 'rateLimit'), 'the shared signer budget field is exposed');

    const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
    assert.equal(rows.length, 2, 'the replayed message id was not inserted twice');
    const chat = rows.find((row) => row.event_type === 'chat');
    assert.equal(chat.viewer_uid, '4242');
    assert.equal(chat.viewer_id, 'tiktok:4242');
    assert.equal(chat.content, 'Hello 世界 😂');
    assert.equal(chat.external_id, 'chat-1');
    assert.equal(chat.source_quality, 'verified');

    const gift = rows.find((row) => row.event_type === 'gift');
    assert.equal(gift.viewer_id, 'tiktok:4242');
    assert.equal(gift.gift_name, 'Rose');
    assert.equal(gift.gift_quantity, 3);
    assert.equal(gift.amount_minor, null);
    assert.equal(gift.currency, null);
    assert.equal(gift.value_kind, 'unknown');
    assert.equal(gift.amount_display, '6 TikTok Diamonds');
    assert.equal(gift.is_paid, 1);

    const session = getSession(db, sessionId);
    assert.equal(session.message_count, 1);
    assert.equal(session.payment_event_count, 1);
    assert.equal(session.broadcaster_id, 'tiktok:111');

    const viewers = listSessionViewers(db, sessionId, {limit: 10});
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].viewer_id, 'tiktok:4242');
    assert.deepEqual(viewerCurrencyTotals(db, 'tiktok:4242'), [], 'diamonds never become fiat');

    const pkg = await buildAnalysisPackage({
      db,
      sessionId,
      locale: 'en',
      exportsDir: join(dir.dir, 'exports'),
      now: now()
    });
    const inspected = await inspectAnalysisPackage(pkg.absolutePath);
    const lines = inspected.messages.map((line) => JSON.parse(line));
    const chatLine = lines.find((line) => line.message_id === 'chat-1');
    assert.equal(chatLine.viewer_id, 'tiktok:4242');
    assert.equal(chatLine.content, 'Hello 世界 😂');
    // Gifts are payment events, not chat lines: the AI package includes only
    // chat/super_chat messages, exactly like the other platforms.
    assert.equal(lines.every((line) => line.type === 'chat' || line.type === 'super_chat'), true);
    assert.equal(lines.some((line) => line.message_id === 'gift-1'), false);

    const stopped = await service.disconnect({sessionId});
    assert.equal(stopped.stopped, true);
    assert.equal(getSession(db, sessionId).status, 'ended');
    assert.equal(getSession(db, sessionId).end_reason, 'user');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    dir.cleanup();
  }
});

test('the same TikTok room cannot be recorded twice, other creators stay independent', async () => {
  const {db, sessionManager, service} = harness({
    queue: [
      frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'a1', userId: '1', nickname: 'A', content: 'one'})}]),
      frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'b1', userId: '2', nickname: 'B', content: 'two'})}])
    ]
  });
  try {
    const first = await service.connect('creator');
    await assert.rejects(() => service.connect('https://www.tiktok.com/@creator/live'), (error) => error.code === 'SESSION_DUPLICATE_ROOM');
    const second = await service.connect('other');
    assert.notEqual(first.session.id, second.session.id);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE platform = ?').get('tiktok').c === 2);
    const rooms = db.prepare('SELECT DISTINCT platform_room_id FROM sessions WHERE platform = ?').all('tiktok').map((row) => row.platform_room_id);
    assert.deepEqual(rooms.sort(), ['900001', '900002']);
    await service.disconnect({sessionId: first.session.id});
    await service.disconnect({sessionId: second.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('status reports the transport, capability boundaries and retention policy', async () => {
  const {db, sessionManager, service} = harness();
  try {
    const status = service.status();
    assert.equal(status.available, true);
    assert.equal(status.mode, 'signer');
    assert.equal(status.capabilities.requiresPaidPlan, false);
    assert.equal(status.capabilities.stableUserId, true);
    assert.equal(status.capabilities.roomMetadata, 'verified-public');
    assert.equal(status.capabilities.giftCatalog, 'verified-public');
    assert.equal(status.capabilities.gifts, 'parsed-not-observed');
    assert.equal(status.policy.days, 30);
    assert.equal(status.policy.maxDays, 30);
    assert.equal(status.policy.policy, 'tiktok-raw-content');
    assert.equal(typeof status.policy.pendingPurge, 'number');
    assert.equal(status.login.state, 'unavailable');
    assert.ok(status.rateLimit === null || typeof status.rateLimit === 'object');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
  }
});

test('browser transport requires a verified login before a session can start', async () => {
  const login = {
    state: 'idle',
    status() {
      return {
        state: this.state,
        supported: true,
        browserOpen: false,
        verifiedAt: null,
        capture: null,
        error: null
      };
    },
    async start() {
      this.state = 'waiting';
      return this.status();
    },
    async verify() {
      this.state = 'logged_in';
      return this.status();
    },
    async cancel() {
      this.state = 'idle';
      return this.status();
    },
    async logout() {
      this.state = 'idle';
      return this.status();
    },
    async shutdown() {}
  };
  const adapter = {
    state: 'connected',
    async start({onStateChange}) {
      onStateChange?.({adapter: 'fake', state: 'connected', detail: {category: 'normal'}});
    },
    async stop() {},
    snapshot() {
      return {state: 'connected', detail: {category: 'normal'}};
    },
    capture() {
      return {category: 'normal', lastEventAt: T0, reconnectAttempts: 0};
    }
  };
  const relay = {
    async start() {},
    createAdapter() {
      return adapter;
    },
    async stop() {},
    async closeBrowser() {}
  };
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserLogin: login,
    browserRelay: relay
  });
  try {
    const status = service.status();
    assert.equal(status.transport.active, 'browser');
    assert.equal(status.transport.browserReady, false);
    await assert.rejects(() => service.connect('creator'), (error) => error.code === 'TIKTOK_LOGIN_REQUIRED');

    login.state = 'logged_in';
    const started = await service.connect('creator');
    assert.equal(started.session.platform, 'tiktok');
    assert.equal(service.status().transport.browserReady, true);
    await service.disconnect({sessionId: started.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
  }
});

test('a selected browser relay is actually available and its events reach SQLite', async () => {
  const dir = createTempDir('tiktok-browser-capture-');
  const frames = [
    {
      method: 'WebcastChatMessage',
      payload: chatMessage({msgId: 'browser-chat-1', userId: '777', nickname: 'Browser Alice', content: '来自浏览器 😀'})
    },
    {
      method: 'WebcastGiftMessage',
      payload: giftMessage({
        msgId: 'browser-gift-1',
        userId: '777',
        nickname: 'Browser Alice',
        giftName: 'Rose',
        diamonds: 2,
        repeatCount: 2,
        repeatEnd: 1
      })
    }
  ];
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({frames, ready: {events: frames.length, roomEnterStatus: 200}})
  });
  const marks = [];
  const login = fakeBrowserLogin({marks});
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: login
  });
  try {
    const status = service.status();
    assert.equal(status.transport.requested, 'browser');
    assert.equal(status.transport.active, 'browser', 'the relay exposes createAdapter, not start');
    assert.equal(status.transport.browserAvailable, true);

    const result = await service.connect('creator');
    assert.equal(result.session.platform, 'tiktok');
    assert.equal(result.room.uniqueId, 'creator');
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(result.session.id).c >= 2);

    const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(result.session.id);
    const chat = rows.find((row) => row.event_type === 'chat');
    assert.equal(chat.viewer_uid, '777');
    assert.equal(chat.viewer_id, 'tiktok:777');
    assert.equal(chat.display_name, 'Browser Alice');
    assert.equal(chat.content, '来自浏览器 😀');
    assert.equal(chat.external_id, 'browser-chat-1');
    assert.ok(chat.occurred_at > 0, 'event time is stored');

    const gift = rows.find((row) => row.event_type === 'gift');
    assert.equal(gift.viewer_id, 'tiktok:777');
    assert.equal(gift.gift_name, 'Rose');
    assert.equal(gift.gift_quantity, 2);
    assert.equal(gift.amount_minor, null);
    assert.equal(gift.value_kind, 'unknown');
    assert.equal(gift.amount_display, '4 TikTok Diamonds');

    assert.equal(marks.at(-1)?.type, 'verified', 'real relay success is written back to the login badge');
    assert.equal(service.status().login.state, TIKTOK_LOGIN_STATES.LOGGED_IN);

    const stopped = await service.disconnect({sessionId: result.session.id});
    assert.equal(stopped.stopped, true);
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('a real PushFrame socket envelope reaches SQLite with the stable viewer id', async () => {
  const dir = createTempDir('tiktok-browser-pushframe-');
  const batch = fetchResult({
    messages: [
      {method: 'WebcastChatMessage', payload: chatMessage({msgId: 'push-chat-1', userId: '888', nickname: 'Push Alice', content: 'PushFrame 你好'}), msgId: 501n}
    ]
  });
  const frame = pushFrame({payload: gzipSync(batch), logId: 77n});
  const decoded = decodeFramePayload(frame.toString('base64'));
  assert.equal(decoded.length, 1);
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({
      frames: decoded,
      ready: {events: decoded.length, roomEnterStatus: 200}
    })
  });
  const login = fakeBrowserLogin({});
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: login
  });
  try {
    const result = await service.connect('creator');
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(result.session.id).c >= 1);
    const row = db.prepare("SELECT * FROM events WHERE session_id = ? AND event_type = 'chat'").get(result.session.id);
    assert.equal(row.viewer_id, 'tiktok:888');
    assert.equal(row.content, 'PushFrame 你好');
    assert.equal(row.external_id, 'push-chat-1');
    assert.equal(service.status().capture.eventsVerified, true);
    await service.disconnect({sessionId: result.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('the browser relay merges a gift streak and keeps its final quantity', async () => {
  const dir = createTempDir('tiktok-browser-streak-');
  const frames = [
    {
      method: 'WebcastGiftMessage',
      payload: giftMessage({
        msgId: 'gift-step-1',
        userId: '888',
        nickname: 'Streaker',
        giftName: 'Rose',
        diamonds: 2,
        repeatCount: 1,
        repeatEnd: 0,
        groupId: '8888'
      })
    },
    {
      method: 'WebcastGiftMessage',
      payload: giftMessage({
        msgId: 'gift-step-2',
        userId: '888',
        nickname: 'Streaker',
        giftName: 'Rose',
        diamonds: 2,
        repeatCount: 3,
        repeatEnd: 1,
        groupId: '8888'
      })
    }
  ];
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({frames, ready: {events: frames.length, roomEnterStatus: 200}})
  });
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: fakeBrowserLogin({})
  });
  try {
    const result = await service.connect('creator');
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(result.session.id).c >= 1);
    const gifts = db.prepare("SELECT * FROM events WHERE session_id = ? AND event_type = 'gift'").all(result.session.id);
    assert.equal(gifts.length, 1, 'a streak is written once');
    assert.equal(gifts[0].gift_quantity, 3, 'the final repeat count wins');
    assert.equal(gifts[0].amount_display, '6 TikTok Diamonds');
    assert.equal(gifts[0].viewer_id, 'tiktok:888');
    await service.disconnect({sessionId: result.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('a logged-in browser plus a real 403 is a room refusal, not a lost login', async () => {
  const dir = createTempDir('tiktok-browser-403-');
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({
      ready: {loginRequired: false, roomRefused: true, events: 0, roomEnterStatus: 403}
    })
  });
  const marks = [];
  const login = fakeBrowserLogin({marks});
  const settings = {tiktokTransport: 'browser'};
  const {db, sessionManager, service} = harness({
    settings,
    browserRelay: relay,
    browserLogin: login
  });
  try {
    assert.equal(service.transport().active, 'browser');
    await assert.rejects(
      () => service.connect('creator'),
      (error) => error.code === 'TIKTOK_ROOM_REFUSED'
        && error.details?.reason === 'room_enter_403'
        && error.details?.roomEnterStatus === 403
        && error.messageKey === 'errors.tiktokRoomRefused'
    );
    assert.equal(marks[0]?.type, 'refused');
    const status = service.status();
    assert.equal(status.login.state, TIKTOK_LOGIN_STATES.LOGGED_IN, 'the account is still logged in');
    assert.equal(status.login.roomAccess.state, 'refused');
    assert.equal(status.capture.state, 'platform_refused');
    assert.equal(status.capture.category, 'platform_refused');
    assert.equal(status.recordings.length, 0, 'a failed start must not leave a recording');
    assert.equal(status.recording, 'idle');
    assert.equal(status.transport.active, 'browser');

    settings.tiktokTransport = 'signer';
    const switched = service.status();
    assert.equal(switched.transport.active, 'signer');
    assert.equal(switched.capture, null, 'a browser failure is not shown as the signer channel state');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('a browser 403 does not discard events that the live page still delivers', async () => {
  const dir = createTempDir('tiktok-browser-403-events-');
  const frames = [{
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '403-chat-1', userId: '777', nickname: 'Viewer', content: 'still here'})
  }];
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({
      frames,
      ready: {loginRequired: false, roomRefused: true, events: frames.length, roomEnterStatus: 403}
    })
  });
  const marks = [];
  const login = fakeBrowserLogin({marks});
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: login
  });
  try {
    const result = await service.connect('creator');
    assert.ok(result.session.id);
    const status = service.status();
    assert.equal(status.login.state, TIKTOK_LOGIN_STATES.LOGGED_IN);
    assert.equal(status.capture.captureState, 'events_received');
    assert.equal(status.capture.eventsVerified, true);
    assert.equal(status.capture.roomEnterStatus, 403);
    assert.equal(marks.at(-1)?.type, 'verified');
    await service.disconnect({sessionId: result.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('starting a browser recording with no room confirmation is not shown as normal capture', async () => {
  const dir = createTempDir('tiktok-browser-unconfirmed-');
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({
      frames: [],
      ready: {loginRequired: false, events: 0, roomEnterStatus: null}
    })
  });
  const marks = [];
  const login = fakeBrowserLogin({marks});
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: login
  });
  try {
    const result = await service.connect('creator');
    assert.ok(result.session.id);
    const status = service.status();
    assert.equal(status.capture.captureState, 'room_unconfirmed');
    assert.equal(status.capture.eventsVerified, false);
    assert.equal(status.capture.category, 'room_unconfirmed');
    assert.notEqual(status.capture.category, 'normal');
    await service.disconnect({sessionId: result.session.id});
    assert.equal(service.status().capture.captureState, 'stopped', 'stopping must not fall back to a raw missing key');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('an expired login blocks a browser start instead of silently trying a stale profile', async () => {
  const dir = createTempDir('tiktok-browser-expired-');
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({frames: [], ready: {events: 0, roomEnterStatus: 200}})
  });
  const marks = [];
  const login = fakeBrowserLogin({state: TIKTOK_LOGIN_STATES.EXPIRED, marks});
  const {db, sessionManager, service} = harness({
    settings: {tiktokTransport: 'browser'},
    browserRelay: relay,
    browserLogin: login
  });
  try {
    await assert.rejects(
      () => service.connect('creator'),
      (error) => error.code === 'TIKTOK_LOGIN_REQUIRED'
        && error.details?.reason === 'session_expired'
        && error.details?.loginState === 'expired'
    );
    const status = service.status();
    assert.equal(status.login.state, TIKTOK_LOGIN_STATES.EXPIRED);
    assert.equal(status.recordings.length, 0);
    assert.equal(status.recording, 'idle');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});

test('an explicit browser selection never depends on the signing channel', async () => {
  const dir = createTempDir('tiktok-browser-no-signer-');
  const relay = new TikTokBrowserRelay({
    dataDir: dir.dir,
    sessionFactory: () => new FakeBrowserSession({frames: [], ready: {events: 0, roomEnterStatus: 200}})
  });
  const login = fakeBrowserLogin({});
  const settings = {tiktokTransport: 'auto'};
  const {db, sessionManager, service} = harness({
    settings,
    browserRelay: relay,
    browserLogin: login,
    signerOverride: {}
  });
  try {
    let transport = service.transport();
    assert.equal(transport.signerAvailable, false);
    assert.equal(transport.active, 'browser', 'auto falls back to the browser relay when the signer is missing');

    settings.tiktokTransport = 'browser';
    transport = service.transport();
    assert.equal(transport.active, 'browser');

    settings.tiktokTransport = 'signer';
    transport = service.transport();
    assert.equal(transport.active, null, 'an unavailable signer is reported, not silently replaced');
    await assert.rejects(
      () => service.connect('creator'),
      (error) => error.code === 'TIKTOK_SIGNER_UNAVAILABLE'
    );
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
    dir.cleanup();
  }
});
