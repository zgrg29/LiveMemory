import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {
  T0,
  addBroadcaster,
  closeDatabase,
  makeBatchResult,
  openMemoryDb,
  readBatchPackage,
  seedSession
} from '../helpers/ai-fixtures.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {
  buildInstructions,
  instructionLocales,
  instructionVersion
} from '../../src/ai/prompts/instructions.mjs';
import {
  PROMPT_VERSION,
  RESULT_SCHEMA_VERSION,
  promptVersionFor
} from '../../src/ai/constants.mjs';
import {validateAgainstSchema} from '../../src/ai/import/schema-validator.mjs';
import {loadResultSchema} from '../../src/ai/import/validate.mjs';

const LOCALES = ['zh-CN', 'ja', 'en'];

test('all three prompt languages carry the same batch, aggregate and provenance rules', () => {
  assert.deepEqual(instructionLocales().sort(), LOCALES.slice().sort());
  for (const locale of LOCALES) {
    const batch = buildInstructions(locale, {
      session: {id: 'ses_test', platform: 'youtube', simulated: true, started_at: T0, ended_at: T0 + 1000},
      broadcaster: {id: 'youtube:UC_TEST', name: 'Tester', identity: 'verified'},
      messageCount: 500,
      support: [],
      jobId: 'aij_test',
      taskId: 'ses_test-analysis-b01',
      promptVersion: promptVersionFor(locale),
      batch: {
        index: 1,
        total: 3,
        batchId: 'aij_test-b01',
        fromSeq: 1,
        toSeq: 500,
        messageCount: 500,
        fromAt: T0,
        toAt: T0 + 500_000
      }
    });
    assert.match(batch, /aij_test-b01/);
    assert.match(batch, /ses_test-analysis-b01/);
    assert.match(batch, /schema_version/);
    assert.match(batch, /1\.2\.0/);
    assert.match(batch, /message_refs/);
    assert.match(batch, /observed/);
    assert.match(batch, /inferred/);
    assert.match(batch, /viewer_profiles/);
    assert.match(batch, /viewer_memory_updates/);
    assert.match(batch, /confidence/);
    assert.match(batch, /500/);
    // Language-specific headings must not be mixed.
    assert.ok(!batch.includes('## Package contents') || locale === 'en');
    assert.ok(!batch.includes('## 分析包内容') || locale === 'zh-CN');

    const aggregate = buildInstructions(locale, {
      session: {id: 'ses_test', platform: 'youtube', simulated: false, started_at: T0, ended_at: T0 + 1000},
      broadcaster: {id: 'youtube:UC_TEST', name: 'Tester', identity: 'verified'},
      messageCount: 1500,
      support: [],
      jobId: 'aij_test',
      taskId: 'ses_test-analysis-final',
      promptVersion: promptVersionFor(locale),
      aggregate: {batchCount: 3}
    });
    assert.match(aggregate, /batch_results\.json/);
    assert.match(aggregate, /ses_test-analysis-final/);
    assert.match(aggregate, /\{.?batch.?/i);
    assert.match(aggregate, /seq/);
    assert.match(aggregate, /1\.2\.0/);
  }
});

test('prompt versions are explicit, stable per locale and recorded on jobs', async () => {
  assert.equal(PROMPT_VERSION, 'lm-prompt-m6.2');
  for (const locale of LOCALES) {
    assert.equal(promptVersionFor(locale), `lm-prompt-m6.2-${locale}`);
    assert.equal(instructionVersion(locale), promptVersionFor(locale));
  }
  assert.equal(promptVersionFor('fr'), 'lm-prompt-m6.2-en');

  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 3});
  const exportsDir = join(temp.dir, 'exports');
  const job = await createAnalysisJob({db, sessionId: session.id, locale: 'ja', exportsDir, batchSize: 1000, now: T0 + 10_000});
  assert.equal(job.job.promptVersion, 'lm-prompt-m6.2-ja');
  const packageData = readBatchPackage(exportsDir, job.packages[0]);
  assert.equal(packageData.manifest.prompt_version, 'lm-prompt-m6.2-ja');
  assert.equal(packageData.manifest.schema_version, RESULT_SCHEMA_VERSION);
  closeDatabase(db);
  temp.cleanup();
});

test('the result schema accepts v1.0 answers and the M6 optional extensions, but rejects unknown fields', () => {
  const schema = loadResultSchema();
  const oldAnswer = {
    protocol: 'livememory-analysis-result-v1',
    task_id: 'ses_x-topics',
    session_id: 'ses_x',
    locale: 'en',
    session_topics: {summary: 's', topics: [], sentiment: [], disputes: [], highlights: []},
    viewer_profiles: []
  };
  assert.deepEqual(validateAgainstSchema(schema, oldAnswer), []);

  const extended = {
    ...oldAnswer,
    schema_version: '1.1.0',
    job_id: 'aij_x',
    batch_id: 'aij_x-b01',
    broadcaster_id: null,
    session_topics: {
      summary: 's',
      topics: [{
        title: 't',
        started_at: '2026-11-08T10:00:00.000Z',
        ended_at: '2026-11-08T10:01:00.000Z',
        summary: 's',
        key_points: ['p'],
        confidence: 0.5,
        evidence: 'inferred',
        message_refs: [1, {batch: 2, seq: 3}]
      }],
      sentiment: [{at: '2026-11-08T10:00:00.000Z', tone: 'mixed', note: 'n', confidence: 0.4, sample_size: 3, evidence_note: 'small'}],
      disputes: [{
        summary: 'd',
        started_at: '2026-11-08T10:00:00.000Z',
        note: 'n',
        confidence: 0.3,
        title: 'Dispute',
        viewpoints: ['a', 'b'],
        evidence: 'inferred',
        message_refs: [{batch: 1, seq: 1}]
      }],
      highlights: [{
        started_at: '2026-11-08T10:00:00.000Z',
        ended_at: '2026-11-08T10:01:00.000Z',
        reason: 'r',
        clip_suggestion: 'c',
        title: 'h',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [2]
      }]
    }
  };
  assert.deepEqual(validateAgainstSchema(schema, extended), []);

  const unknown = structuredClone(oldAnswer);
  unknown.extra = true;
  assert.ok(validateAgainstSchema(schema, unknown).some((error) => error.code === 'SCHEMA_UNKNOWN_FIELD'));

  const badRef = structuredClone(extended);
  badRef.session_topics.topics[0].message_refs = [{batch: 1}];
  assert.ok(validateAgainstSchema(schema, badRef).length > 0);

  const badVersion = structuredClone(extended);
  badVersion.schema_version = '2.0.0';
  assert.ok(validateAgainstSchema(schema, badVersion).some((error) => error.code === 'SCHEMA_ENUM'));
});

test('schema-valid answers built from real package metadata pass semantic validation', async () => {
  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 8});
  const exportsDir = join(temp.dir, 'exports');
  const job = await createAnalysisJob({db, sessionId: session.id, locale: 'en', exportsDir, now: T0 + 20_000});
  const data = readBatchPackage(exportsDir, job.packages[0]);
  const {validateAnalysisImport} = await import('../../src/ai/import/validate.mjs');
  const preview = validateAnalysisImport({
    db,
    text: JSON.stringify(makeBatchResult(data.manifest, data.messages, data.viewers)),
    now: T0 + 30_000
  });
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.target.schemaVersion, '1.1.0');
  assert.equal(preview.target.protocol, 'livememory-analysis-result-v1');
  closeDatabase(db);
  temp.cleanup();
});
