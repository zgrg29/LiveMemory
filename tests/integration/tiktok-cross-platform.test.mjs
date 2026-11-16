import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../src/storage/repositories/viewers.mjs';
import {chatMessage, fetchResult} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';
import {encodePushFrame} from '../../src/platforms/tiktok/webcast.mjs';

/**
 * Cross-platform concurrency: a real TikTok local adapter next to a second
 * LiveMemory platform adapter, sharing one SessionManager and one SQLite file.
 *
 * The TikTok socket is fake and the Bilibili adapter is a controllable test
 * transport (`FakeBilibiliAdapter`), so this is an automated isolation test,
 * not a real-platform capture. Its purpose is to prove that starting, stopping
 * or failing one platform never touches a recording of another platform.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 6000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function tiktokRoom() {
  return {
    uniqueId: 'creator',
    roomId: '7700000000000000999',
    anchorUid: 'anchor-tiktok-999',
    anchorName: 'TikTok Creator',
    isLive: true,
    status: 2,
    title: 'TikTok live',
    startedAt: T0,
    checkedAt: T0,
    liveUrl: 'https://www.tiktok.com/@creator/live'
  };
}

function fakeTikTokClient(rooms) {
  return {
    async resolveRoom(input) {
      const uniqueId = typeof input === 'string' ? input : input?.uniqueId;
      const found = rooms[String(uniqueId).replace(/^@/, '')];
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async checkRoom(input) {
      return this.resolveRoom(input);
    },
    async fetchRoomInfo(roomId) {
      const found = Object.values(rooms).find((entry) => entry.roomId === roomId);
      if (!found) throw Object.assign(new Error('not found'), {code: 'TIKTOK_ROOM_NOT_FOUND'});
      return found;
    },
    async fetchGiftCatalog() {
      return new Map();
    }
  };
}

function fakeTtwid() {
  return {
    get: async () => 'anon-device-cookie-value',
    snapshot: () => ({cached: true, fetchCount: 1, retryCount: 0, source: 'test'})
  };
}

class FakeBilibiliAdapter {
  constructor() {
    this.state = 'idle';
    this.handlers = null;
    this.stopped = 0;
  }

  async start(context) {
    this.handlers = context;
    this.state = 'connected';
    context.onStateChange?.({state: 'connected', detail: {fake: 'bilibili'}});
  }

  emit(draft) {
    this.handlers?.onEvent?.(draft);
  }

  async stop() {
    this.stopped += 1;
    this.state = 'stopped';
  }

  snapshot() {
    return {id: 'fake-bilibili', state: this.state};
  }
}

function biliChat(externalId, uid, content) {
  return {
    platform: 'bilibili',
    event_type: 'chat',
    viewer_uid: uid,
    display_name: 'Bili Viewer',
    occurred_at: T0 + 1000,
    content,
    external_id: externalId,
    source_quality: 'verified'
  };
}

async function connectTikTok(service, input) {
  const before = FakeWebSocket.instances.length;
  const running = service.connect(input);
  const ws = await waitFor(() => (
    FakeWebSocket.instances.length > before ? FakeWebSocket.instances.at(-1) : null
  ));
  if (ws.readyState === 0) ws.open();
  const result = await running;
  return {result, ws};
}

function frame(entries) {
  return encodePushFrame({payload: gzipSync(fetchResult({messages: entries}))});
}

function eventCount(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c;
}

test('TikTok and Bilibili record at the same time without sharing lifecycle', async () => {
  FakeWebSocket.reset();
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const sessionManager = new SessionManager({
    db,
    settings: {get: () => ({storageMode: 'compact'})},
    now: () => T0
  });
  const tiktok = new TikTokService({
    sessionManager,
    db,
    client: fakeTikTokClient({creator: tiktokRoom()}),
    ttwidProvider: fakeTtwid(),
    WebSocketImpl: FakeWebSocket,
    now: () => T0,
    adapterOptions: {
      statusIntervalMs: 100000,
      statusCheckDelayMs: 100000,
      streakFlushMs: 100000,
      maxBackoffMs: 30,
      heartbeatIntervalMs: 100000
    }
  });
  const biliAdapter = new FakeBilibiliAdapter();

  try {
    const tt = await connectTikTok(tiktok, '@creator');
    const bili = await sessionManager.startPlatform({
      platform: 'bilibili',
      platformRoomId: '5050',
      roomTitle: 'Bilibili room',
      broadcasterName: 'Bili Anchor',
      broadcasterUid: '9001',
      sourceQuality: 'verified',
      simulated: false,
      createAdapter: () => biliAdapter
    });
    assert.equal(bili.started, true);

    const sessionTikTok = tt.result.session.id;
    const sessionBili = bili.session.id;
    assert.notEqual(sessionTikTok, sessionBili);
    assert.equal(sessionManager.listRecordings().length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'live'").get().c, 2);

    tt.ws.deliver(frame([{
      method: 'WebcastChatMessage',
      payload: chatMessage({msgId: '9301', userId: '501', nickname: 'TT Viewer', content: 'from TikTok'}),
      msgId: 9301n
    }]));
    biliAdapter.emit(biliChat('bili-1', '601', 'from Bilibili'));
    await waitFor(() => eventCount(db, sessionTikTok) === 1 && eventCount(db, sessionBili) === 1);

    assert.equal(db.prepare('SELECT viewer_uid FROM events WHERE session_id = ?').get(sessionTikTok).viewer_uid, '501');
    assert.equal(db.prepare('SELECT viewer_uid FROM events WHERE session_id = ?').get(sessionBili).viewer_uid, '601');
    assert.deepEqual(listSessionViewers(db, sessionTikTok).map((row) => row.platform_uid), ['501']);
    assert.deepEqual(listSessionViewers(db, sessionBili).map((row) => row.platform_uid), ['601']);
    assert.equal(getSession(db, sessionTikTok).platform, 'tiktok');
    assert.equal(getSession(db, sessionBili).platform, 'bilibili');

    // Stopping TikTok leaves the Bilibili recording live and ingesting.
    const stopped = await tiktok.disconnect({sessionId: sessionTikTok});
    assert.equal(stopped.stopped, true);
    assert.equal(getSession(db, sessionTikTok).status, 'ended');
    assert.equal(getSession(db, sessionBili).status, 'live');
    assert.equal(biliAdapter.stopped, 0, 'TikTok stop never touches the Bilibili adapter');
    assert.equal(sessionManager.listRecordings().length, 1);

    biliAdapter.emit(biliChat('bili-2', '601', 'Bilibili still recording'));
    await waitFor(() => eventCount(db, sessionBili) === 2);
    assert.equal(eventCount(db, sessionTikTok), 1);

    // A platform-level end also stays scoped: ending Bilibili leaves no
    // recording and never reopens TikTok.
    const biliStopped = await sessionManager.stopSession(sessionBili, {status: 'ended', reason: 'user'});
    assert.equal(biliStopped.stopped, true);
    assert.equal(getSession(db, sessionBili).status, 'ended');
    assert.equal(getSession(db, sessionTikTok).status, 'ended');
    assert.equal(sessionManager.listRecordings().length, 0);

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
    closeDatabase(db);
  }
});
