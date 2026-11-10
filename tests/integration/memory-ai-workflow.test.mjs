import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  addBroadcaster,
  openMemoryDb,
  seedSession,
  T0
} from '../helpers/ai-fixtures.mjs';
import {T_DAY} from '../helpers/memory-fixtures.mjs';
import {createMemoryUpdateJob, inspectMemoryPackage} from '../../src/memory/export.mjs';
import {validateMemoryImport} from '../../src/memory/validate.mjs';
import {importMemoryUpdate} from '../../src/memory/importer.mjs';
import {buildMemoryJobView, buildViewerMemoryView} from '../../src/memory/view.mjs';
import {mergeSessionIntoMemory} from '../../src/memory/local.mjs';
import {
  getMemory,
  getMemoryJob,
  listFacts,
  listMemoryBatches
} from '../../src/storage/repositories/viewer-memory.mjs';
import {MEMORY_PROTOCOL} from '../../src/memory/constants.mjs';

const BROADCASTER = 'youtube:UC_AI_TEST';
const VIEWER_0 = 'youtube:UC_VIEWER_0';
const VIEWER_1 = 'youtube:UC_VIEWER_1';

async function scenario({
  viewersPerBatch = 20,
  messageCount = 20,
  viewerCount = 2,
  before = null
} = {}) {
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount, viewerCount});
  if (before) await before({db, session});
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-job-'));
  const created = await createMemoryUpdateJob({
    db,
    sessionId: session.id,
    locale: 'en',
    exportsDir,
    viewersPerBatch,
    now: T0 + 1000
  });
  const packages = await Promise.all(created.batches.map((batch) => inspectMemoryPackage(join(exportsDir, batch.fileName))));
  return {
    db,
    session,
    exportsDir,
    created,
    packages,
    cleanup() {
      db.close();
      rmSync(exportsDir, {recursive: true, force: true});
    }
  };
}

function resultFor(manifest, overrides = {}) {
  return {
    protocol: MEMORY_PROTOCOL,
    schema_version: '1.0.0',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.batch.task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    viewer_operations: [],
    ...overrides
  };
}

function firstSeqFor(pkg, viewerId) {
  const line = pkg.excerpts.find((entry) => entry.viewer_id === viewerId);
  assert.ok(line, `no excerpt for ${viewerId}`);
  return line.seq;
}

test('memory packages contain the current memory, the new messages and a strict schema', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    assert.deepEqual(
      pkg.names.sort(),
      ['instructions.md', 'manifest.json', 'memory_context.json', 'result.schema.json', 'viewer_excerpts.jsonl'].sort()
    );
    assert.equal(pkg.manifest.protocol, MEMORY_PROTOCOL);
    assert.equal(pkg.manifest.stage, 'memory_batch');
    assert.equal(pkg.manifest.session_id, ctx.session.id);
    assert.equal(pkg.manifest.broadcaster_id, BROADCASTER);
    assert.equal(pkg.manifest.counts.viewers, 2);
    assert.equal(pkg.manifest.batch.total, 1);
    assert.equal(pkg.context.viewers.length, 2);
    assert.equal(pkg.excerpts.length, 20);
    // seq is contiguous inside the package and maps to a real viewer
    assert.deepEqual(pkg.excerpts.map((entry) => entry.seq), Array.from({length: 20}, (_, index) => index + 1));
    assert.ok(pkg.excerpts.every((entry) => entry.viewer_id && entry.content));
    const instructions = pkg.names.includes('instructions.md');
    assert.ok(instructions);
    // No money is exposed as a prompt input for memory, and no other broadcaster.
    assert.equal(JSON.stringify(pkg.context).includes('other broadcaster'), true);
    assert.equal(pkg.manifest.counts.viewers_with_memory, 0);
  } finally {
    ctx.cleanup();
  }
});

test('an imported add creates memory facts with verifiable message evidence', async () => {
  const ctx = await scenario({viewersPerBatch: 1});
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    const seq = firstSeqFor(pkg, viewerId);
    const text = JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: viewerId,
        summary: 'An interested viewer.',
        operations: [{
          op: 'add',
          kind: 'interest',
          topic: 'music games',
          statement: 'Plays rhythm games',
          certainty: 'stated',
          confidence: 0.8,
          evidence: [{batch: 1, seq}]
        }]
      }]
    }));

    const preview = validateMemoryImport({db: ctx.db, text, now: T0 + 2000});
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.action, 'apply');
    assert.equal(preview.totals.added, 1);
    assert.equal(preview.plan[0].operations[0].result, 'added');
    assert.equal(preview.evidenceTotal, 1);
    // Preview did not write anything.
    assert.equal(getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId}), null);

    const outcome = importMemoryUpdate({db: ctx.db, text, now: T0 + 3000});
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.versions.length, 1);

    const memory = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    assert.ok(memory);
    const facts = listFacts(ctx.db, memory.id);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].certainty, 'stated');
    assert.equal(facts[0].status, 'active');
    assert.equal(facts[0].evidenceStatus, 'available');
    assert.equal(facts[0].evidenceCount, 1);

    const view = buildViewerMemoryView(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    const evidence = view.facts[0].evidence[0];
    assert.ok(evidence.eventId);
    assert.equal(evidence.verified, true);
    assert.ok(evidence.snippet);

    const job = getMemoryJob(ctx.db, pkg.manifest.job_id);
    assert.equal(buildMemoryJobView(ctx.db, job).status.status, 'partial');
  } finally {
    ctx.cleanup();
  }
});

test('re-importing the identical answer is a duplicate and changes nothing', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    const text = JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: viewerId,
        operations: [{
          op: 'add',
          kind: 'topic',
          topic: 'testing',
          statement: 'Talks about testing',
          certainty: 'inferred',
          evidence: [firstSeqFor(pkg, viewerId)]
        }]
      }]
    }));
    const first = importMemoryUpdate({db: ctx.db, text, now: T0 + 2000});
    assert.equal(first.duplicate, false);
    const versionAfterFirst = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId}).version;

    const second = importMemoryUpdate({db: ctx.db, text, now: T0 + 3000});
    assert.equal(second.duplicate, true);
    assert.equal(getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId}).version, versionAfterFirst);
    assert.equal(listFacts(ctx.db, getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId}).id).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('a different answer for an applied batch needs an explicit new version', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    const base = {
      viewer_operations: [{
        viewer_id: viewerId,
        operations: [{
          op: 'add',
          kind: 'topic',
          topic: 'first topic',
          statement: 'first',
          certainty: 'inferred',
          evidence: [firstSeqFor(pkg, viewerId)]
        }]
      }]
    };
    importMemoryUpdate({db: ctx.db, text: JSON.stringify(resultFor(pkg.manifest, base)), now: T0 + 2000});

    const changed = {
      viewer_operations: [{
        viewer_id: viewerId,
        operations: [{
          op: 'add',
          kind: 'topic',
          topic: 'second topic',
          statement: 'second',
          certainty: 'inferred',
          evidence: [firstSeqFor(pkg, viewerId)]
        }]
      }]
    };
    const preview = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, changed)),
      now: T0 + 3000
    });
    assert.equal(preview.action, 'confirm_version');
    assert.equal(preview.target.requiresVersionConfirm, true);

    assert.throws(
      () => importMemoryUpdate({db: ctx.db, text: JSON.stringify(resultFor(pkg.manifest, changed)), now: T0 + 3000}),
      (error) => error.code === 'MEMORY_VERSION_REQUIRED'
    );
    const applied = importMemoryUpdate({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, changed)),
      createVersion: true,
      now: T0 + 4000
    });
    assert.equal(applied.duplicate, false);
    const memory = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    const topics = listFacts(ctx.db, memory.id).map((fact) => fact.topic).sort();
    assert.deepEqual(topics, ['first topic', 'second topic']);
  } finally {
    ctx.cleanup();
  }
});

test('batches can be imported out of order and the job reports partial progress', async () => {
  const ctx = await scenario({viewersPerBatch: 1});
  try {
    assert.equal(ctx.packages.length, 2);
    const [first, second] = ctx.packages;
    const resultForPackage = (pkg) => JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: pkg.context.viewers[0].viewer_id,
        operations: [{
          op: 'add',
          kind: 'topic',
          topic: `topic-${pkg.manifest.batch.index}`,
          statement: 'something',
          certainty: 'inferred',
          evidence: [firstSeqFor(pkg, pkg.context.viewers[0].viewer_id)]
        }]
      }]
    }));

    // Second batch first.
    importMemoryUpdate({db: ctx.db, text: resultForPackage(second), now: T0 + 2000});
    let job = getMemoryJob(ctx.db, second.manifest.job_id);
    let view = buildMemoryJobView(ctx.db, job);
    assert.equal(view.status.status, 'partial');
    assert.deepEqual(view.status.missingBatches, [1]);
    assert.equal(view.batches.find((batch) => batch.batchIndex === 1).applied, false);
    assert.equal(view.batches.find((batch) => batch.batchIndex === 2).applied, true);

    // Then the first one: same viewers must not be corrupted by the order.
    importMemoryUpdate({db: ctx.db, text: resultForPackage(first), now: T0 + 3000});
    job = getMemoryJob(ctx.db, first.manifest.job_id);
    view = buildMemoryJobView(ctx.db, job);
    assert.equal(view.status.status, 'complete');
    assert.deepEqual(view.status.missingBatches, []);
    assert.equal(listMemoryBatches(ctx.db, job.id).length, 2);

    const memory = getMemory(ctx.db, {
      broadcasterId: BROADCASTER,
      viewerId: first.context.viewers[0].viewer_id
    });
    assert.equal(listFacts(ctx.db, memory.id).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('a viewer id that was not in the package is rejected', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const text = JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: 'youtube:UC_INVENTED',
        operations: [{op: 'add', kind: 'topic', topic: 'x', statement: 'x', certainty: 'uncertain'}]
      }]
    }));
    const preview = validateMemoryImport({db: ctx.db, text, now: T0 + 2000});
    assert.equal(preview.ok, false);
    assert.ok(preview.errors.some((error) => error.code === 'MEMORY_VIEWER_UNKNOWN'));
    assert.throws(
      () => importMemoryUpdate({db: ctx.db, text, now: T0 + 2000}),
      (error) => error.code === 'MEMORY_IMPORT_INVALID'
    );
  } finally {
    ctx.cleanup();
  }
});

test('a stated fact without a quote is rejected, an unsupported inference is downgraded', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;

    const unsupported = JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: viewerId,
        operations: [{
          op: 'add',
          kind: 'identity',
          topic: 'job',
          statement: 'Works as a doctor',
          certainty: 'stated'
        }]
      }]
    }));
    const rejected = validateMemoryImport({db: ctx.db, text: unsupported, now: T0 + 2000});
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) => error.code === 'MEMORY_EVIDENCE_REQUIRED'));

    const inferred = JSON.stringify(resultFor(pkg.manifest, {
      viewer_operations: [{
        viewer_id: viewerId,
        operations: [{
          op: 'add',
          kind: 'interest',
          topic: 'puzzle games',
          statement: 'Probably likes puzzle games',
          certainty: 'inferred'
        }]
      }]
    }));
    const preview = validateMemoryImport({db: ctx.db, text: inferred, now: T0 + 2000});
    assert.equal(preview.ok, true);
    assert.ok(preview.warnings.some((warning) => warning.code === 'MEMORY_CERTAINTY_DOWNGRADED'));

    importMemoryUpdate({db: ctx.db, text: inferred, now: T0 + 2500});
    const memory = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    const fact = listFacts(ctx.db, memory.id)[0];
    assert.equal(fact.certainty, 'uncertain');
    assert.equal(fact.status, 'needs_confirmation');
  } finally {
    ctx.cleanup();
  }
});

test('invalid JSON, an old schema version and a foreign protocol are rejected', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const broken = validateMemoryImport({db: ctx.db, text: '{"protocol":', now: T0 + 2000});
    assert.equal(broken.ok, false);
    assert.ok(broken.errors.some((error) => error.code === 'INVALID_JSON'));

    const oldVersion = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify({...resultFor(pkg.manifest), schema_version: '0.1.0'}),
      now: T0 + 2000
    });
    assert.equal(oldVersion.ok, false);
    assert.ok(oldVersion.errors.some((error) => error.code === 'SCHEMA_VERSION_UNSUPPORTED'));

    const wrongProtocol = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify({...resultFor(pkg.manifest), protocol: 'livememory-analysis-result-v1'}),
      now: T0 + 2000
    });
    assert.equal(wrongProtocol.ok, false);
    assert.ok(wrongProtocol.errors.some((error) => error.code === 'PROTOCOL_MISMATCH'));
  } finally {
    ctx.cleanup();
  }
});

test('evidence seqs outside the package and foreign fact ids are rejected', async () => {
  const ctx = await scenario({viewersPerBatch: 1});
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    const bogusSeq = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'add',
            kind: 'topic',
            topic: 'x',
            statement: 'x',
            certainty: 'inferred',
            evidence: [{batch: 1, seq: 99999}]
          }]
        }]
      })),
      now: T0 + 2000
    });
    assert.equal(bogusSeq.ok, false);
    assert.ok(bogusSeq.errors.some((error) => error.code === 'MEMORY_REF_UNKNOWN'));

    const otherBatch = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'add',
            kind: 'topic',
            topic: 'x',
            statement: 'x',
            certainty: 'inferred',
            evidence: [{batch: 2, seq: 1}]
          }]
        }]
      })),
      now: T0 + 2000
    });
    assert.equal(otherBatch.ok, false);
    assert.ok(otherBatch.errors.some((error) => error.code === 'MEMORY_REF_OTHER_BATCH'));

    const foreignFact = validateMemoryImport({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{op: 'confirm', target_fact_id: 'mfc_invented'}]
        }]
      })),
      now: T0 + 2000
    });
    assert.equal(foreignFact.ok, false);
    assert.ok(foreignFact.errors.some((error) => error.code === 'MEMORY_FACT_UNKNOWN'));
  } finally {
    ctx.cleanup();
  }
});

test('a later session can supersede a fact created by an earlier session', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-chain-'));
  try {
    addBroadcaster(db);
    const first = seedSession(db, {messageCount: 10, viewerCount: 1});
    let created = await createMemoryUpdateJob({
      db, sessionId: first.id, locale: 'en', exportsDir, now: T0 + 1000
    });
    let pkg = await inspectMemoryPackage(join(exportsDir, created.batches[0].fileName));
    const viewerId = pkg.context.viewers[0].viewer_id;
    importMemoryUpdate({
      db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'add',
            kind: 'life_event',
            topic: '考试',
            statement: '正在准备考试',
            certainty: 'stated',
            evidence: [firstSeqFor(pkg, viewerId)]
          }]
        }]
      })),
      now: T0 + 2000
    });
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId});
    const originalFactId = listFacts(db, memory.id)[0].id;

    const second = seedSession(db, {
      messageCount: 10,
      viewerCount: 1,
      roomId: 'second-room',
      title: 'second stream',
      startedAt: T0 + T_DAY
    });
    created = await createMemoryUpdateJob({
      db, sessionId: second.id, locale: 'en', exportsDir, now: T0 + T_DAY + 1000
    });
    pkg = await inspectMemoryPackage(join(exportsDir, created.batches[0].fileName));
    // The package must contain the existing fact so the AI can target it.
    const contextViewer = pkg.context.viewers.find((entry) => entry.viewer_id === viewerId);
    assert.equal(contextViewer.memory.version, 1);
    assert.equal(contextViewer.memory.facts[0].id, originalFactId);

    const preview = validateMemoryImport({
      db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'supersede',
            target_fact_id: originalFactId,
            kind: 'life_event',
            topic: '考试',
            statement: '考试已经结束',
            certainty: 'stated',
            evidence: [firstSeqFor(pkg, viewerId)]
          }]
        }]
      })),
      now: T0 + T_DAY + 2000
    });
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.totals.added, 1);
    assert.equal(preview.totals.changed, 1);

    importMemoryUpdate({
      db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'supersede',
            target_fact_id: originalFactId,
            kind: 'life_event',
            topic: '考试',
            statement: '考试已经结束',
            certainty: 'stated',
            evidence: [firstSeqFor(pkg, viewerId)]
          }]
        }]
      })),
      now: T0 + T_DAY + 3000
    });

    const facts = listFacts(db, memory.id);
    assert.equal(facts.length, 2);
    const oldFact = facts.find((fact) => fact.id === originalFactId);
    assert.equal(oldFact.status, 'superseded');
    assert.equal(oldFact.supersededBy, facts.find((fact) => fact.id !== originalFactId).id);
    const newFact = facts.find((fact) => fact.id !== originalFactId);
    assert.equal(newFact.status, 'active');
    assert.equal(newFact.statement, '考试已经结束');

    const view = buildViewerMemoryView(db, {broadcasterId: BROADCASTER, viewerId});
    assert.equal(view.memory.version, 2);
    assert.equal(view.groups.history.length, 1);
    assert.equal(view.groups.confirmed.length, 1);
    assert.equal(view.versions.length, 2);
    assert.equal(view.versions[0].counts.added, 1);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('a conflict is preserved for the streamer instead of being resolved by the AI', async () => {
  const ctx = await scenario({viewersPerBatch: 1});
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    const seq = firstSeqFor(pkg, viewerId);
    importMemoryUpdate({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'Valorant',
            statement: '喜欢 Valorant',
            certainty: 'stated',
            evidence: [seq]
          }]
        }]
      })),
      now: T0 + 2000
    });
    const memory = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    const factId = listFacts(ctx.db, memory.id)[0].id;

    importMemoryUpdate({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [{
            op: 'conflict',
            target_fact_id: factId,
            kind: 'dislike',
            topic: 'Valorant',
            statement: '说最讨厌 Valorant',
            certainty: 'stated',
            evidence: [seq]
          }]
        }]
      })),
      createVersion: true,
      now: T0 + 3000
    });

    const facts = listFacts(ctx.db, memory.id);
    assert.equal(facts.length, 2);
    assert.equal(facts.every((fact) => fact.status === 'conflicted'), true);
    assert.equal(facts[0].conflictsWith, facts[1].id);
    assert.equal(facts[1].conflictsWith, facts[0].id);
    const view = buildViewerMemoryView(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    assert.equal(view.groups.conflicts.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test('multi-language memory statements are stored verbatim', async () => {
  const ctx = await scenario();
  try {
    const pkg = ctx.packages[0];
    const viewerId = pkg.context.viewers[0].viewer_id;
    importMemoryUpdate({
      db: ctx.db,
      text: JSON.stringify(resultFor(pkg.manifest, {
        viewer_operations: [{
          viewer_id: viewerId,
          operations: [
            {
              op: 'add',
              kind: 'topic',
              topic: '日本語の話題',
              statement: 'ゲームの話をよくする',
              certainty: 'inferred',
              evidence: [firstSeqFor(pkg, viewerId)]
            },
            {
              op: 'add',
              kind: 'interest',
              topic: '英文话题',
              statement: 'Talked about English songs',
              certainty: 'inferred',
              evidence: [firstSeqFor(pkg, viewerId)]
            }
          ]
        }]
      })),
      now: T0 + 2000
    });
    const memory = getMemory(ctx.db, {broadcasterId: BROADCASTER, viewerId});
    const statements = listFacts(ctx.db, memory.id).map((fact) => fact.statement).sort();
    assert.deepEqual(statements, ['Talked about English songs', 'ゲームの話をよくする']);
  } finally {
    ctx.cleanup();
  }
});
