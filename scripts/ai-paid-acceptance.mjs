#!/usr/bin/env node
/**
 * P0-3 Phase B — real paid acceptance harness (user-authorized only).
 *
 * This script never ships in the EXE and never runs in tests. It exists so the
 * real-provider run is reproducible and the spend cap is enforced by request
 * count, not by trust.
 *
 * Usage:
 *   node scripts/ai-paid-acceptance.mjs prepare
 *   node scripts/ai-paid-acceptance.mjs serve --dir a --cap 10 --timeout-min 30
 *   node scripts/ai-paid-acceptance.mjs run
 *
 * Flow:
 *   1. `prepare` seeds two identical isolated data directories (`a`, `b`) with
 *      synthetic sessions. It does not touch the production data directory.
 *   2. `serve` starts the console on directory `a`, prints a one-time bootstrap
 *      URL, and waits until the user has created a provider config and passed
 *      the capability test. It writes `a/ready.json` and keeps serving.
 *   3. The operator stops `serve`, then `run` executes the paid tasks on `a`
 *      (cap 10) and `b` (cap 20), enforcing a request budget. It writes a
 *      sanitized report; provider keys and chat text are never printed.
 *
 * The harness does not read the production `secrets/` directory. The user enters
 * the key into the isolated console; only the isolated `config/` and `secrets/`
 * are copied from `a` to `b`.
 */

import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {estimateCost} from '../src/ai/providers/pricing.mjs';

const ROOT = resolve('tests', '.tmp', 'paid-p03');
const STATE_FILE = join(ROOT, 'state.json');
const T0 = Date.parse('2026-11-08T10:00:00.000Z');

const SESSIONS = [
  {
    id: 'ses_p03_ab',
    title: 'P0-3 A/B 25 viewers',
    viewers: 25,
    messages: 200,
    locale: 'zh-CN'
  },
  {
    id: 'ses_p03_both',
    title: 'P0-3 single-session report 80 viewers',
    viewers: 80,
    messages: 800,
    locale: 'zh-CN'
  },
  {
    id: 'ses_p03_scale',
    title: 'P0-3 scale 100 viewers',
    viewers: 100,
    messages: 1000,
    locale: 'zh-CN'
  },
  {
    id: 'ses_p03_ja',
    title: 'P0-3 Japanese 60 viewers',
    viewers: 60,
    messages: 600,
    locale: 'ja'
  }
];

const PHRASES = {
  'zh-CN': [
    '吉他练了一个月，还是按不紧弦',
    '今天下班好晚，只能补录播',
    '猫又踩键盘了',
    '这周的作业终于交完了',
    '在东京留学，时差有点难受',
    '推荐一下适合新手的键盘',
    '第一次看直播，氛围很好',
    '刚搬到大阪，还在找好吃的拉面',
    '最近在学做菜，失败了三次',
    '这首歌的副歌太好听了',
    '明天要早起，先睡了',
    '有没有人一起打游戏',
    '工作压力大，听直播放松',
    '今天生日，来许个愿',
    '画画卡在配色上',
    '这期节目的剪辑好厉害'
  ],
  ja: [
    'ギターを始めて一ヶ月、まだコードが押さえられない',
    '今日は残業で配信をリアルタイムで見られなかった',
    '猫がまたキーボードを踏んだ',
    '今週の課題をやっと出せた',
    '東京に留学中で、時差がつらい',
    '初心者向けのキーボードを教えてほしい',
    '初めて見ました、雰囲気がいいですね',
    '大阪に引っ越したばかりで、美味しいラーメンを探しています',
    '最近料理を練習中、三回失敗した',
    'この曲のサビが本当に好き',
    '明日は早起きなのでもう寝ます',
    '一緒にゲームする人いますか',
    '仕事が大変で、配信を聞いて落ち着いています',
    '今日誕生日なので願い事をします',
    '絵の色選びで止まっている',
    '今回の編集すごく上手'
  ],
  en: [
    'I started learning guitar last month',
    'Could not watch live today because of work',
    'My cat stepped on the keyboard again',
    'Finally submitted this week assignment',
    'Studying in Tokyo, the time zone is rough',
    'Any beginner keyboard recommendations?',
    'First time here, great atmosphere',
    'Just moved to Osaka, looking for good ramen',
    'Learning to cook, failed three times',
    'The chorus of this song is amazing',
    'Need to wake up early tomorrow, good night',
    'Anyone want to play games together?',
    'Work is stressful, the stream helps me relax',
    'It is my birthday today, making a wish',
    'Stuck on color choices for my drawing',
    'The editing this time is really good'
  ]
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedDataDir(dir) {
  mkdirSync(dir, {recursive: true});
  return startServer({auth: false, dataDir: dir, port: 0, systemLocale: 'en'});
}

function seedSessions(server) {
  const db = server.db;
  const broadcasterId = 'youtube:UC_P03_BROADCASTER';
  upsertBroadcaster(db, {
    id: broadcasterId,
    platform: 'youtube',
    platformUid: 'UC_P03_BROADCASTER',
    displayName: 'P0-3 Synthetic Broadcaster',
    identity: 'verified',
    seenAt: T0,
    now: T0
  });
  for (const spec of SESSIONS) {
    const session = createSession(db, {
      id: spec.id,
      platform: 'youtube',
      platformRoomId: `p03-${spec.id}`,
      roomTitle: spec.title,
      broadcasterName: 'P0-3 Synthetic Broadcaster',
      broadcasterId,
      broadcasterIdentity: 'verified',
      storageMode: 'full',
      sourceQuality: 'mock',
      simulated: true,
      startedAt: T0
    });
    const ingest = new EventIngest({db});
    const phrases = PHRASES[spec.locale] ?? PHRASES.en;
    for (let index = 0; index < spec.messages; index += 1) {
      const viewer = index % spec.viewers;
      ingest.record({
        session_id: session.id,
        platform: 'youtube',
        event_type: 'chat',
        viewer_uid: `UC_P03_${spec.id}_${viewer}`,
        display_name: `P03 Viewer ${viewer}`,
        occurred_at: T0 + 1000 + index * 1000,
        content: `${phrases[index % phrases.length]} #${index}`,
        external_id: `p03-${spec.id}-${index}`,
        source_quality: 'mock'
      });
    }
    endSession(db, session.id, {
      status: 'ended',
      endedAt: T0 + 1000 + spec.messages * 1000,
      reason: 'adapter_end'
    });
  }
}

function configSummary(config) {
  return {
    id: config.id,
    providerId: config.providerId,
    regionId: config.regionId,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    pricing: config.pricing,
    pricingStatus: config.pricingStatus,
    contextLength: config.contextLength,
    capabilities: config.capabilities,
    lastTestStatus: {
      status: config.lastTestStatus?.status ?? null,
      usage: config.lastTestStatus?.usage ?? null,
      at: config.lastTestStatus?.at ?? null,
      error: config.lastTestStatus?.error ?? null
    }
  };
}

async function waitForTerminal(runner, sessionId, {timeoutMs = 30 * 60 * 1000} = {}) {
  const startedAt = Date.now();
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (['complete', 'failed', 'partial', 'needs_action', 'canceled', 'interrupted'].includes(status.status)) {
      return status;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`task ${sessionId} did not finish in ${timeoutMs} ms (status ${status.status})`);
    }
    await sleep(500);
  }
}

function jobUsage(db, sessionId, kind) {
  const jobKind = kind === 'session' ? 'session_analysis' : 'viewer_memory_analysis';
  const row = db.prepare(`
    SELECT id, usage_json FROM ai_jobs
    WHERE session_id = ? AND kind = ?
    ORDER BY rowid DESC LIMIT 1
  `).get(sessionId, jobKind);
  if (!row) return {jobId: null, usage: null};
  return {jobId: row.id, usage: row.usage_json ? JSON.parse(row.usage_json) : null};
}

function usageCost(usage, pricing) {
  if (!usage) return null;
  return estimateCost({
    pricing,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0
  });
}

function summarizeTask({sessionId, mode, locale, status, requests, db, pricing, extra = {}}) {
  const sessionJob = jobUsage(db, sessionId, 'session');
  const memoryJob = jobUsage(db, sessionId, 'memory');
  const usages = [sessionJob.usage, memoryJob.usage].filter(Boolean);
  const total = usages.reduce((acc, usage) => ({
    inputTokens: acc.inputTokens + Number(usage.inputTokens ?? 0),
    outputTokens: acc.outputTokens + Number(usage.outputTokens ?? 0),
    reasoningTokens: acc.reasoningTokens + Number(usage.reasoningTokens ?? 0),
    cachedInputTokens: acc.cachedInputTokens + Number(usage.cachedInputTokens ?? 0),
    cacheWriteInputTokens: acc.cacheWriteInputTokens + Number(usage.cacheWriteInputTokens ?? 0),
    requests: acc.requests + Number(usage.requests ?? 0),
    attempts: acc.attempts + Number(usage.attempts ?? 0),
    unknownUsageAttempts: acc.unknownUsageAttempts + Number(usage.unknownUsageAttempts ?? 0)
  }), {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, requests: 0, attempts: 0, unknownUsageAttempts: 0
  });
  const facts = db.prepare(`
    SELECT COUNT(*) AS n, COUNT(DISTINCT viewer_id) AS viewers
    FROM memory_facts WHERE source_session_id = ?
  `).get(sessionId);
  return {
    sessionId,
    mode,
    locale,
    status: status.status,
    error: status.error ?? null,
    requests,
    usage: usages.length > 0 ? total : null,
    cost: usages.length > 0 ? usageCost(total, pricing) : null,
    sessionJobId: sessionJob.jobId,
    memoryJobId: memoryJob.jobId,
    memoryCoverage: status.memoryCoverage ?? null,
    memoryBatchTotal: status.memoryBatchTotal ?? null,
    facts: Number(facts?.n ?? 0),
    viewersWithFacts: Number(facts?.viewers ?? 0),
    ...extra
  };
}

function makeCountedFetch(limit, counterFile) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let count = 0;
  const fetchImpl = async (...args) => {
    count += 1;
    if (count > limit) {
      const error = new Error('PAID_BUDGET_EXCEEDED');
      error.code = 'PAID_BUDGET_EXCEEDED';
      throw error;
    }
    writeFileSync(counterFile, `${count}\n`, 'utf8');
    return nativeFetch(...args);
  };
  return {fetchImpl, count: () => count};
}

async function prepare() {
  if (existsSync(ROOT)) {
    if (process.argv.includes('--force')) rmSync(ROOT, {recursive: true, force: true});
    else throw new Error(`${ROOT} already exists; pass --force to recreate`);
  }
  mkdirSync(ROOT, {recursive: true});
  for (const name of ['a', 'b']) {
    const dir = join(ROOT, name);
    const server = await seedDataDir(dir);
    try {
      seedSessions(server);
    } finally {
      await server.close();
    }
  }
  writeJson(STATE_FILE, {
    createdAt: new Date().toISOString(),
    root: ROOT,
    sessions: SESSIONS,
    dirs: {a: join(ROOT, 'a'), b: join(ROOT, 'b')}
  });
  console.log(`prepared ${ROOT}`);
  for (const spec of SESSIONS) {
    console.log(`  ${spec.id}: ${spec.viewers} viewers / ${spec.messages} messages / ${spec.locale}`);
  }
}

async function serve() {
  const name = arg('dir', 'a');
  const cap = Number(arg('cap', '10')) || 10;
  const timeoutMin = Number(arg('timeout-min', '30')) || 30;
  const dir = join(ROOT, name);
  if (!existsSync(dir)) throw new Error(`missing ${dir}; run prepare first`);
  const counterFile = join(dir, 'paid-request-count.txt');
  writeFileSync(counterFile, '0\n', 'utf8');
  const counted = makeCountedFetch(Number(arg('request-limit', '12')) || 12, counterFile);
  const server = await startServer({
    // Test-only console on loopback. A longer bootstrap TTL gives the operator
    // time to open the isolated console and enter the key; the token is still
    // one-time and process-local, and this harness never runs in production.
    auth: {bootstrapTtlMs: 60 * 60 * 1000},
    dataDir: dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: counted.fetchImpl,
      memoryViewerCapHard: cap
    }
  });
  const url = server.auth.browserUrl(server.url);
  writeFileSync(join(dir, 'bootstrap-url.txt'), `${url}\n`, 'utf8');
  console.log(`OPEN ${url}`);
  console.log(`DATA ${dir}`);
  console.log(`CAP ${cap} REQUEST_LIMIT 12`);
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let ready = null;
  try {
    while (Date.now() < deadline) {
      const configs = server.providerConfigStore.list();
      const config = configs.find((entry) => entry.capabilities?.memory === true)
        ?? configs.find((entry) => entry.capabilities?.session === true);
      if (config) {
        ready = configSummary(server.providerConfigStore.get(config.id));
        writeJson(join(ROOT, 'ready.json'), ready);
        writeJson(join(dir, 'ready.json'), ready);
        console.log(`READY ${JSON.stringify({
          configId: ready.id,
          providerId: ready.providerId,
          modelId: ready.modelId,
          capabilities: ready.capabilities,
          testStatus: ready.lastTestStatus.status,
          testUsage: ready.lastTestStatus.usage
        })}`);
        break;
      }
      await sleep(3000);
    }
    if (!ready) throw new Error(`no configured provider within ${timeoutMin} minutes`);
    // Keep the console alive until the operator stops this process.
    await new Promise((done) => {
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
    });
  } finally {
    await server.close();
  }
}

async function copyConfig(fromDir, toDir) {
  cpSync(join(fromDir, 'config'), join(toDir, 'config'), {recursive: true, force: true});
  cpSync(join(fromDir, 'secrets'), join(toDir, 'secrets'), {recursive: true, force: true});
  // Never inherit the other run's job state; the data itself was seeded
  // identically and must not contain the other cap's results.
  rmSync(join(toDir, 'runtime', 'ai-v13.json'), {force: true});
}

async function run() {
  const ready = readJson(join(ROOT, 'ready.json'));
  const pricing = ready.pricing;
  if (!pricing) throw new Error('the selected config has no price; enter input/output price first');
  const tasks = [];
  const startedAt = Date.now();

  // A: cap 10 — the previous policy. Only the A/B dataset is run here.
  {
    const dir = join(ROOT, 'a');
    const counterFile = join(dir, 'paid-request-count.txt');
    const counted = makeCountedFetch(10, counterFile);
    const server = await startServer({
      auth: true, dataDir: dir, port: 0, systemLocale: 'en',
      auto: {fetchImpl: counted.fetchImpl, memoryViewerCapHard: 10}
    });
    try {
      const before = counted.count();
      await server.analysisRunner.start({
        sessionId: 'ses_p03_ab', locale: 'zh-CN', mode: 'memory',
        configId: ready.id, consent: true
      });
      const status = await waitForTerminal(server.analysisRunner, 'ses_p03_ab');
      tasks.push(summarizeTask({
        sessionId: 'ses_p03_ab', mode: 'memory', locale: 'zh-CN', status,
        requests: counted.count() - before, db: server.db, pricing, extra: {cap: 10}
      }));
    } finally {
      await server.close();
    }
  }

  await copyConfig(join(ROOT, 'a'), join(ROOT, 'b'));

  // B: cap 20 — shipped adaptive policy.
  const bCounterFile = join(ROOT, 'b', 'paid-request-count.txt');
  const countedB = makeCountedFetch(24, bCounterFile);
  let serverB = await startServer({
    auth: true,
    dataDir: join(ROOT, 'b'),
    port: 0,
    systemLocale: 'en',
    auto: {fetchImpl: countedB.fetchImpl, memoryViewerCapHard: 20}
  });

  const task = async ({sessionId, mode, locale, label}) => {
    const before = countedB.count();
    await serverB.analysisRunner.start({sessionId, locale, mode, configId: ready.id, consent: true});
    const status = await waitForTerminal(serverB.analysisRunner, sessionId);
    const summary = summarizeTask({
      sessionId, mode, locale, status, requests: countedB.count() - before,
      db: serverB.db, pricing, extra: {cap: 20, label}
    });
    tasks.push(summary);
    return summary;
  };

  try {
    await task({sessionId: 'ses_p03_both', mode: 'combined', locale: 'zh-CN', label: 'single-session + memory'});
    await task({sessionId: 'ses_p03_ab', mode: 'memory', locale: 'zh-CN', label: 'A/B 25 viewers'});

    // Scale + controlled resume: pause at a batch boundary, restart, resume.
    {
      const before = countedB.count();
      await serverB.analysisRunner.start({
        sessionId: 'ses_p03_scale', locale: 'zh-CN', mode: 'memory',
        configId: ready.id, consent: true
      });
      let paused = false;
      for (let index = 0; index < 1200; index += 1) {
        const status = serverB.analysisRunner.getStatus('ses_p03_scale');
        if (status.status === 'complete') break;
        if (Number(status.memoryBatchesCompleted ?? 0) >= 2
          && status.currentRequest === null
          && status.status === 'running') {
          serverB.analysisRunner.pause('ses_p03_scale');
          paused = true;
          break;
        }
        await sleep(250);
      }
      if (paused) {
        for (let index = 0; index < 120; index += 1) {
          if (serverB.analysisRunner.getStatus('ses_p03_scale').status !== 'running') break;
          await sleep(250);
        }
        const pausedStatus = serverB.analysisRunner.getStatus('ses_p03_scale');
        const pausedRequests = countedB.count() - before;
        await serverB.close();
        serverB = await startServer({
          auth: true, dataDir: join(ROOT, 'b'), port: 0, systemLocale: 'en',
          auto: {fetchImpl: countedB.fetchImpl, memoryViewerCapHard: 20}
        });
        await serverB.analysisRunner.resume('ses_p03_scale', {consent: true});
        const status = await waitForTerminal(serverB.analysisRunner, 'ses_p03_scale');
        tasks.push(summarizeTask({
          sessionId: 'ses_p03_scale', mode: 'memory', locale: 'zh-CN', status,
          requests: countedB.count() - before, db: serverB.db, pricing,
          extra: {cap: 20, label: 'scale', resume: true, pausedAt: pausedStatus.status, pausedRequests}
        }));
      } else {
        const status = await waitForTerminal(serverB.analysisRunner, 'ses_p03_scale');
        tasks.push(summarizeTask({
          sessionId: 'ses_p03_scale', mode: 'memory', locale: 'zh-CN', status,
          requests: countedB.count() - before, db: serverB.db, pricing,
          extra: {cap: 20, label: 'scale', resume: false, reason: 'completed before a safe pause'}
        }));
      }
    }

    await task({sessionId: 'ses_p03_ja', mode: 'memory', locale: 'ja', label: 'Japanese memory'});

    const facts = [];
    for (const name of ['a', 'b']) {
      const db = openDatabase({file: join(ROOT, name, 'database', 'livememory.db')});
      try {
        const rows = db.prepare(`
          SELECT f.viewer_id, f.kind, f.topic, f.statement, f.certainty, f.status,
                 f.evidence_count, f.source_session_id, f.source_job_id
          FROM memory_facts f
          WHERE f.source_session_id IN ('ses_p03_ab','ses_p03_both','ses_p03_scale','ses_p03_ja')
          ORDER BY f.source_session_id, f.viewer_id, f.topic, f.statement
        `).all();
        for (const row of rows) facts.push({dir: name, ...row});
      } finally {
        closeDatabase(db);
      }
    }

    const totalUsage = tasks.reduce((acc, task) => ({
      inputTokens: acc.inputTokens + Number(task.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + Number(task.usage?.outputTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + Number(task.usage?.reasoningTokens ?? 0),
      cachedInputTokens: acc.cachedInputTokens + Number(task.usage?.cachedInputTokens ?? 0),
      requests: acc.requests + Number(task.requests ?? 0),
      attempts: acc.attempts + Number(task.usage?.attempts ?? 0),
      cost: acc.cost + Number(task.cost?.amount ?? 0)
    }), {inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, requests: 0, attempts: 0, cost: 0});

    const testUsage = ready.lastTestStatus?.usage ?? null;
    const testCost = usageCost(testUsage, pricing);
    const report = {
      generatedAt: new Date().toISOString(),
      model: {providerId: ready.providerId, modelId: ready.modelId, regionId: ready.regionId},
      pricing,
      capabilityTest: {status: ready.lastTestStatus?.status, usage: testUsage, cost: testCost},
      tasks,
      facts,
      budget: {
        requestCap: 46,
        requests: totalUsage.requests + Number(testUsage?.requests ?? 0),
        estimatedCostUsd: Number((totalUsage.cost + Number(testCost?.amount ?? 0)).toFixed(6)),
        authoritative: false,
        note: 'Estimated from provider-reported tokens x the price entered in the isolated config; not an invoice.'
      },
      elapsedMs: Date.now() - startedAt
    };
    writeJson(join(ROOT, 'report.json'), report);
    console.log(JSON.stringify({
      report: join(ROOT, 'report.json'),
      tasks: tasks.map((task) => ({
        sessionId: task.sessionId, label: task.label, cap: task.cap, status: task.status,
        requests: task.requests, facts: task.facts, coverage: task.memoryCoverage,
        input: task.usage?.inputTokens ?? 0, output: task.usage?.outputTokens ?? 0,
        cost: task.cost?.amount ?? null
      })),
      budget: report.budget
    }, null, 2));
  } finally {
    await serverB.close();
  }
}

async function resumeJa() {
  const ready = readJson(join(ROOT, 'ready.json'));
  const dir = join(ROOT, 'b');
  const counterFile = join(dir, 'resume-request-count.txt');
  const counted = makeCountedFetch(12, counterFile);
  const server = await startServer({
    auth: true,
    dataDir: dir,
    port: 0,
    systemLocale: 'en',
    auto: {fetchImpl: counted.fetchImpl, memoryViewerCapHard: 20}
  });
  try {
    await server.analysisRunner.resume('ses_p03_ja', {consent: true});
    const status = await waitForTerminal(server.analysisRunner, 'ses_p03_ja');
    const summary = summarizeTask({
      sessionId: 'ses_p03_ja', mode: 'memory', locale: 'ja', status,
      requests: counted.count(), db: server.db, pricing: ready.pricing,
      extra: {cap: 20, label: 'Japanese memory (resume)'}
    });
    writeJson(join(ROOT, 'resume-ja.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await server.close();
  }
}

async function repeat() {
  const ready = readJson(join(ROOT, 'ready.json'));
  const root = join(ROOT, 'repeat');
  mkdirSync(root, {recursive: true});
  for (const name of ['a', 'b']) {
    const dir = join(root, name);
    if (existsSync(join(dir, 'database', 'livememory.db'))) continue;
    const server = await seedDataDir(dir);
    try {
      seedSessions(server);
    } finally {
      await server.close();
    }
  }
  copyConfig(join(ROOT, 'a'), join(root, 'a'));
  copyConfig(join(ROOT, 'a'), join(root, 'b'));

  const runOne = async (name, cap) => {
    const dir = join(root, name);
    const counted = makeCountedFetch(12, join(dir, `repeat-request-count.txt`));
    const server = await startServer({
      auth: true, dataDir: dir, port: 0, systemLocale: 'en',
      auto: {fetchImpl: counted.fetchImpl, memoryViewerCapHard: cap}
    });
    try {
      await server.analysisRunner.start({
        sessionId: 'ses_p03_ab', locale: 'zh-CN', mode: 'memory',
        configId: ready.id, consent: true
      });
      const status = await waitForTerminal(server.analysisRunner, 'ses_p03_ab');
      return summarizeTask({
        sessionId: 'ses_p03_ab', mode: 'memory', locale: 'zh-CN', status,
        requests: counted.count(), db: server.db, pricing: ready.pricing,
        extra: {cap, label: 'A/B repeat'}
      });
    } finally {
      await server.close();
    }
  };

  const a = await runOne('a', 10);
  const b = await runOne('b', 20);
  const facts = [];
  for (const name of ['a', 'b']) {
    const db = openDatabase({file: join(root, name, 'database', 'livememory.db')});
    try {
      for (const row of db.prepare(`
        SELECT f.viewer_id, f.kind, f.topic, f.statement, f.certainty, f.status,
               f.evidence_count, f.source_session_id, f.source_job_id
        FROM memory_facts f WHERE f.source_session_id = 'ses_p03_ab'
      `).all()) facts.push({dir: name, ...row});
    } finally {
      closeDatabase(db);
    }
  }
  writeJson(join(root, 'repeat.json'), {a, b, facts});
  console.log(JSON.stringify({a, b, facts: facts.length}, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (command === 'serve') return serve();
  if (command === 'run') return run();
  if (command === 'resume-ja') return resumeJa();
  if (command === 'repeat') return repeat();
  throw new Error('usage: prepare | serve | run | resume-ja | repeat');
}

main().catch((error) => {
  console.error(`[ai-paid-acceptance] ${error?.code ?? error?.name ?? 'ERROR'}: ${error?.message ?? error}`);
  process.exitCode = 1;
});
