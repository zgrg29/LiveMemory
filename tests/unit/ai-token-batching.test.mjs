import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BATCH_INPUT_TOKENS,
  MIN_BATCH_INPUT_TOKENS,
  planBatchBudget,
  planMemoryViewerBatches,
  planSessionMessageBatches,
  promptOverheadTokens,
  resolveBatchInputTokens,
  resolveMaxCompletionTokens,
  resolveOutputTokens
} from '../../src/ai/batching/tokens.mjs';
import {assignMemoryOnlyBatches} from '../../src/ai/export/split-jobs.mjs';

test('the input budget is configurable, clamped and adaptive for small contexts', () => {
  assert.equal(resolveBatchInputTokens({}), DEFAULT_BATCH_INPUT_TOKENS);
  assert.equal(resolveBatchInputTokens({configured: 500}), MIN_BATCH_INPUT_TOKENS);
  assert.equal(resolveBatchInputTokens({configured: 999999}), 32000);
  assert.equal(resolveBatchInputTokens({configured: 6000}), 6000);
  // A small context cannot fit the default 8k + 8k output; shrink, never below 2k.
  assert.ok(resolveBatchInputTokens({contextLength: 16000, outputReserve: 8000}) < 8000);
  assert.equal(resolveBatchInputTokens({contextLength: 8000, outputReserve: 8000}), MIN_BATCH_INPUT_TOKENS);
});

test('the output budget leaves room for the actual input inside the context window', () => {
  assert.equal(resolveOutputTokens({desired: 8000, inputTokens: 7000, contextLength: 131072}), 8000);
  assert.equal(resolveOutputTokens({desired: 8000, inputTokens: 9000, contextLength: 12000}), 2500);
  assert.equal(resolveOutputTokens({desired: 100, inputTokens: 0, contextLength: null}), 512);
});

test('session planning covers every message once and only exceeds the budget for one oversized message', () => {
  const tokens = [10, 20, 30, 40, 5000, 10];
  const batches = planSessionMessageBatches({
    messageTokens: tokens,
    overheadTokens: 1000,
    inputBudget: 2000,
    maxMessages: 5000
  });
  assert.deepEqual(
    batches.flatMap((batch) => [batch.startIndex, batch.endIndex]),
    [0, 4, 4, 5, 5, 6]
  );
  const indices = batches.flatMap((batch) => {
    const list = [];
    for (let index = batch.startIndex; index < batch.endIndex; index += 1) list.push(index);
    return list;
  });
  assert.deepEqual(indices, [0, 1, 2, 3, 4, 5]);
  assert.equal(batches.length, 3);
  for (const batch of batches) {
    if (batch.endIndex - batch.startIndex === 1) continue;
    assert.ok(batch.messageTokens <= 1000, 'normal batches must fit the remaining budget');
  }
});

test('memory planning never splits or drops a viewer and isolates an oversized viewer', () => {
  const viewers = [
    {viewerId: 'v1', excerptCount: 10, excerptTokens: 500, memoryTokens: 100},
    {viewerId: 'v2', excerptCount: 10, excerptTokens: 500, memoryTokens: 100},
    {viewerId: 'big', excerptCount: 120, excerptTokens: 9000, memoryTokens: 2000},
    {viewerId: 'v4', excerptCount: 5, excerptTokens: 200, memoryTokens: 50}
  ];
  const plan = planMemoryViewerBatches({
    viewers,
    viewerCap: 10,
    excerptCap: 600,
    overheadTokens: 1500,
    inputBudget: 4000
  });
  const assigned = plan.batches.flatMap((batch) => batch.viewerIds);
  assert.deepEqual(assigned, ['v1', 'v2', 'big', 'v4'], 'every viewer exactly once, in stable order');
  assert.equal(plan.oversized, true);
  const bigBatch = plan.batches.find((batch) => batch.viewerIds.includes('big'));
  assert.deepEqual(bigBatch.viewerIds, ['big'], 'an oversized viewer is isolated rather than dropped');
  assert.equal(plan.batches.every((batch) => batch.viewerIds.length <= 10), true);
});

test('the viewer cap and excerpt cap still bound memory batches', () => {
  const viewers = Array.from({length: 7}, (_, index) => ({
    viewerId: `v${index}`,
    excerptCount: 200,
    excerptTokens: 800,
    memoryTokens: 100
  }));
  const plan = planMemoryViewerBatches({
    viewers,
    viewerCap: 5,
    excerptCap: 600,
    overheadTokens: 1000,
    inputBudget: 32000
  });
  for (const batch of plan.batches) {
    assert.ok(batch.viewerIds.length <= 5);
    assert.ok(batch.excerptCount <= 600);
  }
  assert.equal(plan.batches.flatMap((batch) => batch.viewerIds).length, 7);
});

test('exceeding the batch limit fails explicitly instead of silently truncating', () => {
  const viewers = Array.from({length: 4}, (_, index) => ({
    viewerId: `v${index}`,
    excerptCount: 1,
    excerptTokens: 500,
    memoryTokens: 0,
    cost: 500
  }));
  assert.throws(() => planMemoryViewerBatches({
    viewers,
    viewerCap: 1,
    excerptCap: 600,
    overheadTokens: 100,
    inputBudget: 32000,
    maxBatches: 2
  }), (error) => error.code === 'ANALYSIS_TOO_MANY_BATCHES');
});

test('the legacy memory assignment helper stays compatible and gains token awareness', () => {
  const viewers = [
    {viewer_id: 'a'},
    {viewer_id: 'b'},
    {viewer_id: 'c'}
  ];
  const messagesByViewer = new Map([
    ['a', new Array(400).fill({})],
    ['b', new Array(400).fill({})],
    ['c', []]
  ]);
  const legacy = assignMemoryOnlyBatches({viewers, messagesByViewer, viewerCap: 10, excerptCap: 600, maxBatches: 10});
  assert.deepEqual(legacy.map((batch) => batch.viewerIds), [['a', 'b', 'c']]);
  const costs = new Map([
    ['a', {excerptTokens: 3000, memoryTokens: 3000}],
    ['b', {excerptTokens: 100, memoryTokens: 0}],
    ['c', {excerptTokens: 0, memoryTokens: 0}]
  ]);
  const planned = assignMemoryOnlyBatches({
    viewers,
    messagesByViewer,
    viewerCap: 10,
    excerptCap: 600,
    maxBatches: 10,
    viewerCosts: costs,
    overheadTokens: 1000,
    inputBudget: 4000
  });
  assert.deepEqual(planned.map((batch) => batch.viewerIds), [['a'], ['b', 'c']]);
  assert.equal(planned[0].oversized, true);
});

test('prompt overhead accepts a measured schema size', () => {
  assert.equal(promptOverheadTokens({instructions: '', context: null, schema: 1234}) >= 1234, true);
});

/**
 * Real 2026-11-12 package shape: 889 Japanese/ASCII messages, ~94k estimated
 * message tokens, ~6.9k fixed prompt overhead. The old 8k-total policy produced
 * ~125 tiny batches; the new policy must keep the same input to a handful of
 * requests without dropping a message.
 */
test('an 889-message session no longer fragments into tiny batches', () => {
  const messageCount = 889;
  const totalMessageTokens = 94137;
  const perMessage = Math.floor(totalMessageTokens / messageCount);
  const messageTokens = Array.from({length: messageCount}, (_, index) => (
    index === messageCount - 1 ? totalMessageTokens - perMessage * (messageCount - 1) : perMessage
  ));
  const overhead = 7193;

  const planFor = (total) => {
    const budget = planBatchBudget({
      totalInputTokens: total,
      overheadTokens: overhead,
      outputReserve: 8000,
      contextLength: null
    });
    const batches = planSessionMessageBatches({
      messageTokens,
      contentBudget: budget.contentTokens,
      overheadTokens: budget.overheadTokens,
      maxMessages: 5000
    });
    return {budget, batches};
  };

  const eight = planFor(8000);
  const sixteen = planFor(16000);
  const twentyFour = planFor(24000);
  const thirtyTwo = planFor(32000);

  assert.equal(eight.budget.overheadAdjusted, true, '8k must not leave only ~800 content tokens');
  assert.ok(eight.batches.length <= 30, `8k plan is still bounded: ${eight.batches.length}`);
  assert.ok(eight.batches.length < 40, 'the 125-batch fragmentation must not return');

  assert.ok(twentyFour.batches.length <= 8, `24k plan: ${twentyFour.batches.length} batches`);
  assert.ok(thirtyTwo.batches.length <= 6, `32k plan: ${thirtyTwo.batches.length} batches`);
  assert.ok(thirtyTwo.batches.length <= twentyFour.batches.length);
  assert.ok(twentyFour.batches.length <= sixteen.batches.length);

  for (const {budget, batches} of [eight, sixteen, twentyFour, thirtyTwo]) {
    assert.equal(
      batches.reduce((sum, batch) => sum + batch.messageCount, 0),
      messageCount,
      'every message is covered exactly once'
    );
    assert.deepEqual(
      batches.flatMap((batch) => {
        const indexes = [];
        for (let index = batch.startIndex; index < batch.endIndex; index += 1) indexes.push(index);
        return indexes;
      }),
      Array.from({length: messageCount}, (_, index) => index)
    );
    for (const batch of batches) {
      assert.ok(
        batch.estimatedTokens <= budget.totalInputTokens + 2048,
        'a normal batch may only exceed the budget by one oversized message'
      );
    }
  }
});

test('the default budget is 24k and keeps a large session at a few requests', () => {
  assert.equal(DEFAULT_BATCH_INPUT_TOKENS, 24000);
  assert.equal(resolveBatchInputTokens({}), 24000);
  assert.ok(resolveBatchInputTokens({contextLength: 32000, outputReserve: 8000}) <= 24000);
});

test('a 124-viewer memory job assigns every viewer exactly once', () => {
  const viewers = Array.from({length: 124}, (_, index) => ({
    viewerId: `v${index}`,
    excerptCount: 12,
    excerptTokens: 300,
    memoryTokens: 80
  }));
  const plan = planMemoryViewerBatches({
    viewers,
    viewerCap: 10,
    excerptCap: 600,
    contentBudget: 16000,
    overheadTokens: 5000,
    maxBatches: 200
  });
  const assigned = plan.batches.flatMap((batch) => batch.viewerIds);
  assert.equal(assigned.length, 124);
  assert.equal(new Set(assigned).size, 124);
  assert.equal(plan.totalViewers, 124);
  assert.equal(plan.oversized, false);
});

test('a single viewer above the hard request cap fails explicitly instead of being dropped', () => {
  assert.throws(() => planMemoryViewerBatches({
    viewers: [{viewerId: 'huge', excerptCount: 600, excerptTokens: 50000, memoryTokens: 0}],
    viewerCap: 10,
    excerptCap: 600,
    contentBudget: 8000,
    overheadTokens: 5000,
    maxSingleViewerTokens: 48000
  }), (error) => error.code === 'ANALYSIS_MEMORY_VIEWER_TOO_LARGE');
});

test('DashScope total completion is bounded without disabling thinking', () => {
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'dashscope',
    answerTokens: 8000,
    estimatedInputTokens: 24000,
    contextLength: null
  }), 24000);
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'custom',
    answerTokens: 8000
  }), null);
  // A declared 32k context still fits the cap to the remaining room.
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'dashscope',
    answerTokens: 8000,
    estimatedInputTokens: 24000,
    contextLength: 32000
  }), 8000);
});
