/**
 * RC0-AI-EFFICIENCY formal EXE verification.
 *
 * Proves, against the packaged binary and isolated data directories:
 *   1. an AI long-term-profile analysis runs end to end through the real
 *      runner/validator/importer inside the EXE;
 *   2. provider-reported token usage (including cache-hit tokens) is stored in
 *      `ai_jobs.usage_json` and exposed as `status.efficiency`;
 *   3. a failed attempt is attributed (failed / retried / unknown usage) instead
 *      of disappearing from the accounting;
 *   4. Resume re-requests only the unfinished batch and never re-bills a batch
 *      whose result was already saved; a repeated Continue after completion
 *      sends zero requests;
 *   5. local API authentication still protects the AI endpoints;
 *   6. a portable `.livememory` backup can still be created.
 *
 * The provider is a local OpenAI-compatible HTTP server started by this script.
 * No API key, no network and no real paid provider is used; answers are
 * synthetic fixtures. This is a packaged-binary + local-mock verification, not a
 * real-provider acceptance test.
 *
 * Usage: node scripts/verify-ai-token-exe.mjs [path/to/LiveMemory.exe]
 */

import {spawn} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, seedSession, T0, parsePromptMemoryRefs} from '../tests/helpers/ai-fixtures.mjs';
import {manifestLevel} from './pe-manifest.mjs';

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `ai-token-exe-${stamp}`);
const bootstrapFile = join(root, 'bootstrap.url');
mkdirSync(root, {recursive: true});

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (line) => process.stdout.write(`[ai-token-exe] ${line}\n`);

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function waitFor(check, {timeout = 60000, interval = 250, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => resolvePort(chosen));
    });
  });
}

// ---------------------------------------------------------------------------
// Local OpenAI-compatible fake provider
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();

function sessionAnswer() {
  return {
    session_topics: {
      summary: 'Synthetic batch summary (EXE verification).',
      topics: [{
        title: 'Synthetic topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'A topic observed in this batch.',
        key_points: ['one point'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
}

function aggregateAnswer(batches) {
  const topics = [];
  for (let batch = 1; batch <= batches; batch += 1) {
    topics.push({
      title: `Merged topic ${batch}`,
      started_at: iso(T0 + 1000),
      ended_at: iso(T0 + 2000),
      summary: 'Merged.',
      key_points: ['merged'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: [{batch, seq: 1}]
    });
  }
  return {
    covered_batches: Array.from({length: batches}, (_unused, index) => index + 1),
    session_topics: {summary: 'Merged session.', topics, sentiment: [], disputes: [], highlights: []}
  };
}

function memoryAnswer(refs) {
  return {
    viewers: [...refs.values()].map((entry) => (entry.zeroExcerpt || entry.evidence.length === 0
      ? {ref: entry.ref, memory: {no_new_information: true, operations: []}}
      : {
        ref: entry.ref,
        memory: {
          summary: `Synthetic summary for ref ${entry.ref}.`,
          summary_certainty: 'stated',
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: `topic-${entry.ref}`,
            statement: `Synthetic stated fact for ref ${entry.ref}.`,
            confidence: 0.9,
            certainty: 'stated',
            evidence: [entry.evidence[0]]
          }]
        }
      }))
  };
}

function startFakeProvider({port}) {
  const state = {
    requests: [],
    failOnceAt: 0,
    failBatch: null,
    releaseFailBatch: false
  };
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      const bytes = Buffer.byteLength(raw, 'utf8');
      const text = (body.messages ?? []).map((message) => message.content).join('\n');
      const ordinal = state.requests.length + 1;
      const batchId = /- batch_id: "([^"]+)"/.exec(text)?.[1] ?? null;
      const batchNumber = Number(/-b(\d+)$/.exec(batchId ?? '')?.[1] ?? 0);
      const kind = text.includes('AUTOMATIC MEMORY CONTRACT') ? 'memory'
        : (text.includes('AGGREGATE MERGE CONTRACT') ? 'final'
          : (text.includes('PARTIAL DIGEST CONTRACT') ? 'digest' : 'session'));
      const refs = kind === 'memory' ? parsePromptMemoryRefs(text) : null;
      state.requests.push({ordinal, kind, batchId, batchNumber, bytes, refs: refs ? refs.size : null});

      const failThis = (state.failOnceAt && ordinal === state.failOnceAt)
        || (state.failBatch !== null
          && !state.releaseFailBatch
          && kind === 'memory'
          && batchNumber === state.failBatch);
      if (failThis) {
        res.writeHead(500, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: {message: 'injected server error', type: 'mock'}}));
        return;
      }

      let answer;
      if (kind === 'memory') {
        answer = memoryAnswer(refs);
      } else if (kind === 'final' || kind === 'digest') {
        const covered = [...text.matchAll(/^- batch (\d+):/gm)].map((match) => Number(match[1]));
        answer = aggregateAnswer(Math.max(1, covered.length > 0 ? Math.max(...covered) : 1));
      } else {
        answer = sessionAnswer();
      }
      const answerText = JSON.stringify(answer);
      const promptTokens = Math.ceil(bytes / 3.2);
      const cached = Math.floor(promptTokens * 0.4);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        model: 'fake-exe-model',
        choices: [{message: {content: answerText}, finish_reason: 'stop'}],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: Math.ceil(Buffer.byteLength(answerText, 'utf8') / 3.2),
          total_tokens: promptTokens + Math.ceil(Buffer.byteLength(answerText, 'utf8') / 3.2),
          prompt_tokens_details: {cached_tokens: cached}
        }
      }));
    });
  });
  return new Promise((resolveProvider) => {
    server.listen(port, '127.0.0.1', () => resolveProvider({server, state}));
  });
}

// ---------------------------------------------------------------------------
// Seed a data directory: one recorded session + one already-tested provider
// ---------------------------------------------------------------------------

async function seedDataDir({dataDir, fakePort, sessionId, concurrency = 1}) {
  mkdirSync(dataDir, {recursive: true});
  const server = await startServer({auth: false, dataDir, port: 0, systemLocale: 'en'});
  try {
    addBroadcaster(server.db);
    seedSession(server.db, {id: sessionId, messageCount: 120, viewerCount: 40, startedAt: T0});
    const config = server.providerConfigStore.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      modelId: 'fake-exe-model',
      apiKey: 'test-key-not-a-real-credential',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
      allowLocalNetwork: true,
      concurrency
    });
    server.providerConfigStore.recordTest(config.id, {
      status: 'passed',
      capabilities: {
        network: true,
        auth: true,
        text: true,
        json: true,
        structuredOutputs: true,
        session: true,
        memory: true,
        multilingual: true,
        testedAt: new Date().toISOString()
      },
      stages: {},
      usage: {inputTokens: 120, outputTokens: 30, requests: 4, cost: null}
    });
    return {configId: config.id};
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// EXE lifecycle + HTTP helpers
// ---------------------------------------------------------------------------

let port = null;
let child = null;
let exitInfo = null;
let cookie = null;

function headersFor(extra = {}) {
  return cookie ? {cookie, ...extra} : extra;
}

async function json(path, {method = 'GET', body = undefined} = {}) {
  const headers = headersFor();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return {status: response.status, payload};
}

async function launch({dataDir}) {
  port = await freePort();
  cookie = null;
  rmSync(bootstrapFile, {force: true});
  child = spawn(distExe, ['--no-open', '--port', String(port), '--data-dir', dataDir, '--lang', 'en'], {
    cwd: root,
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile},
    stdio: ['ignore', openSync(join(root, 'stdout.log'), 'a'), openSync(join(root, 'stderr.log'), 'a')],
    windowsHide: true
  });
  exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = {code, signal}; });
  await waitFor(async () => {
    if (exitInfo) throw new Error(`EXE exited early: ${JSON.stringify(exitInfo)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1000)});
      return response.ok ? response.json() : null;
    } catch { return null; }
  }, {timeout: 60000, label: 'health'});
}

async function authenticate() {
  const url = await waitFor(() => {
    if (!existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeout: 20000, label: 'bootstrap URL'});
  const token = decodeURIComponent(new URL(url).hash.replace(/^#lm_bootstrap=/, ''));
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token})
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function stop() {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  child.kill('SIGTERM');
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (exitInfo) break;
    await sleep(100);
  }
  if (!exitInfo) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  child = null;
}

async function waitForAnalysis(sessionId, {timeout = 120000} = {}) {
  return waitFor(async () => {
    const status = await json(`/api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (status.status !== 200) return null;
    return ['complete', 'partial', 'failed', 'needs_action', 'canceled'].includes(status.payload.status)
      ? status.payload
      : null;
  }, {timeout, interval: 400, label: 'analysis status'});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let provider = null;
try {
  log(`exe ${distExe}`);
  log(`work ${root}`);
  const manifest = manifestLevel(readFileSync(distExe));
  record('packaged EXE manifest is asInvoker (no UAC elevation)', manifest === 'asInvoker', [
    `manifest: ${manifest}`,
    `sha256 ${sha256File(distExe)}`,
    `bytes ${statSync(distExe).size}`
  ]);

  const fakePort = await freePort();
  provider = await startFakeProvider({port: fakePort});

  // ---- Phase A: happy path ------------------------------------------------
  const dirA = join(root, 'data-a');
  const sessionA = 'ses_ai_token_exe_a';
  const seededA = await seedDataDir({dataDir: dirA, fakePort, sessionId: sessionA});
  await launch({dataDir: dirA});
  const health = await json('/api/health');
  const buildInfo = JSON.parse(readFileSync(join(resolve('build'), 'build-info.json'), 'utf8'));
  record('the EXE launches as the current user and serves /api/health',
    health.status === 200 && health.payload?.buildId === buildInfo.buildId,
    [`buildId ${health.payload?.buildId}`, `commit ${health.payload?.commit}`]);

  const anon = await json(`/api/ai/analyze/status?sessionId=${encodeURIComponent(sessionA)}`);
  record('unauthenticated AI status is rejected', anon.status === 401, [`HTTP ${anon.status}`]);
  await authenticate();

  const started = await json('/api/ai/analyze/run', {
    method: 'POST',
    body: {sessionId: sessionA, locale: 'en', mode: 'memory', configId: seededA.configId, consent: true}
  });
  if (![200, 202].includes(started.status)) {
    throw new Error(`analyze/run failed: HTTP ${started.status} ${JSON.stringify(started.payload)}`);
  }
  const complete = await waitForAnalysis(sessionA);
  const efficiency = complete.efficiency ?? null;
  const memoryRequestsA = provider.state.requests.filter((entry) => entry.kind === 'memory');
  record('AI long-term-profile analysis completes inside the packaged EXE', complete.status === 'complete', [
    `status ${complete.status}`,
    `viewers ${complete.memoryJob?.memoryCoverage?.covered ?? '?'}/${complete.memoryJob?.memoryCoverage?.total ?? '?'}`,
    `batches ${complete.memoryBatchTotal ?? '?'}`,
    `memory requests ${memoryRequestsA.length}`
  ]);
  record('provider-reported token usage is stored for the job',
    Number(complete.usage?.inputTokens ?? 0) > 0 && Number(complete.usage?.outputTokens ?? 0) > 0,
    [`input ${complete.usage?.inputTokens}`, `output ${complete.usage?.outputTokens}`,
      `requests ${complete.usage?.requests}`, `attempts ${complete.usage?.attempts}`]);
  record('cache-hit tokens are recorded separately from fresh input',
    Number(complete.usage?.cachedInputTokens ?? 0) > 0
      && Number(complete.usage.cachedInputTokens) < Number(complete.usage.inputTokens),
    [`cached ${complete.usage?.cachedInputTokens} of ${complete.usage?.inputTokens}`]);
  record('usage source and the per-attempt ledger are exposed',
    efficiency?.tokenSource === 'provider-reported'
      && Number(efficiency?.attempts ?? 0) >= Number(efficiency?.requestsWithUsage ?? 0)
      && efficiency?.estimated === true,
    [`tokenSource ${efficiency?.tokenSource}`, `attempts ${efficiency?.attempts}`,
      `requestsWithUsage ${efficiency?.requestsWithUsage}`, `attemptLedgerTokens ${efficiency?.attemptLedgerTokens}`]);
  record('estimated cost and per-100-viewer metrics derive from reported usage',
    Number(efficiency?.cost?.amount ?? 0) > 0
      && Number(efficiency?.costPer100Viewers ?? 0) > 0
      && Number(efficiency?.tokensPer100Viewers ?? 0) > 0
      && Number(efficiency?.factsSaved ?? 0) > 0,
    [`cost ${efficiency?.cost?.amount} ${efficiency?.cost?.currency}`,
      `costPer100Viewers ${efficiency?.costPer100Viewers}`,
      `tokensPer100Viewers ${efficiency?.tokensPer100Viewers}`,
      `facts ${efficiency?.factsSaved}`]);
  record('each planned memory batch was requested exactly once',
    memoryRequestsA.length === new Set(memoryRequestsA.map((entry) => entry.batchId)).size,
    [`batch ids ${memoryRequestsA.map((entry) => entry.batchId).join(', ')}`]);

  const backupPath = join(root, 'ai-token-backup.livememory');
  const backup = await json('/api/backup/create', {method: 'POST', body: {path: backupPath}});
  const backupJobId = backup.payload?.job?.id ?? null;
  const backupDone = backupJobId
    ? await waitFor(async () => {
      const job = await json(`/api/backup/jobs/${encodeURIComponent(backupJobId)}`);
      const payload = job.payload?.job ?? job.payload ?? null;
      const status = payload?.status ?? null;
      return ['completed', 'failed', 'cancelled'].includes(status) ? payload : null;
    }, {timeout: 60000, label: 'backup job'})
    : null;
  record('a portable .livememory backup can still be created',
    backup.status === 202 && backupDone?.status === 'completed' && existsSync(backupPath),
    [`HTTP ${backup.status}`, `job ${backupDone?.status ?? 'missing'}`,
      `bytes ${existsSync(backupPath) ? statSync(backupPath).size : 0}`]);

  // Repeated Continue after completion must not re-bill anything.
  const beforeResume = provider.state.requests.length;
  const resumeNoop = await json('/api/ai/analyze/resume', {
    method: 'POST',
    body: {sessionId: sessionA, consent: true}
  });
  const afterResume = provider.state.requests.length;
  record('a repeated Continue after completion sends no provider request',
    afterResume === beforeResume,
    [`HTTP ${resumeNoop.status}`, `requests ${beforeResume} → ${afterResume}`]);

  await stop();

  // Restart on the same data directory: the job must still be complete.
  await launch({dataDir: dirA});
  await authenticate();
  const restarted = await json(`/api/ai/analyze/status?sessionId=${encodeURIComponent(sessionA)}`);
  record('the completed task still reports complete after an EXE restart',
    restarted.payload?.status === 'complete'
      && restarted.payload?.memoryJob?.memoryCoverage?.covered === complete.memoryJob.memoryCoverage.covered
      && Number(restarted.payload?.efficiency?.inputTokens ?? 0) === Number(efficiency?.inputTokens ?? 0),
    [`status ${restarted.payload?.status}`,
      `covered ${restarted.payload?.memoryJob?.memoryCoverage?.covered}`,
      `inputTokens ${restarted.payload?.efficiency?.inputTokens}`]);
  await stop();

  // ---- Phase B: failure attribution + resume ------------------------------
  const dirB = join(root, 'data-b');
  const sessionB = 'ses_ai_token_exe_b';
  const seededB = await seedDataDir({dataDir: dirB, fakePort, sessionId: sessionB, concurrency: 3});
  provider.state.requests.length = 0;
  provider.state.failBatch = 2;
  provider.state.releaseFailBatch = false;
  await launch({dataDir: dirB});
  await authenticate();
  const startedB = await json('/api/ai/analyze/run', {
    method: 'POST',
    body: {sessionId: sessionB, locale: 'en', mode: 'memory', configId: seededB.configId, consent: true}
  });
  if (![200, 202].includes(startedB.status)) {
    throw new Error(`phase B analyze/run failed: HTTP ${startedB.status} ${JSON.stringify(startedB.payload)}`);
  }
  const failedB = await waitForAnalysis(sessionB);
  const batchesB = failedB.memoryBatchTotal ?? 0;
  const failedRequests = provider.state.requests.filter((entry) => entry.batchNumber === 2);
  record('a provider failure is attributed instead of disappearing',
    failedB.status !== 'complete'
      && Number(failedB.attemptStats?.failed ?? 0) > 0
      && Number(failedB.efficiency?.unknownUsageAttempts ?? 0) > 0
      && Number(failedB.usage?.attempts ?? 0) > Number(failedB.usage?.requests ?? 0)
      && (failedB.memoryJob?.failedBatches ?? []).includes(2),
    [`status ${failedB.status}`, `failed attempts ${failedB.attemptStats?.failed}`,
      `unknownUsageAttempts ${failedB.efficiency?.unknownUsageAttempts}`,
      `attempts ${failedB.usage?.attempts} vs requests ${failedB.usage?.requests}`,
      `failedBatches ${JSON.stringify(failedB.memoryJob?.failedBatches)}`]);
  record('batch 2 was retried within the bounded attempt policy',
    failedRequests.length >= 2,
    [`batch 2 requests ${failedRequests.length}`]);

  const coveredBefore = failedB.memoryJob?.memoryCoverage?.covered ?? 0;
  const totalBefore = failedB.memoryJob?.memoryCoverage?.total ?? 0;
  record('sibling batches were saved and only the failed batch is pending',
    batchesB >= 2 && totalBefore > coveredBefore && coveredBefore > 0,
    [`covered ${coveredBefore}/${totalBefore}`, `planned batches ${batchesB}`]);

  provider.state.releaseFailBatch = true;
  provider.state.requests.length = 0;
  const resumed = await json('/api/ai/analyze/resume', {method: 'POST', body: {sessionId: sessionB, consent: true}});
  const completeB = await waitForAnalysis(sessionB);
  const resumeRequests = provider.state.requests.filter((entry) => entry.kind === 'memory');
  const resumeBatchIds = [...new Set(resumeRequests.map((entry) => entry.batchId))];
  record('Resume completes the job without re-requesting saved batches',
    resumed.status === 202 || resumed.status === 200
      ? completeB.status === 'complete'
        && completeB.memoryJob?.memoryCoverage?.covered === totalBefore
        && resumeBatchIds.length === 1
        && resumeBatchIds[0]?.endsWith('-b02')
      : false,
    [`HTTP ${resumed.status}`, `status ${completeB.status}`,
      `covered ${completeB.memoryJob?.memoryCoverage?.covered}/${totalBefore}`,
      `resume batches ${resumeBatchIds.join(', ')}`,
      `resume memory requests ${resumeRequests.length}`]);
  await stop();
} finally {
  await stop();
  if (provider?.server) await new Promise((done) => provider.server.close(done));
  const passed = results.filter((entry) => entry.passed).length;
  process.stdout.write(`\n[ai-token-exe] ${passed}/${results.length} checks passed\n`);
  process.stdout.write(`[ai-token-exe] artifacts ${root}\n`);
  if (passed !== results.length) process.exitCode = 1;
}
