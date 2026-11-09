import {
  getViewer,
  viewerCurrencyTotals,
  viewerNicknameHistory,
  viewerSessionHistory
} from '../../storage/repositories/viewers.mjs';
import {
  getBroadcaster,
  unassignedViewerSessions,
  unassignedViewerStats,
  unassignedViewerSupport,
  viewerBroadcasterRow,
  viewerBroadcasterSessions,
  viewerBroadcasterSupport,
  viewerBroadcasters
} from '../../storage/repositories/broadcasters.mjs';
import {groupCurrencyTotals} from '../payments/totals.mjs';

/**
 * Viewer read model.
 *
 * A platform account keeps one global identity and lifetime totals. The
 * broadcaster context is a separate layer: when `broadcasterId` is supplied the
 * profile returns counters, support and sessions scoped to that channel only.
 * The global numbers remain visible but are labelled as global by the UI. No
 * broadcaster is ever mixed into another one's context.
 */

function mapSession(row) {
  return {
    sessionId: row.session_id,
    roomTitle: row.room_title,
    platform: row.platform,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    lastSeenAt: row.last_seen_at
  };
}

function mapBroadcasterRow(row) {
  return {
    id: row.broadcaster_id,
    platform: row.platform,
    platformUid: row.platform_uid,
    displayName: row.display_name,
    identity: row.identity_quality,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastSessionAt: row.last_session_at ?? null
  };
}

function mapSessions(rows) {
  return rows.map(mapSession);
}

/**
 * @param {object} db
 * @param {string} viewerId
 * @param {{broadcasterId?:string|null, unassigned?:boolean}} options
 */
export function buildViewerProfile(db, viewerId, {broadcasterId = null, unassigned = false} = {}) {
  const viewer = getViewer(db, viewerId);
  if (!viewer) return null;
  const totals = groupCurrencyTotals(viewerCurrencyTotals(db, viewerId));
  const nicknames = viewerNicknameHistory(db, viewerId);
  const relationshipRows = viewerBroadcasters(db, viewerId);
  const broadcasters = relationshipRows.map((row) => ({
    ...mapBroadcasterRow(row),
    support: groupCurrencyTotals(viewerBroadcasterSupport(db, viewerId, row.broadcaster_id))
  }));

  let scope = null;
  if (unassigned) {
    const stats = unassignedViewerStats(db, viewerId);
    scope = {
      kind: 'unassigned',
      broadcaster: null,
      ...stats,
      support: groupCurrencyTotals(unassignedViewerSupport(db, viewerId)),
      sessions: mapSessions(unassignedViewerSessions(db, viewerId, {limit: 50}))
    };
  } else if (broadcasterId) {
    const relationship = viewerBroadcasterRow(db, viewerId, broadcasterId);
    const broadcasterRow = relationship ?? getBroadcaster(db, broadcasterId);
    if (broadcasterRow) {
      scope = relationship
        ? {
          kind: 'broadcaster',
          broadcaster: {
            id: broadcasterId,
            platform: broadcasterRow.platform,
            platformUid: broadcasterRow.platform_uid,
            displayName: broadcasterRow.display_name,
            identity: broadcasterRow.identity_quality
          },
          messageCount: Number(relationship.message_count ?? 0),
          paymentEventCount: Number(relationship.payment_event_count ?? 0),
          sessionCount: Number(relationship.session_count ?? 0),
          firstSeenAt: relationship.first_seen_at,
          lastSeenAt: relationship.last_seen_at,
          support: groupCurrencyTotals(viewerBroadcasterSupport(db, viewerId, broadcasterId)),
          sessions: mapSessions(viewerBroadcasterSessions(db, viewerId, broadcasterId, {limit: 50}))
        }
        : {
          kind: 'broadcaster',
          broadcaster: {
            id: broadcasterId,
            platform: broadcasterRow.platform,
            platformUid: broadcasterRow.platform_uid,
            displayName: broadcasterRow.display_name,
            identity: broadcasterRow.identity_quality
          },
          messageCount: 0,
          paymentEventCount: 0,
          sessionCount: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          support: [],
          sessions: [],
          noRelationship: true
        };
    } else {
      scope = {kind: 'none'};
    }
  }

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
      broadcasterCount: broadcasters.length,
      focused: viewer.focused === 1
    },
    // Lifetime numbers across every recorded broadcaster. The UI labels these
    // explicitly so they are never mistaken for the selected channel's context.
    support: totals,
    nicknames: nicknames.map((row) => ({
      nickname: row.nickname,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    })),
    sessions: mapSessions(viewerSessionHistory(db, viewerId, {limit: 50})),
    broadcasters,
    scope
  };
}
