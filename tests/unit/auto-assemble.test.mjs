import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  assembleCompactAnswer,
  buildCompactAnswerSchema,
  inspectCompactAnswer,
  isCompactAnswer,
  mergeTargetedAnswer
} from '../../src/ai/auto/assemble.mjs';
import {buildTargetedViewerPrompt} from '../../src/ai/auto/prompt.mjs';

const SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../src/ai/schemas/analysis-result-v1.schema.json', import.meta.url)),
  'utf8'
));

function manifest(overrides = {}) {
  return {
    protocol: 'livememory-analysis-v1',
    result_protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    locale: 'ja',
    job_id: 'aij_test',
    session_id: 'ses_test',
    broadcaster_id: 'youtube:UC_BC',
    batch: {index: 1, total: 1, batch_id: 'aij_test-b01'},
    tasks: [{task_id: 'ses_test-analysis'}],
    ...overrides
  };
}

const refs = [
  {ref: 1, viewerId: 'youtube:UC_A', nickname: 'A', seqs: [1], excerptCount: 1, zeroExcerpt: false},
  {ref: 2, viewerId: 'youtube:UC_B', nickname: 'B', seqs: [], excerptCount: 0, zeroExcerpt: true},
  {ref: 3, viewerId: 'youtube:UC_C', nickname: 'C', seqs: [2, 3], excerptCount: 2, zeroExcerpt: false}
];

function answer(overrides = {}) {
  return {
    session_topics: {summary: 's', topics: [], sentiment: [], disputes: [], highlights: []},
    viewers: [
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 3, memory: {no_new_information: true, operations: []}}
    ],
    ...overrides
  };
}

test('the compact schema forces one entry per ref and never asks for viewer_id', () => {
  const schema = buildCompactAnswerSchema({resultSchema: SCHEMA, viewerCount: 3});
  assert.equal(schema.properties.viewers.minItems, 3);
  assert.equal(schema.properties.viewers.maxItems, 3);
  assert.deepEqual(schema.properties.viewers.items.properties.ref.enum, [1, 2, 3]);
  const memoryProps = schema.properties.viewers.items.properties.memory.properties;
  assert.equal(memoryProps.viewer_id, undefined);
  const profileProps = schema.properties.viewers.items.properties.profile.properties;
  assert.equal(profileProps.viewer_id, undefined);
  assert.deepEqual(
    [...schema.properties.viewers.items.properties.memory.required].sort(),
    ['no_new_information', 'operations']
  );
});

test('inspectCompactAnswer reports missing, duplicate and out-of-range refs', () => {
  const missing = inspectCompactAnswer(answer(), {viewerCount: 3});
  assert.deepEqual(missing.missing, [2]);
  assert.equal(missing.ok, false);

  const duplicate = inspectCompactAnswer({
    session_topics: {},
    viewers: [
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 3, memory: {no_new_information: true, operations: []}}
    ]
  }, {viewerCount: 3});
  assert.ok(duplicate.issues.some((entry) => entry.code === 'REF_DUPLICATE'));
  assert.deepEqual(duplicate.missing, [2]);

  const unknown = inspectCompactAnswer({
    session_topics: {},
    viewers: [
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 2, memory: {no_new_information: true, operations: []}},
      {ref: 4, memory: {no_new_information: true, operations: []}}
    ]
  }, {viewerCount: 3});
  assert.ok(unknown.issues.some((entry) => entry.code === 'REF_INVALID'));
  assert.deepEqual(unknown.missing, [3]);
});

test('assembly uses the batch assignment for ids, never a model-supplied id', () => {
  const assembled = assembleCompactAnswer({
    answer: {
      session_topics: {summary: 's', topics: [], sentiment: [], disputes: [], highlights: []},
      viewers: [
        {ref: 3, memory: {no_new_information: true, operations: []}},
        {ref: 1, memory: {no_new_information: true, operations: []}},
        {ref: 2, memory: {no_new_information: true, operations: []}}
      ]
    },
    manifest: manifest(),
    viewerRefs: refs
  });
  assert.equal(assembled.ok, true);
  assert.deepEqual(
    assembled.result.viewer_memory_updates.map((entry) => entry.viewer_id),
    ['youtube:UC_A', 'youtube:UC_B', 'youtube:UC_C']
  );
  assert.equal(assembled.result.job_id, 'aij_test');
  assert.equal(assembled.result.batch_id, 'aij_test-b01');
  assert.equal(assembled.result.schema_version, '1.2.0');
});

test('a targeted supplement may only fill refs that were missing', () => {
  const merged = mergeTargetedAnswer({
    answer: answer(),
    supplement: {
      viewers: [
        {ref: 2, memory: {no_new_information: true, operations: []}},
        {ref: 1, memory: {no_new_information: false, operations: []}}
      ]
    },
    missingRefs: [2]
  });
  assert.equal(merged.ok, false);
  assert.ok(merged.issues.some((entry) => entry.code === 'REF_UNKNOWN'));

  const accepted = mergeTargetedAnswer({
    answer: answer(),
    supplement: {viewers: [{ref: 2, memory: {no_new_information: true, operations: []}}]},
    missingRefs: [2]
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.answer.viewers.map((entry) => entry.ref), [1, 2, 3]);
});

test('the targeted prompt contains only the missing ref and its own excerpts', () => {
  const files = {
    'manifest.json': JSON.stringify(manifest()),
    'memory_context.json': JSON.stringify({
      viewers: refs.map((entry) => ({
        viewer_id: entry.viewerId,
        nickname: entry.nickname,
        evidence_seqs: entry.seqs,
        session_excerpt_message_count: entry.excerptCount,
        zero_excerpt: entry.zeroExcerpt,
        memory: {status: 'none', version: 0, facts: []}
      }))
    }),
    'viewer_excerpts.jsonl': [
      {seq: 1, viewer_id: 'youtube:UC_A', content: 'A says hi'},
      {seq: 2, viewer_id: 'youtube:UC_C', content: 'C says hi'},
      {seq: 3, viewer_id: 'youtube:UC_C', content: 'C says more'}
    ].map((entry) => JSON.stringify(entry)).join('\n'),
    'result.schema.json': JSON.stringify(SCHEMA),
    'instructions.md': '# test'
  };
  const prompt = buildTargetedViewerPrompt({files, refs: [2]});
  assert.deepEqual(prompt.targetRefs, [2]);
  assert.deepEqual(prompt.viewerRefs.map((entry) => entry.viewerId), ['youtube:UC_B']);
  assert.match(prompt.user, /no chat excerpts/);
  assert.doesNotMatch(prompt.user, /UC_A|UC_C/);
  assert.equal(prompt.answerSchema.properties.viewers.minItems, 1);
  assert.equal(prompt.answerSchema.properties.viewers.items.properties.ref.const, 2);
  assert.equal(prompt.answerSchema.properties.session_topics, undefined);
  assert.deepEqual(prompt.answerSchema.required, ['viewers']);
});

test('isCompactAnswer distinguishes compact from full results', () => {
  assert.equal(isCompactAnswer(answer()), true);
  assert.equal(isCompactAnswer({viewer_memory_updates: []}), false);
  assert.equal(isCompactAnswer([]), false);
});
