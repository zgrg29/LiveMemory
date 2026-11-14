#!/usr/bin/env node
/**
 * P0-3 Phase B — real paid acceptance through the packaged Windows EXE.
 *
 * This script launches `dist/LiveMemory.exe` on an isolated data directory that
 * already contains synthetic sessions and a user-entered provider config
 * (copied from the isolated console used for the in-process run). It never reads
 * the production data directory and never prints the API key.
 *
 * It verifies, with real DeepSeek requests:
 *   - authentication still protects the AI endpoints;
 *   - a combined session report + long-term memory task completes;
 *   - the saved report has schema 1.3.0 and the memory job covers every viewer;
 *   - usage and the estimated cost are recorded;
 *   - a portable `.livememory` backup can still be created;
 *   - a restart keeps the completed result and a repeated resume sends no
 *     provider request.
 */

import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, cpSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';

const EXE = resolve('dist', 'LiveMemory.exe');
const SOURCE_ROOT = resolve('tests', '.tmp', 'paid-p03');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ROOT = join(SOURCE_ROOT, `exe-${STAMP}`);
const DATA_DIR = join(ROOT, 'data');
const BOOTSTRAP_FILE = join(ROOT, 'bootstrap.url');
const T0 = Date.parse('2026-11-08T10:00:00.000Z');

mkdirSync(ROOT, {recursive: true});

const PHRASES = [
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
];

const SESSION = {
  id: 'ses_p03_exe',
  title: 'P0-3 EXE real-provider acceptance',
  viewers: 40,
  messages: 400,
  locale: 'zh-CN'
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function seed() {
  const server = await startServer({auth: false, dataDir: DATA_DIR, port: 0, systemLocale: 'en'});
  try {
    const broadcasterId = 'youtube:UC_P03_EXE';
    upsertBroadcaster(server.db, {
      id: broadcasterId,
      platform: 'youtube',
      platformUid: 'UC_P03_EXE',
      displayName: 'P0-3 EXE Synthetic Broadcaster',
      identity: 'verified',
      seenAt: T0,
      now: T0
    });
    const session = createSession(server.db, {
      id: SESSION.id,
      platform: 'youtube',
      platformRoomId: 'p03-exe',
      roomTitle: SESSION.title,
      broadcasterName: 'P0-3 EXE Synthetic Broadcaster',
      broadcasterId,
      broadcasterIdentity: 'verified',
      storageMode: 'full',
      sourceQuality: 'mock',
      simulated: true,
      startedAt: T0
    });
    const ingest = new EventIngest({db: server.db});
    for (let index = 0; index < SESSION.messages; index += 1) {
      const viewer = index % SESSION.viewers;
      ingest.record({
        session_id: session.id,
        platform: 'youtube',
        event_type: 'chat',
        viewer_uid: `UC_P03_EXE_${viewer}`,
        display_name: `P03 EXE Viewer ${viewer}`,
        occurred_at: T0 + 1000 + index * 1000,
        content: `${PHRASES[index % PHRASES.length]} #${index}`,
        external_id: `p03-exe-${index}`,
        source_quality: 'mock'
      });
    }
    endSession(server.db, session.id, {
      status: 'ended',
      endedAt: T0 + 1000 + SESSION.messages * 1000,
      reason: 'adapter_end'
    });
  } finally {
    await server.close();
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}

async function waitFor(check, {timeout = 60000, interval = 250, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(interval);
  }
}

let port = null;
let child = null;
let exitInfo = null;
let cookie = null;

function headersFor(extra = {}) {
  return cookie ? {cookie, ...extra} : extra;
}

async function json(path, {method = 'GET', body} = {}) {
  const headers = headersFor();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {status: response.status, payload};
}

async function launch() {
  port = await freePort();
  cookie = null;
  exitInfo = null;
  rmSync(BOOTSTRAP_FILE, {force: true});
  child = spawn(EXE, ['--no-open', '--port', String(port), '--data-dir', DATA_DIR, '--lang', 'en'], {
    cwd: ROOT,
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: BOOTSTRAP_FILE},
    stdio: ['ignore', openSync(join(ROOT, 'stdout.log'), 'a'), openSync(join(ROOT, 'stderr.log'), 'a')],
    windowsHide: true
  });
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  return waitFor(async () => {
    if (exitInfo) throw new Error(`EXE exited early: ${JSON.stringify(exitInfo)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1000)});
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }, {timeout: 60000, label: 'health'});
}

async function authenticate() {
  const url = await waitFor(() => {
    if (!existsSync(BOOTSTRAP_FILE)) return null;
    return readFileSync(BOOTSTRAP_FILE, 'utf8').trim() || null;
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
  while (Date.now() - started < 20000) {
    if (exitInfo) break;
    await sleep(100);
  }
  if (!exitInfo) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  child = null;
}

async function waitAnalysis(timeout = 15 * 60 * 1000) {
  return waitFor(async () => {
    const status = await json(`/api/ai/analyze/status?sessionId=${encodeURIComponent(SESSION.id)}`);
    if (status.status !== 200) return null;
    return ['complete', 'partial', 'failed', 'needs_action', 'canceled'].includes(status.payload.status)
      ? status.payload
      : null;
  }, {timeout, interval: 1000, label: 'analysis'});
}

async function main() {
  const checks = [];
  const record = (name, passed, details = []) => {
    checks.push({name, passed, details});
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${details.length ? ` — ${details.join(' | ')}` : ''}`);
  };
  if (!existsSync(EXE)) throw new Error(`missing ${EXE}; build it first`);
  if (!existsSync(join(SOURCE_ROOT, 'a', 'config', 'ai-providers.json'))) {
    throw new Error('missing isolated provider config; run the in-process acceptance first');
  }

  await seed();
  // Copy only the isolated provider config + encrypted key; the database is the
  // freshly seeded synthetic one.
  for (const entry of ['config', 'secrets']) {
    const source = join(SOURCE_ROOT, 'a', entry);
    const target = join(DATA_DIR, entry);
    rmSync(target, {recursive: true, force: true});
    cpSync(source, target, {recursive: true, force: true});
  }
  const configs = JSON.parse(readFileSync(join(DATA_DIR, 'config', 'ai-providers.json'), 'utf8')).configs;
  const configId = configs.find((entry) => entry.capabilities?.memory === true)?.id;
  if (!configId) throw new Error('copied config has no memory capability');

  const buildInfo = JSON.parse(readFileSync('build/build-info.json', 'utf8'));
  const health = await launch();
  record('EXE launches as the current user and serves the expected build',
    health?.buildId === buildInfo.buildId,
    [`buildId ${health?.buildId}`, `commit ${health?.commit}`]);

  const anon = await json(`/api/ai/analyze/status?sessionId=${encodeURIComponent(SESSION.id)}`);
  record('unauthenticated AI status is rejected', anon.status === 401, [`HTTP ${anon.status}`]);
  await authenticate();

  const started = await json('/api/ai/analyze/run', {
    method: 'POST',
    body: {sessionId: SESSION.id, locale: 'zh-CN', mode: 'combined', configId, consent: true}
  });
  record('a real combined analysis task is accepted', started.status === 202, [`HTTP ${started.status}`]);

  const status = await waitAnalysis();
  const coverage = status.memoryCoverage ?? null;
  record('the real task completes with every viewer covered',
    status.status === 'complete' && coverage?.covered === SESSION.viewers && coverage?.failed === 0,
    [`status ${status.status}`, `covered ${coverage?.covered}/${coverage?.total}`, `failed ${coverage?.failed}`]);
  record('usage is recorded from the provider',
    Number(status.usage?.requests ?? 0) > 0 && Number(status.usage?.inputTokens ?? 0) > 0,
    [`requests ${status.usage?.requests}`, `attempts ${status.usage?.attempts}`,
      `input ${status.usage?.inputTokens}`, `output ${status.usage?.outputTokens}`,
      `cached ${status.usage?.cachedInputTokens}`]);
  record('estimated cost is derived from the entered price',
    Number(status.efficiency?.cost?.amount ?? 0) > 0,
    [`cost ${status.efficiency?.cost?.amount} ${status.efficiency?.cost?.currency}`]);

  const report = await json(`/api/ai/sessions/${encodeURIComponent(SESSION.id)}/report`);
  const reportBody = report.payload ?? null;
  const reportData = reportBody?.report ?? null;
  record('a schema 1.3.0 single-session report is saved',
    report.status === 200
      && reportBody?.result?.schemaVersion === '1.3.0'
      && Array.isArray(reportData?.topics)
      && reportData.topics.length > 0,
    [`HTTP ${report.status}`, `schema ${reportBody?.result?.schemaVersion ?? 'n/a'}`,
      `mode ${reportBody?.mode ?? 'n/a'}`, `topics ${reportData?.topics?.length ?? 0}`,
      `summary ${String(reportData?.summary ?? '').slice(0, 80)}`]);

  record('long-term profiles are persisted with facts',
    Number(status.efficiency?.factsSaved ?? 0) > 0
      && Number(coverage?.semantic ?? 0) === SESSION.viewers,
    [`facts ${status.efficiency?.factsSaved ?? 0}`, `semantic ${coverage?.semantic ?? 0}/${SESSION.viewers}`]);

  const backupPath = join(ROOT, 'p03-real.livememory');
  const backup = await json('/api/backup/create', {method: 'POST', body: {path: backupPath}});
  const jobId = backup.payload?.job?.id ?? null;
  const backupDone = jobId
    ? await waitFor(async () => {
      const job = await json(`/api/backup/jobs/${encodeURIComponent(jobId)}`);
      const jobBody = job.payload?.job ?? job.payload;
      return ['completed', 'failed', 'cancelled'].includes(jobBody?.status) ? jobBody : null;
    }, {timeout: 120000, interval: 500, label: 'backup'})
    : null;
  record('a portable .livememory backup can still be created',
    backup.status === 202 && backupDone?.status === 'completed' && existsSync(backupPath),
    [`HTTP ${backup.status}`, `job ${backupDone?.status ?? 'missing'}`,
      `bytes ${existsSync(backupPath) ? statSync(backupPath).size : 0}`]);

  const beforeRestartRequests = Number(status.usage?.requests ?? 0);
  await stop();
  const health2 = await launch();
  await authenticate();
  const restarted = await waitAnalysis();
  record('the completed task survives a real process restart',
    health2?.buildId === buildInfo.buildId
      && restarted.status === 'complete'
      && Number(restarted.usage?.requests ?? 0) === beforeRestartRequests,
    [`status ${restarted.status}`, `requests ${beforeRestartRequests} → ${restarted.usage?.requests}`]);

  const resume = await json('/api/ai/analyze/resume', {
    method: 'POST',
    body: {sessionId: SESSION.id, consent: true}
  });
  const afterResume = await waitAnalysis();
  // A completed task is accepted with 202 and immediately reports complete; the
  // important assertion is that the provider request count does not change.
  record('a repeated resume after completion sends no provider request',
    [200, 202].includes(resume.status)
      && (resume.payload?.status ?? 'complete') === 'complete'
      && Number(afterResume.usage?.requests ?? 0) === beforeRestartRequests,
    [`HTTP ${resume.status}`, `status ${resume.payload?.status ?? afterResume.status}`,
      `requests ${beforeRestartRequests} → ${afterResume.usage?.requests}`]);

  await stop();
  const summary = {
    generatedAt: new Date().toISOString(),
    build: {buildId: buildInfo.buildId, commit: buildInfo.commit},
    session: SESSION,
    status: {
      status: status.status,
      usage: status.usage,
      efficiency: {
        cost: status.efficiency?.cost ?? null,
        tokenSource: status.efficiency?.tokenSource ?? null,
        per100Viewers: status.efficiency?.costPer100Viewers ?? null
      },
      coverage
    },
    backup: {path: backupPath, bytes: existsSync(backupPath) ? statSync(backupPath).size : 0},
    checks
  };
  writeFileSync(join(ROOT, 'exe-acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const failed = checks.filter((check) => !check.passed);
  console.log(`\n[ai-paid-exe] ${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`[ai-paid-exe] artifacts ${ROOT}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(`[ai-paid-exe] ${error?.code ?? error?.name ?? 'ERROR'}: ${error?.message ?? error}`);
  await stop().catch(() => {});
  process.exitCode = 1;
});
