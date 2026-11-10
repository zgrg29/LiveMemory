import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openMemoryDb, addBroadcaster, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {jobMemoryCoverage, listJobMemoryViewers} from '../../src/storage/repositories/ai-jobs.mjs';
import {getMemory, listFacts} from '../../src/storage/repositories/viewer-memory.mjs';
import {loadMemoryFacts} from '../../src/memory/model.mjs';
import {objectiveHistory} from '../../src/memory/objective.mjs';

/**
 * Unified AI analysis + long-term memory.
 *
 * A single exported task covers session analysis AND every identifiable viewer.
 * Importing a batch applies the report and the viewer memory in one transaction.
 * The tests use synthetic responses shaped exactly like a real AI answer; no
 * external service is called.
 */

function readPackage(dir, pkg) {
  const buffer = readFileSync(join(dir, pkg.fileName));
  return {
    buffer,
    manifest: JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8')),
    memoryContext: JSON.parse(readZipEntry(buffer, 'memory_context.json').toString('utf8')),
    excerpts: readZipEntry(buffer, 'viewer_excerpts.jsonl').toString('utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  };
}

function makeResult(dir, pkg, {operationFor = null, profiles = []} = {}) {
  const data = readPackage(dir, pkg);
  const updates = data.memoryContext.viewers.map((viewer) => {
    const excerpts = data.excerpts.filter((entry) => entry.viewer_id === viewer.viewer_id);
    const operations = operationFor ? operationFor(viewer, excerpts, data) : [];
    if (!operations || operations.length === 0) {
      return {viewer_id: viewer.viewer_id, no_new_information: true, operations: []};
    }
    return {
      viewer_id: viewer.viewer_id,
      no_new_information: false,
      operations
    };
  });
  const payload = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    job_id: data.manifest.job_id,
    batch_id: data.manifest.batch.batch_id,
    broadcaster_id: data.manifest.broadcaster_id,
    task_id: data.manifest.tasks[0].task_id,
    session_id: data.manifest.session_id,
    locale: data.manifest.locale,
    session_topics: {
      summary: 'Synthetic unified session',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    },
    viewer_profiles: profiles,
    viewer_memory_updates: updates
  };
  return {text: JSON.stringify(payload), payload, data};
}

function importPackage(db, dir, pkg, options = {}) {
  const {text} = makeResult(dir, pkg, options);
  return importAnalysisResult({db, text, now: T0 + 100000});
}

function oneMessageSession(db, index, content) {
  const session = seedSession(db, {
    id: `ses_low_${index}`,
    title: `Low frequency ${index}`,
    messageCount: 1,
    viewerCount: 1,
    viewerUidPrefix: 'UC_LOW_FREQ',
    startedAt: T0 + index * HOUR
  });
  db.prepare('UPDATE events SET content = ? WHERE session_id = ?').run(content, session.id);
  return session;
}

test('A: five one-message broadcasts accumulate objective and semantic memory', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const contents = [
    '晚上好',
    '今天又来了',
    '最近在学画画',
    '昨天画了一只猫',
    '最近开始画二次元人物了'
  ];
  let firstSave = null;
  for (let index = 0; index < contents.length; index += 1) {
    const session = oneMessageSession(db, index, contents[index]);
    const created = await createAnalysisJob({
      db,
      sessionId: session.id,
      locale: 'en',
      exportsDir: temp.dir,
      now: T0 + index * HOUR + 10000
    });
    assert.ok(created);
    assert.equal(created.job.memoryViewersTotal, 1);
    const pkg = created.packages[0];
    const operationIndex = index >= 2 ? index - 2 : -1;
    const result = makeResult(temp.dir, pkg, {
      operationFor: (viewer, excerpts) => {
        if (operationIndex < 0) return [];
        const themes = [
          {topic: '绘画', statement: '最近在学画画'},
          {topic: '绘画练习', statement: '昨天画了一只猫'},
          {topic: '二次元人物绘画', statement: '最近开始画二次元人物了'}
        ];
        const theme = themes[operationIndex];
        return [{
          op: 'add',
          kind: 'interest',
          topic: theme.topic,
          statement: theme.statement,
          certainty: 'stated',
          confidence: 0.9,
          evidence: [excerpts[0].seq]
        }];
      }
    });
    const preview = validateAnalysisImport({db, text: result.text, now: T0 + index * HOUR + 20000});
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.memory.coverage.total, 1);
    assert.equal(preview.memory.coverage.missing_update, 0);
    const outcome = importAnalysisResult({db, text: result.text, now: T0 + index * HOUR + 30000});
    assert.equal(outcome.duplicate, false);
    if (!firstSave) firstSave = session.id;
  }

  const memory = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: 'youtube:UC_LOW_FREQ_0'});
  assert.ok(memory);
  assert.ok(memory.version >= 3, `expected semantic versions, got ${memory.version}`);
  const facts = listFacts(db, memory.id, {limit: 100});
  const statements = facts.map((fact) => fact.statement);
  assert.ok(statements.some((text) => text.includes('画画')));
  assert.ok(statements.some((text) => text.includes('二次元')));
  // The two greetings never became interests.
  assert.equal(statements.some((text) => text.includes('晚上好')), false);

  const objective = objectiveHistory(db, {
    broadcasterId: 'youtube:UC_AI_TEST',
    viewerId: 'youtube:UC_LOW_FREQ_0'
  });
  assert.equal(objective.viewer.sessionCount, 5);
  assert.equal(objective.viewer.messageCount, 5);
  assert.equal(objective.recentSessions.length, 5);
  assert.equal(objective.recentSessions.every((row) => row.messageCount === 1), true);
  assert.equal(memory.lastSessionId, 'ses_low_4');
});

test('B: a greeting updates objective history without inventing an interest', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = oneMessageSession(db, 0, '晚上好');
  const created = await createAnalysisJob({db, sessionId: session.id, locale: 'zh-CN', exportsDir: temp.dir, now: T0 + 10000});
  const result = makeResult(temp.dir, created.packages[0]);
  const preview = validateAnalysisImport({db, text: result.text});
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.memory.coverage.no_semantics, 1);
  assert.equal(preview.memory.coverage.missing_update, 0);
  importAnalysisResult({db, text: result.text});
  const memory = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: 'youtube:UC_LOW_FREQ_0'});
  assert.ok(memory);
  assert.equal(memory.version, 0);
  assert.equal(listFacts(db, memory.id).length, 0);
  const objective = objectiveHistory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: 'youtube:UC_LOW_FREQ_0'});
  assert.equal(objective.viewer.sessionCount, 1);
  assert.equal(objective.viewer.messageCount, 1);
  assert.equal(objective.recentSessions[0].sessionId, session.id);
});

test('C: one informative message is enough to create a sourced memory', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = oneMessageSession(db, 0, '我最近在学习国画');
  const created = await createAnalysisJob({db, sessionId: session.id, locale: 'zh-CN', exportsDir: temp.dir, now: T0 + 10000});
  const result = makeResult(temp.dir, created.packages[0], {
    operationFor: (viewer, excerpts) => [{
      op: 'add',
      kind: 'life_event',
      topic: '国画学习',
      statement: '最近在学习国画',
      certainty: 'stated',
      confidence: 0.95,
      evidence: [excerpts[0].seq]
    }]
  });
  const preview = validateAnalysisImport({db, text: result.text});
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.memory.totals.semanticViewers, 1);
  assert.equal(preview.memory.plan[0].counts.added, 1);
  importAnalysisResult({db, text: result.text});
  const memory = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId: 'youtube:UC_LOW_FREQ_0'});
  const facts = loadMemoryFacts(db, memory.id);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].statement, '最近在学习国画');
  assert.equal(facts[0].certainty, 'stated');
  assert.ok(facts[0].evidence.length >= 1);
  assert.equal(facts[0].evidence[0].seq, 1);
});

test('D: hundreds of low-activity viewers are all covered, without a Top N cut', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = seedSession(db, {
    messageCount: 300,
    viewerCount: 300,
    viewerUidPrefix: 'UC_MANY',
    title: 'Many low activity viewers'
  });
  const created = await createAnalysisJob({db, sessionId: session.id, locale: 'en', exportsDir: temp.dir, now: T0 + 10000});
  assert.ok(created.job.batchTotal >= 2, 'viewer coverage must drive at least two batches');
  assert.equal(created.job.memoryViewersTotal, 300);
  const totalMemoryViewers = created.packages.reduce((sum, pkg) => sum + pkg.memoryViewerCount, 0);
  assert.equal(totalMemoryViewers, 300, 'every viewer appears in exactly one memory batch');
  assert.equal(new Set(created.packages.map((pkg) => pkg.memoryViewerCount)).size <= created.packages.length, true);

  const before = jobMemoryCoverage(db, created.job.id);
  assert.equal(before.total, 300);
  assert.equal(before.pending, 300);
  assert.equal(before.covered, 0);

  let imported = 0;
  for (const pkg of created.packages) {
    const result = makeResult(temp.dir, pkg);
    const preview = validateAnalysisImport({db, text: result.text});
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.memory.coverage.missing_update, 0);
    importAnalysisResult({db, text: result.text});
    imported += 1;
  }
  assert.equal(imported, created.packages.length);
  const after = jobMemoryCoverage(db, created.job.id);
  assert.equal(after.total, 300);
  assert.equal(after.pending, 0);
  assert.equal(after.missing_update, 0);
  assert.equal(after.complete, true);
  const memories = Number(db.prepare('SELECT COUNT(*) AS count FROM viewer_memories').get().count);
  assert.equal(memories, 300);
  const pending = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ai_job_memory_viewers WHERE job_id = ? AND status = 'pending'
  `).get(created.job.id).count);
  assert.equal(pending, 0);
});

test('E: cross-batch viewers stay in one memory batch, re-import is idempotent', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = seedSession(db, {
    messageCount: 600,
    viewerCount: 300,
    viewerUidPrefix: 'UC_CROSS',
    title: 'Cross batch coverage'
  });
  const created = await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'en',
    exportsDir: temp.dir,
    batchSize: 100,
    now: T0 + 10000
  });
  assert.ok(created.job.batchTotal >= 6);

  const assignments = listJobMemoryViewers(db, created.job.id);
  assert.equal(assignments.length, 300);
  assert.equal(new Set(assignments.map((row) => row.viewerId)).size, 300);
  const targetViewer = 'youtube:UC_CROSS_0';
  const targetAssignment = assignments.find((row) => row.viewerId === targetViewer);
  assert.ok(targetAssignment);
  const targetPackage = created.packages.find((pkg) => pkg.batchIndex === targetAssignment.batchIndex);
  const targetData = readPackage(temp.dir, targetPackage);
  const targetExcerpts = targetData.excerpts.filter((entry) => entry.viewer_id === targetViewer);
  assert.equal(targetExcerpts.length, 2, 'all of the viewer sessions messages are together');
  assert.equal(
    created.packages.filter((pkg) => {
      const data = readPackage(temp.dir, pkg);
      return data.memoryContext.viewers.some((viewer) => viewer.viewer_id === targetViewer);
    }).length,
    1,
    'the viewer is assigned to exactly one memory batch'
  );

  const first = makeResult(temp.dir, created.packages[0]);
  const firstImport = importAnalysisResult({db, text: first.text});
  assert.equal(firstImport.duplicate, false);
  const partial = jobMemoryCoverage(db, created.job.id);
  assert.ok(partial.pending > 0);
  assert.ok(partial.covered > 0);

  const second = makeResult(temp.dir, created.packages[2]);
  const third = makeResult(temp.dir, created.packages[1]);
  importAnalysisResult({db, text: third.text});
  importAnalysisResult({db, text: second.text});
  const afterThree = jobMemoryCoverage(db, created.job.id);
  assert.ok(afterThree.covered > partial.covered);

  const duplicate = importAnalysisResult({db, text: first.text});
  assert.equal(duplicate.duplicate, true);
  const afterDuplicate = jobMemoryCoverage(db, created.job.id);
  assert.equal(afterDuplicate.covered, afterThree.covered);

  for (const pkg of created.packages) {
    const result = makeResult(temp.dir, pkg);
    const preview = validateAnalysisImport({db, text: result.text});
    if (!preview.ok && preview.target?.duplicate) continue;
    if (!preview.ok) {
      assert.fail(`unexpected preview failure: ${JSON.stringify(preview.errors)}`);
    }
    const outcome = importAnalysisResult({db, text: result.text});
    assert.ok(outcome.duplicate === true || outcome.duplicate === false);
  }
  const complete = jobMemoryCoverage(db, created.job.id);
  assert.equal(complete.total, 300);
  assert.equal(complete.pending, 0);
  assert.equal(complete.missing_update, 0);
});

test('a missing viewer update is blocked instead of silently skipping the viewer', async (t) => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = seedSession(db, {messageCount: 4, viewerCount: 2, viewerUidPrefix: 'UC_MISS'});
  const created = await createAnalysisJob({db, sessionId: session.id, locale: 'en', exportsDir: temp.dir, now: T0 + 10000});
  const result = makeResult(temp.dir, created.packages[0]);
  result.payload.viewer_memory_updates = result.payload.viewer_memory_updates.slice(1);
  const preview = validateAnalysisImport({db, text: JSON.stringify(result.payload)});
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.some((error) => error.code === 'MEMORY_VIEWER_UPDATE_MISSING'));
});
