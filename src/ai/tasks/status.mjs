import {getJobBatch, jobMemoryCoverage, listJobBatches} from '../../storage/repositories/ai-jobs.mjs';
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
  const analysisMode = job.analysisMode ?? 'combined';
  // A multi-batch session report needs the stage-2 aggregate answer just like a
  // legacy combined job. Memory-only jobs never need an aggregate.
  const aggregateRequired = analysisMode !== 'memory' && job.batchTotal > 1;
  const aggregateImported = Boolean(finalResult);
  const aggregatePackageReady = Boolean(job.aggregatePackageId);
  const memoryCoverage = jobMemoryCoverage(db, job.id);
  const memoryReady = analysisMode === 'session' || memoryCoverage.total === 0 || memoryCoverage.complete;

  let status;
  if (analysisMode === 'session') {
    if (aggregateRequired) {
      if (finalResult) {
        status = 'complete';
      } else if (missingBatches.length === 0 && batches.length > 0) {
        status = 'awaiting_aggregate';
      } else if (importedBatches > 0) {
        status = 'partial';
      } else if (job.lastErrorAt) {
        status = 'invalid';
      } else {
        status = 'awaiting_import';
      }
    } else if (job.batchTotal > 0 && importedBatches === batches.length && batches.length > 0 && memoryReady) {
      status = 'complete';
    } else if (importedBatches > 0) {
      status = 'partial';
    } else if (job.lastErrorAt) {
      status = 'invalid';
    } else {
      status = 'awaiting_import';
    }
  } else if (analysisMode === 'memory') {
    // Session and memory are independent tasks in v0.13. A memory job never
    // needs an aggregate report.
    if (job.batchTotal > 0 && importedBatches === batches.length && batches.length > 0 && memoryReady) {
      status = 'complete';
    } else if (importedBatches > 0) {
      status = 'partial';
    } else if (job.lastErrorAt) {
      status = 'invalid';
    } else {
      status = 'awaiting_import';
    }
  } else if (finalResult && memoryReady) {
    status = 'complete';
  } else if (job.batchTotal === 1 && importedBatches === 1 && memoryReady) {
    status = 'complete';
  } else if (job.batchTotal === 1) {
    status = job.lastErrorAt ? 'invalid' : 'awaiting_import';
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
  // Per-batch failures survive concurrent sibling successes and restarts. They
  // are exposed so the console can say exactly which batch failed and why.
  const batchErrors = Array.isArray(latestError?.batches)
    ? latestError.batches.filter((entry) => entry && typeof entry === 'object')
    : [];
  const failedBatches = [...new Set(batchErrors
    .map((entry) => (Number.isInteger(Number(entry.batchIndex)) ? Number(entry.batchIndex) : null))
    .filter((index) => index !== null))].sort((a, b) => a - b);

  return {
    status,
    labelKey: `ai.job.status.${status}`,
    complete: status === 'complete',
    analysisMode,
    batchTotal: job.batchTotal,
    batchesImported: importedBatches,
    missingBatches,
    aggregateRequired,
    aggregateImported,
    aggregatePackageReady,
    totalMessages: job.totalMessages,
    maxMessages: job.maxMessages,
    memoryViewersTotal: job.memoryViewersTotal,
    memoryCoverage,
    memoryReady,
    resultCount: results.length,
    // The job's own usage row. Session and memory are separate jobs, so each
    // value contains only the requests made for that job.
    usage: job.usage ?? null,
    versions,
    finalResult: finalResult
      ? {id: finalResult.id, resultVersion: finalResult.resultVersion, importedAt: finalResult.importedAt}
      : null,
    latestError,
    batchErrors,
    failedBatches
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
