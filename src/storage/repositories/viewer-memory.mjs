/**
 * Long-term viewer memory persistence (M7).
 *
 * Scope rule: a memory always belongs to exactly one `broadcaster × viewer`
 * pair. The same platform account seen in two channels has two independent
 * memories; this module never returns another channel's facts.
 *
 * The head row (`viewer_memories`) owns a version pointer and a small summary.
 * Atomic knowledge lives in `memory_facts` and is rewritten as a whole inside a
 * transaction whenever a version is applied: the fact set is small, and a
 * whole-set rewrite makes "current state" and "version snapshot" impossible to
 * diverge.
 *
 * A deleted memory keeps its head row as a tombstone (`status = 'deleted'`,
 * no facts, `deleted_at` set) so that an AI package generated *before* the
 * deletion cannot silently restore the data the user removed.
 */

function mapMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    broadcasterId: row.broadcaster_id,
    viewerId: row.viewer_id,
    status: row.status,
    version: Number(row.version ?? 0),
    summary: row.summary ?? null,
    summaryCertainty: row.summary_certainty ?? null,
    firstMemoryAt: Number(row.first_memory_at ?? 0),
    lastUpdateAt: Number(row.last_update_at ?? 0),
    lastSessionId: row.last_session_id ?? null,
    lastJobId: row.last_job_id ?? null,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    deleteReason: row.delete_reason ?? null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

function mapFact(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoryId: row.memory_id,
    broadcasterId: row.broadcaster_id,
    viewerId: row.viewer_id,
    kind: row.kind,
    topic: row.topic ?? null,
    statement: row.statement,
    certainty: row.certainty,
    status: row.status,
    statusReason: row.status_reason ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    dedupeKey: row.dedupe_key,
    evidenceStatus: row.evidence_status ?? 'none',
    evidenceCount: Number(row.evidence_count ?? 0),
    evidenceAvailable: Number(row.evidence_available ?? 0),
    sourceKind: row.source_kind,
    sourceSessionId: row.source_session_id ?? null,
    sourceJobId: row.source_job_id ?? null,
    sourceResultId: row.source_result_id ?? null,
    sourceLabel: row.source_label ?? null,
    validFrom: row.valid_from === null || row.valid_from === undefined ? null : Number(row.valid_from),
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : Number(row.valid_until),
    supersededBy: row.superseded_by ?? null,
    conflictsWith: row.conflicts_with ?? null,
    userVerified: row.user_verified === 1,
    firstSeenAt: Number(row.first_seen_at ?? 0),
    lastConfirmedAt: Number(row.last_confirmed_at ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export function mapEvidence(row) {
  if (!row) return null;
  return {
    factId: row.fact_id,
    sourceKey: row.source_key,
    sessionId: row.session_id,
    batchIndex: row.batch_index === null || row.batch_index === undefined ? null : Number(row.batch_index),
    seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
    eventId: row.event_id === null || row.event_id === undefined ? null : Number(row.event_id),
    observedAt: row.observed_at === null || row.observed_at === undefined ? null : Number(row.observed_at),
    available: row.available === 1,
    contentPurged: row.content_purged_at !== null && row.content_purged_at !== undefined,
    contentExists: row.event_exists === null || row.event_exists === undefined ? true : Number(row.event_exists) === 1
  };
}

/* ------------------------------------------------------------------ memory */

export function getMemory(db, {broadcasterId, viewerId}) {
  return mapMemory(db.prepare(`
    SELECT * FROM viewer_memories WHERE broadcaster_id = ? AND viewer_id = ?
  `).get(String(broadcasterId), String(viewerId)));
}

export function getMemoryById(db, memoryId) {
  return mapMemory(db.prepare('SELECT * FROM viewer_memories WHERE id = ?').get(String(memoryId)));
}

/**
 * Create the head row, or resurrect a tombstone as a brand-new memory.
 *
 * Resurrection only happens when the caller explicitly starts a new memory
 * (a new job created after the deletion). A stale package is rejected earlier,
 * in the import validation, by comparing the package generation time with
 * `deleted_at`.
 */
export function ensureMemory(db, {id, broadcasterId, viewerId, now = Date.now()}) {
  const existing = getMemory(db, {broadcasterId, viewerId});
  if (existing) {
    if (existing.status === 'deleted') {
      db.prepare(`
        UPDATE viewer_memories
           SET status = 'active', version = 0, summary = NULL, summary_certainty = NULL,
               first_memory_at = ?, last_update_at = ?, last_session_id = NULL, last_job_id = NULL,
               deleted_at = NULL, delete_reason = NULL, updated_at = ?
         WHERE id = ?
      `).run(Number(now), Number(now), Number(now), existing.id);
      return getMemory(db, {broadcasterId, viewerId});
    }
    return existing;
  }
  db.prepare(`
    INSERT INTO viewer_memories (
      id, broadcaster_id, viewer_id, status, version, summary, summary_certainty,
      first_memory_at, last_update_at, last_session_id, last_job_id,
      deleted_at, delete_reason, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    String(id),
    String(broadcasterId),
    String(viewerId),
    Number(now),
    Number(now),
    Number(now),
    Number(now)
  );
  return getMemory(db, {broadcasterId, viewerId});
}

export function touchMemory(db, memoryId, {
  version,
  summary,
  summaryCertainty,
  lastSessionId,
  lastJobId,
  now = Date.now()
} = {}) {
  db.prepare(`
    UPDATE viewer_memories
       SET version = COALESCE(?, version),
           summary = COALESCE(?, summary),
           summary_certainty = COALESCE(?, summary_certainty),
           last_update_at = ?,
           last_session_id = COALESCE(?, last_session_id),
           last_job_id = COALESCE(?, last_job_id),
           updated_at = ?
     WHERE id = ?
  `).run(
    version === undefined ? null : Number(version),
    summary === undefined ? null : String(summary),
    summaryCertainty === undefined ? null : String(summaryCertainty),
    Number(now),
    lastSessionId === undefined ? null : String(lastSessionId),
    lastJobId === undefined ? null : String(lastJobId),
    Number(now),
    String(memoryId)
  );
  return getMemoryById(db, memoryId);
}

export function listMemories(db, {broadcasterId = null, status = null, limit = 100, offset = 0} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = [];
  const params = [];
  if (broadcasterId) {
    clauses.push('m.broadcaster_id = ?');
    params.push(String(broadcasterId));
  }
  if (status) {
    clauses.push('m.status = ?');
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit, safeOffset);
  return db.prepare(`
    SELECT m.*, v.nickname, v.platform, v.platform_uid, v.focused,
           (SELECT COUNT(*) FROM memory_facts f WHERE f.memory_id = m.id) AS fact_count,
           (SELECT COUNT(*) FROM memory_facts f WHERE f.memory_id = m.id AND f.status = 'active') AS active_count,
           (SELECT COUNT(*) FROM memory_facts f
             WHERE f.memory_id = m.id AND f.status IN ('needs_confirmation', 'conflicted')) AS attention_count
      FROM viewer_memories m
      JOIN viewers v ON v.id = m.viewer_id
      ${where}
     ORDER BY m.last_update_at DESC
     LIMIT ? OFFSET ?
  `).all(...params).map((row) => ({
    ...mapMemory(row),
    nickname: row.nickname ?? null,
    platform: row.platform,
    platformUid: row.platform_uid,
    focused: Number(row.focused ?? 0) === 1,
    factCount: Number(row.fact_count ?? 0),
    activeCount: Number(row.active_count ?? 0),
    attentionCount: Number(row.attention_count ?? 0)
  }));
}

/** Small, cheap overview used by the memory page header. */
export function memoryOverview(db, {broadcasterId = null} = {}) {
  const clause = broadcasterId ? 'WHERE m.broadcaster_id = ?' : '';
  const params = broadcasterId ? [String(broadcasterId)] : [];
  const head = db.prepare(`
    SELECT COUNT(*) AS memory_count,
           COALESCE(SUM(CASE WHEN m.status = 'active' THEN 1 ELSE 0 END), 0) AS active_memories,
           COALESCE(SUM(CASE WHEN m.status = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted_memories,
           MAX(m.last_update_at) AS last_update_at
      FROM viewer_memories m
      ${clause}
  `).get(...params);
  const facts = db.prepare(`
    SELECT f.status, COUNT(*) AS count
      FROM memory_facts f
      JOIN viewer_memories m ON m.id = f.memory_id
      ${clause}
     GROUP BY f.status
  `).all(...params);
  const byStatus = {};
  for (const row of facts) byStatus[row.status] = Number(row.count ?? 0);
  const certainty = db.prepare(`
    SELECT f.certainty, COUNT(*) AS count
      FROM memory_facts f
      JOIN viewer_memories m ON m.id = f.memory_id
      ${clause}
     GROUP BY f.certainty
  `).all(...params);
  const byCertainty = {};
  for (const row of certainty) byCertainty[row.certainty] = Number(row.count ?? 0);
  return {
    memories: Number(head?.memory_count ?? 0),
    activeMemories: Number(head?.active_memories ?? 0),
    deletedMemories: Number(head?.deleted_memories ?? 0),
    lastUpdateAt: head?.last_update_at ?? null,
    facts: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
    byStatus,
    byCertainty
  };
}

/* ------------------------------------------------------------------- facts */

export function listFacts(db, memoryId, {limit = 500} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db.prepare(`
    SELECT * FROM memory_facts
     WHERE memory_id = ?
     ORDER BY
       CASE status
         WHEN 'conflicted' THEN 0
         WHEN 'needs_confirmation' THEN 1
         WHEN 'active' THEN 2
         WHEN 'outdated' THEN 3
         ELSE 4
       END,
       last_confirmed_at DESC,
       id ASC
     LIMIT ?
  `).all(String(memoryId), safeLimit).map(mapFact);
}

export function getFact(db, factId) {
  return mapFact(db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(String(factId)));
}

export function listEvidence(db, memoryId) {
  return db.prepare(`
    SELECT e.*, ev.id AS event_exists, ev.content_purged_at
      FROM memory_fact_evidence e
      JOIN memory_facts f ON f.id = e.fact_id
      LEFT JOIN events ev ON ev.id = e.event_id
     WHERE f.memory_id = ?
     ORDER BY e.observed_at ASC
  `).all(String(memoryId)).map(mapEvidence);
}

/**
 * Replace every fact and every evidence row of one memory.
 *
 * Called inside the caller's transaction together with the version insert, so
 * an applied version and the live fact set are always written atomically.
 */
export function replaceFacts(db, memoryId, facts, {now = Date.now()} = {}) {
  db.prepare('DELETE FROM memory_fact_evidence WHERE fact_id IN (SELECT id FROM memory_facts WHERE memory_id = ?)')
    .run(String(memoryId));
  db.prepare('DELETE FROM memory_facts WHERE memory_id = ?').run(String(memoryId));
  const factStatement = db.prepare(`
    INSERT INTO memory_facts (
      id, memory_id, broadcaster_id, viewer_id, kind, topic, statement, certainty,
      status, status_reason, confidence, dedupe_key, evidence_status, evidence_count,
      evidence_available, source_kind, source_session_id, source_job_id, source_result_id,
      source_label, valid_from, valid_until, superseded_by, conflicts_with, user_verified,
      first_seen_at, last_confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const evidenceStatement = db.prepare(`
    INSERT INTO memory_fact_evidence (
      fact_id, source_key, session_id, batch_index, seq, event_id, observed_at, available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fact of facts) {
    factStatement.run(
      String(fact.id),
      String(memoryId),
      String(fact.broadcasterId),
      String(fact.viewerId),
      String(fact.kind),
      fact.topic ?? null,
      String(fact.statement),
      String(fact.certainty),
      String(fact.status),
      fact.statusReason ?? null,
      fact.confidence === null || fact.confidence === undefined ? null : Number(fact.confidence),
      String(fact.dedupeKey),
      String(fact.evidenceStatus ?? 'none'),
      Number(fact.evidenceCount ?? 0),
      Number(fact.evidenceAvailable ?? 0),
      String(fact.sourceKind),
      fact.sourceSessionId ?? null,
      fact.sourceJobId ?? null,
      fact.sourceResultId ?? null,
      fact.sourceLabel ?? null,
      fact.validFrom ?? null,
      fact.validUntil ?? null,
      fact.supersededBy ?? null,
      fact.conflictsWith ?? null,
      fact.userVerified ? 1 : 0,
      Number(fact.firstSeenAt ?? now),
      Number(fact.lastConfirmedAt ?? now),
      Number(fact.createdAt ?? now),
      Number(now)
    );
    for (const evidence of fact.evidence ?? []) {
      evidenceStatement.run(
        String(fact.id),
        String(evidence.sourceKey),
        String(evidence.sessionId),
        evidence.batchIndex === null || evidence.batchIndex === undefined ? null : Number(evidence.batchIndex),
        evidence.seq === null || evidence.seq === undefined ? null : Number(evidence.seq),
        evidence.eventId === null || evidence.eventId === undefined ? null : Number(evidence.eventId),
        evidence.observedAt === null || evidence.observedAt === undefined ? null : Number(evidence.observedAt),
        evidence.available === false ? 0 : 1
      );
    }
  }
  return facts.length;
}

/**
 * Recompute evidence availability after raw chat was purged or events deleted.
 *
 * A memory is never deleted here. Instead the fact records that its evidence is
 * no longer verifiable, which is exactly what the UI must say.
 */
export function refreshMemoryEvidence(db, {memoryId = null, now = Date.now()} = {}) {
  const scope = memoryId ? 'WHERE f.memory_id = ?' : '';
  const params = memoryId ? [String(memoryId)] : [];
  const rows = db.prepare(`
    SELECT f.id AS fact_id,
           COUNT(e.source_key) AS total,
           SUM(CASE WHEN e.available = 1 THEN 1 ELSE 0 END) AS available,
           SUM(CASE WHEN e.event_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM events ev WHERE ev.id = e.event_id
               ) THEN 1 ELSE 0 END) AS existing,
           SUM(CASE WHEN e.event_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM events ev WHERE ev.id = e.event_id AND ev.content_purged_at IS NULL
               ) THEN 1 ELSE 0 END) AS intact
      FROM memory_facts f
      LEFT JOIN memory_fact_evidence e ON e.fact_id = f.id
      ${scope}
     GROUP BY f.id
  `).all(...params);
  const update = db.prepare(`
    UPDATE memory_facts
       SET evidence_status = ?, evidence_count = ?, evidence_available = ?, updated_at = ?
     WHERE id = ?
  `);
  // Evidence rows whose event disappeared can never become available again.
  db.prepare(`
    UPDATE memory_fact_evidence
       SET available = 0
     WHERE event_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.id = memory_fact_evidence.event_id)
       ${memoryId ? 'AND fact_id IN (SELECT id FROM memory_facts WHERE memory_id = ?)' : ''}
  `).run(...(memoryId ? [String(memoryId)] : []));
  const changed = [];
  for (const row of rows) {
    const total = Number(row.total ?? 0);
    const available = Number(row.available ?? 0);
    const existing = Number(row.existing ?? 0);
    const intact = Number(row.intact ?? 0);
    let status = 'none';
    if (total > 0) {
      if (intact > 0 && intact >= total) status = 'available';
      else if (intact > 0) status = 'partial';
      else if (existing > 0) status = 'purged';
      else status = 'unavailable';
    }
    update.run(status, total, Math.min(available, existing), Number(now), row.fact_id);
    changed.push({factId: row.fact_id, evidenceStatus: status, evidenceCount: total});
  }
  return changed;
}

/* ---------------------------------------------------------------- versions */

export function insertVersion(db, {
  id,
  memoryId,
  version,
  sourceKind,
  sourceJobId = null,
  sourceResultId = null,
  sourceSessionId = null,
  sourceKey,
  counts,
  diff,
  snapshot,
  appliedAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO memory_versions (
      id, memory_id, version, source_kind, source_job_id, source_result_id,
      source_session_id, source_key, counts_json, diff_json, snapshot_json, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(id),
    String(memoryId),
    Number(version),
    String(sourceKind),
    sourceJobId ?? null,
    sourceResultId ?? null,
    sourceSessionId ?? null,
    String(sourceKey),
    JSON.stringify(counts ?? {}),
    JSON.stringify(diff ?? {}),
    JSON.stringify(snapshot ?? []),
    Number(appliedAt)
  );
  return getVersion(db, memoryId, version);
}

export function mapVersion(row, {includeSnapshot = false} = {}) {
  if (!row) return null;
  const version = {
    id: row.id,
    memoryId: row.memory_id,
    version: Number(row.version),
    sourceKind: row.source_kind,
    sourceJobId: row.source_job_id ?? null,
    sourceResultId: row.source_result_id ?? null,
    sourceSessionId: row.source_session_id ?? null,
    sourceKey: row.source_key,
    counts: safeParse(row.counts_json, {}),
    diff: safeParse(row.diff_json, {added: [], changed: [], removed: [], unchanged: 0}),
    appliedAt: Number(row.applied_at)
  };
  if (includeSnapshot) version.snapshot = safeParse(row.snapshot_json, []);
  return version;
}

function safeParse(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function listVersions(db, memoryId, {limit = 30} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return db.prepare(`
    SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT ?
  `).all(String(memoryId), safeLimit).map((row) => mapVersion(row));
}

export function getVersion(db, memoryId, version, {includeSnapshot = true} = {}) {
  return mapVersion(
    db.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(String(memoryId), Number(version)),
    {includeSnapshot}
  );
}

export function latestVersion(db, memoryId) {
  return mapVersion(db.prepare(`
    SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 1
  `).get(String(memoryId)));
}

export function versionForSource(db, memoryId, sourceKey) {
  return mapVersion(db.prepare(`
    SELECT * FROM memory_versions WHERE memory_id = ? AND source_key = ?
  `).get(String(memoryId), String(sourceKey)));
}

export function countVersions(db, memoryId) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id = ?')
    .get(String(memoryId))?.count ?? 0);
}

/** Keep only the newest `keep` versions of one memory; older snapshots go. */
export function pruneVersions(db, {memoryId, keep = 20} = {}) {
  const safeKeep = Math.min(Math.max(Number(keep) || 20, 1), 500);
  const result = db.prepare(`
    DELETE FROM memory_versions
     WHERE memory_id = ?
       AND version NOT IN (
         SELECT version FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT ?
       )
  `).run(String(memoryId), String(memoryId), safeKeep);
  return Number(result.changes ?? 0);
}

/* ------------------------------------------------------------------ delete */

/**
 * Delete one viewer's memory in one broadcaster's context.
 *
 * Facts, evidence and version history are removed; the head row stays as a
 * tombstone so an older export cannot resurrect deleted knowledge.
 */
export function deleteMemory(db, {memoryId, reason = 'user', now = Date.now()}) {
  const memory = getMemoryById(db, memoryId);
  if (!memory) return null;
  db.prepare(`
    DELETE FROM memory_fact_evidence
     WHERE fact_id IN (SELECT id FROM memory_facts WHERE memory_id = ?)
  `).run(String(memoryId));
  db.prepare('DELETE FROM memory_facts WHERE memory_id = ?').run(String(memoryId));
  db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(String(memoryId));
  db.prepare(`
    UPDATE viewer_memories
       SET status = 'deleted', version = 0, summary = NULL, summary_certainty = NULL,
           deleted_at = ?, delete_reason = ?, updated_at = ?
     WHERE id = ?
  `).run(Number(now), String(reason).slice(0, 80), Number(now), String(memoryId));
  return getMemoryById(db, memoryId);
}

/** Memories whose viewer has not appeared for a long time (manual cleanup). */
export function listStaleMemories(db, {broadcasterId = null, olderThanMs, now = Date.now(), limit = 1000} = {}) {
  const cutoff = Number(now) - Number(olderThanMs ?? 0);
  const clauses = ["m.status = 'active'", 'v.last_seen_at < ?'];
  const params = [cutoff];
  if (broadcasterId) {
    clauses.push('m.broadcaster_id = ?');
    params.push(String(broadcasterId));
  }
  params.push(Math.min(Math.max(Number(limit) || 1000, 1), 5000));
  return db.prepare(`
    SELECT m.id, m.broadcaster_id, m.viewer_id, v.nickname, v.last_seen_at,
           (SELECT COUNT(*) FROM memory_facts f WHERE f.memory_id = m.id) AS fact_count
      FROM viewer_memories m
      JOIN viewers v ON v.id = m.viewer_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY v.last_seen_at ASC
     LIMIT ?
  `).all(...params).map((row) => ({
    memoryId: row.id,
    broadcasterId: row.broadcaster_id,
    viewerId: row.viewer_id,
    nickname: row.nickname ?? null,
    lastSeenAt: Number(row.last_seen_at ?? 0),
    factCount: Number(row.fact_count ?? 0)
  }));
}

/* -------------------------------------------------------------------- jobs */

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    broadcasterId: row.broadcaster_id ?? null,
    sessionId: row.session_id,
    locale: row.locale,
    promptVersion: row.prompt_version,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    scope: row.scope,
    batchTotal: Number(row.batch_total ?? 1),
    viewersTotal: Number(row.viewers_total ?? 0),
    messagesTotal: Number(row.messages_total ?? 0),
    lastErrorAt: row.last_error_at === null || row.last_error_at === undefined ? null : Number(row.last_error_at),
    lastErrorCode: row.last_error_code ?? null,
    lastErrorJson: row.last_error_json ?? null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export function insertMemoryJob(db, {
  id,
  broadcasterId = null,
  sessionId,
  locale,
  promptVersion,
  protocolVersion,
  schemaVersion,
  scope = 'session',
  batchTotal = 1,
  viewersTotal = 0,
  messagesTotal = 0,
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO memory_jobs (
      id, broadcaster_id, session_id, locale, prompt_version, protocol_version,
      schema_version, scope, batch_total, viewers_total, messages_total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(id),
    broadcasterId ?? null,
    String(sessionId),
    String(locale),
    String(promptVersion),
    String(protocolVersion),
    String(schemaVersion),
    String(scope),
    Number(batchTotal),
    Number(viewersTotal),
    Number(messagesTotal),
    Number(createdAt),
    Number(createdAt)
  );
  return getMemoryJob(db, id);
}

export function getMemoryJob(db, jobId) {
  return mapJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(String(jobId)));
}

export function listMemoryJobs(db, {sessionId = null, broadcasterId = null, limit = 50} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const clauses = [];
  const params = [];
  if (sessionId) {
    clauses.push('session_id = ?');
    params.push(String(sessionId));
  }
  if (broadcasterId) {
    clauses.push('broadcaster_id = ?');
    params.push(String(broadcasterId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit);
  return db.prepare(`SELECT * FROM memory_jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params).map(mapJob);
}

export function touchMemoryJob(db, jobId, {now = Date.now()} = {}) {
  db.prepare('UPDATE memory_jobs SET updated_at = ? WHERE id = ?').run(Number(now), String(jobId));
}

export function recordMemoryJobFailure(db, jobId, {code, errors = [], now = Date.now()} = {}) {
  const capped = (Array.isArray(errors) ? errors : []).slice(0, 40).map((error) => ({
    path: typeof error?.path === 'string' ? error.path.slice(0, 300) : '',
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNKNOWN'
  }));
  db.prepare(`
    UPDATE memory_jobs
       SET last_error_at = ?, last_error_code = ?, last_error_json = ?, updated_at = ?
     WHERE id = ?
  `).run(
    Number(now),
    String(code ?? 'MEMORY_IMPORT_INVALID'),
    JSON.stringify({at: now, code: String(code ?? 'MEMORY_IMPORT_INVALID'), errors: capped}),
    Number(now),
    String(jobId)
  );
}

export function clearMemoryJobFailure(db, jobId, {now = Date.now()} = {}) {
  db.prepare(`
    UPDATE memory_jobs
       SET last_error_at = NULL, last_error_code = NULL, last_error_json = NULL, updated_at = ?
     WHERE id = ?
  `).run(Number(now), String(jobId));
}

/* ------------------------------------------------------------------ batches */

function mapBatch(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    batchIndex: Number(row.batch_index),
    batchId: row.batch_id,
    taskId: row.task_id,
    viewerCount: Number(row.viewer_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
    checksum: row.checksum,
    fileName: row.file_name ?? null,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    packageChecksum: row.package_checksum ?? null,
    createdAt: Number(row.created_at ?? 0)
  };
}

export function insertMemoryBatch(db, {
  jobId,
  batchIndex,
  batchId,
  taskId,
  viewerCount = 0,
  messageCount = 0,
  checksum,
  fileName = null,
  bytes = null,
  packageChecksum = null,
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO memory_job_batches (
      job_id, batch_index, batch_id, task_id, viewer_count, message_count,
      checksum, file_name, bytes, package_checksum, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(jobId),
    Number(batchIndex),
    String(batchId),
    String(taskId),
    Number(viewerCount),
    Number(messageCount),
    String(checksum),
    fileName ?? null,
    bytes === null || bytes === undefined ? null : Number(bytes),
    packageChecksum ?? null,
    Number(createdAt)
  );
  return getMemoryBatch(db, jobId, batchIndex);
}

export function getMemoryBatch(db, jobId, batchIndex) {
  return mapBatch(db.prepare('SELECT * FROM memory_job_batches WHERE job_id = ? AND batch_index = ?')
    .get(String(jobId), Number(batchIndex)));
}

export function getMemoryBatchById(db, jobId, batchId) {
  return mapBatch(db.prepare('SELECT * FROM memory_job_batches WHERE job_id = ? AND batch_id = ?')
    .get(String(jobId), String(batchId)));
}

export function listMemoryBatches(db, jobId) {
  return db.prepare('SELECT * FROM memory_job_batches WHERE job_id = ? ORDER BY batch_index ASC')
    .all(String(jobId)).map(mapBatch);
}

export function setMemoryBatchPackage(db, jobId, batchIndex, {fileName, bytes, packageChecksum}) {
  db.prepare(`
    UPDATE memory_job_batches SET file_name = ?, bytes = ?, package_checksum = ?
     WHERE job_id = ? AND batch_index = ?
  `).run(fileName, Number(bytes), packageChecksum, String(jobId), Number(batchIndex));
}

export function insertMemoryBatchMessages(db, jobId, batchIndex, entries) {
  const statement = db.prepare(`
    INSERT OR REPLACE INTO memory_job_messages (job_id, batch_index, seq, event_id)
    VALUES (?, ?, ?, ?)
  `);
  for (const entry of entries) {
    statement.run(String(jobId), Number(batchIndex), Number(entry.seq), Number(entry.eventId));
  }
}

export function getMemoryBatchEventId(db, jobId, batchIndex, seq) {
  const row = db.prepare(`
    SELECT event_id FROM memory_job_messages WHERE job_id = ? AND batch_index = ? AND seq = ?
  `).get(String(jobId), Number(batchIndex), Number(seq));
  return row ? Number(row.event_id) : null;
}

export function countMemoryBatchMessages(db, jobId, batchIndex) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_job_messages WHERE job_id = ? AND batch_index = ?
  `).get(String(jobId), Number(batchIndex))?.count ?? 0);
}

/* ------------------------------------------------------------- job viewers */

export function insertMemoryBatchViewers(db, jobId, batchIndex, entries) {
  const statement = db.prepare(`
    INSERT OR REPLACE INTO memory_job_viewers (
      job_id, batch_index, viewer_id, base_memory_id, base_version
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const entry of entries) {
    const viewerId = typeof entry === 'string' ? entry : entry.viewerId;
    statement.run(
      String(jobId),
      Number(batchIndex),
      String(viewerId),
      (typeof entry === 'object' && entry.baseMemoryId) || null,
      Number((typeof entry === 'object' && entry.baseVersion) || 0)
    );
  }
}

export function listMemoryBatchViewers(db, jobId, batchIndex) {
  return db.prepare(`
    SELECT * FROM memory_job_viewers WHERE job_id = ? AND batch_index = ? ORDER BY viewer_id ASC
  `).all(String(jobId), Number(batchIndex)).map((row) => ({
    jobId: row.job_id,
    batchIndex: Number(row.batch_index),
    viewerId: row.viewer_id,
    baseMemoryId: row.base_memory_id ?? null,
    baseVersion: Number(row.base_version ?? 0)
  }));
}

export function getMemoryBatchViewer(db, jobId, batchIndex, viewerId) {
  const row = db.prepare(`
    SELECT * FROM memory_job_viewers WHERE job_id = ? AND batch_index = ? AND viewer_id = ?
  `).get(String(jobId), Number(batchIndex), String(viewerId));
  if (!row) return null;
  return {
    jobId: row.job_id,
    batchIndex: Number(row.batch_index),
    viewerId: row.viewer_id,
    baseMemoryId: row.base_memory_id ?? null,
    baseVersion: Number(row.base_version ?? 0)
  };
}

export function listMemoryJobViewerIds(db, jobId, batchIndex = null) {
  if (batchIndex === null || batchIndex === undefined) {
    return db.prepare(`
      SELECT DISTINCT viewer_id FROM memory_job_viewers WHERE job_id = ? ORDER BY viewer_id ASC
    `).all(String(jobId)).map((row) => row.viewer_id);
  }
  return listMemoryBatchViewers(db, jobId, batchIndex).map((row) => row.viewerId);
}

/* ------------------------------------------------------------------ results */

function mapResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    batchIndex: Number(row.batch_index),
    batchId: row.batch_id,
    checksum: row.checksum,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    locale: row.locale,
    source: row.source,
    viewerTotal: Number(row.viewer_total ?? 0),
    opTotal: Number(row.op_total ?? 0),
    evidenceTotal: Number(row.evidence_total ?? 0),
    evidenceMissing: Number(row.evidence_missing ?? 0),
    appliedAt: Number(row.applied_at ?? 0),
    result: row.result_json ? safeParse(row.result_json, null) : undefined
  };
}

export function insertMemoryResult(db, {
  id,
  jobId,
  sessionId,
  batchIndex,
  batchId,
  checksum,
  protocolVersion,
  schemaVersion,
  locale,
  source,
  resultJson,
  viewerTotal = 0,
  opTotal = 0,
  evidenceTotal = 0,
  evidenceMissing = 0,
  appliedAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO memory_results (
      id, job_id, session_id, batch_index, batch_id, checksum, protocol_version,
      schema_version, locale, source, result_json, viewer_total, op_total,
      evidence_total, evidence_missing, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(id),
    String(jobId),
    String(sessionId),
    Number(batchIndex),
    String(batchId),
    String(checksum),
    String(protocolVersion),
    String(schemaVersion),
    String(locale),
    String(source),
    String(resultJson),
    Number(viewerTotal),
    Number(opTotal),
    Number(evidenceTotal),
    Number(evidenceMissing),
    Number(appliedAt)
  );
  return getMemoryResult(db, id);
}

export function getMemoryResult(db, resultId, {includeJson = true} = {}) {
  return mapResult(db.prepare('SELECT * FROM memory_results WHERE id = ?').get(String(resultId)), {includeJson});
}

export function findMemoryResultByChecksum(db, jobId, batchId, checksum) {
  return mapResult(db.prepare(`
    SELECT * FROM memory_results WHERE job_id = ? AND batch_id = ? AND checksum = ?
  `).get(String(jobId), String(batchId), String(checksum)));
}

export function listMemoryResults(db, jobId) {
  return db.prepare('SELECT * FROM memory_results WHERE job_id = ? ORDER BY batch_index ASC')
    .all(String(jobId)).map(mapResult);
}

export function latestMemoryResultForBatch(db, jobId, batchIndex) {
  return mapResult(db.prepare(`
    SELECT * FROM memory_results WHERE job_id = ? AND batch_index = ? ORDER BY applied_at DESC LIMIT 1
  `).get(String(jobId), Number(batchIndex)));
}

export const __internal = {mapMemory, mapFact, mapBatch, mapJob, mapResult, safeParse};
