import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {
  addBroadcaster,
  makeBatchResult,
  seedSession,
  T0
} from '../helpers/ai-fixtures.mjs';
import {createSessionAnalysisJob} from '../../src/ai/export/split-jobs.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {AI_OUTPUT_LOCALES} from '../../src/shared/locale.mjs';
import {outputLanguage} from '../../src/ai/prompts/language.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';

/**
 * Report reading-language translation across all ten AI output languages.
 *
 * The provider is a local mock. The test proves the *mechanics* required by the
 * product: the original report is never overwritten, each target language has
 * its own cache rows, structured fields and evidence are untouched, and the
 * source language is never offered as a pointless translation.
 */

/** Session (v13 split) packages contain no `viewer_context.json`. */
function readSessionPackage(exportsDir, pkg) {
  const buffer = readFileSync(join(exportsDir, pkg.fileName));
  return {
    manifest: JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8')),
    messages: readZipEntry(buffer, 'messages.jsonl').toString('utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  };
}

function translationFetch({state}) {
  return async (_url, options) => {
    state.calls += 1;
    const body = JSON.parse(options.body);
    const user = body.messages[body.messages.length - 1].content;
    const match = /Input JSON:\n\n([\s\S]*?)\n\nReturn only/.exec(user);
    assert.ok(match, 'translation prompt must include the input JSON');
    const input = JSON.parse(match[1]);
    const target = /Target language: ([^\n]+)/.exec(user)?.[1] ?? '';
    state.prompts.push({target, user});
    const code = /\(([a-zA-Z-]+)\)\s*$/.exec(target)?.[1] ?? 'unknown';
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            items: input.items.map((item) => ({id: item.id, text: `[${code}] ${item.text}`}))
          })
        },
        finish_reason: 'stop'
      }],
      usage: {prompt_tokens: 40, completion_tokens: 30}
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

async function waitForTranslation(server, sessionId, locale) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const status = await server.translationService.getStatus(sessionId, locale);
    if (status.translation.status !== 'running') return status.translation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`translation did not settle for ${locale}`);
}

test('report reading translation supports all ten target languages without mixing caches', async (t) => {
  const temp = createTempDir();
  const state = {calls: 0, prompts: []};
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    auto: {fetchImpl: translationFetch({state}), maxRetries: 0, chunkChars: 20000}
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 8, viewerCount: 2, startedAt: T0});
  const created = await createSessionAnalysisJob({
    db: server.db,
    sessionId: session.id,
    locale: 'ja',
    exportsDir: server.paths.exports,
    tokenBudget: 24000
  });
  const files = readSessionPackage(server.paths.exports, created.packages[0]);
  const result = makeBatchResult(files.manifest, files.messages, [], {
    locale: 'ja',
    schema_version: '1.3.0',
    analysis_scope: 'session',
    session_topics: {
      summary: '配信全体の要約です。',
      topics: [{
        title: '話題',
        started_at: files.messages[0].at,
        ended_at: files.messages.at(-1).at,
        summary: '話題の説明。',
        key_points: ['要点'],
        confidence: 0.8,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
  importAnalysisResult({db: server.db, text: JSON.stringify(result), source: 'api'});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    modelId: 'mock-translator',
    apiKey: 'test-key',
    allowLocalNetwork: true,
    pricingStatus: 'unknown'
  });

  // The original report and raw chat are the immutable baseline.
  const original = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.equal(original.report.summary, '配信全体の要約です。');
  const originalTopics = JSON.stringify(original.report.topics);
  const chatBefore = server.db.prepare(
    "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
  ).all(session.id).map((row) => row.content);

  const targets = AI_OUTPUT_LOCALES.filter((code) => code !== 'ja');
  for (const code of targets) {
    const started = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({locale: code, configId: config.id, consent: true})
    });
    assert.equal(started.status, 202, `${code}: ${await started.text()}`);
    const settled = await waitForTranslation(server, session.id, code);
    assert.ok(['complete', 'partial'].includes(settled.status), `${code}: ${JSON.stringify(settled)}`);

    // The translation request named exactly this target language.
    const prompt = state.prompts.filter((entry) => entry.target.includes(`(${code})`)).at(-1);
    assert.ok(prompt, `${code} translation prompt`);
    assert.equal(
      prompt.target,
      `${outputLanguage(code).name} (${code})`,
      `${code} target language label`
    );

    // Reading in that language returns translated prose only.
    const translated = await fetch(
      `${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report?locale=${code}`
    ).then((response) => response.json());
    assert.equal(translated.report.summary, `[${code}] 配信全体の要約です。`, `${code} translated summary`);
    assert.equal(translated.report.language?.targetLocale ?? code, code);
    // Structured fields and evidence are never translated: the topic timeline
    // (timestamps, confidence, evidence kind) is identical apart from the text.
    assert.equal(translated.report.topics[0].started_at, original.report.topics[0].started_at, code);
    assert.equal(translated.report.topics[0].confidence, original.report.topics[0].confidence, code);
    assert.equal(translated.report.topics[0].evidence, original.report.topics[0].evidence, code);
    assert.deepEqual(translated.report.topics[0].message_refs, original.report.topics[0].message_refs, code);

    // Each target language owns its own cache rows; nothing is overwritten.
    const rows = server.db.prepare(
      'SELECT COUNT(*) AS n FROM ai_translations WHERE session_id = ? AND target_locale = ?'
    ).get(session.id, code);
    assert.ok(rows.n > 0, `${code} cache rows`);
  }

  // No cache row mixes two target languages, and every target has its own tag.
  const perLocale = server.db.prepare(
    'SELECT target_locale, COUNT(*) AS n FROM ai_translations WHERE session_id = ? GROUP BY target_locale'
  ).all(session.id);
  assert.deepEqual(perLocale.map((row) => row.target_locale).sort(), [...targets].sort());
  for (const row of perLocale) {
    const texts = server.db.prepare(
      'SELECT translated_text FROM ai_translations WHERE session_id = ? AND target_locale = ?'
    ).all(session.id, row.target_locale);
    for (const entry of texts) {
      assert.ok(entry.translated_text.startsWith(`[${row.target_locale}]`), `${row.target_locale} cache tag`);
    }
  }

  // The stored original is untouched: same prose, same structure, same chat.
  const after = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.equal(after.report.summary, '配信全体の要約です。');
  assert.equal(JSON.stringify(after.report.topics), originalTopics);
  assert.deepEqual(
    server.db.prepare("SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id")
      .all(session.id).map((row) => row.content),
    chatBefore
  );

  // Translating into the report's own language is refused, not silently run.
  const same = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/translation`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({locale: 'ja', configId: config.id, consent: true})
  });
  assert.equal(same.status, 409);
  const sameBody = await same.json();
  assert.equal(sameBody.error.code, 'TRANSLATION_NOT_NEEDED');
});
