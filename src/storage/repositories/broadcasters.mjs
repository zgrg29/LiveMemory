import {isMessageEvent, isPaymentEvent} from '../../shared/events.mjs';
import {BROADCASTER_IDENTITY, isKnownBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {countableValueKind} from './viewers.mjs';

/**
 * Broadcaster persistence and the broadcaster × viewer interaction context.
 *
 * Identity rule: one broadcaster per stable channel (`platform:uid`). A viewer
 * is still one global platform identity, but every pair has its own counters
 * and per-currency totals. Reads never add different broadcasters together
 * unless the caller explicitly asks for the global view.
 */

const UPSERT_BROADCASTER = `
  INSERT INTO broadcasters (
    id, platform, platform_uid, display_name, identity_quality,
    first_seen_at, last_seen_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, broadcasters.display_name),
    identity_quality = CASE
      WHEN broadcasters.identity_quality = 'unresolved' THEN excluded.identity_quality
      WHEN excluded.identity_quality = 'verified' THEN 'verified'
      ELSE broadcasters.identity_quality
    END,
    first_seen_at = MIN(broadcasters.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(broadcasters.last_seen_at, excluded.last_seen_at),
    updated_at = MAX(broadcasters.updated_at, excluded.updated_at)
`;

const UPSERT_VIEWER_BROADCASTER = `
  INSERT INTO viewer_broadcasters (
    viewer_id, broadcaster_id, message_count, payment_event_count,
    first_seen_at, last_seen_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (viewer_id, broadcaster_id) DO UPDATE SET
    message_count = viewer_broadcasters.message_count + excluded.message_count,
    payment_event_count = viewer_broadcasters.payment_event_count + excluded.payment_event_count,
    first_seen_at = MIN(viewer_broadcasters.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(viewer_broadcasters.last_seen_at, excluded.last_seen_at),
    updated_at = MAX(viewer_broadcasters.updated_at, excluded.updated_at)
`;

const UPSERT_VIEWER_BROADCASTER_TOTAL = `
  INSERT INTO viewer_broadcaster_currency_totals (
    viewer_id, broadcaster_id, currency, value_kind, total_minor, event_count
  ) VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT (viewer_id, broadcaster_id, currency, value_kind) DO UPDATE SET
    total_minor = viewer_broadcaster_currency_totals.total_minor + excluded.total_minor,
    event_count = viewer_broadcaster_currency_totals.event_count + 1
`;

export function upsertBroadcaster(db, {
  id,
  platform,
  platformUid,
  displayName = null,
  identity = BROADCASTER_IDENTITY.VERIFIED,
  seenAt = Date.now(),
  now = seenAt
} = {}) {
  if (!id) return false;
  db.prepare(UPSERT_BROADCASTER).run(
    String(id),
    String(platform),
    String(platformUid),
    displayName === null || displayName === undefined ? null : String(displayName),
    isKnownBroadcasterIdentity(identity) ? identity : BROADCASTER_IDENTITY.VERIFIED,
    seenAt,
    seenAt,
    now,
    now
  );
  return true;
}

export function getBroadcaster(db, broadcasterId) {
  return db.prepare(`
    SELECT b.*,
           (SELECT COUNT(*) FROM sessions s WHERE s.broadcaster_id = b.id) AS session_count,
           (SELECT COUNT(*) FROM viewer_broadcasters vb WHERE vb.broadcaster_id = b.id) AS viewer_count,
           (SELECT MAX(s.started_at) FROM sessions s WHERE s.broadcaster_id = b.id) AS last_session_at
      FROM broadcasters b
     WHERE b.id = ?
  `).get(String(broadcasterId)) ?? null;
}

export function listBroadcasters(db, {query = '', limit = 200} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const text = String(query ?? '').trim().slice(0, 80);
  const clauses = [];
  const params = [];
  if (text) {
    clauses.push('(b.display_name LIKE ? OR b.platform_uid LIKE ? OR b.id LIKE ?)');
    params.push(`%${text}%`, `%${text}%`, `%${text}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit);
  return db.prepare(`
    SELECT b.*,
           (SELECT COUNT(*) FROM sessions s WHERE s.broadcaster_id = b.id) AS session_count,
           (SELECT COUNT(*) FROM viewer_broadcasters vb WHERE vb.broadcaster_id = b.id) AS viewer_count,
           (SELECT MAX(s.started_at) FROM sessions s WHERE s.broadcaster_id = b.id) AS last_session_at
      FROM broadcasters b
      ${where}
     ORDER BY b.last_seen_at DESC, b.display_name
     LIMIT ?
  `).all(...params);
}

/**
 * The broadcaster a viewer page should preselect: the one recording right now,
 * otherwise the most recent real (non-simulated) channel, otherwise any.
 */
export function currentBroadcasterId(db) {
  const live = db.prepare(`
    SELECT broadcaster_id FROM sessions
     WHERE status = 'live' AND broadcaster_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `).get();
  if (live?.broadcaster_id) return live.broadcaster_id;
  const real = db.prepare(`
    SELECT broadcaster_id FROM sessions
     WHERE broadcaster_id IS NOT NULL AND platform <> 'mock'
     ORDER BY started_at DESC LIMIT 1
  `).get();
  if (real?.broadcaster_id) return real.broadcaster_id;
  const any = db.prepare(`
    SELECT broadcaster_id FROM sessions
     WHERE broadcaster_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `).get();
  return any?.broadcaster_id ?? null;
}

/** Sessions that could not be attributed to a broadcaster (legacy history). */
export function unassignedOverview(db) {
  const sessions = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE broadcaster_id IS NULL').get();
  const viewers = db.prepare(`
    SELECT COUNT(DISTINCT vs.viewer_id) AS count
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
     WHERE s.broadcaster_id IS NULL
  `).get();
  return {
    sessionCount: Number(sessions?.count ?? 0),
    viewerCount: Number(viewers?.count ?? 0)
  };
}

/** Add one event to the broadcaster × viewer context. */
export function recordViewerBroadcasterActivity(db, event, {
  broadcasterId,
  now = Date.now()
} = {}) {
  if (!event.viewer_id || !broadcasterId) return false;
  const messageDelta = isMessageEvent(event.event_type) ? 1 : 0;
  const paymentDelta = isPaymentEvent(event.event_type) && event.is_paid ? 1 : 0;
  db.prepare(UPSERT_VIEWER_BROADCASTER).run(
    event.viewer_id,
    String(broadcasterId),
    messageDelta,
    paymentDelta,
    event.occurred_at,
    event.occurred_at,
    now,
    now
  );
  const valueKind = countableValueKind(event.value_kind);
  const amount = Number(event.amount_minor ?? 0);
  if (event.is_paid && valueKind && Number.isSafeInteger(amount) && amount > 0) {
    db.prepare(UPSERT_VIEWER_BROADCASTER_TOTAL).run(
      event.viewer_id,
      String(broadcasterId),
      event.currency,
      valueKind,
      amount
    );
  }
  return true;
}

const ORDER_BY = Object.freeze({
  messages: 'vb.message_count DESC, vb.last_seen_at DESC',
  sessions: 'scoped_session_count DESC, vb.message_count DESC',
  support: 'vb.payment_event_count DESC, vb.last_seen_at DESC',
  recent: 'vb.last_seen_at DESC',
  newest: 'vb.first_seen_at DESC'
});

/**
 * Viewers scoped to one broadcaster. Counters in the returned rows are scoped:
 * they never include activity from other broadcasters.
 */
export function listBroadcasterViewers(db, broadcasterId, {
  query = '',
  limit = 200,
  offset = 0,
  sort = 'messages'
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const order = ORDER_BY[sort] ?? ORDER_BY.messages;
  const text = String(query ?? '').trim().slice(0, 80);
  const clauses = ['vb.broadcaster_id = ?'];
  const params = [String(broadcasterId)];
  if (text) {
    clauses.push('(v.nickname LIKE ? OR v.platform_uid LIKE ? OR v.id LIKE ?)');
    params.push(`%${text}%`, `%${text}%`, `%${text}%`);
  }
  params.push(safeLimit, safeOffset);
  return db.prepare(`
    SELECT v.id, v.platform, v.platform_uid, v.nickname, v.focused,
           v.first_seen_at, v.last_seen_at,
           v.message_count AS lifetime_message_count,
           v.payment_event_count AS lifetime_payment_event_count,
           (SELECT COUNT(*) FROM viewer_sessions life WHERE life.viewer_id = v.id) AS lifetime_session_count,
           vb.message_count AS scoped_message_count,
           vb.payment_event_count AS scoped_payment_event_count,
           vb.first_seen_at AS scoped_first_seen_at,
           vb.last_seen_at AS scoped_last_seen_at,
           (SELECT COUNT(*)
              FROM viewer_sessions vs
              JOIN sessions s ON s.id = vs.session_id
             WHERE vs.viewer_id = vb.viewer_id
               AND s.broadcaster_id = vb.broadcaster_id) AS scoped_session_count,
           (SELECT COUNT(*) FROM viewer_broadcasters other WHERE other.viewer_id = v.id) AS broadcaster_count
      FROM viewer_broadcasters vb
      JOIN viewers v ON v.id = vb.viewer_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${order}
     LIMIT ? OFFSET ?
  `).all(...params);
}

/** Viewers whose only recorded context is an unattributed legacy session. */
export function listUnassignedViewers(db, {query = '', limit = 200} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const text = String(query ?? '').trim().slice(0, 80);
  const clauses = ['s.broadcaster_id IS NULL'];
  const params = [];
  if (text) {
    clauses.push('(v.nickname LIKE ? OR v.platform_uid LIKE ? OR v.id LIKE ?)');
    params.push(`%${text}%`, `%${text}%`, `%${text}%`);
  }
  params.push(safeLimit);
  return db.prepare(`
    SELECT v.id, v.platform, v.platform_uid, v.nickname, v.focused,
           v.first_seen_at, v.last_seen_at,
           v.message_count AS lifetime_message_count,
           v.payment_event_count AS lifetime_payment_event_count,
           (SELECT COUNT(*) FROM viewer_sessions life WHERE life.viewer_id = v.id) AS lifetime_session_count,
           SUM(vs.message_count) AS scoped_message_count,
           SUM(vs.payment_event_count) AS scoped_payment_event_count,
           MIN(vs.first_seen_at) AS scoped_first_seen_at,
           MAX(vs.last_seen_at) AS scoped_last_seen_at,
           COUNT(DISTINCT vs.session_id) AS scoped_session_count,
           (SELECT COUNT(*) FROM viewer_broadcasters other WHERE other.viewer_id = v.id) AS broadcaster_count
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
      JOIN viewers v ON v.id = vs.viewer_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY v.id
     ORDER BY scoped_message_count DESC, v.last_seen_at DESC
     LIMIT ?
  `).all(...params);
}

export function viewerBroadcasters(db, viewerId) {
  return db.prepare(`
    SELECT vb.viewer_id, vb.broadcaster_id,
           b.platform, b.platform_uid, b.display_name, b.identity_quality,
           vb.message_count, vb.payment_event_count,
           vb.first_seen_at, vb.last_seen_at,
           (SELECT COUNT(*)
              FROM viewer_sessions vs
              JOIN sessions s ON s.id = vs.session_id
             WHERE vs.viewer_id = vb.viewer_id
               AND s.broadcaster_id = vb.broadcaster_id) AS session_count,
           (SELECT MAX(s.started_at)
              FROM viewer_sessions vs
              JOIN sessions s ON s.id = vs.session_id
             WHERE vs.viewer_id = vb.viewer_id
               AND s.broadcaster_id = vb.broadcaster_id) AS last_session_at
      FROM viewer_broadcasters vb
      JOIN broadcasters b ON b.id = vb.broadcaster_id
     WHERE vb.viewer_id = ?
     ORDER BY vb.last_seen_at DESC
  `).all(String(viewerId));
}

/** Context rows for many viewers of one broadcaster (AI package export). */
export function broadcasterViewerContexts(db, broadcasterId, viewerIds) {
  const ids = [...new Set((viewerIds ?? []).map(String))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT vb.viewer_id, vb.message_count, vb.payment_event_count,
           vb.first_seen_at, vb.last_seen_at,
           (SELECT COUNT(*)
              FROM viewer_sessions vs
              JOIN sessions s ON s.id = vs.session_id
             WHERE vs.viewer_id = vb.viewer_id
               AND s.broadcaster_id = vb.broadcaster_id) AS session_count,
           (SELECT COUNT(*) FROM viewer_broadcasters other
             WHERE other.viewer_id = vb.viewer_id) AS broadcaster_count
      FROM viewer_broadcasters vb
     WHERE vb.broadcaster_id = ? AND vb.viewer_id IN (${placeholders})
  `).all(String(broadcasterId), ...ids);
  return new Map(rows.map((row) => [row.viewer_id, row]));
}

export function viewerBroadcasterRow(db, viewerId, broadcasterId) {
  return db.prepare(`
    SELECT vb.*, b.platform, b.platform_uid, b.display_name, b.identity_quality,
           (SELECT COUNT(*)
              FROM viewer_sessions vs
              JOIN sessions s ON s.id = vs.session_id
             WHERE vs.viewer_id = vb.viewer_id
               AND s.broadcaster_id = vb.broadcaster_id) AS session_count
      FROM viewer_broadcasters vb
      JOIN broadcasters b ON b.id = vb.broadcaster_id
     WHERE vb.viewer_id = ? AND vb.broadcaster_id = ?
  `).get(String(viewerId), String(broadcasterId)) ?? null;
}

export function viewerBroadcasterSupport(db, viewerId, broadcasterId) {
  return db.prepare(`
    SELECT currency, value_kind, total_minor, event_count
      FROM viewer_broadcaster_currency_totals
     WHERE viewer_id = ? AND broadcaster_id = ?
     ORDER BY currency, value_kind
  `).all(String(viewerId), String(broadcasterId));
}

export function viewerBroadcasterSessions(db, viewerId, broadcasterId, {limit = 20} = {}) {
  return db.prepare(`
    SELECT vs.session_id, vs.message_count, vs.payment_event_count,
           vs.first_seen_at, vs.last_seen_at,
           s.room_title, s.platform, s.started_at, s.ended_at, s.status
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
     WHERE vs.viewer_id = ? AND s.broadcaster_id = ?
     ORDER BY vs.last_seen_at DESC
     LIMIT ?
  `).all(
    String(viewerId),
    String(broadcasterId),
    Math.min(Math.max(Number(limit) || 20, 1), 100)
  );
}

/** Totals grouped by currency/value_kind for every viewer of a broadcaster. */
export function broadcasterSupportTotals(db, broadcasterId) {
  return db.prepare(`
    SELECT currency, value_kind, SUM(total_minor) AS total_minor,
           SUM(event_count) AS event_count
      FROM viewer_broadcaster_currency_totals
     WHERE broadcaster_id = ?
     GROUP BY currency, value_kind
     ORDER BY currency, value_kind
  `).all(String(broadcasterId));
}

/** Support map for a list of viewers inside one broadcaster's context. */
export function broadcasterSupportByViewerIds(db, broadcasterId, viewerIds) {
  const ids = [...new Set((viewerIds ?? []).map(String))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT viewer_id AS owner_id, currency, value_kind, total_minor, event_count
      FROM viewer_broadcaster_currency_totals
     WHERE broadcaster_id = ? AND viewer_id IN (${placeholders})
  `).all(String(broadcasterId), ...ids);
  return groupByOwner(rows);
}

/** Support map for viewers in the unattributed legacy scope. */
export function unassignedSupportByViewerIds(db, viewerIds) {
  const ids = [...new Set((viewerIds ?? []).map(String))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT e.viewer_id AS owner_id, e.currency, e.value_kind,
           SUM(e.amount_minor) AS total_minor, COUNT(*) AS event_count
      FROM events e
      JOIN sessions s ON s.id = e.session_id
     WHERE s.broadcaster_id IS NULL
       AND e.viewer_id IN (${placeholders})
       AND e.is_paid = 1
       AND e.amount_minor > 0
       AND e.value_kind IN ('actual', 'display')
       AND e.currency IS NOT NULL
     GROUP BY e.viewer_id, e.currency, e.value_kind
  `).all(...ids);
  return groupByOwner(rows);
}

/** Support for a single viewer in the unattributed legacy scope. */
export function unassignedViewerSupport(db, viewerId) {
  return db.prepare(`
    SELECT e.currency, e.value_kind, SUM(e.amount_minor) AS total_minor, COUNT(*) AS event_count
      FROM events e
      JOIN sessions s ON s.id = e.session_id
     WHERE s.broadcaster_id IS NULL
       AND e.viewer_id = ?
       AND e.is_paid = 1
       AND e.amount_minor > 0
       AND e.value_kind IN ('actual', 'display')
       AND e.currency IS NOT NULL
     GROUP BY e.currency, e.value_kind
     ORDER BY e.currency, e.value_kind
  `).all(String(viewerId));
}

/** One viewer's activity inside unattributed legacy sessions. */
export function unassignedViewerStats(db, viewerId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(vs.message_count), 0) AS message_count,
           COALESCE(SUM(vs.payment_event_count), 0) AS payment_event_count,
           MIN(vs.first_seen_at) AS first_seen_at,
           MAX(vs.last_seen_at) AS last_seen_at,
           COUNT(DISTINCT vs.session_id) AS session_count
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
     WHERE s.broadcaster_id IS NULL AND vs.viewer_id = ?
  `).get(String(viewerId));
  return {
    messageCount: Number(row?.message_count ?? 0),
    paymentEventCount: Number(row?.payment_event_count ?? 0),
    firstSeenAt: row?.first_seen_at ?? null,
    lastSeenAt: row?.last_seen_at ?? null,
    sessionCount: Number(row?.session_count ?? 0)
  };
}

export function unassignedViewerSessions(db, viewerId, {limit = 20} = {}) {
  return db.prepare(`
    SELECT vs.session_id, vs.message_count, vs.payment_event_count,
           vs.first_seen_at, vs.last_seen_at,
           s.room_title, s.platform, s.started_at, s.ended_at, s.status
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
     WHERE vs.viewer_id = ? AND s.broadcaster_id IS NULL
     ORDER BY vs.last_seen_at DESC
     LIMIT ?
  `).all(String(viewerId), Math.min(Math.max(Number(limit) || 20, 1), 100));
}

/** Audience summary for the selected broadcaster, including new vs returning. */
export function broadcasterAudienceSummary(db, broadcasterId) {
  const broadcaster = getBroadcaster(db, broadcasterId);
  if (!broadcaster) return null;
  const latest = db.prepare(`
    SELECT id, started_at, ended_at FROM sessions
     WHERE broadcaster_id = ?
     ORDER BY started_at DESC LIMIT 1
  `).get(String(broadcasterId)) ?? null;
  const totals = db.prepare(`
    SELECT COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(SUM(payment_event_count), 0) AS payment_event_count
      FROM viewer_broadcasters WHERE broadcaster_id = ?
  `).get(String(broadcasterId));
  const fresh = latest
    ? db.prepare(`
        SELECT COUNT(*) AS count FROM viewer_broadcasters
         WHERE broadcaster_id = ? AND first_seen_at >= ?
      `).get(String(broadcasterId), latest.started_at)
    : {count: 0};
  return {
    broadcaster,
    viewerCount: Number(broadcaster.viewer_count ?? 0),
    sessionCount: Number(broadcaster.session_count ?? 0),
    messageCount: Number(totals?.message_count ?? 0),
    paymentEventCount: Number(totals?.payment_event_count ?? 0),
    latestSession: latest,
    newViewers: Number(fresh?.count ?? 0),
    returningViewers: Math.max(0, Number(broadcaster.viewer_count ?? 0) - Number(fresh?.count ?? 0))
  };
}

function groupByOwner(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.owner_id) ?? [];
    list.push({
      currency: row.currency,
      value_kind: row.value_kind,
      total_minor: row.total_minor,
      event_count: row.event_count
    });
    map.set(row.owner_id, list);
  }
  return map;
}

export const __internal = {ORDER_BY, UPSERT_BROADCASTER, UPSERT_VIEWER_BROADCASTER};
