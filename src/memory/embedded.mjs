import {getSession} from '../storage/repositories/sessions.mjs';
import {getEventById} from '../storage/repositories/events.mjs';
import {
  getJobMemoryMessage,
  listJobMemoryViewers,
  listJobViewerIds
} from '../storage/repositories/ai-jobs.mjs';
import {getMemory, listFacts} from '../storage/repositories/viewer-memory.mjs';
import {
  MAX_EVIDENCE_PER_OP,
  MAX_OPS_PER_VIEWER,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TOPIC_LENGTH,
  MEMORY_CERTAINTIES,
  MEMORY_CERTAINTY,
  MEMORY_KINDS,
  MEMORY_OPERATION,
  MEMORY_OPERATIONS,
  TARGETED_OPERATIONS
} from './constants.mjs';
import {normalizeCertainty, normalizeKind, normalizeText} from './model.mjs';
import {previewMemoryOperations} from './store.mjs';

/**
 * Validation and application of long-term memory updates embedded in one M6
 * analysis result.
 *
 * This is a security boundary: the update is external data. It may only name
 * viewers assigned to this batch, only cite excerpts that were written by the
 * same viewer, and can never write objective statistics. Every viewer assigned
 * to the batch must have exactly one entry, including viewers with no new
 * semantic information.
 */

export const MEMORY_FIX_GROUPS = Object.freeze({
  MEMORY_UPDATES_REQUIRED: 'viewer',
  MEMORY_VIEWER_UPDATE_MISSING: 'viewer',
  MEMORY_VIEWER_UNKNOWN: 'viewer',
  MEMORY_VIEWER_DUPLICATE: 'viewer',
  MEMORY_VIEWER_DELETED: 'privacy',
  MEMORY_OP_UNKNOWN: 'enum',
  MEMORY_KIND_INVALID: 'enum',
  MEMORY_STATEMENT_REQUIRED: 'missing',
  MEMORY_OPS_TOO_MANY: 'size',
  MEMORY_EVIDENCE_TOO_MANY: 'size',
  MEMORY_EVIDENCE_OTHER_VIEWER: 'evidence',
  MEMORY_REF_UNKNOWN: 'evidence',
  MEMORY_REF_OTHER_BATCH: 'evidence',
  MEMORY_EVIDENCE_REQUIRED: 'evidence',
  MEMORY_FACT_TARGET_REQUIRED: 'target',
  MEMORY_FACT_UNKNOWN: 'target',
  MEMORY_NO_NEW_WITH_OPS: 'none',
  MEMORY_AGGREGATE_UPDATE: 'none',
  MEMORY_BASE_STALE: 'none',
  MEMORY_EVIDENCE_DELETED: 'none',
  MEMORY_EVIDENCE_PURGED: 'none',
  MEMORY_NO_NEW_FLAG_MISSING: 'none',
  MEMORY_OBJECTIVE_ONLY: 'none',
  MEMORY_PREVIEW_FAILED: 'none',
  MEMORY_BROADCASTER_REQUIRED: 'broadcast'
});

function issue(severity, path, code, params = {}) {
  return {severity, path, code, params, fixGroup: MEMORY_FIX_GROUPS[code] ?? 'none'};
}

function normalizeEvidenceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => {
    if (typeof ref === 'number') return {batch: null, seq: Math.trunc(ref)};
    return {batch: Math.trunc(Number(ref?.batch)), seq: Math.trunc(Number(ref?.seq))};
  });
}

function factsForMemory(db, broadcasterId, viewerId) {
  const memory = broadcasterId ? getMemory(db, {broadcasterId, viewerId}) : null;
  const facts = memory && memory.status === 'active' ? listFacts(db, memory.id, {limit: 500}) : [];
  return {memory, facts};
}

/**
 * @returns {{ok:boolean, errors:Array, warnings:Array, viewers:Array, coverage:object,
 *   plan:Array, totals:object, legacy:boolean, memoryViewers:Array}}
 */
export function validateEmbeddedMemoryUpdates({
  db,
  job,
  batch,
  session,
  payload,
  schemaVersion = '1.0.0',
  mode = 'batch',
  now = Date.now()
}) {
  const errors = [];
  const warnings = [];
  const emptyTotals = {semanticViewers: 0, noSemanticViewers: 0, objectiveOnly: 0, missing: 0, operations: 0, added: 0, changed: 0, removed: 0, confirmed: 0};
  const base = {
    ok: true,
    errors,
    warnings,
    viewers: [],
    coverage: null,
    plan: [],
    totals: emptyTotals,
    legacy: false,
    updatesMissing: false,
    memoryViewers: []
  };
  if (!job || !session) return base;
  const broadcasterId = job.broadcasterId ?? session.broadcaster_id ?? null;
  if (!broadcasterId) {
    if (Array.isArray(payload.viewer_memory_updates) && payload.viewer_memory_updates.length > 0) {
      errors.push(issue('error', 'broadcaster_id', 'MEMORY_BROADCASTER_REQUIRED', {}));
      return {...base, ok: false};
    }
    warnings.push(issue('warning', 'broadcaster_id', 'MEMORY_OBJECTIVE_ONLY', {reason: 'broadcaster_unresolved'}));
    return {...base, ok: true, updatesMissing: true};
  }

  if (mode === 'aggregate') {
    if (Array.isArray(payload.viewer_memory_updates) && payload.viewer_memory_updates.length > 0) {
      errors.push(issue('error', 'viewer_memory_updates', 'MEMORY_AGGREGATE_UPDATE', {}));
    }
    return {...base, ok: errors.length === 0};
  }

  const allMemoryViewers = listJobMemoryViewers(db, job.id);
  let memoryViewers = allMemoryViewers.filter((entry) => entry.batchIndex === batch.batchIndex);
  const legacy = allMemoryViewers.length === 0;
  if (legacy) {
    // Pre-v12 jobs have no memory assignment table. Cover their batch viewers
    // with objective updates only; semantic updates are not accepted because
    // there is no excerpt mapping to verify them against.
    const viewerIds = listJobViewerIds(db, job.id, batch.batchIndex);
    memoryViewers = viewerIds.map((viewerId) => ({
      viewerId,
      batchIndex: batch.batchIndex,
      baseVersion: 0,
      status: 'pending'
    }));
    if (Array.isArray(payload.viewer_memory_updates) && payload.viewer_memory_updates.length > 0) {
      errors.push(issue('error', 'viewer_memory_updates', 'MEMORY_UPDATES_REQUIRED', {legacy: true}));
    }
  }
  base.legacy = legacy;
  base.memoryViewers = memoryViewers;
  if (!legacy && memoryViewers.length === 0) {
    if (Array.isArray(payload.viewer_memory_updates) && payload.viewer_memory_updates.length > 0) {
      errors.push(issue('error', 'viewer_memory_updates', 'MEMORY_VIEWER_UNKNOWN', {viewerId: payload.viewer_memory_updates[0]?.viewer_id ?? ''}));
    }
    return {...base, ok: errors.length === 0};
  }
  if (memoryViewers.length === 0) return base;

  const byViewer = new Map(memoryViewers.map((entry) => [entry.viewerId, entry]));
  const updates = payload.viewer_memory_updates;
  if (!Array.isArray(updates)) {
    if (schemaVersion === '1.2.0') {
      errors.push(issue('error', 'viewer_memory_updates', 'MEMORY_UPDATES_REQUIRED', {}));
    }
    for (const entry of memoryViewers) {
      warnings.push(issue('warning', `viewer_memory_updates.${entry.viewerId}`, 'MEMORY_OBJECTIVE_ONLY', {viewerId: entry.viewerId}));
    }
    return {
      ...base,
      ok: errors.length === 0,
      updatesMissing: true,
      coverage: {
        total: memoryViewers.length,
        semantic: 0,
        no_semantics: 0,
        objective_only: memoryViewers.length,
        missing_update: 0,
        deleted: 0
      }
    };
  }

  const seen = new Set();
  const resolved = [];
  const coverage = {
    total: memoryViewers.length,
    semantic: 0,
    no_semantics: 0,
    objective_only: 0,
    missing_update: 0,
    deleted: 0
  };
  const plan = [];
  const totals = {...emptyTotals};

  for (let index = 0; index < updates.length; index += 1) {
    const entry = updates[index] ?? {};
    const viewerId = normalizeText(entry.viewer_id, 200);
    const path = `viewer_memory_updates[${index}]`;
    if (!viewerId || !byViewer.has(viewerId)) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_UNKNOWN', {viewerId}));
      continue;
    }
    if (seen.has(viewerId)) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_DUPLICATE', {viewerId}));
      continue;
    }
    seen.add(viewerId);
    const assignment = byViewer.get(viewerId);
    const {memory, facts} = factsForMemory(db, broadcasterId, viewerId);
    if (memory && memory.status === 'deleted' && Number(job.createdAt) <= Number(memory.deletedAt ?? 0)) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_DELETED', {viewerId}));
      coverage.deleted += 1;
      continue;
    }
    if (memory && memory.status === 'active' && memory.version !== Number(assignment.baseVersion ?? 0)) {
      warnings.push(issue('warning', `${path}.viewer_id`, 'MEMORY_BASE_STALE', {
        viewerId,
        baseVersion: assignment.baseVersion,
        currentVersion: memory.version
      }));
    }
    const operations = Array.isArray(entry.operations) ? entry.operations : [];
    if (operations.length > MAX_OPS_PER_VIEWER) {
      errors.push(issue('error', `${path}.operations`, 'MEMORY_OPS_TOO_MANY', {limit: MAX_OPS_PER_VIEWER, actual: operations.length}));
      coverage.missing_update += 1;
      continue;
    }
    if (entry.no_new_information === true && operations.length > 0) {
      errors.push(issue('error', `${path}.operations`, 'MEMORY_NO_NEW_WITH_OPS', {}));
      coverage.missing_update += 1;
      continue;
    }
    if (entry.no_new_information !== true && operations.length === 0 && !entry.summary) {
      warnings.push(issue('warning', `${path}.no_new_information`, 'MEMORY_NO_NEW_FLAG_MISSING', {}));
    }

    const factsById = new Map(facts.map((fact) => [fact.id, fact]));
    const resolvedOps = [];
    const evidenceRows = [];
    for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
      const operation = operations[opIndex];
      const opPath = `${path}.operations[${opIndex}]`;
      const op = operation?.op;
      if (!MEMORY_OPERATIONS.includes(op)) {
        errors.push(issue('error', `${opPath}.op`, 'MEMORY_OP_UNKNOWN', {actual: String(op ?? '')}));
        continue;
      }
      let kind = operation.kind ? normalizeKind(operation.kind) : null;
      if (operation.kind && !MEMORY_KINDS.includes(operation.kind)) {
        errors.push(issue('error', `${opPath}.kind`, 'MEMORY_KIND_INVALID', {actual: String(operation.kind)}));
        continue;
      }
      if (!kind && (op === MEMORY_OPERATION.ADD || op === MEMORY_OPERATION.UNCERTAIN)) kind = 'other';
      const topic = operation.topic ? normalizeText(operation.topic, MAX_TOPIC_LENGTH) : null;
      const statement = normalizeText(operation.statement ?? '', MAX_STATEMENT_LENGTH);
      if (!statement && !topic && ![
        MEMORY_OPERATION.CONFIRM,
        MEMORY_OPERATION.OUTDATED
      ].includes(op)) {
        errors.push(issue('error', `${opPath}.statement`, 'MEMORY_STATEMENT_REQUIRED', {}));
        continue;
      }
      let targetFactId = null;
      if (TARGETED_OPERATIONS.includes(op)) {
        targetFactId = operation.target_fact_id ? normalizeText(operation.target_fact_id, 60) : null;
        if (!targetFactId) {
          errors.push(issue('error', `${opPath}.target_fact_id`, 'MEMORY_FACT_TARGET_REQUIRED', {}));
          continue;
        }
        if (!factsById.has(targetFactId)) {
          errors.push(issue('error', `${opPath}.target_fact_id`, 'MEMORY_FACT_UNKNOWN', {factId: targetFactId, viewerId}));
          continue;
        }
      }
      let certainty = operation.certainty ? normalizeCertainty(operation.certainty) : null;
      if (operation.certainty && !MEMORY_CERTAINTIES.includes(operation.certainty)) certainty = null;
      if (op === MEMORY_OPERATION.UNCERTAIN) certainty = MEMORY_CERTAINTY.UNCERTAIN;
      if (!certainty) certainty = op === MEMORY_OPERATION.ADD ? MEMORY_CERTAINTY.INFERRED : null;

      const refs = normalizeEvidenceRefs(operation.evidence);
      if (refs.length > MAX_EVIDENCE_PER_OP) {
        errors.push(issue('error', `${opPath}.evidence`, 'MEMORY_EVIDENCE_TOO_MANY', {limit: MAX_EVIDENCE_PER_OP, actual: refs.length}));
        continue;
      }
      const evidence = [];
      for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
        const ref = refs[refIndex];
        const refPath = `${opPath}.evidence[${refIndex}]`;
        const refBatch = ref.batch ?? batch.batchIndex;
        if (refBatch !== batch.batchIndex) {
          errors.push(issue('error', refPath, 'MEMORY_REF_OTHER_BATCH', {expected: batch.batchIndex, actual: refBatch}));
          continue;
        }
        if (!Number.isFinite(ref.seq) || ref.seq < 1) {
          errors.push(issue('error', refPath, 'MEMORY_REF_UNKNOWN', {seq: ref.seq, batch: refBatch}));
          continue;
        }
        const mapping = getJobMemoryMessage(db, job.id, batch.batchIndex, ref.seq);
        if (!mapping) {
          errors.push(issue('error', refPath, 'MEMORY_REF_UNKNOWN', {seq: ref.seq, batch: refBatch}));
          continue;
        }
        if (mapping.viewerId !== viewerId) {
          errors.push(issue('error', refPath, 'MEMORY_EVIDENCE_OTHER_VIEWER', {seq: ref.seq, viewerId, actual: mapping.viewerId}));
          continue;
        }
        const event = getEventById(db, mapping.eventId);
        if (!event) {
          warnings.push(issue('warning', refPath, 'MEMORY_EVIDENCE_DELETED', {seq: ref.seq}));
        } else if (event.content_purged_at) {
          warnings.push(issue('warning', refPath, 'MEMORY_EVIDENCE_PURGED', {seq: ref.seq}));
        }
        evidence.push({
          sourceKey: `analysis:${job.id}:b${batch.batchIndex}:v${viewerId}:s${ref.seq}`.slice(0, 200),
          sessionId: session.id,
          batchIndex: batch.batchIndex,
          seq: ref.seq,
          eventId: mapping.eventId,
          observedAt: event?.occurred_at ?? null,
          available: Boolean(event) && !event?.content_purged_at
        });
        evidenceRows.push(evidence.at(-1));
      }
      const needsEvidence = [
        MEMORY_OPERATION.ADD,
        MEMORY_OPERATION.UPDATE,
        MEMORY_OPERATION.SUPERSEDE,
        MEMORY_OPERATION.CONFLICT
      ].includes(op);
      if (needsEvidence && evidence.length === 0) {
        if (certainty === MEMORY_CERTAINTY.STATED) {
          errors.push(issue('error', `${opPath}.evidence`, 'MEMORY_EVIDENCE_REQUIRED', {certainty}));
          continue;
        }
        if (certainty === MEMORY_CERTAINTY.INFERRED) certainty = MEMORY_CERTAINTY.UNCERTAIN;
      }
      resolvedOps.push({
        op,
        kind,
        topic,
        statement: statement || topic || '',
        certainty,
        confidence: operation.confidence === undefined ? null : Number(operation.confidence),
        targetFactId,
        reason: operation.reason ? normalizeText(operation.reason, 200) : null,
        validFrom: operation.valid_from ? Date.parse(operation.valid_from) : null,
        validUntil: operation.valid_until ? Date.parse(operation.valid_until) : null,
        evidence
      });
    }

    const summary = typeof entry.summary === 'string' ? normalizeText(entry.summary, MAX_SUMMARY_LENGTH) : null;
    const summaryCertainty = summary
      ? (normalizeCertainty(entry.summary_certainty) ?? MEMORY_CERTAINTY.INFERRED)
      : null;
    const semantic = resolvedOps.length > 0 || Boolean(summary);
    if (semantic) {
      totals.semanticViewers += 1;
      coverage.semantic += 1;
    } else {
      totals.noSemanticViewers += 1;
      coverage.no_semantics += 1;
    }
    totals.operations += resolvedOps.length;
    const resolvedEntry = {
      viewerId,
      nickname: null,
      summary,
      summaryCertainty,
      noNewInformation: entry.no_new_information === true,
      operations: resolvedOps,
      baseVersion: Number(assignment.baseVersion ?? 0),
      memoryVersion: memory?.version ?? 0,
      deleted: false
    };
    resolved.push(resolvedEntry);

    if (resolvedOps.length > 0 || summary) {
      try {
        const preview = previewMemoryOperations({
          db,
          broadcasterId,
          viewerId,
          operations: resolvedOps,
          now
        });
        plan.push({
          viewerId,
          baseVersion: preview.baseVersion,
          nextVersion: preview.version,
          summary,
          opCount: resolvedOps.length,
          counts: preview.diff.counts,
          diff: preview.diff,
          warnings: preview.warnings
        });
        totals.added += Number(preview.diff.counts?.added ?? 0);
        totals.changed += Number(preview.diff.counts?.changed ?? 0);
        totals.removed += Number(preview.diff.counts?.removed ?? 0);
        totals.confirmed += Number(preview.diff.counts?.confirmed ?? 0);
      } catch (error) {
        errors.push(issue('error', path, 'MEMORY_PREVIEW_FAILED', {message: String(error?.message ?? '').slice(0, 120)}));
      }
    }
  }

  for (const entry of memoryViewers) {
    if (seen.has(entry.viewerId)) continue;
    errors.push(issue('error', 'viewer_memory_updates', 'MEMORY_VIEWER_UPDATE_MISSING', {viewerId: entry.viewerId}));
    coverage.missing_update += 1;
  }
  coverage.objective_only = 0;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    viewers: resolved,
    coverage,
    plan,
    totals,
    legacy,
    memoryViewers
  };
}

/**
 * Apply one validated batch inside the caller's analysis-import transaction.
 * The caller owns the transaction; a throw must roll back the analysis result
 * as well.
 */
export function applyEmbeddedMemoryUpdates({
  db,
  job,
  batch,
  session,
  validation,
  resultId,
  now = Date.now(),
  applyOperations,
  ensureObjective
}) {
  const outcomes = [];
  if (!validation || validation.legacy || validation.updatesMissing) {
    for (const entry of validation?.memoryViewers ?? []) {
      const objective = ensureObjective({
        viewerId: entry.viewerId,
        sessionId: session.id,
        jobId: job.id,
        now
      });
      outcomes.push({
        viewerId: entry.viewerId,
        status: objective.status === 'deleted' ? 'deleted' : 'objective_only',
        objective,
        version: null
      });
    }
    return outcomes;
  }
  const byViewer = new Map(validation.viewers.map((entry) => [entry.viewerId, entry]));
  for (const assignment of validation.memoryViewers) {
    const viewerId = assignment.viewerId;
    const objective = ensureObjective({
      viewerId,
      sessionId: session.id,
      jobId: job.id,
      now
    });
    if (objective.status === 'deleted') {
      outcomes.push({viewerId, status: 'deleted', objective, version: null});
      continue;
    }
    const entry = byViewer.get(viewerId);
    if (!entry) {
      outcomes.push({viewerId, status: 'missing_update', objective, version: null});
      continue;
    }
    if (entry.operations.length === 0 && !entry.summary) {
      outcomes.push({viewerId, status: 'no_semantics', objective, version: objective.memory?.version ?? 0});
      continue;
    }
    const outcome = applyOperations({
      broadcasterId: job.broadcasterId,
      viewerId,
      operations: entry.operations,
      summary: entry.summary,
      summaryCertainty: entry.summaryCertainty,
      source: {
        kind: 'session_analysis_result',
        jobId: job.id,
        sessionId: session.id,
        resultId,
        label: 'analysis_result'
      },
      sourceKey: `analysis:${resultId}:${viewerId}`,
      now
    });
    outcomes.push({
      viewerId,
      status: outcome.duplicate ? 'no_semantics' : 'semantic',
      objective,
      version: outcome.version,
      counts: outcome.counts ?? null
    });
  }
  return outcomes;
}
