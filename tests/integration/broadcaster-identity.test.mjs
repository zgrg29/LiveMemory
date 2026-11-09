import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
import {createSession, endSession} from '../../src/storage/repositories/sessions.mjs';
import {
  broadcasterAudienceSummary,
  listBroadcasterViewers,
  upsertBroadcaster,
  viewerBroadcasterSupport,
  viewerBroadcasters
} from '../../src/storage/repositories/broadcasters.mjs';
import {viewerCurrencyTotals, viewerNicknameHistory, viewerSessionHistory} from '../../src/storage/repositories/viewers.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {buildViewerProfile} from '../../src/analytics/viewers/profile.mjs';
import {groupCurrencyTotals} from '../../src/analytics/payments/totals.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * Broadcaster identity and the broadcaster × viewer interaction context.
 *
 * These tests use the real repositories and ingest pipeline. They prove that a
 * single platform account can appear for two channels while every counter,
 * currency total and AI context stays separated.
 */

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const HOUR = 3_600_000;

function seed({file = null} = {}) {
  const db = openDatabase(file ? {file} : {memory: true});
  migrate(db, {now: T0});
  upsertBroadcaster(db, {
    id: 'youtube:UC_CHANNEL_A',
    platform: 'youtube',
    platformUid: 'UC_CHANNEL_A',
    displayName: 'Channel A',
    identity: 'verified',
    seenAt: T0
  });
  upsertBroadcaster(db, {
    id: 'youtube:UC_CHANNEL_B',
    platform: 'youtube',
    platformUid: 'UC_CHANNEL_B',
    displayName: 'Channel B',
    identity: 'verified',
    seenAt: T0 + 10 * HOUR
  });
  upsertBroadcaster(db, {
    id: 'bilibili:12345',
    platform: 'bilibili',
    platformUid: '12345',
    displayName: 'Bili channel',
    identity: 'verified',
    seenAt: T0 + 20 * HOUR
  });

  const sessionA = createSession(db, {
    id: 'ses_broadcaster_a',
    platform: 'youtube',
    platformRoomId: 'video-a',
    roomTitle: 'A live',
    broadcasterName: 'Channel A',
    broadcasterId: 'youtube:UC_CHANNEL_A',
    broadcasterIdentity: 'verified',
    startedAt: T0
  });
  const sessionB0 = createSession(db, {
    id: 'ses_broadcaster_b_old',
    platform: 'youtube',
    platformRoomId: 'video-b-old',
    roomTitle: 'B earlier live',
    broadcasterName: 'Channel B',
    broadcasterId: 'youtube:UC_CHANNEL_B',
    broadcasterIdentity: 'verified',
    startedAt: T0 + 9 * HOUR
  });
  const sessionB = createSession(db, {
    id: 'ses_broadcaster_b',
    platform: 'youtube',
    platformRoomId: 'video-b',
    roomTitle: 'B live',
    broadcasterName: 'Channel B',
    broadcasterId: 'youtube:UC_CHANNEL_B',
    broadcasterIdentity: 'verified',
    startedAt: T0 + 10 * HOUR
  });
  const sessionC = createSession(db, {
    id: 'ses_broadcaster_bili',
    platform: 'bilibili',
    platformRoomId: '5050',
    roomTitle: 'Bili live',
    broadcasterName: 'Bili channel',
    broadcasterId: 'bilibili:12345',
    broadcasterIdentity: 'verified',
    startedAt: T0 + 20 * HOUR
  });
  const ingest = new EventIngest({db, now: () => T0 + 21 * HOUR});

  function chat(session, uid, name, at, content, id) {
    return ingest.record({
      session_id: session.id,
      platform: session.platform,
      external_id: id,
      event_type: 'chat',
      viewer_uid: uid,
      display_name: name,
      occurred_at: at,
      content,
      source_quality: 'verified'
    });
  }
  function superChat(session, uid, name, at, amountMinor, amountDisplay, id) {
    return ingest.record({
      session_id: session.id,
      platform: session.platform,
      external_id: id,
      event_type: 'super_chat',
      viewer_uid: uid,
      display_name: name,
      occurred_at: at,
      content: 'support',
      amount_minor: amountMinor,
      amount_display: amountDisplay,
      currency: 'USD',
      value_kind: 'actual',
      is_paid: true,
      source_quality: 'verified'
    });
  }

  // The same platform account in both channels. Renames must not split it.
  chat(sessionA, 'UC_SAME', 'Same viewer', T0 + 1000, 'A hello', 'a-chat-1');
  superChat(sessionA, 'UC_SAME', 'Same viewer', T0 + 2000, 500, '$5.00', 'a-sc-1');
  chat(sessionA, 'UC_SAME', 'Same viewer renamed', T0 + 3000, 'A again', 'a-chat-2');
  // A different account with the same nickname as a viewer in channel B.
  chat(sessionA, 'UC_OTHER', 'Twin', T0 + 4000, 'A other', 'a-chat-3');

  chat(sessionB0, 'UC_SAME', 'Same viewer', T0 + 9 * HOUR + 1000, 'B older hello', 'b0-chat-1');
  chat(sessionB, 'UC_SAME', 'Same viewer renamed', T0 + 10 * HOUR + 1000, 'B hello', 'b-chat-1');
  superChat(sessionB, 'UC_SAME', 'Same viewer renamed', T0 + 10 * HOUR + 2000, 1000, '$10.00', 'b-sc-1');
  chat(sessionB, 'UC_BONLY', 'Twin', T0 + 10 * HOUR + 3000, 'B other', 'b-chat-2');

  // Same nickname on another platform must never merge.
  chat(sessionC, 'UC_SAME', 'Twin', T0 + 20 * HOUR + 1000, 'Bili hi', 'c-chat-1');

  endSession(db, sessionA.id, {status: 'ended', endedAt: T0 + 5000});
  endSession(db, sessionB0.id, {status: 'ended', endedAt: T0 + 9 * HOUR + 5000});
  endSession(db, sessionB.id, {status: 'ended', endedAt: T0 + 10 * HOUR + 5000});
  endSession(db, sessionC.id, {status: 'ended', endedAt: T0 + 20 * HOUR + 5000});
  return {db};
}

test('one platform account keeps two independent broadcaster contexts', () => {
  const {db} = seed();
  try {
    const aViewers = listBroadcasterViewers(db, 'youtube:UC_CHANNEL_A', {sort: 'messages'});
    const bViewers = listBroadcasterViewers(db, 'youtube:UC_CHANNEL_B', {sort: 'messages'});
    const sameA = aViewers.find((row) => row.id === 'youtube:UC_SAME');
    const sameB = bViewers.find((row) => row.id === 'youtube:UC_SAME');
    assert.ok(sameA);
    assert.ok(sameB);
    assert.equal(Number(sameA.scoped_message_count), 3);
    assert.equal(Number(sameA.scoped_payment_event_count), 1);
    assert.equal(Number(sameB.scoped_message_count), 3);
    assert.equal(Number(sameB.scoped_payment_event_count), 1);
    assert.equal(Number(sameA.scoped_session_count), 1);
    assert.equal(Number(sameB.scoped_session_count), 2);
    assert.equal(Number(sameA.broadcaster_count), 2);

    const supportA = groupCurrencyTotals(viewerBroadcasterSupport(db, 'youtube:UC_SAME', 'youtube:UC_CHANNEL_A'));
    const supportB = groupCurrencyTotals(viewerBroadcasterSupport(db, 'youtube:UC_SAME', 'youtube:UC_CHANNEL_B'));
    assert.equal(supportA[0].actualMinor, 500);
    assert.equal(supportB[0].actualMinor, 1000);
    const lifetime = groupCurrencyTotals(viewerCurrencyTotals(db, 'youtube:UC_SAME'));
    assert.equal(lifetime[0].actualMinor, 1500);

    const relationships = viewerBroadcasters(db, 'youtube:UC_SAME');
    assert.equal(relationships.length, 2);
    assert.deepEqual(relationships.map((row) => row.broadcaster_id).sort(), [
      'youtube:UC_CHANNEL_A',
      'youtube:UC_CHANNEL_B'
    ]);

    // A rename updates the profile but keeps one identity and two nicknames.
    const nicknames = viewerNicknameHistory(db, 'youtube:UC_SAME');
    assert.deepEqual(nicknames.map((row) => row.nickname).sort(), ['Same viewer', 'Same viewer renamed']);
    assert.equal(viewerSessionHistory(db, 'youtube:UC_SAME').length, 3);

    // Identical nicknames never merge accounts, across platforms either.
    const twinYoutube = listBroadcasterViewers(db, 'youtube:UC_CHANNEL_B', {query: 'Twin'});
    assert.equal(twinYoutube.length, 1);
    assert.equal(twinYoutube[0].id, 'youtube:UC_BONLY');
    const bili = listBroadcasterViewers(db, 'bilibili:12345', {query: 'Twin'});
    assert.equal(bili.length, 1);
    assert.equal(bili[0].id, 'bilibili:UC_SAME');
    assert.notEqual(bili[0].id, 'youtube:UC_SAME');

    const profile = buildViewerProfile(db, 'youtube:UC_SAME', {broadcasterId: 'youtube:UC_CHANNEL_A'});
    assert.equal(profile.viewer.id, 'youtube:UC_SAME');
    assert.equal(profile.viewer.broadcasterCount, 2);
    assert.equal(profile.scope.kind, 'broadcaster');
    assert.equal(profile.scope.messageCount, 3);
    assert.equal(profile.scope.paymentEventCount, 1);
    assert.equal(profile.scope.support[0].actualMinor, 500);
    assert.equal(profile.scope.sessions.length, 1);
    // Global lifetime stays explicitly separate.
    assert.equal(profile.viewer.messageCount, 6);
    assert.equal(profile.support[0].actualMinor, 1500);

    const summaryB = broadcasterAudienceSummary(db, 'youtube:UC_CHANNEL_B');
    assert.equal(summaryB.viewerCount, 2);
    assert.equal(summaryB.newViewers, 1);
    assert.equal(summaryB.returningViewers, 1);
    assert.equal(summaryB.sessionCount, 2);
    const summaryA = broadcasterAudienceSummary(db, 'youtube:UC_CHANNEL_A');
    assert.equal(summaryA.newViewers, 2);
    assert.equal(summaryA.returningViewers, 0);
  } finally {
    closeDatabase(db);
  }
});

test('the AI package carries only the current broadcaster context', async () => {
  const {db} = seed();
  const temp = createTempDir();
  try {
    const result = await buildAnalysisPackage({
      db,
      sessionId: 'ses_broadcaster_a',
      locale: 'en',
      exportsDir: temp.dir,
      now: T0 + 30 * HOUR
    });
    assert.ok(result);
    const inspected = await inspectAnalysisPackage(result.absolutePath);
    assert.ok(inspected.names.includes('session_context.json'));
    const sessionContext = JSON.parse(await readPackageEntry(result.absolutePath, 'session_context.json'));
    const viewerContext = JSON.parse(await readPackageEntry(result.absolutePath, 'viewer_context.json'));
    const instructions = await readPackageEntry(result.absolutePath, 'instructions.md');

    assert.equal(sessionContext.broadcaster.id, 'youtube:UC_CHANNEL_A');
    assert.equal(sessionContext.broadcaster.identity, 'verified');
    assert.equal(sessionContext.session.broadcaster_id, 'youtube:UC_CHANNEL_A');
    assert.equal(sessionContext.session.broadcaster_identity, 'verified');

    const same = viewerContext.find((entry) => entry.viewer_id === 'youtube:UC_SAME');
    assert.ok(same);
    assert.equal(same.broadcaster_id, 'youtube:UC_CHANNEL_A');
    assert.equal(same.broadcaster_context.message_count, 3);
    assert.equal(same.broadcaster_context.payment_event_count, 1);
    assert.equal(same.broadcaster_context.support[0].actualMinor, 500);
    assert.equal(same.lifetime.message_count, 6);
    assert.equal(same.lifetime.support[0].actualMinor, 1500);
    assert.equal(same.other_broadcaster_count, 1);
    assert.match(instructions, /Broadcaster context/);
    assert.match(instructions, /lifetime/);
    assert.match(instructions, /Channel A/);
  } finally {
    closeDatabase(db);
    temp.cleanup();
  }
});

async function readPackageEntry(absolutePath, name) {
  const {readZipEntry} = await import('../../src/shared/zip.mjs');
  return readZipEntry(await readFile(absolutePath), name).toString('utf8');
}

test('legacy history is attributed conservatively during the v5 migration', () => {
  const db = openDatabase({memory: true});
  const initial = MIGRATIONS.find((migration) => migration.version === 1);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
  `);
  initial.up(db);
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run(initial.name, T0);
  for (const migration of MIGRATIONS.filter((item) => item.version >= 2 && item.version <= 4)) {
    migration.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, T0);
  }
  const addSession = db.prepare(`
    INSERT INTO sessions (
      id, platform, platform_room_id, room_title, broadcaster_name, status,
      storage_mode, source_quality, simulated, started_at, ended_at, last_event_at,
      message_count, gift_event_count, payment_event_count, ai_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ended', 'compact', 'verified', 0, ?, ?, NULL, 1, 0, 0, 'none', ?, ?)
  `);
  addSession.run('ses_bili_room', 'bilibili', '5050', 'Old Bilibili', 'Anchor', T0, T0 + 1000, T0, T0);
  addSession.run('ses_yt_video', 'youtube', 'old-video-id', 'Old YouTube', 'Old Channel', T0 + HOUR, T0 + HOUR + 1000, T0 + HOUR, T0 + HOUR);
  addSession.run('ses_mock', 'mock', 'simulation', 'Old mock', null, T0 + 2 * HOUR, T0 + 2 * HOUR + 1000, T0 + 2 * HOUR, T0 + 2 * HOUR);
  db.prepare(`
    INSERT INTO viewers (id, platform, platform_uid, nickname, first_seen_at, last_seen_at, message_count, payment_event_count, focused, created_at, updated_at)
    VALUES ('bilibili:77', 'bilibili', '77', 'Bili viewer', ?, ?, 1, 0, 0, ?, ?)
  `).run(T0, T0, T0, T0);
  db.prepare(`
    INSERT INTO viewer_sessions (viewer_id, session_id, message_count, payment_event_count, first_seen_at, last_seen_at)
    VALUES ('bilibili:77', 'ses_bili_room', 1, 0, ?, ?)
  `).run(T0, T0);
  db.prepare(`
    INSERT INTO events (session_id, platform, external_id, event_type, viewer_id, viewer_uid, display_name, occurred_at, received_at, content, gift_quantity, value_kind, is_paid, source_quality, dedupe_key)
    VALUES ('ses_bili_room', 'bilibili', 'old-chat', 'chat', 'bilibili:77', '77', 'Bili viewer', ?, ?, 'old', 1, 'unknown', 0, 'verified', 'ext:old-chat')
  `).run(T0, T0);

  const result = migrate(db, {now: T0 + 3 * HOUR});
  assert.deepEqual(result.applied, [5, 6, 7]);
  assert.equal(currentSchemaVersion(db), 7);
  const bili = db.prepare('SELECT broadcaster_id, broadcaster_identity FROM sessions WHERE id = ?').get('ses_bili_room');
  assert.equal(bili.broadcaster_id, 'bilibili:room:5050');
  assert.equal(bili.broadcaster_identity, 'room_fallback');
  const yt = db.prepare('SELECT broadcaster_id, broadcaster_identity FROM sessions WHERE id = ?').get('ses_yt_video');
  assert.equal(yt.broadcaster_id, null);
  assert.equal(yt.broadcaster_identity, 'unresolved');
  const mock = db.prepare('SELECT broadcaster_id, broadcaster_identity FROM sessions WHERE id = ?').get('ses_mock');
  assert.equal(mock.broadcaster_id, 'mock:simulation');
  assert.equal(mock.broadcaster_identity, 'simulated');
  const relation = db.prepare('SELECT * FROM viewer_broadcasters WHERE viewer_id = ?').get('bilibili:77');
  assert.equal(relation.broadcaster_id, 'bilibili:room:5050');
  assert.equal(relation.message_count, 1);
  closeDatabase(db);
});

test('the HTTP scope endpoints return the same separated numbers', async (t) => {
  const temp = createTempDir();
  const {mkdirSync} = await import('node:fs');
  mkdirSync(`${temp.dir}\\database`, {recursive: true});
  const seeded = seed({file: `${temp.dir}\\database\\livememory.db`});
  closeDatabase(seeded.db);
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const list = await (await fetch(`${base}api/broadcasters`)).json();
  assert.ok(list.broadcasters.some((row) => row.id === 'youtube:UC_CHANNEL_A'));
  assert.ok(list.broadcasters.some((row) => row.id === 'youtube:UC_CHANNEL_B'));

  const scoped = await (await fetch(`${base}api/broadcasters/youtube:UC_CHANNEL_A/viewers?sort=messages`)).json();
  const same = scoped.viewers.find((row) => row.id === 'youtube:UC_SAME');
  assert.equal(same.scoped.messageCount, 3);
  assert.equal(same.scoped.support[0].actualMinor, 500);
  assert.equal(same.lifetime.messageCount, 6);
  assert.equal(same.broadcasterCount, 2);

  const detail = await (await fetch(`${base}api/viewers/youtube:UC_SAME?broadcasterId=youtube:UC_CHANNEL_B`)).json();
  assert.equal(detail.scope.broadcaster.id, 'youtube:UC_CHANNEL_B');
  assert.equal(detail.scope.messageCount, 3);
  assert.equal(detail.scope.support[0].actualMinor, 1000);
  assert.equal(detail.viewer.messageCount, 6);
  assert.equal(detail.broadcasters.length, 2);

  const all = await (await fetch(`${base}api/viewers?query=Same`)).json();
  assert.equal(all.scope.kind, 'all');
  assert.ok(all.viewers.some((row) => row.id === 'youtube:UC_SAME'));

  const history = await (await fetch(`${base}api/sessions?broadcasterId=youtube:UC_CHANNEL_A`)).json();
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].broadcasterId, 'youtube:UC_CHANNEL_A');
  assert.equal(history.sessions[0].broadcasterIdentity, 'verified');
});
