#!/usr/bin/env node
/**
 * Offline long-term-memory quality evaluation.
 *
 * It scores *already saved* facts against a human gold set. It never calls a
 * provider, never downloads anything and never writes to the database it reads.
 *
 * Usage:
 *   node scripts/memory-quality-eval.mjs score --db <livememory.db> --job <aij_...> \
 *     --corpus p03 --locale zh-CN [--json out.json] [--md out.md]
 *
 *   node scripts/memory-quality-eval.mjs p03 --root tests/.tmp/paid-p03
 *
 * The P0-3 mode re-scores the four archived real DeepSeek A/B runs (cap 10 and
 * cap 20, two repetitions each) without any new request. It prints a compact
 * comparison table and writes the full per-fact review table as JSON.
 */

import {DatabaseSync} from 'node:sqlite';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {evaluateMemoryQuality, renderQualityMarkdown} from '../src/ai/quality/metrics.mjs';
import {buildP03Gold} from '../tests/fixtures/memory-quality/p03-retro-gold.mjs';
import {loadJobUsage, loadSavedFacts, latestMemoryJob} from '../tests/helpers/memory-quality.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function openReadOnly(file) {
  return new DatabaseSync(file, {readOnly: true});
}

function p03Defaults(sessionId) {
  if (String(sessionId).includes('_ja')) {
    return {
      locale: 'ja',
      viewerPrefix: 'youtube:UC_P03_ses_p03_ja_',
      viewerCount: 60,
      messageCount: 600
    };
  }
  return {
    locale: 'zh-CN',
    viewerPrefix: 'youtube:UC_P03_ses_p03_ab_',
    viewerCount: 25,
    messageCount: 200
  };
}

function runtimeAttempts(runDir, sessionId) {
  const file = join(runDir, 'runtime', 'ai-v13.json');
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const entry = state.sessions?.[sessionId];
    if (!entry?.attemptStats) return null;
    return {
      attempts: Number(entry.attemptStats.total ?? 0),
      repairAttempts: Number(entry.attemptStats.repairAttempts ?? 0),
      outputRejected: Number(entry.attemptStats.outputRejected ?? 0),
      retried: Number(entry.attemptStats.retried ?? 0),
      failed: Number(entry.attemptStats.failed ?? 0)
    };
  } catch {
    return null;
  }
}

function scoreOne({dbFile, jobId, sessionId, corpus, locale, viewerPrefix, viewerCount, messageCount}) {
  const db = openReadOnly(dbFile);
  try {
    const job = jobId
      ? db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(jobId)
      : latestMemoryJob(db, sessionId);
    if (!job) throw new Error(`memory job not found (job=${jobId ?? 'latest'}, session=${sessionId ?? '?'})`);
    const facts = loadSavedFacts(db, {jobId: job.id});
    const usage = loadJobUsage(db, job.id);
    const defaults = p03Defaults(job.session_id);
    const gold = buildP03Gold({
      sessionKey: job.session_id,
      viewerPrefix: viewerPrefix ?? defaults.viewerPrefix,
      viewerCount: Number(viewerCount ?? defaults.viewerCount),
      messageCount: Number(messageCount ?? defaults.messageCount),
      locale: locale ?? defaults.locale
    });
    const evaluation = evaluateMemoryQuality({
      facts,
      goldFacts: gold.goldFacts,
      negatives: gold.negatives,
      usage
    });
    return {
      db: dbFile,
      jobId: job.id,
      sessionId: job.session_id,
      corpus,
      locale: locale ?? defaults.locale,
      evaluation,
      job: {
        batchTotal: job.batch_total,
        memoryViewersTotal: job.memory_viewers_total,
        createdAt: job.created_at
      }
    };
  } finally {
    db.close();
  }
}

function writeOutputs(result, {jsonPath = null, mdPath = null, title = null} = {}) {
  const markdown = renderQualityMarkdown(result.evaluation, {
    title: title ?? `Memory quality — ${basename(result.db)} / ${result.jobId}`
  });
  if (jsonPath) writeFileSync(resolve(jsonPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (mdPath) writeFileSync(resolve(mdPath), markdown, 'utf8');
  return markdown;
}

function scoreCommand() {
  const dbFile = arg('db');
  if (!dbFile) throw new Error('--db is required');
  const corpus = arg('corpus', 'p03');
  if (corpus !== 'p03') throw new Error(`unsupported corpus: ${corpus}`);
  const result = scoreOne({
    dbFile: resolve(dbFile),
    jobId: arg('job'),
    sessionId: arg('session'),
    corpus,
    locale: arg('locale'),
    viewerPrefix: arg('viewer-prefix'),
    viewerCount: arg('viewer-count'),
    messageCount: arg('message-count')
  });
  const markdown = writeOutputs(result, {
    jsonPath: arg('json'),
    mdPath: arg('md'),
    title: arg('title')
  });
  process.stdout.write(markdown);
}

function p03Command() {
  const root = resolve(arg('root', join('tests', '.tmp', 'paid-p03')));
  const runs = [
    {label: 'run1-cap10', dir: 'a', session: 'ses_p03_ab'},
    {label: 'run1-cap20', dir: 'b', session: 'ses_p03_ab'},
    {label: 'run2-cap10', dir: join('repeat', 'a'), session: 'ses_p03_ab'},
    {label: 'run2-cap20', dir: join('repeat', 'b'), session: 'ses_p03_ab'}
  ];
  const results = [];
  for (const run of runs) {
    const dbFile = join(root, run.dir, 'database', 'livememory.db');
    let file;
    try {
      file = readFileSync(dbFile);
    } catch {
      process.stderr.write(`skip ${run.label}: ${dbFile} not found\n`);
      continue;
    }
    if (file.length === 0) continue;
    const result = scoreOne({
      dbFile,
      jobId: null,
      sessionId: run.session,
      corpus: 'p03',
      locale: 'zh-CN',
      viewerPrefix: 'youtube:UC_P03_ses_p03_ab_',
      viewerCount: 25,
      messageCount: 200
    });
    result.label = run.label;
    result.attempts = runtimeAttempts(join(root, run.dir), run.session);
    results.push(result);
  }
  if (results.length === 0) throw new Error('no archived P0-3 runs found');
  const rows = results.map((result) => {
    const s = result.evaluation.summary;
    return {
      label: result.label,
      run: String(result.job.batchTotal),
      facts: s.saved.total,
      stated: s.saved.stated,
      uncertain: s.saved.uncertain,
      correct: s.correct,
      wrong: s.wrong,
      recall: s.recall,
      importantRecall: s.importantRecall,
      accuracy: s.accuracy,
      requests: s.tokens.requests,
      repairs: result.attempts?.repairAttempts ?? null,
      rejected: result.attempts?.outputRejected ?? null,
      tokens: s.tokens.totalTokens,
      cost: s.tokens.estimatedCost,
      tokensPerCorrect: s.tokens.tokensPerCorrectFact,
      costPerCorrect: s.tokens.costPerCorrectFact
    };
  });
  const outJson = arg('json');
  if (outJson) {
    writeFileSync(resolve(outJson), `${JSON.stringify({generatedAt: new Date().toISOString(), results}, null, 2)}\n`, 'utf8');
  }
  const pct = (value) => (value === null ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`);
  const lines = [
    '# P0-3 archived real DeepSeek A/B — semantic re-score',
    '',
    '| run | batches | facts | stated | uncertain | correct | wrong | recall | important | accuracy | req | repairs | rejected | tokens | cost | tok/correct | $/correct |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const row of rows) {
    lines.push([
      row.label,
      row.run,
      row.facts,
      row.stated,
      row.uncertain,
      row.correct,
      row.wrong,
      pct(row.recall),
      pct(row.importantRecall),
      pct(row.accuracy),
      row.requests,
      row.repairs ?? 'n/a',
      row.rejected ?? 'n/a',
      row.tokens,
      row.cost === null ? 'n/a' : `$${Number(row.cost).toFixed(5)}`,
      row.tokensPerCorrect === null ? 'n/a' : Math.round(row.tokensPerCorrect),
      row.costPerCorrect === null ? 'n/a' : `$${Number(row.costPerCorrect).toFixed(6)}`
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  const markdown = `${lines.join('\n')}\n`;
  const outMd = arg('md');
  if (outMd) writeFileSync(resolve(outMd), markdown, 'utf8');
  process.stdout.write(markdown);
}

try {
  const command = process.argv[2];
  if (command === 'score') scoreCommand();
  else if (command === 'p03') p03Command();
  else {
    process.stderr.write('usage: memory-quality-eval.mjs score --db <file> [--job id] [--corpus p03] | p03 [--root dir]\n');
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`[memory-quality-eval] ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
