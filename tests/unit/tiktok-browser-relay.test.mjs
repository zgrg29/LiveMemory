import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokBrowserAdapter} from '../../src/platforms/tiktok/browser-relay.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSession {
  constructor({ready = {}, closeOnLaunch = false} = {}) {
    this.ready = ready;
    this.alive = false;
    this.closed = false;
    this.onFrame = () => {};
    this.onClose = () => {};
    this.onRoomStatus = () => {};
    this.closeOnLaunch = closeOnLaunch;
  }

  async launch() {
    this.alive = true;
    if (this.closeOnLaunch) this.onClose();
    return this;
  }

  isAlive() {
    return this.alive && !this.closed;
  }

  async waitForReady() {
    return {closed: false, loginRequired: false, roomRefused: false, events: 0, roomEnterStatus: 200, ...this.ready};
  }

  async close() {
    this.closed = true;
    this.alive = false;
  }
}

function adapterWith(factory, options = {}) {
  return new TikTokBrowserAdapter({
    uniqueId: 'creator',
    roomId: '900001',
    sessionFactory: factory,
    loginWaitMs: 100,
    refusedGraceMs: 30,
    streakFlushMs: 100000,
    ...options
  });
}

async function waitUntil(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

test('a room-entry 403 after start fails the capture instead of showing normal recording', async () => {
  const session = new FakeSession({ready: {events: 0, roomEnterStatus: 200}});
  const ended = [];
  const adapter = adapterWith(() => session);
  try {
    await adapter.start({onEnd: (info) => ended.push(info)});
    assert.equal(adapter.state, 'connected');
    assert.equal(adapter.capture().category, 'waiting_events');

    session.onRoomStatus({status: 403, at: Date.now()});
    assert.equal(await waitUntil(() => adapter.state === 'failed'), true);
    const capture = adapter.capture();
    assert.equal(capture.category, 'platform_refused');
    assert.equal(capture.captureState, 'platform_refused');
    assert.equal(capture.roomAccess.state, 'refused');
    assert.equal(ended.at(-1)?.reason, 'room_access_refused');
  } finally {
    await adapter.stop();
  }
});

test('real frames after a late 403 keep the capture working and keep the warning', async () => {
  const session = new FakeSession({ready: {events: 0, roomEnterStatus: 200}});
  const adapter = adapterWith(() => session, {refusedGraceMs: 1000});
  try {
    await adapter.start();
    session.onRoomStatus({status: 403, at: Date.now()});
    assert.equal(adapter.capture().category, 'room_unconfirmed');
    session.onFrame({
      method: 'WebcastChatMessage',
      payload: Buffer.concat([
        Buffer.from([0x0a, 0x04, 0x12, 0x02, 0x08, 0x01])
      ])
    });
    // A malformed frame is ignored; use a valid mapping through the real helper.
    const {chatMessage} = await import('../helpers/tiktok-frames.mjs');
    session.onFrame({method: 'WebcastChatMessage', payload: chatMessage({msgId: 'late-1', content: 'after 403'})});
    const capture = adapter.capture();
    assert.equal(capture.eventsVerified, true);
    assert.equal(capture.category, 'normal');
    assert.equal(capture.roomAccess.state, 'refused');
  } finally {
    await adapter.stop();
  }
});

test('closing the dedicated browser while recording reconnects to the same session', async () => {
  const first = new FakeSession({ready: {events: 1, roomEnterStatus: 200}});
  const second = new FakeSession({ready: {events: 2, roomEnterStatus: 200}});
  let calls = 0;
  const adapter = adapterWith(() => (calls++ === 0 ? first : second));
  try {
    await adapter.start();
    assert.equal(adapter.capture().eventsVerified, true);
    first.alive = false;
    first.onClose();
    assert.equal(await waitUntil(() => adapter.recoveries === 1 && adapter.state === 'connected'), true);
    assert.equal(adapter.reconnectAttempts, 1);
    assert.equal(adapter.session, second);
    assert.equal(adapter.capture().eventsVerified, true);
  } finally {
    await adapter.stop();
  }
});
