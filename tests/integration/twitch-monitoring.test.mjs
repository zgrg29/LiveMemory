import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TwitchService} from '../../src/platforms/twitch/service.mjs';
import {TwitchChannelDetector} from '../../src/monitoring/detectors/twitch.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {MONITOR_STATE} from '../../src/monitoring/constants.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {getMonitorTarget} from '../../src/storage/repositories/monitor-targets.mjs';

/**
 * Automatic Twitch monitoring with the real detector, TwitchService,
 * SessionManager and SQLite. The only fake parts are the public metadata client
 * and the WebSocket, so no real Twitch request is made.
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

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(data) {
    this.sent.push(String(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
FakeSocket.instances = [];

test('a Twitch monitor target starts a session when the channel goes live', async () => {
  FakeSocket.instances = [];
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});

  const state = {live: false};
  const client = {
    async getChannel(login) {
      return {
        login,
        channelId: '71092938',
        displayName: 'xQc',
        title: state.live ? 'LIVE NOW' : 'Offline',
        game: 'Just Chatting',
        isLive: state.live,
        streamId: state.live ? 'stream-1' : null,
        startedAt: state.live ? T0 : null,
        viewers: state.live ? 1234 : null,
        checkedAt: clock
      };
    }
  };
  const twitch = new TwitchService({
    sessionManager,
    db,
    client,
    WebSocketImpl: FakeSocket,
    now,
    adapterOptions: {
      heartbeatMs: 100000,
      watchdogMs: 100000,
      statusIntervalMs: 100000
    }
  });
  const detector = new TwitchChannelDetector({client, now});
  const monitoring = new MonitoringManager({
    db,
    sessionManager,
    twitch,
    now,
    detectors: {twitch: detector},
    random: () => 0.5
  });

  try {
    const target = await monitoring.createTarget({platform: 'twitch', input: 'xqc'});
    assert.equal(target.platform, 'twitch');
    assert.equal(target.targetKey, 'xqc');
    assert.equal(target.platformUid, '71092938');
    assert.equal(target.state, MONITOR_STATE.WAITING);

    state.live = true;
    const checking = monitoring.checkNow(target.id);
    await waitFor(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0];
    socket.emit('open', {});
    socket.emit('message', {data: '@room-id=71092938 :tmi.twitch.tv ROOMSTATE #xqc'});
    const result = await checking;

    assert.equal(result.state, MONITOR_STATE.RECORDING);
    assert.ok(result.activeSessionId);
    const row = getMonitorTarget(db, target.id);
    assert.equal(row.state, MONITOR_STATE.RECORDING);
    assert.equal(row.active_session_id, result.activeSessionId);
    assert.equal(getSession(db, result.activeSessionId).platform, 'twitch');
    assert.equal(getSession(db, result.activeSessionId).broadcaster_id, 'twitch:71092938');

    socket.emit('message', {
      data: '@display-name=Alice;user-id=1001;login=alice;id=auto-1;room-id=71092938;tmi-sent-ts=1700000000000'
        + ' :alice!alice@alice.tmi.twitch.tv PRIVMSG #xqc :auto monitored'
    });
    await waitFor(() => getSession(db, result.activeSessionId).message_count === 1);
    const event = db.prepare('SELECT viewer_id, content FROM events WHERE session_id = ?').get(result.activeSessionId);
    assert.equal(event.viewer_id, 'twitch:1001');
    assert.equal(event.content, 'auto monitored');

    // Stopping the capture does not delete the target; it returns to waiting.
    await sessionManager.stopSession(result.activeSessionId, {status: 'ended', reason: 'user'});
    await monitoring.tick();
    const after = getMonitorTarget(db, target.id);
    assert.equal(after.active_session_id, null);
    assert.equal(after.last_session_id, result.activeSessionId);
    assert.equal(after.state, MONITOR_STATE.WAITING);
    assert.ok(after.next_check_at > clock);
  } finally {
    monitoring.stop();
    await sessionManager.shutdown().catch(() => {});
  }
});
