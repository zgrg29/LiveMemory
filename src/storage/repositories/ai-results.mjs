/**
 * AI analysis results and evidence references.
 *
 * Results are external, untrusted documents. They are stored verbatim only
 * after strict validation and sanitisation; this module never merges AI numbers
 * into the deterministic event/journal tables.
 */

function mapResult(row, {includeJson = false} = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    scopeKey: row.scope_key,
    batchIndex: row.batch_index === null || row.batch_index === undefined ? null : Number(row.batch_index),
    taskId: row.task_id,
    taskKind: row.task_kind,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    locale: row.locale,
    checksum: row.checksum,
    resultVersion: Number(row.result_version),
    source: row.source,
    evidenceTotal: Number(row.evidence_total ?? 0),
    evidenceMissing: Number(row.evidence_missing ?? 0),
    importedAt: Number(row.imported_at)
  };
  if (includeJson) result.result = JSON.parse(row.result_json);
  return result;
}

export function insertResult(db, {
  id,
  jobId,
  sessionId,
  scopeKey,
  batchIndex = null,
  taskId,
  taskKind,
  protocolVersion,
  schemaVersion,
  locale,
  checksum,
  resultVersion,
  source,
  resultJson,
  evidenceTotal = 0,
  evidenceMissing = 0,
  importedAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO ai_results (
      id, job_id, session_id, scope_key, batch_index, task_id, task_kind,
      protocol_version, schema_version, locale, checksum, result_version, source,
      result_json, evidence_total, evidence_missing, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(id),
    String(jobId),
    String(sessionId),
    String(scopeKey),
    batchIndex === null || batchIndex === undefined ? null : Number(batchIndex),
    String(taskId),
    String(taskKind),
    String(protocolVersion),
    String(schemaVersion),
    String(locale),
    String(checksum),
    Number(resultVersion),
    String(source),
    String(resultJson),
    Number(evidenceTotal),
    Number(evidenceMissing),
    Number(importedAt)
  );
  return getResult(db, id);
}

export function getResult(db, resultId, options = {}) {
  return mapResult(
    db.prepare('SELECT * FROM ai_results WHERE id = ?').get(String(resultId)),
    options
  );
}

export function listResults(db, jobId, {includeJson = false} = {}) {
  return db.prepare('SELECT * FROM ai_results WHERE job_id = ? ORDER BY imported_at ASC, result_version ASC')
    .all(String(jobId)).map((row) => mapResult(row, {includeJson}));
}

export function listSessionResults(db, sessionId, {limit = 100} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`
    SELECT * FROM ai_results WHERE session_id = ?
     ORDER BY imported_at DESC LIMIT ?
  `).all(String(sessionId), safeLimit).map((row) => mapResult(row));
}

export function latestResultForScope(db, jobId, scopeKey, options = {}) {
  return mapResult(
    db.prepare(`
      SELECT * FROM ai_results
       WHERE job_id = ? AND scope_key = ?
       ORDER BY result_version DESC LIMIT 1
    `).get(String(jobId), String(scopeKey)),
    options
  );
}

export function resultVersionCount(db, jobId, scopeKey) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ai_results WHERE job_id = ? AND scope_key = ?
  `).get(String(jobId), String(scopeKey))?.count ?? 0);
}

export function findResultByChecksum(db, jobId, scopeKey, checksum) {
  return mapResult(
    db.prepare(`
      SELECT * FROM ai_results
       WHERE job_id = ? AND scope_key = ? AND checksum = ?
       ORDER BY result_version DESC LIMIT 1
    `).get(String(jobId), String(scopeKey), String(checksum))
  );
}

export function insertEvidence(db, resultId, rows) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO ai_result_evidence (
      result_id, section, item_index, seq, batch_index, event_id, available
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    statement.run(
      String(resultId),
      String(row.section),
      Number(row.itemIndex),
      Number(row.seq),
      Number(row.batchIndex),
      row.eventId === null || row.eventId === undefined ? null : Number(row.eventId),
      row.available ? 1 : 0
    );
  }
}

export function listEvidence(db, resultId) {
  return db.prepare(`
    SELECT * FROM ai_result_evidence
     WHERE result_id = ?
     ORDER BY section ASC, item_index ASC, batch_index ASC, seq ASC
  `).all(String(resultId)).map((row) => ({
    resultId: row.result_id,
    section: row.section,
    itemIndex: Number(row.item_index),
    seq: Number(row.seq),
    batchIndex: Number(row.batch_index),
    eventId: row.event_id === null || row.event_id === undefined ? null : Number(row.event_id),
    available: row.available === 1
  }));
}
