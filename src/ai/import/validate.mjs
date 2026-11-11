import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {getSession} from '../../storage/repositories/sessions.mjs';
import {
  countSessionMessages,
  getEventById,
  listSessionMessagesAsc
} from '../../storage/repositories/events.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {
  getJob,
  getJobBatchById,
  getJobMessageEventId,
  listAllJobViewerIds,
  listJobBatches,
  listJobViewerIds,
  listJobs
} from '../../storage/repositories/ai-jobs.mjs';
import {
  findResultByChecksum,
  latestResultForScope
} from '../../storage/repositories/ai-results.mjs';
import {isoFromEpochMs} from '../../shared/time.mjs';
import {
  ACCEPTED_RESULT_SCHEMA_VERSIONS,
  ANALYSIS_MODE,
  RESULT_PROTOCOL,
  SUPPORTED_LOCALES,
  TASK_KIND,
  MAX_IMPORT_BYTES,
  MAX_REPORT_EVIDENCE
} from '../constants.mjs';
import {validateAgainstSchema} from './schema-validator.mjs';
import {validateEmbeddedMemoryUpdates} from '../../memory/embedded.mjs';

const SCHEMA_FILE = fileURLToPath(new URL('../schemas/analysis-result-v1.schema.json', import.meta.url));
const SCHEMA_FILE_V13 = fileURLToPath(new URL('../schemas/analysis-result-v1.3.schema.json', import.meta.url));
const cachedSchemas = new Map();

export function loadResultSchema(version = '1.2.0') {
  if (!cachedSchemas.has(version)) {
    cachedSchemas.set(
      version,
      JSON.parse(readFileSync(version === '1.3.0' ? SCHEMA_FILE_V13 : SCHEMA_FILE, 'utf8'))
    );
  }
  return cachedSchemas.get(version);
}

/**
 * Map a validation code to a short, translatable "how to fix it" group. The
 * console renders `ai.import.fix.<group>` next to the field path.
 */
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
  SCHEMA_REF_SHAPE: 'message_ref',
  SCHEMA_AMBIGUOUS: 'message_ref',
  PROTOCOL_MISMATCH: 'version',
  SCHEMA_VERSION_UNSUPPORTED: 'version',
  SESSION_NOT_FOUND: 'session',
  SESSION_MISMATCH: 'session',
  SESSION_EMPTY: 'session',
  JOB_NOT_FOUND: 'task',
  TASK_MISMATCH: 'task',
  TASK_NOT_FOUND: 'task',
  BATCH_MISMATCH: 'batch',
  BATCH_MISSING: 'batch',
  BATCH_NOT_READY: 'aggregate',
  AGGREGATE_NOT_READY: 'aggregate',
  REF_AMBIGUOUS: 'message_ref',
  REF_OTHER_BATCH: 'message_ref',
  MESSAGE_REF_UNKNOWN: 'message_ref',
  VIEWER_UNKNOWN: 'viewer',
  VIEWER_DUPLICATE: 'viewer',
  BROADCASTER_MISMATCH: 'broadcast',
  TIME_INVALID: 'datetime',
  TIME_ORDER: 'datetime',
  TIME_OUT_OF_RANGE: 'range',
  TIME_OUTSIDE_BATCH: 'range',
  EVIDENCE_TOO_MANY: 'size',
  VERSION_CONFIRM_REQUIRED: 'version',
  RESULT_EMPTY: 'none',
  EVIDENCE_PURGED: 'none',
  EVIDENCE_DELETED: 'none',
  LOCALE_MISMATCH: 'none',
  BROADCASTER_UNVERIFIED: 'broadcast',
  LEGACY_PACKAGE: 'none',
  BATCH_ID_MISSING: 'batch',
  SESSION_SCHEMA_REQUIRED: 'version',
  MEMORY_SCHEMA_REQUIRED: 'version',
  ANALYSIS_SCOPE_MISMATCH: 'version',
  SESSION_TOPICS_REQUIRED: 'missing',
  SESSION_MEMORY_FORBIDDEN: 'version',
  MEMORY_PROFILES_FORBIDDEN: 'version'
});

function issue(severity, path, code, params = {}) {
  return {severity, path, code, params, fixGroup: FIX_GROUPS[code] ?? 'none'};
}

export function parseImportText(text, {maxBytes = MAX_IMPORT_BYTES} = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return {errors: [issue('error', '', 'EMPTY_INPUT')], value: null, fenced: false};
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return {
      errors: [issue('error', '', 'TOO_LARGE', {bytes, limit: maxBytes})],
      value: null,
      fenced: false
    };
  }
  let source = text.replace(/^\uFEFF/, '').trim();
  let fenced = false;
  // Accept one Markdown code fence because chat UIs often add it, but never try
  // to dig JSON out of arbitrary prose: everything must still pass the schema.
  if (source.startsWith('```')) {
    const match = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(source);
    if (match) {
      source = match[1];
      fenced = true;
    }
  }
  try {
    const value = JSON.parse(source);
    return {errors: [], value, fenced, bytes};
  } catch (error) {
    return {
      errors: [issue('error', '', 'INVALID_JSON', {message: String(error?.message ?? '').slice(0, 160)})],
      value: null,
      fenced,
      bytes
    };
  }
}

/** Canonical JSON (sorted keys) used for duplicate detection. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function checksumOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function cleanText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function cleanStringArray(value) {
  return Array.isArray(value) ? value.map(cleanText) : [];
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => {
    if (typeof ref === 'number') return Math.trunc(ref);
    return {batch: Math.trunc(Number(ref?.batch)), seq: Math.trunc(Number(ref?.seq))};
  });
}

/** Build the only object that is ever persisted: an explicit field allow-list. */
export function sanitizeResult(parsed, {schemaVersion}) {
  const topics = parsed?.session_topics ?? {};
  return {
    protocol: RESULT_PROTOCOL,
    schema_version: schemaVersion,
    ...(typeof parsed.job_id === 'string' ? {job_id: cleanText(parsed.job_id)} : {}),
    ...(typeof parsed.batch_id === 'string' ? {batch_id: cleanText(parsed.batch_id)} : {}),
    ...(Object.prototype.hasOwnProperty.call(parsed, 'broadcaster_id')
      ? {broadcaster_id: parsed.broadcaster_id === null ? null : cleanText(parsed.broadcaster_id)}
      : {}),
    task_id: cleanText(parsed.task_id),
    session_id: cleanText(parsed.session_id),
    locale: parsed.locale,
    ...(typeof parsed.analysis_scope === 'string' ? {analysis_scope: parsed.analysis_scope} : {}),
    session_topics: {
      summary: cleanText(topics.summary ?? ''),
      topics: (topics.topics ?? []).map((topic) => ({
        title: cleanText(topic.title),
        started_at: topic.started_at,
        ended_at: topic.ended_at,
        summary: cleanText(topic.summary ?? ''),
        key_points: cleanStringArray(topic.key_points),
        confidence: Number(topic.confidence),
        evidence: topic.evidence,
        ...(Array.isArray(topic.message_refs) ? {message_refs: normalizeRefs(topic.message_refs)} : {})
      })),
      sentiment: (topics.sentiment ?? []).map((entry) => ({
        at: entry.at,
        tone: entry.tone,
        note: cleanText(entry.note ?? ''),
        confidence: Number(entry.confidence),
        ...(entry.sample_size !== undefined ? {sample_size: Number(entry.sample_size)} : {}),
        ...(typeof entry.evidence_note === 'string' ? {evidence_note: cleanText(entry.evidence_note)} : {})
      })),
      disputes: (topics.disputes ?? []).map((entry) => ({
        summary: cleanText(entry.summary ?? ''),
        started_at: entry.started_at,
        ...(typeof entry.title === 'string' ? {title: cleanText(entry.title)} : {}),
        ...(typeof entry.ended_at === 'string' ? {ended_at: entry.ended_at} : {}),
        note: cleanText(entry.note ?? ''),
        ...(Array.isArray(entry.viewpoints) ? {viewpoints: cleanStringArray(entry.viewpoints)} : {}),
        confidence: Number(entry.confidence),
        ...(entry.evidence !== undefined ? {evidence: entry.evidence} : {}),
        ...(Array.isArray(entry.message_refs) ? {message_refs: normalizeRefs(entry.message_refs)} : {})
      })),
      highlights: (topics.highlights ?? []).map((entry) => ({
        started_at: entry.started_at,
        ended_at: entry.ended_at,
        ...(typeof entry.title === 'string' ? {title: cleanText(entry.title)} : {}),
        reason: cleanText(entry.reason ?? ''),
        clip_suggestion: cleanText(entry.clip_suggestion ?? ''),
        ...(entry.confidence !== undefined ? {confidence: Number(entry.confidence)} : {}),
        ...(entry.evidence !== undefined ? {evidence: entry.evidence} : {}),
        ...(Array.isArray(entry.message_refs) ? {message_refs: normalizeRefs(entry.message_refs)} : {})
      }))
    },
    viewer_profiles: (parsed.viewer_profiles ?? []).map((profile) => ({
      viewer_id: cleanText(profile.viewer_id),
      interests: (profile.interests ?? []).map((entry) => ({
        topic: cleanText(entry.topic),
        strength: entry.strength,
        evidence: entry.evidence,
        note: cleanText(entry.note ?? '')
      })),
      dislikes: (profile.dislikes ?? []).map((entry) => ({
        topic: cleanText(entry.topic),
        evidence: entry.evidence,
        note: cleanText(entry.note ?? '')
      })),
      summary: cleanText(profile.summary ?? ''),
      confidence: Number(profile.confidence)
    })),
    viewer_memory_updates: (parsed.viewer_memory_updates ?? []).map((entry) => ({
      viewer_id: cleanText(entry.viewer_id),
      ...(typeof entry.summary === 'string' ? {summary: cleanText(entry.summary)} : {}),
      ...(entry.summary_certainty !== undefined ? {summary_certainty: entry.summary_certainty} : {}),
      no_new_information: entry.no_new_information === true,
      operations: (entry.operations ?? []).map((operation) => ({
        op: operation.op,
        ...(operation.kind ? {kind: operation.kind} : {}),
        ...(operation.topic !== undefined ? {topic: cleanText(operation.topic)} : {}),
        ...(operation.statement !== undefined ? {statement: cleanText(operation.statement)} : {}),
        ...(operation.certainty ? {certainty: operation.certainty} : {}),
        ...(operation.confidence !== undefined ? {confidence: Number(operation.confidence)} : {}),
        ...(operation.target_fact_id ? {target_fact_id: cleanText(operation.target_fact_id)} : {}),
        ...(operation.reason ? {reason: cleanText(operation.reason)} : {}),
        ...(operation.valid_from ? {valid_from: operation.valid_from} : {}),
        ...(operation.valid_until ? {valid_until: operation.valid_until} : {}),
        ...(Array.isArray(operation.evidence) ? {evidence: normalizeRefs(operation.evidence)} : {})
      }))
    }))
  };
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

function timestamp(value, path, {windowStart, windowEnd, issues, warnings, batch}) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issues.push(issue('error', path, 'TIME_INVALID', {actual: String(value).slice(0, 64)}));
    return null;
  }
  if (parsed < windowStart || parsed > windowEnd) {
    issues.push(issue('error', path, 'TIME_OUT_OF_RANGE', {
      min: isoFromEpochMs(windowStart),
      max: isoFromEpochMs(windowEnd)
    }));
  } else if (batch && batch.fromAt && batch.toAt) {
    const slack = 10 * 60 * 1000;
    if (parsed < batch.fromAt - slack || parsed > batch.toAt + slack) {
      warnings.push(issue('warning', path, 'TIME_OUTSIDE_BATCH', {
        batch: batch.batchIndex,
        min: isoFromEpochMs(batch.fromAt),
        max: isoFromEpochMs(batch.toAt)
      }));
    }
  }
  return parsed;
}

function collectRefs(container, section, itemIndex) {
  if (!Array.isArray(container?.message_refs)) return [];
  return container.message_refs.map((ref, refIndex) => ({
    section,
    itemIndex,
    refIndex,
    path: `session_topics.${section}[${itemIndex}].message_refs[${refIndex}]`,
    ref
  }));
}

/**
 * Validate an AI answer against the live database.
 *
 * Returns a preview (never writes) with blocking errors, non-blocking warnings,
 * exact field paths, duplicate/version information and the sanitised result that
 * `importAnalysisResult` would persist.
 */
export function validateAnalysisImport({db, text, source = 'paste', now = Date.now()}) {
  const parsedInput = parseImportText(text);
  const issues = [...parsedInput.errors];
  const warnings = [];
  const payload = parsedInput.value;
  const target = {
    session: null,
    job: null,
    batch: null,
    mode: null,
    protocol: null,
    schemaVersion: null,
    analysisScope: null,
    analysisMode: null,
    locale: null,
    taskId: null,
    taskKind: null,
    coverage: null,
    missingBatches: [],
    alreadyImported: false,
    duplicate: null,
    requiresVersionConfirm: false,
    legacy: false
  };
  const empty = {
    ok: false,
    action: 'blocked',
    errors: issues,
    warnings,
    target,
    sanitized: null,
    evidenceRows: [],
    checksum: null,
    scopeKey: null,
    batchIndex: null,
    job: null,
    legacyCreate: null,
    memory: null,
    source
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    if (issues.length === 0) issues.push(issue('error', '', 'NOT_OBJECT'));
    return empty;
  }

  const schemaVersion = typeof payload.schema_version === 'string' ? payload.schema_version : '1.0.0';
  target.protocol = typeof payload.protocol === 'string' ? payload.protocol : null;
  target.schemaVersion = schemaVersion;
  target.analysisScope = typeof payload.analysis_scope === 'string' ? payload.analysis_scope : null;
  target.locale = typeof payload.locale === 'string' ? payload.locale : null;
  target.taskId = typeof payload.task_id === 'string' ? payload.task_id : null;

  // 1. JSON Schema (structure, types, enums, ranges, ref shapes).
  const schemaToUse = schemaVersion === '1.3.0' ? '1.3.0' : '1.2.0';
  for (const schemaError of validateAgainstSchema(loadResultSchema(schemaToUse), payload)) {
    issues.push(issue('error', schemaError.path, schemaError.code, schemaError.params));
  }
  if (payload.schema_version !== undefined && !ACCEPTED_RESULT_SCHEMA_VERSIONS.includes(payload.schema_version)) {
    issues.push(issue('error', 'schema_version', 'SCHEMA_VERSION_UNSUPPORTED', {
      actual: String(payload.schema_version),
      accepted: ACCEPTED_RESULT_SCHEMA_VERSIONS.join(', ')
    }));
  }
  if (payload.protocol !== RESULT_PROTOCOL) {
    issues.push(issue('error', 'protocol', 'PROTOCOL_MISMATCH', {
      expected: RESULT_PROTOCOL,
      actual: String(payload.protocol ?? '')
    }));
  }
  if (!SUPPORTED_LOCALES.includes(payload.locale)) {
    // Already reported by the schema enum; this keeps the target readable.
    target.locale = null;
  }

  // 2. Resolve the session and job the answer claims to belong to.
  let job = null;
  let session = null;
  let legacy = false;
  let legacyNeedsCreate = false;
  if (typeof payload.job_id === 'string' && payload.job_id.trim() !== '') {
    job = getJob(db, payload.job_id.trim());
    if (!job) {
      issues.push(issue('error', 'job_id', 'JOB_NOT_FOUND', {jobId: payload.job_id.trim()}));
    }
  } else if (typeof payload.session_id === 'string' && payload.session_id.trim() !== '') {
    // Pre-M6 package: no job id. Reuse an earlier legacy job for this session so
    // re-importing the same answer is still detected as a duplicate.
    const candidates = listJobs(db, {sessionId: payload.session_id.trim(), limit: 50}).filter((row) => row.legacy);
    job = candidates[0] ?? null;
    if (!job) legacyNeedsCreate = true;
    legacy = true;
  } else {
    issues.push(issue('error', 'session_id', 'SESSION_NOT_FOUND', {}));
  }

  if (job) {
    session = getSession(db, job.sessionId);
  } else if (typeof payload.session_id === 'string') {
    session = getSession(db, payload.session_id.trim());
  }
  if (!session) {
    if (!issues.some((item) => item.code === 'SESSION_NOT_FOUND')) {
      issues.push(issue('error', 'session_id', 'SESSION_NOT_FOUND', {sessionId: String(payload.session_id ?? '')}));
    }
    return {...empty, errors: dedupeIssues(issues), warnings, sanitized: null, job: null};
  }
  target.session = {
    id: session.id,
    platform: session.platform,
    roomTitle: session.room_title,
    broadcasterName: session.broadcaster_name,
    broadcasterId: session.broadcaster_id ?? null,
    broadcasterIdentity: session.broadcaster_identity ?? 'unresolved',
    startedAt: session.started_at,
    endedAt: session.ended_at,
    archived: session.archived_at !== null && session.archived_at !== undefined,
    simulated: session.simulated === 1
  };
  if (job && payload.session_id !== job.sessionId) {
    issues.push(issue('error', 'session_id', 'SESSION_MISMATCH', {
      expected: job.sessionId,
      actual: String(payload.session_id ?? '')
    }));
  }
  if (!job && !legacyNeedsCreate && payload.job_id) {
    return {...empty, errors: dedupeIssues(issues), warnings, target};
  }

  // 3. Resolve the batch (or the aggregate/final scope).
  const jobBatches = job ? listJobBatches(db, job.id) : [];
  const wantsAggregate = Boolean(job && job.batchTotal > 1
    && (String(payload.task_id).endsWith('-analysis-final')
      || (job.aggregateTaskId && payload.task_id === job.aggregateTaskId)));
  let batch = null;
  let mode = 'batch';
  let missingBatches = [];
  if (wantsAggregate) {
    mode = 'aggregate';
    const latestByBatch = new Map();
    for (const row of db.prepare('SELECT batch_index, MAX(result_version) AS version FROM ai_results WHERE job_id = ? AND batch_index IS NOT NULL GROUP BY batch_index').all(job.id)) {
      latestByBatch.set(Number(row.batch_index), Number(row.version));
    }
    missingBatches = jobBatches.filter((entry) => !latestByBatch.has(entry.batchIndex)).map((entry) => entry.batchIndex);
    if (missingBatches.length > 0) {
      issues.push(issue('error', '', 'AGGREGATE_NOT_READY', {missing: missingBatches.join(', ')}));
    }
    const expectedTask = job.aggregateTaskId ?? `${session.id}-analysis-final`;
    if (payload.task_id !== expectedTask) {
      issues.push(issue('error', 'task_id', 'TASK_MISMATCH', {expected: expectedTask, actual: String(payload.task_id ?? '')}));
    }
    target.taskKind = TASK_KIND.SESSION_AGGREGATE;
  } else if (job) {
    if (typeof payload.batch_id === 'string' && payload.batch_id.trim() !== '') {
      batch = getJobBatchById(db, job.id, payload.batch_id.trim());
      if (!batch) {
        issues.push(issue('error', 'batch_id', 'BATCH_MISMATCH', {batchId: payload.batch_id.trim()}));
      }
    } else {
      batch = jobBatches.find((entry) => entry.taskId === payload.task_id) ?? null;
      if (!batch) {
        if (job.batchTotal === 1) {
          batch = jobBatches[0] ?? null;
        } else {
          issues.push(issue('error', 'batch_id', 'BATCH_MISSING', {batches: job.batchTotal}));
        }
      } else if (!payload.batch_id) {
        // Resolved by task_id. This is unambiguous because task ids are unique
        // per batch inside one job.
        warnings.push(issue('warning', 'batch_id', 'BATCH_ID_MISSING', {batchId: batch.batchId}));
      }
    }
    if (batch && payload.task_id !== batch.taskId) {
      // A pre-M6 package advertised two task ids (`-topics` and `-viewers`) for
      // the same JSON answer. Keep both acceptable for legacy jobs only.
      const legacyIds = job.legacy
        ? [`${session.id}-topics`, `${session.id}-viewers`, `${session.id}-analysis`]
        : [];
      if (!legacyIds.includes(payload.task_id)) {
        issues.push(issue('error', 'task_id', 'TASK_MISMATCH', {
          expected: batch.taskId,
          actual: String(payload.task_id ?? '')
        }));
      }
    }
    target.taskKind = TASK_KIND.SESSION_ANALYSIS;
  } else {
    // Legacy whole-session package.
    const expectedTasks = [
      `${session.id}-topics`,
      `${session.id}-viewers`,
      `${session.id}-analysis`,
      `${session.id}-analysis-final`
    ];
    if (!expectedTasks.includes(payload.task_id)) {
      issues.push(issue('error', 'task_id', 'TASK_MISMATCH', {
        expected: `${session.id}-topics`,
        actual: String(payload.task_id ?? '')
      }));
    }
    legacy = true;
    warnings.push(issue('warning', '', 'LEGACY_PACKAGE', {}));
    mode = 'batch';
    target.taskKind = TASK_KIND.LEGACY_TOPICS;
    const totalMessages = countSessionMessages(db, session.id);
    if (totalMessages === 0) {
      issues.push(issue('error', '', 'SESSION_EMPTY', {}));
      return {...empty, errors: dedupeIssues(issues), warnings, target};
    }
    const rows = listSessionMessagesAsc(db, {sessionId: session.id, limit: totalMessages});
    batch = {
      jobId: null,
      batchIndex: 1,
      batchId: null,
      taskId: payload.task_id,
      fromSeq: 1,
      toSeq: totalMessages,
      fromAt: rows[0]?.occurred_at ?? session.started_at,
      toAt: rows[rows.length - 1]?.occurred_at ?? session.ended_at ?? now,
      messageCount: totalMessages,
      checksum: null,
      packageId: null,
      createdAt: now,
      eventIds: rows.map((row) => row.id),
      viewers: listSessionViewers(db, session.id, {limit: 2000}).map((viewer) => viewer.viewer_id)
    };
    target.legacy = true;
  }

  target.job = job
    ? {
      id: job.id,
      batchTotal: job.batchTotal,
      promptVersion: job.promptVersion,
      locale: job.locale,
      legacy: job.legacy,
      totalMessages: job.totalMessages,
      aggregatePackageId: job.aggregatePackageId,
      analysisMode: job.analysisMode ?? 'combined'
    }
    : (legacyNeedsCreate
      ? {
        id: null,
        batchTotal: 1,
        promptVersion: null,
        locale: null,
        legacy: true,
        totalMessages: batch?.messageCount ?? 0,
        aggregatePackageId: null,
        analysisMode: 'combined'
      }
      : null);
  target.analysisMode = job?.analysisMode ?? 'combined';
  if (job?.analysisMode === ANALYSIS_MODE.MEMORY) {
    target.taskKind = TASK_KIND.VIEWER_MEMORY;
  }

  // v0.13 mode boundary. A session-only job must not bring long-term memory
  // updates, and a memory-only job must not try to replace the session report.
  if (job) {
    if (job.analysisMode === ANALYSIS_MODE.SESSION && schemaVersion !== '1.3.0') {
      issues.push(issue('error', 'schema_version', 'SESSION_SCHEMA_REQUIRED', {expected: '1.3.0'}));
    }
    if (job.analysisMode === ANALYSIS_MODE.MEMORY && schemaVersion !== '1.3.0') {
      issues.push(issue('error', 'schema_version', 'MEMORY_SCHEMA_REQUIRED', {expected: '1.3.0'}));
    }
    if (schemaVersion === '1.3.0') {
      const expectedScope = job.analysisMode === ANALYSIS_MODE.SESSION
        ? 'session'
        : (job.analysisMode === ANALYSIS_MODE.MEMORY ? 'viewer_memory' : null);
      if (!expectedScope) {
        issues.push(issue('error', 'analysis_scope', 'ANALYSIS_SCOPE_MISMATCH', {
          actual: String(payload.analysis_scope ?? ''),
          mode: job.analysisMode
        }));
      } else if (payload.analysis_scope !== expectedScope) {
        issues.push(issue('error', 'analysis_scope', 'ANALYSIS_SCOPE_MISMATCH', {
          expected: expectedScope,
          actual: String(payload.analysis_scope ?? '')
        }));
      }
      if (payload.analysis_scope === 'session') {
        if (!payload.session_topics || typeof payload.session_topics !== 'object') {
          issues.push(issue('error', 'session_topics', 'SESSION_TOPICS_REQUIRED', {}));
        }
        if (Array.isArray(payload.viewer_memory_updates) && payload.viewer_memory_updates.length > 0) {
          issues.push(issue('error', 'viewer_memory_updates', 'SESSION_MEMORY_FORBIDDEN', {}));
        }
      }
      if (payload.analysis_scope === 'viewer_memory'
        && !Array.isArray(payload.viewer_memory_updates)) {
        issues.push(issue('error', 'viewer_memory_updates', 'MEMORY_UPDATES_REQUIRED', {}));
      }
      if (payload.analysis_scope === 'viewer_memory'
        && Array.isArray(payload.viewer_profiles)
        && payload.viewer_profiles.length > 0) {
        issues.push(issue('error', 'viewer_profiles', 'MEMORY_PROFILES_FORBIDDEN', {}));
      }
    }
  }
  if (batch) {
    target.batch = {
      index: batch.batchIndex,
      batchIndex: batch.batchIndex,
      batchId: batch.batchId,
      taskId: batch.taskId,
      fromSeq: batch.fromSeq,
      toSeq: batch.toSeq,
      messageCount: batch.messageCount,
      fromAt: batch.fromAt,
      toAt: batch.toAt
    };
    target.coverage = {
      fromSeq: batch.fromSeq,
      toSeq: batch.toSeq,
      messageCount: batch.messageCount,
      fromAt: batch.fromAt,
      toAt: batch.toAt
    };
  }
  target.mode = mode;
  target.missingBatches = missingBatches;

  // A missing/ambiguous batch makes every evidence reference meaningless. Stop
  // before semantic checks so the user sees the real cause, not a cascade.
  if (mode === 'batch' && !batch) {
    return {...empty, errors: dedupeIssues(issues), warnings, target};
  }

  // 4. Broadcaster identity must match the job/session snapshot.
  if (Object.prototype.hasOwnProperty.call(payload, 'broadcaster_id') && payload.broadcaster_id !== null) {
    const expected = job ? job.broadcasterId : (session.broadcaster_id ?? null);
    if (expected && payload.broadcaster_id !== expected) {
      issues.push(issue('error', 'broadcaster_id', 'BROADCASTER_MISMATCH', {
        expected,
        actual: String(payload.broadcaster_id)
      }));
    } else if (!expected) {
      warnings.push(issue('warning', 'broadcaster_id', 'BROADCASTER_UNVERIFIED', {}));
    }
  }
  if (job && target.locale && job.locale !== payload.locale) {
    warnings.push(issue('warning', 'locale', 'LOCALE_MISMATCH', {expected: job.locale, actual: payload.locale}));
  }

  // 5. Time window and evidence references.
  const windowStart = Math.min(session.started_at, session.platform_started_at ?? session.started_at) - 10 * 60 * 1000;
  const windowEnd = (session.ended_at ?? now) + 10 * 60 * 1000;
  const timeOptions = {windowStart, windowEnd, issues, warnings, batch: mode === 'batch' ? batch : null};
  const topics = payload.session_topics ?? {};
  const evidenceRows = [];
  let evidenceCount = 0;
  const addRefs = (item, section, itemIndex) => {
    for (const entry of collectRefs(item, section, itemIndex)) {
      evidenceCount += 1;
      if (evidenceCount > MAX_REPORT_EVIDENCE * 50) {
        issues.push(issue('error', entry.path, 'EVIDENCE_TOO_MANY', {limit: MAX_REPORT_EVIDENCE * 50}));
        continue;
      }
      let batchIndex = null;
      let seq = null;
      if (typeof entry.ref === 'number') {
        seq = Math.trunc(entry.ref);
        if (mode === 'aggregate' && job && job.batchTotal > 1) {
          issues.push(issue('error', entry.path, 'REF_AMBIGUOUS', {}));
          continue;
        }
        batchIndex = mode === 'aggregate' ? 1 : batch.batchIndex;
      } else {
        batchIndex = Math.trunc(Number(entry.ref?.batch));
        seq = Math.trunc(Number(entry.ref?.seq));
        if (mode !== 'aggregate') {
          if (batchIndex !== batch.batchIndex) {
            issues.push(issue('error', entry.path, 'REF_OTHER_BATCH', {
              expected: batch.batchIndex,
              actual: batchIndex
            }));
            continue;
          }
        } else {
          const match = jobBatches.find((row) => row.batchIndex === batchIndex);
          if (!match) {
            issues.push(issue('error', entry.path, 'REF_OTHER_BATCH', {
              expected: jobBatches.map((row) => row.batchIndex).join(', '),
              actual: batchIndex
            }));
            continue;
          }
        }
      }
      const targetBatch = mode === 'aggregate'
        ? jobBatches.find((row) => row.batchIndex === batchIndex)
        : batch;
      if (!targetBatch || seq < 1 || seq > targetBatch.messageCount) {
        issues.push(issue('error', entry.path, 'MESSAGE_REF_UNKNOWN', {
          seq,
          batch: batchIndex,
          max: targetBatch?.messageCount ?? 0
        }));
        continue;
      }
      let eventId;
      if (job) {
        eventId = getJobMessageEventId(db, job.id, batchIndex, seq);
        if (eventId === null) {
          issues.push(issue('error', entry.path, 'MESSAGE_REF_UNKNOWN', {
            seq,
            batch: batchIndex,
            max: targetBatch.messageCount
          }));
          continue;
        }
      } else {
        eventId = batch.eventIds?.[seq - 1] ?? null;
        if (eventId === null) {
          issues.push(issue('error', entry.path, 'MESSAGE_REF_UNKNOWN', {
            seq,
            batch: batchIndex,
            max: targetBatch?.messageCount ?? 0
          }));
          continue;
        }
      }
      const eventRow = getEventById(db, eventId);
      const available = Boolean(eventRow);
      if (!available) {
        warnings.push(issue('warning', entry.path, 'EVIDENCE_DELETED', {seq, batch: batchIndex}));
      } else if (eventRow.content === null && eventRow.content_purged_at) {
        warnings.push(issue('warning', entry.path, 'EVIDENCE_PURGED', {seq, batch: batchIndex}));
      }
      evidenceRows.push({
        section,
        itemIndex,
        seq,
        batchIndex,
        eventId,
        available
      });
    }
  };

  if (Array.isArray(topics.topics)) {
    topics.topics.forEach((topic, index) => {
      const started = timestamp(topic?.started_at, `session_topics.topics[${index}].started_at`, timeOptions);
      const ended = timestamp(topic?.ended_at, `session_topics.topics[${index}].ended_at`, timeOptions);
      if (started !== null && ended !== null && ended < started) {
        issues.push(issue('error', `session_topics.topics[${index}].ended_at`, 'TIME_ORDER', {}));
      }
      addRefs(topic, 'topics', index);
    });
  }
  if (Array.isArray(topics.sentiment)) {
    topics.sentiment.forEach((entry, index) => {
      timestamp(entry?.at, `session_topics.sentiment[${index}].at`, timeOptions);
    });
  }
  if (Array.isArray(topics.disputes)) {
    topics.disputes.forEach((entry, index) => {
      const started = timestamp(entry?.started_at, `session_topics.disputes[${index}].started_at`, timeOptions);
      const ended = entry?.ended_at ? timestamp(entry.ended_at, `session_topics.disputes[${index}].ended_at`, timeOptions) : null;
      if (started !== null && ended !== null && ended < started) {
        issues.push(issue('error', `session_topics.disputes[${index}].ended_at`, 'TIME_ORDER', {}));
      }
      addRefs(entry, 'disputes', index);
    });
  }
  if (Array.isArray(topics.highlights)) {
    topics.highlights.forEach((entry, index) => {
      const started = timestamp(entry?.started_at, `session_topics.highlights[${index}].started_at`, timeOptions);
      const ended = timestamp(entry?.ended_at, `session_topics.highlights[${index}].ended_at`, timeOptions);
      if (started !== null && ended !== null && ended < started) {
        issues.push(issue('error', `session_topics.highlights[${index}].ended_at`, 'TIME_ORDER', {}));
      }
      addRefs(entry, 'highlights', index);
    });
  }

  // 6. Viewer profiles must resolve to identities really present in this batch.
  let allowedViewerIds = null;
  if (job) {
    if (job.analysisMode === ANALYSIS_MODE.SESSION) {
      // A session report is allowed to mention only participants of this session;
      // it still cannot create or modify long-term memory.
      allowedViewerIds = new Set(listSessionViewers(db, session.id, {limit: 20000})
        .map((viewer) => viewer.viewer_id));
    } else if (job.analysisMode === ANALYSIS_MODE.MEMORY) {
      allowedViewerIds = null;
    } else {
      allowedViewerIds = mode === 'aggregate'
        ? new Set(listAllJobViewerIds(db, job.id))
        : new Set(listJobViewerIds(db, job.id, batch.batchIndex));
    }
  } else if (batch?.viewers) {
    allowedViewerIds = new Set(batch.viewers);
  }
  if (Array.isArray(payload.viewer_profiles) && allowedViewerIds) {
    const seen = new Set();
    payload.viewer_profiles.forEach((profile, index) => {
      const viewerId = profile?.viewer_id;
      if (seen.has(viewerId)) {
        issues.push(issue('error', `viewer_profiles[${index}].viewer_id`, 'VIEWER_DUPLICATE', {viewerId}));
        return;
      }
      seen.add(viewerId);
      if (!allowedViewerIds.has(viewerId)) {
        issues.push(issue('error', `viewer_profiles[${index}].viewer_id`, 'VIEWER_UNKNOWN', {viewerId}));
      }
    });
  }

  // 7. Long-term memory updates travel in the same answer. Every viewer
  // assigned to this batch must be covered exactly once; objective history is
  // applied by the importer even when there is no new semantic information.
  const memory = (mode === 'batch' && batch && (job?.analysisMode ?? 'combined') !== ANALYSIS_MODE.SESSION)
    ? validateEmbeddedMemoryUpdates({
      db,
      job,
      batch,
      session,
      payload,
      schemaVersion,
      mode,
      now
    })
    : (mode === 'aggregate'
      ? validateEmbeddedMemoryUpdates({db, job, batch: null, session, payload, schemaVersion, mode, now})
      : null);
  if (memory) {
    for (const item of memory.errors) issues.push(item);
    for (const item of memory.warnings) warnings.push(item);
    target.memory = {
      ok: memory.ok,
      legacy: memory.legacy,
      coverage: memory.coverage,
      totals: memory.totals,
      viewerCount: memory.viewers.length,
      plan: memory.plan,
      gaps: memory.gaps ?? {missing: [], unknown: [], duplicate: []}
    };
  }

  const hasContent = (topics.topics?.length ?? 0) > 0
    || (topics.disputes?.length ?? 0) > 0
    || (topics.highlights?.length ?? 0) > 0
    || (payload.viewer_profiles?.length ?? 0) > 0
    || (payload.viewer_memory_updates ?? []).some((entry) => (entry?.operations?.length ?? 0) > 0)
    || (topics.summary ?? '').trim() !== '';
  if (!hasContent) {
    warnings.push(issue('warning', '', 'RESULT_EMPTY', {}));
  }

  const sanitized = sanitizeResult(payload, {schemaVersion});
  const checksum = checksumOf(sanitized);
  const scopeKey = mode === 'aggregate' ? 'final' : `batch:${batch?.batchIndex ?? 1}`;
  const batchIndex = mode === 'aggregate' ? null : (batch?.batchIndex ?? 1);
  target.alreadyImported = false;

  const errors = dedupeIssues(issues.filter((item) => item.severity === 'error'));
  const warningList = dedupeIssues(warnings);

  if (errors.length > 0) {
    return {
      ok: false,
      action: 'blocked',
      errors,
      warnings: warningList,
      target,
      sanitized,
      evidenceRows,
      checksum,
      scopeKey,
      batchIndex,
      taskKind: target.taskKind,
      job,
      session,
      batch,
      memory,
      legacyCreate: legacyNeedsCreate
        ? {sessionId: session.id, batch, messageCount: batch?.messageCount ?? 0}
        : null,
      source
    };
  }

  let duplicate = null;
  let requiresVersionConfirm = false;
  let latestVersion = null;
  if (job) {
    duplicate = findResultByChecksum(db, job.id, scopeKey, checksum);
    if (!duplicate) {
      const latest = latestResultForScope(db, job.id, scopeKey);
      requiresVersionConfirm = Boolean(latest);
      latestVersion = latest?.resultVersion ?? null;
    }
  }
  target.duplicate = duplicate
    ? {id: duplicate.id, resultVersion: duplicate.resultVersion, importedAt: duplicate.importedAt}
    : null;
  target.alreadyImported = Boolean(duplicate);
  target.requiresVersionConfirm = requiresVersionConfirm;
  target.latestVersion = latestVersion;
  const action = duplicate ? 'duplicate' : (requiresVersionConfirm ? 'confirm_version' : 'import');

  return {
    ok: true,
    action,
    errors: [],
    warnings: warningList,
    target,
    sanitized,
    evidenceRows,
    checksum,
    scopeKey,
    batchIndex,
    taskKind: target.taskKind,
    job,
    session,
    batch,
    memory,
    legacyCreate: legacyNeedsCreate
      ? {sessionId: session.id, batch, messageCount: batch?.messageCount ?? 0}
      : null,
    source
  };
}

export const __internal = {cleanText, normalizeRefs, FIX_GROUPS, timestamp};
