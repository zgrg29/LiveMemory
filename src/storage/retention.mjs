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

export const DEFAULT_YOUTUBE_RAW_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

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
       AND (content IS NOT NULL OR emotes IS NOT NULL)
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
           content_purged_at = ?
     WHERE ${clause.sql}
       AND received_at < ?
       AND (content IS NOT NULL OR emotes IS NOT NULL)
  `).run(now, ...clause.params, cutoff);
  return {purged: Number(result.changes ?? 0), cutoff, dryRun: false};
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
    const summary = {
      at: Math.trunc(Number(now)),
      days: normalizeRetentionDays(days),
      platforms,
      purged: result.purged,
      cutoff: result.cutoff
    };
    writeMeta(db, 'retention.lastRun', summary, now);
    if (result.purged > 0) logger?.info({event: 'retention.purged', count: result.purged, days: summary.days});
    return summary;
  } catch (error) {
    logger?.warn({event: 'retention.failed', code: error?.code ?? 'unknown'});
    return null;
  }
}

export function retentionStatus(db, {days = DEFAULT_YOUTUBE_RAW_RETENTION_DAYS, now = Date.now()} = {}) {
  const last = readMeta(db, 'retention.lastRun');
  return {
    policy: 'youtube-raw-content',
    days: normalizeRetentionDays(days),
    pendingPurge: countExpiredRawEvents(db, {now, days, platforms: ['youtube']}),
    lastRun: last
  };
}

export const __internal = {platformClause, readMeta, writeMeta};
