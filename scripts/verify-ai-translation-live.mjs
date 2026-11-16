#!/usr/bin/env node
/**
 * P42 / I18N-M3 real-provider report-reading translation harness.
 *
 * It generates one real Chinese report, then asks the user's real DeepSeek
 * provider to translate the *reading view* into Korean, Traditional Chinese,
 * Spanish, French and Indonesian. It verifies:
 *   - each target gets its own cache rows and its own prose language,
 *   - the stored original report, structured fields, evidence refs and raw chat
 *     are unchanged,
 *   - reading an already translated language costs zero provider requests,
 *   - a failed translation keeps the original Chinese text (no blank report).
 *
 * Usage:
 *   node scripts/verify-ai-translation-live.mjs --source-data-dir "E:\LiveMemory data"
 *
 * Encrypted credentials are copied into `tests/.tmp/p42-translation-live`; keys
 * are never printed and the source directory is never written.
 */

import {cpSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster} from '../tests/helpers/ai-fixtures.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {getJob} from '../src/storage/repositories/ai-jobs.mjs';

const ROOT = resolve('tests', '.tmp', 'p42-translation-live');
const REPORT_FILE = join(ROOT, 'report.json');
const TARGETS = ['ko', 'zh-TW', 'es', 'fr', 'id'];

const CHAT = [
  ['youtube:UC_P42_TR_1', '小雨', '我上周开始学吉他了，今天练了两个小时'],
  ['youtube:UC_P42_TR_1', '小雨', '吉他真的很有意思，我会继续练下去'],
  ['youtube:UC_P42_TR_2', '阿杰', '我最近在学做菜，昨天做了番茄炒蛋'],
  ['youtube:UC_P42_TR_2', '阿杰', '周末打算试试烤蛋糕'],
  ['youtube:UC_P42_TR_1', '小雨', '我养了一只猫，叫豆豆，它很喜欢听我弹吉他'],
  ['youtube:UC_P42_TR_2', '阿杰', '猫对音乐也很敏感呢'],
  ['youtube:UC_P42_TR_1', '小雨', '今天直播的声音效果不错'],
  ['youtube:UC_P42_TR_2', '阿杰', '感谢主播分享，学到了很多']
];

const NAMES = /小雨|阿杰/g;

function counts(text) {
  const cleaned = String(text ?? '').replace(NAMES, '');
  const han = (cleaned.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  const kana = (cleaned.match(/[\u3040-\u30FF]/g) ?? []).length;
  const hangul = (cleaned.match(/[\uAC00-\uD7A3]/g) ?? []).length;
  const traditional = (cleaned.match(/[這觀眾說與時練習進態歡覺開學會話題們為對從個來後當國語錄]/g) ?? []).length;
  const simplified = (cleaned.match(/[这观众说与时练习进态欢觉开学会话题们为对从个来后当国语录]/g) ?? []).length;
  return {han, kana, hangul, traditional, simplified};
}

const SCRIPT_TESTS = {
  'zh-CN': (text) => {
    const c = counts(text);
    return c.han >= 8 && c.kana <= Math.max(1, Math.floor(c.han * 0.02))
      && c.hangul <= Math.max(1, Math.floor(c.han * 0.05));
  },
  ko: (text) => counts(text).hangul >= 10,
  'zh-TW': (text) => {
    const c = counts(text);
    return c.han >= 10 && c.traditional >= 3 && c.simplified <= Math.max(1, Math.floor(c.traditional * 0.1));
  },
  es: (text) => /\b(el|la|los|las|de|que|con|una|para|y|en)\b/i.test(String(text ?? '')),
  fr: (text) => /\b(le|la|les|des|de|que|avec|une|pour|et|en)\b/i.test(String(text ?? '')),
  id: (text) => /\b(yang|dan|di|dengan|untuk|tidak|adalah|ini|itu)\b/i.test(String(text ?? ''))
};

function parseArgs(argv) {
  const args = {sourceDataDir: null, cap: 16, timeoutMin: 15};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    if (token === '--source-data-dir') args.sourceDataDir = next();
    else if (token === '--cap') args.cap = Math.max(1, Number(next()) || 16);
    else if (token === '--timeout-min') args.timeoutMin = Math.max(1, Number(next()) || 15);
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function seedSession(db) {
  const startedAt = Date.now() - 120_000;
  const session = createSession(db, {
    id: 'ses_p42_translation',
    platform: 'youtube',
    platformRoomId: 'p42-translation-room',
    roomTitle: 'P42 translation report',
    broadcasterName: 'P42 translation',
    broadcasterId: 'youtube:UC_P42_TR_BROADCASTER',
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt
  });
  const ingest = new EventIngest({db});
  CHAT.forEach(([viewerId, name, content], index) => {
    ingest.record({
      session_id: session.id,
      platform: 'youtube',
      event_type: 'chat',
      viewer_uid: viewerId.split(':')[1],
      display_name: name,
      occurred_at: startedAt + 1000 + index * 1000,
      content,
      external_id: `p42-tr-${index}`,
      source_quality: 'mock'
    });
  });
  endSession(db, session.id, {
    status: 'ended',
    endedAt: startedAt + 1000 + CHAT.length * 1000,
    reason: 'adapter_end'
  });
  return session;
}

async function waitForRun(runner, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (['complete', 'failed', 'needs_action'].includes(status.status)) return status;
    if (Date.now() > deadline) return {timeout: true, status};
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function waitForTranslation(server, sessionId, locale, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await server.translationService.getStatus(sessionId, locale);
    if (status.translation.status !== 'running') return status.translation;
    if (Date.now() > deadline) return {status: 'timeout'};
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
}

function collectProse(report) {
  const pieces = [report.summary];
  for (const topic of report.topics ?? []) pieces.push(topic.title, topic.summary, ...(topic.key_points ?? []));
  for (const item of report.highlights ?? []) pieces.push(item.reason, item.clip_suggestion, item.title);
  return pieces.filter((value) => typeof value === 'string' && value.trim()).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See the header of scripts/verify-ai-translation-live.mjs');
    return 0;
  }
  if (!args.sourceDataDir) {
    console.error('Missing --source-data-dir.');
    return 2;
  }
  const configFile = join(args.sourceDataDir, 'config', 'ai-providers.json');
  const keyFile = join(args.sourceDataDir, 'secrets', 'ai-keys.json');
  const aesFile = join(args.sourceDataDir, 'secrets', 'ai-keys.key');
  if (!existsSync(configFile) || !existsSync(keyFile)) {
    console.error('BLOCKED: source data directory has no provider configuration/credentials.');
    return 2;
  }

  rmSync(ROOT, {recursive: true, force: true});
  mkdirSync(join(ROOT, 'config'), {recursive: true});
  mkdirSync(join(ROOT, 'secrets'), {recursive: true});
  cpSync(configFile, join(ROOT, 'config', 'ai-providers.json'));
  cpSync(keyFile, join(ROOT, 'secrets', 'ai-keys.json'));
  if (existsSync(aesFile)) cpSync(aesFile, join(ROOT, 'secrets', 'ai-keys.key'));

  let requests = 0;
  let capExceeded = false;
  const realFetch = globalThis.fetch;
  const countingFetch = async (...fetchArgs) => {
    requests += 1;
    if (requests > args.cap) {
      capExceeded = true;
      throw Object.assign(new Error('REAL_PROVIDER_CAP_EXCEEDED'), {code: 'PROVIDER_NETWORK_FAILED'});
    }
    return realFetch(...fetchArgs);
  };

  const server = await startServer({
    auth: false,
    dataDir: ROOT,
    port: 0,
    systemLocale: 'en',
    auto: {fetchImpl: countingFetch, maxRetries: 0}
  });

  const report = {
    startedAt: new Date().toISOString(),
    sourceDataDir: args.sourceDataDir,
    requestCap: args.cap,
    targets: [],
    blocked: false,
    notes: [
      'Real provider output. Prompts, chat text and credentials are not written here.',
      'Translation only writes ai_translations cache rows; ai_results and events stay untouched.',
      'Machine evidence: script heuristics + stored cache + HTTP responses, not a native-speaker review.'
    ]
  };

  try {
    const configs = server.providerConfigStore.list();
    const config = configs.find((entry) => entry.isDefault) ?? configs[0];
    if (!config || config.capabilities?.session !== true) {
      report.blocked = true;
      report.blockedReason = 'no provider with a passed session capability test';
      console.error('BLOCKED: no usable provider.');
      writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      return 2;
    }
    report.provider = {id: config.id, providerId: config.providerId, modelId: config.modelId};
    addBroadcaster(server.db, {id: 'youtube:UC_P42_TR_BROADCASTER', name: 'P42 translation'});
    const session = seedSession(server.db);

    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'zh-CN',
      mode: 'session',
      configId: config.id,
      consent: true
    });
    const analyzed = await waitForRun(server.analysisRunner, session.id, args.timeoutMin * 60 * 1000);
    report.analysis = {status: analyzed.status, sessionJobId: analyzed.sessionJobId ?? null};
    if (analyzed.status !== 'complete') {
      report.error = analyzed.error?.code ?? analyzed.status;
      return 1;
    }
    const sessionJob = analyzed.sessionJobId ? getJob(server.db, analyzed.sessionJobId) : null;
    report.analysis.jobLocale = sessionJob?.locale ?? null;

    const originalResponse = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    const original = await originalResponse.json();
    const originalSummary = original.report.summary;
    const originalTopics = JSON.stringify(original.report.topics);
    const originalHighlights = JSON.stringify(original.report.highlights ?? []);
    const chatBefore = server.db.prepare(
      "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
    ).all(session.id).map((row) => row.content);
    report.analysis.originalSummaryChars = originalSummary.length;
    report.analysis.originalScript = SCRIPT_TESTS['zh-CN']
      ? (counts(originalSummary).han >= 8)
      : null;

    for (const locale of TARGETS) {
      const entry = {locale, ok: false};
      const requestsBefore = requests;
      const started = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({locale, configId: config.id, consent: true})
      });
      entry.httpStatus = started.status;
      if (started.status !== 202) {
        entry.error = (await started.json().catch(() => ({})))?.error?.code ?? 'start-failed';
        report.targets.push(entry);
        continue;
      }
      const settled = await waitForTranslation(server, session.id, locale, args.timeoutMin * 60 * 1000);
      entry.status = settled.status;
      entry.requestsUsed = requests - requestsBefore;
      entry.cacheRows = server.db.prepare(
        'SELECT COUNT(*) AS n FROM ai_translations WHERE session_id = ? AND target_locale = ?'
      ).get(session.id, locale).n;

      const readResponse = await fetch(
        `${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=${locale}`
      );
      const read = await readResponse.json();
      const statusBody = await fetch(
        `${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation?locale=${locale}`
      ).then((response) => response.json());
      entry.readLocale = statusBody.translation?.targetLocale ?? null;
      entry.translationStatus = statusBody.translation?.status ?? null;
      entry.translatedSummary = read.report.summary;
      entry.summaryChanged = read.report.summary !== originalSummary;
      const prose = collectProse(read.report);
      entry.scriptMatch = SCRIPT_TESTS[locale]?.(prose) ?? true;
      const structure = (topics) => topics.map((topic) => ({
        started_at: topic.started_at,
        ended_at: topic.ended_at,
        confidence: topic.confidence,
        evidence: topic.evidence,
        message_refs: topic.message_refs,
        key_point_count: (topic.key_points ?? []).length
      }));
      entry.structuredIntact = JSON.stringify(structure(read.report.topics ?? []))
        === JSON.stringify(structure(JSON.parse(originalTopics)));
      // Highlight prose is translated by design; only its anchors must match.
      const highlightStructure = (items) => (items ?? []).map((item) => ({
        started_at: item.started_at,
        ended_at: item.ended_at,
        clip_start: item.clip_start,
        clip_end: item.clip_end,
        confidence: item.confidence,
        evidence: item.evidence,
        message_refs: item.message_refs
      }));
      entry.highlightsIntact = JSON.stringify(highlightStructure(read.report.highlights))
        === JSON.stringify(highlightStructure(JSON.parse(originalHighlights)));

      // Reading the same language again must be a cache hit: no provider call.
      const beforeCachedRead = requests;
      const cached = await fetch(
        `${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=${locale}`
      );
      const cachedBody = await cached.json();
      entry.cachedReadRequests = requests - beforeCachedRead;
      entry.cachedReadSame = cachedBody.report.summary === read.report.summary;

      entry.ok = ['complete', 'partial'].includes(entry.status)
        && entry.readLocale === locale
        && entry.summaryChanged
        && entry.scriptMatch
        && entry.structuredIntact
        && entry.highlightsIntact
        && entry.cachedReadRequests === 0
        && entry.cachedReadSame;
      report.targets.push(entry);
    }

    // Original must be untouched after all reading translations.
    const after = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`).then((r) => r.json());
    report.originalUntouched = after.report.summary === originalSummary
      && JSON.stringify(after.report.topics) === originalTopics
      && JSON.stringify(after.report.highlights ?? []) === originalHighlights;
    const chatAfter = server.db.prepare(
      "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
    ).all(session.id).map((row) => row.content);
    report.chatUnchanged = JSON.stringify(chatAfter) === JSON.stringify(chatBefore);

    // Failed translation must fall back to the original prose, not blank it.
    const badConfig = server.providerConfigStore.create({
      providerId: 'deepseek',
      regionId: 'global',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-flash',
      apiKey: 'p42-invalid-key-for-failure-path',
      pricingStatus: 'unknown'
    });
    const failureBefore = requests;
    const failedStart = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({locale: 'ja', configId: badConfig.id, consent: true})
    });
    const failedSettled = failedStart.status === 202
      ? await waitForTranslation(server, session.id, 'ja', 5 * 60 * 1000)
      : {status: `http-${failedStart.status}`};
    const fallbackRead = await fetch(
      `${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=ja`
    ).then((r) => r.json());
    report.failure = {
      httpStatus: failedStart.status,
      status: failedSettled.status,
      requestsUsed: requests - failureBefore,
      summaryFallsBackToOriginal: fallbackRead.report.summary === originalSummary,
      originalStillIntact: JSON.stringify(fallbackRead.report.topics) === originalTopics
    };
  } catch (error) {
    report.error = String(error?.code ?? error?.message ?? error).slice(0, 300);
  } finally {
    report.requests = requests;
    report.usage = finishedUsage(server);
    report.finishedAt = new Date().toISOString();
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    await server.close();
  }

  const targetsOk = report.targets.length === TARGETS.length && report.targets.every((entry) => entry.ok);
  const failureOk = report.failure?.summaryFallsBackToOriginal === true
    && report.failure?.originalStillIntact === true;

  console.log('');
  console.log(`P42 report translation — ${report.provider?.providerId} / ${report.provider?.modelId}`);
  console.log('target   status    requests  cache  changed  script  structured  cachedRead  ok');
  for (const entry of report.targets) {
    console.log([
      String(entry.locale).padEnd(8),
      String(entry.status ?? entry.error ?? '-').padEnd(9),
      String(entry.requestsUsed ?? '-').padEnd(8),
      String(entry.cacheRows ?? '-').padEnd(6),
      entry.summaryChanged ? 'yes' : 'NO ',
      entry.scriptMatch ? 'yes' : 'NO ',
      entry.structuredIntact ? 'yes' : 'NO ',
      entry.cachedReadRequests === 0 ? '0' : String(entry.cachedReadRequests ?? '-'),
      entry.ok ? 'yes' : 'NO'
    ].join('  '));
  }
  console.log('');
  console.log(`requests used: ${requests}/${args.cap}; report: ${REPORT_FILE}`);
  console.log(`original untouched: ${report.originalUntouched}; failure fallback: ${failureOk}`);
  if (capExceeded) return 3;
  return report.blocked ? 2 : (targetsOk && report.originalUntouched && failureOk ? 0 : 1);
}

function finishedUsage(server) {
  const totals = {inputTokens: 0, outputTokens: 0, requests: 0};
  for (const entry of Object.values(server.analysisRunner.state.all())) {
    for (const jobId of [entry?.sessionJobId].filter(Boolean)) {
      const job = getJob(server.db, jobId);
      if (!job?.usage) continue;
      totals.inputTokens += Number(job.usage.inputTokens ?? 0);
      totals.outputTokens += Number(job.usage.outputTokens ?? 0);
      totals.requests += Number(job.usage.requests ?? 0);
    }
  }
  // Translation usage lives in its own table; read it for an honest total.
  const translationUsage = server.db.prepare(
    'SELECT usage_json FROM ai_translation_runs WHERE usage_json IS NOT NULL'
  ).all();
  for (const row of translationUsage) {
    let usage = null;
    try {
      usage = JSON.parse(row.usage_json);
    } catch {
      usage = null;
    }
    totals.inputTokens += Number(usage?.inputTokens ?? 0);
    totals.outputTokens += Number(usage?.outputTokens ?? 0);
    totals.requests += Number(usage?.attempts ?? usage?.requests ?? 0);
  }
  return totals;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error);
  process.exit(1);
});
