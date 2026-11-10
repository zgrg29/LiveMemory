import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEvidence,
  applyOutdatedRule,
  createFact,
  dedupeKeyFor,
  diffFacts,
  groupFacts,
  normalizeText,
  normalizeTopic
} from '../../src/memory/model.mjs';
import {MEMORY_OUTDATED_AFTER_MS} from '../../src/memory/constants.mjs';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');

function fact(overrides = {}) {
  return createFact({
    broadcasterId: 'bilibili:room:1',
    viewerId: 'bilibili:42',
    kind: 'interest',
    topic: 'RPG',
    statement: 'likes RPG games',
    certainty: 'inferred',
    now: T0,
    ...overrides
  });
}

test('topic normalisation ignores case, spacing, punctuation and emoji', () => {
  const keys = ['RPG游戏', 'rpg 游戏', 'RPG游戏🎮', ' ＲＰＧ游戏！'].map((value) => normalizeTopic(value));
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], 'rpg游戏');
  // Chinese and Japanese text is preserved, never transliterated.
  assert.equal(normalizeTopic('音ゲー'), '音ゲー');
  assert.equal(normalizeTopic('音ゲー'), normalizeTopic('音ゲー '));
});

test('dedupe keys separate kinds but merge the same topic', () => {
  assert.equal(
    dedupeKeyFor({kind: 'interest', topic: 'Valorant', statement: 'a'}),
    dedupeKeyFor({kind: 'interest', topic: 'valorant ', statement: 'b'})
  );
  assert.notEqual(
    dedupeKeyFor({kind: 'interest', topic: 'Valorant', statement: 'a'}),
    dedupeKeyFor({kind: 'dislike', topic: 'Valorant', statement: 'a'})
  );
  // A fact without a topic falls back to the statement.
  assert.match(dedupeKeyFor({kind: 'life_event', statement: '考试结束'}), /^life_event:s:/);
});

test('normalizeText removes control characters and clamps length', () => {
  assert.equal(normalizeText('  a\u0000b  '), 'ab');
  assert.equal(normalizeText('a'.repeat(500), 10).length, 10);
  assert.equal(normalizeText(null), '');
});

test('evidence is de-duplicated by source key', () => {
  const item = fact();
  assert.equal(addEvidence(item, {sessionId: 'ses_1', batchIndex: 1, seq: 4, eventId: 10, observedAt: T0}), true);
  assert.equal(addEvidence(item, {sessionId: 'ses_1', batchIndex: 1, seq: 4, eventId: 10, observedAt: T0}), false);
  assert.equal(item.evidence.length, 1);
});

test('diff reports added, changed, confirmed, unchanged and removed facts', () => {
  const kept = fact({topic: 'A'});
  const confirmed = fact({topic: 'B'});
  const changed = fact({topic: 'C'});
  const removed = fact({topic: 'D'});
  const before = [kept, {...confirmed, lastConfirmedAt: T0 - 1000}, changed, removed];

  const after = [
    kept,
    {...confirmed, lastConfirmedAt: T0},
    {...changed, statement: 'updated statement'},
    fact({topic: 'E'})
  ];
  const diff = diffFacts(before, after);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.changed, 1);
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.counts.confirmed, 1);
  assert.equal(diff.counts.unchanged, 1);
  assert.equal(diff.changed[0].changes[0].field, 'statement');
});

test('outdated rule marks old active facts but keeps timeless and superseded ones', () => {
  const old = fact({topic: 'old'});
  old.lastConfirmedAt = T0 - MEMORY_OUTDATED_AFTER_MS - 1;
  const fresh = fact({topic: 'fresh'});
  const identity = fact({topic: 'name', kind: 'identity'});
  identity.lastConfirmedAt = T0 - MEMORY_OUTDATED_AFTER_MS - 1;
  const superseded = fact({topic: 'gone', status: 'superseded'});
  superseded.lastConfirmedAt = T0 - MEMORY_OUTDATED_AFTER_MS - 1;
  const uncertain = fact({topic: 'maybe', certainty: 'uncertain', status: 'needs_confirmation'});
  uncertain.lastConfirmedAt = T0 - MEMORY_OUTDATED_AFTER_MS - 1;
  const touched = applyOutdatedRule([old, fresh, identity, superseded, uncertain], {
    now: T0,
    outdatedAfterMs: MEMORY_OUTDATED_AFTER_MS
  });
  assert.deepEqual(touched.map((entry) => entry.topic), ['old']);
  assert.equal(old.status, 'outdated');
  assert.equal(old.statusReason, 'not_recently_confirmed');
  assert.equal(fresh.status, 'active');
  assert.equal(identity.status, 'active');
  assert.equal(superseded.status, 'superseded');
  assert.equal(uncertain.status, 'needs_confirmation');
});

test('groupFacts separates confirmed, inferred, attention, conflicts and history', () => {
  const stated = fact({topic: 's', certainty: 'stated'});
  const inferred = fact({topic: 'i'});
  const uncertain = fact({topic: 'u', certainty: 'uncertain', status: 'needs_confirmation'});
  const conflicted = fact({topic: 'c', status: 'conflicted'});
  const outdated = fact({topic: 'o', status: 'outdated'});
  const superseded = fact({topic: 'h', status: 'superseded'});
  const groups = groupFacts([stated, inferred, uncertain, conflicted, outdated, superseded]);
  assert.deepEqual(groups.confirmed.map((entry) => entry.topic), ['s']);
  assert.deepEqual(groups.inferred.map((entry) => entry.topic), ['i']);
  assert.deepEqual(groups.attention.map((entry) => entry.topic), ['u']);
  assert.deepEqual(groups.conflicts.map((entry) => entry.topic), ['c']);
  assert.deepEqual(groups.outdated.map((entry) => entry.topic), ['o']);
  assert.deepEqual(groups.history.map((entry) => entry.topic), ['h']);
});
