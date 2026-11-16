import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AI_OUTPUT_LOCALES} from '../../src/shared/locales.mjs';
import {
  NATURAL_LANGUAGE_FIELDS,
  OUTPUT_LANGUAGES,
  PROTECTED_TOKENS,
  hasNativeInstructions,
  languageRuleText,
  languageSectionBullets,
  memoryExampleFor,
  outputLanguage,
  repairLabelFor,
  systemPromptFor
} from '../../src/ai/prompts/language.mjs';
import {
  buildMemoryInstructions as buildSplitMemoryInstructions,
  buildSessionInstructions,
  memoryCompactShape
} from '../../src/ai/prompts/split.mjs';
import {buildInstructions} from '../../src/ai/prompts/instructions.mjs';
import {buildMemoryInstructions as buildLegacyMemoryInstructions} from '../../src/memory/prompt.mjs';
import {
  buildAggregateDigestPrompt,
  buildMemoryPrompt,
  buildRepairMessages,
  buildSessionAggregatePrompt,
  buildSessionPrompt
} from '../../src/ai/api/prompts.mjs';

/**
 * Ten-language AI prompt contract.
 *
 * This file is the P41 gate for "the language is really supported, not just
 * offered in a selector". It checks the prompt surface only; the result schema
 * contract is covered by `locale-registry.test.mjs` and the end-to-end language
 * behaviour by `tests/integration/ai-i18n-locales.test.mjs`.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const TEN_CODES = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];
const RESULT_SCHEMA = JSON.parse(
  readFileSync(`${root}src/ai/schemas/analysis-result-v1.3.schema.json`, 'utf8')
);

function sessionFiles(locale) {
  const manifest = {
    protocol: 'livememory-analysis-v1',
    session_id: 'ses_prompt_test',
    broadcaster_id: 'youtube:UC_TEST',
    locale,
    job_id: 'aij_prompt_test',
    tasks: [{task_id: 'ses_prompt_test-analysis', kind: 'session_analysis'}],
    batch: {batch_id: 'aij_prompt_test-b01', index: 1, total: 1, from_seq: 1, to_seq: 2, message_count: 2}
  };
  return {
    'manifest.json': JSON.stringify(manifest),
    'session_context.json': JSON.stringify({session: {id: 'ses_prompt_test', platform: 'youtube'}}),
    'messages.jsonl': [
      JSON.stringify({seq: 1, at: '2026-11-08T10:00:00.000Z', content: 'hello'}),
      JSON.stringify({seq: 2, at: '2026-11-08T10:00:01.000Z', content: 'ギターを始めました'})
    ].join('\n'),
    'instructions.md': buildSessionInstructions(locale, {
      session: {id: 'ses_prompt_test', platform: 'youtube'},
      jobId: 'aij_prompt_test',
      taskId: 'ses_prompt_test-analysis',
      messageCount: 2
    }),
    'result.schema.json': JSON.stringify(RESULT_SCHEMA)
  };
}

function memoryFiles(locale) {
  const manifest = {
    protocol: 'livememory-analysis-v1',
    session_id: 'ses_prompt_test',
    broadcaster_id: 'youtube:UC_TEST',
    locale,
    job_id: 'aij_prompt_test',
    prompt_version: 'lm-prompt-m6.4',
    tasks: [{task_id: 'ses_prompt_test-memory', kind: 'viewer_memory_analysis'}],
    batch: {batch_id: 'aij_prompt_test-b01', index: 1, total: 1, message_count: 1, viewers_total: 1},
    counts: {messages: 1, viewers_total: 1}
  };
  const viewers = [{
    viewer_id: 'youtube:UC_VIEWER_0',
    nickname: 'Viewer 0',
    evidence_seqs: [1],
    zero_excerpt: false
  }];
  return {
    'manifest.json': JSON.stringify(manifest),
    'session_context.json': JSON.stringify({session: {id: 'ses_prompt_test'}}),
    'memory_context.json': JSON.stringify({
      protocol: 'livememory-analysis-v1',
      kind: 'viewer_memory',
      job: {id: 'aij_prompt_test', locale},
      batch: {batch_id: 'aij_prompt_test-b01', index: 1, total: 1},
      viewers: viewers.map((viewer) => ({...viewer, memory: {status: 'none', version: 0, facts: []}}))
    }),
    'viewer_excerpts.jsonl': JSON.stringify({
      viewer_id: 'youtube:UC_VIEWER_0',
      seq: 1,
      at: '2026-11-08T10:00:00.000Z',
      content: 'ギターを始めました'
    }),
    'result.schema.json': JSON.stringify(RESULT_SCHEMA)
  };
}

const MANIFEST = {
  job_id: 'aij_prompt_test',
  session_id: 'ses_prompt_test',
  broadcaster_id: 'youtube:UC_TEST',
  locale: 'en',
  tasks: [{task_id: 'ses_prompt_test-analysis-final'}]
};

test('the output language table covers exactly the AI output languages', () => {
  assert.deepEqual(Object.keys(OUTPUT_LANGUAGES), TEN_CODES);
  assert.deepEqual([...AI_OUTPUT_LOCALES], TEN_CODES);
  for (const code of TEN_CODES) {
    const entry = outputLanguage(code);
    assert.ok(entry.name && entry.nativeName, code);
    assert.ok(entry.rule.length > 20, `${code} rule`);
    assert.ok(entry.guard.length > 20, `${code} guard`);
    assert.ok(entry.system.length > 20, `${code} system`);
    assert.ok(entry.repair.length > 10, `${code} repair`);
    // The guard must name the fields a model is most likely to translate.
    assert.match(entry.guard, /JSON/, `${code} guard must mention JSON`);
    assert.match(entry.guard, /viewer_id/, `${code} guard must protect viewer_id`);
    assert.match(entry.guard, /seq/, `${code} guard must protect seq`);
    // The example must be in the target language and cover the prose fields.
    assert.ok(entry.example.summary && entry.example.topic && entry.example.statement, code);
    assert.deepEqual(Object.keys(entry.example).sort(), ['statement', 'summary', 'topic']);
  }
  // No two languages may share the same rule text (a copy-paste regression).
  const rules = TEN_CODES.map((code) => outputLanguage(code).rule);
  assert.equal(new Set(rules).size, TEN_CODES.length);
  const guards = TEN_CODES.map((code) => outputLanguage(code).guard);
  assert.equal(new Set(guards).size, TEN_CODES.length);
});

test('native instruction bodies are declared on the registry, not in a second list', () => {
  const native = TEN_CODES.filter((code) => hasNativeInstructions(code));
  assert.deepEqual(native, ['zh-CN', 'ja', 'en']);
});

test('every locale names the natural-language fields it must translate', () => {
  assert.deepEqual([...NATURAL_LANGUAGE_FIELDS], [
    'summary', 'title', 'key_points', 'note', 'reason', 'clip_suggestion', 'statement', 'topic'
  ]);
  for (const code of TEN_CODES) {
    const rule = outputLanguage(code).rule;
    for (const field of NATURAL_LANGUAGE_FIELDS) {
      // Field names stay English in every language: they are machine hints.
      assert.ok(rule.includes(field), `${code} rule must mention ${field}`);
    }
  }
  // The protected list is the machine contract and is never localised. Every
  // guard names the two most translation-prone identifiers plus JSON itself;
  // the packaged instruction outline keeps the remaining protocol field names.
  assert.deepEqual([...PROTECTED_TOKENS], [
    'protocol', 'schema_version', 'analysis_scope', 'job_id', 'batch_id',
    'task_id', 'session_id', 'viewer_id', 'message_id', 'seq', 'locale'
  ]);
  for (const code of TEN_CODES) {
    const guard = outputLanguage(code).guard;
    for (const token of ['viewer_id', 'message_id', 'seq', 'JSON']) {
      assert.ok(guard.includes(token), `${code} guard must name ${token}`);
    }
  }
});

test('session instructions exist for all ten languages with their own output rule', () => {
  for (const code of TEN_CODES) {
    const text = buildSessionInstructions(code, {
      session: {id: 'ses_prompt_test', platform: 'youtube'},
      jobId: 'aij_prompt_test',
      taskId: 'ses_prompt_test-analysis',
      messageCount: 2
    });
    assert.ok(text.includes(`OUTPUT LANGUAGE (${code})`), `${code} session output rule`);
    assert.ok(text.includes(languageRuleText(code)), `${code} session rule text`);
    assert.ok(text.includes(`- locale: \`${code}\``), `${code} locale line`);
    assert.ok(text.includes('message_refs'), `${code} evidence rule`);
    // Never mix another language's output rule into this prompt.
    for (const other of TEN_CODES) {
      if (other === code) continue;
      assert.ok(!text.includes(languageRuleText(other)), `${code} prompt leaked ${other} rule`);
    }
  }
});

test('memory instructions exist for all ten languages with a localized example', () => {
  for (const code of TEN_CODES) {
    const text = buildSplitMemoryInstructions(code, {
      session: {id: 'ses_prompt_test', platform: 'youtube'},
      jobId: 'aij_prompt_test',
      taskId: 'ses_prompt_test-memory',
      viewerCount: 1,
      viewersTotal: 1,
      messageCount: 1
    });
    assert.ok(text.includes(languageRuleText(code)), `${code} memory rule text`);
    const example = memoryExampleFor(code);
    assert.ok(text.includes(example.summary), `${code} example summary`);
    assert.ok(text.includes(example.topic), `${code} example topic`);
    assert.ok(text.includes(example.statement), `${code} example statement`);
    // The compact answer example is the only place prose appears; it must be
    // this language's example and not the English fallback.
    if (code !== 'en') assert.ok(!text.includes(memoryExampleFor('en').summary), `${code} used the English example`);
    const shape = memoryCompactShape(code);
    assert.ok(shape.includes(example.summary), `${code} compact shape`);
    assert.ok(!shape.includes('viewer_id'), `${code} compact shape must not ask for viewer_id`);
  }
});

test('packaged instructions carry an explicit output-language section for all ten', () => {
  for (const code of TEN_CODES) {
    const text = buildInstructions(code, {
      session: {id: 'ses_prompt_test', platform: 'youtube', started_at: 0, ended_at: 1000},
      messageCount: 2,
      support: [],
      schemaVersion: '1.3.0'
    });
    const bullets = languageSectionBullets(code);
    for (const bullet of bullets) assert.ok(text.includes(bullet), `${code} missing language bullet`);
    assert.ok(text.includes(`Locale: \`${code}\``), `${code} locale bullet`);
    // The schema outline mirrors the registry, never a frozen three-item list.
    assert.ok(text.includes(`"locale": ${JSON.stringify(TEN_CODES.join(' | '))}`), `${code} schema outline`);
  }
  // Instruction bodies really differ per language family.
  assert.notEqual(buildInstructions('ja'), buildInstructions('en'));
  assert.notEqual(buildInstructions('ko'), buildInstructions('en'));
  assert.notEqual(buildInstructions('ko'), buildInstructions('de'));
});

test('the human-paste memory instructions state the output language for all ten', () => {
  for (const code of TEN_CODES) {
    const text = buildLegacyMemoryInstructions(code, {
      session: {id: 'ses_prompt_test'},
      jobId: 'aij_prompt_test'
    });
    assert.ok(text.includes(`output_language: ${code}`), `${code} output_language line`);
    assert.ok(text.includes(languageRuleText(code)), `${code} language rule`);
    assert.ok(text.includes('viewer_operations'), `${code} protocol shape`);
  }
});

test('provider prompts for all ten languages carry the system rule and the guard', () => {
  for (const code of TEN_CODES) {
    const session = buildSessionPrompt(sessionFiles(code));
    assert.equal(session.locale, code);
    assert.equal(session.messages[0].role, 'system');
    assert.equal(session.messages[0].content, systemPromptFor(code));
    assert.ok(session.messages[0].content.length > 40, `${code} system prompt`);
    assert.ok(session.messages[1].content.includes(`OUTPUT LANGUAGE (${code})`), `${code} session rule`);

    const memory = buildMemoryPrompt(memoryFiles(code));
    assert.equal(memory.locale, code);
    assert.equal(memory.messages[0].content, systemPromptFor(code));
    const memoryText = memory.messages[1].content;
    assert.ok(memoryText.includes(languageRuleText(code)), `${code} memory contract rule`);
    assert.ok(memoryText.includes(memoryExampleFor(code).summary), `${code} memory example`);
    assert.ok(memoryText.includes('"no_new_information"'), `${code} compact contract`);

    const aggregate = buildSessionAggregatePrompt({
      manifest: {...MANIFEST, locale: code},
      batchResults: [{batch_index: 1, result: {session_topics: {summary: 'x'}}}],
      resultSchema: RESULT_SCHEMA
    });
    assert.ok(
      aggregate.messages[1].content.includes(`OUTPUT LANGUAGE (${code})`),
      `${code} aggregate output rule`
    );
    assert.match(aggregate.messages[1].content, /seq/, `${code} aggregate evidence rule`);

    const digest = buildAggregateDigestPrompt({
      manifest: {...MANIFEST, locale: code},
      level: 1,
      nodeIndex: 1,
      sourceKind: 'batches',
      childItems: [{batch_index: 1, result: {session_topics: {summary: 'x'}}}],
      coverage: [{batch: 1, from_seq: 1, to_seq: 2, messages: 2, from_at: 'a', to_at: 'b'}],
      resultSchema: RESULT_SCHEMA
    });
    assert.ok(
      digest.messages[1].content.includes(`OUTPUT LANGUAGE (${code})`),
      `${code} digest output rule`
    );

    const repair = buildRepairMessages({
      prompt: session,
      previousText: '{"bad":true}',
      errors: [{path: 'session_topics', code: 'SCHEMA_REQUIRED'}],
      locale: code
    });
    const repairText = repair.messages.at(-1).content;
    assert.ok(repairText.startsWith(repairLabelFor(code)), `${code} repair label`);
  }
});

test('the English body is never the whole prompt for the seven added languages', () => {
  for (const code of TEN_CODES) {
    if (hasNativeInstructions(code)) continue;
    const text = buildSessionInstructions(code, {messageCount: 1});
    // The instruction body may be English, but the output-language contract must
    // be in the target language so the model cannot treat English as the output.
    assert.ok(text.includes(outputLanguage(code).rule), `${code} must state its own rule`);
    assert.ok(!text.includes('(English here)'), `${code} must not inherit the English placeholder`);
  }
});

test('prompt growth for the added languages stays bounded', () => {
  const baseline = buildSessionInstructions('en', {messageCount: 1}).length;
  for (const code of TEN_CODES) {
    const length = buildSessionInstructions(code, {messageCount: 1}).length;
    // Only one language's text is ever sent. The cap proves the ten-language
    // support did not turn every request into a ten-language document.
    assert.ok(length < baseline + 2000, `${code} session instructions grew by ${length - baseline}`);
  }
});

test('the result schema accepts every AI output language and rejects the rest', async () => {
  const {validateAgainstSchema} = await import('../../src/ai/import/schema-validator.mjs');
  const base = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.3.0',
    analysis_scope: 'session',
    task_id: 'ses_prompt_test-analysis',
    session_id: 'ses_prompt_test',
    locale: 'en',
    session_topics: {summary: 's', topics: [], sentiment: [], disputes: [], highlights: []}
  };
  for (const code of TEN_CODES) {
    assert.deepEqual(validateAgainstSchema(RESULT_SCHEMA, {...base, locale: code}), [], code);
  }
  for (const code of ['th-TH', 'he', 'zh', 'pt-PT', '']) {
    const errors = validateAgainstSchema(RESULT_SCHEMA, {...base, locale: code});
    assert.ok(errors.length > 0, `${code} must not validate`);
  }
});
