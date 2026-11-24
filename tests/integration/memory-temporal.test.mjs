import {buildMemoryChronology, buildMemoryPayload} from '../../src/ai/export/context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openMemoryDb, addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {applyMemoryOperations} from '../../src/memory/store.mjs';
import {loadMemoryFacts} from '../../src/memory/model.mjs';
import {getMemory, listFacts} from '../../src/storage/repositories/viewer-memory.mjs';
import {insertTranslationRun, updateTranslationRun} from '../../src/storage/repositories/ai-translations.mjs';

const DAY = 86400000;
function fixture(t) {
  const db = openMemoryDb(); t.after(() => db.close());
  const broadcasterId = addBroadcaster(db);
  const sessions = [0, 2, 4].map((offset, i) => seedSession(db, {
    id: `ses_temporal_${i}`, startedAt: T0 + offset * DAY, messageCount: 2, viewerCount: 1
  }));
  const viewerId = db.prepare('SELECT id FROM viewers LIMIT 1').get().id;
  const evidence = (index) => {
    const event = db.prepare('SELECT id, occurred_at FROM events WHERE session_id = ? ORDER BY id LIMIT 1').get(sessions[index].id);
    return {sourceKey: `job:${index}`, eventId: event.id, sessionId: sessions[index].id,
      seq: 1, batchIndex: 1, observedAt: event.occurred_at, available: true};
  };
  let sequence = 0;
  const apply = (index, operations, extras = {}) => applyMemoryOperations({db, broadcasterId, viewerId,
    operations: operations.map((op) => ({certainty: 'stated', confidence: .9, evidence: [evidence(index)], ...op})),
    source: {kind: 'session_analysis_result', sessionId: sessions[index].id},
    sourceKey: `analysis:${++sequence}`, now: T0 + 30 * DAY, ...extras});
  const facts = () => { const memory = getMemory(db, {broadcasterId, viewerId}); return loadMemoryFacts(db, memory.id); };
  return {db, broadcasterId, viewerId, sessions, evidence, apply, facts};
}

for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1], [1, 0, 2], [0, 2, 1]]) {
  test(`independent interests survive order ${order.join(',')} without time decay`, (t) => {
    const f = fixture(t);
    for (const i of order) f.apply(i, [{op: 'add', kind: 'interest', topic: ['原神', '星穹铁道', '音楽'][i], statement: ['喜欢原神', '正在玩星穹铁道', '音楽が好き'][i]}]);
    const facts = f.facts();
    assert.equal(facts.length, 3);
    assert.ok(facts.every((fact) => fact.status === 'active'));
    assert.deepEqual(facts.map((fact) => fact.firstSeenAt).sort(), [0, 2, 4].map((d) => T0 + d * DAY + 1000));
  });
}

for (const order of [[0, 2], [2, 0]]) {
  test(`residence current and historical states survive order ${order.join(',')}`, (t) => {
    const f = fixture(t);
    for (const i of order) {
      const current = f.db.prepare("SELECT id FROM memory_facts WHERE status = 'active' LIMIT 1").get();
      f.apply(i, [{op: current ? 'supersede' : 'add', targetFactId: current?.id,
        kind: 'identity', topic: 'residence', statement: i === 0 ? '大阪に住んでいる' : '已经搬到东京'}]);
    }
    assert.equal(f.facts().find((fact) => fact.status === 'active').statement, '已经搬到东京');
    const historical = f.facts().find((fact) => fact.statement === '大阪に住んでいる');
    assert.equal(historical.status, 'superseded');
    assert.ok(historical.firstSeenAt < historical.validUntil);
    assert.equal(f.facts().reduce((n, fact) => n + fact.evidence.length, 0), 2);
  });
}

for (const order of [[0, 2], [2, 0]]) {
  test(`new weak joke cannot replace earlier self-statement: ${order.join(',')}`, (t) => {
    const f = fixture(t);
    for (const i of order) f.apply(i, [{op: 'add', kind: 'identity', topic: 'residence',
      statement: i === 0 ? '大阪に住んでいる' : '住在月球（可能是玩笑）',
      certainty: i === 0 ? 'stated' : 'uncertain', confidence: i === 0 ? .95 : .2}]);
    assert.equal(f.facts().find((fact) => fact.status === 'active').statement, '大阪に住んでいる');
    assert.equal(f.facts().find((fact) => fact.certainty === 'uncertain').status, 'conflicted');
  });
}

test('reanalysis uses event identity across jobs and cannot increase certainty, confidence or versions', (t) => {
  const f = fixture(t);
  f.apply(0, [{op: 'add', kind: 'interest', topic: 'game', statement: 'ゲーム好き', certainty: 'inferred', confidence: .4}]);
  const before = f.facts()[0];
  const version = getMemory(f.db, f).version;
  f.apply(0, [{op: 'add', kind: 'interest', topic: 'game', statement: 'ゲーム好き', confidence: .99,
    evidence: [{...f.evidence(0), sourceKey: 'different-job:same-event'}]}]);
  const after = f.facts()[0];
  assert.equal(after.evidence.length, 1); assert.equal(after.confidence, before.confidence);
  assert.equal(after.certainty, before.certainty); assert.equal(getMemory(f.db, f).version, version);
  assert.equal(f.db.prepare('SELECT message_count FROM viewers LIMIT 1').get().message_count, 6);
});

test('stale target snapshots rebase onto the live current state in one transaction', async (t) => {
  const f = fixture(t);
  const first = f.apply(0, [{op: 'add', kind: 'identity', topic: 'residence', statement: '大阪'}]);
  const staleTarget = first.facts[0].id;
  await Promise.all([2, 1].map((i) => Promise.resolve().then(() => f.apply(i, [{op: 'supersede', targetFactId: staleTarget,
    kind: 'identity', topic: 'residence', statement: i === 2 ? '东京' : '京都'}]))));
  assert.equal(f.facts().find((fact) => fact.status === 'active').statement, '东京');
  assert.equal(f.facts().length, 3);
});

test('legacy analysis timestamps recover from real evidence, including retained purged event times', (t) => {
  const f = fixture(t); f.apply(0, [{op: 'add', kind: 'identity', topic: 'birthday', statement: '生日在五月'}]);
  f.db.prepare('UPDATE memory_facts SET first_seen_at = ?, last_confirmed_at = ?').run(T0 + 30 * DAY, T0 + 30 * DAY);
  f.db.prepare('UPDATE events SET content = NULL, content_purged_at = ?').run(T0 + 31 * DAY);
  const fact = f.facts()[0]; assert.equal(fact.firstSeenAt, T0 + 1000);
  assert.equal(fact.evidence[0].available, false, 'purged content must not be restored by temporal recovery');
});

test('unknown legacy observation dates are never replaced with the analysis clock', (t) => {
  const f = fixture(t); const outcome = f.apply(0, [{op: 'add', kind: 'identity', topic: 'birthday', statement: '五月'}]);
  f.db.prepare('DELETE FROM memory_fact_evidence').run();
  f.db.prepare('UPDATE memory_facts SET source_session_id = NULL').run();
  const fact = f.facts()[0]; assert.equal(fact.firstSeenAt, 0); assert.equal(fact.lastConfirmedAt, 0);
  assert.ok(outcome.version >= 1);
});

test('translation progress omission preserves usage rather than binding undefined', (t) => {
  const f = fixture(t);
  const row = insertTranslationRun(f.db, {sessionId: f.sessions[0].id, targetLocale: 'zh-CN', translatorVersion: 'test', usage: {inputTokens: 12}});
  const updated = updateTranslationRun(f.db, row.id, {usage: undefined, pendingItems: 3});
  assert.deepEqual(updated.usage, {inputTokens: 12}); assert.equal(updated.pendingItems, 3);
});

for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
  test(`historical state intervals follow observation chronology ${order.join(',')}`, (t) => {
    const f = fixture(t);
    for (const i of order) f.apply(i, [{op: 'add', kind: 'identity', topic: 'residence', statement: ['大阪', '京都', '東京'][i]}]);
    const facts = f.facts().sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    assert.equal(facts.at(-1).statement, '東京'); assert.equal(facts.at(-1).status, 'active');
    for (let i = 0; i < 2; i++) {
      assert.equal(facts[i].validUntil, facts[i + 1].firstSeenAt);
      assert.equal(facts[i].supersededBy, facts[i + 1].id);
    }
  });
}

test('rewriting the same evidence cannot promote a competing state into current memory', (t) => {
  const f = fixture(t);
  f.apply(0, [{op: 'add', kind: 'identity', topic: 'residence', statement: '大阪', certainty: 'inferred', confidence: .4}]);
  const target = f.facts()[0];
  f.apply(0, [{op: 'supersede', targetFactId: target.id, kind: 'identity', topic: 'residence',
    statement: '東京', certainty: 'stated', confidence: .99,
    evidence: [{...f.evidence(0), sourceKey: 'another-job:same-quote'}]}]);
  assert.equal(f.facts().find((fact) => fact.status === 'active').statement, '大阪');
  assert.equal(f.facts().find((fact) => fact.statement === '東京').status, 'conflicted');
});

test('a failed fact rewrite rolls back the whole fact set and version', (t) => {
  const f = fixture(t); f.apply(0, [{op: 'add', kind: 'interest', topic: 'music', statement: '音楽'}]);
  const before = f.db.prepare('SELECT * FROM memory_facts').all();
  const version = getMemory(f.db, f).version;
  f.db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON memory_versions BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
  assert.throws(() => f.apply(1, [{op: 'add', kind: 'interest', topic: 'game', statement: 'ゲーム'}]), /synthetic rollback/);
  assert.deepEqual(f.db.prepare('SELECT * FROM memory_facts').all(), before);
  assert.equal(getMemory(f.db, f).version, version);
});


test('memory request explicitly marks historical backfill from real record times', (t) => {
  const f = fixture(t); f.apply(2, [{op: 'add', kind: 'identity', topic: 'birthday', statement: '五月'}]);
  const memory = buildMemoryPayload(f.db, f);
  const chronology = buildMemoryChronology({startedAt: T0, endedAt: T0 + 3000}, [{memory}]);
  assert.equal(chronology.historical_backfill, true);
  assert.equal(Date.parse(chronology.known_memory_through), T0 + 4 * DAY + 1000);
  assert.equal(buildMemoryChronology({startedAt: T0}, [{memory: {facts: [{last_confirmed_at: null}]}}]).historical_backfill, null);
});


test('old result-based evidence keys deduplicate across reanalysis without inventing support', (t) => {
  const f = fixture(t);
  f.apply(0, [{op: 'add', kind: 'interest', topic: 'music', statement: '音楽', certainty: 'inferred', confidence: .4,
    evidence: [{sourceKey: 'r:old_result', sessionId: f.sessions[0].id, observedAt: T0, eventId: null}]}]);
  f.db.prepare("UPDATE memory_fact_evidence SET source_key = 'r:old_result', observed_at = ?").run(T0 + 100 * DAY);
  assert.equal(f.facts()[0].firstSeenAt, T0, 'legacy result evidence must use session time, not old import time');
  f.apply(0, [{op: 'add', kind: 'interest', topic: 'music', statement: '音楽', certainty: 'stated', confidence: .99,
    evidence: [{resultId: 'new_result', sessionId: f.sessions[0].id, observedAt: T0, eventId: null}]}]);
  assert.equal(f.facts()[0].confidence, .4); assert.equal(f.facts()[0].certainty, 'inferred');
  assert.equal(f.facts()[0].evidence.length, 1);
});


test('historical accumulation beyond the UI page limit cannot drop existing facts on commit', (t) => {
  const f = fixture(t);
  f.apply(0, Array.from({length: 510}, (_, i) => ({op: 'add', kind: 'interest', topic: `topic-${i}`, statement: `fact ${i}`})));
  f.apply(1, [{op: 'add', kind: 'interest', topic: 'historical-extra', statement: '追加事实'}]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 511);
  assert.equal(f.facts().length, 511);
});
