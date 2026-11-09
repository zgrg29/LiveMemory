import {getJobBatch, listJobBatches} from '../../storage/repositories/ai-jobs.mjs';
import {listResults} from '../../storage/repositories/ai-results.mjs';

/**
 * Task state is always computed from the database, never from a front-end flag.
 *
 * A task can therefore be resumed after a restart, and a "complete" label is
 * only possible when every required batch (and, for multi-batch jobs, the
 * stage-2 aggregate result) really exists.
 */
export function computeJobStatus(db, job) {
  if (!job) return null;
  const batches = listJobBatches(db, job.id);
  const results = listResults(db, job.id);
  const latestByScope = new Map();
  for (const result of results) {
    const current = latestByScope.get(result.scopeKey);
    if (!current || current.resultVersion < result.resultVersion) latestByScope.set(result.scopeKey, result);
  }
  const latestByBatch = new Map();
  for (const result of latestByScope.values()) {
    if (result.batchIndex !== null) latestByBatch.set(result.batchIndex, result);
  }
  const finalResult = latestByScope.get('final') ?? null;
  const missingBatches = batches
    .filter((batch) => !latestByBatch.has(batch.batchIndex))
    .map((batch) => batch.batchIndex);
  const importedBatches = batches.length - missingBatches.length;
  const aggregateRequired = job.batchTotal > 1;
  const aggregateImported = Boolean(finalResult);
  const aggregatePackageReady = Boolean(job.aggregatePackageId);

  let status;
  if (finalResult) {
    status = 'complete';
  } else if (job.batchTotal === 1) {
    status = importedBatches === 1 ? 'complete' : (job.lastErrorAt ? 'invalid' : 'awaiting_import');
  } else if (missingBatches.length === 0) {
    status = 'awaiting_aggregate';
  } else if (importedBatches > 0) {
    status = 'partial';
  } else if (job.lastErrorAt) {
    status = 'invalid';
  } else {
    status = 'awaiting_import';
  }

  const versions = {};
  for (const result of results) {
    const list = versions[result.scopeKey] ?? [];
    list.push(result.resultVersion);
    versions[result.scopeKey] = list;
  }
  let latestError = null;
  if (job.lastErrorJson) {
    try {
      latestError = JSON.parse(job.lastErrorJson);
    } catch {
      latestError = null;
    }
  }

  return {
    status,
    labelKey: `ai.job.status.${status}`,
    complete: status === 'complete',
    batchTotal: job.batchTotal,
    batchesImported: importedBatches,
    missingBatches,
    aggregateRequired,
    aggregateImported,
    aggregatePackageReady,
    totalMessages: job.totalMessages,
    maxMessages: job.maxMessages,
    resultCount: results.length,
    versions,
    finalResult: finalResult
      ? {id: finalResult.id, resultVersion: finalResult.resultVersion, importedAt: finalResult.importedAt}
      : null,
    latestError
  };
}

/** Recompute and persist `sessions.ai_status` from real job/result rows. */
export function recomputeSessionAiStatus(db, sessionId, {setSessionAiStatus, listJobs, now = Date.now()}) {
  const jobs = listJobs(db, {sessionId, limit: 200});
  let status = 'none';
  if (jobs.some((job) => computeJobStatus(db, job).complete)) {
    status = 'imported';
  } else if (jobs.some((job) => listResults(db, job.id).length > 0)) {
    status = 'partial';
  } else if (jobs.length > 0) {
    status = 'exported';
  }
  setSessionAiStatus(db, sessionId, status, {now});
  return status;
}

/** Batch row helper used by routes and tests. */
export function getBatch(db, jobId, batchIndex) {
  return getJobBatch(db, jobId, batchIndex);
}
