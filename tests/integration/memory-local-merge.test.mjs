import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  addBroadcaster,
  openMemoryDb,
  seedSession,
  T0
} from '../helpers/ai-fixtures.mjs';
import {importSessionAnalysis, T_DAY} from '../helpers/memory-fixtures.mjs';
import {mergeSessionIntoMemory, selectAnalysisSource} from '../../src/memory/local.mjs';
import {buildViewerMemoryView} from '../../src/memory/view.mjs';
import {getMemory, listFacts, listVersions} from '../../src/storage/repositories/viewer-memory.mjs';

function withDbAndExports(fn) {
  return async () => {
    const db = openMemoryDb();
    const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-'));
    try {
      await fn({db, exportsDir});
    } finally {
      db.close();
      rmSync(exportsDir, {recursive: true, force: true});
    }
  };
}

const BROADCASTER = 'youtube:UC_AI_TEST';
const VIEWER_0 = 'youtube:UC_VIEWER_0';
const VIEWER_1 = 'youtube:UC_VIEWER_1';

test('the first merge creates memory version 1 from imported session analysis', withDbAndExports(async ({db, exportsDir}) => {
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 20, viewerCount: 2});
  await importSessionAnalysis({db, sessionId: session.id, exportsDir});

  const source = selectAnalysisSource(db, session.id);
  assert.ok(source, 'analysis source should be found');
  assert.equal(source.complete, true);

  const preview = mergeSessionIntoMemory({db, sessionId: session.id, now: T0 + 1000});
  assert.equal(preview.ok, true);
  assert.equal(preview.apply, false);
  assert.equal(preview.totals.viewers, 2);
  assert.ok(preview.totals.added >= 2);
  // The analysis import creates an objective-only memory head (version 0);
  // the deterministic merge is what adds semantic facts and version 1.
  const before = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  assert.ok(before);
  assert.equal(before.version, 0);
  assert.equal(listFacts(db, before.id).length, 0);

  const applied = mergeSessionIntoMemory({db, sessionId: session.id, apply: true, now: T0 + 2000});
  assert.equal(applied.totals.skipped, 0);
  const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  assert.ok(memory);
  assert.equal(memory.version, 1);
  assert.equal(memory.status, 'active');

  const facts = listFacts(db, memory.id);
  assert.equal(facts.length, 1);
  const fact = facts[0];
  assert.equal(fact.kind, 'interest');
  assert.equal(fact.topic, 'testing');
  assert.equal(fact.certainty, 'inferred', 'session analysis must never become a stated fact');
  assert.equal(fact.status, 'active');
  assert.equal(fact.sourceKind, 'session_result');
  assert.equal(fact.sourceSessionId, session.id);
  assert.ok(fact.sourceResultId);

  const versions = listVersions(db, memory.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].sourceKind, 'session_result');
  assert.equal(versions[0].counts.added, 1);

  const view = buildViewerMemoryView(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  assert.equal(view.memory.version, 1);
  assert.equal(view.facts.length, 1);
  assert.equal(view.versions.length, 1);
  assert.equal(view.groups.inferred.length, 1);
}));

test('a second session increments the same memory to version 2 without duplicates', withDbAndExports(async ({db, exportsDir}) => {
  addBroadcaster(db);
  const first = seedSession(db, {messageCount: 12, viewerCount: 2});
  await importSessionAnalysis({db, sessionId: first.id, exportsDir});
  mergeSessionIntoMemory({db, sessionId: first.id, apply: true, now: T0 + 1000});

  const second = seedSession(db, {
    messageCount: 12,
    viewerCount: 2,
    roomId: 'ai-test-room-2',
    title: 'second stream',
    startedAt: T0 + T_DAY
  });
  await importSessionAnalysis({
    db,
    sessionId: second.id,
    exportsDir,
    profiles: [
      {
        viewer_id: VIEWER_0,
        interests: [
          {topic: 'testing', strength: 'stable', evidence: 'observed', note: 'Still testing.'},
          {topic: 'music games', strength: 'emerging', evidence: 'observed', note: 'Started playing rhythm games.'}
        ],
        dislikes: [],
        summary: 'Still here, now playing music games.',
        confidence: 0.7
      },
      {
        viewer_id: VIEWER_1,
        interests: [{topic: 'testing', strength: 'stable', evidence: 'observed', note: 'Same as before.'}],
        dislikes: [],
        summary: 'Steady.',
        confidence: 0.5
      }
    ]
  });

  const preview = mergeSessionIntoMemory({db, sessionId: second.id, now: T0 + T_DAY + 1000});
  assert.equal(preview.totals.added, 1, 'only the new topic is added');
  assert.equal(preview.totals.confirmed, 2, 'the known topic is confirmed for both viewers');

  mergeSessionIntoMemory({db, sessionId: second.id, apply: true, now: T0 + T_DAY + 2000});
  const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  assert.equal(memory.version, 2);
  const facts = listFacts(db, memory.id);
  assert.equal(facts.length, 2);
  const testing = facts.find((fact) => fact.topic === 'testing');
  const music = facts.find((fact) => fact.topic === 'music games');
  assert.ok(testing.lastConfirmedAt >= T0 + T_DAY);
  assert.equal(music.status, 'active');

  const versions = listVersions(db, memory.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 2);
  assert.equal(versions[0].counts.added, 1);
  assert.equal(versions[0].counts.confirmed, 1);
  assert.equal(versions[1].version, 1);
}));

test('three sessions keep accumulating versions and re-merging is idempotent', withDbAndExports(async ({db, exportsDir}) => {
  addBroadcaster(db);
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const session = seedSession(db, {
      messageCount: 8,
      viewerCount: 1,
      roomId: `room-${index}`,
      title: `stream ${index}`,
      startedAt: T0 + index * T_DAY
    });
    sessions.push(session);
    await importSessionAnalysis({
      db,
      sessionId: session.id,
      exportsDir,
      profiles: [{
        viewer_id: VIEWER_0,
        interests: [{topic: `topic-${index}`, strength: 'stable', evidence: 'observed', note: `note ${index}`}],
        dislikes: [],
        summary: `summary ${index}`,
        confidence: 0.6
      }]
    });
    mergeSessionIntoMemory({db, sessionId: session.id, apply: true, now: T0 + index * T_DAY + 1000});
  }

  const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  assert.equal(memory.version, 3);
  assert.equal(listFacts(db, memory.id).length, 3);
  assert.equal(listVersions(db, memory.id).length, 3);
  assert.equal(memory.summary, 'summary 2');

  // Importing the identical analysis again and merging must not create a version.
  const again = mergeSessionIntoMemory({db, sessionId: sessions[2].id, apply: true, now: T0 + 10 * T_DAY});
  assert.equal(again.totals.skipped, 1);
  assert.equal(getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0}).version, 3);
  assert.equal(listVersions(db, memory.id).length, 3);
}));

test('interests that stop appearing are marked outdated, never deleted or turned into dislikes', withDbAndExports(async ({db, exportsDir}) => {
  addBroadcaster(db);
  const first = seedSession(db, {messageCount: 6, viewerCount: 1});
  await importSessionAnalysis({
    db,
    sessionId: first.id,
    exportsDir,
    profiles: [{
      viewer_id: VIEWER_0,
      interests: [{topic: 'old game', strength: 'stable', evidence: 'observed', note: 'Plays old game.'}],
      dislikes: [],
      summary: 'Plays the old game.',
      confidence: 0.6
    }]
  });
  mergeSessionIntoMemory({db, sessionId: first.id, apply: true, now: T0 + 1000});

  const later = seedSession(db, {
    messageCount: 6,
    viewerCount: 1,
    roomId: 'later-room',
    title: 'much later',
    startedAt: T0 + 200 * T_DAY
  });
  await importSessionAnalysis({
    db,
    sessionId: later.id,
    exportsDir,
    profiles: [{
      viewer_id: VIEWER_0,
      interests: [{topic: 'new game', strength: 'emerging', evidence: 'observed', note: 'Plays a new game now.'}],
      dislikes: [],
      summary: 'Plays a new game.',
      confidence: 0.6
    }]
  });
  mergeSessionIntoMemory({db, sessionId: later.id, apply: true, now: T0 + 200 * T_DAY + 1000});

  const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_0});
  const facts = listFacts(db, memory.id);
  const oldGame = facts.find((fact) => fact.topic === 'old game');
  const newGame = facts.find((fact) => fact.topic === 'new game');
  assert.equal(oldGame.status, 'outdated');
  assert.equal(oldGame.statusReason, 'not_recently_confirmed');
  assert.equal(newGame.status, 'active');
  assert.equal(facts.some((fact) => fact.kind === 'dislike'), false, 'a fading interest must not become a dislike');
  assert.equal(facts.length, 2, 'the old fact is kept as context');
}));

test('memories are isolated per broadcaster even for the same platform account', withDbAndExports(async ({db, exportsDir}) => {
  addBroadcaster(db, {id: 'youtube:UC_AI_TEST', name: 'Channel A'});
  addBroadcaster(db, {id: 'youtube:UC_OTHER', name: 'Channel B'});

  const a = seedSession(db, {messageCount: 6, viewerCount: 1, broadcasterId: 'youtube:UC_AI_TEST', broadcasterName: 'Channel A'});
  await importSessionAnalysis({
    db,
    sessionId: a.id,
    exportsDir,
    profiles: [{
      viewer_id: VIEWER_0,
      interests: [{topic: 'private-a', strength: 'stable', evidence: 'observed', note: 'Only told channel A.'}],
      dislikes: [],
      summary: 'A context',
      confidence: 0.6
    }]
  });
  mergeSessionIntoMemory({db, sessionId: a.id, apply: true, now: T0 + 1000});

  const b = seedSession(db, {
    messageCount: 6,
    viewerCount: 1,
    roomId: 'room-b',
    title: 'channel B stream',
    broadcasterId: 'youtube:UC_OTHER',
    broadcasterName: 'Channel B',
    startedAt: T0 + T_DAY
  });
  await importSessionAnalysis({
    db,
    sessionId: b.id,
    exportsDir,
    profiles: [{
      viewer_id: VIEWER_0,
      interests: [{topic: 'private-b', strength: 'stable', evidence: 'observed', note: 'Only told channel B.'}],
      dislikes: [],
      summary: 'B context',
      confidence: 0.6
    }]
  });
  mergeSessionIntoMemory({db, sessionId: b.id, apply: true, now: T0 + T_DAY + 1000});

  const memoryA = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: VIEWER_0});
  const memoryB = getMemory(db, {broadcasterId: 'youtube:UC_OTHER', viewerId: VIEWER_0});
  assert.ok(memoryA && memoryB);
  assert.notEqual(memoryA.id, memoryB.id);
  const factsA = listFacts(db, memoryA.id).map((fact) => fact.topic);
  const factsB = listFacts(db, memoryB.id).map((fact) => fact.topic);
  assert.deepEqual(factsA, ['private-a']);
  assert.deepEqual(factsB, ['private-b']);

  const viewA = buildViewerMemoryView(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: VIEWER_0});
  assert.equal(viewA.facts.some((fact) => fact.topic === 'private-b'), false);
}));

test('a session without imported analysis or without a broadcaster is reported honestly', withDbAndExports(async ({db}) => {
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 4, viewerCount: 1});
  const noAnalysis = mergeSessionIntoMemory({db, sessionId: session.id});
  assert.equal(noAnalysis.ok, false);
  assert.equal(noAnalysis.reason, 'MEMORY_NO_ANALYSIS');

  const unassigned = seedSession(db, {
    messageCount: 4,
    viewerCount: 1,
    roomId: 'unassigned-room',
    broadcasterId: null,
    broadcasterIdentity: 'unresolved',
    startedAt: T0 + T_DAY
  });
  const noBroadcaster = mergeSessionIntoMemory({db, sessionId: unassigned.id});
  assert.equal(noBroadcaster.ok, false);
  assert.equal(noBroadcaster.reason, 'MEMORY_BROADCASTER_REQUIRED');

  const missing = mergeSessionIntoMemory({db, sessionId: 'ses_missing'});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'SESSION_NOT_FOUND');
}));
