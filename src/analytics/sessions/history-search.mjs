/**
 * Live-history search read model.
 *
 * One query surface answers three different questions without ever loading chat
 * rows into the browser:
 *
 *   1. broadcaster  — stable broadcaster id / platform uid / display name;
 *   2. title        — substring of the recorded stream title (CJK is just text,
 *                     so no word tokenizer is required);
 *   3. viewer       — stable platform id, or nickname / nickname history, mapped
 *                     to the sessions in which that identity participated.
 *
 * Identity rules are preserved: nickname search may return several *different*
 * identities, and each one is reported separately. A viewer id is never derived
 * from a nickname, and events without a stable id (viewer_id = NULL) are never
 * presented as a known participant.
 *
 * The query only touches sessions, viewers, viewer_nicknames, viewer_sessions
 * and (for broadcaster display names) broadcasters; it never scans `events`.
 */

export const HISTORY_SEARCH_SCOPES = Object.freeze(['all', 'broadcaster', 'title', 'viewer']);
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_LIMIT = 100;
export const HISTORY_MAX_QUERY = 120;
const MAX_VIEWER_CANDIDATES = 300;
const MAX_VIEWERS_PER_RESULT = 20;

const TITLE_PREDICATE = `(COALESCE(s.room_title, '') LIKE ? ESCAPE '\\')`;

const BROADCASTER_PREDICATE = `(
  COALESCE(s.broadcaster_name, '') LIKE ? ESCAPE '\\'
  OR COALESCE(s.broadcaster_id, '') LIKE ? ESCAPE '\\'
  OR EXISTS (
    SELECT 1
      FROM broadcasters b
     WHERE b.id = s.broadcaster_id
       AND (
         COALESCE(b.display_name, '') LIKE ? ESCAPE '\\'
         OR COALESCE(b.platform_uid, '') LIKE ? ESCAPE '\\'
         OR COALESCE(b.id, '') LIKE ? ESCAPE '\\'
       )
  )
)`;

const SESSION_COLUMNS = `
  s.*,
  (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.session_id = s.id) AS unique_viewer_count,
  (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
  (SELECT b.display_name FROM broadcasters b WHERE b.id = s.broadcaster_id) AS broadcaster_display_name,
  (SELECT b.platform_uid FROM broadcasters b WHERE b.id = s.broadcaster_id) AS broadcaster_platform_uid
`;

/** NFKC + whitespace normalisation; keeps CJK and mixed scripts intact. */
export function normalizeSearchQuery(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HISTORY_MAX_QUERY);
}

/** Escape LIKE wildcards so a literal `%` or `_` never matches everything. */
export function likePattern(value) {
  const escaped = String(value ?? '').replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

function titleParams(pattern) {
  return [pattern];
}

function broadcasterParams(pattern) {
  return [pattern, pattern, pattern, pattern, pattern];
}

function viewerPredicate(count) {
  const placeholders = Array.from({length: count}, () => '?').join(', ');
  return `EXISTS (
    SELECT 1 FROM viewer_sessions vs
     WHERE vs.session_id = s.id AND vs.viewer_id IN (${placeholders})
  )`;
}

/**
 * Resolve every identity whose nickname (current or historical) or stable id
 * matches the term. Multiple rows mean multiple identities, never one merged
 * person.
 */
export function resolveViewerCandidates(db, query) {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  const pattern = likePattern(q);
  const rows = db.prepare(`
    SELECT v.id, v.platform, v.platform_uid, v.nickname, v.focused,
           (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.viewer_id = v.id) AS session_count
      FROM viewers v
     WHERE v.id = ?
        OR v.platform_uid = ?
        OR COALESCE(v.nickname, '') LIKE ? ESCAPE '\\'
        OR EXISTS (
             SELECT 1 FROM viewer_nicknames vn
              WHERE vn.viewer_id = v.id AND vn.nickname LIKE ? ESCAPE '\\'
           )
     ORDER BY v.last_seen_at DESC, v.id ASC
     LIMIT ?
  `).all(q, q, pattern, pattern, MAX_VIEWER_CANDIDATES);
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    platformUid: row.platform_uid,
    nickname: row.nickname,
    focused: row.focused === 1,
    sessionCount: Number(row.session_count ?? 0),
    matchedBy: q === row.id || q === row.platform_uid ? 'stableId' : 'nickname'
  }));
}

function normalizeScope(scope) {
  return HISTORY_SEARCH_SCOPES.includes(scope) ? scope : 'all';
}

function normalizeFilters({platform = null, status = null, from = null, to = null} = {}) {
  const clauses = [];
  const params = [];
  const normalizedPlatform = ['bilibili', 'youtube', 'mock'].includes(platform) ? platform : null;
  if (normalizedPlatform) {
    clauses.push('s.platform = ?');
    params.push(normalizedPlatform);
  }
  const normalizedStatus = ['live', 'ended', 'interrupted'].includes(status) ? status : null;
  if (normalizedStatus) {
    clauses.push('s.status = ?');
    params.push(normalizedStatus);
  }
  const fromMs = Number.isFinite(Number(from)) && Number(from) > 0 ? Math.trunc(Number(from)) : null;
  const toMs = Number.isFinite(Number(to)) && Number(to) > 0 ? Math.trunc(Number(to)) : null;
  if (fromMs !== null) {
    clauses.push('s.started_at >= ?');
    params.push(fromMs);
  }
  if (toMs !== null) {
    clauses.push('s.started_at <= ?');
    params.push(toMs);
  }
  return {clauses, params, platform: normalizedPlatform, status: normalizedStatus, from: fromMs, to: toMs};
}

function emptyPayload({query, scope, limit, offset}) {
  return {
    query,
    scope,
    total: 0,
    hiddenArchivedCount: 0,
    limit,
    offset,
    hasMore: false,
    sessions: [],
    viewerCandidates: [],
    anonymousIdentityNotice: false
  };
}

function toSessionResult(row) {
  return {
    id: row.id,
    platform: row.platform,
    platformRoomId: row.platform_room_id,
    roomTitle: row.room_title,
    broadcasterName: row.broadcaster_name,
    broadcasterId: row.broadcaster_id ?? null,
    broadcasterIdentity: row.broadcaster_identity ?? 'unresolved',
    broadcasterPlatformUid: row.broadcaster_platform_uid ?? null,
    status: row.status,
    endReason: row.end_reason ?? null,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    archivedAt: row.archived_at ?? null,
    storageMode: row.storage_mode,
    sourceQuality: row.source_quality,
    simulated: row.simulated === 1,
    startedAt: row.started_at,
    platformStartedAt: row.platform_started_at ?? null,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    platformStatus: row.platform_status ?? null,
    platformStatusAt: row.platform_status_at ?? null,
    lastLiveSeenAt: row.last_live_seen_at ?? null,
    platformEndedAt: row.platform_ended_at ?? null,
    platformEndQuality: row.platform_end_quality ?? null,
    messageCount: Number(row.message_count ?? 0),
    giftEventCount: Number(row.gift_event_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    uniqueViewerCount: Number(row.unique_viewer_count ?? 0),
    eventCount: Number(row.event_count ?? 0),
    aiStatus: row.ai_status
  };
}

/**
 * @param {object} db
 * @param {{
 *   query?: string, scope?: string, platform?: string|null, status?: string|null,
 *   from?: number|null, to?: number|null, includeArchived?: boolean,
 *   archivedOnly?: boolean, limit?: number, offset?: number
 * }} options
 */
export function searchHistory(db, {
  query = '',
  scope = 'all',
  platform = null,
  status = null,
  from = null,
  to = null,
  includeArchived = false,
  archivedOnly = false,
  limit = HISTORY_PAGE_SIZE,
  offset = 0
} = {}) {
  const q = normalizeSearchQuery(query);
  const normalizedScope = normalizeScope(scope);
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || HISTORY_PAGE_SIZE, 1), HISTORY_MAX_LIMIT);
  const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
  const filters = normalizeFilters({platform, status, from, to});

  const viewerCandidates = q ? resolveViewerCandidates(db, q) : [];
  const viewerIds = viewerCandidates.map((candidate) => candidate.id);
  const candidateById = new Map(viewerCandidates.map((candidate) => [candidate.id, candidate]));

  let matchSql = '';
  let matchParams = [];
  let flagSelect = '';
  let flagParams = [];
  let viewerPart = false;
  if (q) {
    const pattern = likePattern(q);
    flagSelect = `,
      CASE WHEN ${TITLE_PREDICATE} THEN 1 ELSE 0 END AS title_match,
      CASE WHEN ${BROADCASTER_PREDICATE} THEN 1 ELSE 0 END AS broadcaster_match`;
    flagParams = [...titleParams(pattern), ...broadcasterParams(pattern)];

    const viewerSql = viewerIds.length > 0 ? viewerPredicate(viewerIds.length) : null;
    if (normalizedScope === 'title') {
      matchSql = `AND ${TITLE_PREDICATE}`;
      matchParams = titleParams(pattern);
    } else if (normalizedScope === 'broadcaster') {
      matchSql = `AND ${BROADCASTER_PREDICATE}`;
      matchParams = broadcasterParams(pattern);
    } else if (normalizedScope === 'viewer') {
      viewerPart = true;
      if (viewerSql) {
        matchSql = `AND ${viewerSql}`;
        matchParams = [...viewerIds];
      } else {
        matchSql = 'AND 1 = 0';
      }
    } else {
      const parts = [TITLE_PREDICATE, BROADCASTER_PREDICATE];
      matchParams = [...titleParams(pattern), ...broadcasterParams(pattern)];
      if (viewerSql) {
        parts.push(viewerSql);
        matchParams.push(...viewerIds);
        viewerPart = true;
      }
      matchSql = `AND (${parts.join(' OR ')})`;
    }
  }

  const archivedClause = archivedOnly
    ? 's.archived_at IS NOT NULL'
    : (includeArchived ? null : 's.archived_at IS NULL');
  const whereClauses = [...filters.clauses];
  if (archivedClause) whereClauses.push(archivedClause);
  if (matchSql) whereClauses.push(matchSql.replace(/^AND /, ''));

  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM sessions s
     ${whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''}
  `).get(...filters.params, ...matchParams)?.count ?? 0);

  let hiddenArchivedCount = 0;
  if (archivedClause === 's.archived_at IS NULL') {
    const hiddenWhere = [...filters.clauses, 's.archived_at IS NOT NULL'];
    if (matchSql) hiddenWhere.push(matchSql.replace(/^AND /, ''));
    hiddenArchivedCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions s
       WHERE ${hiddenWhere.join(' AND ')}
    `).get(...filters.params, ...matchParams)?.count ?? 0);
  }

  if (total === 0) {
    return {
      ...emptyPayload({query: q, scope: normalizedScope, limit: safeLimit, offset: safeOffset}),
      hiddenArchivedCount,
      viewerCandidates: viewerCandidates.slice(0, MAX_VIEWERS_PER_RESULT),
      anonymousIdentityNotice: Boolean(q) && (normalizedScope === 'viewer' || normalizedScope === 'all')
    };
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT ${SESSION_COLUMNS}${flagSelect}
      FROM sessions s
     ${whereSql}
     ORDER BY s.started_at DESC, s.id DESC
     LIMIT ? OFFSET ?
  `).all(...flagParams, ...filters.params, ...matchParams, safeLimit, safeOffset);

  const viewerMatchesBySession = new Map();
  if (viewerPart && rows.length > 0) {
    const sessionIds = rows.map((row) => row.id);
    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
    const viewerPlaceholders = viewerIds.map(() => '?').join(', ');
    const viewerRows = db.prepare(`
      SELECT vs.session_id, vs.message_count, vs.payment_event_count,
             vs.first_seen_at, vs.last_seen_at,
             v.id AS viewer_id, v.platform, v.platform_uid, v.nickname
        FROM viewer_sessions vs
        JOIN viewers v ON v.id = vs.viewer_id
       WHERE vs.session_id IN (${sessionPlaceholders})
         AND vs.viewer_id IN (${viewerPlaceholders})
       ORDER BY vs.message_count DESC, v.platform_uid ASC, v.id ASC
    `).all(...sessionIds, ...viewerIds);
    for (const viewerRow of viewerRows) {
      const list = viewerMatchesBySession.get(viewerRow.session_id) ?? [];
      if (list.length >= MAX_VIEWERS_PER_RESULT) continue;
      const candidate = candidateById.get(viewerRow.viewer_id);
      list.push({
        viewerId: viewerRow.viewer_id,
        platform: viewerRow.platform,
        platformUid: viewerRow.platform_uid,
        nickname: viewerRow.nickname,
        matchedBy: candidate?.matchedBy ?? 'nickname',
        messageCount: Number(viewerRow.message_count ?? 0),
        paymentEventCount: Number(viewerRow.payment_event_count ?? 0),
        firstSeenAt: viewerRow.first_seen_at ?? null,
        lastSeenAt: viewerRow.last_seen_at ?? null
      });
      viewerMatchesBySession.set(viewerRow.session_id, list);
    }
  }

  const sessions = rows.map((row) => {
    const matchedViewers = viewerMatchesBySession.get(row.id) ?? [];
    const title = row.title_match === 1;
    const broadcaster = row.broadcaster_match === 1;
    return {
      ...toSessionResult(row),
      match: {
        title,
        broadcaster,
        viewer: matchedViewers.length > 0,
        titleTerm: title ? q : null,
        broadcasterTerm: broadcaster ? q : null
      },
      matchedViewers
    };
  });

  return {
    query: q,
    scope: normalizedScope,
    filters: {
      platform: filters.platform,
      status: filters.status,
      from: filters.from,
      to: filters.to,
      includeArchived: Boolean(includeArchived),
      archivedOnly: Boolean(archivedOnly)
    },
    total,
    hiddenArchivedCount,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + sessions.length < total,
    sessions,
    viewerCandidates: viewerCandidates.slice(0, MAX_VIEWERS_PER_RESULT),
    anonymousIdentityNotice: Boolean(q) && (normalizedScope === 'viewer' || normalizedScope === 'all')
  };
}

export const __internal = {
  MAX_VIEWER_CANDIDATES,
  MAX_VIEWERS_PER_RESULT,
  TITLE_PREDICATE,
  BROADCASTER_PREDICATE
};
