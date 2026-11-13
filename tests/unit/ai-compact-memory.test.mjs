import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_UPDATE_FIELDS,
  assembleMemoryCompact,
  buildMemoryCompactSchema,
  inspectCompactMemory
} from '../../src/ai/api/compact.mjs';
import {buildMemoryPrompt} from '../../src/ai/api/prompts.mjs';
import {
  buildMemoryInstructions,
  memoryCompactShape
} from '../../src/ai/prompts/split.mjs';
import {loadResultSchema} from '../../src/ai/import/validate.mjs';

const MANIFEST = {
  job_id: 'aij_compact_test',
  session_id: 'ses_compact_test',
  locale: 'ja',
  broadcaster_id: 'youtube:UC_TEST',
  prompt_version: 'lm-prompt-v13.1-memory-ja',
  batch: {index: 1, total: 1, batch_id: 'aij_compact_test-b01', message_count: 2},
  tasks: [{task_id: 'ses_compact_test-memory', kind: 'viewer_memory_analysis'}],
  counts: {viewers: 2, viewers_total: 2, messages: 2}
};

function memoryContext() {
  return {
    protocol: 'livememory-analysis-v1',
    kind: 'viewer_memory_only',
    analysis_scope: 'viewer_memory',
    job: {id: MANIFEST.job_id},
    batch: {index: 1, total: 1, batch_id: 'aij_compact_test-b01', viewers_total: 2},
    viewers: [
      {
        viewer_id: 'youtube:UC_A',
        nickname: 'A',
        evidence_seqs: [1],
        zero_excerpt: false,
        memory: {status: 'none', version: 0, facts: []}
      },
      {
        viewer_id: 'youtube:UC_B',
        nickname: 'B',
        evidence_seqs: [2],
        zero_excerpt: false,
        memory: {status: 'none', version: 0, facts: []}
      }
    ]
  };
}

function refs() {
  return [
    {ref: 1, viewerId: 'youtube:UC_A', nickname: 'A', evidenceSeqs: [1], zeroExcerpt: false},
    {ref: 2, viewerId: 'youtube:UC_B', nickname: 'B', evidenceSeqs: [2], zeroExcerpt: false}
  ];
}

test('the best-effort compact example no longer teaches English identity fields', () => {
  const ja = memoryCompactShape('ja');
  assert.match(ja, /ギターを始めました/);
  assert.doesNotMatch(ja, /"viewer_id"/);
  assert.doesNotMatch(ja, /"locale": "en"/);
  assert.doesNotMatch(ja, /"protocol"/);
  assert.match(ja, /"ref": 1/);

  const zh = memoryCompactShape('zh-CN');
  assert.match(zh, /开始学吉他/);
  const en = memoryCompactShape('en');
  assert.match(en, /Started learning guitar/);
});

test('memory instructions state the task language and the no-fabrication rules', () => {
  const ja = buildMemoryInstructions('ja', {jobId: 'aij_x', session: {id: 'ses_x'}});
  assert.match(ja, /自然で読みやすい日本語/);
  assert.match(ja, /topic/);
  assert.match(ja, /捏造/);
  assert.doesNotMatch(ja, /"locale": "en"/);
  assert.doesNotMatch(ja, /viewer_memory_updates/);
  assert.doesNotMatch(ja, /"viewer_id"/);

  const zh = buildMemoryInstructions('zh-CN', {jobId: 'aij_x', session: {id: 'ses_x'}});
  assert.match(zh, /简体中文/);
  assert.doesNotMatch(zh, /viewer_memory_updates/);

  const en = buildMemoryInstructions('en', {jobId: 'aij_x', session: {id: 'ses_x'}});
  assert.match(en, /task locale/);
  assert.doesNotMatch(en, /viewer_memory_updates/);
});

test('provider memory prompts ignore a stale packaged shape and keep one compact contract', () => {
  const schema = loadResultSchema('1.3.0');
  const files = {
    'manifest.json': JSON.stringify(MANIFEST),
    'memory_context.json': JSON.stringify(memoryContext()),
    'viewer_excerpts.jsonl': [
      JSON.stringify({seq: 1, viewer_ref: 1, at: '2026-11-08T10:00:01.000Z', content: 'ギターを始めました'}),
      JSON.stringify({seq: 2, viewer_ref: 2, at: '2026-11-08T10:00:02.000Z', content: 'こんにちは'})
    ].join('\n'),
    'result.schema.json': JSON.stringify(schema),
    // A package created by the old provider build: full result shape, fixed
    // English example and a viewer_id instruction. It must not reach the model.
    'instructions.md': '## 出力例\n```json\n{"locale": "en", "viewer_memory_updates": [{"viewer_id": "youtube:UC_exact"}]}\n```'
  };
  const prompt = buildMemoryPrompt(files);
  const user = prompt.messages.find((message) => message.role === 'user').content;
  assert.equal(prompt.locale, 'ja');
  assert.match(user, /自然な日本語/);
  assert.match(user, /ギターを始めました/);
  assert.match(user, /- ref 1: nickname="A"; evidence_seqs=\[1\]; zero_excerpt=false/);
  assert.doesNotMatch(user, /"locale": "en"/);
  assert.doesNotMatch(user, /youtube:UC_exact/);
  assert.ok(user.includes('"ref": 1'));
  assert.ok(!user.includes('"viewer_id": "youtube:UC_A"'), 'viewer ids are never sent in the compact contract');
});

test('compact assembly always restores the program-owned viewer id', () => {
  const answer = {
    viewers: [
      {
        ref: 1,
        memory: {
          viewer_id: 'youtube:UC_B',
          summary: 'attempted identity override',
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'guitar',
            statement: 'likes guitar',
            certainty: 'stated',
            evidence: [1]
          }]
        }
      },
      {ref: 2, memory: {no_new_information: true, operations: []}}
    ]
  };
  const assembled = assembleMemoryCompact({answer, manifest: MANIFEST, refs: refs()});
  assert.equal(assembled.ok, true);
  assert.deepEqual(assembled.result.viewer_memory_updates.map((entry) => entry.viewer_id), [
    'youtube:UC_A',
    'youtube:UC_B'
  ]);
  assert.equal(assembled.ignoredFields.length, 1);
  assert.deepEqual(assembled.ignoredFields[0].fields, ['viewer_id']);
  assert.equal(assembled.result.locale, 'ja');
});

test('only whitelisted memory fields survive; operations remain fully validated', () => {
  assert.deepEqual([...MEMORY_UPDATE_FIELDS].sort(), [
    'no_new_information',
    'operations',
    'summary',
    'summary_certainty'
  ]);
  const answer = {
    viewers: [{
      ref: 1,
      memory: {
        summary: 'summary',
        session_id: 'ses_other',
        ref: 2,
        no_new_information: false,
        operations: [{op: 'invent', kind: 'interest', statement: 'x', evidence: [1]}]
      }
    }, {
      ref: 2,
      memory: {no_new_information: true, operations: []}
    }]
  };
  const assembled = assembleMemoryCompact({answer, manifest: MANIFEST, refs: refs()});
  assert.equal(assembled.ok, true);
  const first = assembled.result.viewer_memory_updates[0];
  assert.equal(first.viewer_id, 'youtube:UC_A');
  assert.equal(first.session_id, undefined);
  assert.equal(first.ref, undefined);
  // Unknown operation fields are NOT silently dropped: full schema validation
  // must still reject them before anything is imported.
  assert.equal(first.operations[0].op, 'invent');
});

test('duplicate, unknown and missing refs are diagnosed without guessing', () => {
  const duplicate = inspectCompactMemory({
    viewers: [
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 1, memory: {no_new_information: true, operations: []}}
    ]
  }, {refs: refs()});
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.issues.some((item) => item.code === 'MEMORY_REF_DUPLICATE'));
  assert.deepEqual(duplicate.missing, [2]);

  const unknown = inspectCompactMemory({
    viewers: [
      {ref: 1, memory: {no_new_information: true, operations: []}},
      {ref: 2, memory: {no_new_information: true, operations: []}},
      {ref: 3, memory: {no_new_information: true, operations: []}}
    ]
  }, {refs: refs()});
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some((item) => item.code === 'MEMORY_REF_UNKNOWN'));
});

test('the compact schema itself forbids viewer_id inside memory', () => {
  const schema = buildMemoryCompactSchema({resultSchema: loadResultSchema('1.3.0'), refs: refs()});
  const memory = schema.properties.viewers.items.properties.memory;
  assert.equal(memory.additionalProperties, false);
  assert.equal(Object.prototype.hasOwnProperty.call(memory.properties, 'viewer_id'), false);
  assert.deepEqual(memory.required.sort(), ['no_new_information', 'operations']);
});
