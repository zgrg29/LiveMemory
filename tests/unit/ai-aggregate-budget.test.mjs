import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  MAX_AGGREGATE_OUTPUT_TOKENS,
  MIN_AGGREGATE_OUTPUT_TOKENS,
  resolveAggregateOutputTokens,
  resolveMaxCompletionTokens
} from '../../src/ai/batching/tokens.mjs';
import {
  buildSessionAggregateAnswerSchema,
  buildSessionAnswerSchema
} from '../../src/ai/api/compact.mjs';
import {
  buildSessionAggregatePrompt,
  condenseBatchResult
} from '../../src/ai/api/prompts.mjs';

const ROOT = process.cwd();
const resultSchema = JSON.parse(readFileSync(
  join(ROOT, 'src/ai/schemas/analysis-result-v1.3.schema.json'),
  'utf8'
));

function batchResults(count = 18) {
  return Array.from({length: count}, (_, index) => ({
    batch_index: index + 1,
    task_id: `task-b${index + 1}`,
    coverage: {
      from_seq: index * 100 + 1,
      to_seq: (index + 1) * 100,
      message_count: 100,
      from_at: `2026-11-08T10:${String(index).padStart(2, '0')}:00.000Z`,
      to_at: `2026-11-08T10:${String(index).padStart(2, '0')}:59.000Z`
    },
    result: {
      summary: `Batch ${index + 1} summary`,
      topics: [{
        title: `Topic ${index + 1}`,
        started_at: `2026-11-08T10:${String(index).padStart(2, '0')}:00.000Z`,
        ended_at: `2026-11-08T10:${String(index).padStart(2, '0')}:59.000Z`,
        summary: 'Topic summary',
        key_points: ['point'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [{batch: index + 1, seq: 1}]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  }));
}

test('the aggregate output budget is independent, bounded and derived from real batch results', () => {
  assert.equal(resolveAggregateOutputTokens({batchResultTokens: 0}), MIN_AGGREGATE_OUTPUT_TOKENS);
  assert.equal(resolveAggregateOutputTokens({batchResultTokens: 1000}), MIN_AGGREGATE_OUTPUT_TOKENS);
  assert.equal(
    resolveAggregateOutputTokens({batchResultTokens: 30000}),
    MAX_AGGREGATE_OUTPUT_TOKENS,
    'an 18-batch, ~30k-token merge gets a real report budget, not 8k'
  );
  assert.equal(
    resolveAggregateOutputTokens({batchResultTokens: 100000}),
    MAX_AGGREGATE_OUTPUT_TOKENS,
    'the budget is capped instead of growing without bound'
  );
  assert.equal(
    resolveAggregateOutputTokens({batchResultTokens: 30000, inputTokens: 20000, contextLength: 32000}),
    11500,
    'a known context still limits the answer by remaining room'
  );
  assert.ok(
    resolveAggregateOutputTokens({batchResultTokens: 30000}) > 8000,
    'the old batch budget must not be reused for the merge'
  );
});

test('DashScope completion headroom is added to the independent aggregate answer budget', () => {
  const completion = resolveMaxCompletionTokens({
    providerId: 'dashscope',
    answerTokens: resolveAggregateOutputTokens({batchResultTokens: 30000}),
    estimatedInputTokens: 34048,
    contextLength: 0
  });
  assert.equal(completion, MAX_AGGREGATE_OUTPUT_TOKENS + 16000);
  assert.ok(completion <= 96000);
});

test('the aggregate answer schema is stricter than the full report schema and does not mutate it', () => {
  const full = buildSessionAnswerSchema(resultSchema);
  const bounded = buildSessionAggregateAnswerSchema(resultSchema);
  assert.equal(full.properties.session_topics.properties.topics.maxItems, 60);
  assert.equal(bounded.properties.session_topics.properties.topics.maxItems, 24);
  assert.equal(bounded.properties.session_topics.properties.sentiment.maxItems, 12);
  assert.equal(bounded.properties.session_topics.properties.disputes.maxItems, 8);
  assert.equal(bounded.properties.session_topics.properties.highlights.maxItems, 8);
  assert.equal(bounded.properties.session_topics.properties.summary.maxLength, 800);
  assert.equal(
    bounded.properties.session_topics.properties.topics.items.properties.key_points.maxItems,
    4
  );
  assert.equal(
    bounded.properties.session_topics.properties.topics.items.properties.message_refs.maxItems,
    4
  );
  assert.equal(bounded.properties.viewer_profiles, undefined,
    'the aggregate must not ask for per-session viewer profiles');
  assert.equal(resultSchema.properties.session_topics.properties.topics.maxItems, 60,
    'the source schema is not mutated');
});

test('the aggregate prompt limits output and lists every batch coverage in all three locales', () => {
  const manifest = {
    job_id: 'aij_test',
    session_id: 'ses_test',
    locale: 'en',
    tasks: [{task_id: 'ses_test-analysis-final'}]
  };
  const results = batchResults(18);
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const prompt = buildSessionAggregatePrompt({
      manifest: {...manifest, locale},
      batchResults: results,
      resultSchema
    });
    const text = prompt.messages.map((message) => message.content).join('\n');
    assert.match(text, /AGGREGATE MERGE CONTRACT/);
    assert.match(text, /batch 18:/, `${locale}: the last batch must be listed`);
    assert.match(text, /batch 1:/);
    assert.match(text, /24/);
    assert.match(text, /viewer_memory_updates/);
    assert.match(text, /\{"batch"/);
    assert.equal(prompt.answerSchema.properties.viewer_profiles, undefined);
    assert.ok(prompt.estimatedTokens > 0);
  }
});

test('compact per-batch condensation keeps every evidence ref and bounds only cardinality', () => {
  const result = {
    summary: 'S'.repeat(5000),
    session_topics: {
      summary: 'S'.repeat(5000),
      topics: Array.from({length: 30}, (_, index) => ({
        title: `Topic ${index}`,
        started_at: '2026-11-08T10:00:00.000Z',
        ended_at: '2026-11-08T10:01:00.000Z',
        summary: 'x'.repeat(3000),
        key_points: Array.from({length: 20}, (_, point) => `p${point}`.repeat(100)),
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1, 2, 3, 4, 5, 6, 7, 8]
      })),
      sentiment: Array.from({length: 20}, () => ({
        at: '2026-11-08T10:00:00.000Z', tone: 'positive', note: 'n'.repeat(1000), confidence: 0.5
      })),
      disputes: Array.from({length: 20}, () => ({
        summary: 'd'.repeat(1000),
        started_at: '2026-11-08T10:00:00.000Z',
        note: 'n'.repeat(1000),
        confidence: 0.5
      })),
      highlights: Array.from({length: 20}, () => ({
        started_at: '2026-11-08T10:00:00.000Z',
        ended_at: '2026-11-08T10:01:00.000Z',
        reason: 'r'.repeat(1000),
        clip_suggestion: 'c'.repeat(1000)
      }))
    }
  };
  const compact = condenseBatchResult(result, {
    batchIndex: 7,
    limits: {
      topics: 5,
      sentiment: 3,
      disputes: 2,
      highlights: 2,
      messageRefs: 4,
      keyPoints: 3,
      summaryChars: 1200,
      topicSummaryChars: 800
    }
  });
  assert.equal(compact.topics.length, 5);
  assert.equal(compact.sentiment.length, 3);
  assert.equal(compact.disputes.length, 2);
  assert.equal(compact.highlights.length, 2);
  assert.equal(compact.topics[0].summary.length, 800);
  assert.equal(compact.topics[0].key_points.length, 3);
  assert.deepEqual(compact.topics[0].message_refs, [
    {batch: 7, seq: 1},
    {batch: 7, seq: 2},
    {batch: 7, seq: 3},
    {batch: 7, seq: 4}
  ]);
  assert.ok(compact.summary.length <= 1200);
});
