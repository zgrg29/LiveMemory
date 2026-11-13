import {createId} from '../../shared/ids.mjs';

/**
 * Translation display cache.
 *
 * This module is deliberately separate from ai-jobs/ai-results: a translation
 * is not an analysis result, cannot change a fact or a viewer id, and its
 * token/cost usage must never be added to the original analysis job.
 */

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    itemPath: row.item_path,
    targetLocale: row.target_locale,
    sourceHash: row.source_hash,
    sourceLocale: row.source_locale ?? null,
    translatedText: row.translated_text ?? null,
    status: row.status,
    errorCode: row.error_code ?? null,
    providerConfigId: row.provider_config_id ?? null,
    providerId: row.provider_id ?? null,
    modelId: row.model_id ?? null,
    translatorVersion: row.translator_version,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    targetLocale: row.target_locale,
    sourceLocale: row.source_locale ?? null,
    status: row.status,
    providerConfigId: row.provider_config_id ?? null,
    providerId: row.provider_id ?? null,
    modelId: row.model_id ?? null,
    translatorVersion: row.translator_version,
    totalItems: Number(row.total_items ?? 0),
    translatedItems: Number(row.translated_items ?? 0),
    failedItems: Number(row.failed_items ?? 0),
    pendingItems: Number(row.pending_items ?? 0),
    usage: parseJson(row.usage_json, null),
    error: parseJson(row.error_json, null),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? null
      : Number(row.completed_at)
  };
}

export function insertTranslationRun(db, {
  id = null,
  sessionId,
  targetLocale,
  sourceLocale = null,
  status = 'running',
  providerConfigId = null,
  providerId = null,
  modelId = null,
  translatorVersion,
  totalItems = 0,
  translatedItems = 0,
  failedItems = 0,
  pendingItems = 0,
  usage = null,
  error = null,
  startedAt = Date.now(),
  updatedAt = null,
  completedAt = null
}) {
  const runId = id ?? createId('atr');
  const at = Number(updatedAt ?? startedAt);
  db.prepare(`
    INSERT INTO ai_translation_runs (
      id, session_id, target_locale, source_locale, status,
      provider_config_id, provider_id, model_id, translator_version,
      total_items, translated_items, failed_items, pending_items,
      usage_json, error_json, started_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    String(sessionId),
    String(targetLocale),
    sourceLocale === null ? null : String(sourceLocale),
    String(status),
    providerConfigId === null ? null : String(providerConfigId),
    providerId === null ? null : String(providerId),
    modelId === null ? null : String(modelId),
    String(translatorVersion),
    Number(totalItems) || 0,
    Number(translatedItems) || 0,
    Number(failedItems) || 0,
    Number(pendingItems) || 0,
    usage === null ? null : JSON.stringify(usage),
    error === null ? null : JSON.stringify(error),
    Number(startedAt),
    at,
    completedAt === null ? null : Number(completedAt)
  );
  return getTranslationRun(db, runId);
}

const RUN_FIELDS = Object.freeze({
  status: 'status',
  translatedItems: 'translated_items',
  failedItems: 'failed_items',
  pendingItems: 'pending_items',
  usage: 'usage_json',
  error: 'error_json',
  completedAt: 'completed_at',
  updatedAt: 'updated_at'
});

export function updateTranslationRun(db, runId, patch = {}) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(RUN_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    let value = patch[key];
    if (key === 'usage' || key === 'error') value = value === null ? null : JSON.stringify(value);
    if (key === 'updatedAt' || key === 'completedAt') value = value === null ? null : Number(value);
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return getTranslationRun(db, runId);
  values.push(String(runId));
  db.prepare(`UPDATE ai_translation_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTranslationRun(db, runId);
}

export function getTranslationRun(db, runId) {
  return mapRun(db.prepare('SELECT * FROM ai_translation_runs WHERE id = ?').get(String(runId)));
}

export function latestTranslationRun(db, {sessionId, targetLocale}) {
  return mapRun(db.prepare(`
    SELECT * FROM ai_translation_runs
     WHERE session_id = ? AND target_locale = ?
     ORDER BY started_at DESC, rowid DESC
     LIMIT 1
  `).get(String(sessionId), String(targetLocale)));
}

/**
 * A process that dies mid-run must not leave a permanent "running" status.
 * The translation rows that were already committed stay valid and reusable.
 */
export function markRunningTranslationRunsInterrupted(db, {now = Date.now()} = {}) {
  const rows = db.prepare("SELECT id FROM ai_translation_runs WHERE status = 'running'").all();
  for (const row of rows) {
    updateTranslationRun(db, row.id, {
      status: 'interrupted',
      error: {code: 'TRANSLATION_INTERRUPTED', at: Number(now)},
      pendingItems: 0,
      updatedAt: now,
      completedAt: now
    });
  }
  return rows.length;
}

export function upsertTranslationItem(db, {
  id = null,
  sessionId,
  targetKind,
  targetId,
  itemPath,
  targetLocale,
  sourceHash,
  sourceLocale = null,
  translatedText = null,
  status = 'ok',
  errorCode = null,
  providerConfigId = null,
  providerId = null,
  modelId = null,
  translatorVersion,
  now = Date.now()
}) {
  const rowId = id ?? createId('atl');
  const at = Number(now);
  db.prepare(`
    INSERT INTO ai_translations (
      id, session_id, target_kind, target_id, item_path, target_locale,
      source_hash, source_locale, translated_text, status, error_code,
      provider_config_id, provider_id, model_id, translator_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (target_kind, target_id, item_path, target_locale, source_hash, translator_version)
    DO UPDATE SET
      translated_text = excluded.translated_text,
      status = excluded.status,
      error_code = excluded.error_code,
      provider_config_id = excluded.provider_config_id,
      provider_id = excluded.provider_id,
      model_id = excluded.model_id,
      updated_at = excluded.updated_at
  `).run(
    rowId,
    String(sessionId),
    String(targetKind),
    String(targetId),
    String(itemPath),
    String(targetLocale),
    String(sourceHash),
    sourceLocale === null ? null : String(sourceLocale),
    translatedText === null ? null : String(translatedText),
    String(status),
    errorCode === null ? null : String(errorCode).slice(0, 80),
    providerConfigId === null ? null : String(providerConfigId),
    providerId === null ? null : String(providerId),
    modelId === null ? null : String(modelId),
    String(translatorVersion),
    at,
    at
  );
  return getTranslationItem(db, {
    targetKind,
    targetId,
    itemPath,
    targetLocale,
    sourceHash,
    translatorVersion
  });
}

export function getTranslationItem(db, {
  targetKind,
  targetId,
  itemPath,
  targetLocale,
  sourceHash,
  translatorVersion
}) {
  return mapItem(db.prepare(`
    SELECT * FROM ai_translations
     WHERE target_kind = ? AND target_id = ? AND item_path = ?
       AND target_locale = ? AND source_hash = ? AND translator_version = ?
  `).get(
    String(targetKind),
    String(targetId),
    String(itemPath),
    String(targetLocale),
    String(sourceHash),
    String(translatorVersion)
  ));
}

export function listTranslationItems(db, {sessionId, targetLocale, translatorVersion = null}) {
  const params = [String(sessionId), String(targetLocale)];
  let sql = 'SELECT * FROM ai_translations WHERE session_id = ? AND target_locale = ?';
  if (translatorVersion) {
    sql += ' AND translator_version = ?';
    params.push(String(translatorVersion));
  }
  return db.prepare(sql).all(...params).map(mapItem);
}

/** Remove display translations when the source memory is deleted. */
export function deleteTranslationsForMemory(db, {memoryId, factIds = []}) {
  const ids = factIds.map(String);
  let removed = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    removed += Number(db.prepare(`
      DELETE FROM ai_translations
       WHERE target_kind = 'memory_fact' AND target_id IN (${placeholders})
    `).run(...ids).changes ?? 0);
  }
  removed += Number(db.prepare(`
    DELETE FROM ai_translations
     WHERE target_kind = 'memory_summary' AND target_id = ?
  `).run(String(memoryId)).changes ?? 0);
  return removed;
}

export function deleteTranslationsForSession(db, sessionId) {
  db.prepare('DELETE FROM ai_translations WHERE session_id = ?').run(String(sessionId));
  db.prepare('DELETE FROM ai_translation_runs WHERE session_id = ?').run(String(sessionId));
}

export const __internal = {mapItem, mapRun};
