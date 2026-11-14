import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMemoryQuality,
  normalizeForMatch,
  diceCoefficient,
  scoreFactAgainstGold
} from '../../src/ai/quality/metrics.mjs';

/**
 * Pure metric tests. They are deliberately hand-built: every expected number is
 * visible in the fixture, so a change in the scoring rule cannot hide behind a
 * generated corpus.
 */

const VIEWER = 'youtube:UC_MQ_A';
const OTHER = 'youtube:UC_MQ_B';

function gold(overrides = {}) {
  return {
    id: 'g1',
    viewerKey: VIEWER,
    statement: '在学吉他',
    aliases: ['吉他', 'guitar'],
    category: 'interest',
    importance: 'high',
    shouldPersist: true,
    status: 'current',
    evidence: [{sessionKey: 's1', seq: 1, eventKey: 's1#1', content: '最近在学吉他'}],
    ...overrides
  };
}

function fact(overrides = {}) {
  return {
    id: 'f1',
    viewerKey: VIEWER,
    kind: 'interest',
    topic: '吉他',
    statement: '在学吉他',
    certainty: 'stated',
    status: 'active',
    evidence: [{
      sessionKey: 's1',
      seq: 1,
      eventKey: 's1#1',
      viewerKey: VIEWER,
      content: '最近在学吉他'
    }],
    ...overrides
  };
}

test('normalization and dice are stable for zh/ja/en', () => {
  assert.equal(normalizeForMatch('  Guitar!  '), 'guitar');
  assert.equal(normalizeForMatch('ギター、'), 'ギター');
  assert.ok(diceCoefficient('在学吉他', '在学吉他') === 1);
  assert.ok(diceCoefficient('在学吉他', '最近在学做菜') < 1);
  const scored = scoreFactAgainstGold(fact(), gold());
  assert.ok(scored.aliasHit);
  assert.ok(scored.score >= 0.62);
});

test('a correct alias fact is recalled, accurate, and costed per correct fact', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact()],
    goldFacts: [gold()],
    usage: {requests: 1, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cost: {amount: 0.0012}}
  });
  assert.equal(evaluation.summary.gold.total, 1);
  assert.equal(evaluation.summary.correct, 1);
  assert.equal(evaluation.summary.recall, 1);
  assert.equal(evaluation.summary.importantRecall, 1);
  assert.equal(evaluation.summary.accuracy, 1);
  assert.equal(evaluation.summary.missed, 0);
  assert.equal(evaluation.summary.wrong, 0);
  assert.equal(evaluation.summary.tokens.tokensPerCorrectFact, 1200);
  assert.equal(evaluation.summary.tokens.costPerCorrectFact, 0.0012);
});

test('a missing fact is counted as missed, not as a wrong save', () => {
  const evaluation = evaluateMemoryQuality({facts: [], goldFacts: [gold()]});
  assert.equal(evaluation.summary.recall, 0);
  assert.equal(evaluation.summary.missed, 1);
  assert.equal(evaluation.summary.wrong, 0);
  assert.equal(evaluation.summary.accuracy, null);
});

test('a statement that cites unrelated chat is matched but not evidence-supported', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact({
      topic: '搬家',
      statement: '刚搬家',
      evidence: [{
        sessionKey: 's1',
        seq: 2,
        eventKey: 's1#2',
        viewerKey: VIEWER,
        content: '今天天气不错'
      }]
    })],
    goldFacts: [gold()]
  });
  assert.equal(evaluation.summary.correct, 0);
  assert.equal(evaluation.summary.wrong, 1);
  assert.equal(evaluation.perFact[0].classification, 'wrong_unsupported');
  assert.equal(evaluation.perFact[0].contentSupported, false);
});

test('uncertain facts are review cases, never silently correct', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact({certainty: 'uncertain', status: 'needs_confirmation'})],
    goldFacts: [gold()]
  });
  assert.equal(evaluation.summary.correct, 0);
  assert.equal(evaluation.summary.review, 1);
  assert.equal(evaluation.summary.recall, 0);
  assert.equal(evaluation.summary.recallIncludingReview, 1);
});

test('ambiguous gold facts are excluded from the strict denominator and listed', () => {
  const ambiguous = gold({
    id: 'g2',
    statement: '今天生日',
    aliases: ['生日'],
    shouldPersist: 'ambiguous',
    ambiguous: true,
    evidence: [{sessionKey: 's1', seq: 3, eventKey: 's1#3', content: '今天生日'}]
  });
  const evaluation = evaluateMemoryQuality({
    facts: [fact({topic: '生日', statement: '今天生日', evidence: [{
      sessionKey: 's1', seq: 3, eventKey: 's1#3', viewerKey: VIEWER, content: '今天生日'
    }]})],
    goldFacts: [gold(), ambiguous]
  });
  assert.equal(evaluation.summary.gold.total, 1, 'ambiguous fact is not in strict gold');
  assert.equal(evaluation.summary.gold.ambiguous, 1);
  assert.equal(evaluation.summary.correct, 0);
  assert.equal(evaluation.summary.ambiguous, 1);
});

test('cross-viewer evidence is detected separately from an unsupported statement', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact({
      evidence: [{
        sessionKey: 's1',
        seq: 9,
        eventKey: 's1#9',
        viewerKey: OTHER,
        content: '别人的发言'
      }]
    })],
    goldFacts: [gold()]
  });
  assert.equal(evaluation.summary.crossViewerEvidence, 1);
  assert.equal(evaluation.summary.crossViewerRate, 1);
  assert.equal(evaluation.perFact[0].classification, 'cross_viewer_evidence');
});

test('a fact citing an explicitly no-save message is counted as false positive', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact({
      topic: '今日疲惫',
      statement: '今天非常疲惫',
      evidence: [{
        sessionKey: 's1',
        seq: 4,
        eventKey: 's1#4',
        viewerKey: VIEWER,
        content: '今天累死了'
      }]
    })],
    goldFacts: [gold()],
    negatives: [{viewerKey: VIEWER, sessionKey: 's1', seq: 4, eventKey: 's1#4', content: '今天累死了'}]
  });
  assert.equal(evaluation.summary.noSaveEvidence, 1);
  assert.equal(evaluation.summary.noSaveRate, 1);
  assert.equal(evaluation.perFact[0].classification, 'no_save_evidence');
});

test('two facts with the same kind and topic count as a duplicate', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [
      fact({id: 'f1'}),
      fact({id: 'f2', statement: '最近在学吉他'})
    ],
    goldFacts: [gold()]
  });
  assert.equal(evaluation.summary.duplicates, 1);
  assert.equal(evaluation.summary.duplicateRate, 0.5);
  assert.equal(evaluation.duplicates.groups[0].count, 2);
});

test('same-name different viewer is never merged by the metric matcher', () => {
  const evaluation = evaluateMemoryQuality({
    facts: [fact({viewerKey: OTHER, topic: '金融', statement: '做金融工作'})],
    goldFacts: [gold({viewerKey: VIEWER})]
  });
  assert.equal(evaluation.summary.correct, 0);
  assert.equal(evaluation.summary.wrong, 1);
  assert.equal(evaluation.perFact[0].matchedGoldId, null);
});
