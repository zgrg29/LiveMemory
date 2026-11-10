import {createId} from '../shared/ids.mjs';
import {getViewer, viewerNicknameHistory, viewerSessionHistory} from '../storage/repositories/viewers.mjs';
import {getBroadcaster, broadcasterViewerContexts} from '../storage/repositories/broadcasters.mjs';
import {getMemory, ensureMemory, touchMemory} from '../storage/repositories/viewer-memory.mjs';

/**
 * Objective interaction history.
 *
 * These facts are deterministic projections of real rows (events, sessions,
 * viewers, viewer_sessions). AI never writes them, and importing the same
 * analysis twice cannot double-count them. A viewer's memory head can exist with
 * version 0 and no semantic facts: that is a real, deliberate state meaning
 * "this viewer was processed, but no semantic memory exists yet".
 */

export function ensureObjectiveMemory({
  db,
  broadcasterId,
  viewerId,
  sessionId,
  jobId = null,
  now = Date.now()
}) {
  if (!broadcasterId || !viewerId) return {status: 'missing_identity', memory: null};
  const viewer = getViewer(db, viewerId);
  if (!viewer) return {status: 'viewer_missing', memory: null};
  const existing = getMemory(db, {broadcasterId, viewerId});
  if (existing && existing.status === 'deleted') {
    // A deleted memory is a privacy decision; an objective sync must never
    // resurrect it. A future explicit analysis job may start a new memory.
    return {status: 'deleted', memory: existing};
  }
  const firstSeen = Number(viewer.first_seen_at ?? now) || now;
  const memory = ensureMemory(db, {
    id: createId('vmem'),
    broadcasterId,
    viewerId,
    now: existing ? now : firstSeen
  });
  touchMemory(db, memory.id, {
    lastSessionId: sessionId ?? undefined,
    lastJobId: jobId ?? undefined,
    now
  });
  return {status: 'updated', memory: getMemory(db, {broadcasterId, viewerId})};
}

export function objectiveHistory(db, {broadcasterId, viewerId, limit = 10} = {}) {
  const viewer = getViewer(db, viewerId);
  if (!viewer) return null;
  const broadcaster = broadcasterId ? getBroadcaster(db, broadcasterId) : null;
  const context = broadcasterId
    ? broadcasterViewerContexts(db, broadcasterId, [viewerId]).get(viewerId) ?? null
    : null;
  const sessions = viewerSessionHistory(db, viewerId, {limit}).map((row) => ({
    sessionId: row.session_id,
    roomTitle: row.room_title,
    platform: row.platform,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  }));
  return {
    broadcasterId: broadcasterId ?? null,
    broadcaster: broadcaster
      ? {
        id: broadcaster.id,
        platform: broadcaster.platform,
        platformUid: broadcaster.platform_uid,
        displayName: broadcaster.display_name,
        identity: broadcaster.identity_quality
      }
      : null,
    viewer: {
      id: viewer.id,
      platform: viewer.platform,
      platformUid: viewer.platform_uid,
      nickname: viewer.nickname,
      firstSeenAt: viewer.first_seen_at,
      lastSeenAt: viewer.last_seen_at,
      sessionCount: Number(viewer.session_count ?? 0),
      messageCount: Number(viewer.message_count ?? 0),
      paymentEventCount: Number(viewer.payment_event_count ?? 0)
    },
    broadcasterContext: context
      ? {
        sessionCount: Number(context.session_count ?? 0),
        messageCount: Number(context.message_count ?? 0),
        paymentEventCount: Number(context.payment_event_count ?? 0),
        firstSeenAt: context.first_seen_at,
        lastSeenAt: context.last_seen_at
      }
      : null,
    recentSessions: sessions,
    nicknames: viewerNicknameHistory(db, viewerId).slice(0, 10).map((row) => ({
      nickname: row.nickname,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }))
  };
}
