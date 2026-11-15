import {getSession} from '../../storage/repositories/sessions.mjs';
import {countSessionSpeakers, topSessionViewers} from '../../storage/repositories/viewers.mjs';

/**
 * Current-session leaderboard (read model).
 *
 * This is intentionally *session-scoped*: it is not a viewer's long-term
 * activity or an all-broadcaster total. Ranking uses the stable platform
 * identity (`platform:uid`) plus the per-session message counter, never a
 * nickname, so two different people with the same display name stay separate.
 *
 * The query is capped at 100. When a session only has 20 speakers, 20 rows are
 * returned; nothing is padded to 100.
 */
export const LEADERBOARD_LIMIT = 100;

export function buildSessionLeaderboard(db, sessionId, {limit = LEADERBOARD_LIMIT, query = ''} = {}) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const safeLimit = Math.min(Math.max(Number(limit) || LEADERBOARD_LIMIT, 1), LEADERBOARD_LIMIT);
  const needle = String(query ?? '').trim().slice(0, 80).toLowerCase();
  const total = countSessionSpeakers(db, sessionId);
  // Fetch the full ranked top window first so filtering by text never renumbers
  // the ranks. Search is a view of the current leaderboard, not a new ranking.
  const ranked = topSessionViewers(db, sessionId, {limit: safeLimit}).speakers.map((row, index) => ({
    rank: index + 1,
    viewerId: row.viewer_id,
    nickname: row.nickname ?? null,
    platform: row.platform,
    platformUid: row.platform_uid ?? null,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    lastMessageAt: row.last_seen_at ?? null
  }));
  const viewers = needle
    ? ranked.filter((row) => {
      const nickname = String(row.nickname ?? '').toLowerCase();
      const uid = String(row.platformUid ?? row.viewerId ?? '').toLowerCase();
      return nickname.includes(needle) || uid.includes(needle);
    })
    : ranked;

  return {
    sessionId: session.id,
    broadcasterId: session.broadcaster_id ?? null,
    broadcasterIdentity: session.broadcaster_identity ?? 'unresolved',
    limit: safeLimit,
    total,
    returned: viewers.length,
    rankedTotal: ranked.length,
    query: String(query ?? '').trim().slice(0, 80),
    viewers
  };
}
