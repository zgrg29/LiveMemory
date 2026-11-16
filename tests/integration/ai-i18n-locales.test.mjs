import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {addBroadcaster, parsePromptMemoryRefs, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {AI_OUTPUT_LOCALES} from '../../src/shared/locale.mjs';
import {languageRuleText, memoryExampleFor, outputLanguage, systemPromptFor} from '../../src/ai/prompts/language.mjs';
import {getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {getMemory, listFacts} from '../../src/storage/repositories/viewer-memory.mjs';

/**
 * End-to-end AI output language tests with a *simulated* provider.
 *
 * The mock model is locale-aware: it reads the task language out of the prompt it
 * receives and answers with that language's example text. That proves the whole
 * local pipeline (task language -> prompt language -> stored result language ->
 * report/长期画像 language) for all ten languages, and it proves the raw chat and
 * evidence are never rewritten. It does **not** prove the linguistic quality of a
 * real model: that is recorded separately as a real-provider verification.
 */

const TEN = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

function promptLocale(text) {
  const explicit = /^- locale: `([^`]+)`/m.exec(text);
  if (explicit) return explicit[1];
  const rule = /OUTPUT LANGUAGE \(([^)]+)\)/.exec(text);
  return rule ? rule[1] : 'en';
}

function sessionAnswer(locale, window) {
  const example = memoryExampleFor(locale);
  return JSON.stringify({
    session_topics: {
      // Prose deliberately comes from the language table: a locale-unaware mock
      // would produce English text and the assertions below would catch it.
      summary: example.summary,
      topics: [{
        title: example.topic,
        started_at: window.from,
        ended_at: window.to,
        summary: example.summary,
        key_points: [example.statement],
        confidence: 0.8,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [],
      disputes: [],
      highlights: [{
        started_at: window.from,
        ended_at: window.to,
        title: example.topic,
        reason: example.summary,
        clip_suggestion: example.statement,
        confidence: 0.5,
        evidence: 'observed',
        message_refs: [1]
      }]
    },
    viewer_profiles: []
  });
}

function memoryAnswer(locale, promptText) {
  const refs = parsePromptMemoryRefs(promptText);
  const example = memoryExampleFor(locale);
  const viewers = [...refs.values()].map((ref) => {
    const evidence = Array.isArray(ref.evidence) && ref.evidence.length > 0 ? [ref.evidence[0]] : [];
    if (ref.zeroExcerpt || evidence.length === 0) {
      return {ref: ref.ref, memory: {no_new_information: true, operations: []}};
    }
    return {
      ref: ref.ref,
      memory: {
        summary: example.summary,
        summary_certainty: 'inferred',
        no_new_information: false,
        operations: [{
          op: 'add',
          kind: 'interest',
          // The mock answers the way a compliant model should: a NEW fact uses
          // the task language; it never translates an existing topic.
          topic: example.topic,
          statement: example.statement,
          certainty: 'stated',
          confidence: 0.9,
          evidence
        }]
      }
    };
  });
  return JSON.stringify({viewers});
}

async function startMockServer(t, {captured = []} = {}) {
  const temp = createTempDir();
  // The mock needs the session window so its timestamps pass the local
  // TIME_OUT_OF_RANGE validation; tests set it before each task.
  const window = {from: new Date(T0).toISOString(), to: new Date(T0 + 5000).toISOString()};
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const system = body.messages?.[0]?.content ?? '';
        const text = body.messages.map((message) => message.content).join('\n');
        const locale = promptLocale(text);
        captured.push({locale, system, text});
        const content = text.includes('AUTOMATIC MEMORY CONTRACT')
          ? memoryAnswer(locale, text)
          : sessionAnswer(locale, window);
        return Response.json({
          model: body.model,
          choices: [{message: {content}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 100, completion_tokens: 50, total_tokens: 150}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'mock-locale-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true, auth: true, text: true, json: true,
      session: true, memory: true, testedAt: new Date().toISOString()
    },
    stages: {}
  });
  return {server, config, window};
}

async function waitFor(runner, sessionId, predicate, {timeoutMs = 30000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runTask(server, {sessionId, locale, configId, mode = 'both'}) {
  await server.analysisRunner.start({sessionId, locale, mode, configId, consent: true});
  const status = await waitFor(server.analysisRunner, sessionId, (value) => (
    value.status === 'complete' || value.status === 'failed' || value.status === 'needs_action'
  ));
  return status;
}

function chatContents(server, sessionId) {
  return server.db.prepare(
    "SELECT content FROM events WHERE session_id = ? AND event_type = 'chat' ORDER BY id"
  ).all(sessionId).map((row) => row.content);
}

function viewerIdsOf(server, sessionId) {
  return server.db.prepare(
    `SELECT viewer_id, COUNT(*) AS messages FROM viewer_sessions
     WHERE session_id = ? GROUP BY viewer_id ORDER BY viewer_id`
  ).all(sessionId);
}

function factsFor(server, {broadcasterId, viewerId}) {
  const memory = getMemory(server.db, {broadcasterId, viewerId});
  if (!memory) return [];
  return listFacts(server.db, memory.id);
}

test('all ten AI output languages produce a localised single-session report and localised facts', async (t) => {
  const captured = [];
  const {server, config, window} = await startMockServer(t, {captured});

  for (const [index, locale] of TEN.entries()) {
    // One broadcaster per language: each language gets a fresh long-term memory,
    // so a shared topic ("吉他" is the same word in zh-CN and zh-TW) cannot be
    // de-duplicated across languages. Cross-language coexistence is covered by
    // the dedicated mixed-language test below.
    const broadcasterId = `youtube:UC_I18N_${locale.replace(/-/g, '_')}`;
    addBroadcaster(server.db, {id: broadcasterId, name: `I18N ${locale}`});
    const session = seedSession(server.db, {
      id: `ses_i18n_${locale.replace(/-/g, '_')}`,
      messageCount: 6,
      viewerCount: 2,
      broadcasterId,
      roomId: `i18n-${locale}`,
      startedAt: T0 + index * HOUR
    });
    window.from = new Date(session.started_at ?? session.startedAt).toISOString();
    window.to = new Date((session.started_at ?? session.startedAt) + 6000).toISOString();
    const before = chatContents(server, session.id);
    const status = await runTask(server, {sessionId: session.id, locale, configId: config.id});
    assert.equal(status.status, 'complete', `${locale}: ${JSON.stringify(status.error ?? {})}`);

    // 1. The job stores the language that was chosen for this task.
    const sessionJob = getJob(server.db, status.sessionJobId);
    assert.equal(sessionJob.locale, locale, `${locale} session job locale`);
    assert.equal(sessionJob.promptVersion, `lm-prompt-v13.3-session-${locale}`, `${locale} prompt version`);
    const memoryJob = getJob(server.db, status.memoryJobId);
    assert.equal(memoryJob.locale, locale, `${locale} memory job locale`);

    // 2. Both prompts were sent in the task language, with the target-language
    //    system prompt; no other language's rule leaked into the request.
    const taskPrompts = captured.filter((entry) => entry.locale === locale);
    assert.ok(taskPrompts.length >= 2, `${locale} requests`);
    const language = outputLanguage(locale);
    for (const entry of taskPrompts) {
      assert.equal(entry.system, systemPromptFor(locale), `${locale} system prompt`);
      // The output-language contract travels with every request: as the
      // `## Output language` section of the packaged instructions, or as the
      // native rule inside the memory instructions.
      assert.ok(
        entry.text.includes(languageRuleText(locale)) ||
          (entry.text.includes(language.rule) && entry.text.includes(language.guard)),
        `${locale} output-language rule`
      );
    }

    // 3. The stored report is in that language, not English.
    const example = memoryExampleFor(locale);
    const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
      .then((response) => response.json());
    assert.equal(report.report.summary, example.summary, `${locale} report summary`);
    assert.equal(report.report.topics[0].title, example.topic, `${locale} topic title`);

    // 4. Long-term facts are written in the task language.
    const viewers = viewerIdsOf(server, session.id);
    assert.ok(viewers.length >= 1, `${locale} identifiable viewers`);
    const facts = viewers.flatMap((viewer) => factsFor(server, {
      broadcasterId: session.broadcaster_id,
      viewerId: viewer.viewer_id
    }));
    assert.ok(facts.length >= 1, `${locale} facts`);
    assert.ok(
      facts.some((fact) => fact.topic === example.topic && fact.statement === example.statement),
      `${locale} fact prose (${JSON.stringify(facts.map((fact) => fact.topic))})`
    );

    // 5. The raw chat is never overwritten by analysis in any language.
    assert.deepEqual(chatContents(server, session.id), before, `${locale} raw chat unchanged`);
    assert.equal(getSession(server.db, session.id).id, session.id);
  }

  // Every language produced at least one session and one memory request.
  const byLocale = new Map();
  for (const entry of captured) byLocale.set(entry.locale, (byLocale.get(entry.locale) ?? 0) + 1);
  assert.deepEqual([...byLocale.keys()].sort(), [...TEN].sort());
});

test('mixed-language facts coexist and same-language facts still deduplicate', async (t) => {
  const {server, config, window} = await startMockServer(t);
  // One viewer, one broadcaster, three sessions: zh-CN, ko, then zh-CN again.
  const sessions = [];
  for (const [index, locale] of ['zh-CN', 'ko', 'zh-CN'].entries()) {
    const session = seedSession(server.db, {
      id: `ses_mix_${index}`,
      messageCount: 4,
      viewerCount: 1,
      startedAt: T0 + index * HOUR
    });
    window.from = new Date(session.started_at ?? session.startedAt).toISOString();
    window.to = new Date((session.started_at ?? session.startedAt) + 5000).toISOString();
    const status = await runTask(server, {sessionId: session.id, locale, configId: config.id});
    assert.equal(status.status, 'complete', `${locale} #${index}: ${JSON.stringify(status.error ?? {})}`);
    sessions.push({session, locale});
  }

  const viewerId = viewerIdsOf(server, sessions[0].session.id)[0].viewer_id;
  const broadcasterId = sessions[0].session.broadcaster_id;
  const facts = factsFor(server, {broadcasterId, viewerId});
  const live = facts.filter((fact) => fact.status !== 'superseded');

  // zh-CN contributed 吉他, ko contributed 기타. Plan B: both stay, neither is
  // translated over the other, and the mixed languages cause no constraint error.
  const topics = live.map((fact) => fact.topic).sort();
  assert.deepEqual(topics, [...new Set(topics)], 'no duplicate live rows for one topic');
  assert.ok(topics.includes('吉他'), `expected the Chinese topic, got ${JSON.stringify(topics)}`);
  assert.ok(topics.includes('기타'), `expected the Korean topic, got ${JSON.stringify(topics)}`);
  const guitar = live.find((fact) => fact.topic === '吉他');
  assert.equal(guitar.statement, '开始学吉他');

  // The second zh-CN run repeats the same topic. Same-language de-duplication
  // still applies: exactly one live Chinese row, and its identity is preserved.
  const chineseRows = live.filter((fact) => fact.topic === '吉他');
  assert.equal(chineseRows.length, 1, 'same-language topic must not accumulate');

  // The viewer memory summary follows the most recent task (the second zh-CN
  // run), and the Korean fact from the middle run is still intact.
  const memory = server.db.prepare(
    'SELECT summary FROM viewer_memories WHERE broadcaster_id = ? AND viewer_id = ?'
  ).get(broadcasterId, viewerId);
  assert.equal(memory.summary, memoryExampleFor('zh-CN').summary);

  // Raw chat for every session is intact and still in its original language.
  for (const {session} of sessions) {
    const contents = chatContents(server, session.id);
    assert.ok(contents.length > 0);
    assert.ok(contents[0].includes('<script>'), 'the raw chat content is unchanged');
  }
});

test('interface language and AI output language are independent at the API level', async (t) => {
  const captured = [];
  const {server, config} = await startMockServer(t, {captured});
  const session = seedSession(server.db, {id: 'ses_ui_ai_split', messageCount: 4, viewerCount: 1, startedAt: T0});

  const patch = (body) => fetch(`${server.url}api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  }).then((response) => response.json());

  // Korean interface + Japanese output.
  await patch({locale: 'ko', aiOutputLocale: 'ja'});
  const bootstrap = await fetch(`${server.url}api/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.effective.locale, 'ko');
  assert.equal(bootstrap.settings.aiOutputLocale, 'ja');
  assert.equal(bootstrap.effective.aiOutputLocale, 'ja');

  const first = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId: session.id, mode: 'session', configId: config.id, consent: true})
  }).then((response) => response.json());
  assert.equal(first.locale, 'ja', 'the task language comes from the AI preference, not the UI');
  const firstStatus = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
  assert.equal(getJob(server.db, firstStatus.sessionJobId).locale, 'ja');

  // Switching the interface to German does not touch the saved preference.
  const switched = await patch({locale: 'de'});
  assert.equal(switched.effective.locale, 'de');
  assert.equal(switched.settings.aiOutputLocale, 'ja');
  assert.equal(switched.effective.aiOutputLocale, 'ja');
  // The completed job keeps its language snapshot.
  assert.equal(getJob(server.db, firstStatus.sessionJobId).locale, 'ja');

  // An explicit per-task language still wins over the preference.
  const explicit = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      sessionId: session.id,
      mode: 'session',
      configId: config.id,
      locale: 'pt-BR',
      consent: true
    })
  }).then((response) => response.json());
  assert.equal(explicit.locale, 'pt-BR');
  const explicitStatus = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
  assert.equal(getJob(server.db, explicitStatus.sessionJobId).locale, 'pt-BR');
  // The earlier Japanese job is untouched: a new task never rewrites history.
  assert.equal(getJob(server.db, firstStatus.sessionJobId).locale, 'ja');

  // `follow-ui` makes a new task follow the interface language again.
  const follow = await patch({aiOutputLocale: 'follow-ui'});
  assert.equal(follow.effective.aiOutputLocale, 'de');
  const third = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId: session.id, mode: 'session', configId: config.id, consent: true})
  }).then((response) => response.json());
  assert.equal(third.locale, 'de');

  // Invalid values are rejected instead of reaching a provider.
  const bad = await fetch(`${server.url}api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({aiOutputLocale: 'th-TH'})
  });
  assert.equal(bad.status, 400);
});

test('an in-flight task keeps its language across pause, restart and settings changes', async (t) => {
  const captured = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const temp = createTempDir();
  let server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        const locale = promptLocale(text);
        captured.push({locale, text});
        if (!blocked && !text.includes('AUTOMATIC MEMORY CONTRACT')) {
          // Block the first session request so the task can be paused in flight.
          blocked = true;
          await gate;
        }
        return Response.json({
          model: body.model,
          choices: [{
            message: {
              content: text.includes('AUTOMATIC MEMORY CONTRACT')
                ? memoryAnswer(locale, text)
                : sessionAnswer(locale)
            },
            finish_reason: 'stop'
          }],
          usage: {prompt_tokens: 10, completion_tokens: 5}
        });
      }
    }
  });
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_snapshot', messageCount: 12, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'mock-snapshot',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });

  // Create the task in Korean.
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'ko',
    mode: 'both',
    configId: config.id,
    consent: true
  });
  for (let index = 0; index < 400 && !blocked; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(blocked, true, 'the first provider request must be in flight');
  const entry = server.analysisRunner.state.get(session.id);
  const jobId = entry.sessionJobId;
  assert.ok(jobId, 'the session job exists while the first request is in flight');
  assert.equal(getJob(server.db, jobId).locale, 'ko');

  // While it is running: change the interface language and the AI preference.
  await fetch(`${server.url}api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({locale: 'de', aiOutputLocale: 'es'})
  });
  assert.equal(getJob(server.db, jobId).locale, 'ko', 'settings must not rewrite the task language');

  // Pause, reload the runtime state from disk (simulated restart), then resume.
  server.analysisRunner.pause(session.id);
  release();
  await waitFor(server.analysisRunner, session.id, (value) => value.status !== 'running');
  const paused = server.analysisRunner.getStatus(session.id);
  assert.ok(['paused', 'interrupted', 'partial'].includes(paused.status), paused.status);
  assert.equal(server.analysisRunner.state.get(session.id).locale, 'ko', 'paused state keeps the language');

  await server.close();
  server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en'
  });
  const restarted = server.analysisRunner.state.get(session.id);
  assert.ok(restarted, 'runtime state survives a restart');
  assert.equal(restarted.locale, 'ko', 'restart keeps the task language');
  assert.ok(['paused', 'interrupted'].includes(restarted.status), restarted.status);
  assert.equal(getJob(server.db, jobId).locale, 'ko');

  // The resume request continues the same job; the new prompt is still Korean.
  captured.length = 0;
  const resumedWindow = {
    from: new Date(session.started_at ?? session.startedAt).toISOString(),
    to: new Date((session.started_at ?? session.startedAt) + 5000).toISOString()
  };
  server.analysisRunner.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => message.content).join('\n');
    const locale = promptLocale(text);
    captured.push({locale, text});
    return Response.json({
      model: body.model,
      choices: [{
        message: {
          content: text.includes('AUTOMATIC MEMORY CONTRACT')
            ? memoryAnswer(locale, text)
            : sessionAnswer(locale, resumedWindow)
        },
        finish_reason: 'stop'
      }],
      usage: {prompt_tokens: 10, completion_tokens: 5}
    });
  };
  const resume = await fetch(`${server.url}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId: session.id, consent: true})
  });
  assert.equal(resume.status, 202, await resume.text());
  const finished = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
  assert.equal(getJob(server.db, finished.sessionJobId).locale, 'ko');
  assert.ok(captured.length > 0, 'the resumed task issued a request');
  for (const request of captured) {
    assert.equal(request.locale, 'ko', 'every resumed request keeps the original task language');
    assert.ok(request.text.includes(languageRuleText('ko')));
  }
  // The report is still Korean even though the UI is German and the AI
  // preference is Spanish now.
  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.equal(report.report.summary, memoryExampleFor('ko').summary);
});
