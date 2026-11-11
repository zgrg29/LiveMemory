import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {openMemoryDb, addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {createViewerMemoryJob} from '../../src/ai/export/split-jobs.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {computeJobStatus} from '../../src/ai/tasks/status.mjs';
import {latestResultForScope} from '../../src/storage/repositories/ai-results.mjs';
import {buildSessionAnalysisReport} from '../../src/analytics/ai/report.mjs';

test('memory-only job updates viewer memory and never overwrites a session report', async () => {
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {id: 'ses_v13_memory', messageCount: 6, viewerCount: 2, startedAt: T0});
  const temp = createTempDir();
  try {
    const exportsDir = join(temp.dir, 'exports');
    const built = await createViewerMemoryJob({
      db,
      sessionId: session.id,
      locale: 'en',
      exportsDir,
      viewersPerBatch: 10,
      maxBatches: 5
    });
    assert.equal(built.job.analysisMode, 'memory');
    assert.equal(built.job.batchTotal, 1);
    const pkg = built.packages[0];
    const buffer = readFileSync(join(exportsDir, pkg.fileName));
    const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
    const memory = JSON.parse(readZipEntry(buffer, 'memory_context.json').toString('utf8'));
    assert.equal(manifest.analysis_scope, 'viewer_memory');
    assert.equal(memory.viewers.length, 2);

    const withEvidence = memory.viewers.find((viewer) => viewer.evidence_seqs.length > 0);
    const updates = memory.viewers.map((viewer) => {
      if (viewer.viewer_id === withEvidence.viewer_id) {
        return {
          viewer_id: viewer.viewer_id,
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'testing',
            statement: 'Enjoys testing memory jobs',
            certainty: 'stated',
            confidence: 0.9,
            evidence: [viewer.evidence_seqs[0]]
          }]
        };
      }
      return {viewer_id: viewer.viewer_id, no_new_information: true, operations: []};
    });
    const result = {
      protocol: 'livememory-analysis-result-v1',
      schema_version: '1.3.0',
      analysis_scope: 'viewer_memory',
      job_id: manifest.job_id,
      batch_id: manifest.batch.batch_id,
      task_id: manifest.tasks[0].task_id,
      session_id: session.id,
      locale: 'en',
      viewer_memory_updates: updates
    };
    const preview = validateAnalysisImport({db, text: JSON.stringify(result), source: 'api', now: T0 + 20000});
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    assert.equal(preview.target.analysisMode, 'memory');
    assert.equal(preview.memory.coverage.total, 2);

    const imported = importAnalysisResult({db, text: JSON.stringify(result), source: 'api', now: T0 + 20000});
    assert.equal(imported.duplicate, false);
    const job = getJob(db, built.job.id);
    const status = computeJobStatus(db, job);
    assert.equal(status.complete, true);
    assert.equal(status.analysisMode, 'memory');
    assert.equal(status.memoryCoverage.covered, 2);
    assert.ok(latestResultForScope(db, job.id, 'batch:1'));

    const report = buildSessionAnalysisReport(db, session.id);
    assert.equal(report.mode, 'none');
    assert.equal(report.incompleteReason, 'memory_only');
    // The memory-only result must not be exposed as a session report.
    assert.equal(report.report, null);
  } finally {
    temp.cleanup();
    db.close();
  }
});
