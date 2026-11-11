import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {openMemoryDb, addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {createViewerMemoryJob} from '../../src/ai/export/split-jobs.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {computeJobStatus} from '../../src/ai/tasks/status.mjs';

test('52 viewers / 99 messages split into stable memory batches and survive partial import', async () => {
  const db = openMemoryDb();
  const temp = createTempDir();
  try {
    addBroadcaster(db);
    const session = seedSession(db, {
      id: 'ses_v13_52',
      messageCount: 99,
      viewerCount: 52,
      startedAt: T0
    });
    const exportsDir = join(temp.dir, 'exports');
    const built = await createViewerMemoryJob({
      db,
      sessionId: session.id,
      locale: 'en',
      exportsDir,
      viewersPerBatch: 10,
      excerptCap: 600,
      maxBatches: 30
    });
    assert.equal(built.job.batchTotal, 6);
    assert.equal(built.packages.length, 6);
    const seenViewers = new Set();
    for (const pkg of built.packages) {
      const buffer = readFileSync(join(exportsDir, pkg.fileName));
      const memory = JSON.parse(readZipEntry(buffer, 'memory_context.json').toString('utf8'));
      for (const viewer of memory.viewers) {
        assert.equal(seenViewers.has(viewer.viewer_id), false);
        seenViewers.add(viewer.viewer_id);
      }
      const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
      const result = {
        protocol: 'livememory-analysis-result-v1',
        schema_version: '1.3.0',
        analysis_scope: 'viewer_memory',
        job_id: manifest.job_id,
        batch_id: manifest.batch.batch_id,
        task_id: manifest.tasks[0].task_id,
        session_id: session.id,
        locale: 'en',
        viewer_memory_updates: memory.viewers.map((viewer) => ({
          viewer_id: viewer.viewer_id,
          no_new_information: true,
          operations: []
        }))
      };
      importAnalysisResult({db, text: JSON.stringify(result), source: 'api', now: T0 + 40000 + pkg.batchIndex});
      const status = computeJobStatus(db, getJob(db, built.job.id));
      if (pkg.batchIndex < 6) {
        assert.equal(status.status, 'partial');
        assert.equal(status.batchesImported, pkg.batchIndex);
      } else {
        assert.equal(status.complete, true);
        assert.equal(status.batchesImported, 6);
        assert.equal(status.memoryCoverage.covered, 52);
      }
    }
    assert.equal(seenViewers.size, 52);
  } finally {
    temp.cleanup();
    db.close();
  }
});
