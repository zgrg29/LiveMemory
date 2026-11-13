import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {addBroadcaster, seedSession, T0, makeBatchResult, readBatchPackage} from '../helpers/ai-fixtures.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {createSessionAnalysisJob, createViewerMemoryJob} from '../../src/ai/export/split-jobs.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';

/**
 * End-to-end tests for report reading-language translation.
 *
 * Every provider call is a local mock. The assertions focus on the guarantees
 * that matter most:
 *   - translation never re-runs session/memory analysis;
 *   - cached languages do not spend more tokens;
 *   - identity, topic keys, certainty, versions and evidence are unchanged;
 *   - failed/missing paragraphs can be retried without losing good ones;
 *   - a new result version cannot reuse an old translation.
 */

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTranslation(server, sessionId, locale, predicate = (translation) => translation.status !== 'running') {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const status = await server.translationService.getStatus(sessionId, locale);
    if (predicate(status.translation)) return status.translation;
    await delay(80);
  }
  throw new Error(`translation did not settle for ${locale}`);
}

function readPackageFiles(exportsDir, pkg) {
  const buffer = readFileSync(join(exportsDir, pkg.fileName));
  const names = ['manifest.json', 'instructions.md', 'messages.jsonl', 'session_context.json'];
  const files = {};
  for (const name of names) {
    try {
      files[name] = readZipEntry(buffer, name).toString('utf8');
    } catch {
      files[name] = null;
    }
  }
  files.manifest = JSON.parse(files['manifest.json']);
  files.messages = files['messages.jsonl']
    ? files['messages.jsonl'].split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return files;
}

function makeJapaneseResult(manifest, messages, overrides = {}) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.3.0',
    analysis_scope: 'session',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: 'ja',
    session_topics: {
      summary: '視聴者は新作ゲームの難易度について議論していた。',
      topics: [{
        title: 'ゲームの難易度',
        started_at: first.at,
        ended_at: last.at,
        summary: '難しいという意見が多かった。',
        key_points: ['難しい', 'それは楽しい'],
        confidence: 0.8,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [{
        at: first.at,
        tone: 'mixed',
        note: '反応は分かれた。',
        confidence: 0.5
      }],
      disputes: [{
        summary: '難易度について意見が対立した。',
        note: '断定はできない。',
        viewpoints: ['難しい', 'ちょうどいい'],
        started_at: first.at,
        confidence: 0.4,
        evidence: 'inferred',
        message_refs: [1]
      }],
      highlights: [{
        started_at: first.at,
        ended_at: last.at,
        title: '同時コメント',
        reason: 'コメントが増えた。',
        clip_suggestion: 'この区間を確認',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [1]
      }]
    },
    viewer_profiles: [],
    ...overrides
  };
}

function seedLongTermMemory(server, {session, broadcasterId, summary = 'ゲームとテストについて話す視聴者。'}) {
  const viewerId = server.db.prepare(
    'SELECT viewer_id FROM viewer_sessions WHERE session_id = ? ORDER BY message_count DESC LIMIT 1'
  ).get(session.id)?.viewer_id;
  assert.ok(viewerId, 'session must have an identifiable viewer');
  const now = T0 + 60000;
  server.db.prepare(`
    INSERT INTO viewer_memories (
      id, broadcaster_id, viewer_id, status, version, summary, summary_certainty,
      first_memory_at, last_update_at, last_session_id, created_at, updated_at
    ) VALUES ('vm_test', ?, ?, 'active', 2, ?, 'inferred', ?, ?, ?, ?, ?)
  `).run(broadcasterId, viewerId, summary, now, now, session.id, now, now);
  server.db.prepare(`
    INSERT INTO memory_facts (
      id, memory_id, broadcaster_id, viewer_id, kind, topic, statement, certainty,
      status, status_reason, confidence, dedupe_key, evidence_status, evidence_count,
      evidence_available, source_kind, source_session_id, source_job_id, source_result_id,
      source_label, valid_from, valid_until, superseded_by, conflicts_with, user_verified,
      first_seen_at, last_confirmed_at, created_at, updated_at
    ) VALUES (
      'mfc_test', 'vm_test', ?, ?, 'interest', 'ゲーム', '新作ゲームを楽しみにしている。',
      'stated', 'active', NULL, 0.9, 'interest:ゲーム', 'none', 0, 0,
      'session_analysis', ?, NULL, NULL, 'ai_session', NULL, NULL, NULL, NULL, 0,
      ?, ?, ?, ?
    )
  `).run(broadcasterId, viewerId, session.id, now, now, now, now);
  return {viewerId, memoryId: 'vm_test', factId: 'mfc_test'};
}

function translationFetch({state}) {
  return async (_url, options) => {
    state.calls += 1;
    if (state.mode === 'fail') {
      throw new Error('mock network down');
    }
    const body = JSON.parse(options.body);
    const user = body.messages[body.messages.length - 1].content;
    const match = /Input JSON:\n\n([\s\S]*?)\n\nReturn only/.exec(user);
    assert.ok(match, 'translation prompt must include the input JSON');
    const input = JSON.parse(match[1]);
    state.lastInput = input;
    state.lastUser = user;
    if (state.mode === 'invalid') {
      return new Response('not json at all', {
        status: 200,
        headers: {'content-type': 'text/plain'}
      });
    }
    const target = /Target language: ([^\n]+)/.exec(user)?.[1] ?? 'unknown';
    let items = input.items.map((item) => ({
      id: item.id,
      text: `${target.startsWith('Japanese') ? '【JA】' : target.startsWith('Simplified') ? '【ZH】' : '【EN】'}${item.text}`
    }));
    if (state.mode === 'omit' && state.omitOnce) {
      state.omitOnce = false;
      items = items.slice(1);
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {content: JSON.stringify({items})},
        finish_reason: 'stop'
      }],
      usage: {prompt_tokens: 40, completion_tokens: 30}
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

async function setupServer(t, state) {
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    auto: {
      fetchImpl: translationFetch({state}),
      maxRetries: 0,
      chunkChars: 20000
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 8, viewerCount: 2});
  const created = await createSessionAnalysisJob({
    db: server.db,
    sessionId: session.id,
    locale: 'ja',
    exportsDir: server.paths.exports,
    tokenBudget: 24000
  });
  const files = readPackageFiles(server.paths.exports, created.packages[0]);
  importAnalysisResult({
    db: server.db,
    text: JSON.stringify(makeJapaneseResult(files.manifest, files.messages)),
    source: 'api'
  });
  const memory = seedLongTermMemory(server, {
    session,
    broadcasterId: session.broadcaster_id
  });
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    modelId: 'mock-translator',
    apiKey: 'test-key',
    allowLocalNetwork: true,
    pricingStatus: 'unknown'
  });
  return {server, session, config, memory, files};
}

test('a saved Japanese report can be read in Chinese without re-running analysis', async (t) => {
  const state = {calls: 0, mode: 'ok'};
  const {server, session, config, memory} = await setupServer(t, state);
  const base = server.url;

  const before = {
    results: Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c),
    jobs: server.db.prepare('SELECT id, usage_json FROM ai_jobs ORDER BY id').all(),
    messages: Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_job_messages').get().c),
    fact: server.db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(memory.factId),
    memoryHead: server.db.prepare('SELECT * FROM viewer_memories WHERE id = ?').get(memory.memoryId)
  };

  const original = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.equal(original.status, 200);
  assert.equal(original.payload.translation.status, 'missing');
  assert.match(original.payload.report.summary, /視聴者/);
  assert.equal(state.calls, 0, 'reading a missing translation must not call the provider');

  const started = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(started.status, 202, JSON.stringify(started.payload));
  assert.ok(['running', 'complete'].includes(started.payload.translation.status));
  const settled = await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');
  assert.equal(settled.translated, settled.total);
  assert.equal(state.calls, 1);

  const translated = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.equal(translated.status, 200);
  assert.equal(translated.payload.translation.status, 'complete');
  assert.match(translated.payload.report.summary, /【ZH】/);
  assert.match(translated.payload.report.topics[0].title, /【ZH】/);
  assert.match(translated.payload.report.sentiment[0].note, /【ZH】/);
  // Long-term facts are translated as display text only.
  const profile = translated.payload.longTermProfiles.items[0];
  assert.equal(profile.facts[0].id, memory.factId);
  assert.equal(profile.facts[0].topic, 'ゲーム', 'topic is a stable matching key and must not be translated');
  assert.equal(profile.facts[0].certainty, 'stated');
  assert.equal(profile.version, 2);
  assert.match(profile.facts[0].statement, /【ZH】/);
  assert.match(profile.summary, /【ZH】/);

  // The stored original report is unchanged; selecting the source language
  // returns it without using the translation cache.
  const stillOriginal = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
  assert.equal(stillOriginal.payload.translation.status, 'original');
  assert.match(stillOriginal.payload.report.summary, /視聴者/);
  assert.doesNotMatch(stillOriginal.payload.report.summary, /【ZH】/);

  // No analysis was re-run and no analysis usage was changed.
  assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), before.results);
  assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_job_messages').get().c), before.messages);
  assert.deepEqual(server.db.prepare('SELECT id, usage_json FROM ai_jobs ORDER BY id').all(), before.jobs);
  assert.deepEqual(
    server.db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(memory.factId),
    before.fact
  );
  assert.deepEqual(
    server.db.prepare('SELECT * FROM viewer_memories WHERE id = ?').get(memory.memoryId),
    before.memoryHead
  );

  // Translation usage is stored separately from analysis usage.
  const run = server.db.prepare('SELECT * FROM ai_translation_runs ORDER BY started_at DESC LIMIT 1').get();
  assert.equal(run.status, 'complete');
  const usage = JSON.parse(run.usage_json);
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cost, null, 'unknown pricing must not be reported as a zero cost');

  // Reading the same language again reuses the cache and makes no request.
  const callsAfterFirst = state.calls;
  const again = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(again.status, 202);
  assert.equal(again.payload.translation.status, 'complete');
  assert.equal(state.calls, callsAfterFirst, 'cached language must not call the provider');

  // A second target language is generated once; switching back is cached.
  const en = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'en', configId: config.id, consent: true}
  });
  assert.equal(en.status, 202);
  await waitForTranslation(server, session.id, 'en', (translation) => translation.status === 'complete');
  assert.equal(state.calls, callsAfterFirst + 1);
  const enReport = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=en`);
  assert.match(enReport.payload.report.summary, /【EN】/);
  assert.equal(enReport.payload.longTermProfiles.items[0].facts[0].topic, 'ゲーム');
  const backToZh = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(backToZh.status, 202);
  assert.equal(backToZh.payload.translation.status, 'complete');
  assert.equal(state.calls, callsAfterFirst + 1, 'switching back must reuse the Chinese cache');

  // Deleting a viewer memory also removes its display translations; the
  // tombstone remains so an older package cannot resurrect the knowledge.
  const {deleteMemory} = await import('../../src/storage/repositories/viewer-memory.mjs');
  deleteMemory(server.db, {memoryId: memory.memoryId, reason: 'user', now: T0 + 180000});
  const translatedFactRows = Number(server.db.prepare(
    "SELECT COUNT(*) AS c FROM ai_translations WHERE target_kind = 'memory_fact' AND target_id = ?"
  ).get(memory.factId).c);
  const translatedSummaryRows = Number(server.db.prepare(
    "SELECT COUNT(*) AS c FROM ai_translations WHERE target_kind = 'memory_summary' AND target_id = ?"
  ).get(memory.memoryId).c);
  assert.equal(translatedFactRows, 0);
  assert.equal(translatedSummaryRows, 0);
  assert.equal(
    server.db.prepare('SELECT status FROM viewer_memories WHERE id = ?').get(memory.memoryId).status,
    'deleted'
  );
});

test('a partially failed translation keeps good paragraphs and retries only the failed ones', async (t) => {
  const state = {calls: 0, mode: 'omit', omitOnce: true};
  const {server, session, config} = await setupServer(t, state);
  const base = server.url;

  const started = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(started.status, 202);
  const partial = await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status !== 'running');
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  assert.equal(partial.failed, 1);
  assert.equal(partial.translated, partial.total - 1);

  const partialReport = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.match(partialReport.payload.report.topics[0].title, /【ZH】/);
  assert.match(partialReport.payload.report.summary, /視聴者/, 'the failed summary keeps the original text');
  const callsBeforeRetry = state.calls;

  state.mode = 'ok';
  const retry = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(retry.status, 202);
  const complete = await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');
  assert.equal(complete.translated, complete.total);
  assert.equal(state.calls, callsBeforeRetry + 1);
  assert.equal(state.lastInput.items.length, 1, 'only the failed paragraph is re-requested');

  const finalReport = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.match(finalReport.payload.report.summary, /【ZH】/);
  assert.match(finalReport.payload.report.topics[0].title, /【ZH】/);
});

test('a new result version does not reuse the previous translation', async (t) => {
  const state = {calls: 0, mode: 'ok'};
  const {server, session, config, files} = await setupServer(t, state);
  const base = server.url;

  await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');

  const jobId = files.manifest.job_id;
  const beforeRows = Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results WHERE job_id = ?').get(jobId).c);
  const v2 = makeJapaneseResult(files.manifest, files.messages, {
    session_topics: {
      summary: '新しいゲームの話は別の話題に変わった。',
      topics: [{
        title: '別の話題',
        started_at: files.messages[0].at,
        ended_at: files.messages.at(-1).at,
        summary: '話題が変わった。',
        key_points: ['新しい話題'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
  const imported = importAnalysisResult({
    db: server.db,
    text: JSON.stringify(v2),
    source: 'api',
    createVersion: true
  });
  assert.equal(imported.duplicate, false);
  assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results WHERE job_id = ?').get(jobId).c), beforeRows + 1);

  const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  // Long-term facts were not re-generated, so their cached translation is still
  // valid; the *new session result* must not reuse the old session translation.
  assert.ok(['missing', 'partial'].includes(report.payload.translation.status));
  assert.ok(report.payload.translation.missing > 0, 'new result id must not match the old cache');
  assert.match(report.payload.report.summary, /新しいゲーム/);
  assert.doesNotMatch(report.payload.report.summary, /【ZH】/);
});

test('missing provider and provider failures never damage the saved analysis', async (t) => {
  const state = {calls: 0, mode: 'fail'};
  const {server, session, config} = await setupServer(t, state);
  const base = server.url;
  const resultsBefore = Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c);

  const noConfig = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', consent: true}
  });
  assert.equal(noConfig.status, 400);
  assert.equal(noConfig.payload.error.code, 'TRANSLATION_PROVIDER_REQUIRED');
  const readable = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.equal(readable.status, 200);
  assert.match(readable.payload.report.summary, /視聴者/);

  const noConsent = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id}
  });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.payload.error.code, 'TRANSLATION_CONSENT_REQUIRED');

  const keyless = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    modelId: 'keyless',
    allowLocalNetwork: true
  });
  const noKey = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: keyless.id, consent: true}
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.payload.error.code, 'TRANSLATION_CREDENTIAL_MISSING');

  const failedStart = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(failedStart.status, 202);
  const failed = await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status !== 'running');
  assert.equal(failed.status, 'failed');
  assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), resultsBefore);
  const afterFailure = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.match(afterFailure.payload.report.summary, /視聴者/);

  // A retry after the configuration/network recovers completes without a new analysis.
  state.mode = 'ok';
  const retry = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  assert.equal(retry.status, 202);
  await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');
  const recovered = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.match(recovered.payload.report.summary, /【ZH】/);
});

test('translation does not fabricate evidence whose original chat was purged', async (t) => {
  const state = {calls: 0, mode: 'ok'};
  const {server, session, config} = await setupServer(t, state);
  const base = server.url;
  await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');
  server.db.prepare('UPDATE events SET content = NULL, content_purged_at = ? WHERE session_id = ?')
    .run(T0 + 120000, session.id);
  const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  const ref = report.payload.report.topics[0].refs[0];
  assert.equal(ref.contentAvailable, false);
  assert.equal(ref.purged, true);
  assert.equal(ref.content, null);
  assert.match(report.payload.report.summary, /【ZH】/);
});

test('session and memory jobs use the same explicit analysis output locale', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 6, viewerCount: 2});
  const sessionJob = await createSessionAnalysisJob({
    db: server.db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: server.paths.exports,
    tokenBudget: 24000
  });
  const memoryJob = await createViewerMemoryJob({
    db: server.db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: server.paths.exports,
    viewersPerBatch: 10,
    tokenBudget: 24000
  });
  assert.equal(sessionJob.job.locale, 'zh-CN');
  assert.equal(memoryJob.job.locale, 'zh-CN');
  assert.match(sessionJob.job.promptVersion, /-zh-CN$/);
  assert.match(memoryJob.job.promptVersion, /-zh-CN$/);

  const sessionFiles = readPackageFiles(server.paths.exports, sessionJob.packages[0]);
  const memoryFiles = readPackageFiles(server.paths.exports, memoryJob.packages[0]);
  assert.match(sessionFiles['instructions.md'], /zh-CN/);
  assert.match(memoryFiles['instructions.md'], /简体中文/);
  assert.equal(sessionFiles.manifest.locale, 'zh-CN');
  assert.equal(memoryFiles.manifest.locale, 'zh-CN');
});

test('an older schema 1.1.0 report is still translatable as a read-only display', async (t) => {
  const state = {calls: 0, mode: 'ok'};
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    auto: {fetchImpl: translationFetch({state}), maxRetries: 0, chunkChars: 20000}
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 4, viewerCount: 2});
  const created = await createAnalysisJob({
    db: server.db,
    sessionId: session.id,
    locale: 'en',
    exportsDir: server.paths.exports,
    batchSize: 1000
  });
  const packageData = readBatchPackage(server.paths.exports, created.packages[0]);
  const legacy = makeBatchResult(packageData.manifest, packageData.messages, packageData.viewers);
  assert.equal(legacy.schema_version, '1.1.0');
  importAnalysisResult({db: server.db, text: JSON.stringify(legacy), source: 'api'});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    modelId: 'mock-legacy',
    apiKey: 'test-key',
    allowLocalNetwork: true
  });

  await jsonRequest(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    body: {locale: 'zh-CN', configId: config.id, consent: true}
  });
  await waitForTranslation(server, session.id, 'zh-CN', (translation) => translation.status === 'complete');
  const report = await jsonRequest(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=zh-CN`);
  assert.equal(report.payload.result.schemaVersion, '1.1.0');
  assert.match(report.payload.report.summary, /【ZH】/);
  assert.match(report.payload.viewerProfiles.items[0].summary, /【ZH】/);
  // The old result is still the same row; translation never re-imports it.
  assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), 1);
});
