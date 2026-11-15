import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers, viewerCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {chatMessage, giftMessage, roomUserSeqMessage} from '../helpers/tiktok-frames.mjs';

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

function harness({queue} = {}) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});
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
  const signer = new FakeSigner(queue ?? [frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'chat-1', content: 'Hello 世界 😂'})}])]);
  const service = new TikTokService({
    sessionManager,
    db,
    client,
    signer,
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

    await waitFor(() => Number(getSession(db, sessionId).message_count) >= 1);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c >= 2);

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
  } finally {
    await sessionManager.shutdown().catch(() => {});
    db.close();
  }
});
