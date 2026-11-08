/**
 * AI analysis package index. Each export is recorded so the console can offer
 * the file again later and so duplicate imports can be rejected in M6.
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
  createdAt = Date.now()
}) {
  db.prepare(`
    INSERT INTO ai_packages (
      id, session_id, kind, protocol_version, locale, file_name, relative_path, checksum, message_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, String(sessionId), String(kind), String(protocolVersion), String(locale), String(fileName), String(relativePath), String(checksum), messageCount, createdAt);
  return getPackage(db, id);
}

export function getPackage(db, packageId) {
  return db.prepare('SELECT * FROM ai_packages WHERE id = ?').get(String(packageId)) ?? null;
}

export function listPackages(db, {sessionId = null, limit = 50} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
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
