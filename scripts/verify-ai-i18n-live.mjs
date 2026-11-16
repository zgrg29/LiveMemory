#!/usr/bin/env node
/**
 * P41 real-provider acceptance harness for the ten AI output languages.
 *
 * This script never ships in the EXE and never runs inside the test suite. It is
 * the *real model* counterpart of `tests/integration/ai-i18n-locales.test.mjs`,
 * which uses a simulated provider and therefore cannot prove language quality.
 *
 * Usage (Windows, from the repository root):
 *
 *   node scripts/verify-ai-i18n-live.mjs --source-data-dir "E:\LiveMemory data"
 *   node scripts/verify-ai-i18n-live.mjs --source-data-dir "D:\lm" --locales ko,zh-TW,de,pt-BR
 *   node scripts/verify-ai-i18n-live.mjs --provider-config <id> --cap 12
 *
 * What it does:
 *   1. Copies only the *encrypted* provider configuration and credential files
 *      from an existing LiveMemory data directory into an isolated test folder
 *      (`tests/.tmp/ai-i18n-live`). It never prints a key and never writes to the
 *      source directory.
 *   2. Seeds one synthetic session with mixed-language chat and real viewers.
 *   3. Runs one combined analysis task per requested language with the user's own
 *      provider and a hard request cap.
 *   4. Verifies, from the *stored* results: the task/result locale, that the
 *      prose really is in the target language (script/word heuristics), that JSON
 *      keys and enums were not translated, that no `viewer_id` leaked into the
 *      memory answer, and that the raw chat was never rewritten.
 *   5. Writes a sanitized JSON report and prints a summary. Chat text, prompts and
 *      credentials are never written to the report.
 *
 * Exit codes: 0 all requested languages passed, 1 some failed, 2 blocked (no
 * usable provider configuration), 3 the request cap would have been exceeded.
 */

import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, T0, HOUR} from '../tests/helpers/ai-fixtures.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {AI_OUTPUT_LOCALES} from '../src/shared/locale.mjs';
import {outputLanguage} from '../src/ai/prompts/language.mjs';
import {getJob} from '../src/storage/repositories/ai-jobs.mjs';
import {getSession} from '../src/storage/repositories/sessions.mjs';
import {getMemory, listFacts} from '../src/storage/repositories/viewer-memory.mjs';

let ROOT = resolve('tests', '.tmp', 'ai-i18n-live');
let REPORT_FILE = join(ROOT, 'report.json');
const DEFAULT_LOCALES = ['ko', 'zh-TW', 'de', 'pt-BR'];

/**
 * Realistic mixed-language chat. Unlike `seedSession`'s placeholder messages it
 * contains explicit personal statements, so the memory stage really has
 * something to extract and the language of the produced facts can be checked.
 * The viewers answer in Korean / Japanese / Chinese-English, exactly the mixed
 * input a real channel produces.
 */
const REAL_CHAT = [
  {uid: 'UC_REAL_0', name: '지민', content: '안녕하세요! 지난달부터 기타를 배우기 시작했어요'},
  {uid: 'UC_REAL_1', name: 'ゆき', content: '最近ギターを始めました。毎日練習しています'},
  {uid: 'UC_REAL_2', name: 'Alex', content: '我上周开始学吉他了，今天练了两个小时'},
  {uid: 'UC_REAL_0', name: '지민', content: '오늘도 기타 연습했어요. 코드가 조금 늘었네요'},
  {uid: 'UC_REAL_1', name: 'ゆき', content: 'ギターの練習、少しずつ上手くなってきました'},
  {uid: 'UC_REAL_2', name: 'Alex', content: '吉他真的很有意思，我会继续练下去'},
  {uid: 'UC_REAL_0', name: '지민', content: '이 방송 정말 좋아요'},
  {uid: 'UC_REAL_1', name: 'ゆき', content: '配信ありがとうございます'},
  {uid: 'UC_REAL_2', name: 'Alex', content: 'Great stream, thanks!'}
];

/** Seed a session whose chat really contains personal statements. */
function seedRealChatSession(db, {id, roomId, broadcasterId, startedAt}) {
  const session = createSession(db, {
    id,
    platform: 'youtube',
    platformRoomId: roomId,
    roomTitle: `P41 ${id}`,
    broadcasterName: 'P41 real provider check',
    broadcasterId,
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt
  });
  const ingest = new EventIngest({db});
  REAL_CHAT.forEach((entry, index) => {
    ingest.record({
      session_id: session.id,
      platform: 'youtube',
      event_type: 'chat',
      viewer_uid: entry.uid,
      display_name: entry.name,
      occurred_at: startedAt + 1000 + index * 1000,
      content: entry.content,
      external_id: `p41-${id}-${index}`,
      source_quality: 'mock'
    });
  });
  endSession(db, session.id, {
    status: 'ended',
    endedAt: startedAt + 1000 + REAL_CHAT.length * 1000,
    reason: 'adapter_end'
  });
  return session;
}

/** Keys every session report must keep in English (protocol mirror). */
const SESSION_KEYS = [
  'protocol', 'schema_version', 'analysis_scope', 'session_topics', 'topics',
  'summary', 'title', 'key_points', 'confidence', 'evidence', 'message_refs'
];

/**
 * Keys every stored memory result must keep in English. The program hydrates the
 * compact model answer (`viewers` → `viewer_memory_updates` + stable
 * `viewer_id`), so those two keys legitimately differ; the operation keys must
 * never be translated when operations exist.
 */
const MEMORY_KEYS = ['viewer_memory_updates', 'viewer_id', 'operations'];
const MEMORY_OPERATION_KEYS = ['op', 'statement'];


/**
 * Viewer names from `REAL_CHAT` are quoted verbatim by the model when it
 * introduces who said what. They are proper nouns and legitimately stay in the
 * original script, so they must not make a Chinese report look "Japanese". The
 * earlier strict `no kana at all` rule produced exactly that false negative on
 * 2026-11-16 (P42); stripping the known names and measuring the script *ratio*
 * is the correct assertion, not a relaxed one.
 */
const QUOTED_NAMES = /지민|ゆき|Alex/g;

/** Count characters of one script family. */
function scriptCounts(text) {
  const han = (text.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30FF]/g) ?? []).length;
  const hangul = (text.match(/[\uAC00-\uD7A3]/g) ?? []).length;
  return {han, kana, hangul};
}

/** Traditional-only vs simplified-only markers, for zh-TW wording. */
const TRADITIONAL_ONLY = /[這觀眾說與時練習進態歡覺開學會話題們為對從個來後當國語錄]/g;
const SIMPLIFIED_ONLY = /[这观众说与时练习进态欢觉开学会话题们为对从个来后当国语录]/g;

const SCRIPT_TESTS = {
  ko: (text) => scriptCounts(text).hangul >= 20,
  ja: (text) => scriptCounts(text).kana >= 10,
  'zh-CN': (text) => {
    const {han, kana, hangul} = scriptCounts(text.replace(QUOTED_NAMES, ''));
    return han >= 4 && kana <= Math.max(3, Math.floor(han * 0.02))
      && hangul <= Math.max(3, Math.floor(han * 0.05));
  },
  'zh-TW': (text) => {
    const cleaned = text.replace(QUOTED_NAMES, '');
    const {han, kana, hangul} = scriptCounts(cleaned);
    const traditional = (cleaned.match(TRADITIONAL_ONLY) ?? []).length;
    const simplified = (cleaned.match(SIMPLIFIED_ONLY) ?? []).length;
    return han >= 4 && kana <= Math.max(3, Math.floor(han * 0.02))
      && hangul <= Math.max(3, Math.floor(han * 0.05))
      && traditional >= 1 && simplified <= Math.max(1, Math.floor(traditional * 0.1));
  },
  es: (text) => /\b(el|la|los|las|de|que|con|una|para)\b/i.test(text),
  'pt-BR': (text) => /\b(o|a|os|as|de|que|com|uma|para|não)\b/i.test(text),
  fr: (text) => /\b(le|la|les|des|de|que|avec|une|pour)\b/i.test(text),
  de: (text) => /\b(der|die|das|und|ist|mit|eine|für|nicht)\b/i.test(text),
  id: (text) => /\b(yang|dan|di|dengan|untuk|tidak|adalah)\b/i.test(text),
  en: (text) => /\b(the|and|with|that|for)\b/i.test(text)
};

/**
 * Per-fact language check. A single fact is often 3–8 words ("Spielt jeden
 * Sonntag Badminton"), which is too short for stop-word detection to be fair.
 * For short facts we therefore assert the script family (Hangul / kana / Han /
 * Latin); the *summary* above still asserts the exact language with a prose-sized
 * sample. A Chinese fact inside a German memory would still fail here.
 */
const LATIN_ONLY = (text) => {
  const c = scriptCounts(text);
  const latin = (String(text).match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  return latin >= 3 && c.han === 0 && c.hangul === 0 && c.kana === 0;
};

const FACT_TESTS = {
  ko: (text) => scriptCounts(text).hangul >= 3,
  ja: (text) => scriptCounts(text).kana >= 2,
  'zh-CN': (text) => scriptCounts(text.replace(QUOTED_NAMES, '')).han >= 2,
  'zh-TW': (text) => scriptCounts(text.replace(QUOTED_NAMES, '')).han >= 2,
  es: LATIN_ONLY,
  'pt-BR': LATIN_ONLY,
  fr: LATIN_ONLY,
  de: LATIN_ONLY,
  id: LATIN_ONLY,
  en: LATIN_ONLY
};

/**
 * Every key the result schema allows. `additionalProperties: false` means a
 * model that translated a field name would fail validation; collecting the keys
 * from the schema lets this harness also *report* that the names are still the
 * English protocol names.
 */
const SCHEMA_KEYS = (() => {
  const schema = JSON.parse(readFileSync(resolve('src', 'ai', 'schemas', 'analysis-result-v1.3.schema.json'), 'utf8'));
  const keys = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.oneOf)) for (const entry of node.oneOf) walk(entry);
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        keys.add(key);
        walk(child);
      }
    }
    if (node.items) walk(node.items);
  };
  walk(schema);
  return keys;
})();

function parseArgs(argv) {
  const args = {
    locales: DEFAULT_LOCALES,
    cap: 14,
    providerConfig: null,
    sourceDataDir: null,
    timeoutMin: 20,
    reuse: false,
    mode: 'both',
    outDir: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    if (token === '--source-data-dir') args.sourceDataDir = next();
    else if (token === '--locales') args.locales = String(next() ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (token === '--cap') args.cap = Math.max(1, Number(next()) || 14);
    else if (token === '--provider-config') args.providerConfig = next();
    else if (token === '--timeout-min') args.timeoutMin = Math.max(1, Number(next()) || 20);
    else if (token === '--mode') args.mode = ['both', 'session', 'memory'].includes(next()) ? argv[index] : 'both';
    else if (token === '--out-dir') args.outDir = next();
    else if (token === '--reuse') args.reuse = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`LiveMemory P41 real-provider AI language verification

  --source-data-dir <dir>  existing LiveMemory data folder with config/ai-providers.json
                           and secrets/ai-keys.json (encrypted credentials)
  --locales <a,b,c>        languages to verify (default: ${DEFAULT_LOCALES.join(',')})
  --cap <n>                hard provider request cap (default: 14)
  --provider-config <id>   use this configuration instead of the default one
  --mode <both|session|memory>  which task to run (default: both)
  --timeout-min <n>        per-task timeout in minutes (default: 20)
  --out-dir <dir>          isolated data folder (default: tests/.tmp/ai-i18n-live)
  --reuse                  re-verify the tasks already stored in --out-dir instead
                           of spending new provider requests (never wipes the folder)
`);
}

async function waitFor(runner, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) return {timeout: true, status};
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function collectProse(result) {
  const topics = result?.session_topics ?? {};
  const pieces = [topics.summary];
  for (const topic of topics.topics ?? []) pieces.push(topic.title, topic.summary, ...(topic.key_points ?? []));
  for (const item of topics.highlights ?? []) pieces.push(item.reason, item.clip_suggestion, item.title);
  for (const item of topics.disputes ?? []) pieces.push(item.note, item.title);
  return pieces.filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n');
}

function rawKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) rawKeys(entry, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      rawKeys(child, out);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const unknown = args.locales.filter((code) => !AI_OUTPUT_LOCALES.includes(code));
  if (unknown.length > 0) {
    console.error(`Unknown AI output language(s): ${unknown.join(', ')}`);
    return 2;
  }
  if (!args.sourceDataDir) {
    console.error('Missing --source-data-dir (see --help). No provider configuration is read without it.');
    return 2;
  }
  const configFile = join(args.sourceDataDir, 'config', 'ai-providers.json');
  const keyFile = join(args.sourceDataDir, 'secrets', 'ai-keys.json');
  const aesFile = join(args.sourceDataDir, 'secrets', 'ai-keys.key');
  if (!existsSync(configFile) || !existsSync(keyFile)) {
    console.error('BLOCKED: the source data directory has no AI provider configuration/credentials.');
    return 2;
  }

  if (args.outDir) {
    ROOT = resolve(args.outDir);
    REPORT_FILE = join(ROOT, 'report.json');
  }

  // `--reuse` must never wipe the folder: it exists to re-read stored results
  // without spending provider requests.
  if (!args.reuse) rmSync(ROOT, {recursive: true, force: true});
  mkdirSync(join(ROOT, 'config'), {recursive: true});
  mkdirSync(join(ROOT, 'secrets'), {recursive: true});
  cpSync(configFile, join(ROOT, 'config', 'ai-providers.json'));
  cpSync(keyFile, join(ROOT, 'secrets', 'ai-keys.json'));
  // The per-install AES key is required to decrypt the copied credential file.
  // It is a local key file, never a provider key, and stays inside tests/.tmp.
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
    sourceDataDir: args.sourceDataDir, // path only, never contents
    requestCap: args.cap,
    mode: args.mode,
    languages: [],
    requests: 0,
    usage: {},
    blocked: false,
    notes: [
      'Real provider output. Chat text, prompts and credentials are never written to this report.',
      'Language quality is judged by script/word heuristics plus strict schema validation; ' +
      'this is machine evidence, not a native-speaker review.',
      'The synthetic chat contains realistic personal statements so the memory stage can be checked.'
    ]
  };

  try {
    const configs = server.providerConfigStore.list();
    const config = args.providerConfig
      ? configs.find((entry) => entry.id === args.providerConfig)
      : (configs.find((entry) => entry.isDefault) ?? configs[0]);
    if (!config) {
      report.blocked = true;
      report.blockedReason = 'no provider configuration in the source data directory';
      console.error('BLOCKED: no usable AI provider configuration.');
      writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      return 2;
    }
    if (config.capabilities?.session !== true || config.capabilities?.memory !== true) {
      report.blocked = true;
      report.blockedReason = 'the provider has not passed the session+memory capability test';
      console.error('BLOCKED: the selected provider has not passed the capability test.');
      writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      return 2;
    }
    report.provider = {id: config.id, providerId: config.providerId, modelId: config.modelId};

    // One broadcaster per language keeps each run's long-term memory fresh, so a
    // new fact is really written in that language instead of continuing facts
    // from a previous language (which is also valid plan-B behaviour, but does
    // not demonstrate new-language fact creation).
    const broadcasterFor = (locale) => `youtube:UC_REAL_I18N_${locale.replace(/-/g, '_')}`;
    for (const [index, locale] of args.locales.entries()) {
      const sessionLocale = locale;
      const broadcasterId = broadcasterFor(locale);
      addBroadcaster(server.db, {id: broadcasterId, name: `P41 ${locale}`});
      const sessionId = `ses_real_i18n_${locale.replace(/-/g, '_')}`;
      const existing = args.reuse ? getSession(server.db, sessionId) : null;
      const session = existing ?? seedRealChatSession(server.db, {
        id: sessionId,
        roomId: `real-${locale}`,
        broadcasterId,
        startedAt: T0 + index * HOUR
      });
      const chatBefore = server.db.prepare(
        "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
      ).all(session.id).map((row) => row.content);

      const entry = {
        locale: sessionLocale,
        ok: false,
        // Explicit nulls keep the success check unambiguous for memory-only tasks.
        resultLocale: null,
        sessionKeysIntact: null,
        unknownKeys: [],
        memoryKeysIntact: null,
        memoryScriptMatch: null,
        viewerIdsResolvedLocally: null
      };
      const startedAt = Date.now();
      try {
        const persisted = args.reuse ? server.analysisRunner.state.get(session.id) : null;
        let finished;
        if (persisted?.status === 'complete' && (persisted.sessionJobId || persisted.memoryJobId)) {
          // Re-verification only: reuse the stored result of an earlier paid run.
          finished = persisted;
          entry.reused = true;
          entry.elapsedMs = null;
        } else {
          await server.analysisRunner.start({
            sessionId: session.id,
            locale: sessionLocale,
            mode: args.mode,
            configId: config.id,
            consent: true
          });
          finished = await waitFor(
            server.analysisRunner,
            session.id,
            (value) => value.status === 'complete' || value.status === 'failed' || value.status === 'needs_action',
            args.timeoutMin * 60 * 1000
          );
          entry.elapsedMs = Date.now() - startedAt;
        }
        if (finished.timeout) {
          entry.error = 'timeout';
          report.languages.push(entry);
          continue;
        }
        entry.status = finished.status;
        entry.sessionJobId = finished.sessionJobId ?? null;
        entry.memoryJobId = finished.memoryJobId ?? null;
        if (finished.status !== 'complete') {
          entry.error = finished.error?.code ?? finished.status;
          report.languages.push(entry);
          continue;
        }
        const sessionJob = finished.sessionJobId ? getJob(server.db, finished.sessionJobId) : null;
        const memoryJob = finished.memoryJobId ? getJob(server.db, finished.memoryJobId) : null;
        entry.sessionJobLocale = sessionJob?.locale ?? null;
        entry.memoryJobLocale = memoryJob?.locale ?? null;
        // A memory-only task has no session job; the memory job carries the
        // language snapshot in that case.
        entry.jobLocale = sessionJob?.locale ?? memoryJob?.locale ?? null;
        entry.promptVersion = sessionJob?.promptVersion ?? memoryJob?.promptVersion ?? null;
        if (sessionJob) {
          const resultRow = server.db.prepare(
            `SELECT result_json FROM ai_results WHERE job_id = ?
             ORDER BY result_version DESC LIMIT 1`
          ).get(finished.sessionJobId);
          const result = resultRow ? JSON.parse(resultRow.result_json) : null;
          entry.resultLocale = result?.locale ?? null;
          const prose = collectProse(result);
          entry.proseChars = prose.length;
          entry.scriptMatch = Boolean(prose) && (SCRIPT_TESTS[locale]?.(prose) ?? true);
          const keys = [...rawKeys(result)];
          entry.sessionKeysIntact = SESSION_KEYS.every((key) => keys.includes(key));
          // A translated field name would be a key outside the schema; because the
          // schema forbids additional properties this is also what makes a renamed
          // `summary`/`session_topics` fail the task instead of passing silently.
          entry.unknownKeys = keys.filter((key) => !SCHEMA_KEYS.has(key));
          entry.proseSample = prose.slice(0, 80);
          entry.example = outputLanguage(locale).example.summary;
        }

        // The memory answer is validated and applied locally. The *stored* result
        // already has refs mapped back to stable viewer ids by the program, so
        // `viewer_id` is expected there; what must hold is that the protocol keys
        // are unchanged and that every id belongs to a viewer of this session
        // (the model can never invent one).
        if (finished.memoryJobId) {
          const memoryRow = server.db.prepare(
            `SELECT result_json FROM ai_results WHERE job_id = ?
             ORDER BY result_version DESC LIMIT 1`
          ).get(finished.memoryJobId);
          const memoryResult = memoryRow ? JSON.parse(memoryRow.result_json) : null;
          if (memoryResult) {
            const memoryKeys = [...rawKeys(memoryResult)];
            const memoryOperations = (memoryResult.viewer_memory_updates ?? [])
              .flatMap((update) => update.operations ?? []);
            entry.memoryKeysIntact = MEMORY_KEYS.every((key) => memoryKeys.includes(key))
              && (memoryOperations.length === 0
                || MEMORY_OPERATION_KEYS.every((key) => memoryKeys.includes(key)));
            entry.memoryLocale = memoryResult.locale ?? null;
            const knownViewers = new Set(server.db.prepare(
              'SELECT DISTINCT viewer_id FROM viewer_sessions WHERE session_id = ?'
            ).all(session.id).map((row) => row.viewer_id));
            const answeredViewers = (memoryResult.viewer_memory_updates ?? [])
              .map((update) => update.viewer_id)
              .filter((id) => typeof id === 'string');
            entry.answeredViewers = answeredViewers.length;
            entry.viewerIdsResolvedLocally = answeredViewers.length > 0
              && answeredViewers.every((id) => knownViewers.has(id));
            const memoryProse = (memoryResult.viewer_memory_updates ?? [])
              .flatMap((update) => [update.summary, ...(update.operations ?? []).map((op) => op.statement)])
              .filter((value) => typeof value === 'string' && value.trim().length > 0)
              .join('\n');
            entry.memoryProseChars = memoryProse.length;
            entry.memoryScriptMatch = memoryProse.length === 0
              ? null
              : (SCRIPT_TESTS[locale]?.(memoryProse) ?? true);
          }
        } else if (args.mode === 'memory') {
          entry.error = 'memory job was not created';
        }

        const viewerRows = server.db.prepare(
          'SELECT viewer_id FROM viewer_sessions WHERE session_id = ? GROUP BY viewer_id'
        ).all(session.id);
        const facts = [];
        for (const row of viewerRows) {
          const memory = getMemory(server.db, {broadcasterId: session.broadcaster_id, viewerId: row.viewer_id});
          if (!memory) continue;
          for (const fact of listFacts(server.db, memory.id)) facts.push(fact);
        }
        entry.facts = facts.length;
        entry.factProseChars = facts.reduce((sum, fact) => sum + String(fact.statement ?? '').length, 0);
        const factMatches = facts.filter((fact) => (
          FACT_TESTS[locale]?.(`${fact.topic ?? ''} ${fact.statement ?? ''}`) ?? true
        )).length;
        entry.factLocaleRatio = facts.length === 0 ? null : factMatches / facts.length;
        entry.factScriptMatch = facts.length === 0
          ? null
          : entry.factLocaleRatio >= 0.8;
        // Plan B: facts keep their own language. A cross-language duplicate is
        // accepted, so only "no crash / no loss" is asserted here.
        entry.factTopics = facts.map((fact) => String(fact.topic ?? '')).slice(0, 8);
        entry.statuses = [...new Set(facts.map((fact) => fact.status))].sort();

        const chatAfter = server.db.prepare(
          "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
        ).all(session.id).map((row) => row.content);
        entry.chatUnchanged = JSON.stringify(chatBefore) === JSON.stringify(chatAfter);

        entry.ok = entry.status === 'complete'
          && entry.jobLocale === locale
          && (entry.resultLocale === null || entry.resultLocale === locale)
          && (entry.scriptMatch ?? true)
          && (entry.sessionKeysIntact ?? true)
          && (entry.unknownKeys?.length ?? 0) === 0
          && (entry.memoryLocale === undefined || entry.memoryLocale === locale)
          && (entry.memoryScriptMatch ?? true)
          && (entry.factScriptMatch ?? true)
          && (entry.memoryKeysIntact ?? true)
          && (entry.viewerIdsResolvedLocally ?? true)
          && entry.chatUnchanged;
      } catch (error) {
        entry.error = String(error?.code ?? error?.message ?? error).slice(0, 200);
      }
      report.languages.push(entry);
    }
  } finally {
    report.requests = requests;
    report.usage = finishedUsage(server);
    report.finishedAt = new Date().toISOString();
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    await server.close();
  }

  console.log('');
  console.log(`P41 real provider — ${report.provider.providerId} / ${report.provider.modelId} (cap ${args.cap} requests)`);
  console.log('language  status    jobLocale  report  keys  memory  facts  chat  ms');
  for (const entry of report.languages) {
    console.log([
      entry.locale.padEnd(8),
      String(entry.status ?? entry.error ?? 'blocked').padEnd(9),
      String(entry.jobLocale ?? '-').padEnd(10),
      entry.scriptMatch ? 'yes  ' : (entry.scriptMatch === null ? 'n/a  ' : 'NO   '),
      entry.sessionKeysIntact ? 'ok ' : (entry.sessionKeysIntact === null ? 'n/a ' : 'NO '),
      entry.memoryScriptMatch === null ? 'n/a ' : (entry.memoryScriptMatch ? 'yes ' : 'NO  '),
      String(entry.facts ?? 0).padEnd(5),
      entry.chatUnchanged ? 'ok' : 'NO',
      String(entry.elapsedMs ?? '-')
    ].join('  '));
  }
  console.log('');
  console.log(`requests used: ${requests}/${args.cap}; report: ${REPORT_FILE}`);
  if (capExceeded) return 3;
  return report.languages.every((entry) => entry.ok) ? 0 : 1;
}

function finishedUsage(server) {
  const entries = Object.values(server.analysisRunner.state.all());
  const totals = {inputTokens: 0, outputTokens: 0, requests: 0};
  for (const entry of entries) {
    const jobIds = [entry?.sessionJobId, entry?.memoryJobId].filter(Boolean);
    for (const jobId of jobIds) {
      const job = getJob(server.db, jobId);
      if (!job?.usage) continue;
      totals.inputTokens += Number(job.usage.inputTokens ?? 0);
      totals.outputTokens += Number(job.usage.outputTokens ?? 0);
      totals.requests += Number(job.usage.requests ?? 0);
    }
  }
  return totals;
}

main().then((code) => {
  process.exit(code);
}, (error) => {
  console.error(error);
  process.exit(1);
});
