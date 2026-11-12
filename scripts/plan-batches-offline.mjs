/**
 * Offline batch-plan comparison for a saved session package.
 *
 * Usage:
 *   node scripts/plan-batches-offline.mjs <path-to-session.zip>
 *
 * It never contacts a provider and never prints chat text: only message counts,
 * byte sizes and token estimates. The package's own instructions/context/schema
 * are used to measure the fixed overhead, exactly like createSessionAnalysisJob.
 */

import {readFileSync} from 'node:fs';
import {readZipEntry, readZipIndex} from '../src/shared/zip.mjs';
import {
  estimateTokens,
  planBatchBudget,
  planSessionMessageBatches,
  promptOverheadTokens,
  resolveBatchInputTokens
} from '../src/ai/batching/tokens.mjs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node scripts/plan-batches-offline.mjs <session.zip>\n');
  process.exit(2);
}

const buffer = readFileSync(file);
const entries = new Set(readZipIndex(buffer).map((entry) => entry.name));
function text(name) {
  if (!entries.has(name)) throw new Error(`package missing ${name}`);
  return readZipEntry(buffer, name).toString('utf8');
}

const manifest = JSON.parse(text('manifest.json'));
const messageLines = text('messages.jsonl').split('\n').filter(Boolean);
const messageTokens = messageLines.map((line) => estimateTokens(line));
const instructions = text('instructions.md');
const context = text('session_context.json');
const schema = JSON.parse(text('result.schema.json'));
const overheadBase = promptOverheadTokens({instructions, context, schema});
const overhead = overheadBase + 250;
const outputReserve = 8000;

const batchesFor = (total) => {
  const target = resolveBatchInputTokens({configured: total, contextLength: null, outputReserve});
  const budget = planBatchBudget({
    totalInputTokens: target,
    overheadTokens: overhead,
    outputReserve,
    contextLength: null
  });
  const plan = planSessionMessageBatches({
    messageTokens,
    contentBudget: budget.contentTokens,
    overheadTokens: budget.overheadTokens,
    maxMessages: 5000
  });
  return {budget, plan};
};

const totals = [8000, 16000, 24000, 32000];
const results = totals.map((total) => {
  const {budget, plan} = batchesFor(total);
  const estimatedInput = plan.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
  return {
    configured: total,
    effectiveInput: budget.totalInputTokens,
    contentBudget: budget.contentTokens,
    overheadAdjusted: budget.overheadAdjusted,
    batches: plan.length,
    messagesPerBatchAvg: plan.length ? (messageLines.length / plan.length).toFixed(1) : '0',
    maxBatchEstimated: plan.length ? Math.max(...plan.map((batch) => batch.estimatedTokens)) : 0,
    estimatedTotalInput: estimatedInput,
    actualProjection: Math.round(estimatedInput * 1.366),
    covered: plan.reduce((sum, batch) => sum + batch.messageCount, 0)
  };
});

process.stdout.write(`package: ${file}\n`);
process.stdout.write(`session: ${manifest.session_id ?? 'unknown'} locale=${manifest.locale ?? '?'}\n`);
process.stdout.write(`messages: ${messageLines.length}\n`);
process.stdout.write(`message tokens (estimate): ${messageTokens.reduce((a, b) => a + b, 0)}\n`);
process.stdout.write(`prompt overhead (estimate): ${overhead} (instructions/context/schema/wrapper)\n`);
process.stdout.write(`output reserve: ${outputReserve}\n\n`);
process.stdout.write('total\teffective\tcontent\toverheadAdj\tbatches\tavgMsgs\tmaxBatch\ttotalInputEst\tactualProjection\tcovered\n');
for (const row of results) {
  process.stdout.write([
    row.configured,
    row.effectiveInput,
    row.contentBudget,
    row.overheadAdjusted ? 'yes' : 'no',
    row.batches,
    row.messagesPerBatchAvg,
    row.maxBatchEstimated,
    row.estimatedTotalInput,
    row.actualProjection,
    row.covered
  ].join('\t') + '\n');
}
