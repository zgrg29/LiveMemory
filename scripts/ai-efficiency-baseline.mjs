#!/usr/bin/env node
/**
 * Token-efficiency baseline harness (RC0-AI-EFFICIENCY).
 *
 * Usage:
 *   node scripts/ai-efficiency-baseline.mjs [--label <name>] [--only <scenario,...>] [--json <path>]
 *
 * What this measures, and how honestly
 * ------------------------------------
 * Every AI request that LiveMemory sends is observed at the transport boundary
 * (`fetchImpl`). For each request the harness records the *real* serialized
 * request body, so the following numbers are direct measurements of what the
 * program actually does:
 *
 *   - requests, by pipeline stage (session / memory / supplement / repair /
 *     digest / final / provider test);
 *   - request bytes, content bytes and fixed-overhead bytes per request;
 *   - byte-identical repeated requests (the objective part of "duplicate input");
 *   - batches planned, viewers covered, facts saved, validation rejections;
 *   - wall-clock duration.
 *
 * Token counts are SIMULATED, never measured: no tokenizer and no paid provider
 * is involved. The mock reports
 *       inputTokens  = ceil(requestBodyBytes / 3.2)
 *       outputTokens = ceil(answerTextBytes / 3.2)
 * and the same deterministic rule is applied to the "before" and "after" runs,
 * so a difference in simulated tokens is a real difference in bytes sent. The
 * absolute token numbers must not be quoted as provider usage.
 *
 * The provider-reported usage that LiveMemory itself stores (`ai_jobs.usage_json`)
 * is compared against the simulated totals as a cross-check that every billable
 * request was attributed.
 *
 * No production database, no real API key, no network: everything runs against a
 * throwaway `tests/.tmp` data directory with a synthetic dataset.
 */

import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {getJob, listJobBatches} from '../src/storage/repositories/ai-jobs.mjs';
import {listResults} from '../src/storage/repositories/ai-results.mjs';
import {computeJobStatus} from '../src/ai/tasks/status.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return argv[index + 1] ?? fallback;
}
const label = arg('label', new Date().toISOString().replace(/[:.]/g, '-'));
const only = (arg('only', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const jsonPath = arg('json', join('tests', '.tmp', 'ai-efficiency', `${label}.json`));

/** Deterministic simulated-token rule. Documented, not a tokenizer. */
const BYTES_PER_TOKEN = 3.2;
const simTokens = (bytes) => (bytes > 0 ? Math.ceil(bytes / BYTES_PER_TOKEN) : 0);

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Deterministic synthetic data
// ---------------------------------------------------------------------------

const WORDS = [
  '絵を描くのが好き', 'ギターを練習中', '今日は仕事が忙しい', '猫を飼っています',
  'ゲームの配信を見るのが趣味', '東京から見ています', '料理を作りました',
  'I just moved to Osaka', 'This stream is relaxing', 'first time here',
  'おすすめの本ありますか', 'ラーメン食べたい', '推しが歌うと泣く',
  'I play the piano', 'learning Japanese', '今日もおつかれさま'
];

function messageFor(index, viewerIndex) {
  const word = WORDS[(index + viewerIndex * 3) % WORDS.length];
  return `${word} #${index}`;
}

/**
 * Seed a synthetic session. `plan` describes the audience shape so scenarios can
 * model sparse, dense, skewed and multilingual chats without touching real data.
 */
function seedSession(db, {
  id,
  viewers = 25,
  messages = 200,
  activity = 'uniform',
  denseViewers = null,
  locale = 'zh-CN',
  messagesPerViewerCap = 400
}) {
  upsertBroadcaster(db, {
    id: 'youtube:UC_EFFICIENCY_TEST',
    platform: 'youtube',
    platformUid: 'UC_EFFICIENCY_TEST',
    displayName: 'Efficiency Test Broadcaster',
    identity: 'verified',
    seenAt: T0,
    now: T0
  });
  const session = createSession(db, {
    id,
    platform: 'youtube',
    platformRoomId: `eff-room-${id}`,
    roomTitle: `Efficiency ${id}`,
    broadcasterName: 'Efficiency Test Broadcaster',
    broadcasterId: 'youtube:UC_EFFICIENCY_TEST',
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt: T0
  });
  const ingest = new EventIngest({db});
  // Per-viewer message counts. `skewed` puts almost all chat on a few viewers,
  // which is the shape that wastes the most per-viewer request overhead.
  const counts = new Array(viewers).fill(0);
  if (activity === 'skewed') {
    const hot = Math.max(1, denseViewers ?? Math.ceil(viewers * 0.05));
    const hotShare = 0.85;
    const hotTotal = Math.round(messages * hotShare);
    for (let index = 0; index < hotTotal; index += 1) counts[index % hot] += 1;
    const rest = messages - hotTotal;
    for (let index = 0; index < rest; index += 1) {
      const at = hot + (index % Math.max(1, viewers - hot));
      if (at < counts.length) counts[at] += 1;
    }
  } else {
    for (let index = 0; index < messages; index += 1) counts[index % viewers] += 1;
  }
  let seq = 0;
  for (let viewerIndex = 0; viewerIndex < viewers; viewerIndex += 1) {
    const count = Math.min(counts[viewerIndex], messagesPerViewerCap);
    for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
      seq += 1;
      ingest.record({
        session_id: session.id,
        platform: 'youtube',
        event_type: 'chat',
        viewer_uid: `UC_EFF_${viewerIndex}`,
        display_name: `Viewer ${viewerIndex} ${locale === 'ja' ? 'さん' : ''}`.trim(),
        occurred_at: T0 + seq * 1000,
        content: messageFor(seq, viewerIndex),
        external_id: `eff-${id}-${seq}`,
        source_quality: 'mock'
      });
    }
  }
  endSession(db, session.id, {
    status: 'ended',
    endedAt: T0 + (seq + 2) * 1000,
    reason: 'adapter_end'
  });
  return session;
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/**
 * Stage classification from the real prompt text. These markers are the same
 * ones the runner and the existing integration tests rely on.
 */
function classify(text) {
  if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
    if (/Return the missing viewers only\./.test(text)) return 'memory-supplement';
    if (/MEMORY EVIDENCE GUARD/.test(text)) return 'memory-repair';
    return 'memory';
  }
  if (text.includes('AGGREGATE MERGE CONTRACT')) return 'session-final';
  if (text.includes('PARTIAL DIGEST CONTRACT')) return 'session-digest';
  if (text.includes('AUTOMATIC PROVIDER MODE')) return 'session';
  return 'other';
}

/**
 * Parse the ref table from the prompt's canonical `memory_context.json` block.
 * (The prompt no longer repeats it in a second "ref N: ..." list.)
 */
function parseRefs(text) {
  const marker = text.indexOf('## memory_context.json');
  if (marker < 0) return new Map();
  const rest = text.slice(marker);
  const afterHeader = rest.slice(rest.indexOf('\n') + 1);
  const nextBlock = afterHeader.indexOf('\n\n## ');
  const jsonText = (nextBlock < 0 ? afterHeader : afterHeader.slice(0, nextBlock)).trim();
  let context;
  try {
    context = JSON.parse(jsonText);
  } catch {
    return new Map();
  }
  const refs = new Map();
  for (const viewer of context?.viewers ?? []) {
    if (!Number.isInteger(Number(viewer?.ref))) continue;
    refs.set(Number(viewer.ref), {
      ref: Number(viewer.ref),
      evidence: Array.isArray(viewer.evidence_seqs) ? viewer.evidence_seqs : [],
      zeroExcerpt: viewer.zero_excerpt === true
    });
  }
  return refs;
}

/**
 * Split the user prompt into its `## <name>` sections and measure each. This is
 * the only way to attribute input bytes to "fixed instruction overhead" versus
 * "actual chat/excerpt content" without reading prompt text into the report.
 */
function measureBlocks(text) {
  const src = String(text ?? '');
  const blocks = {};
  const BARE_MARKERS = ['AUTOMATIC MEMORY CONTRACT', 'MEMORY EVIDENCE GUARD'];
  let current = '__preamble';
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const bytes = Buffer.byteLength(`${buffer.join('\n')}\n`, 'utf8');
    blocks[current] = (blocks[current] ?? 0) + bytes;
    buffer = [];
  };
  for (const line of src.split('\n')) {
    const header = /^## (.+)$/.exec(line);
    if (header) {
      flush();
      current = header[1].trim().slice(0, 60) || '(unnamed)';
      buffer.push(line);
      continue;
    }
    const bare = BARE_MARKERS.find((marker) => line.startsWith(marker));
    if (bare) {
      flush();
      current = `${bare} (no header)`;
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** A deterministic, schema-valid session batch answer with real evidence refs. */
function sessionAnswer({refSeq = 1} = {}) {
  return {
    session_topics: {
      summary: 'Synthetic batch summary for the efficiency baseline.',
      topics: [{
        title: 'Synthetic batch topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'A topic observed in this batch.',
        key_points: ['one point'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [refSeq]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
}

function aggregateAnswer(batchTotal) {
  const topics = [];
  const topicCount = Math.min(24, Math.max(1, Math.ceil(batchTotal / 4)));
  const chunkSize = Math.max(1, Math.ceil(batchTotal / topicCount));
  for (let batch = 1; batch <= batchTotal; batch += chunkSize) {
    const chunk = [];
    for (let index = batch; index < Math.min(batchTotal + 1, batch + chunkSize); index += 1) {
      chunk.push({batch: index, seq: 1});
    }
    topics.push({
      title: `Merged topic ${batch}-${chunk[chunk.length - 1].batch}`,
      started_at: iso(T0 + 1000),
      ended_at: iso(T0 + 2000),
      summary: 'One merged topic.',
      key_points: ['merged'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: chunk
    });
  }
  return {
    covered_batches: Array.from({length: batchTotal}, (_unused, index) => index + 1),
    session_topics: {
      summary: 'Merged whole-session summary.',
      topics,
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
}

/**
 * Memory answer: one update per ref, one stated fact per viewer that actually
 * has an excerpt. This is deliberately modest (no fact inflation) so the
 * "facts per 100 viewers" metric is not gamed.
 */
function memoryAnswer(refs) {
  const viewers = [];
  for (const entry of refs.values()) {
    if (entry.zeroExcerpt || entry.evidence.length === 0) {
      viewers.push({ref: entry.ref, memory: {no_new_information: true, operations: []}});
      continue;
    }
    viewers.push({
      ref: entry.ref,
      memory: {
        summary: `Synthetic long-term summary for ref ${entry.ref}.`,
        summary_certainty: 'stated',
        no_new_information: false,
        operations: [{
          op: 'add',
          kind: 'interest',
          topic: `topic-${entry.ref}`,
          statement: `Synthetic stated fact for ref ${entry.ref}.`,
          certainty: 'stated',
          confidence: 0.9,
          evidence: [entry.evidence[0]]
        }]
      }
    });
  }
  return {viewers};
}

function jsonResponse(content, {input, output, finishReason = 'stop'} = {}) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Response.json({
    model: 'mock-efficiency-model',
    choices: [{message: {content: text}, finish_reason: finishReason}],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output
    }
  });
}

/**
 * Build the fetch implementation plus a recorder.
 *
 * `anomaly` may return one of:
 *   {kind:'status', status, headers}  → HTTP error
 *   {kind:'empty'}                    → 200 with no assistant content
 *   {kind:'truncate'}                 → finish_reason=length with partial text
 *   {kind:'omit-ref', viewerOffset}   → drop one ref (exercises the supplement)
 */
function createMock({anomaly = null} = {}) {
  const calls = [];
  const seen = new Map();
  let ordinal = 0;
  const fetchImpl = async (url, options) => {
    ordinal += 1;
    try {
      return await respond(url, options);
    } catch (error) {
      if (process.env.LM_EFF_DEBUG) {
        process.stderr.write(`mock failure #${ordinal}: ${error?.stack ?? error}\n`);
      }
      throw error;
    }
  };
  const respond = async (url, options) => {
    const raw = String(options?.body ?? '');
    const bodyBytes = Buffer.byteLength(raw, 'utf8');
    const body = JSON.parse(raw);
    const systemBytes = (body.messages ?? [])
      .filter((message) => message.role === 'system')
      .reduce((total, message) => total + Buffer.byteLength(String(message.content ?? ''), 'utf8'), 0);
    const text = (body.messages ?? []).map((message) => message.content).join('\n');
    const userText = (body.messages ?? [])
      .map((message) => message.content)
      .join('\n');
    const stage = classify(text);
    const hash = createHash('sha256').update(raw).digest('hex');
    const previous = seen.get(hash);
    seen.set(hash, (previous ?? 0) + 1);
    const record = {
      ordinal,
      stage,
      bodyBytes,
      systemBytes,
      userBytes: bodyBytes - systemBytes,
      // Bytes actually sent, and the deterministic simulated input tokens for
      // them. Set for *every* attempt, including attempts that fail.
      sentInputTokens: simTokens(bodyBytes),
      billedInputTokens: 0,
      billedOutputTokens: 0,
      billed: false,
      blocks: measureBlocks(userText),
      blockTotalBytes: null,
      duplicateOfEarlierRequest: previous !== undefined,
      outcome: null
    };
    record.blockTotalBytes = Object.values(record.blocks)
      .reduce((total, value) => total + value, 0);
    calls.push(record);

    const bill = (input, output) => {
      record.billed = true;
      record.billedInputTokens = Math.max(0, Number(input) || 0);
      record.billedOutputTokens = Math.max(0, Number(output) || 0);
    };

    const injected = anomaly ? anomaly({ordinal, stage, text, body, record}) : null;
    if (injected?.kind === 'status') {
      const status = injected.status;
      const payload = JSON.stringify({error: {message: `injected ${status}`, type: 'mock'}});
      record.outcome = `http-${status}`;
      return new Response(payload, {
        status,
        headers: {'content-type': 'application/json', ...(injected.headers ?? {})}
      });
    }
    if (injected?.kind === 'empty') {
      record.outcome = 'empty';
      bill(simTokens(bodyBytes), 0);
      return jsonResponse('', {input: record.billedInputTokens, output: 0});
    }
    if (injected?.kind === 'truncate') {
      record.outcome = 'truncated';
      const partial = '{"viewers":[';
      bill(simTokens(bodyBytes), simTokens(Buffer.byteLength(partial, 'utf8')));
      return jsonResponse(partial, {
        input: record.billedInputTokens,
        output: record.billedOutputTokens,
        finishReason: 'length'
      });
    }

    let answer;
    if (stage === 'session-final' || stage === 'session-digest') {
      const total = Number((/batches: (\d+)/.exec(text) ?? [])[1] ?? 1);
      const coverage = /(?:coverage ledger \(exactly these batches\)|batch coverage \(all batches must be represented\))\n([\s\S]*?)\n## /.exec(text)?.[1] ?? '';
      const covered = [...coverage.matchAll(/^- batch (\d+):/gm)].map((match) => Number(match[1]));
      const count = covered.length > 0 ? Math.max(...covered) : total;
      answer = aggregateAnswer(Math.max(1, count));
    } else if (stage === 'memory' || stage === 'memory-repair' || stage === 'memory-supplement') {
      const refs = parseRefs(text);
      answer = memoryAnswer(refs);
      if (injected?.kind === 'omit-ref' && stage === 'memory') {
        const keys = [...refs.keys()];
        const victim = keys[keys.length - 1];
        answer.viewers = answer.viewers.filter((entry) => entry.ref !== victim);
        record.outcome = 'omitted-ref';
      }
    } else {
      answer = sessionAnswer();
    }

    const answerText = JSON.stringify(answer);
    bill(simTokens(bodyBytes), simTokens(Buffer.byteLength(answerText, 'utf8')));
    record.outcome = record.outcome ?? 'ok';
    return jsonResponse(answer, {
      input: record.billedInputTokens,
      output: record.billedOutputTokens
    });
  };
  return {fetchImpl, calls};
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

function tempDir(prefix) {
  const root = join(process.cwd(), 'tests', '.tmp', 'ai-efficiency');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, `${prefix}-`));
  return {
    dir,
    cleanup() { rmSync(dir, {recursive: true, force: true}); }
  };
}

async function waitForTerminal(runner, sessionId, {timeoutMs = 180000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (!['idle', 'running'].includes(status.status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for terminal status: ${JSON.stringify(status)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function makeConfig(server, {
  concurrency = 3,
  pricing = true,
  modelId = 'mock-efficiency-model',
  providerId = 'custom',
  regionId = 'custom',
  baseUrl = 'https://example.com/v1'
} = {}) {
  const config = server.providerConfigStore.create({
    providerId,
    regionId,
    baseUrl,
    modelId,
    apiKey: 'test-key-not-a-real-credential',
    pricingStatus: pricing ? 'paid' : 'unknown',
    ...(pricing ? {pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}} : {}),
    concurrency
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true,
      auth: true,
      text: true,
      json: true,
      session: true,
      memory: true,
      structuredOutputs: true,
      testedAt: new Date().toISOString()
    },
    stages: {}
  });
  return config;
}

function countFacts(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n;
}

function countDuplicateFacts(db) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT memory_id, dedupe_key, COUNT(*) AS c
      FROM memory_facts GROUP BY memory_id, dedupe_key HAVING c > 1
    )
  `).get().n;
}

function collectUsage(db, sessionId) {
  const jobs = db.prepare('SELECT id, analysis_mode, usage_json, batch_total FROM ai_jobs WHERE session_id = ?')
    .all(sessionId);
  const rows = jobs.map((row) => ({
    jobId: row.id,
    mode: row.analysis_mode,
    batchTotal: row.batch_total,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null
  }));
  return rows;
}

async function runScenario(name, spec) {
  const temp = tempDir(name);
  const mock = createMock({anomaly: spec.anomaly ?? null});
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: mock.fetchImpl,
      // Deterministic: no exponential jitter, no transport retries unless the
      // scenario explicitly asks for them.
      maxRetries: spec.maxRetries ?? 2,
      random: () => 0.5
    }
  });
  const startedAt = Date.now();
  try {
    const session = seedSession(server.db, spec.seed);
    const config = makeConfig(server, {
      concurrency: spec.concurrency ?? 3,
      ...(spec.provider ?? {})
    });
    let status = null;
    const phases = [];

    const runPhase = async (labelPhase, action) => {
      const before = mock.calls.length;
      await action();
      const phaseStatus = await waitForTerminal(server.analysisRunner, session.id);
      phases.push({
        phase: labelPhase,
        requests: mock.calls.length - before,
        status: phaseStatus.status
      });
      return phaseStatus;
    };

    if (spec.phases && spec.phases.length > 0) {
      status = await runPhase('initial', () => spec.phases[0]({server, session, config}));
      for (let index = 1; index < spec.phases.length; index += 1) {
        status = await runPhase(`phase-${index + 1}`, () => spec.phases[index]({server, session, config, status}));
      }
    } else {
      status = await runPhase('initial', () => server.analysisRunner.start({
        sessionId: session.id,
        locale: spec.locale ?? 'zh-CN',
        mode: spec.mode ?? 'memory',
        configId: config.id,
        consent: true
      }));
    }

    const elapsedMs = Date.now() - startedAt;
    const facts = countFacts(server.db);
    const jobUsages = collectUsage(server.db, session.id);
    const results = server.db
      .prepare('SELECT COUNT(*) AS n FROM ai_results WHERE session_id = ?')
      .get(session.id).n;
    const memoryJobRow = jobUsages.find((row) => row.mode === 'memory') ?? null;
    const sessionJobRow = jobUsages.find((row) => row.mode === 'session') ?? null;
    const memoryJob = memoryJobRow ? getJob(server.db, memoryJobRow.jobId) : null;
    const sessionJob = sessionJobRow ? getJob(server.db, sessionJobRow.jobId) : null;
    const memoryStatus = memoryJob ? computeJobStatus(server.db, memoryJob) : null;
    const coverage = memoryStatus?.memoryCoverage ?? null;
    const batches = sessionJob ? listJobBatches(server.db, sessionJob.id) : [];

    return summarize({
      name,
      spec,
      mock,
      status,
      phases,
      elapsedMs,
      facts,
      duplicateFacts: countDuplicateFacts(server.db),
      results,
      coverage,
      memoryJobRow,
      sessionJobRow,
      sessionBatchTotal: sessionJob?.batchTotal ?? 0,
      memoryBatchTotal: memoryJob?.batchTotal ?? 0,
      sessionBatches: batches.length,
      sessionId: session.id
    });
  } finally {
    await server.close();
    temp.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function summarize({
  name,
  spec,
  mock,
  status,
  phases,
  elapsedMs,
  facts,
  duplicateFacts,
  results,
  coverage,
  memoryJobRow,
  sessionJobRow,
  sessionBatchTotal,
  memoryBatchTotal,
  sessionId
}) {
  const calls = mock.calls;
  const byStage = new Map();
  for (const call of calls) {
    const entry = byStage.get(call.stage) ?? {
      stage: call.stage,
      requests: 0,
      bodyBytes: 0,
      systemBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      billedInputTokens: 0,
      billedOutputTokens: 0,
      fixedBytes: 0,
      contentBytes: 0
    };
    entry.requests += 1;
    entry.bodyBytes += call.bodyBytes;
    entry.systemBytes += call.systemBytes;
    entry.inputTokens += call.sentInputTokens ?? 0;
    entry.outputTokens += call.billedOutputTokens ?? 0;
    entry.billedInputTokens += call.billedInputTokens ?? 0;
    entry.billedOutputTokens += call.billedOutputTokens ?? 0;
    byStage.set(call.stage, entry);
  }
  const totalBodyBytes = calls.reduce((total, call) => total + call.bodyBytes, 0);
  const totalSystemBytes = calls.reduce((total, call) => total + call.systemBytes, 0);
  // "Sent" = bytes actually transmitted (including attempts the provider
  // rejected). "Billed" = responses that carried a usage block.
  const sentInputTokens = calls.reduce((total, call) => total + (call.sentInputTokens ?? 0), 0);
  const totalInputTokens = calls.reduce((total, call) => total + (call.billedInputTokens ?? 0), 0);
  const totalOutputTokens = calls.reduce((total, call) => total + (call.billedOutputTokens ?? 0), 0);
  const duplicateBytes = calls
    .filter((call) => call.duplicateOfEarlierRequest)
    .reduce((total, call) => total + call.bodyBytes, 0);
  const retryAttempts = calls.filter((call) => call.duplicateOfEarlierRequest
    || (call.stage ?? '').includes('repair')
    || (call.stage ?? '').includes('supplement'));
  const retryRequests = retryAttempts.length;
  const retryTokens = retryAttempts
    .reduce((total, call) => total + (call.sentInputTokens ?? 0) + (call.billedOutputTokens ?? 0), 0);

  // Fixed (repeatable) prompt bytes versus per-request content bytes. The block
  // names come from the real prompt structure; `viewer_excerpts.jsonl`,
  // `messages.jsonl`, `memory_context.json[...]` and `batch_results` are content.
  const CONTENT_BLOCK = /viewer_excerpts|messages\.jsonl|memory_context|batch_results|partial_reports|batch coverage|coverage ledger/;
  const blockTotals = {};
  let fixedBytes = 0;
  let contentBytes = 0;
  for (const call of calls) {
    for (const [name, bytes] of Object.entries(call.blocks ?? {})) {
      blockTotals[name] = (blockTotals[name] ?? 0) + bytes;
      if (CONTENT_BLOCK.test(name)) contentBytes += bytes;
      else fixedBytes += bytes;
    }
    fixedBytes += call.systemBytes;
  }

  const retryAndRecovery = {
    repair: calls.filter((call) => (call.stage ?? '').includes('repair')).length,
    supplement: calls.filter((call) => (call.stage ?? '').includes('supplement')).length,
    transportRetries: calls.filter((call) => call.duplicateOfEarlierRequest).length
  };

  // Program-reported usage: the number LiveMemory itself persisted.
  const reportedInput = (memoryJobRow?.usage?.inputTokens ?? 0) + (sessionJobRow?.usage?.inputTokens ?? 0);
  const reportedOutput = (memoryJobRow?.usage?.outputTokens ?? 0) + (sessionJobRow?.usage?.outputTokens ?? 0);
  const reportedRequests = (memoryJobRow?.usage?.requests ?? 0) + (sessionJobRow?.usage?.requests ?? 0);

  const viewersCovered = coverage?.covered ?? null;
  const viewersTotal = coverage?.total ?? null;
  const coverageRate = viewersTotal ? viewersCovered / viewersTotal : null;
  const errorCodes = [];
  const latestError = status?.error?.code ?? null;
  if (latestError) errorCodes.push(latestError);
  for (const entry of status?.batchErrors ?? []) errorCodes.push(entry.code);
  const billedTotal = totalInputTokens + totalOutputTokens;

  return {
    name,
    description: spec.description ?? '',
    status: status?.status ?? null,
    errorCodes,
    report: {
      batchTotal: memoryBatchTotal || sessionBatchTotal,
      sessionBatchTotal,
      memoryBatchTotal,
      requests: calls.length,
      requestsByStage: Object.fromEntries([...byStage.entries()].map(([stage, entry]) => [stage, entry.requests])),
      stageDetail: [...byStage.values()],
      requestBytes: totalBodyBytes,
      systemPromptBytes: totalSystemBytes,
      fixedBytes,
      contentBytes,
      fixedShare: totalBodyBytes > 0 ? Number((fixedBytes / totalBodyBytes).toFixed(4)) : 0,
      blockTotals,
      sentInputTokens,
      simulatedInputTokens: totalInputTokens,
      simulatedOutputTokens: totalOutputTokens,
      simulatedTotalTokens: billedTotal,
      duplicateRequestBytes: duplicateBytes,
      duplicateShare: totalBodyBytes > 0 ? duplicateBytes / totalBodyBytes : 0,
      retryRequests,
      retryTokens,
      retryTokenShare: billedTotal > 0 ? retryTokens / billedTotal : 0,
      retryAndRecovery,
      reportedInputTokens: reportedInput,
      reportedOutputTokens: reportedOutput,
      reportedRequests,
      unattributedRequests: calls.length - reportedRequests,
      viewersTotal,
      viewersCovered,
      coverageRate,
      facts,
      duplicateFacts,
      results,
      tokensPer100Viewers: viewersCovered > 0
        ? Math.round((billedTotal / viewersCovered) * 100)
        : null,
      tokensPer100Facts: facts > 0
        ? Math.round((billedTotal / facts) * 100)
        : null,
      requestsPer100Viewers: viewersCovered > 0
        ? Number(((calls.length / viewersCovered) * 100).toFixed(2))
        : null,
      elapsedMs,
      estimatedCostUsd: estimateCostUsd(totalInputTokens, totalOutputTokens),
      sessionId
    },
    phases
  };
}

/** Cost from the simulated tokens and the fixture price (1 / 2 USD per Mtok). */
function estimateCostUsd(input, output) {
  const amount = (input / 1_000_000) * 1 + (output / 1_000_000) * 2;
  return Number(amount.toFixed(6));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function anomalyByOrdinal(map) {
  return ({ordinal, stage}) => {
    const rule = map[ordinal];
    if (!rule) return null;
    if (rule.stage && rule.stage !== stage) return null;
    return rule.kind;
  };
}

const SCENARIOS = [
  {
    name: 's1-small-25-viewers',
    description: '小场次：25 位观众、200 条消息、长期画像',
    mode: 'memory',
    seed: {id: 'ses_eff_s1', viewers: 25, messages: 200, locale: 'zh-CN'}
  },
  {
    name: 's2-medium-100-viewers',
    description: '中场次：100 位观众、1000 条消息、长期画像',
    mode: 'memory',
    seed: {id: 'ses_eff_s2', viewers: 100, messages: 1000, locale: 'zh-CN'}
  },
  {
    name: 's3-large-1000-viewers',
    description: '大场次：1000 位观众、6000 条消息、长期画像',
    mode: 'memory',
    seed: {id: 'ses_eff_s3', viewers: 1000, messages: 6000, locale: 'zh-CN'}
  },
  {
    name: 's4-dense-chat',
    description: '高消息密度：40 位观众、6000 条消息（人均 150 条）',
    mode: 'memory',
    seed: {id: 'ses_eff_s4', viewers: 40, messages: 6000, locale: 'ja'}
  },
  {
    name: 's5-skewed-activity',
    description: '少量高活跃 + 大量低活跃：100 位观众、其中 5 人占 85% 发言',
    mode: 'memory',
    seed: {id: 'ses_eff_s5', viewers: 100, messages: 2000, activity: 'skewed', denseViewers: 5, locale: 'zh-CN'}
  },
  {
    name: 's6-multilingual',
    description: '多语言弹幕：60 位观众、1200 条消息、输出语言 ja',
    mode: 'memory',
    locale: 'ja',
    seed: {id: 'ses_eff_s6', viewers: 60, messages: 1200, locale: 'ja'}
  },
  {
    name: 's7-session-report',
    description: '单场直播报告：300 位观众、3000 条消息、多批 + 汇总',
    mode: 'session',
    seed: {id: 'ses_eff_s7', viewers: 300, messages: 3000, locale: 'zh-CN'}
  },
  {
    name: 's8-speech-slash-both-baseline',
    description: '单场 + 长期画像（both）：80 位观众、800 条消息',
    mode: 'both',
    seed: {id: 'ses_eff_s8', viewers: 80, messages: 800, locale: 'zh-CN'}
  },
  {
    name: 's9-resume-after-failure',
    description: '部分失败后 Resume：100 位观众，第 2 个请求注入 500 后继续',
    mode: 'memory',
    maxRetries: 0,
    seed: {id: 'ses_eff_s9', viewers: 100, messages: 1000, locale: 'zh-CN'},
    anomaly: anomalyByOrdinal({2: {kind: {kind: 'status', status: 500}}}),
    phases: [
      ({server, session, config}) => server.analysisRunner.start({
        sessionId: session.id,
        locale: 'zh-CN',
        mode: 'memory',
        configId: config.id,
        consent: true
      }),
      ({server, session}) => server.analysisRunner.resume(session.id, {consent: true})
    ]
  },
  {
    name: 's10-anomalies',
    description: '异常响应：空响应 / 截断 / 429 / 500 各注入一次后自动恢复',
    mode: 'memory',
    maxRetries: 2,
    seed: {id: 'ses_eff_s10', viewers: 60, messages: 600, locale: 'zh-CN'},
    anomaly: anomalyByOrdinal({
      2: {kind: {kind: 'empty'}, stage: 'memory'},
      4: {kind: {kind: 'truncate'}, stage: 'memory'},
      6: {kind: {kind: 'status', status: 429, headers: {'retry-after': '0'}}, stage: 'memory'},
      8: {kind: {kind: 'status', status: 500}, stage: 'memory'}
    })
  },
  {
    name: 's11-omitted-viewer-supplement',
    description: '首答漏写 1 位观众：定向补答路径',
    mode: 'memory',
    seed: {id: 'ses_eff_s11', viewers: 20, messages: 200, locale: 'zh-CN'},
    anomaly: ({ordinal, stage, record}) => {
      if (ordinal === 1 && stage === 'memory') {
        record.outcome = 'omitted-ref';
        return {kind: 'omit-ref'};
      }
      return null;
    }
  },
  {
    name: 's12-no-history-resume-complete',
    description: '已完成后再次 Continue：必须 0 请求',
    mode: 'memory',
    seed: {id: 'ses_eff_s12', viewers: 30, messages: 300, locale: 'zh-CN'},
    phases: [
      ({server, session, config}) => server.analysisRunner.start({
        sessionId: session.id,
        locale: 'zh-CN',
        mode: 'memory',
        configId: config.id,
        consent: true
      }),
      ({server, session}) => server.analysisRunner.resume(session.id, {consent: true})
    ]
  },
  {
    // OpenAI/OpenRouter are the only catalog providers with a verified
    // `response_format: json_schema` path. For them the textual schema block is a
    // duplicate of the machine-enforced schema, so it is not sent twice.
    name: 's13-openai-structured-memory',
    description: '已校验 structured outputs 的 Provider（openai）长期画像：100 位观众',
    mode: 'memory',
    provider: {providerId: 'openai', regionId: 'global', baseUrl: 'https://api.openai.com/v1'},
    seed: {id: 'ses_eff_s13', viewers: 100, messages: 1000, locale: 'zh-CN'}
  },
  {
    name: 's14-openai-structured-session',
    description: '已校验 structured outputs 的 Provider（openai）单场报告：300 位观众',
    mode: 'session',
    provider: {providerId: 'openai', regionId: 'global', baseUrl: 'https://api.openai.com/v1'},
    seed: {id: 'ses_eff_s14', viewers: 300, messages: 3000, locale: 'zh-CN'}
  }
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function formatTable(results) {
  const header = '| 场景 | 请求 | 批次 | 观众覆盖 | 事实 | 输入 Token(模拟) | 输出 Token(模拟) | 重试/补答 Token | 重复输入占比 | 每百观众 Token | 每百事实 Token | 耗时 ms |';
  const rule = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = results.map((entry) => {
    const r = entry.report;
    return `| ${entry.name} | ${r.requests} | ${r.batchTotal} | ${r.viewersCovered ?? '-'}/${r.viewersTotal ?? '-'} | ${r.facts} | ${r.simulatedInputTokens} | ${r.simulatedOutputTokens} | ${r.retryTokens} | ${(r.duplicateShare * 100).toFixed(1)}% | ${r.tokensPer100Viewers ?? '-'} | ${r.tokensPer100Facts ?? '-'} | ${r.elapsedMs} |`;
  });
  return [header, rule, ...rows].join('\n');
}

const selected = only.length > 0
  ? SCENARIOS.filter((scenario) => only.some((token) => scenario.name === token
    || scenario.name.startsWith(`${token}-`)))
  : SCENARIOS;

const results = [];
for (const scenario of selected) {
  process.stderr.write(`running ${scenario.name} ...\n`);
  try {
    const result = await runScenario(scenario.name, scenario);
    results.push(result);
    process.stderr.write(`  ${scenario.name}: status=${result.status} requests=${result.report.requests} `
      + `tokens=${result.report.simulatedTotalTokens} facts=${result.report.facts}\n`);
  } catch (error) {
    results.push({
      name: scenario.name,
      description: scenario.description,
      status: 'harness-error',
      error: error?.stack ?? String(error),
      report: null
    });
    process.stderr.write(`  ${scenario.name}: harness error ${error?.message ?? error}\n`);
  }
}

const payload = {
  label,
  generatedAt: new Date().toISOString(),
  measurement: {
    tokenSource: 'simulated',
    rule: `input=ceil(requestBodyBytes/${BYTES_PER_TOKEN}), output=ceil(answerBytes/${BYTES_PER_TOKEN})`,
    requestBytes: 'measured',
    requests: 'measured',
    facts: 'measured from sqlite',
    note: 'No real provider, no tokenizer. Token values are deterministic simulations of the measured bytes.'
  },
  results
};

mkdirSync(join(process.cwd(), 'tests', '.tmp', 'ai-efficiency'), {recursive: true});
writeFileSync(resolve(jsonPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

process.stdout.write(`\n# AI token-efficiency baseline — ${label}\n\n`);
process.stdout.write(`${formatTable(results)}\n\n`);
process.stdout.write(`JSON: ${resolve(jsonPath)}\n`);

const failed = results.filter((entry) => !entry.report || entry.status === 'harness-error');
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length} scenario(s) did not produce metrics.\n`);
  process.exitCode = 1;
}
