#!/usr/bin/env node
/**
 * P42 / I18N-M3 real-provider cross-language long-term memory harness.
 *
 * It proves plan B on the *real* model, not with a simulated provider:
 *   1. one broadcaster and one stable viewer get a Chinese memory first,
 *   2. the same viewer is then updated in Korean, German and Chinese again,
 *   3. after every round it checks that no earlier fact disappeared, that new
 *      statements/summaries use the current task language, that facts never
 *      reference another viewer's chat as evidence, and that the raw chat was
 *      never rewritten.
 *
 * Usage:
 *   node scripts/verify-ai-memory-crosslang.mjs --source-data-dir "E:\LiveMemory data"
 *
 * The script copies only the encrypted provider configuration/credential files
 * into `tests/.tmp/p42-memory-crosslang`. It never prints a key and never writes
 * to the source directory.
 */

import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster} from '../tests/helpers/ai-fixtures.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {getJob} from '../src/storage/repositories/ai-jobs.mjs';
import {getMemory, listFacts} from '../src/storage/repositories/viewer-memory.mjs';

const ROOT = resolve('tests', '.tmp', 'p42-memory-crosslang');
const REPORT_FILE = join(ROOT, 'report.json');

const BROADCASTER_ID = 'youtube:UC_P42_CROSS';
const ALEX = 'youtube:UC_P42_ALEX';
const JIMIN = 'youtube:UC_P42_JIMIN';
const YUKI = 'youtube:UC_P42_YUKI';

/**
 * Four sessions of the same broadcaster. `Alex` is the viewer whose memory we
 * follow; the other two viewers exist so a cross-viewer evidence leak would be
 * detectable. Each round adds a genuinely new personal statement.
 */
const ROUNDS = [
  {
    locale: 'zh-CN',
    sessionId: 'ses_p42_cross_zh_1',
    lines: [
      [ALEX, 'Alex', '我上周开始学吉他了，今天练了两个小时'],
      [ALEX, 'Alex', '吉他真的很有意思，我会继续练下去'],
      [JIMIN, '지민', '안녕하세요! 저도 기타를 배우고 있어요'],
      [JIMIN, '지민', '기타 연습은 조금 어려워요'],
      [YUKI, 'ゆき', '私もギターを練習しています'],
      [YUKI, 'ゆき', '毎日練習しています']
    ]
  },
  {
    locale: 'ko',
    sessionId: 'ses_p42_cross_ko',
    lines: [
      [ALEX, 'Alex', '지난주부터 피아노도 배우기 시작했어요'],
      [ALEX, 'Alex', '피아노 연습이 정말 재미있어요'],
      [ALEX, 'Alex', '요즘 주말마다 등산을 다녀요'],
      [JIMIN, '지민', '저는 요즘 기타 코드를 연습하고 있어요'],
      [YUKI, 'ゆき', 'ピアノは難しいですね'],
      [YUKI, 'ゆき', '그래도 즐겁게 연습하고 있어요']
    ]
  },
  {
    locale: 'de',
    sessionId: 'ses_p42_cross_de',
    lines: [
      [ALEX, 'Alex', 'Ich habe letzte Woche auch angefangen, Klavier zu lernen.'],
      [ALEX, 'Alex', 'Klavier macht mir wirklich Spaß.'],
      [ALEX, 'Alex', 'Ich spiele außerdem jeden Sonntag Badminton.'],
      [JIMIN, '지민', 'Ich übe jeden Tag Gitarre.'],
      [YUKI, 'ゆき', 'Klavier ist wirklich schwer.'],
      [YUKI, 'ゆき', 'Aber ich übe weiter.']
    ]
  },
  {
    locale: 'zh-CN',
    sessionId: 'ses_p42_cross_zh_2',
    lines: [
      [ALEX, 'Alex', '我最近还在学钢琴，也继续练吉他'],
      [ALEX, 'Alex', '每天练琴很开心'],
      [ALEX, 'Alex', '我养了一只猫，叫豆豆'],
      [JIMIN, '지민', '我每天都练吉他'],
      [YUKI, 'ゆき', '钢琴确实很难'],
      [YUKI, 'ゆき', '但我会继续练习']
    ]
  }
];

const NAMES = /지민|ゆき|Alex/g;

function counts(text) {
  const cleaned = String(text ?? '').replace(NAMES, '');
  const han = (cleaned.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  const kana = (cleaned.match(/[\u3040-\u30FF]/g) ?? []).length;
  const hangul = (cleaned.match(/[\uAC00-\uD7A3]/g) ?? []).length;
  const traditional = (cleaned.match(/[這觀眾說與時練習進態歡覺開學會話題們為對從個來後當國語錄]/g) ?? []).length;
  const simplified = (cleaned.match(/[这观众说与时练习进态欢觉开学会话题们为对从个来后当国语录]/g) ?? []).length;
  return {han, kana, hangul, traditional, simplified, cleaned};
}

const SCRIPT_TESTS = {
  'zh-CN': (text) => {
    const c = counts(text);
    return c.han >= 8 && c.kana <= Math.max(1, Math.floor(c.han * 0.02))
      && c.hangul <= Math.max(1, Math.floor(c.han * 0.05));
  },
  ko: (text) => counts(text).hangul >= 5,
  de: (text) => /\b(der|die|das|und|ist|mit|ich|nicht|auch|jeden|jede|jeder|spielt|spielen|lernt|lernen|hat|habe|ein|eine|einen|sonntag|woche|spaß|sehr|seine|seit|mag|macht|geht|kommt|wird|war|sind|für|auf|von|zu|im|am)\b/i.test(String(text ?? '')),
  ja: (text) => counts(text).kana >= 3
};

function parseArgs(argv) {
  const args = {
    sourceDataDir: null,
    cap: 12,
    timeoutMin: 20
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    if (token === '--source-data-dir') args.sourceDataDir = next();
    else if (token === '--cap') args.cap = Math.max(1, Number(next()) || 12);
    else if (token === '--timeout-min') args.timeoutMin = Math.max(1, Number(next()) || 20);
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function seedSession(db, round, startedAt) {
  const session = createSession(db, {
    id: round.sessionId,
    platform: 'youtube',
    platformRoomId: `p42-cross-${round.locale}-${startedAt}`,
    roomTitle: `P42 cross-language ${round.locale}`,
    broadcasterName: 'P42 cross-language',
    broadcasterId: BROADCASTER_ID,
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt
  });
  const ingest = new EventIngest({db});
  round.lines.forEach(([uid, name, content], index) => {
    ingest.record({
      session_id: session.id,
      platform: 'youtube',
      event_type: 'chat',
      viewer_uid: uid.split(':')[1],
      display_name: name,
      occurred_at: startedAt + 1000 + index * 1000,
      content,
      external_id: `${round.sessionId}-${index}`,
      source_quality: 'mock'
    });
  });
  endSession(db, session.id, {
    status: 'ended',
    endedAt: startedAt + 1000 + round.lines.length * 1000,
    reason: 'adapter_end'
  });
  return session;
}

async function waitFor(runner, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (['complete', 'failed', 'needs_action'].includes(status.status)) return status;
    if (Date.now() > deadline) return {timeout: true, status};
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function memorySnapshot(db) {
  const memory = getMemory(db, {broadcasterId: BROADCASTER_ID, viewerId: ALEX});
  if (!memory) return {memory: null, facts: []};
  return {
    memoryId: memory.id,
    summary: memory.summary ?? null,
    facts: listFacts(db, memory.id).map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      topic: fact.topic,
      statement: fact.statement,
      status: fact.status,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt
    }))
  };
}

/** Every evidence row of Alex's facts must point at a chat line Alex wrote. */
function evidenceAudit(db) {
  const rows = db.prepare(`
    SELECT f.id AS fact_id, f.statement, e.event_id, e.session_id, e.seq,
           ev.viewer_id AS event_viewer_id
      FROM memory_facts f
      JOIN memory_fact_evidence e ON e.fact_id = f.id
      LEFT JOIN events ev ON ev.id = e.event_id
     WHERE f.broadcaster_id = ? AND f.viewer_id = ?
  `).all(BROADCASTER_ID, ALEX);
  const bad = rows.filter((row) => !row.event_id || row.event_viewer_id !== ALEX);
  return {rows: rows.length, bad};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See the header of scripts/verify-ai-memory-crosslang.mjs');
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

  rmSync(ROOT, {recursive: true, force: true});  mkdirSync(join(ROOT, 'config'), {recursive: true});
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
    auto: {fetchImpl: countingFetch, maxRetries: 1}
  });

  const report = {
    startedAt: new Date().toISOString(),
    sourceDataDir: args.sourceDataDir,
    requestCap: args.cap,
    rounds: [],
    requests: 0,
    blocked: false,
    notes: [
      'Real provider output. Chat text, prompts and credentials are not written here.',
      'Plan B: facts in different languages may coexist; historical statements are never translated.',
      'The check is machine evidence (script heuristics, schema, stored rows), not a native-speaker review.'
    ]
  };

  try {
    const configs = server.providerConfigStore.list();
    const config = configs.find((entry) => entry.isDefault) ?? configs[0];
    if (!config || config.capabilities?.memory !== true) {
      report.blocked = true;
      report.blockedReason = 'no provider with a passed memory capability test';
      console.error('BLOCKED: no usable memory-capable provider.');
      writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      return 2;
    }
    report.provider = {id: config.id, providerId: config.providerId, modelId: config.modelId};
    addBroadcaster(server.db, {id: BROADCASTER_ID, name: 'P42 cross-language'});

    let previousIds = new Set();

    for (const [index, round] of ROUNDS.entries()) {
      const startedAt = Date.now();
      const session = seedSession(server.db, round, startedAt + index * 3600_000);

      const chatBefore = server.db.prepare(
        "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
      ).all(session.id).map((row) => row.content);

      const before = memorySnapshot(server.db);
      const beforeById = new Map(before.facts.map((fact) => [fact.id, fact]));
      const entry = {
        locale: round.locale,
        sessionId: session.id,
        beforeFacts: before.facts.length,
        beforeSummary: before.summary,
        ok: false
      };

      await server.analysisRunner.start({
        sessionId: session.id,
        locale: round.locale,
        mode: 'memory',
        configId: config.id,
        consent: true
      });
      const finished = await waitFor(server.analysisRunner, session.id, args.timeoutMin * 60 * 1000);
      entry.elapsedMs = Date.now() - startedAt;
      if (finished.timeout) entry.error = 'timeout';
      entry.status = finished.status;
      entry.memoryJobId = finished.memoryJobId ?? null;
      const job = entry.memoryJobId ? getJob(server.db, entry.memoryJobId) : null;
      entry.jobLocale = job?.locale ?? null;
      const resultRow = entry.memoryJobId
        ? server.db.prepare(
          'SELECT result_json FROM ai_results WHERE job_id = ? ORDER BY result_version DESC LIMIT 1'
        ).get(entry.memoryJobId)
        : null;
      entry.resultLocale = resultRow ? (JSON.parse(resultRow.result_json)?.locale ?? null) : null;

      const after = memorySnapshot(server.db);
      entry.afterFacts = after.facts.length;
      entry.summary = after.summary;
      entry.summaryScriptMatch = after.summary ? (SCRIPT_TESTS[round.locale]?.(after.summary) ?? true) : null;

      const afterById = new Map(after.facts.map((fact) => [fact.id, fact]));
      entry.removedFactIds = [...previousIds].filter((id) => !afterById.has(id));
      entry.createdFacts = after.facts.filter((fact) => !beforeById.has(fact.id));
      entry.changedFacts = after.facts.filter((fact) => {
        const prior = beforeById.get(fact.id);
        return prior && (prior.statement !== fact.statement || prior.status !== fact.status);
      });
      entry.newOrChanged = [...entry.createdFacts, ...entry.changedFacts]
        .map((fact) => ({
          id: fact.id,
          topic: fact.topic,
          statement: fact.statement,
          status: fact.status,
          scriptMatch: SCRIPT_TESTS[round.locale]?.(`${fact.topic ?? ''} ${fact.statement}`) ?? true
        }));
      entry.newFactsLanguageOk = entry.newOrChanged.every((fact) => fact.scriptMatch);
      entry.reusedOldLanguage = after.facts
        .filter((fact) => beforeById.has(fact.id) && !entry.changedFacts.some((changed) => changed.id === fact.id))
        .filter((fact) => !(SCRIPT_TESTS[round.locale]?.(`${fact.topic ?? ''} ${fact.statement}`) ?? true))
        .map((fact) => ({id: fact.id, topic: fact.topic, statement: fact.statement}));

      const evidence = evidenceAudit(server.db);
      entry.evidenceRows = evidence.rows;
      entry.crossViewerEvidence = evidence.bad.map((row) => ({
        factId: row.fact_id,
        sessionId: row.session_id,
        seq: row.seq,
        eventViewerId: row.event_viewer_id
      }));

      const chatAfter = server.db.prepare(
        "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
      ).all(session.id).map((row) => row.content);
      entry.chatUnchanged = JSON.stringify(chatBefore) === JSON.stringify(chatAfter);

      entry.schemaOk = entry.status === 'complete' && entry.jobLocale === round.locale
        && (entry.resultLocale === null || entry.resultLocale === round.locale);
      entry.ok = entry.schemaOk
        && entry.removedFactIds.length === 0
        && entry.newFactsLanguageOk
        && entry.summaryScriptMatch !== false
        && entry.crossViewerEvidence.length === 0
        && entry.chatUnchanged
        && entry.afterFacts >= entry.beforeFacts;

      previousIds = new Set(after.facts.map((fact) => fact.id));
      report.rounds.push(entry);
    }

    // Plan-B coexistence: at least two facts whose topics use different scripts
    // must survive together in the final live set.
    const final = memorySnapshot(server.db);
    const scripts = new Set(final.facts.map((fact) => {
      const c = counts(`${fact.topic ?? ''} ${fact.statement}`);
      if (c.hangul > c.han) return 'hangul';
      if (c.han > 0) return 'han';
      return 'latin';
    }));
    report.final = {
      memoryId: final.memoryId,
      summary: final.summary,
      facts: final.facts,
      coexistingScripts: [...scripts],
      planBCoexistence: scripts.size >= 2
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

  console.log('');
  console.log(`P42 cross-language memory — ${report.provider?.providerId} / ${report.provider?.modelId}`);
  console.log('round  locale  status    facts  new/changed  removed  summary  evidence  ok');
  for (const entry of report.rounds) {
    console.log([
      String(report.rounds.indexOf(entry) + 1).padEnd(5),
      entry.locale.padEnd(6),
      String(entry.status ?? entry.error ?? '-').padEnd(9),
      `${entry.beforeFacts}->${entry.afterFacts}`.padEnd(5),
      String(entry.newOrChanged?.length ?? 0).padEnd(11),
      String(entry.removedFactIds?.length ?? 0).padEnd(8),
      entry.summaryScriptMatch === null ? 'n/a' : (entry.summaryScriptMatch ? 'yes' : 'NO '),
      String(entry.crossViewerEvidence?.length ?? 0).padEnd(8),
      entry.ok ? 'yes' : 'NO'
    ].join('  '));
  }
  console.log('');
  console.log(`requests used: ${requests}/${args.cap}; report: ${REPORT_FILE}`);
  if (capExceeded) return 3;
  return report.blocked ? 2 : (report.rounds.every((entry) => entry.ok) ? 0 : 1);
}

function finishedUsage(server) {
  const totals = {inputTokens: 0, outputTokens: 0, requests: 0};
  for (const entry of Object.values(server.analysisRunner.state.all())) {
    for (const jobId of [entry?.memoryJobId].filter(Boolean)) {
      const job = getJob(server.db, jobId);
      if (!job?.usage) continue;
      totals.inputTokens += Number(job.usage.inputTokens ?? 0);
      totals.outputTokens += Number(job.usage.outputTokens ?? 0);
      totals.requests += Number(job.usage.requests ?? 0);
    }
  }
  return totals;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error);
  process.exit(1);
});
