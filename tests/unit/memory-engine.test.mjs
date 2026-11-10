import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOperations, reviewFact} from '../../src/memory/engine.mjs';
import {createFact} from '../../src/memory/model.mjs';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const CONTEXT = {
  broadcasterId: 'bilibili:room:1',
  viewerId: 'bilibili:42',
  now: T0,
  source: {kind: 'ai_memory_update', jobId: 'mjob_1', resultId: 'mres_1', sessionId: 'ses_1'},
  outdatedAfterMs: 365 * 24 * 3600 * 1000
};

function run(operations, facts = [], context = {}) {
  return applyOperations({facts, operations, context: {...CONTEXT, ...context}});
}

function evidence(seq = 1) {
  return {
    sourceKey: `s:ses_1:b1:${seq}`,
    sessionId: 'ses_1',
    batchIndex: 1,
    seq,
    eventId: 100 + seq,
    observedAt: T0
  };
}

function existing(overrides = {}) {
  return {
    ...createFact({
      broadcasterId: CONTEXT.broadcasterId,
      viewerId: CONTEXT.viewerId,
      kind: 'interest',
      topic: 'RPG',
      statement: '喜欢 RPG',
      certainty: 'inferred',
      now: T0 - 10000,
      ...overrides
    }),
    evidence: []
  };
}

test('add creates an active fact and never duplicates the same topic', () => {
  const first = run([{
    op: 'add',
    kind: 'interest',
    topic: '音乐游戏',
    statement: '在玩音乐游戏',
    certainty: 'inferred',
    evidence: [evidence(2)]
  }]);
  assert.equal(first.facts.length, 1);
  assert.equal(first.facts[0].status, 'active');
  assert.equal(first.results[0].status, 'added');

  const second = run([{
    op: 'add',
    kind: 'interest',
    topic: '音乐游戏 ',
    statement: '又在聊音乐游戏',
    certainty: 'inferred',
    evidence: [evidence(3)]
  }], first.facts);
  assert.equal(second.facts.length, 1, 'same topic must not create a second fact');
  assert.equal(second.results[0].status, 'confirmed');
  assert.equal(second.facts[0].evidence.length, 2);
});

test('a stated statement upgrades an inference but an inference never downgrades a stated fact', () => {
  const base = [existing({certainty: 'inferred'})];
  const upgraded = run([{op: 'confirm', targetFactId: base[0].id, certainty: 'stated', evidence: [evidence(2)]}], base);
  assert.equal(upgraded.facts[0].certainty, 'stated');

  const statedBase = [existing({certainty: 'stated'})];
  const kept = run([{op: 'confirm', targetFactId: statedBase[0].id, certainty: 'inferred', evidence: [evidence(3)]}], statedBase);
  assert.equal(kept.facts[0].certainty, 'stated');
});

test('interest and dislike for the same topic become an explicit conflict', () => {
  const base = [existing({kind: 'interest', topic: 'Valorant'})];
  const outcome = run([{
    op: 'add',
    kind: 'dislike',
    topic: 'Valorant',
    statement: '最讨厌 Valorant',
    certainty: 'stated',
    evidence: [evidence(4)]
  }], base);
  assert.equal(outcome.facts.length, 2);
  assert.equal(outcome.facts.every((fact) => fact.status === 'conflicted'), true);
  assert.equal(outcome.facts[0].conflictsWith, outcome.facts[1].id);
  assert.equal(outcome.facts[1].conflictsWith, outcome.facts[0].id);
  assert.ok(outcome.warnings.some((warning) => warning.code === 'MEMORY_CONFLICT_CREATED'));
});

test('supersede keeps the old fact as history and links the new state', () => {
  const base = [existing({kind: 'life_event', topic: '考试', statement: '正在准备考试', certainty: 'stated'})];
  const outcome = run([{
    op: 'supersede',
    targetFactId: base[0].id,
    kind: 'life_event',
    topic: '考试',
    statement: '考试已经结束',
    certainty: 'stated',
    evidence: [evidence(5)]
  }], base);
  assert.equal(outcome.facts.length, 2);
  const oldFact = outcome.facts.find((fact) => fact.id === base[0].id);
  const newFact = outcome.facts.find((fact) => fact.id !== base[0].id);
  assert.equal(oldFact.status, 'superseded');
  assert.equal(oldFact.statusReason, 'superseded');
  assert.equal(oldFact.supersededBy, newFact.id);
  assert.ok(oldFact.validUntil);
  assert.equal(newFact.status, 'active');
  assert.equal(newFact.topic, '考试');
  // Same topic key is allowed because the old row left the unique index.
  assert.equal(newFact.dedupeKey, oldFact.dedupeKey);
});

test('confirming an outdated fact reactivates it, superseded facts are skipped', () => {
  const outdated = existing({status: 'outdated', statusReason: 'not_recently_confirmed'});
  const reactivated = run([{op: 'confirm', targetFactId: outdated.id, evidence: [evidence(6)]}], [outdated]);
  assert.equal(reactivated.facts[0].status, 'active');
  assert.equal(reactivated.facts[0].statusReason, null);

  const superseded = existing({status: 'superseded'});
  const skipped = run([{op: 'confirm', targetFactId: superseded.id, evidence: [evidence(7)]}], [superseded]);
  assert.equal(skipped.results[0].status, 'skipped');
  assert.equal(skipped.results[0].reason, 'MEMORY_TARGET_SUPERSEDED');
});

test('update refuses to collide with another live topic instead of merging silently', () => {
  const a = existing({topic: 'A'});
  const b = existing({topic: 'B'});
  const outcome = run([{
    op: 'update',
    targetFactId: b.id,
    kind: 'interest',
    topic: 'A',
    statement: '改成 A',
    evidence: [evidence(8)]
  }], [a, b]);
  assert.equal(outcome.results[0].status, 'skipped');
  assert.equal(outcome.results[0].reason, 'MEMORY_TOPIC_CONFLICT');
  assert.equal(outcome.facts.find((fact) => fact.id === b.id).topic, 'B');
});

test('unknown target facts are skipped, not invented', () => {
  const outcome = run([{op: 'confirm', targetFactId: 'mfc_missing', evidence: [evidence(9)]}]);
  assert.equal(outcome.results[0].status, 'skipped');
  assert.equal(outcome.results[0].reason, 'MEMORY_FACT_UNKNOWN');
  assert.equal(outcome.facts.length, 0);
});

test('uncertain facts are stored as needs_confirmation, never as active facts', () => {
  const outcome = run([{
    op: 'uncertain',
    kind: 'life_event',
    statement: '可能搬家了',
    certainty: 'uncertain'
  }]);
  assert.equal(outcome.facts[0].status, 'needs_confirmation');
  assert.equal(outcome.facts[0].certainty, 'uncertain');
  assert.equal(outcome.facts[0].evidenceStatus, 'none');
});

test('outdated operation keeps the fact and records why', () => {
  const base = [existing({kind: 'interest', topic: '老游戏'})];
  const outcome = run([{op: 'outdated', targetFactId: base[0].id, reason: '最近没再提'}], base);
  assert.equal(outcome.facts[0].status, 'outdated');
  assert.equal(outcome.facts[0].statusReason, '最近没再提');
  assert.ok(outcome.facts[0].validUntil);
});

test('reviewFact refuses to resurrect a superseded fact', () => {
  const base = existing({status: 'superseded'});
  for (const action of ['confirm', 'restore']) {
    const outcome = reviewFact({facts: [base], factId: base.id, action, now: T0});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'MEMORY_TARGET_SUPERSEDED');
  }
  const forgotten = reviewFact({facts: [base], factId: base.id, action: 'forget', now: T0});
  assert.equal(forgotten.ok, true);
});

test('a conflict on the exact same topic is skipped instead of breaking uniqueness', () => {
  const base = [existing({kind: 'interest', topic: 'RPG', status: 'active'})];
  const outcome = run([{
    op: 'conflict',
    targetFactId: base[0].id,
    kind: 'interest',
    topic: 'RPG',
    statement: '也许是喜欢，也许不是',
    certainty: 'uncertain',
    evidence: [evidence(11)]
  }], base);
  assert.equal(outcome.results[0].status, 'skipped');
  assert.equal(outcome.results[0].reason, 'MEMORY_TOPIC_CONFLICT');
  assert.equal(outcome.facts.length, 1);
  assert.equal(outcome.facts[0].status, 'active');
});

test('reviewFact lets a human confirm, dismiss, forget and restore a fact', () => {
  const base = existing({certainty: 'inferred', status: 'needs_confirmation'});
  const confirmed = reviewFact({facts: [base], factId: base.id, action: 'confirm', now: T0});
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.facts[0].certainty, 'stated');
  assert.equal(confirmed.facts[0].status, 'active');
  assert.equal(confirmed.facts[0].userVerified, true);

  const dismissed = reviewFact({facts: confirmed.facts, factId: base.id, action: 'dismiss', now: T0});
  assert.equal(dismissed.facts[0].status, 'outdated');
  assert.equal(dismissed.facts[0].statusReason, 'dismissed_by_user');

  const restored = reviewFact({facts: dismissed.facts, factId: base.id, action: 'restore', now: T0});
  assert.equal(restored.facts[0].status, 'active');

  const forgotten = reviewFact({facts: restored.facts, factId: base.id, action: 'forget', now: T0});
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.facts.length, 0);

  const failed = reviewFact({facts: [base], factId: 'mfc_missing', action: 'confirm', now: T0});
  assert.equal(failed.ok, false);
});
