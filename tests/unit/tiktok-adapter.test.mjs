import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokAdapter} from '../../src/platforms/tiktok/adapter.mjs';
import {chatMessage, controlMessage, fetchResult, giftMessage, likeMessage, memberMessage, roomUserSeqMessage} from '../helpers/tiktok-frames.mjs';

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

class FakeSigner {
  constructor(batches) {
    this.batches = batches;
    this.calls = 0;
    this.mode = 'community-signer';
  }

  async connect({cursor = null} = {}) {
    this.calls += 1;
    if (this.batches instanceof Error) throw this.batches;
    if (typeof this.batches === 'function') return this.batches({cursor, call: this.calls});
    const batch = this.batches[Math.min(this.calls - 1, this.batches.length - 1)];
    if (batch instanceof Error) throw batch;
    return {fetchResult: batch, cookie: null, roomId: null, bytes: 1};
  }
}

function frame(messages, {cursor = 'c1'} = {}) {
  return {messages: messages.map((m) => ({method: m.method, payload: m.payload, envelopeMsgId: m.msgId ?? null})), cursor, internalExt: 'ext', fetchInterval: 2000, pushServer: null, routeParams: new Map(), needsAck: false};
}

class FakeClient {
  constructor(responses = []) {
    this.responses = responses;
    this.calls = 0;
  }

  async fetchGiftCatalog() {
    return new Map();
  }

  async resolveRoom() {
    this.calls += 1;
    const response = this.responses[Math.min(this.calls - 1, this.responses.length - 1)] ?? {isLive: true, status: 2};
    if (response instanceof Error) throw response;
    return {uniqueId: 'creator', roomId: '999', anchorUid: '42', anchorName: 'Creator', title: 'T', ...response};
  }
}

async function startAdapter(adapter, events = []) {
  const states = [];
  const ends = [];
  const platform = [];
  await adapter.start({
    onEvent: (event) => events.push(event),
    onStateChange: (change) => states.push(change),
    onEnd: (info) => ends.push(info),
    onPlatformStatus: (info) => platform.push(info)
  });
  return {states, ends, platform};
}

test('the adapter connects, emits real chat drafts and drops replayed message ids', async () => {
  const events = [];
  const signer = new FakeSigner([
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: '1', content: 'one'})}]),
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: '1', content: 'one'})},
      {method: 'WebcastChatMessage', payload: chatMessage({msgId: '2', content: 'two'})}])
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000,
    streakFlushMs: 100000
  });
  const {states} = await startAdapter(adapter, events);
  assert.ok(states.some((change) => change.state === 'connected'));
  await waitFor(() => events.length >= 2);
  assert.deepEqual(events.map((e) => e.content), ['one', 'two']);
  assert.equal(events[0].viewer_uid, '4242');
  assert.equal(adapter.counters.duplicates, 1);
  await adapter.stop();
  assert.equal(adapter.state, 'stopped');
});

test('a streak gift is emitted once with the final count', async () => {
  const events = [];
  const signer = new FakeSigner([
    frame([{method: 'WebcastGiftMessage', payload: giftMessage({msgId: 'g1', repeatCount: 1, repeatEnd: 0, groupId: '77'})}]),
    frame([{method: 'WebcastGiftMessage', payload: giftMessage({msgId: 'g2', repeatCount: 4, repeatEnd: 1, groupId: '77'})}])
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  await startAdapter(adapter, events);
  await waitFor(() => events.length === 1);
  assert.equal(events[0].event_type, 'gift');
  assert.equal(events[0].gift_quantity, 4);
  assert.equal(events[0].amount_minor, null);
  assert.equal(events[0].amount_display, '4 TikTok Diamonds');
  await adapter.stop();
});

test('a streak that never receives its final update is flushed instead of lost', async () => {
  const events = [];
  const signer = new FakeSigner([
    frame([{method: 'WebcastGiftMessage', payload: giftMessage({msgId: 'g3', repeatCount: 2, repeatEnd: 0, groupId: '88'})}]),
    frame([])
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000,
    streakFlushMs: 20
  });
  await startAdapter(adapter, events);
  await waitFor(() => events.length === 1);
  assert.equal(events[0].event_type, 'gift');
  assert.equal(events[0].gift_quantity, 2);
  await adapter.stop();
});

test('poll failures move through reconnecting back to connected without ending the session', async () => {
  const errors = new Error('temporary');
  errors.code = 'TIKTOK_NETWORK';
  const signer = new FakeSigner([
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'a'})}]),
    errors,
    frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: 'b'})}])
  ]);
  const events = [];
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
  const {states, ends} = await startAdapter(adapter, events);
  await waitFor(() => states.some((change) => change.state === 'reconnecting'));
  await waitFor(() => events.length >= 2);
  assert.equal(ends.length, 0);
  assert.ok(states.some((change) => change.state === 'connected' && states.indexOf(change) > 0));
  await adapter.stop();
});

test('two offline observations end the capture, one is not enough', async () => {
  const events = [];
  const client = new FakeClient([{isLive: false, status: 4}, {isLive: false, status: 4}]);
  const signer = new FakeSigner([frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: '7001'})}])]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client,
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 5,
    watchdogCheckMs: 100000
  });
  const {ends, platform} = await startAdapter(adapter, events);
  await waitFor(() => ends.length === 1);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(ends[0].quality, 'verified');
  assert.ok(platform.filter((p) => p.status === 'offline').length >= 2);
  await adapter.stop();
});

test('a stream-ended control message is only one offline observation', async () => {
  const events = [];
  const client = new FakeClient([{isLive: true, status: 2}]);
  const signer = new FakeSigner([
    frame([{method: 'WebcastControlMessage', payload: controlMessage({action: 3})}]),
    frame([])
  ]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client,
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  const {ends} = await startAdapter(adapter, events);
  await sleep(30);
  assert.equal(ends.length, 0);
  assert.equal(adapter.offlineObservations, 1);
  await adapter.stop();
});

test('member, like and viewer-count messages update counters but write no events', async () => {
  const events = [];
  const signer = new FakeSigner([frame([
    {method: 'WebcastMemberMessage', payload: memberMessage()},
    {method: 'WebcastLikeMessage', payload: likeMessage()},
    {method: 'WebcastRoomUserSeqMessage', payload: roomUserSeqMessage({viewerCount: 4321})}
  ])]);
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000
  });
  await startAdapter(adapter, events);
  await waitFor(() => adapter.counters.messages >= 3);
  assert.equal(events.length, 0);
  assert.equal(adapter.viewerCount, 4321);
  assert.equal(adapter.counters.ignored >= 2, true);
  await adapter.stop();
});

test('stop ends timers and a late batch is not emitted', async () => {
  const events = [];
  let release = null;
  const signer = {
    mode: 'community-signer',
    connect: () => new Promise((resolve) => {
      release = () => resolve({fetchResult: frame([{method: 'WebcastChatMessage', payload: chatMessage({msgId: '8001'})}])});
    })
  };
  const adapter = new TikTokAdapter({
    uniqueId: 'creator',
    roomId: '999',
    client: new FakeClient(),
    signer,
    pollIntervalMs: 5,
    statusIntervalMs: 100000,
    watchdogCheckMs: 100000,
    connectTimeoutMs: 50
  });
  await assert.rejects(() => adapter.start({onEvent: (event) => events.push(event)}), (error) => error.code === 'TIKTOK_CONNECT_TIMEOUT');
  await adapter.stop();
  release?.();
  await sleep(20);
  assert.equal(events.length, 0);
  assert.equal(adapter.state, 'stopped');
});
