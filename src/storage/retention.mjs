/**
 * Retention policy enforcement.
 *
 * Why this exists
 * ---------------
 * The YouTube API Services Developer Policies and the Google API Services User
 * Data Policy limit how long an application may keep API data. A streamer
 * signing in with Google authorises *their own* account; that consent does not
 * grant unlimited, indefinite storage of every other viewer's chat text.
 *
 * LiveMemory therefore separates two things:
 * - **derived aggregates** (message counts, per-currency support totals, viewer
 *   identity and nickname history) that the product needs for long-term memory;
 * - **raw platform content** (chat `content`, `emotes`) which is the sensitive
 *   part and is removed after the configured retention window.
 *
 * The default window is deliberately conservative (30 days) and configurable.
 * Deletion only clears the message text; rows, counts, identities and money stay
 * intact, so long-term statistics do not silently change.
 *
 * This module is platform-parameterised but only YouTube is enforced by default:
 * Bilibili data is not governed by Google's policy and its existing behaviour is
 * left untouched.
 */

import {refreshMemoryEvidence} from './repositories/viewer-memory.mjs';

export const DEFAULT_YOUTUBE_RAW_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
/**
 * The Google/YouTube developer policies cap retention of API data at 30
 * calendar days. A larger window is therefore not offered: the previous 3650-day
 * maximum contradicted the policy the application claims to enforce.
 */
export const MAX_RETENTION_DAYS = 30;

export function normalizeRetentionDays(value, fallback = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  const rounded = Math.trunc(days);
  if (rounded < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (rounded > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return rounded;
}

export function retentionCutoff(now, days) {
  return Math.trunc(Number(now)) - normalizeRetentionDays(days) * 86400_000;
}

function platformClause(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) return {sql: '1 = 1', params: []};
  return {
    sql: `platform IN (${platforms.map(() => '?').join(', ')})`,
    params: platforms.map(String)
  };
}

/** How many raw chat bodies would be removed right now. */
export function countExpiredRawEvents(db, {now = Date.now(), days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS, platforms = ['youtube']} = {}) {
  const cutoff = retentionCutoff(now, days);
  const clause = platformClause(platforms);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM events
     WHERE ${clause.sql}
       AND received_at < ?
       AND (content IS NOT NULL OR emotes IS NOT NULL OR badges IS NOT NULL OR amount_display IS NOT NULL)
  `).get(...clause.params, cutoff);
  return Number(row?.count ?? 0);
}

/**
 * Remove raw chat text/emotes older than the retention window.
 * Keeps the row, the identity, the counts and the monetary totals.
 */
export function purgeExpiredRawEvents(db, {
  now = Date.now(),
  days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS,
  platforms = ['youtube'],
  dryRun = false
} = {}) {
  const cutoff = retentionCutoff(now, days);
  const clause = platformClause(platforms);
  if (dryRun) {
    return {purged: countExpiredRawEvents(db, {now, days, platforms}), cutoff, dryRun: true};
  }
  const result = db.prepare(`
    UPDATE events
       SET content = NULL,
           emotes = NULL,
           badges = NULL,
           amount_display = NULL,
           content_purged_at = ?
     WHERE ${clause.sql}
       AND received_at < ?
       AND (content IS NOT NULL OR emotes IS NOT NULL OR badges IS NOT NULL OR amount_display IS NOT NULL)
  `).run(now, ...clause.params, cutoff);
  return {purged: Number(result.changes ?? 0), cutoff, dryRun: false};
}

/**
 * Nicknames are API data too. Once a YouTube viewer has not been seen for the
 * whole retention window, remove their nickname history and current nickname.
 * The pseudonymous channel id, event counts and monetary totals stay as derived
 * aggregates so long-term statistics do not silently change.
 */
export function purgeExpiredYouTubeNicknames(db, {now = Date.now(), days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS} = {}) {
  const cutoff = retentionCutoff(now, days);
  const stale = db.prepare(`
    SELECT id FROM viewers
     WHERE platform = 'youtube'
       AND last_seen_at < ?
  `).all(cutoff).map((row) => row.id);
  if (stale.length === 0) return {purgedNicknames: 0, clearedViewerNicknames: 0, cutoff};
  const placeholders = stale.map(() => '?').join(', ');
  const nicknames = db.prepare(`
    DELETE FROM viewer_nicknames WHERE viewer_id IN (${placeholders})
  `).run(...stale);
  const cleared = db.prepare(`
    UPDATE viewers SET nickname = NULL, updated_at = ?
     WHERE id IN (${placeholders}) AND nickname IS NOT NULL
  `).run(now, ...stale);
  return {
    purgedNicknames: Number(nicknames.changes ?? 0),
    clearedViewerNicknames: Number(cleared.changes ?? 0),
    cutoff
  };
}

function readMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(String(key));
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function writeMeta(db, key, value, now) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), JSON.stringify(value), Math.trunc(Number(now)));
}

/**
 * Run the policy at startup and after a session ends.
 * A failed purge must never prevent the application from starting.
 */
export function runRetention(db, {now = Date.now(), days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS, platforms = ['youtube'], logger = null} = {}) {
  try {
    const result = purgeExpiredRawEvents(db, {now, days, platforms});
    const nicknameResult = purgeExpiredYouTubeNicknames(db, {now, days});
    // Long-term memory may cite messages that were just purged or events that
    // were deleted. The memory itself is kept; its evidence is downgraded so the
    // profile stops claiming that a now-unreadable chat line proves something.
    let memoryEvidence = null;
    try {
      memoryEvidence = refreshMemoryEvidence(db, {now}).length;
    } catch (error) {
      memoryEvidence = null;
      logger?.warn({event: 'retention.memory_evidence_failed', code: error?.code ?? 'unknown'});
    }
    const summary = {
      at: Math.trunc(Number(now)),
      days: normalizeRetentionDays(days),
      platforms,
      purged: result.purged,
      purgedNicknames: nicknameResult.purgedNicknames,
      clearedViewerNicknames: nicknameResult.clearedViewerNicknames,
      memoryFactsRechecked: memoryEvidence,
      cutoff: result.cutoff
    };
    writeMeta(db, 'retention.lastRun', summary, now);
    if (result.purged > 0 || nicknameResult.purgedNicknames > 0) {
      logger?.info({
        event: 'retention.purged',
        count: result.purged,
        nicknames: nicknameResult.purgedNicknames,
        days: summary.days
      });
    }
    return summary;
  } catch (error) {
    logger?.warn({event: 'retention.failed', code: error?.code ?? 'unknown'});
    return null;
  }
}

export function retentionStatus(db, {days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS, now = Date.now()} = {}) {
  const last = readMeta(db, 'retention.lastRun');
  const cutoff = retentionCutoff(now, days);
  const staleNicknames = db.prepare(`
    SELECT COUNT(*) AS count FROM viewers
     WHERE platform = 'youtube' AND last_seen_at < ? AND nickname IS NOT NULL
  `).get(cutoff);
  return {
    policy: 'youtube-raw-content',
    days: normalizeRetentionDays(days),
    maxDays: MAX_RETENTION_DAYS,
    pendingPurge: countExpiredRawEvents(db, {now, days, platforms: ['youtube']}),
    pendingNicknamePurge: Number(staleNicknames?.count ?? 0),
    lastRun: last
  };
}

export const __internal = {platformClause, readMeta, writeMeta};
