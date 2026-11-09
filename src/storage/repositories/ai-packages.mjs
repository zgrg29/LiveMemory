/**
 * AI analysis package index. Each export is recorded so the console can offer
 * the file again later, tie it to an analysis job/batch, and reject duplicate
 * imports. Package rows are removed with their session.
 */
export function insertPackage(db, {
  id,
  sessionId,
  kind = 'analysis',
  protocolVersion,
  locale,
  fileName,
  relativePath,
  checksum,
  messageCount = 0,
  jobId = null,
  batchIndex = null,
  stage = 'single',
  promptVersion = null,
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO ai_packages (
      id, session_id, kind, protocol_version, locale, file_name, relative_path, checksum,
      message_count, job_id, batch_index, stage, prompt_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(sessionId),
    String(kind),
    String(protocolVersion),
    String(locale),
    String(fileName),
    String(relativePath),
    String(checksum),
    messageCount,
    jobId === null || jobId === undefined ? null : String(jobId),
    batchIndex === null || batchIndex === undefined ? null : Number(batchIndex),
    String(stage),
    promptVersion === null || promptVersion === undefined ? null : String(promptVersion),
    createdAt
  );
  return getPackage(db, id);
}

export function getPackage(db, packageId) {
  return db.prepare('SELECT * FROM ai_packages WHERE id = ?').get(String(packageId)) ?? null;
}

export function listPackages(db, {sessionId = null, jobId = null, limit = 50} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (jobId) {
    return db.prepare('SELECT * FROM ai_packages WHERE job_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(jobId), safeLimit);
  }
  if (sessionId) {
    return db.prepare('SELECT * FROM ai_packages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(sessionId), safeLimit);
  }
  return db.prepare('SELECT * FROM ai_packages ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}

export function deletePackageIndex(db, packageId) {
  const result = db.prepare('DELETE FROM ai_packages WHERE id = ?').run(String(packageId));
  return result.changes > 0;
}
