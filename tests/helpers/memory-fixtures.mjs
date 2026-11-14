import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {readBatchPackage, makeBatchResult} from './ai-fixtures.mjs';

/**
 * Helpers that turn a recorded session into an *imported* M6 analysis, which is
 * the only input the deterministic memory merge (no-AI path) uses.
 */
export async function importSessionAnalysis({
  db,
  sessionId,
  exportsDir,
  locale = 'en',
  profiles = null,
  confidence = 0.6
}) {
  const job = await createAnalysisJob({db, sessionId, locale, exportsDir, batchSize: 100000});
  const packages = [];
  for (const pkg of job.packages) {
    const data = readBatchPackage(exportsDir, pkg);
    const viewerProfiles = (profiles ?? data.viewers.map((viewer) => ({
      viewer_id: viewer.viewer_id,
      interests: [{topic: 'testing', strength: 'stable', evidence: 'observed', note: 'Talks about testing a lot.'}],
      dislikes: [],
      summary: 'A steady test viewer.',
      confidence
    }))).filter((profile) => data.viewers.some((viewer) => viewer.viewer_id === profile.viewer_id));
    const result = makeBatchResult(data.manifest, data.messages, data.viewers, {
      viewer_profiles: viewerProfiles
    });
    const imported = importAnalysisResult({db, text: JSON.stringify(result)});
    packages.push({
      manifest: data.manifest,
      messages: data.messages,
      viewers: data.viewers,
      result,
      imported
    });
  }
  return {job, packages};
}

export const T_DAY = 24 * 3600 * 1000;
