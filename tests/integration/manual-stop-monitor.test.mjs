import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {createSession, endSession, getSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {stopSessionRecording} from '../../src/server/session-admin.mjs';

function setup() {
  const db = openDatabase({memory: true});
  migrate(db);
  upsertBroadcaster(db, {
    id: 'bilibili:1',
    platform: 'bilibili',
    platformUid: '1',
    displayName: 'Anchor',
    identity: 'verified',
    seenAt: 1000,
    now: 1000
  });
  const session = createSession(db, {
    id: 'ses_stop_monitor',
    platform: 'bilibili',
    platformRoomId: '123',
    roomTitle: 'Stop test',
    broadcasterName: 'Anchor',
    broadcasterId: 'bilibili:1',
    broadcasterIdentity: 'verified',
    storageMode: 'compact',
    sourceQuality: 'verified',
    simulated: false,
    startedAt: 1000,
    now: 1000
  });
  const calls = [];
  const sessionManager = {
    async stopSession(id, {status, reason}) {
      endSession(db, id, {status, endedAt: 2000, reason});
      return {stopped: true, session: getSession(db, id)};
    }
  };
  const monitoring = {
    noteManualStop(id) {
      calls.push(id);
      return null;
    }
  };
  return {db, session, sessionManager, monitoring, calls};
}

test('a user stop records a manual-stop suppression for the monitoring target', async () => {
  const {db, session, sessionManager, monitoring, calls} = setup();
  try {
    await stopSessionRecording({
      deps: {db, sessionManager, monitoring, logger: {warn() {}}},
      sessionId: session.id,
      reason: 'user'
    });
    assert.deepEqual(calls, [session.id]);
  } finally {
    db.close();
  }
});

test('an adapter/platform end is not treated as a user manual stop', async () => {
  const {db, session, sessionManager, monitoring, calls} = setup();
  try {
    await stopSessionRecording({
      deps: {db, sessionManager, monitoring, logger: {warn() {}}},
      sessionId: session.id,
      reason: 'platform_ended'
    });
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});
