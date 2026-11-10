import {createId} from '../shared/ids.mjs';
import {AppError} from '../shared/errors.mjs';
import {withTransaction} from '../storage/database/connection.mjs';
import {
  clearMemoryJobFailure,
  findMemoryResultByChecksum,
  getMemoryJob,
  getMemoryResult,
  insertMemoryResult,
  recordMemoryJobFailure
} from '../storage/repositories/viewer-memory.mjs';
import {applyMemoryOperations} from './store.mjs';
import {validateMemoryImport} from './validate.mjs';
import {MEMORY_SOURCE_KIND} from './constants.mjs';

/**
 * Persist one validated memory update answer.
 *
 * Rules:
 * - validation runs again here; a preview is never an authorisation;
 * - identical content (same job + batch + checksum) is a duplicate and writes
 *   nothing, so re-importing the same file can never double-apply;
 * - a *different* answer for a batch that was already applied requires an
 *   explicit `createVersion`, and even then facts are merged by key, so no
 *   duplicate memory can accumulate;
 * - result row + every affected memory version are written in one transaction;
 *   a failure leaves the database untouched.
 */
export function importMemoryUpdate({db, text, source = 'paste', createVersion = false, now = Date.now()}) {
  const validation = validateMemoryImport({db, text, source, now});
  if (!validation.ok) {
    if (validation.target?.job?.id) {
      recordMemoryJobFailure(db, validation.target.job.id, {
        code: validation.errors[0]?.code ?? 'MEMORY_IMPORT_INVALID',
        errors: validation.errors,
        now
      });
    }
    throw new AppError('MEMORY_IMPORT_INVALID', {
      messageKey: 'errors.memoryImportInvalid',
      details: {
        errors: validation.errors,
        warnings: validation.warnings,
        target: validation.target,
        plan: validation.plan,
        totals: validation.totals
      },
      httpStatus: 422
    });
  }
  if (validation.action === 'duplicate') {
    return {
      duplicate: true,
      applied: false,
      result: validation.target.duplicate ? getMemoryResult(db, validation.target.duplicate.id) : null,
      preview: validation,
      job: getMemoryJob(db, validation.target.job.id)
    };
  }
  if (validation.action === 'confirm_version' && createVersion !== true) {
    throw new AppError('MEMORY_VERSION_REQUIRED', {
      messageKey: 'errors.memoryVersionRequired',
      details: {
        existing: validation.target.latestVersion,
        batch: validation.target.batch
      },
      httpStatus: 409
    });
  }

  const jobId = validation.target.job.id;
  const batch = validation.batch;
  const outcome = withTransaction(db, () => {
    // Re-check inside the transaction so two imports cannot race.
    const existing = findMemoryResultByChecksum(db, jobId, batch.batchId, validation.checksum);
    if (existing) {
      return {duplicate: true, result: getMemoryResult(db, existing.id), versions: []};
    }
    const resultId = createId('mres');
    insertMemoryResult(db, {
      id: resultId,
      jobId,
      sessionId: validation.session.id,
      batchIndex: batch.batchIndex,
      batchId: batch.batchId,
      checksum: validation.checksum,
      protocolVersion: validation.sanitized.protocol,
      schemaVersion: validation.sanitized.schema_version,
      locale: validation.sanitized.locale,
      source,
      resultJson: JSON.stringify(validation.sanitized),
      viewerTotal: validation.totals.viewers,
      opTotal: validation.totals.operations,
      evidenceTotal: validation.evidenceTotal,
      evidenceMissing: validation.evidenceMissing,
      appliedAt: now
    });
    const versions = [];
    for (const entry of validation.operations) {
      if (entry.operations.length === 0) continue;
      const applied = applyMemoryOperations({
        db,
        broadcasterId: validation.target.broadcasterId,
        viewerId: entry.viewerId,
        operations: entry.operations,
        source: {
          kind: MEMORY_SOURCE_KIND.AI_UPDATE,
          jobId,
          sessionId: validation.session.id,
          resultId,
          label: 'ai_memory_update'
        },
        sourceKey: `result:${resultId}`,
        summary: entry.summary,
        summaryCertainty: entry.summary ? 'inferred' : null,
        now,
        transaction: false
      });
      versions.push({
        viewerId: entry.viewerId,
        memoryId: applied.memoryId,
        version: applied.version,
        duplicate: Boolean(applied.duplicate),
        counts: applied.duplicate ? null : applied.counts
      });
    }
    clearMemoryJobFailure(db, jobId, {now});
    return {duplicate: false, result: getMemoryResult(db, resultId), versions};
  });

  return {
    duplicate: outcome.duplicate,
    applied: !outcome.duplicate,
    result: outcome.result,
    versions: outcome.versions ?? [],
    preview: validation,
    job: getMemoryJob(db, jobId)
  };
}

export const __internal = {};
