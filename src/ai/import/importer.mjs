import {createId} from '../../shared/ids.mjs';
import {AppError} from '../../shared/errors.mjs';
import {withTransaction} from '../../storage/database/connection.mjs';
import {
  clearJobFailure,
  getJob,
  insertJob,
  insertJobBatch,
  insertJobMemoryViewers,
  insertJobMessages,
  insertJobViewers,
  setJobMemoryViewerStatus,
  listJobMemoryViewers,
  recordJobFailure
} from '../../storage/repositories/ai-jobs.mjs';
import {
  findResultByChecksum,
  getResult,
  insertEvidence,
  insertResult,
  latestResultForScope
} from '../../storage/repositories/ai-results.mjs';
import {setSessionAiStatus} from '../../storage/repositories/sessions.mjs';
import {listJobs} from '../../storage/repositories/ai-jobs.mjs';
import {promptVersionFor} from '../constants.mjs';
import {computeJobStatus, recomputeSessionAiStatus} from '../tasks/status.mjs';
import {checksumOf, validateAnalysisImport} from './validate.mjs';
import {ensureObjectiveMemory} from '../../memory/objective.mjs';
import {applyMemoryOperations} from '../../memory/store.mjs';
import {applyEmbeddedMemoryUpdates} from '../../memory/embedded.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';

/**
 * Persist one validated AI result.
 *
 * Rules:
 * - validation runs again here; a preview can never authorise a write;
 * - a legacy (pre-M6) answer gets a real job/batch/message map so evidence and
 *   duplicate detection work exactly like a new batch;
 * - identical content is returned as a duplicate and writes nothing;
 * - a different version needs `createVersion: true`, and always appends a new
 *   version while keeping every earlier result;
 * - everything is one SQLite transaction: a failure leaves no partial result.
 */
export function importAnalysisResult({
  db,
  text,
  source = 'paste',
  createVersion = false,
  viewerIds = null,
  viewerFailures = [],
  now = Date.now()
}) {
  const validation = validateAnalysisImport({db, text, source, now, viewerIds});
  if (!validation.ok) {
    if (validation.job?.id) {
      recordJobFailure(db, validation.job.id, {
        code: validation.errors[0]?.code ?? 'IMPORT_INVALID',
        errors: validation.errors,
        batchIndex: validation.batchIndex ?? null,
        batchId: validation.batch?.batchId ?? null,
        stage: 'import',
        now
      });
    }
    throw new AppError('AI_IMPORT_INVALID', {
      messageKey: 'errors.aiImportInvalid',
      details: {
        errors: validation.errors,
        warnings: validation.warnings,
        target: validation.target
      },
      httpStatus: 422
    });
  }
  if (validation.action === 'duplicate') {
    // The scope already has this exact validated result; any stored failure for
    // the same batch is stale and must not keep the job looking broken.
    if (validation.job?.id) {
      clearJobFailure(db, validation.job.id, {now, batchIndex: validation.batchIndex ?? null});
    }
    const duplicate = getResult(db, validation.target.duplicate.id, {includeJson: true});
    return {
      duplicate: true,
      result: duplicate,
      preview: validation,
      job: validation.job ? getJob(db, validation.job.id) : null,
      status: validation.job ? computeJobStatus(db, validation.job) : null
    };
  }
  if (validation.action === 'confirm_version' && createVersion !== true) {
    throw new AppError('AI_VERSION_REQUIRED', {
      messageKey: 'errors.aiVersionRequired',
      details: {
        existingVersion: validation.target.duplicate?.resultVersion ?? null,
        target: validation.target
      },
      httpStatus: 409
    });
  }

  let job = validation.job;
  const outcome = withTransaction(db, () => {
    if (!job) {
      const created = createLegacyJob(db, validation, {now});
      job = created.job;
    }
    // Re-check inside the transaction: two imports of the same answer must not
    // race into two versions.
    const existing = findResultByChecksum(db, job.id, validation.scopeKey, validation.checksum);
    if (existing) {
      return {duplicate: true, result: getResult(db, existing.id, {includeJson: true})};
    }
    const latest = latestResultForScope(db, job.id, validation.scopeKey);
    if (latest && createVersion !== true) {
      throw new AppError('AI_VERSION_REQUIRED', {
        messageKey: 'errors.aiVersionRequired',
        details: {existingVersion: latest.resultVersion, target: validation.target},
        httpStatus: 409
      });
    }
    const resultVersion = (latest?.resultVersion ?? 0) + 1;
    const resultId = createId('air');
    const missingEvidence = validation.evidenceRows.filter((row) => !row.available).length;
    insertResult(db, {
      id: resultId,
      jobId: job.id,
      sessionId: job.sessionId,
      scopeKey: validation.scopeKey,
      batchIndex: validation.batchIndex,
      taskId: validation.target.taskId,
      taskKind: validation.taskKind,
      protocolVersion: validation.sanitized.protocol,
      schemaVersion: validation.sanitized.schema_version,
      locale: validation.sanitized.locale,
      checksum: validation.checksum,
      resultVersion,
      source,
      resultJson: JSON.stringify(validation.sanitized),
      analysisMode: job.analysisMode ?? 'combined',
      evidenceTotal: validation.evidenceRows.length,
      evidenceMissing: missingEvidence,
      importedAt: now
    });
    insertEvidence(db, resultId, validation.evidenceRows);
    if ((job.analysisMode ?? 'combined') !== 'session') {
      applyMemorySideEffects({
        db,
        job,
        validation,
        resultId,
        now
      });
    }
    // Viewers rejected by the same batch are marked inside the same
    // transaction as the valid viewers' facts. A crash can therefore never
    // leave facts saved without an accurate coverage status.
    for (const failure of Array.isArray(viewerFailures) ? viewerFailures : []) {
      if (!failure?.viewerId) continue;
      setJobMemoryViewerStatus(db, job.id, failure.viewerId, {
        status: 'failed',
        resultId: null,
        processedAt: now
      });
    }
    // Only this batch's failure is resolved. A concurrent sibling success must
    // not erase the real reason another batch failed.
    clearJobFailure(db, job.id, {now, batchIndex: validation.batchIndex ?? null});
    recomputeSessionAiStatus(db, job.sessionId, {setSessionAiStatus, listJobs, now});
    return {duplicate: false, result: getResult(db, resultId, {includeJson: true})};
  });

  return {
    duplicate: outcome.duplicate,
    result: outcome.result,
    preview: validation,
    job: getJob(db, job.id),
    status: computeJobStatus(db, getJob(db, job.id))
  };
}

/**
 * Apply the long-term-memory half of an analysis import.
 *
 * Objective interaction history is deterministic and is ensured for every
 * session viewer, even when a legacy result carries no semantic memory update.
 * Semantic operations are only applied for viewers assigned to this batch.
 * The caller already owns the transaction: any throw rolls back both the report
 * and every memory change.
 */
function applyMemorySideEffects({db, job, validation, resultId, now}) {
  const session = validation.session;
  const broadcasterId = job.broadcasterId ?? session?.broadcaster_id ?? null;
  if (!session || !broadcasterId) return;
  if (validation.memory) {
    const outcomes = applyEmbeddedMemoryUpdates({
      db,
      job,
      session,
      validation: validation.memory,
      resultId,
      now,
      ensureObjective: ({viewerId, sessionId, jobId}) => ensureObjectiveMemory({
        db,
        broadcasterId,
        viewerId,
        sessionId,
        jobId,
        now
      }),
      applyOperations: ({viewerId, operations, summary, summaryCertainty, source, sourceKey}) => applyMemoryOperations({
        db,
        broadcasterId,
        viewerId,
        operations,
        summary,
        summaryCertainty,
        source,
        sourceKey,
        now,
        transaction: false
      })
    });
    for (const outcome of outcomes) {
      setJobMemoryViewerStatus(db, job.id, outcome.viewerId, {
        status: outcome.status,
        resultId,
        processedAt: now
      });
    }
  }

  // Objective history exists independently of AI. It covers gift-only viewers
  // and viewers whose messages were in another batch; it never touches the
  // semantic version.
  //
  // For a memory job, every session viewer is assigned to exactly one batch.
  // Re-scanning the whole session for every imported batch would be O(batches ×
  // viewers) and blocked the event loop on large paid jobs. Only this batch's
  // assigned viewers need the objective update.
  const assignedViewers = Array.isArray(validation.memory?.memoryViewers)
    ? validation.memory.memoryViewers
    : [];
  const objectiveViewers = assignedViewers.length > 0
    ? assignedViewers.map((entry) => entry.viewerId).filter(Boolean)
    : listSessionViewers(db, session.id, {limit: 20000}).map((viewer) => viewer.viewer_id);
  for (const viewerId of objectiveViewers) {
    if (!viewerId) continue;
    ensureObjectiveMemory({
      db,
      broadcasterId,
      viewerId,
      sessionId: session.id,
      jobId: job.id,
      now
    });
  }
}

/**
 * Materialise a pre-M6 result: create the job, its single batch, the seq → event
 * mapping and the viewer set, all derived from the live database. The mapping is
 * what lets the report prove whether a cited message still exists.
 */
function createLegacyJob(db, validation, {now}) {
  const info = validation.legacyCreate;
  if (!info?.batch) {
    throw new AppError('AI_IMPORT_INVALID', {
      messageKey: 'errors.aiImportInvalid',
      details: {errors: validation.errors},
      httpStatus: 422
    });
  }
  const batch = info.batch;
  const job = insertJob(db, {
    id: createId('aij'),
    sessionId: info.sessionId,
    broadcasterId: validation.target.session?.broadcasterId ?? null,
    locale: validation.sanitized.locale,
    promptVersion: promptVersionFor(validation.sanitized.locale),
    protocolVersion: validation.sanitized.protocol,
    batchTotal: 1,
    maxMessages: batch.messageCount,
    totalMessages: batch.messageCount,
    legacy: true,
    createdAt: now
  });
  const batchId = `${job.id}-b01`;
  insertJobBatch(db, {
    jobId: job.id,
    batchIndex: 1,
    batchId,
    taskId: batch.taskId,
    fromSeq: batch.fromSeq,
    toSeq: batch.toSeq,
    fromAt: batch.fromAt,
    toAt: batch.toAt,
    messageCount: batch.messageCount,
    checksum: checksumOf(batch.eventIds),
    packageId: null,
    createdAt: now
  });
  insertJobMessages(db, job.id, 1, (batch.eventIds ?? []).map((eventId, index) => ({
    seq: index + 1,
    eventId
  })));
  insertJobViewers(db, job.id, 1, batch.viewers ?? []);
  return {job: getJob(db, job.id), batchId};
}

export const __internal = {createLegacyJob};
