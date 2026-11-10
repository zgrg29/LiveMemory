import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getSession} from '../storage/repositories/sessions.mjs';
import {getEventById} from '../storage/repositories/events.mjs';
import {
  findMemoryResultByChecksum,
  getMemory,
  getMemoryBatchById,
  getMemoryBatchEventId,
  getMemoryBatchViewer,
  getMemoryJob,
  latestMemoryResultForBatch,
  listFacts,
  listMemoryBatches
} from '../storage/repositories/viewer-memory.mjs';
import {
  ACCEPTED_MEMORY_SCHEMA_VERSIONS,
  MEMORY_CERTAINTIES,
  MEMORY_CERTAINTY,
  MEMORY_KINDS,
  MEMORY_OPERATION,
  MEMORY_OPERATIONS,
  MEMORY_PROTOCOL,
  MEMORY_SCHEMA_VERSION,
  MAX_EVIDENCE_PER_OP,
  MAX_MEMORY_IMPORT_BYTES,
  MAX_OPS_PER_VIEWER,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TOPIC_LENGTH,
  SUPPORTED_MEMORY_LOCALES,
  TARGETED_OPERATIONS
} from './constants.mjs';
import {normalizeCertainty, normalizeKind, normalizeText} from './model.mjs';
import {previewMemoryOperations} from './store.mjs';
import {parseImportText, checksumOf} from '../ai/import/validate.mjs';
import {validateAgainstSchema} from '../ai/import/schema-validator.mjs';
import {isoFromEpochMs} from '../shared/time.mjs';

/**
 * Validation of an imported memory update answer.
 *
 * This is the security boundary: the answer is external, untrusted data. It may
 * only nominate viewers and facts that were in the package it answers, may only
 * cite messages that really exist, and may never write a `stated` fact without a
 * direct quote. The preview it returns is produced by the real merge engine, so
 * what the user sees is exactly what applying would do.
 */

const SCHEMA_FILE = fileURLToPath(new URL('./schemas/memory-update-result-v1.schema.json', import.meta.url));
let cachedSchema = null;

export function loadMemorySchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
  return cachedSchema;
}

const FIX_GROUPS = Object.freeze({
  INVALID_JSON: 'json',
  EMPTY_INPUT: 'json',
  NOT_OBJECT: 'type',
  TOO_LARGE: 'size',
  TOO_COMPLEX: 'size',
  TOO_DEEP: 'size',
  STRING_TOO_LONG: 'range',
  FORBIDDEN_KEY: 'unknown_field',
  SCHEMA_CONST: 'version',
  SCHEMA_ENUM: 'enum',
  SCHEMA_TYPE: 'type',
  SCHEMA_REQUIRED: 'missing',
  SCHEMA_UNKNOWN_FIELD: 'unknown_field',
  SCHEMA_MIN_LENGTH: 'range',
  SCHEMA_MAX_LENGTH: 'range',
  SCHEMA_DATETIME: 'datetime',
  SCHEMA_MINIMUM: 'range',
  SCHEMA_MAXIMUM: 'range',
  SCHEMA_MIN_ITEMS: 'range',
  SCHEMA_MAX_ITEMS: 'range',
  SCHEMA_REF_SHAPE: 'evidence',
  SCHEMA_AMBIGUOUS: 'evidence',
  PROTOCOL_MISMATCH: 'version',
  SCHEMA_VERSION_UNSUPPORTED: 'version',
  MEMORY_JOB_REQUIRED: 'job',
  MEMORY_JOB_NOT_FOUND: 'job',
  MEMORY_BATCH_REQUIRED: 'batch',
  MEMORY_BATCH_UNKNOWN: 'batch',
  MEMORY_TASK_MISMATCH: 'batch',
  MEMORY_SESSION_MISMATCH: 'session',
  MEMORY_SESSION_NOT_FOUND: 'session',
  MEMORY_BROADCASTER_MISMATCH: 'broadcaster',
  MEMORY_BROADCASTER_REQUIRED: 'broadcaster',
  MEMORY_VIEWER_UNKNOWN: 'viewer',
  MEMORY_VIEWER_DUPLICATE: 'viewer',
  MEMORY_SCOPE_MISMATCH: 'viewer',
  MEMORY_FACT_TARGET_REQUIRED: 'target',
  MEMORY_FACT_UNKNOWN: 'target',
  MEMORY_OP_UNKNOWN: 'enum',
  MEMORY_STATEMENT_REQUIRED: 'missing',
  MEMORY_KIND_REQUIRED: 'missing',
  MEMORY_EVIDENCE_REQUIRED: 'evidence',
  MEMORY_REF_UNKNOWN: 'evidence',
  MEMORY_REF_OTHER_BATCH: 'evidence',
  MEMORY_EVIDENCE_TOO_MANY: 'size',
  MEMORY_OPS_TOO_MANY: 'size',
  MEMORY_DELETED: 'privacy',
  MEMORY_EMPTY: 'none',
  MEMORY_NO_EVIDENCE: 'none',
  MEMORY_EVIDENCE_PURGED: 'none',
  MEMORY_EVIDENCE_DELETED: 'none',
  MEMORY_BASE_STALE: 'none',
  MEMORY_LOCALE_MISMATCH: 'none',
  MEMORY_KIND_DEFAULTED: 'none',
  MEMORY_CERTAINTY_DOWNGRADED: 'none',
  MEMORY_TOPIC_CONFLICT: 'target',
  MEMORY_FACT_UNKNOWN_AT_APPLY: 'target'
});

function issue(severity, path, code, params = {}) {
  return {severity, path, code, params, fixGroup: FIX_GROUPS[code] ?? 'none'};
}

function dedupeIssues(issues) {
  const seen = new Set();
  const result = [];
  for (const item of issues) {
    const key = `${item.severity}|${item.path}|${item.code}|${JSON.stringify(item.params)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeEvidenceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => {
    if (typeof ref === 'number') return {batch: null, seq: Math.trunc(ref), raw: ref};
    return {
      batch: Math.trunc(Number(ref?.batch)),
      seq: Math.trunc(Number(ref?.seq)),
      raw: ref
    };
  });
}

/** Only whitelisted fields survive; the AI cannot smuggle extra data in. */
export function sanitizeMemoryResult(parsed, {schemaVersion}) {
  return {
    protocol: MEMORY_PROTOCOL,
    schema_version: schemaVersion,
    ...(typeof parsed.job_id === 'string' ? {job_id: normalizeText(parsed.job_id, 100)} : {}),
    ...(typeof parsed.batch_id === 'string' ? {batch_id: normalizeText(parsed.batch_id, 200)} : {}),
    ...(Object.prototype.hasOwnProperty.call(parsed, 'broadcaster_id')
      ? {
        broadcaster_id: parsed.broadcaster_id === null
          ? null
          : normalizeText(parsed.broadcaster_id, 200)
      }
      : {}),
    task_id: normalizeText(parsed.task_id, 200),
    session_id: normalizeText(parsed.session_id, 100),
    locale: parsed.locale,
    viewer_operations: (parsed.viewer_operations ?? []).map((entry) => ({
      viewer_id: normalizeText(entry.viewer_id, 200),
      ...(typeof entry.summary === 'string' ? {summary: normalizeText(entry.summary, MAX_SUMMARY_LENGTH)} : {}),
      operations: (entry.operations ?? []).map((operation) => ({
        op: operation.op,
        ...(operation.kind ? {kind: operation.kind} : {}),
        ...(operation.topic !== undefined ? {topic: normalizeText(operation.topic, MAX_TOPIC_LENGTH)} : {}),
        ...(operation.statement !== undefined
          ? {statement: normalizeText(operation.statement, MAX_STATEMENT_LENGTH)}
          : {}),
        ...(operation.certainty ? {certainty: operation.certainty} : {}),
        ...(operation.confidence !== undefined ? {confidence: Number(operation.confidence)} : {}),
        ...(operation.target_fact_id ? {target_fact_id: normalizeText(operation.target_fact_id, 60)} : {}),
        ...(operation.reason ? {reason: normalizeText(operation.reason, 200)} : {}),
        ...(operation.valid_from ? {valid_from: operation.valid_from} : {}),
        ...(operation.valid_until ? {valid_until: operation.valid_until} : {}),
        ...(Array.isArray(operation.evidence)
          ? {evidence: operation.evidence.map((ref) => (
            typeof ref === 'number'
              ? Math.trunc(ref)
              : {batch: Math.trunc(Number(ref?.batch)), seq: Math.trunc(Number(ref?.seq))}
          ))}
          : {})
      }))
    }))
  };
}

/**
 * @returns {object} preview with errors/warnings, resolved operations and the
 *   engine plan (per-viewer diff) that applying would produce.
 */
export function validateMemoryImport({db, text, source = 'paste', now = Date.now()}) {
  const parsedInput = parseImportText(text, {maxBytes: MAX_MEMORY_IMPORT_BYTES});
  const errors = [...parsedInput.errors];
  const warnings = [];
  const payload = parsedInput.value;
  const target = {
    job: null,
    batch: null,
    session: null,
    broadcasterId: null,
    locale: null,
    protocol: null,
    schemaVersion: null,
    viewerCount: 0,
    opCount: 0,
    duplicate: null,
    latestVersion: null,
    requiresVersionConfirm: false,
    baseVersions: []
  };
  const blocked = (extra = {}) => ({
    ok: false,
    action: 'blocked',
    errors: dedupeIssues(errors),
    warnings: dedupeIssues(warnings),
    target,
    operations: [],
    plan: [],
    totals: null,
    checksum: null,
    evidenceTotal: 0,
    evidenceMissing: 0,
    source,
    ...extra
  });

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    if (errors.length === 0) errors.push(issue('error', '', 'NOT_OBJECT'));
    return blocked();
  }

  const schemaVersion = typeof payload.schema_version === 'string' ? payload.schema_version : '1.0.0';
  target.protocol = typeof payload.protocol === 'string' ? payload.protocol : null;
  target.schemaVersion = schemaVersion;
  target.locale = typeof payload.locale === 'string' ? payload.locale : null;

  for (const schemaError of validateAgainstSchema(loadMemorySchema(), payload)) {
    errors.push(issue('error', schemaError.path, schemaError.code, schemaError.params));
  }
  if (payload.schema_version !== undefined && !ACCEPTED_MEMORY_SCHEMA_VERSIONS.includes(payload.schema_version)) {
    errors.push(issue('error', 'schema_version', 'SCHEMA_VERSION_UNSUPPORTED', {
      actual: String(payload.schema_version),
      accepted: ACCEPTED_MEMORY_SCHEMA_VERSIONS.join(', ')
    }));
  }
  if (payload.protocol !== MEMORY_PROTOCOL) {
    errors.push(issue('error', 'protocol', 'PROTOCOL_MISMATCH', {
      expected: MEMORY_PROTOCOL,
      actual: String(payload.protocol ?? '')
    }));
  }
  if (!SUPPORTED_MEMORY_LOCALES.includes(payload.locale)) {
    target.locale = null;
  }

  if (typeof payload.job_id !== 'string' || payload.job_id.trim() === '') {
    errors.push(issue('error', 'job_id', 'MEMORY_JOB_REQUIRED', {}));
    return blocked();
  }
  const job = getMemoryJob(db, payload.job_id.trim());
  if (!job) {
    errors.push(issue('error', 'job_id', 'MEMORY_JOB_NOT_FOUND', {jobId: payload.job_id.trim()}));
    return blocked();
  }
  const session = getSession(db, job.sessionId);
  if (!session) {
    errors.push(issue('error', 'session_id', 'MEMORY_SESSION_NOT_FOUND', {sessionId: job.sessionId}));
    return blocked();
  }
  if (payload.session_id !== job.sessionId) {
    errors.push(issue('error', 'session_id', 'MEMORY_SESSION_MISMATCH', {
      expected: job.sessionId,
      actual: String(payload.session_id ?? '')
    }));
  }
  const expectedBroadcaster = job.broadcasterId ?? session.broadcaster_id ?? null;
  if (Object.prototype.hasOwnProperty.call(payload, 'broadcaster_id')
    && payload.broadcaster_id !== null && payload.broadcaster_id !== expectedBroadcaster) {
    errors.push(issue('error', 'broadcaster_id', 'MEMORY_BROADCASTER_MISMATCH', {
      expected: expectedBroadcaster,
      actual: String(payload.broadcaster_id)
    }));
  }
  if (!expectedBroadcaster) {
    errors.push(issue('error', 'broadcaster_id', 'MEMORY_BROADCASTER_REQUIRED', {}));
  }
  if (job.locale !== payload.locale) {
    warnings.push(issue('warning', 'locale', 'MEMORY_LOCALE_MISMATCH', {expected: job.locale, actual: payload.locale}));
  }

  if (typeof payload.batch_id !== 'string' || payload.batch_id.trim() === '') {
    errors.push(issue('error', 'batch_id', 'MEMORY_BATCH_REQUIRED', {}));
    return blocked();
  }
  const batch = getMemoryBatchById(db, job.id, payload.batch_id.trim());
  if (!batch) {
    errors.push(issue('error', 'batch_id', 'MEMORY_BATCH_UNKNOWN', {
      batchId: payload.batch_id.trim(),
      batches: listMemoryBatches(db, job.id).map((row) => row.batchId).join(', ')
    }));
    return blocked();
  }
  if (payload.task_id !== batch.taskId) {
    errors.push(issue('error', 'task_id', 'MEMORY_TASK_MISMATCH', {
      expected: batch.taskId,
      actual: String(payload.task_id ?? '')
    }));
  }

  target.job = {
    id: job.id,
    batchTotal: job.batchTotal,
    viewersTotal: job.viewersTotal,
    locale: job.locale,
    promptVersion: job.promptVersion,
    createdAt: job.createdAt
  };
  target.batch = {
    index: batch.batchIndex,
    batchId: batch.batchId,
    taskId: batch.taskId,
    viewerCount: batch.viewerCount,
    messageCount: batch.messageCount,
    fileName: batch.fileName,
    checksum: batch.checksum
  };
  target.session = {
    id: session.id,
    platform: session.platform,
    roomTitle: session.room_title,
    broadcasterName: session.broadcaster_name,
    broadcasterId: expectedBroadcaster,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    archived: session.archived_at !== null && session.archived_at !== undefined
  };
  target.broadcasterId = expectedBroadcaster;

  const viewerEntries = Array.isArray(payload.viewer_operations) ? payload.viewer_operations : [];
  const seenViewers = new Set();
  const resolved = [];
  let evidenceTotal = 0;
  let evidenceMissing = 0;
  const factsCache = new Map();
  const memoryCache = new Map();

  for (let viewerIndex = 0; viewerIndex < viewerEntries.length; viewerIndex += 1) {
    const entry = viewerEntries[viewerIndex];
    const viewerId = normalizeText(entry?.viewer_id, 200);
    const path = `viewer_operations[${viewerIndex}]`;
    if (!viewerId) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_UNKNOWN', {viewerId: ''}));
      continue;
    }
    if (seenViewers.has(viewerId)) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_DUPLICATE', {viewerId}));
      continue;
    }
    seenViewers.add(viewerId);
    const batchViewer = getMemoryBatchViewer(db, job.id, batch.batchIndex, viewerId);
    if (!batchViewer) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_VIEWER_UNKNOWN', {viewerId}));
      continue;
    }
    const memory = getMemory(db, {broadcasterId: expectedBroadcaster, viewerId});
    memoryCache.set(viewerId, memory);
    if (memory && memory.broadcasterId !== expectedBroadcaster) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_SCOPE_MISMATCH', {viewerId}));
      continue;
    }
    if (memory && memory.status === 'deleted' && Number(job.createdAt) <= Number(memory.deletedAt ?? 0)) {
      errors.push(issue('error', `${path}.viewer_id`, 'MEMORY_DELETED', {viewerId}));
      continue;
    }
    if (memory && memory.status === 'active' && memory.version !== batchViewer.baseVersion) {
      warnings.push(issue('warning', `${path}.viewer_id`, 'MEMORY_BASE_STALE', {
        viewerId,
        baseVersion: batchViewer.baseVersion,
        currentVersion: memory.version
      }));
    }
    const facts = memory && memory.status === 'active' ? listFacts(db, memory.id, {limit: 500}) : [];
    factsCache.set(viewerId, new Map(facts.map((fact) => [fact.id, fact])));

    const operations = Array.isArray(entry.operations) ? entry.operations : [];
    if (operations.length > MAX_OPS_PER_VIEWER) {
      errors.push(issue('error', `${path}.operations`, 'MEMORY_OPS_TOO_MANY', {limit: MAX_OPS_PER_VIEWER, actual: operations.length}));
      continue;
    }
    const resolvedOps = [];
    for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
      const operation = operations[opIndex];
      const opPath = `${path}.operations[${opIndex}]`;
      const op = operation?.op;
      if (!MEMORY_OPERATIONS.includes(op)) {
        errors.push(issue('error', `${opPath}.op`, 'MEMORY_OP_UNKNOWN', {actual: String(op ?? '')}));
        continue;
      }
      const statement = normalizeText(operation.statement ?? '', MAX_STATEMENT_LENGTH);
      const topic = operation.topic ? normalizeText(operation.topic, MAX_TOPIC_LENGTH) : null;
      let kind = operation.kind ? normalizeKind(operation.kind) : null;
      if (operation.kind && !MEMORY_KINDS.includes(operation.kind)) {
        // The schema already rejects unknown kinds; keep a defensive fallback.
        kind = 'other';
      }
      if (!kind && (op === MEMORY_OPERATION.ADD || op === MEMORY_OPERATION.UNCERTAIN)) {
        kind = 'other';
        warnings.push(issue('warning', `${opPath}.kind`, 'MEMORY_KIND_DEFAULTED', {kind}));
      }
      if (!statement && (op === MEMORY_OPERATION.ADD
        || op === MEMORY_OPERATION.UPDATE
        || op === MEMORY_OPERATION.SUPERSEDE
        || op === MEMORY_OPERATION.CONFLICT
        || op === MEMORY_OPERATION.UNCERTAIN)) {
        if (topic) {
          // A topic alone is a valid, if terse, statement.
        } else {
          errors.push(issue('error', `${opPath}.statement`, 'MEMORY_STATEMENT_REQUIRED', {}));
          continue;
        }
      }

      let targetFactId = null;
      if (TARGETED_OPERATIONS.includes(op)) {
        targetFactId = operation.target_fact_id ? normalizeText(operation.target_fact_id, 60) : null;
        if (!targetFactId) {
          errors.push(issue('error', `${opPath}.target_fact_id`, 'MEMORY_FACT_TARGET_REQUIRED', {}));
          continue;
        }
        const known = factsCache.get(viewerId);
        if (!known?.has(targetFactId)) {
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
        errors.push(issue('error', `${opPath}.evidence`, 'MEMORY_EVIDENCE_TOO_MANY', {
          limit: MAX_EVIDENCE_PER_OP,
          actual: refs.length
        }));
        continue;
      }
      const evidence = [];
      for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
        const ref = refs[refIndex];
        const refPath = `${opPath}.evidence[${refIndex}]`;
        const refBatch = ref.batch ?? batch.batchIndex;
        if (refBatch !== batch.batchIndex) {
          errors.push(issue('error', refPath, 'MEMORY_REF_OTHER_BATCH', {
            expected: batch.batchIndex,
            actual: refBatch
          }));
          continue;
        }
        if (!Number.isFinite(ref.seq) || ref.seq < 1) {
          errors.push(issue('error', refPath, 'MEMORY_REF_UNKNOWN', {seq: ref.seq, batch: refBatch}));
          continue;
        }
        const eventId = getMemoryBatchEventId(db, job.id, batch.batchIndex, ref.seq);
        if (eventId === null) {
          errors.push(issue('error', refPath, 'MEMORY_REF_UNKNOWN', {
            seq: ref.seq,
            batch: refBatch,
            max: batch.messageCount
          }));
          continue;
        }
        const event = getEventById(db, eventId);
        if (!event) {
          evidenceMissing += 1;
          warnings.push(issue('warning', refPath, 'MEMORY_EVIDENCE_DELETED', {seq: ref.seq}));
        } else if (event.content_purged_at) {
          warnings.push(issue('warning', refPath, 'MEMORY_EVIDENCE_PURGED', {seq: ref.seq}));
        }
        evidenceTotal += 1;
        evidence.push({
          sourceKey: `s:${job.sessionId}:b${batch.batchIndex}:${ref.seq}`,
          sessionId: job.sessionId,
          batchIndex: batch.batchIndex,
          seq: ref.seq,
          eventId,
          observedAt: event?.occurred_at ?? null,
          available: Boolean(event) && !event?.content_purged_at
        });
      }

      const needsEvidence = [MEMORY_OPERATION.ADD, MEMORY_OPERATION.UPDATE, MEMORY_OPERATION.SUPERSEDE,
        MEMORY_OPERATION.CONFLICT].includes(op);
      if (needsEvidence && evidence.length === 0) {
        if (certainty === MEMORY_CERTAINTY.STATED) {
          errors.push(issue('error', `${opPath}.evidence`, 'MEMORY_EVIDENCE_REQUIRED', {certainty}));
          continue;
        }
        if (certainty === MEMORY_CERTAINTY.INFERRED) {
          warnings.push(issue('warning', `${opPath}.certainty`, 'MEMORY_CERTAINTY_DOWNGRADED', {}));
          certainty = MEMORY_CERTAINTY.UNCERTAIN;
        } else {
          warnings.push(issue('warning', `${opPath}.evidence`, 'MEMORY_NO_EVIDENCE', {}));
        }
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
        evidence,
        path: opPath
      });
    }
    resolved.push({
      viewerId,
      nickname: null,
      summary: typeof entry.summary === 'string' ? normalizeText(entry.summary, MAX_SUMMARY_LENGTH) : null,
      operations: resolvedOps,
      baseVersion: batchViewer.baseVersion,
      memoryVersion: memory?.version ?? 0
    });
  }

  target.viewerCount = resolved.length;
  target.opCount = resolved.reduce((sum, entry) => sum + entry.operations.length, 0);
  if (resolved.length === 0 && errors.length === 0) {
    warnings.push(issue('warning', '', 'MEMORY_EMPTY', {}));
  }

  const sanitized = sanitizeMemoryResult(payload, {schemaVersion});
  const checksum = checksumOf(sanitized);
  const duplicate = findMemoryResultByChecksum(db, job.id, batch.batchId, checksum);
  const latest = latestMemoryResultForBatch(db, job.id, batch.batchIndex);
  target.duplicate = duplicate
    ? {id: duplicate.id, appliedAt: duplicate.appliedAt}
    : null;
  target.requiresVersionConfirm = Boolean(latest && !duplicate);
  target.latestVersion = latest ? {id: latest.id, appliedAt: latest.appliedAt} : null;

  const plan = [];
  if (errors.length === 0) {
    for (const entry of resolved) {
      if (entry.operations.length === 0) continue;
      const preview = previewMemoryOperations({
        db,
        broadcasterId: expectedBroadcaster,
        viewerId: entry.viewerId,
        operations: entry.operations,
        source: {
          kind: 'ai_memory_update',
          jobId: job.id,
          sessionId: session.id,
          resultId: null,
          label: 'ai_memory_update'
        },
        now
      });
      const factIds = [...new Set(entry.operations.flatMap((operation) => (
        operation.targetFactId ? [operation.targetFactId] : []
      )))];
      plan.push({
        viewerId: entry.viewerId,
        baseVersion: preview.baseVersion,
        nextVersion: preview.version,
        summary: entry.summary,
        opCount: entry.operations.length,
        counts: preview.diff.counts,
        diff: preview.diff,
        operations: entry.operations.map((operation, index) => ({
          op: operation.op,
          kind: operation.kind,
          topic: operation.topic,
          statement: operation.statement,
          certainty: operation.certainty,
          targetFactId: operation.targetFactId,
          result: preview.results[index]?.status ?? 'skipped',
          reason: preview.results[index]?.reason ?? null,
          evidence: operation.evidence.length
        })),
        targetFacts: factIds.map((factId) => {
          const fact = factsCache.get(entry.viewerId)?.get(factId);
          return fact
            ? {id: fact.id, kind: fact.kind, topic: fact.topic, statement: fact.statement, status: fact.status}
            : {id: factId, missing: true};
        }),
        warnings: preview.warnings
      });
    }
  }

  const totals = plan.reduce((acc, entry) => {
    acc.viewers += 1;
    acc.operations += entry.opCount;
    for (const key of ['added', 'changed', 'removed', 'confirmed']) {
      acc[key] += Number(entry.counts?.[key] ?? 0);
    }
    return acc;
  }, {viewers: 0, operations: 0, added: 0, changed: 0, removed: 0, confirmed: 0});

  if (errors.length > 0) {
    return blocked({
      target,
      operations: resolved,
      plan,
      totals,
      checksum,
      evidenceTotal,
      evidenceMissing
    });
  }

  return {
    ok: true,
    action: duplicate ? 'duplicate' : (target.requiresVersionConfirm ? 'confirm_version' : 'apply'),
    errors: [],
    warnings: dedupeIssues(warnings),
    target,
    job,
    batch,
    session,
    operations: resolved,
    plan,
    totals,
    checksum,
    sanitized,
    evidenceTotal,
    evidenceMissing,
    source
  };
}

export const __internal = {FIX_GROUPS, normalizeEvidenceRefs, issue};
