import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {seedGoldCorpus, loadSavedFacts} from '../helpers/memory-quality.mjs';
import {
  GQ_GOLD_FACTS,
  GQ_IDENTITY_CHECKS,
  GQ_SESSIONS,
  goldStats
} from '../fixtures/memory-quality/gold-corpus.mjs';
import {createViewerMemoryJob} from '../../src/ai/export/split-jobs.mjs';
import {buildMemoryRefs, assembleMemoryCompact} from '../../src/ai/api/compact.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {MEMORY_FILES} from '../../src/ai/api/prompts.mjs';
import {readAnalysisPackage} from '../../src/ai/api/prompts.mjs';
import {evaluateMemoryQuality} from '../../src/ai/quality/metrics.mjs';
import {countFactQuality} from '../../src/ai/quality/facts.mjs';
import {listSessionViewers} from '../../src/storage/repositories/viewers.mjs';
import {getMemory} from '../../src/storage/repositories/viewer-memory.mjs';
import {createSession, endSession} from '../../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {buildMemoryPrompt, buildTargetedMemoryPrompt} from '../../src/ai/api/prompts.mjs';

/**
 * RC0-MEMORY-QUALITY integration test.
 *
 * The "oracle" is a deterministic client of the *real* compact-answer assembler,
 * schema validation, importer and memory engine. It proves the local pipeline
 * can store every annotated fact when the answer is correct. It is not a model
 * and is never used to claim semantic quality.
 */

function excerptLines(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function goldForSession(sessionKey) {
  return GQ_GOLD_FACTS.filter((fact) => (
    fact.status !== 'superseded'
    && fact.shouldPersist === true
    && fact.ambiguous !== true
    && fact.evidence.some((evidence) => evidence.sessionKey === sessionKey)
  ));
}

function oracleAnswer(files, goldFacts) {
  const manifest = JSON.parse(files['manifest.json']);
  const context = JSON.parse(files['memory_context.json']);
  const refs = buildMemoryRefs(context);
  const refByViewer = new Map(refs.map((entry) => [entry.viewerId, entry.ref]));
  const linesByViewer = new Map();
  for (const line of excerptLines(files['viewer_excerpts.jsonl'])) {
    const list = linesByViewer.get(line.viewer_id) ?? [];
    list.push(line);
    linesByViewer.set(line.viewer_id, list);
  }
  const viewers = context.viewers.map((viewer) => {
    const lines = linesByViewer.get(viewer.viewer_id) ?? [];
    const facts = goldFacts.filter((fact) => fact.viewerKey === viewer.viewer_id);
    const operations = [];
    for (const fact of facts) {
      const wanted = new Set(fact.evidence.map((evidence) => evidence.content));
      const seqs = lines.filter((line) => wanted.has(line.content)).map((line) => line.seq);
      if (seqs.length === 0) continue;
      operations.push({
        op: 'add',
        kind: fact.category,
        topic: fact.aliases[0] ?? fact.category,
        statement: fact.statement,
        certainty: 'stated',
        confidence: 0.9,
        evidence: [...new Set(seqs)]
      });
    }
    return {
      ref: refByViewer.get(viewer.viewer_id),
      memory: operations.length > 0
        ? {no_new_information: false, operations}
        : {no_new_information: true, operations: []}
    };
  });
  return {manifest, answer: {viewers}};
}

async function importOracleForSession({db, exportsDir, sessionId, locale = 'zh-CN', cap = 10, sessionKey}) {
  const created = await createViewerMemoryJob({
    db,
    sessionId,
    locale,
    exportsDir,
    viewersPerBatch: cap,
    viewersPerBatchHard: cap,
    excerptCap: 600,
    now: Date.parse('2026-11-20T00:00:00.000Z')
  });
  assert.ok(created, 'memory job created');
  const gold = goldForSession(sessionKey);
  for (const pkg of created.packages) {
    const files = readAnalysisPackage(join(exportsDir, pkg.fileName), MEMORY_FILES);
    const {manifest, answer} = oracleAnswer(files, gold);
    const refs = buildMemoryRefs(JSON.parse(files['memory_context.json']));
    const assembled = assembleMemoryCompact({answer, manifest, refs});
    assert.equal(assembled.ok, true, JSON.stringify(assembled.issues));
    importAnalysisResult({db, text: JSON.stringify(assembled.result)});
  }
  return {created, gold};
}

test('gold corpus stats and identity scenarios are internally consistent', () => {
  const stats = goldStats();
  assert.equal(stats.sessions, 3);
  assert.ok(stats.viewers >= 12, `expected at least 12 viewers, got ${stats.viewers}`);
  assert.ok(stats.currentFacts >= 25, `expected at least 25 current facts, got ${stats.currentFacts}`);
  assert.ok(stats.importantFacts >= 8);
  assert.ok(stats.negatives >= 15);
  // Every evidence key resolves to a message in the declared session.
  for (const fact of GQ_GOLD_FACTS) {
    assert.ok(fact.evidence.length > 0, `${fact.id} has no evidence`);
    for (const evidence of fact.evidence) {
      const session = GQ_SESSIONS.find((entry) => entry.key === evidence.sessionKey);
      const message = session?.messages.find((entry) => entry.seq === evidence.seq);
      assert.ok(message, `${fact.id}: evidence ${evidence.sessionKey}#${evidence.seq} does not exist`);
      assert.equal(message.content, evidence.content);
    }
  }
  // Same-name collision is real in the fixture; the ids must differ.
  const [a, b] = GQ_IDENTITY_CHECKS.sameNameDifferentViewer.viewerKeys;
  assert.notEqual(a, b);
});

test('5/10/20 viewer batches are all covered and the oracle answer is stored fully', async () => {
  for (const cap of [5, 10, 20]) {
    const temp = createTempDir(`lm-gq-cap${cap}-`);
    const exportsDir = mkdtempSync(join(temp.dir, 'exports-'));
    const server = await startServer({
      auth: false,
      dataDir: temp.dir,
      port: 0,
      systemLocale: 'en',
      auto: {memoryViewerCapHard: cap}
    });
    try {
      seedGoldCorpus(server.db);
      const session = GQ_SESSIONS[0];
      const {created, gold} = await importOracleForSession({
        db: server.db,
        exportsDir,
        sessionId: session.id,
        locale: 'zh-CN',
        cap,
        sessionKey: session.key
      });
      const facts = loadSavedFacts(server.db, {jobId: created.job.id});
      const evaluation = evaluateMemoryQuality({facts, goldFacts: gold, negatives: []});
      assert.equal(evaluation.summary.gold.total, gold.length);
      assert.equal(evaluation.summary.saved.total, gold.length, `cap ${cap}: every oracle fact must be stored`);
      assert.equal(
        evaluation.summary.recall,
        1,
        `cap ${cap}: strict recall should be 100%; missed=${evaluation.missed.map((fact) => fact.id).join(',')}`
      );
      assert.equal(evaluation.summary.accuracy, 1, `cap ${cap}: oracle facts should be evidence-supported`);
      assert.equal(evaluation.summary.crossViewerEvidence, 0);
      const quality = countFactQuality(server.db, created.job.id);
      assert.equal(quality.total, gold.length);
      assert.equal(quality.stated, gold.length);
      assert.equal(quality.uncertain, 0);
      assert.equal(quality.active, gold.length);
      // Every viewer is assigned exactly once across the planned batches.
      const assigned = server.db.prepare(`
        SELECT viewer_id, COUNT(*) AS n FROM ai_job_memory_viewers WHERE job_id = ? GROUP BY viewer_id
      `).all(created.job.id);
      assert.equal(assigned.length, listSessionViewers(server.db, session.id, {limit: 1000}).length);
      assert.ok(assigned.every((row) => Number(row.n) === 1));
    } finally {
      await server.close();
      temp.cleanup();
    }
  }
});

test('gold annotations never leak into a memory package', async () => {
  const temp = createTempDir('lm-gq-leak-');
  const exportsDir = mkdtempSync(join(temp.dir, 'exports-'));
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  try {
    seedGoldCorpus(server.db);
    const created = await createViewerMemoryJob({
      db: server.db,
      sessionId: GQ_SESSIONS[0].id,
      locale: 'zh-CN',
      exportsDir,
      viewersPerBatch: 10,
      viewersPerBatchHard: 10
    });
    for (const pkg of created.packages) {
      const text = readFileSync(join(exportsDir, pkg.fileName)).toString('utf8');
      assert.equal(text.includes('shouldPersist'), false);
      assert.equal(text.includes('f-haru-cs'), false);
      // A unique gold statement that is not present verbatim in any chat line.
      assert.equal(text.includes('在研究生院学习计算机科学'), false);
    }
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('a degraded answer is measured as missed / no-save rather than silently accepted', async () => {
  const temp = createTempDir('lm-gq-degraded-');
  const exportsDir = mkdtempSync(join(temp.dir, 'exports-'));
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  try {
    seedGoldCorpus(server.db);
    const session = GQ_SESSIONS[0];
    const gold = goldForSession(session.key);
    const created = await createViewerMemoryJob({
      db: server.db,
      sessionId: session.id,
      locale: 'zh-CN',
      exportsDir,
      viewersPerBatch: 20,
      viewersPerBatchHard: 20
    });
    const pkg = created.packages[0];
    const files = readAnalysisPackage(join(exportsDir, pkg.fileName), MEMORY_FILES);
    const context = JSON.parse(files['memory_context.json']);
    const refs = buildMemoryRefs(context);
    const refByViewer = new Map(refs.map((entry) => [entry.viewerId, entry.ref]));
    const lines = excerptLines(files['viewer_excerpts.jsonl']);
    const byViewer = new Map();
    for (const line of lines) {
      const list = byViewer.get(line.viewer_id) ?? [];
      list.push(line);
      byViewer.set(line.viewer_id, list);
    }
    const haru = 'youtube:UC_GQ_haru';
    const mika = 'youtube:UC_GQ_mika';
    const haruGold = gold.filter((fact) => fact.viewerKey === haru);
    const kept = haruGold[0];
    const keptSeqs = (byViewer.get(haru) ?? [])
      .filter((line) => kept.evidence.some((evidence) => evidence.content === line.content))
      .map((line) => line.seq);
    const tired = (byViewer.get(mika) ?? []).find((line) => line.content.includes('疲れすぎた'));
    assert.ok(tired, 'temporary mika message is in the package');
    const viewers = context.viewers.map((viewer) => {
      if (viewer.viewer_id === haru) {
        return {
          ref: refByViewer.get(haru),
          memory: {
            no_new_information: false,
            operations: [{
              op: 'add',
              kind: kept.category,
              topic: kept.aliases[0],
              statement: kept.statement,
              certainty: 'stated',
              evidence: keptSeqs
            }]
          }
        };
      }
      if (viewer.viewer_id === mika) {
        return {
          ref: refByViewer.get(mika),
          memory: {
            no_new_information: false,
            operations: [{
              op: 'add',
              kind: 'other',
              topic: '今日疲惫',
              statement: '今天非常疲惫',
              certainty: 'stated',
              evidence: [tired.seq]
            }]
          }
        };
      }
      return {ref: refByViewer.get(viewer.viewer_id), memory: {no_new_information: true, operations: []}};
    });
    const manifest = JSON.parse(files['manifest.json']);
    const assembled = assembleMemoryCompact({answer: {viewers}, manifest, refs});
    assert.equal(assembled.ok, true, JSON.stringify(assembled.issues));
    importAnalysisResult({db: server.db, text: JSON.stringify(assembled.result)});
    const facts = loadSavedFacts(server.db, {jobId: created.job.id});
    const evaluation = evaluateMemoryQuality({
      facts,
      goldFacts: gold,
      negatives: [
        {
          id: 'n-mika-tired',
          viewerKey: mika,
          sessionKey: session.key,
          seq: tired.seq,
          eventKey: `${session.id}#${tired.seq}`,
          content: tired.content
        }
      ]
    });
    assert.equal(evaluation.summary.saved.total, 2);
    assert.equal(evaluation.summary.correct, 1);
    assert.equal(evaluation.summary.noSaveEvidence, 1);
    assert.ok(evaluation.summary.recall < 1);
    assert.ok(evaluation.summary.falsePositiveRate > 0);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('a cross-viewer evidence attempt is rejected before it can create a fact', async () => {
  const temp = createTempDir('lm-gq-cross-');
  const exportsDir = mkdtempSync(join(temp.dir, 'exports-'));
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  try {
    seedGoldCorpus(server.db);
    const session = GQ_SESSIONS[0];
    const created = await createViewerMemoryJob({
      db: server.db,
      sessionId: session.id,
      locale: 'zh-CN',
      exportsDir,
      viewersPerBatch: 20,
      viewersPerBatchHard: 20
    });
    const files = readAnalysisPackage(join(exportsDir, created.packages[0].fileName), MEMORY_FILES);
    const context = JSON.parse(files['memory_context.json']);
    const refs = buildMemoryRefs(context);
    const refByViewer = new Map(refs.map((entry) => [entry.viewerId, entry.ref]));
    const lines = excerptLines(files['viewer_excerpts.jsonl']);
    const haru = 'youtube:UC_GQ_haru';
    const mika = 'youtube:UC_GQ_mika';
    const mikaLine = lines.find((line) => line.viewer_id === mika);
    assert.ok(mikaLine);
    const viewers = context.viewers.map((viewer) => (
      viewer.viewer_id === haru
        ? {
          ref: refByViewer.get(haru),
          memory: {
            no_new_information: false,
            operations: [{
              op: 'add',
              kind: 'interest',
              topic: 'borrowed',
              statement: '借用了别人的证据',
              certainty: 'stated',
              evidence: [mikaLine.seq]
            }]
          }
        }
        : {ref: refByViewer.get(viewer.viewer_id), memory: {no_new_information: true, operations: []}}
    ));
    const manifest = JSON.parse(files['manifest.json']);
    const assembled = assembleMemoryCompact({answer: {viewers}, manifest, refs});
    assert.equal(assembled.ok, true, JSON.stringify(assembled.issues));
    assert.throws(
      () => importAnalysisResult({db: server.db, text: JSON.stringify(assembled.result)}),
      (error) => String(error?.code ?? error?.message ?? error).includes('AI_IMPORT_INVALID')
    );
    // No fact may be created from the rejected answer.
    const facts = loadSavedFacts(server.db, {jobId: created.job.id});
    assert.equal(facts.length, 0);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('a high-frequency viewer excerpt window is disclosed, not silently truncated', async () => {
  const temp = createTempDir('lm-gq-window-');
  const exportsDir = mkdtempSync(join(temp.dir, 'exports-'));
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  try {
    seedGoldCorpus(server.db);
    const startedAt = Date.parse('2026-11-05T10:00:00.000Z');
    const session = createSession(server.db, {
      id: 'ses_gq_chatty',
      platform: 'youtube',
      platformRoomId: 'gq-chatty',
      roomTitle: 'Chatty viewer',
      broadcasterName: 'GQ Synthetic Broadcaster',
      broadcasterId: 'youtube:UC_GQ_BROADCASTER',
      broadcasterIdentity: 'verified',
      storageMode: 'full',
      sourceQuality: 'mock',
      simulated: true,
      startedAt
    });
    const ingest = new EventIngest({db: server.db, now: () => startedAt});
    for (let index = 0; index < 150; index += 1) {
      ingest.record({
        session_id: session.id,
        platform: 'youtube',
        event_type: 'chat',
        viewer_uid: 'UC_GQ_chatty',
        display_name: 'Chatty',
        occurred_at: startedAt + (index + 1) * 1000,
        content: index === 0 ? 'I play piano every day' : `filler message ${index}`,
        external_id: `chatty-${index}`,
        source_quality: 'mock'
      });
    }
    endSession(server.db, session.id, {status: 'ended', endedAt: startedAt + 200000, reason: 'adapter_end'});
    const created = await createViewerMemoryJob({
      db: server.db,
      sessionId: session.id,
      locale: 'en',
      exportsDir,
      viewersPerBatch: 10,
      viewersPerBatchHard: 10
    });
    const pkg = created.packages[0];
    const files = readAnalysisPackage(join(exportsDir, pkg.fileName), MEMORY_FILES);
    const manifest = JSON.parse(files['manifest.json']);
    const context = JSON.parse(files['memory_context.json']);
    const viewer = context.viewers.find((entry) => entry.viewer_id === 'youtube:UC_GQ_chatty');
    assert.ok(viewer);
    assert.equal(viewer.excerpt_total_messages, 150);
    assert.equal(viewer.excerpt_included_messages, 120);
    assert.equal(viewer.excerpt_omitted_messages, 30);
    assert.equal(viewer.excerpt_window, 'most_recent');
    assert.equal(manifest.batch_plan.excerpt_per_viewer_cap, 120);
    assert.equal(manifest.batch_plan.excerpt_omitted_messages, 30);
    assert.equal(manifest.batch_plan.excerpt_truncated_viewers, 1);
    const lines = excerptLines(files['viewer_excerpts.jsonl']);
    assert.equal(lines.length, 120);
    assert.equal(lines.some((line) => line.content === 'I play piano every day'), false);
    const prompt = buildMemoryPrompt(files, {structuredOutputs: false});
    assert.match(prompt.messages[1].content, /excerpt_omitted_messages/);
    assert.match(prompt.messages[1].content, /only that viewer's most recent messages/);
    const targeted = buildTargetedMemoryPrompt({
      prompt,
      missingRefs: [prompt.refs[0].ref]
    });
    assert.match(targeted.messages[1].content, /excerpt_omitted_messages/);
    assert.match(targeted.messages[1].content, /"excerpt_omitted_messages":30/);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('nickname changes keep one stable viewer id and never merge the same display name', async () => {
  const temp = createTempDir('lm-gq-identity-');
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  try {
    seedGoldCorpus(server.db);
    const haru = GQ_IDENTITY_CHECKS.renamed.viewerKey;
    const memory = getMemory(server.db, {
      broadcasterId: 'youtube:UC_GQ_BROADCASTER',
      viewerId: haru
    });
    // No memory has been written yet, but the viewer identity must exist once.
    const viewers = server.db.prepare('SELECT id FROM viewers WHERE id = ?').all(haru);
    assert.equal(viewers.length, 1);
    const nickA = GQ_IDENTITY_CHECKS.sameNameDifferentViewer.viewerKeys[0];
    const nickB = GQ_IDENTITY_CHECKS.sameNameDifferentViewer.viewerKeys[1];
    assert.notEqual(nickA, nickB);
    const both = server.db.prepare('SELECT id FROM viewers WHERE id IN (?, ?) ORDER BY id').all(nickA, nickB);
    assert.equal(both.length, 2);
    assert.equal(new Set(both.map((row) => row.id)).size, 2);
    // The seeder never writes memory directly.
    assert.equal(memory, null);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
