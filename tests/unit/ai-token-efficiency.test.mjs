import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage} from '../../src/ai/providers/adapters.mjs';
import {
  addUsage,
  countRequestWithoutUsage,
  estimateCost,
  normalizePricing
} from '../../src/ai/providers/pricing.mjs';
import {attemptRecord} from '../../src/ai/runtime/attempt.mjs';
import {buildMemoryPrompt, buildSessionPrompt} from '../../src/ai/api/prompts.mjs';
import {
  MEMORY_BASE_OUTPUT_TOKENS,
  MEMORY_MAX_VIEWERS_PER_BATCH,
  planMemoryViewerBatches
} from '../../src/ai/batching/tokens.mjs';
import {loadResultSchema} from '../../src/ai/import/validate.mjs';

/**
 * RC0-AI-EFFICIENCY: token attribution and prompt de-duplication.
 *
 * These are the invariants the efficiency work must not break:
 *   - a provider-reported number is never replaced by an estimate;
 *   - a missing number stays unknown (null), never 0;
 *   - cache hits and reasoning tokens survive into the stored usage;
 *   - a request without usage is still counted as one attempt;
 *   - the answer schema is delivered exactly once per request.
 */

const PRICING = {currency: 'USD', inputPerMillion: 1, outputPerMillion: 2};

test('cache and reasoning tokens are parsed for all three usage families', () => {
  const openai = normalizeUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: {cached_tokens: 600},
      completion_tokens_details: {reasoning_tokens: 120}
    }
  });
  assert.equal(openai.inputTokens, 1000, 'cached tokens are a subset for OpenAI');
  assert.equal(openai.cachedInputTokens, 600);
  assert.equal(openai.reasoningTokens, 120);
  assert.equal(openai.cacheReported, true);

  const deepseek = normalizeUsage({
    usage: {prompt_tokens: 800, completion_tokens: 100, prompt_cache_hit_tokens: 500}
  });
  assert.equal(deepseek.inputTokens, 800);
  assert.equal(deepseek.cachedInputTokens, 500);
  assert.equal(deepseek.raw.source, 'deepseek-cache-fields');

  const anthropic = normalizeUsage({
    usage: {
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100
    }
  });
  // Anthropic excludes cache tokens from input_tokens, so the billed input is
  // 200 fresh + 700 cache read + 100 cache write.
  assert.equal(anthropic.inputTokens, 1000);
  assert.equal(anthropic.cachedInputTokens, 700);
  assert.equal(anthropic.cacheWriteInputTokens, 100);
  assert.equal(anthropic.raw.source, 'anthropic-cache-fields');
});

test('a provider that reports no usage yields null, never zero', () => {
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({usage: {}}), null);
});

test('usage accumulation keeps reasoning, cache and attempt counters', () => {
  let total = null;
  total = addUsage(total, {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 10,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0
  }, PRICING);
  total = addUsage(total, {
    inputTokens: 50,
    outputTokens: 5,
    reasoningTokens: 2,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0
  }, PRICING);
  assert.equal(total.inputTokens, 150);
  assert.equal(total.outputTokens, 25);
  assert.equal(total.reasoningTokens, 12);
  assert.equal(total.cachedInputTokens, 50);
  assert.equal(total.requests, 2);
  assert.equal(total.attempts, 2);
  assert.equal(total.cost.currency, 'USD');
  assert.equal(total.cost.cachedInputTokens, 50);
  // 100 uncached input + 50 cached at the input price + 25 output at 2 USD/Mtok.
  const expected = (100 / 1e6) * 1 + (50 / 1e6) * 1 + (25 / 1e6) * 2;
  assert.ok(Math.abs(total.cost.amount - expected) < 1e-12);
  assert.equal(total.cost.cachePriced, false);
});

test('a configured cache price is used for cache hits only', () => {
  const pricing = normalizePricing({...PRICING, cachedInputPerMillion: 0.25});
  assert.equal(pricing.cachedInputPerMillion, 0.25);
  const cost = estimateCost({
    pricing,
    inputTokens: 1000,
    outputTokens: 0,
    cachedInputTokens: 800
  });
  // 200 fresh at 1 + 800 cached at 0.25 => 0.0002 + 0.0002
  assert.ok(Math.abs(cost.amount - 0.0004) < 1e-12);
  assert.equal(cost.cachePriced, true);
});

test('unknown pricing never produces a fabricated amount', () => {
  assert.equal(estimateCost({pricing: null, inputTokens: 10, outputTokens: 10}), null);
  const usage = addUsage(null, {inputTokens: 10, outputTokens: 10}, null);
  assert.equal(usage.cost, null);
  assert.equal(usage.inputTokens, 10);
});

test('a request without usage is counted as an unknown attempt', () => {
  const usage = countRequestWithoutUsage(addUsage(null, {inputTokens: 5, outputTokens: 1}, PRICING));
  assert.equal(usage.requests, 1, 'only usage-bearing responses count as reported requests');
  assert.equal(usage.attempts, 2, 'the unknown attempt is still counted');
  assert.equal(usage.unknownUsageAttempts, 1);
  assert.equal(usage.usageReported, false);
  assert.equal(usage.inputTokens, 5);
  assert.ok(Math.abs(usage.cost.amount - 0.000007) < 1e-12);
});

test('attempt records label the usage source and keep unknown distinct from zero', () => {
  const known = attemptRecord({
    kind: 'memory',
    attempt: 0,
    outcome: 'succeeded',
    usage: {inputTokens: 11, outputTokens: 3, cachedInputTokens: 4},
    estimatedInputTokens: 40
  });
  assert.equal(known.usageKnown, true);
  assert.equal(known.usageSource, 'provider-reported');
  assert.equal(known.inputTokens, 11);
  assert.equal(known.cachedInputTokens, 4);
  assert.equal(known.estimatedInputTokens, 40);
  assert.equal(known.estimateSource, 'bytes-per-3-estimate');

  const unknown = attemptRecord({kind: 'memory', attempt: 0, outcome: 'failed'});
  assert.equal(unknown.usageKnown, false);
  assert.equal(unknown.usageSource, 'unknown');
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
});

function memoryFiles({refs = 2, locale = 'en'} = {}) {
  const viewers = Array.from({length: refs}, (_unused, index) => ({
    viewer_id: `youtube:UC_${index + 1}`,
    nickname: `Viewer ${index + 1}`,
    evidence_seqs: [index + 1],
    zero_excerpt: false,
    memory: {status: 'none', version: 0, facts: []}
  }));
  return {
    'manifest.json': JSON.stringify({
      protocol: 'livememory-analysis-v1',
      job_id: 'aij_eff',
      session_id: 'ses_eff',
      locale,
      batch: {batch_id: 'aij_eff-b01', index: 1, total: 1, message_count: refs},
      tasks: [{task_id: 'ses_eff-memory'}],
      counts: {viewers_total: refs}
    }),
    'memory_context.json': JSON.stringify({
      protocol: 'livememory-analysis-v1',
      kind: 'viewer_memory_only',
      analysis_scope: 'viewer_memory',
      job: {id: 'aij_eff'},
      batch: {index: 1, total: 1, batch_id: 'aij_eff-b01', task_id: 'ses_eff-memory'},
      viewers,
      notes: {}
    }),
    'viewer_excerpts.jsonl': viewers
      .map((viewer, index) => JSON.stringify({seq: index + 1, viewer_id: viewer.viewer_id, content: 'hello'}))
      .join('\n'),
    'result.schema.json': JSON.stringify(loadResultSchema('1.3.0')),
    'instructions.md': ''
  };
}

test('the memory prompt carries the answer schema exactly once', () => {
  const files = memoryFiles();
  const legacy = buildMemoryPrompt(files, {structuredOutputs: false});
  const legacyUser = legacy.messages[1].content;
  assert.match(legacyUser, /## compact answer schema/, 'a non-structured provider needs the textual schema');
  assert.equal(legacyUser.split('## compact answer schema').length - 1, 1);
  assert.ok(legacy.answerSchema, 'the schema is still returned for response_format');

  const structured = buildMemoryPrompt(files, {structuredOutputs: true});
  const structuredUser = structured.messages[1].content;
  assert.doesNotMatch(structuredUser, /## compact answer schema/, 'the schema is not sent twice');
  assert.match(structuredUser, /supplied in the request `response_format`/);
  assert.ok(structured.answerSchema, 'the machine-enforced schema is unchanged');
  assert.ok(structured.estimatedTokens < legacy.estimatedTokens);
});

test('the memory prompt contains the compact answer example only once', () => {
  const files = memoryFiles();
  const user = buildMemoryPrompt(files, {structuredOutputs: true}).messages[1].content;
  const occurrences = user.split('"viewers": [').length - 1;
  assert.equal(occurrences, 1, 'the example is not repeated as a second identical block');
  assert.doesNotMatch(user, /## Output example \(compact/);
});

test('the session prompt carries the answer schema exactly once', () => {
  const schema = JSON.stringify(loadResultSchema('1.3.0'));
  const files = {
    'manifest.json': JSON.stringify({
      protocol: 'livememory-analysis-v1',
      job_id: 'aij_s',
      session_id: 'ses_s',
      locale: 'en',
      broadcast_started_at: null,
      batch: {batch_id: 'aij_s-b01', index: 1, total: 1},
      tasks: [{task_id: 'ses_s-analysis'}],
      counts: {messages: 1, viewers: 0}
    }),
    'session_context.json': JSON.stringify({session: {id: 'ses_s'}, counts: {}}),
    'messages.jsonl': JSON.stringify({seq: 1, content: 'hi', at: '2026-11-08T10:00:01.000Z'}),
    'instructions.md': '## Rules\n- be accurate\n',
    'result.schema.json': schema
  };
  const legacy = buildSessionPrompt(files, {structuredOutputs: false});
  assert.equal(legacy.messages[1].content.split('## compact answer schema').length - 1, 1);
  const structured = buildSessionPrompt(files, {structuredOutputs: true});
  assert.doesNotMatch(structured.messages[1].content, /## compact answer schema/);
  assert.ok(structured.answerSchema);
  assert.ok(structured.estimatedTokens < legacy.estimatedTokens);
});

function sparseViewers(count, {excerpts = 1} = {}) {
  return Array.from({length: count}, (_unused, index) => ({
    viewerId: `youtube:UC_${index}`,
    excerptCount: excerpts,
    excerptTokens: excerpts * 60,
    memoryTokens: 0,
    existingFacts: 0
  }));
}

test('a sparse audience uses the spare budget instead of one request per ten viewers', () => {
  const viewers = sparseViewers(100);
  const tight = planMemoryViewerBatches({
    viewers,
    viewerCap: 10,
    viewerCapHard: 10,
    contentBudget: 16000,
    overheadTokens: 8000,
    outputBudgetTokens: MEMORY_BASE_OUTPUT_TOKENS
  });
  const adaptive = planMemoryViewerBatches({
    viewers,
    viewerCap: 10,
    viewerCapHard: MEMORY_MAX_VIEWERS_PER_BATCH,
    contentBudget: 16000,
    overheadTokens: 8000,
    outputBudgetTokens: MEMORY_BASE_OUTPUT_TOKENS
  });
  assert.equal(tight.batches.length, 10);
  assert.ok(adaptive.batches.length < tight.batches.length);
  assert.ok(adaptive.batches.every((batch) => batch.viewerIds.length <= MEMORY_MAX_VIEWERS_PER_BATCH));
  const planned = adaptive.batches.reduce((total, batch) => total + batch.viewerIds.length, 0);
  assert.equal(planned, 100, 'no viewer is dropped or duplicated');
});

test('adaptive batching never exceeds the output budget or the hard ceiling', () => {
  const viewer = {
    viewerId: 'youtube:UC_hot',
    excerptCount: 200,
    excerptTokens: 200 * 60,
    memoryTokens: 0,
    existingFacts: 4
  };
  const viewers = Array.from({length: 40}, (_unused, index) => ({...viewer, viewerId: `youtube:UC_${index}`}));
  const plan = planMemoryViewerBatches({
    viewers,
    viewerCap: 10,
    viewerCapHard: MEMORY_MAX_VIEWERS_PER_BATCH,
    contentBudget: 60000,
    overheadTokens: 8000,
    outputBudgetTokens: MEMORY_BASE_OUTPUT_TOKENS
  });
  // Dense viewers are output-bound: the adaptive ceiling must not pack them in.
  assert.ok(plan.batches.every((batch) => batch.viewerIds.length <= 10));
  assert.equal(plan.batches.reduce((total, batch) => total + batch.viewerIds.length, 0), 40);
});
