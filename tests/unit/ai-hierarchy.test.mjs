import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_AGGREGATE_LIMITS,
  TIGHT_AGGREGATE_LIMITS,
  checkBatchCoverage,
  deterministicDigest,
  deterministicFinal,
  digestSchema,
  finalEnvelopeSchema,
  groupBatchesContiguously,
  normalizeDigestAnswer,
  normalizeFinalAnswer,
  splitGroup
} from '../../src/ai/aggregate/hierarchy.mjs';
import {
  resolveAggregateContextBudget,
  resolveAggregateInputLimit,
  resolveDigestOutputTokens
} from '../../src/ai/batching/tokens.mjs';
import {buildAggregateDigestPrompt, buildSessionAggregatePrompt} from '../../src/ai/api/prompts.mjs';
import {loadResultSchema} from '../../src/ai/import/validate.mjs';
import {estimateJsonTokens} from '../../src/ai/batching/tokens.mjs';

const T0 = Date.parse('2026-11-13T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const resultSchema = loadResultSchema('1.3.0');

function makeEntry(batch, {summaryLength = 160, topicCount = 4} = {}) {
  const from = T0 + 1000 + batch * 120000;
  const result = {
    session_topics: {
      summary: `batch ${batch} ` + 's'.repeat(summaryLength),
      topics: Array.from({length: topicCount}, (_, index) => ({
        title: `batch ${batch} topic ${index}`,
        started_at: iso(from + index * 1000),
        ended_at: iso(from + index * 1000 + 500),
        summary: `topic ${batch}.${index} ` + 'd'.repeat(80),
        key_points: ['point one', 'point two'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1, 2]
      })),
      sentiment: [{at: iso(from), tone: 'positive', note: 'good '.repeat(8), confidence: 0.6}],
      disputes: [],
      highlights: [{
        started_at: iso(from),
        ended_at: iso(from + 1000),
        title: `batch ${batch} highlight`,
        reason: 'reason '.repeat(20),
        clip_suggestion: 'clip',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [1]
      }]
    }
  };
  const validRefs = new Set([`${batch}:1`, `${batch}:2`]);
  return {
    batchIndex: batch,
    batchId: `job-b${batch}`,
    taskId: `task-b${batch}`,
    checksum: `checksum-${batch}`,
    fromSeq: 1 + (batch - 1) * 100,
    toSeq: batch * 100,
    fromAt: from,
    toAt: from + 120000,
    messageCount: 100,
    result,
    coverage: {
      from_seq: 1 + (batch - 1) * 100,
      to_seq: batch * 100,
      message_count: 100,
      from_at: iso(from),
      to_at: iso(from + 120000)
    },
    reportable: true,
    validRefs,
    condensedTokens: estimateJsonTokens(result) + 250
  };
}

function contextFor(entries) {
  return {
    batchMeta: new Map(entries.map((entry) => [entry.batchIndex, {
      fromAt: entry.fromAt,
      toAt: entry.toAt,
      messageCount: entry.messageCount
    }])),
    reportable: new Map(entries.map((entry) => [entry.batchIndex, entry.reportable])),
    validRefs: new Map(entries.map((entry) => [entry.batchIndex, entry.validRefs]))
  };
}

function manifest(locale = 'en') {
  return {
    job_id: 'aij_hierarchy_unit',
    session_id: 'ses_hierarchy_unit',
    locale,
    broadcaster_id: 'mock:broadcaster',
    tasks: [{task_id: 'ses_hierarchy_unit-analysis-final', kind: 'session_aggregate', session_id: 'ses_hierarchy_unit'}]
  };
}

test('aggregate budget uses the configured context or a conservative unknown default', () => {
  assert.deepEqual(resolveAggregateContextBudget({contextLength: null}), {
    contextTokens: 64000,
    source: 'conservative-default'
  });
  assert.equal(resolveAggregateContextBudget({contextLength: 32000}).contextTokens, 32000);
  assert.equal(resolveAggregateContextBudget({contextLength: 1000000}).contextTokens, 1000000);
  const unknown = resolveAggregateInputLimit({contextLength: null, outputReserve: 16000});
  assert.equal(unknown.contextTokens, 64000);
  assert.equal(unknown.inputLimit, 64000 - 16000 - 500);
  const huge = resolveAggregateInputLimit({contextLength: 1000000, outputReserve: 16000});
  assert.equal(huge.inputLimit, 192000, 'one request input is bounded even on a 1M model');
  const digest = resolveDigestOutputTokens({childTokens: 5000, contextLength: null});
  assert.ok(digest >= 4000 && digest <= 8000);
});

test('token-budget grouping covers 1, 8, 18, 32, 64 and 128 batches exactly once', () => {
  for (const count of [1, 8, 18, 32, 64, 128]) {
    const entries = Array.from({length: count}, (_, index) => makeEntry(index + 1));
    const items = entries.map((entry) => ({entry, coveredBatches: [entry.batchIndex], tokens: entry.condensedTokens}));
    const groups = groupBatchesContiguously(items, {budgetTokens: 30000, fixedOverhead: 4000});
    const seen = groups.flat().map((item) => item.entry.batchIndex);
    assert.equal(seen.length, count);
    assert.deepEqual(seen, entries.map((entry) => entry.batchIndex));
    for (const group of groups) {
      const tokens = group.reduce((sum, item) => sum + item.tokens, 0) + 4000;
      assert.ok(group.length === 1 || tokens <= 30000,
        `group ${group.map((item) => item.entry.batchIndex)} must fit the budget`);
    }
  }
});

test('an oversized single group is split and the smallest unit stays intact', () => {
  const entries = Array.from({length: 2}, (_, index) => makeEntry(index + 1, {summaryLength: 5000, topicCount: 8}));
  const items = entries.map((entry) => ({entry, coveredBatches: [entry.batchIndex], tokens: entry.condensedTokens}));
  const groups = groupBatchesContiguously(items, {budgetTokens: 2000, fixedOverhead: 0});
  assert.equal(groups.length, 2, 'each oversized batch becomes its own group');
  const split = splitGroup([1, 2, 3, 4]);
  assert.deepEqual(split, [[1, 2], [3, 4]]);
  assert.equal(splitGroup([1]), null);
});

test('partial digest prompts exist in all three locales and preserve the coverage contract', () => {
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const prompt = buildAggregateDigestPrompt({
      manifest: manifest(locale),
      level: 1,
      nodeIndex: 1,
      sourceKind: 'batches',
      childItems: [{batch_index: 1, result: {}}],
      coverage: [{batch: 1, from_seq: 1, to_seq: 100, messages: 100, from_at: iso(T0), to_at: iso(T0 + 1000)}],
      limits: DIGEST_AGGREGATE_LIMITS,
      resultSchema
    });
    const text = prompt.messages[1].content;
    assert.match(text, /PARTIAL DIGEST CONTRACT/);
    assert.match(text, /covered_batches/);
    assert.match(text, /batch 1/);
    assert.ok(prompt.answerSchema.properties.covered_batches);
    assert.ok(prompt.estimatedTokens > 0);
  }
});

test('final prompt with partial reports lists every child and its coverage', () => {
  const entries = [makeEntry(1), makeEntry(2)];
  const prompt = buildSessionAggregatePrompt({
    manifest: manifest('en'),
    batchResults: [],
    partialReports: [{
      node_id: 'node-1',
      level: 1,
      covered_batches: [1, 2],
      session_topics: {summary: 'partial', topics: [], sentiment: [], disputes: [], highlights: []}
    }],
    coverage: [
      {batch: 1, from_seq: 1, to_seq: 100, messages: 100, from_at: iso(T0), to_at: iso(T0 + 1000)},
      {batch: 2, from_seq: 101, to_seq: 200, messages: 100, from_at: iso(T0 + 1000), to_at: iso(T0 + 2000)}
    ],
    resultSchema,
    answerSchema: finalEnvelopeSchema(resultSchema),
    requireCoverage: true
  });
  const text = prompt.messages[1].content;
  assert.match(text, /partial_reports/);
  assert.match(text, /batch 1/);
  assert.match(text, /batch 2/);
  assert.match(text, /covered_batches/);
});

test('deterministic digest preserves every batch and every evidence reference under bounded caps', () => {
  for (const count of [1, 8, 18, 32, 64, 128]) {
    const entries = Array.from({length: count}, (_, index) => makeEntry(index + 1, {topicCount: 3}));
    const context = contextFor(entries);
    const items = entries.map((entry) => ({
      entry,
      coveredBatches: [entry.batchIndex],
      tokens: entry.condensedTokens
    }));
    const groups = groupBatchesContiguously(items, {
      budgetTokens: 60000,
      fixedOverhead: 4000,
      maxItems: 72
    });
    const digests = groups.map((group) => deterministicDigest({
      batchEntries: entries,
      groupBatches: group.map((item) => item.entry.batchIndex),
      limits: DIGEST_AGGREGATE_LIMITS
    }));
    for (const digest of digests) {
      assert.ok(digest.session_topics.topics.length <= DIGEST_AGGREGATE_LIMITS.topics);
      assert.ok(digest.session_topics.highlights.length <= DIGEST_AGGREGATE_LIMITS.highlights);
    }
    const coveredBatches = digests.flatMap((digest) => digest.covered_batches);
    assert.deepEqual(coveredBatches, entries.map((entry) => entry.batchIndex));
    const allCited = new Set(digests.flatMap((digest) => digest.session_topics.topics
      .flatMap((topic) => topic.message_refs ?? [])
      .map((ref) => ref.batch)));
    // Each leaf digest is checked batch-by-batch; together they cite every batch.
    for (const digest of digests) {
      const coverage = checkBatchCoverage({
        digest,
        batchBatches: digest.covered_batches,
        ...context
      });
      assert.equal(coverage.ok, true, `${count} batches must be covered per leaf`);
    }
    assert.equal(allCited.size, count);
  }
});

test('a model digest that drops a batch or invents evidence is rejected deterministically', () => {
  const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
  const context = contextFor(entries);
  const good = deterministicDigest({batchEntries: entries, groupBatches: [1, 2, 3]});
  const missing = {
    covered_batches: [1, 2],
    session_topics: {...good.session_topics, topics: good.session_topics.topics.filter((topic) => (
      (topic.message_refs ?? []).every((ref) => ref.batch === 1)
    ))}
  };
  const missingResult = normalizeDigestAnswer(missing, {
    groupBatches: [1, 2, 3],
    ...context,
    limits: DIGEST_AGGREGATE_LIMITS
  });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.issues.some((issue) => issue.code === 'AGGREGATE_COVERAGE_INCOMPLETE'));

  const invented = {
    covered_batches: [1, 2, 3],
    session_topics: {
      ...good.session_topics,
      topics: good.session_topics.topics.map((topic) => ({
        ...topic,
        message_refs: [{batch: 1, seq: 999}]
      })),
      highlights: good.session_topics.highlights.map((item) => ({...item, message_refs: [{batch: 1, seq: 999}]}))
    }
  };
  const inventedResult = normalizeDigestAnswer(invented, {
    groupBatches: [1, 2, 3],
    ...context,
    limits: DIGEST_AGGREGATE_LIMITS
  });
  assert.equal(inventedResult.ok, false, 'a fabricated seq does not count as coverage');
  assert.ok(inventedResult.digest.session_topics.topics.every((topic) => (
    (topic.message_refs ?? []).every((ref) => ref.seq !== 999)
  )));
});

test('deterministic final merges 32 batches into a bounded coverage-complete report', () => {
  const entries = Array.from({length: 32}, (_, index) => makeEntry(index + 1, {topicCount: 3}));
  const context = contextFor(entries);
  const child = deterministicDigest({
    batchEntries: entries,
    groupBatches: entries.map((entry) => entry.batchIndex)
  });
  const final = deterministicFinal({
    childDigests: [child],
    allBatches: entries.map((entry) => entry.batchIndex),
    batchEntries: entries
  });
  assert.ok(final.session_topics.topics.length <= 24);
  const normalized = normalizeFinalAnswer(final, {
    allBatches: entries.map((entry) => entry.batchIndex),
    ...context
  });
  assert.equal(normalized.ok, true);
  const refs = new Set(final.session_topics.topics
    .flatMap((topic) => topic.message_refs ?? [])
    .map((ref) => ref.batch));
  assert.equal(refs.size, 32);
  for (const topic of final.session_topics.topics) {
    assert.ok(Date.parse(topic.ended_at) >= Date.parse(topic.started_at));
  }
});

test('final normalization deduplicates and sorts the timeline without dropping evidence', () => {
  const entries = Array.from({length: 4}, (_, index) => makeEntry(index + 1));
  const context = contextFor(entries);
  const duplicate = {
    covered_batches: [1, 2, 3, 4],
    session_topics: {
      summary: 'duplicate test',
      topics: [
        {
          title: 'Same topic', started_at: iso(T0 + 4000), ended_at: iso(T0 + 5000),
          summary: 'later', key_points: ['b'], confidence: 0.6, evidence: 'observed',
          message_refs: [{batch: 3, seq: 1}, {batch: 4, seq: 1}]
        },
        {
          title: 'Same topic', started_at: iso(T0 + 4000), ended_at: iso(T0 + 5000),
          summary: 'earlier', key_points: ['a'], confidence: 0.8, evidence: 'observed',
          message_refs: [{batch: 1, seq: 1}, {batch: 2, seq: 1}]
        }
      ],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
  const normalized = normalizeFinalAnswer(duplicate, {
    allBatches: [1, 2, 3, 4],
    ...context
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.envelope.session_topics.topics.length, 1, 'identical events are merged');
  assert.deepEqual(
    normalized.envelope.session_topics.topics[0].message_refs.map((ref) => ref.batch).sort(),
    [1, 2, 3, 4]
  );
  assert.ok(normalized.envelope.session_topics.topics[0].key_points.includes('a'));
  assert.ok(normalized.envelope.session_topics.topics[0].key_points.includes('b'));
});

test('the tight retry schema is stricter than the normal partial schema', () => {
  const normal = digestSchema(resultSchema, {limits: DIGEST_AGGREGATE_LIMITS});
  const tight = digestSchema(resultSchema, {limits: TIGHT_AGGREGATE_LIMITS});
  assert.ok(tight.properties.session_topics.properties.topics.maxItems
    <= normal.properties.session_topics.properties.topics.maxItems);
  assert.ok(tight.properties.session_topics.properties.summary.maxLength
    <= normal.properties.session_topics.properties.summary.maxLength);
  assert.equal(finalEnvelopeSchema(resultSchema).properties.covered_batches.maxItems, 2001);
});
