import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';

/**
 * Session lifecycle with a controllable fake adapter. This exercises the real
 * SQLite rows, the real ingest pipeline and the real manager, but it is not a
 * real Bilibili capture: the platform transport is simulated.
 */

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const settings = {get: () => ({storageMode: 'compact'})};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, {timeout = 3000, interval = 10} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

class LifecycleAdapter {
  constructor(name) {
    this.name = name;
    this.context = null;
    this.state = 'idle';
    this.stopped = 0;
  }

  async start(context) {
    this.context = context;
    this.state = 'connected';
    context.onStateChange?.({state: 'connected', detail: {adapter: this.name}});
  }

  emit(draft) {
    this.context?.onEvent?.(draft);
  }

  status(info) {
    this.context?.onPlatformStatus?.(info);
  }

  end(info) {
    this.context?.onEnd?.(info);
  }

  async stop() {
    this.stopped += 1;
    this.state = 'stopped';
  }

  snapshot() {
    return {id: this.name, state: this.state, detail: {adapter: this.name}};
  }
}

function chat(room, at, content, externalId) {
  return {
    platform: 'bilibili',
    event_type: 'chat',
    viewer_uid: 'viewer-1',
    display_name: 'Viewer',
    occurred_at: at,
    content,
    external_id: externalId,
    source_quality: 'verified'
  };
}

function createHarness() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const manager = new SessionManager({db, settings, now: () => clock});
  return {
    db,
    manager,
    setClock(value) { clock = value; },
    now() { return clock; }
  };
}

async function start(harness, {room, name, broadcasterUid = null}) {
  const adapter = new LifecycleAdapter(name);
  const result = await harness.manager.startPlatform({
    platform: 'bilibili',
    platformRoomId: room,
    roomTitle: `${name} stream`,
    broadcasterName: name,
    broadcasterUid,
    sourceQuality: 'estimated',
    createAdapter: () => adapter
  });
  assert.equal(result.started, true, `${name} should start`);
  return {adapter, session: result.session};
}

test('ending one platform broadcast stops only that capture and freezes its row', async () => {
  const harness = createHarness();
  const {db, manager, setClock} = harness;
  try {
    const a = await start(harness, {room: '1001', name: 'A'});
    const b = await start(harness, {room: '1002', name: 'B'});
    const c = await start(harness, {room: '1003', name: 'C'});

    a.adapter.emit(chat('1001', T0 + 10, 'a1', 'a-1'));
    b.adapter.emit(chat('1002', T0 + 10, 'b1', 'b-1'));
    c.adapter.emit(chat('1003', T0 + 10, 'c1', 'c-1'));

    setClock(T0 + 1000);
    a.adapter.status({status: 'ending', at: T0 + 1000, source: 'websocket'});
    assert.equal(getSession(db, a.session.id).platform_status, 'ending');
    // The capture is still local-live while the end is being confirmed.
    assert.equal(getSession(db, a.session.id).status, 'live');

    setClock(T0 + 2000);
    a.adapter.status({
      status: 'ended',
      at: T0 + 2000,
      platformEndedAt: T0 + 2000,
      endQuality: 'event',
      source: 'websocket'
    });
    a.adapter.end({reason: 'platform_ended', platformStatus: 'ended', platformEndedAt: T0 + 2000, endQuality: 'event'});

    await waitFor(() => getSession(db, a.session.id).status === 'ended');

    const rowA = getSession(db, a.session.id);
    assert.equal(rowA.end_reason, 'platform_ended');
    assert.equal(rowA.platform_status, 'ended');
    assert.equal(rowA.platform_ended_at, T0 + 2000);
    assert.equal(rowA.platform_end_quality, 'event');
    assert.equal(rowA.ended_at, T0 + 2000);
    assert.equal(rowA.message_count, 1);

    // The other two broadcasts are untouched.
    assert.equal(getSession(db, b.session.id).status, 'live');
    assert.equal(getSession(db, c.session.id).status, 'live');
    assert.equal(getSession(db, b.session.id).platform_status, null);
    assert.equal(manager.listRecordings().length, 2);
    assert.equal(getSession(db, b.session.id).message_count, 1);
    assert.equal(getSession(db, c.session.id).message_count, 1);

    // A queued callback from the ended adapter must not append to the old row.
    a.adapter.emit(chat('1001', T0 + 3000, 'late', 'a-late'));
    assert.equal(getSession(db, a.session.id).message_count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(a.session.id).n, 1);

    // The ended capture is no longer in the running list.
    assert.deepEqual(
      manager.listRecordings().map((recording) => recording.sessionId).sort(),
      [b.session.id, c.session.id].sort()
    );
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('a manual stop stays a manual stop even when the platform was live', async () => {
  const harness = createHarness();
  const {db, manager, setClock} = harness;
  try {
    const d = await start(harness, {room: '2001', name: 'D'});
    setClock(T0 + 500);
    d.adapter.status({status: 'live', at: T0 + 500, lastLiveSeenAt: T0 + 500, source: 'poll'});
    setClock(T0 + 1000);
    const stopped = await manager.stopSession(d.session.id, {reason: 'user'});
    assert.equal(stopped.stopped, true);

    const row = getSession(db, d.session.id);
    assert.equal(row.status, 'ended');
    assert.equal(row.end_reason, 'user');
    assert.equal(row.ended_at, T0 + 1000);
    // The platform was last confirmed live. A manual stop must not rewrite it
    // to "ended", and it must not invent a platform end time.
    assert.equal(row.platform_status, 'live');
    assert.equal(row.platform_ended_at, null);
    assert.equal(row.last_live_seen_at, T0 + 500);

    d.adapter.emit(chat('2001', T0 + 2000, 'after-stop', 'd-late'));
    assert.equal(getSession(db, d.session.id).message_count, 0);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('a duplicate end callback ends the session once and never throws', async () => {
  const harness = createHarness();
  const {db, manager, setClock} = harness;
  try {
    const e = await start(harness, {room: '3001', name: 'E'});
    setClock(T0 + 1000);
    e.adapter.status({status: 'ended', at: T0 + 1000, platformEndedAt: T0 + 1000, endQuality: 'poll'});
    e.adapter.end({reason: 'platform_ended', platformStatus: 'ended', platformEndedAt: T0 + 1000, endQuality: 'poll'});
    e.adapter.end({reason: 'platform_ended', platformStatus: 'ended', platformEndedAt: T0 + 1000, endQuality: 'poll'});

    await waitFor(() => getSession(db, e.session.id).status === 'ended');
    await sleep(80);
    assert.equal(getSession(db, e.session.id).status, 'ended');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE end_reason = 'platform_ended'").get().n, 1);
    assert.equal(manager.listRecordings().length, 0);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('a quick restart of the same room creates a new session and keeps the old one', async () => {
  const harness = createHarness();
  const {db, manager, setClock} = harness;
  try {
    const first = await start(harness, {room: '4001', name: 'F'});
    first.adapter.emit(chat('4001', T0 + 10, 'first', 'f-1'));
    setClock(T0 + 1000);
    first.adapter.status({status: 'ended', at: T0 + 1000, platformEndedAt: T0 + 1000, endQuality: 'poll'});
    first.adapter.end({reason: 'platform_ended', platformStatus: 'ended'});
    await waitFor(() => getSession(db, first.session.id).status === 'ended');

    setClock(T0 + 2000);
    const second = await start(harness, {room: '4001', name: 'F2'});
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.status, 'live');
    assert.equal(getSession(db, first.session.id).status, 'ended');

    second.adapter.emit(chat('4001', T0 + 2010, 'second', 'f-2'));
    assert.equal(getSession(db, first.session.id).message_count, 1);
    assert.equal(getSession(db, second.session.id).message_count, 1);

    // The old adapter cannot write into the new session.
    first.adapter.emit(chat('4001', T0 + 2020, 'stale', 'f-stale'));
    assert.equal(getSession(db, second.session.id).message_count, 1);
  } finally {
    await manager.shutdown();
    db.close();
  }
});
