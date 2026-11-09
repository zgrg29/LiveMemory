import {isMessageEvent, isPaymentEvent} from '../../shared/events.mjs';

/**
 * Viewer persistence and long-term aggregates.
 *
 * Identity rule: a viewer is `platform:stable_user_id`. A nickname is only a
 * display label that changes over time; it is never used to merge people.
 * Events without a stable id still count towards session totals, but they never
 * create or mutate a viewer profile.
 */

const UPSERT_VIEWER = `
  INSERT INTO viewers (
    id, platform, platform_uid, nickname, first_seen_at, last_seen_at,
    message_count, payment_event_count, focused, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    nickname = COALESCE(excluded.nickname, viewers.nickname),
    last_seen_at = MAX(viewers.last_seen_at, excluded.last_seen_at),
    message_count = viewers.message_count + excluded.message_count,
    payment_event_count = viewers.payment_event_count + excluded.payment_event_count,
    updated_at = excluded.updated_at
`;

const UPSERT_NICKNAME = `
  INSERT INTO viewer_nicknames (viewer_id, nickname, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (viewer_id, nickname) DO UPDATE SET
    first_seen_at = MIN(viewer_nicknames.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(viewer_nicknames.last_seen_at, excluded.last_seen_at)
`;

const UPSERT_VIEWER_SESSION = `
  INSERT INTO viewer_sessions (
    viewer_id, session_id, message_count, payment_event_count, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (viewer_id, session_id) DO UPDATE SET
    message_count = viewer_sessions.message_count + excluded.message_count,
    payment_event_count = viewer_sessions.payment_event_count + excluded.payment_event_count,
    first_seen_at = MIN(viewer_sessions.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(viewer_sessions.last_seen_at, excluded.last_seen_at)
`;

const UPSERT_VIEWER_TOTAL = `
  INSERT INTO viewer_currency_totals (viewer_id, currency, value_kind, total_minor, event_count)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT (viewer_id, currency, value_kind) DO UPDATE SET
    total_minor = viewer_currency_totals.total_minor + excluded.total_minor,
    event_count = viewer_currency_totals.event_count + 1
`;

const UPSERT_SESSION_TOTAL = `
  INSERT INTO session_currency_totals (session_id, currency, value_kind, total_minor, event_count)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT (session_id, currency, value_kind) DO UPDATE SET
    total_minor = session_currency_totals.total_minor + excluded.total_minor,
    event_count = session_currency_totals.event_count + 1
`;

/** Countable value kinds. "unknown" amounts are never aggregated as money. */
export function countableValueKind(valueKind) {
  return valueKind === 'actual' || valueKind === 'display' ? valueKind : null;
}

/**
 * Make sure the viewer row exists before an event references it.
 * Counters are added later by recordViewerActivity, only for inserted events,
 * so re-delivered duplicates never inflate totals.
 */
const ENSURE_VIEWER = `
  INSERT INTO viewers (
    id, platform, platform_uid, nickname, first_seen_at, last_seen_at,
    message_count, payment_event_count, focused, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  ON CONFLICT (id) DO NOTHING
`;

export function ensureViewer(db, event, {now = Date.now()} = {}) {
  if (!event.viewer_id) return false;
  db.prepare(ENSURE_VIEWER).run(
    event.viewer_id,
    event.platform,
    String(event.viewer_uid),
    event.display_name ?? null,
    event.occurred_at,
    event.occurred_at,
    now,
    now
  );
  return true;
}

export function recordViewerActivity(db, event, {now = Date.now(), sessionId = event.session_id} = {}) {
  if (!event.viewer_id) return false;
  const messageDelta = isMessageEvent(event.event_type) ? 1 : 0;
  // Only an actually paid event counts towards a viewer's payment history. The
  // recipient of a gifted membership must never look like a payer.
  const paymentDelta = isPaymentEvent(event.event_type) && event.is_paid ? 1 : 0;
  db.prepare(UPSERT_VIEWER).run(
    event.viewer_id,
    event.platform,
    String(event.viewer_uid),
    event.display_name ?? null,
    event.occurred_at,
    event.occurred_at,
    messageDelta,
    paymentDelta,
    now,
    now
  );
  if (event.display_name) {
    db.prepare(UPSERT_NICKNAME).run(event.viewer_id, event.display_name, event.occurred_at, event.occurred_at);
  }
  if (sessionId) {
    db.prepare(UPSERT_VIEWER_SESSION).run(
      event.viewer_id,
      String(sessionId),
      messageDelta,
      paymentDelta,
      event.occurred_at,
      event.occurred_at
    );
  }
  const valueKind = countableValueKind(event.value_kind);
  const amount = Number(event.amount_minor ?? 0);
  if (event.is_paid && valueKind && Number.isSafeInteger(amount) && amount > 0) {
    db.prepare(UPSERT_VIEWER_TOTAL).run(event.viewer_id, event.currency, valueKind, amount);
  }
  return true;
}

export function recordSessionPayment(db, event) {
  const valueKind = countableValueKind(event.value_kind);
  const amount = Number(event.amount_minor ?? 0);
  if (!event.is_paid || !valueKind || !Number.isSafeInteger(amount) || amount <= 0) return false;
  db.prepare(UPSERT_SESSION_TOTAL).run(event.session_id, event.currency, valueKind, amount);
  return true;
}

export function listViewers(db, {query = '', limit = 50, offset = 0, platform = null} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = [];
  const params = [];
  const text = String(query ?? '').trim().slice(0, 80);
  if (text) {
    clauses.push('v.nickname LIKE ?');
    params.push(`%${text}%`);
  }
  if (platform) {
    clauses.push('v.platform = ?');
    params.push(String(platform));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit, safeOffset);
  return db.prepare(`
    SELECT v.*,
           (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.viewer_id = v.id) AS session_count,
           (SELECT COUNT(*) FROM viewer_nicknames vn WHERE vn.viewer_id = v.id) AS nickname_count,
           (SELECT COUNT(*) FROM viewer_broadcasters vb WHERE vb.viewer_id = v.id) AS broadcaster_count
      FROM viewers v
      ${where}
     ORDER BY v.last_seen_at DESC
     LIMIT ? OFFSET ?
  `).all(...params);
}

export function getViewer(db, viewerId) {
  return db.prepare(`
    SELECT v.*,
           (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.viewer_id = v.id) AS session_count
      FROM viewers v WHERE v.id = ?
  `).get(String(viewerId)) ?? null;
}

export function viewerCurrencyTotals(db, viewerId) {
  return db.prepare(`
    SELECT currency, value_kind, total_minor, event_count
      FROM viewer_currency_totals
     WHERE viewer_id = ?
     ORDER BY currency, value_kind
  `).all(String(viewerId));
}

export function sessionCurrencyTotals(db, sessionId) {
  return db.prepare(`
    SELECT currency, value_kind, total_minor, event_count
      FROM session_currency_totals
     WHERE session_id = ?
     ORDER BY currency, value_kind
  `).all(String(sessionId));
}

export function viewerNicknameHistory(db, viewerId) {
  return db.prepare(`
    SELECT nickname, first_seen_at, last_seen_at
      FROM viewer_nicknames
     WHERE viewer_id = ?
     ORDER BY last_seen_at DESC
  `).all(String(viewerId));
}

export function viewerSessionHistory(db, viewerId, {limit = 20} = {}) {
  return db.prepare(`
    SELECT vs.session_id, vs.message_count, vs.payment_event_count,
           vs.first_seen_at, vs.last_seen_at,
           s.room_title, s.platform, s.started_at, s.ended_at, s.status
      FROM viewer_sessions vs
      JOIN sessions s ON s.id = vs.session_id
     WHERE vs.viewer_id = ?
     ORDER BY vs.last_seen_at DESC
     LIMIT ?
  `).all(String(viewerId), Math.min(Math.max(Number(limit) || 20, 1), 100));
}

/**
 * One viewer's participation row in one session. Returns null when the viewer
 * has no recorded participation there (for example after the session was
 * deleted), so callers never invent a relationship.
 */
export function viewerSessionStats(db, sessionId, viewerId) {
  const row = db.prepare(`
    SELECT vs.session_id, vs.viewer_id, vs.message_count, vs.payment_event_count,
           vs.first_seen_at, vs.last_seen_at
      FROM viewer_sessions vs
     WHERE vs.session_id = ? AND vs.viewer_id = ?
  `).get(String(sessionId), String(viewerId));
  if (!row) return null;
  return {
    sessionId: row.session_id,
    viewerId: row.viewer_id,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null
  };
}

export function setViewerFocused(db, viewerId, focused, {now = Date.now()} = {}) {
  const result = db.prepare('UPDATE viewers SET focused = ?, updated_at = ? WHERE id = ?')
    .run(focused ? 1 : 0, now, String(viewerId));
  return result.changes > 0;
}

/** Everyone who took part in one session, with their lifetime aggregates. */
export function listSessionViewers(db, sessionId, {limit = 2000} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 20000);
  return db.prepare(`
    SELECT v.id AS viewer_id, v.platform, v.platform_uid, v.nickname,
           v.first_seen_at, v.last_seen_at, v.message_count, v.payment_event_count,
           (SELECT COUNT(*) FROM viewer_sessions all_vs WHERE all_vs.viewer_id = v.id) AS session_count,
           vs.message_count AS session_message_count,
           vs.payment_event_count AS session_payment_event_count,
           vs.first_seen_at AS session_first_seen_at,
           vs.last_seen_at AS session_last_seen_at
      FROM viewer_sessions vs
      JOIN viewers v ON v.id = vs.viewer_id
     WHERE vs.session_id = ?
     ORDER BY vs.message_count DESC, v.last_seen_at DESC
     LIMIT ?
  `).all(String(sessionId), safeLimit);
}

/** Totals for many sessions at once (avoids one query per history row). */
export function sessionSupportBySessionIds(db, sessionIds) {
  const ids = [...new Set((sessionIds ?? []).map(String))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT session_id AS owner_id, currency, value_kind, total_minor, event_count
      FROM session_currency_totals
     WHERE session_id IN (${placeholders})
  `).all(...ids);
  return groupTotalsByOwner(rows);
}

/** Totals for many viewers at once (viewer list page). */
export function viewerSupportByViewerIds(db, viewerIds) {
  const ids = [...new Set((viewerIds ?? []).map(String))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT viewer_id AS owner_id, currency, value_kind, total_minor, event_count
      FROM viewer_currency_totals
     WHERE viewer_id IN (${placeholders})
  `).all(...ids);
  return groupTotalsByOwner(rows);
}

function groupTotalsByOwner(rows) {
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

/**
 * Top speakers and supporters for a single session (read model).
 *
 * The speaker ranking is deliberately capped at 100 for the live leaderboard and
 * ordered by:
 *   1. valid messages in this session (chat + Super Chat),
 *   2. stable platform uid (never the nickname),
 *   3. viewer id.
 * The latter two only break ties, so equal message counts cannot swap places
 * between two refreshes and different people with the same nickname stay apart.
 */
export function topSessionViewers(db, sessionId, {limit = 5} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 100);
  const speakers = db.prepare(`
    SELECT vs.viewer_id, v.nickname, v.platform, v.platform_uid,
           vs.message_count, vs.payment_event_count,
           vs.last_seen_at
      FROM viewer_sessions vs
      JOIN viewers v ON v.id = vs.viewer_id
     WHERE vs.session_id = ? AND vs.message_count > 0
     ORDER BY vs.message_count DESC, v.platform_uid ASC, v.id ASC
     LIMIT ?
  `).all(String(sessionId), safeLimit);
  const supporters = db.prepare(`
    SELECT e.viewer_id,
           MAX(e.display_name) AS nickname,
           SUM(e.amount_minor) AS total_minor,
           MIN(e.currency) AS currency,
           COUNT(*) AS event_count
      FROM events e
     WHERE e.session_id = ?
       AND e.is_paid = 1
       AND e.amount_minor > 0
       AND e.value_kind = 'actual'
       AND e.viewer_id IS NOT NULL
     GROUP BY e.viewer_id
     ORDER BY total_minor DESC, e.viewer_id ASC
     LIMIT ?
  `).all(String(sessionId), Math.min(safeLimit, 20));
  return {speakers, supporters};
}

/**
 * Rebuild one viewer's derived aggregates from the rows that still exist.
 *
 * Used after permanently deleting a session: global counters, per-session
 * participation and currency totals must describe the remaining data only.
 * A viewer whose only evidence was the deleted session is removed, unless the
 * user explicitly marked them as important (`focused = 1`), which is treated as
 * independently retained user data. A viewer that still has raw events but no
 * `viewer_sessions` row (legacy or manually repaired data) is kept and rebuilt
 * from those events instead of being deleted.
 *
 * @returns {{kept:boolean, removed:boolean, sessionCount:number}}
 */
export function rebuildViewerAggregates(db, viewerId, {now = Date.now()} = {}) {
  const id = String(viewerId);
  const viewer = db.prepare('SELECT id, focused FROM viewers WHERE id = ?').get(id) ?? null;
  if (!viewer) return {kept: false, removed: false, sessionCount: 0};

  const sessionRow = db.prepare(`
    SELECT COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(SUM(payment_event_count), 0) AS payment_event_count,
           MIN(first_seen_at) AS first_seen_at,
           MAX(last_seen_at) AS last_seen_at,
           COUNT(*) AS session_count
      FROM viewer_sessions
     WHERE viewer_id = ?
  `).get(id);
  const sessionCount = Number(sessionRow?.session_count ?? 0);

  if (sessionCount === 0) {
    const eventRow = db.prepare(`
      SELECT COUNT(*) AS event_count,
             SUM(CASE WHEN event_type IN ('chat', 'super_chat') THEN 1 ELSE 0 END) AS message_count,
             SUM(CASE WHEN is_paid = 1 AND event_type IN
                   ('gift', 'super_chat', 'super_sticker', 'guard', 'membership')
                 THEN 1 ELSE 0 END) AS payment_event_count,
             MIN(occurred_at) AS first_seen_at,
             MAX(occurred_at) AS last_seen_at
        FROM events
       WHERE viewer_id = ?
    `).get(id);
    if (Number(eventRow?.event_count ?? 0) === 0) {
      if (Number(viewer.focused) === 1) {
        db.prepare('UPDATE viewers SET message_count = 0, payment_event_count = 0, updated_at = ? WHERE id = ?')
          .run(now, id);
        db.prepare('DELETE FROM viewer_currency_totals WHERE viewer_id = ?').run(id);
        return {kept: true, removed: false, sessionCount: 0};
      }
      db.prepare('DELETE FROM viewers WHERE id = ?').run(id);
      return {kept: false, removed: true, sessionCount: 0};
    }
    db.prepare(`
      UPDATE viewers
         SET message_count = ?, payment_event_count = ?,
             first_seen_at = COALESCE(?, first_seen_at),
             last_seen_at = COALESCE(?, last_seen_at),
             updated_at = ?
       WHERE id = ?
    `).run(
      Number(eventRow.message_count ?? 0),
      Number(eventRow.payment_event_count ?? 0),
      eventRow.first_seen_at ?? null,
      eventRow.last_seen_at ?? null,
      now,
      id
    );
  } else {
    db.prepare(`
      UPDATE viewers
         SET message_count = ?, payment_event_count = ?,
             first_seen_at = ?, last_seen_at = ?, updated_at = ?
       WHERE id = ?
    `).run(
      Number(sessionRow.message_count ?? 0),
      Number(sessionRow.payment_event_count ?? 0),
      Number(sessionRow.first_seen_at ?? now),
      Number(sessionRow.last_seen_at ?? now),
      now,
      id
    );
  }

  // Currency totals are derived from raw events, so they are rebuilt exactly
  // from the remaining paid events (same rules as the ingest path).
  db.prepare('DELETE FROM viewer_currency_totals WHERE viewer_id = ?').run(id);
  db.prepare(`
    INSERT INTO viewer_currency_totals (viewer_id, currency, value_kind, total_minor, event_count)
    SELECT viewer_id, currency, value_kind, SUM(amount_minor), COUNT(*)
      FROM events
     WHERE viewer_id = ?
       AND is_paid = 1
       AND amount_minor > 0
       AND value_kind IN ('actual', 'display')
       AND currency IS NOT NULL
     GROUP BY currency, value_kind
  `).run(id);
  return {kept: true, removed: false, sessionCount};
}

/** Number of viewers with at least one valid message in one session. */
export function countSessionSpeakers(db, sessionId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM viewer_sessions
     WHERE session_id = ? AND message_count > 0
  `).get(String(sessionId));
  return Number(row?.count ?? 0);
}
