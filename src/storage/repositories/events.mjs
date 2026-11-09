/**
 * Event persistence.
 *
 * The UNIQUE(session_id, dedupe_key) constraint is the last line of defence
 * against duplicated platform deliveries (reconnects, replays, double imports).
 * Inserts use OR IGNORE so a duplicate is silently skipped and never counted
 * twice in totals.
 */

import {parseEmotesJson, serializeEmotes} from '../../shared/emoticons.mjs';
import {parseBadgesJson, serializeBadges} from '../../shared/badges.mjs';

const INSERT_SQL = `
  INSERT OR IGNORE INTO events (
    session_id, platform, external_id, event_type, viewer_id, viewer_uid, display_name,
    occurred_at, received_at, content, emotes, badges, gift_id, gift_name, gift_type, gift_quantity,
    unit_amount_minor, amount_minor, amount_display, currency, value_kind, is_paid, source_quality, dedupe_key
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertEvent(db, event) {
  const result = db.prepare(INSERT_SQL).run(
    event.session_id,
    event.platform,
    event.external_id,
    event.event_type,
    event.viewer_id,
    event.viewer_uid,
    event.display_name,
    event.occurred_at,
    event.received_at,
    event.content,
    serializeEmotes(event.emotes),
    serializeBadges(event.badges),
    event.gift_id,
    event.gift_name,
    event.gift_type,
    event.gift_quantity,
    event.unit_amount_minor,
    event.amount_minor,
    event.amount_display,
    event.currency,
    event.value_kind,
    event.is_paid ? 1 : 0,
    event.source_quality,
    event.dedupe_key
  );
  return {
    inserted: result.changes > 0,
    rowId: Number(result.lastInsertRowid ?? 0)
  };
}

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    platform: row.platform,
    external_id: row.external_id,
    event_type: row.event_type,
    viewer_id: row.viewer_id,
    viewer_uid: row.viewer_uid,
    display_name: row.display_name,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    content: row.content,
    emotes: parseEmotesJson(row.emotes),
    badges: parseBadgesJson(row.badges),
    gift_id: row.gift_id,
    gift_name: row.gift_name,
    gift_type: row.gift_type,
    gift_quantity: row.gift_quantity,
    unit_amount_minor: row.unit_amount_minor,
    amount_minor: row.amount_minor,
    amount_display: row.amount_display,
    currency: row.currency,
    value_kind: row.value_kind,
    is_paid: row.is_paid === 1,
    source_quality: row.source_quality,
    content_purged_at: row.content_purged_at
  };
}

export function listEvents(db, {sessionId, limit = 50, beforeId = null, eventTypes = null} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const params = [String(sessionId)];
  let sql = 'SELECT * FROM events WHERE session_id = ?';
  if (beforeId !== null && beforeId !== undefined) {
    sql += ' AND id < ?';
    params.push(Number(beforeId));
  }
  if (Array.isArray(eventTypes) && eventTypes.length > 0) {
    sql += ` AND event_type IN (${eventTypes.map(() => '?').join(', ')})`;
    params.push(...eventTypes.map(String));
  }
  sql += ' ORDER BY occurred_at DESC, id DESC LIMIT ?';
  params.push(safeLimit);
  return db.prepare(sql).all(...params).map(mapEventRow);
}

export function recentEvents(db, sessionId, limit = 40) {
  return db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?'
  ).all(String(sessionId), Math.min(Math.max(Number(limit) || 40, 1), 500)).map(mapEventRow);
}

export function listTimelineRows(db, sessionId) {
  return db.prepare(`
    SELECT occurred_at, event_type, viewer_id, is_paid, amount_minor, currency, value_kind
      FROM events
     WHERE session_id = ?
     ORDER BY occurred_at ASC, id ASC
  `).all(String(sessionId));
}

/**
 * Ascending message list used by the AI analysis package. `seq` is assigned by
 * the caller so the model can reference messages by a small integer instead of
 * an internal row id.
 */
export function listSessionMessagesAsc(db, {sessionId, limit = 20000, offset = 0} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20000, 1), 50000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND event_type IN ('chat', 'super_chat')
     ORDER BY occurred_at ASC, id ASC
     LIMIT ? OFFSET ?
  `).all(String(sessionId), safeLimit, safeOffset).map(mapEventRow);
}

/** One event by row id, used to resolve AI evidence references. */
export function getEventById(db, eventId) {
  return mapEventRow(db.prepare('SELECT * FROM events WHERE id = ?').get(Number(eventId)));
}

/** Chat/Super Chat row count; the batching divisor. */
export function countSessionMessages(db, sessionId) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM events
     WHERE session_id = ? AND event_type IN ('chat', 'super_chat')
  `).get(String(sessionId))?.count ?? 0);
}

/**
 * A single viewer's messages inside one session (history drill-down).
 * Uses the (viewer_id, occurred_at) index so the session is never fully scanned
 * into the browser.
 */
export function listViewerSessionMessages(db, {sessionId, viewerId, limit = 50} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND viewer_id = ?
       AND event_type IN ('chat', 'super_chat')
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?
  `).all(String(sessionId), String(viewerId), safeLimit);
  return rows.reverse().map(mapEventRow);
}

export function eventSummaryCounts(db, sessionId) {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN event_type IN ('chat', 'super_chat') THEN 1 ELSE 0 END) AS messages,
      SUM(CASE WHEN event_type = 'gift' THEN 1 ELSE 0 END) AS gifts,
      SUM(CASE WHEN event_type IN ('super_chat', 'super_sticker', 'guard', 'membership') THEN 1 ELSE 0 END) AS memberships,
      COUNT(*) AS total
    FROM events
   WHERE session_id = ?
  `).get(String(sessionId)) ?? {messages: 0, gifts: 0, memberships: 0, total: 0};
}

/**
 * Compact storage mode: after a verified AI import the raw chat text is no
 * longer needed for accounting. Only the message body is removed; the row (and
 * therefore counts, identity and payments) stays intact.
 */
export function purgeSessionContent(db, sessionId, {now = Date.now()} = {}) {
  const result = db.prepare(`
    UPDATE events
       SET content = NULL,
           emotes = NULL,
           badges = NULL,
           amount_display = NULL,
           content_purged_at = ?
     WHERE session_id = ?
       AND (content IS NOT NULL OR emotes IS NOT NULL OR badges IS NOT NULL OR amount_display IS NOT NULL)
       AND event_type IN ('chat', 'super_chat')
  `).run(now, String(sessionId));
  return result.changes;
}

export function contentStats(db, sessionId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS with_content,
      SUM(LENGTH(COALESCE(content, ''))) AS content_bytes
    FROM events WHERE session_id = ?
  `).get(String(sessionId)) ?? {total: 0, with_content: 0, content_bytes: 0};
}
