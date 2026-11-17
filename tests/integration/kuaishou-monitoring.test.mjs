import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {KuaishouService} from '../../src/platforms/kuaishou/service.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {liveCycleKey} from '../../src/monitoring/model.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {MONITOR_ERROR} from '../../src/monitoring/constants.mjs';
import {createKuaishouFetch, comment, feed, KUAISHOU_T0} from '../fixtures/kuaishou.mjs';

/**
 * Kuaishou monitoring through the shared scheduler. Fake fetch, real DB and
 * manager. Covers the disabled gate, offline waiting, automatic recording,
 * platform end, new-broadcast cycle key, inconclusive pages never ending a
 * session, and manual-stop suppression.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 5000, interval = 10, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(interval);
  }
}

function harness({enabled = true, rooms = {alpha: {}}, feeds = {}} = {}) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const state = {rooms, feeds};
  const baseFetch = createKuaishouFetch({rooms: state.rooms, feeds: state.feeds});
  let networkCalls = 0;
  const fetchImpl = async (url) => {
    networkCalls += 1;
    return baseFetch(url);
  };
  const sessionManager = new SessionManager({
    db,
    settings: {get: () => ({storageMode: 'compact'})},
    now: () => T0
  });
  const kuaishou = new KuaishouService({
    sessionManager,
    db,
    now: () => T0,
    access: enabled
      ? {enabled: true, status: 'internal-authorized', authorizationRequired: false}
      : {enabled: false, status: 'authorization-required', authorizationRequired: true},
    fetchImpl,
    adapterOptions: {
      pollIntervalMs: 10,
      statusIntervalMs: 20,
      statusOfflineConfirmations: 2,
      maxConsecutiveFailures: 4,
      maxBackoffMs: 30
    }
  });
  const manager = new MonitoringManager({
    db,
    sessionManager,
    kuaishou,
    logger: null,
    now: () => T0,
    random: () => 0.5
  });
  return {db, sessionManager, kuaishou, manager, state, networkCalls: () => networkCalls};
}

async function dueTick(manager, db, targetId) {
  db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(targetId);
  await manager.tick();
}

test('without authorisation a monitor target is refused before any network request', async () => {
  const {db, sessionManager, manager, networkCalls} = harness({enabled: false});
  try {
    await assert.rejects(
      () => manager.createTarget({platform: 'kuaishou', input: 'alpha'}),
      (error) => error.code === MONITOR_ERROR.RESTRICTED
    );
    assert.equal(networkCalls(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('an offline Kuaishou room can be monitored and never creates an empty session', async () => {
  const {db, sessionManager, manager} = harness({rooms: {alpha: {}}});
  try {
    const target = await manager.createTarget({platform: 'kuaishou', input: 'alpha'});
    assert.equal(target.platform, 'kuaishou');
    assert.equal(target.targetKey, 'alpha');
    assert.equal(target.state, 'waiting');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);

    await dueTick(manager, db, target.id);
    assert.equal(manager.getTarget(target.id).state, 'waiting');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a live Kuaishou room is detected once, recorded, ended by the platform and restarted only for a new stream id', async () => {
  const rooms = {alpha: {liveStreamId: 'L1', title: 'Alpha live'}};
  const feeds = {L1: [feed({feeds: [comment({content: 'monitor chat', time: KUAISHOU_T0 + 1})]})], L2: [feed({feeds: [comment({content: 'second broadcast', time: KUAISHOU_T0 + 2})]})]};
  const {db, sessionManager, manager, state} = harness({rooms, feeds});
  try {
    const target = await manager.createTarget({platform: 'kuaishou', input: 'alpha'});
    await dueTick(manager, db, target.id);
    const recording = manager.getTarget(target.id);
    assert.equal(recording.state, 'recording');
    assert.ok(recording.activeSessionId);
    const firstSessionId = recording.activeSessionId;
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(firstSessionId).c >= 1);

    const session = getSession(db, firstSessionId);
    assert.equal(session.platform, 'kuaishou');
    assert.equal(session.platform_room_id, 'alpha');
    assert.equal(session.broadcaster_id, 'kuaishou:alpha');
    const event = db.prepare('SELECT viewer_id, external_id, content FROM events WHERE session_id = ?').get(firstSessionId);
    assert.match(event.viewer_id, new RegExp(`^kuaishou:h5:12345@${firstSessionId}$`));
    assert.equal(event.external_id, null);
    assert.equal(event.content, 'monitor chat');

    await dueTick(manager, db, target.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'no duplicate session');
    assert.equal(manager.getTarget(target.id).state, 'recording');

    // Inconclusive pages must not end the broadcast.
    state.rooms.alpha = {rateLimited: true};
    await sleep(120);
    assert.equal(getSession(db, firstSessionId).status, 'live');
    state.rooms.alpha = {liveStreamId: 'L1', title: 'Alpha live'};

    // Two confirmed offline observations end the session.
    state.rooms.alpha = {};
    await waitFor(() => getSession(db, firstSessionId).status === 'ended', {label: 'platform end'});
    await dueTick(manager, db, target.id);
    assert.equal(manager.getTarget(target.id).state, 'waiting');

    // A new live stream id is a new cycle and may start a new session.
    state.rooms.alpha = {liveStreamId: 'L2', title: 'Alpha live again'};
    await dueTick(manager, db, target.id);
    const second = manager.getTarget(target.id);
    assert.equal(second.state, 'recording');
    assert.notEqual(second.activeSessionId, firstSessionId);
    assert.equal(liveCycleKey('kuaishou', {target_key: 'alpha'}, {status: 'live', liveStreamId: 'L2'}), 'kuaishou:alpha:L2');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a manual stop suppresses the same broadcast until a new live stream id appears', async () => {
  const rooms = {alpha: {liveStreamId: 'L1', title: 'Alpha'}};
  const feeds = {
    L1: [feed({feeds: [comment({content: 'one', time: KUAISHOU_T0 + 1})]})],
    L2: [feed({feeds: [comment({content: 'two', time: KUAISHOU_T0 + 2})]})]
  };
  const {db, sessionManager, manager, state} = harness({rooms, feeds});
  try {
    const target = await manager.createTarget({platform: 'kuaishou', input: 'alpha'});
    await dueTick(manager, db, target.id);
    const sessionId = manager.getTarget(target.id).activeSessionId;
    assert.ok(sessionId);
    manager.noteManualStop(sessionId);
    await sessionManager.stopSession(sessionId, {status: 'ended', reason: 'user'});
    await dueTick(manager, db, target.id);
    const held = manager.getTarget(target.id);
    assert.equal(held.state, 'live_stopped');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'same broadcast is not restarted');

    state.rooms.alpha = {liveStreamId: 'L2', title: 'Alpha again'};
    await dueTick(manager, db, target.id);
    const next = manager.getTarget(target.id);
    assert.equal(next.state, 'recording');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2, 'new broadcast records again');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
