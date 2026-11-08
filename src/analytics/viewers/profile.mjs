import {
  getViewer,
  viewerCurrencyTotals,
  viewerNicknameHistory,
  viewerSessionHistory
} from '../../storage/repositories/viewers.mjs';
import {groupCurrencyTotals} from '../payments/totals.mjs';

/**
 * Viewer read model.
 *
 * The default view is a summary: identity, lifetime participation, economic
 * support and nickname history. Raw messages are never part of this payload
 * (and may already be purged in compact storage mode).
 */
export function buildViewerProfile(db, viewerId) {
  const viewer = getViewer(db, viewerId);
  if (!viewer) return null;
  const totals = groupCurrencyTotals(viewerCurrencyTotals(db, viewerId));
  const nicknames = viewerNicknameHistory(db, viewerId);
  const sessions = viewerSessionHistory(db, viewerId, {limit: 20});
  return {
    viewer: {
      id: viewer.id,
      platform: viewer.platform,
      platformUid: viewer.platform_uid,
      nickname: viewer.nickname,
      firstSeenAt: viewer.first_seen_at,
      lastSeenAt: viewer.last_seen_at,
      sessionCount: Number(viewer.session_count ?? 0),
      messageCount: Number(viewer.message_count ?? 0),
      paymentEventCount: Number(viewer.payment_event_count ?? 0),
      focused: viewer.focused === 1
    },
    support: totals,
    nicknames: nicknames.map((row) => ({
      nickname: row.nickname,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    })),
    sessions: sessions.map((row) => ({
      sessionId: row.session_id,
      roomTitle: row.room_title,
      platform: row.platform,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      messageCount: Number(row.message_count ?? 0),
      paymentEventCount: Number(row.payment_event_count ?? 0),
      lastSeenAt: row.last_seen_at
    }))
  };
}
