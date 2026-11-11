/**
 * AI analysis jobs.
 *
 * A job binds one recorded session to one prompt version and one or more
 * message batches. It never stores AI output itself: results live in
 * `ai_results` and reference this job. Deleting a session cascades through
 * jobs, batches, message maps and results, so no orphan analysis survives a
 * deleted broadcast.
 */

function parseJson(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    broadcasterId: row.broadcaster_id ?? null,
    kind: row.kind,
    locale: row.locale,
    promptVersion: row.prompt_version,
    protocolVersion: row.protocol_version,
    batchTotal: Number(row.batch_total ?? 1),
    maxMessages: Number(row.max_messages ?? 0),
    totalMessages: Number(row.total_messages ?? 0),
    memoryViewersTotal: Number(row.memory_viewers_total ?? 0),
    analysisMode: row.analysis_mode ?? 'combined',
    providerConfigId: row.provider_config_id ?? null,
    providerId: row.provider_id ?? null,
    regionId: row.region_id ?? null,
    modelId: row.model_id ?? null,
    pricingStatus: row.pricing_status ?? null,
    budget: parseJson(row.budget_json),
    costEstimate: parseJson(row.cost_estimate_json),
    usage: parseJson(row.usage_json),
    requestedBy: row.requested_by ?? null,
    legacy: row.legacy === 1,
    aggregatePackageId: row.aggregate_package_id ?? null,
    aggregateTaskId: row.aggregate_task_id ?? null,
    lastErrorAt: row.last_error_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorJson: row.last_error_json ?? null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    batchIndex: Number(row.batch_index),
    batchId: row.batch_id,
    taskId: row.task_id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    fromAt: row.from_at === null || row.from_at === undefined ? null : Number(row.from_at),
    toAt: row.to_at === null || row.to_at === undefined ? null : Number(row.to_at),
    messageCount: Number(row.message_count),
    checksum: row.checksum,
    packageId: row.package_id ?? null,
    createdAt: Number(row.created_at ?? 0)
  };
}

export function insertJob(db, {
  id,
  sessionId,
  broadcasterId = null,
  kind = 'session_analysis',
  locale,
  promptVersion,
  protocolVersion,
  batchTotal = 1,
  maxMessages = 1000,
  totalMessages = 0,
  memoryViewersTotal = 0,
  analysisMode = 'combined',
  providerConfigId = null,
  providerId = null,
  regionId = null,
  modelId = null,
  pricingStatus = null,
  budget = null,
  costEstimate = null,
  usage = null,
  requestedBy = null,
  legacy = false,
  aggregateTaskId = null,
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO ai_jobs (
      id, session_id, broadcaster_id, kind, locale, prompt_version, protocol_version,
      batch_total, max_messages, total_messages, memory_viewers_total, legacy, aggregate_task_id,
      analysis_mode, provider_config_id, provider_id, region_id, model_id, pricing_status,
      budget_json, cost_estimate_json, usage_json, requested_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(id),
    String(sessionId),
    broadcasterId === null || broadcasterId === undefined ? null : String(broadcasterId),
    String(kind),
    String(locale),
    String(promptVersion),
    String(protocolVersion),
    Number(batchTotal),
    Number(maxMessages),
    Number(totalMessages),
    Number(memoryViewersTotal),
    legacy ? 1 : 0,
    aggregateTaskId === null || aggregateTaskId === undefined ? null : String(aggregateTaskId),
    String(analysisMode ?? 'combined'),
    providerConfigId === null || providerConfigId === undefined ? null : String(providerConfigId),
    providerId === null || providerId === undefined ? null : String(providerId),
    regionId === null || regionId === undefined ? null : String(regionId),
    modelId === null || modelId === undefined ? null : String(modelId),
    pricingStatus === null || pricingStatus === undefined ? null : String(pricingStatus),
    budget ? JSON.stringify(budget) : null,
    costEstimate ? JSON.stringify(costEstimate) : null,
    usage ? JSON.stringify(usage) : null,
    requestedBy === null || requestedBy === undefined ? null : String(requestedBy),
    Number(createdAt),
    Number(createdAt)
  );
  return getJob(db, id);
}

export function getJob(db, jobId) {
  return mapJob(db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(String(jobId)));
}

export function listJobs(db, {sessionId = null, limit = 50} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (sessionId) {
    return db.prepare('SELECT * FROM ai_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(sessionId), safeLimit).map(mapJob);
  }
  return db.prepare('SELECT * FROM ai_jobs ORDER BY created_at DESC LIMIT ?')
    .all(safeLimit).map(mapJob);
}

export function touchJob(db, jobId, {now = Date.now()} = {}) {
  db.prepare('UPDATE ai_jobs SET updated_at = ? WHERE id = ?').run(Number(now), String(jobId));
}

export function setJobAggregatePackage(db, jobId, {packageId, taskId, now = Date.now()}) {
  db.prepare(`
    UPDATE ai_jobs
       SET aggregate_package_id = ?, aggregate_task_id = ?, updated_at = ?
     WHERE id = ?
  `).run(String(packageId), String(taskId), Number(now), String(jobId));
  return getJob(db, jobId);
}

/** Persist a failed import so the task state survives a restart. */
export function recordJobFailure(db, jobId, {
  code,
  errors = [],
  now = Date.now()
} = {}) {
  const capped = (Array.isArray(errors) ? errors : []).slice(0, 40).map((error) => ({
    path: typeof error?.path === 'string' ? error.path.slice(0, 300) : '',
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNKNOWN',
    params: error?.params && typeof error.params === 'object' ? error.params : null
  }));
  const json = JSON.stringify({at: now, code: String(code ?? 'IMPORT_INVALID'), errors: capped});
  db.prepare(`
    UPDATE ai_jobs
       SET last_error_at = ?, last_error_code = ?, last_error_json = ?, updated_at = ?
     WHERE id = ?
  `).run(Number(now), String(code ?? 'IMPORT_INVALID'), json, Number(now), String(jobId));
  return getJob(db, jobId);
}

export function clearJobFailure(db, jobId, {now = Date.now()} = {}) {
  db.prepare(`
    UPDATE ai_jobs
       SET last_error_at = NULL, last_error_code = NULL, last_error_json = NULL, updated_at = ?
     WHERE id = ?
  `).run(Number(now), String(jobId));
}

export function setJobUsage(db, jobId, usage, {costEstimate = null, now = Date.now()} = {}) {
  db.prepare(`
    UPDATE ai_jobs
       SET usage_json = ?, cost_estimate_json = COALESCE(?, cost_estimate_json), updated_at = ?
     WHERE id = ?
  `).run(
    usage ? JSON.stringify(usage) : null,
    costEstimate ? JSON.stringify(costEstimate) : null,
    Number(now),
    String(jobId)
  );
  return getJob(db, jobId);
}

export function setJobAnalysisMode(db, jobId, mode, {now = Date.now()} = {}) {
  db.prepare('UPDATE ai_jobs SET analysis_mode = ?, updated_at = ? WHERE id = ?')
    .run(String(mode), Number(now), String(jobId));
  return getJob(db, jobId);
}

export function insertJobBatch(db, {
  jobId,
  batchIndex,
  batchId,
  taskId,
  fromSeq,
  toSeq,
  fromAt = null,
  toAt = null,
  messageCount,
  checksum,
  packageId = null,
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO ai_job_batches (
      job_id, batch_index, batch_id, task_id, from_seq, to_seq, from_at, to_at,
      message_count, checksum, package_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(jobId),
    Number(batchIndex),
    String(batchId),
    String(taskId),
    Number(fromSeq),
    Number(toSeq),
    fromAt === null || fromAt === undefined ? null : Number(fromAt),
    toAt === null || toAt === undefined ? null : Number(toAt),
    Number(messageCount),
    String(checksum),
    packageId === null || packageId === undefined ? null : String(packageId),
    Number(createdAt)
  );
  return getJobBatch(db, jobId, batchIndex);
}

export function getJobBatch(db, jobId, batchIndex) {
  return mapBatch(
    db.prepare('SELECT * FROM ai_job_batches WHERE job_id = ? AND batch_index = ?')
      .get(String(jobId), Number(batchIndex))
  );
}

export function getJobBatchById(db, jobId, batchId) {
  return mapBatch(
    db.prepare('SELECT * FROM ai_job_batches WHERE job_id = ? AND batch_id = ?')
      .get(String(jobId), String(batchId))
  );
}

export function listJobBatches(db, jobId) {
  return db.prepare('SELECT * FROM ai_job_batches WHERE job_id = ? ORDER BY batch_index ASC')
    .all(String(jobId)).map(mapBatch);
}

export function insertJobMessages(db, jobId, batchIndex, entries) {
  const statement = db.prepare(`
    INSERT INTO ai_job_messages (job_id, batch_index, seq, event_id)
    VALUES (?, ?, ?, ?)
  `);
  for (const entry of entries) {
    statement.run(String(jobId), Number(batchIndex), Number(entry.seq), Number(entry.eventId));
  }
}

export function getJobMessageEventId(db, jobId, batchIndex, seq) {
  const row = db.prepare(`
    SELECT event_id FROM ai_job_messages
     WHERE job_id = ? AND batch_index = ? AND seq = ?
  `).get(String(jobId), Number(batchIndex), Number(seq));
  return row ? Number(row.event_id) : null;
}

export function countJobMessages(db, jobId, batchIndex) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ai_job_messages WHERE job_id = ? AND batch_index = ?
  `).get(String(jobId), Number(batchIndex))?.count ?? 0);
}

export function insertJobViewers(db, jobId, batchIndex, viewerIds) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO ai_job_viewers (job_id, batch_index, viewer_id)
    VALUES (?, ?, ?)
  `);
  for (const viewerId of viewerIds) {
    statement.run(String(jobId), Number(batchIndex), String(viewerId));
  }
}

export function listJobViewerIds(db, jobId, batchIndex) {
  return db.prepare(`
    SELECT viewer_id FROM ai_job_viewers
     WHERE job_id = ? AND batch_index = ?
     ORDER BY viewer_id ASC
  `).all(String(jobId), Number(batchIndex)).map((row) => row.viewer_id);
}

export function listAllJobViewerIds(db, jobId) {
  return db.prepare(`
    SELECT DISTINCT viewer_id FROM ai_job_viewers
     WHERE job_id = ?
     ORDER BY viewer_id ASC
  `).all(String(jobId)).map((row) => row.viewer_id);
}

/** Copy the package provenance onto the ai_packages row. */
export function setPackageJob(db, packageId, {
  jobId,
  batchIndex,
  stage,
  promptVersion
}) {
  db.prepare(`
    UPDATE ai_packages
       SET job_id = ?, batch_index = ?, stage = ?, prompt_version = ?
     WHERE id = ?
  `).run(
    String(jobId),
    batchIndex === null || batchIndex === undefined ? null : Number(batchIndex),
    String(stage),
    String(promptVersion),
    String(packageId)
  );
}

/* --------------------------------------------------- unified memory coverage */

function mapMemoryViewer(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    viewerId: row.viewer_id,
    batchIndex: Number(row.batch_index),
    baseMemoryId: row.base_memory_id ?? null,
    baseVersion: Number(row.base_version ?? 0),
    messageCount: Number(row.message_count ?? 0),
    status: row.status,
    resultId: row.result_id ?? null,
    processedAt: row.processed_at ?? null
  };
}

export function insertJobMemoryViewers(db, jobId, entries) {
  const statement = db.prepare(`
    INSERT INTO ai_job_memory_viewers (
      job_id, viewer_id, batch_index, base_memory_id, base_version, message_count, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  for (const entry of entries) {
    statement.run(
      String(jobId),
      String(entry.viewerId),
      Number(entry.batchIndex),
      entry.baseMemoryId === null || entry.baseMemoryId === undefined ? null : String(entry.baseMemoryId),
      Number(entry.baseVersion ?? 0),
      Number(entry.messageCount ?? 0)
    );
  }
}

export function insertJobMemoryMessages(db, jobId, batchIndex, entries) {
  const statement = db.prepare(`
    INSERT INTO ai_job_memory_messages (job_id, batch_index, seq, viewer_id, event_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const entry of entries) {
    statement.run(
      String(jobId),
      Number(batchIndex),
      Number(entry.seq),
      String(entry.viewerId),
      Number(entry.eventId)
    );
  }
}

export function getJobMemoryViewer(db, jobId, viewerId) {
  return mapMemoryViewer(db.prepare(`
    SELECT * FROM ai_job_memory_viewers WHERE job_id = ? AND viewer_id = ?
  `).get(String(jobId), String(viewerId)));
}

export function listJobMemoryViewers(db, jobId, {batchIndex = null} = {}) {
  const rows = batchIndex === null
    ? db.prepare(`
        SELECT * FROM ai_job_memory_viewers WHERE job_id = ? ORDER BY batch_index ASC, viewer_id ASC
      `).all(String(jobId))
    : db.prepare(`
        SELECT * FROM ai_job_memory_viewers
         WHERE job_id = ? AND batch_index = ? ORDER BY viewer_id ASC
      `).all(String(jobId), Number(batchIndex));
  return rows.map(mapMemoryViewer);
}

export function getJobMemoryMessage(db, jobId, batchIndex, seq) {
  const row = db.prepare(`
    SELECT viewer_id, event_id FROM ai_job_memory_messages
     WHERE job_id = ? AND batch_index = ? AND seq = ?
  `).get(String(jobId), Number(batchIndex), Number(seq));
  return row ? {viewerId: row.viewer_id, eventId: Number(row.event_id)} : null;
}

export function countJobMemoryMessages(db, jobId, batchIndex) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ai_job_memory_messages WHERE job_id = ? AND batch_index = ?
  `).get(String(jobId), Number(batchIndex))?.count ?? 0);
}

export function setJobMemoryViewerStatus(db, jobId, viewerId, {
  status,
  resultId = null,
  processedAt = Date.now()
}) {
  db.prepare(`
    UPDATE ai_job_memory_viewers
       SET status = ?, result_id = ?, processed_at = ?
     WHERE job_id = ? AND viewer_id = ?
  `).run(
    String(status),
    resultId === null || resultId === undefined ? null : String(resultId),
    Number(processedAt),
    String(jobId),
    String(viewerId)
  );
}

/**
 * Coverage of one job, computed from real rows. `pending` means the batch that
 * owns the viewer has not been imported yet; it is not "skipped".
 */
export function jobMemoryCoverage(db, jobId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
      FROM ai_job_memory_viewers
     WHERE job_id = ?
     GROUP BY status
  `).all(String(jobId));
  const counts = {
    total: 0,
    pending: 0,
    semantic: 0,
    no_semantics: 0,
    objective_only: 0,
    missing_update: 0,
    deleted: 0
  };
  for (const row of rows) {
    const key = String(row.status ?? 'pending');
    counts[key] = Number(row.count ?? 0);
    counts.total += Number(row.count ?? 0);
  }
  return {
    ...counts,
    covered: counts.total - counts.pending - counts.missing_update,
    complete: counts.total > 0 && counts.pending === 0 && counts.missing_update === 0
  };
}

export const __internal = {mapJob, mapBatch, mapMemoryViewer};
