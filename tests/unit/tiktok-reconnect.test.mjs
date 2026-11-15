import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokAdapter} from '../../src/platforms/tiktok/adapter.mjs';
import {TikTokError, TIKTOK_ERRORS} from '../../src/platforms/tiktok/errors.mjs';
import {chatMessage} from '../helpers/tiktok-frames.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function frame(messages = [], {cursor = 'c1'} = {}) {
  return {
    messages: messages.map((message) => ({method: message.method, payload: message.payload, envelopeMsgId: null})),
    cursor,
    internalExt: 'ext',
    fetchInterval: 0,
    pushServer: null,
    routeParams: new Map(),
    needsAck: false
  };
}

class SequenceSigner {
  constructor(queue) {
    this.queue = queue;
    this.calls = 0;
    this.cursors = [];
    this.mode = 'community-signer';
  }

  availability() {
    return {limit: 30, windowMs: 3_600_000, remaining: 10, resetAt: Date.now() + 3_600_000, nextAllowedAt: 0};
  }

  async connect({cursor = null} = {}) {
    this.calls += 1;
    this.cursors.push(cursor);
    const entry = this.queue[Math.min(this.calls - 1, this.queue.length - 1)];
    if (typeof entry === 'function') return entry({cursor, call: this.calls});
    if (entry instanceof Error) throw entry;
    return {fetchResult: entry};
  }
}

class FakeClient {
  constructor({isLive = true, roomId = '999'} = {}) {
    this.isLive = isLive;
    this.roomId = roomId;
    this.resolveCalls = 0;
  }

  async fetchGiftCatalog() {
    return new Map();
  }

  async resolveRoom() {
    this.resolveCalls += 1;
    return {uniqueId: 'creator', roomId: this.roomId, anchorUid: '42', anchorName: 'Creator', isLive: this.isLive, status: this.isLive ? 2 : 4};
  }

  async fetchRoomInfo() {
    return {roomId: this.roomId, isLive: this.isLive, status: this.isLive ? 2 : 4};
  }
}

test('a 429 enters waiting-for-quota and never retries before the advertised delay', async () => {
  const error = new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
    messageKey: 'errors.tiktokRateLimit',
    httpStatus: 429,
    status: 429,
    retryAfterMs: 600000,
    details: {rateLimit: {limit: 30, remaining: 0, resetAt: Date.now() + 600000}}
  });
  const signer = new SequenceSigner([error]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  const states = [];
  await adapter.start({onStateChange: (change) => states.push(change)});
  assert.ok(states.some((change) => change.state === 'rate_limited'));
  assert.equal(adapter.state, 'rate_limited');
  assert.ok(adapter.nextPollAt - Date.now() > 500000);
  await sleep(30);
  assert.equal(signer.calls, 1, 'no rapid retry inside the rate-limit window');
  await adapter.stop();
});

test('an empty batch is a healthy poll, not a reconnect', async () => {
  const signer = new SequenceSigner([frame([]), frame([])]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  const states = [];
  await adapter.start({onStateChange: (change) => states.push(change)});
  await waitFor(() => adapter.counters.emptyBatches >= 1);
  assert.equal(adapter.state, 'connected');
  assert.equal(states.some((change) => change.state === 'reconnecting'), false);
  assert.equal(adapter.capture().category, 'normal');
  assert.equal(adapter.capture().lastEventAt, null);
  await adapter.stop();
});

test('a protocol error resets the cursor instead of retrying a stale one forever', async () => {
  const protocol = new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
    messageKey: 'errors.tiktokProtocol',
    details: {reason: 'missing_cursor'}
  });
  const signer = new SequenceSigner([
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'a1', content: 'one'})}], {cursor: 'stale'}),
    protocol,
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'a2', content: 'two'})}], {cursor: 'fresh'})
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    maxBackoffMs: 10,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  await adapter.start();
  await waitFor(() => signer.calls >= 3);
  assert.deepEqual(signer.cursors.slice(0, 3), [null, 'stale', null]);
  assert.ok(adapter.cursorResets >= 1);
  await waitFor(() => adapter.state === 'connected');
  await adapter.stop();
});

test('recovery records interruption, recovery and a possible gap timestamp', async () => {
  const network = Object.assign(new Error('temporary'), {code: TIKTOK_ERRORS.NETWORK});
  const signer = new SequenceSigner([
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'g1', content: 'before'})}]),
    network,
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'g2', content: 'after'})}])
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    maxBackoffMs: 10,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  await adapter.start();
  await waitFor(() => adapter.lastGap);
  const gap = adapter.lastGap;
  assert.ok(gap.startedAt > 0);
  assert.ok(gap.endedAt >= gap.startedAt);
  assert.equal(gap.possibleMissed, true);
  assert.equal(gap.note, 'upstream_history_not_backfilled');
  assert.ok(adapter.recoveredCount >= 1);
  assert.ok(adapter.capture().possibleGap);
  await adapter.stop();
});

test('a room change is confirmed offline and ends the same session', async () => {
  const client = new FakeClient({isLive: true, roomId: '999'});
  const signer = new SequenceSigner([frame([])]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client,
    signer,
    pollIntervalMs: 100,
    statusIntervalMs: 5,
    statusCheckDelayMs: 5,
    watchdogCheckMs: 100000
  });
  const ends = [];
  await adapter.start({onEnd: (info) => ends.push(info)});
  client.roomId = '1000';
  await waitFor(() => ends.length === 1);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(adapter.state, 'stopped');
  await adapter.stop();
});

test('a fatal premium refusal rejects the start with a user-action state', async () => {
  const error = new TikTokError(TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, {
    messageKey: 'errors.tiktokSignerPremiumRequired',
    httpStatus: 403
  });
  const signer = new SequenceSigner([error]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  await assert.rejects(() => adapter.start(), (failure) => failure.code === TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED);
  assert.equal(adapter.started, false);
  await adapter.stop();
});
