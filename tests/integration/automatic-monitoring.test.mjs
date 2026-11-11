import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {MONITOR_STATE} from '../../src/monitoring/constants.mjs';
import {duplicateRoomError} from '../../src/shared/recording.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listMonitorTargetSessions} from '../../src/storage/repositories/monitor-targets.mjs';
import {buildAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

/**
 * Automatic-monitoring state machine with real SQLite, the real SessionManager
 * and a fake detector/adapter. No platform network is involved: this verifies
 * target persistence, session creation, reconnection vs. new broadcast, and the
 * "network error is not an end" rule.
 */

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const settings = {get: () => ({storageMode: 'compact'})};

function createAdapterFactory() {
  const adapters = [];
  const factory = ({sessionId}) => {
    const adapter = {
      sessionId,
      state: 'idle',
      context: null,
      stopped: 0,
      async start(context) {
        this.context = context;
        this.state = 'connected';
        context.onStateChange?.({state: 'connected', detail: {adapter: 'fake'}});
      },
      async stop() {
        this.stopped += 1;
        this.state = 'stopped';
      },
      snapshot() {
        return {id: 'fake', state: this.state, detail: {adapter: 'fake'}};
      },
      emit(draft) {
        this.context?.onEvent?.(draft);
      },
      platformStatus(info) {
        this.context?.onPlatformStatus?.(info);
      },
      reconnect() {
        this.state = 'reconnecting';
        this.context?.onStateChange?.({state: 'reconnecting', detail: {attempt: 2}});
      },
      end(reason = 'platform_ended') {
        this.state = 'stopped';
        this.context?.onPlatformStatus?.({
          status: 'ended',
          at: T0 + 1000,
          platformEndedAt: T0 + 1000,
          endQuality: 'event'
        });
        this.context?.onEnd?.({reason, platformStatus: 'ended'});
      }
    };
    adapters.push(adapter);
    return adapter;
  };
  return {factory, adapters};
}

function createHarness() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings, now});
  const sessions = [];
  const {factory, adapters} = createAdapterFactory();

  const bilibili = {
    async connectResolved(room, {monitorTargetId = null} = {}) {
      const result = await sessionManager.startPlatform({
        platform: 'bilibili',
        platformRoomId: String(room.roomId),
        roomTitle: room.title ?? `Bilibili ${room.roomId}`,
        broadcasterName: room.anchorName ?? 'Anchor',
        broadcasterUid: room.anchorUid ?? '4242',
        sourceQuality: 'verified',
        monitorTargetId,
        createAdapter: factory
      });
      if (!result.started) throw duplicateRoomError(result.duplicate);
      sessions.push(result.session.id);
      return result;
    }
  };

  const detector = {
    calls: 0,
    queue: [],
    async resolve(input) {
      const roomId = String(input).replace(/\D/g, '') || '1001';
      return {
        platform: 'bilibili',
        targetKey: roomId,
        displayName: 'Anchor A',
        platformUid: '4242',
        broadcasterId: `bilibili:4242`,
        input: String(input),
        meta: {anchorName: 'Anchor A'}
      };
    },
    async detect() {
      this.calls += 1;
      const next = this.queue.length > 0 ? this.queue.shift() : {status: 'offline'};
      if (next instanceof Error) throw next;
      return next;
    }
  };

  let changes = 0;
  const manager = new MonitoringManager({
    db,
    sessionManager,
    bilibili,
    youtube: null,
    now,
    detectors: {bilibili: detector},
    onChange: () => { changes += 1; },
    random: () => 0.5
  });

  return {
    db,
    manager,
    sessionManager,
    bilibili,
    detector,
    now,
    adapters,
    sessions,
    advance(ms) { clock += ms; },
    setClock(value) { clock = value; },
    get changes() { return changes; },
    async dispose() {
      manager.stop();
      await sessionManager.shutdown();
      db.close();
    }
  };
}

test('a target is persisted independently from the broadcast session', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const target = await harness.manager.createTarget({platform: 'bilibili', input: 'https://live.bilibili.com/1001'});
  assert.equal(target.platform, 'bilibili');
  assert.equal(target.targetKey, '1001');
  assert.equal(target.state, MONITOR_STATE.WAITING);
  assert.equal(target.enabled, true);
  assert.equal(target.broadcasterId, 'bilibili:4242');
  assert.ok(target.nextCheckInMs > 0);

  const list = harness.manager.listTargets();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, target.id);
  assert.equal(list[0].activeSessionId, null);

  await assert.rejects(
    () => harness.manager.createTarget({platform: 'bilibili', input: '1001'}),
    (error) => error.code === 'MONITOR_TARGET_EXISTS'
  );
});

test('live check creates one normal session, keeps it on reconnect and ends only when the platform confirms', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const target = await harness.manager.createTarget({platform: 'bilibili', input: '1001'});

  harness.detector.queue.push({status: 'offline', title: null, carousel: false});
  harness.advance(10000);
  await harness.manager.tick();
  assert.equal(harness.manager.getTarget(target.id).state, MONITOR_STATE.WAITING);
  assert.equal(harness.sessions.length, 0);

  harness.detector.queue.push({status: 'live', title: 'Live one', online: 10});
  harness.advance(120000);
  await harness.manager.tick();
  const recordingTarget = harness.manager.getTarget(target.id);
  assert.equal(recordingTarget.state, MONITOR_STATE.RECORDING);
  assert.equal(harness.sessions.length, 1);
  const firstSessionId = recordingTarget.activeSessionId;
  assert.equal(recordingTarget.lastSessionId, firstSessionId);
  const row = getSession(harness.db, firstSessionId);
  assert.equal(row.monitor_target_id, target.id);
  assert.equal(row.status, 'live');
  assert.equal(row.platform_room_id, '1001');
  assert.equal(row.broadcaster_id, 'bilibili:4242');

  // Reconnecting transport: same session, derived public state only.
  harness.adapters.at(-1).reconnect();
  harness.advance(30000);
  await harness.manager.tick();
  const reconnecting = harness.manager.getTarget(target.id);
  assert.equal(reconnecting.baseState, MONITOR_STATE.RECORDING);
  assert.equal(reconnecting.state, 'reconnecting');
  assert.equal(reconnecting.activeSessionId, firstSessionId);
  assert.equal(harness.sessions.length, 1);

  // A transient monitoring error while recording must not create or end a session.
  harness.advance(300000);
  await harness.manager.tick();
  assert.equal(harness.manager.getTarget(target.id).activeSessionId, firstSessionId);

  // Platform-confirmed end: the adapter ends the session; the target survives.
  harness.adapters.at(-1).end('platform_ended');
  harness.advance(1000);
  await harness.manager.tick();
  const waiting = harness.manager.getTarget(target.id);
  assert.equal(waiting.state, MONITOR_STATE.WAITING);
  assert.equal(waiting.activeSessionId, null);
  assert.equal(waiting.lastSessionId, firstSessionId);
  assert.equal(harness.sessions.length, 1);
  assert.equal(getSession(harness.db, firstSessionId).status, 'ended');
  assert.equal(getSession(harness.db, firstSessionId).end_reason, 'platform_ended');

  // Next broadcast: same target, a brand-new independent session.
  harness.detector.queue.push({status: 'live', title: 'Live two', online: 20});
  harness.advance(30000);
  await harness.manager.tick();
  const second = harness.manager.getTarget(target.id);
  assert.equal(second.state, MONITOR_STATE.RECORDING);
  assert.notEqual(second.activeSessionId, firstSessionId);
  assert.equal(harness.sessions.length, 2);
  assert.equal(getSession(harness.db, second.activeSessionId).status, 'live');

  const sessions = listMonitorTargetSessions(harness.db, target.id, {limit: 10});
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map((row) => row.status)), new Set(['live', 'ended']));
});

test('manual stop suppresses only the same live cycle, survives restart and allows a new cycle', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const target = await harness.manager.createTarget({platform: 'bilibili', input: '7007'});

  harness.detector.queue.push({status: 'live', title: 'Live one', liveStartedAt: 1000});
  harness.advance(10000);
  await harness.manager.tick();
  const first = harness.manager.getTarget(target.id);
  assert.equal(first.state, MONITOR_STATE.RECORDING);
  const firstSessionId = first.activeSessionId;
  assert.ok(firstSessionId);

  // User clicks "stop capture": the session ends with end_reason=user and the
  // monitoring target records a persistent suppression for this live cycle.
  await harness.sessionManager.stopSession(firstSessionId, {status: 'ended', reason: 'user'});
  const stopped = harness.manager.noteManualStop(firstSessionId);
  assert.equal(stopped.state, MONITOR_STATE.LIVE_STOPPED);
  assert.equal(stopped.activeSessionId, null);
  assert.equal(getSession(harness.db, firstSessionId).end_reason, 'user');
  assert.equal(stopped.meta.manualStop.liveKey, 'bilibili:7007:1000');

  // Polls and heartbeats still see LIVE for the same cycle: never restart.
  harness.detector.queue.push(
    {status: 'live', title: 'Live one', liveStartedAt: 1000},
    {status: 'live', title: 'Live one', liveStartedAt: 1000},
    {status: 'live', title: 'Live one', liveStartedAt: 1000}
  );
  for (let index = 0; index < 3; index += 1) {
    harness.advance(120000);
    await harness.manager.tick();
  }
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.manager.getTarget(target.id).state, MONITOR_STATE.LIVE_STOPPED);

  // Restart must not forget the suppression.
  harness.manager.stop();
  const restarted = new MonitoringManager({
    db: harness.db,
    sessionManager: harness.sessionManager,
    bilibili: harness.bilibili,
    youtube: null,
    now: harness.now,
    detectors: {bilibili: harness.detector},
    random: () => 0.5
  });
  restarted.recover();
  harness.detector.queue.push({status: 'live', title: 'Live one', liveStartedAt: 1000});
  harness.advance(120000);
  await restarted.tick();
  assert.equal(harness.sessions.length, 1);
  assert.equal(restarted.getTarget(target.id).state, MONITOR_STATE.LIVE_STOPPED);

  // A transient error is not evidence of the broadcast ending.
  harness.detector.queue.push(Object.assign(new Error('timeout'), {code: 'MONITOR_NETWORK'}));
  harness.advance(120000);
  await restarted.tick();
  harness.detector.queue.push({status: 'live', title: 'Live one', liveStartedAt: 1000});
  harness.advance(120000);
  await restarted.tick();
  assert.equal(harness.sessions.length, 1);
  assert.equal(restarted.getTarget(target.id).state, MONITOR_STATE.LIVE_STOPPED);

  // Confirmed offline releases the old cycle.
  harness.detector.queue.push({status: 'offline', title: null, liveStartedAt: null});
  harness.advance(120000);
  await restarted.tick();
  assert.equal(restarted.getTarget(target.id).state, MONITOR_STATE.WAITING);
  assert.equal(restarted.getTarget(target.id).meta.manualStop, null);

  // A genuinely new broadcast (new live_time) may start a new session.
  harness.detector.queue.push({status: 'live', title: 'Live two', liveStartedAt: 2000});
  harness.advance(120000);
  await restarted.tick();
  const second = restarted.getTarget(target.id);
  assert.equal(second.state, MONITOR_STATE.RECORDING);
  assert.equal(harness.sessions.length, 2);
  assert.notEqual(second.activeSessionId, firstSessionId);

  // Explicit "start capturing chat" is the only way to resume the same cycle.
  await harness.sessionManager.stopSession(second.activeSessionId, {status: 'ended', reason: 'user'});
  restarted.noteManualStop(second.activeSessionId);
  harness.detector.queue.push({status: 'live', title: 'Live two', liveStartedAt: 2000});
  const resumed = await restarted.updateTarget(target.id, {action: 'resume_capture'});
  assert.equal(resumed.state, MONITOR_STATE.RECORDING);
  assert.equal(harness.sessions.length, 3);
  assert.notEqual(resumed.activeSessionId, second.activeSessionId);
  restarted.stop();
});

test('a repeated check failure backs off and becomes a visible error without touching a session', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const target = await harness.manager.createTarget({platform: 'bilibili', input: '2002'});
  harness.detector.queue.push(
    Object.assign(new Error('network'), {code: 'MONITOR_NETWORK'}),
    Object.assign(new Error('network'), {code: 'MONITOR_NETWORK'}),
    Object.assign(new Error('network'), {code: 'MONITOR_NETWORK'}),
    Object.assign(new Error('network'), {code: 'MONITOR_NETWORK'})
  );
  for (let index = 0; index < 4; index += 1) {
    harness.advance(31 * 60 * 1000);
    await harness.manager.tick();
  }
  const failed = harness.manager.getTarget(target.id);
  assert.equal(failed.state, MONITOR_STATE.ERROR);
  assert.equal(failed.error.code, 'MONITOR_NETWORK');
  assert.equal(failed.consecutiveFailures, 4);
  assert.ok(failed.nextCheckInMs > 0);
  assert.equal(harness.sessions.length, 0);

  // Retry resets the failure counter and returns to waiting.
  const retried = await harness.manager.updateTarget(target.id, {action: 'retry'});
  assert.equal(retried.state, MONITOR_STATE.WAITING);
  assert.equal(retried.consecutiveFailures, 0);
  assert.equal(retried.error, null);

  // A 429 uses the platform Retry-After, not the normal interval.
  harness.detector.queue.push(Object.assign(new Error('rate'), {
    code: 'MONITOR_RATE_LIMITED',
    details: {retryAfterMs: 900000}
  }));
  harness.advance(5000);
  await harness.manager.tick();
  const limited = harness.manager.getTarget(target.id);
  assert.equal(limited.consecutiveFailures, 1);
  assert.ok(limited.nextCheckInMs >= 890000, `expected long retry, got ${limited.nextCheckInMs}`);
});

test('pause, resume and delete have distinct, explicit semantics', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const target = await harness.manager.createTarget({platform: 'bilibili', input: '3003'});

  const paused = await harness.manager.updateTarget(target.id, {action: 'pause'});
  assert.equal(paused.state, MONITOR_STATE.PAUSED);
  assert.equal(paused.enabled, false);
  await assert.rejects(() => harness.manager.checkNow(target.id), (error) => error.code === 'MONITOR_TARGET_PAUSED');

  // A paused target is never checked by the scheduler.
  harness.detector.queue.push({status: 'live', title: 'should not start'});
  harness.advance(60 * 60 * 1000);
  await harness.manager.tick();
  assert.equal(harness.sessions.length, 0);

  const resumed = await harness.manager.updateTarget(target.id, {action: 'resume'});
  assert.equal(resumed.state, MONITOR_STATE.WAITING);
  assert.equal(resumed.enabled, true);

  await assert.rejects(
    () => harness.manager.deleteTarget(target.id, {confirm: false}),
    (error) => error.code === 'DELETE_CONFIRM_REQUIRED'
  );

  harness.detector.queue.push({status: 'live', title: 'now live'});
  harness.advance(5000);
  await harness.manager.tick();
  assert.equal(harness.manager.getTarget(target.id).state, MONITOR_STATE.RECORDING);

  // Deleting while a capture is active is refused; the session is untouched.
  await assert.rejects(
    () => harness.manager.deleteTarget(target.id, {confirm: true}),
    (error) => error.code === 'MONITOR_TARGET_RECORDING'
  );
  assert.equal(harness.sessions.length, 1);
  assert.equal(getSession(harness.db, harness.sessions[0]).status, 'live');

  // After it ends, deletion removes only the target; the broadcast row stays.
  harness.adapters.at(-1).end('platform_ended');
  harness.advance(2000);
  await harness.manager.tick();
  const deleted = await harness.manager.deleteTarget(target.id, {confirm: true});
  assert.equal(deleted.deleted, true);
  assert.equal(harness.manager.getTarget(target.id), null);
  assert.equal(getSession(harness.db, harness.sessions[0]).status, 'ended');
});

test('a monitored session uses the normal M6/M7 session model', async (t) => {
  const harness = createHarness();
  const temp = createTempDir();
  t.after(async () => {
    await harness.dispose();
    temp.cleanup();
  });
  const target = await harness.manager.createTarget({platform: 'bilibili', input: '6006'});
  harness.detector.queue.push({status: 'live', title: 'Exportable broadcast'});
  harness.advance(10000);
  await harness.manager.tick();
  const sessionId = harness.manager.getTarget(target.id).activeSessionId;
  assert.ok(sessionId);

  harness.adapters.at(-1).emit({
    platform: 'bilibili',
    event_type: 'chat',
    viewer_uid: '9001',
    display_name: 'Viewer',
    occurred_at: T0 + 2000,
    content: 'hello from an automatically recorded broadcast',
    external_id: 'auto-msg-1',
    source_quality: 'verified'
  });

  const session = getSession(harness.db, sessionId);
  assert.equal(session.monitor_target_id, target.id);
  assert.equal(session.broadcaster_id, 'bilibili:4242');

  const built = await buildAnalysisPackage({
    db: harness.db,
    sessionId,
    locale: 'en',
    exportsDir: temp.dir,
    now: T0 + 5000
  });
  assert.ok(built);
  assert.equal(built.messageCount, 1);
  const inspection = await import('../../src/ai/export/package.mjs')
    .then((module) => module.inspectAnalysisPackage(built.absolutePath));
  assert.equal(inspection.manifest.protocol, 'livememory-analysis-v1');
  assert.equal(inspection.manifest.session_id, sessionId);
  assert.equal(inspection.manifest.counts.messages, 1);

  // Selecting the session through the monitoring API returns the same row the
  // AI export and long-term memory features already use.
  const rows = harness.manager.listSessions(target.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sessionId);
});

test('several targets are checked independently and a restart restores them', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const a = await harness.manager.createTarget({platform: 'bilibili', input: '4004'});
  const b = await harness.manager.createTarget({platform: 'bilibili', input: '5005'});
  assert.equal(harness.manager.listTargets().length, 2);

  harness.detector.queue.push({status: 'live', title: 'A live'}, {status: 'offline'});
  harness.advance(10000);
  await harness.manager.tick();
  const afterTick = harness.manager.listTargets();
  const stateA = afterTick.find((target) => target.id === a.id).state;
  const stateB = afterTick.find((target) => target.id === b.id).state;
  assert.equal(stateA, MONITOR_STATE.RECORDING);
  assert.equal(stateB, MONITOR_STATE.WAITING);
  assert.equal(harness.sessions.length, 1);

  // Simulate a crash: the session row is recovered as interrupted before the
  // scheduler restarts, and the target returns to waiting without losing its row.
  harness.manager.stop();
  harness.sessionManager.recoverInterrupted();
  const restarted = new MonitoringManager({
    db: harness.db,
    sessionManager: harness.sessionManager,
    bilibili: null,
    youtube: null,
    now: () => T0 + 10 * 60 * 1000,
    detectors: {bilibili: harness.detector},
    random: () => 0.5
  });
  restarted.recover();
  const restored = restarted.listTargets();
  assert.equal(restored.length, 2);
  const restoredA = restored.find((target) => target.id === a.id);
  assert.equal(restoredA.activeSessionId, null);
  assert.equal(restoredA.state, MONITOR_STATE.WAITING);
  assert.equal(restoredA.lastSessionId, harness.sessions[0]);
  assert.equal(getSession(harness.db, harness.sessions[0]).status, 'interrupted');
  restarted.stop();
});
