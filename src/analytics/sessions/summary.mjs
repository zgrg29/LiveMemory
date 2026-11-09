import {getSession} from '../../storage/repositories/sessions.mjs';
import {contentStats, listTimelineRows} from '../../storage/repositories/events.mjs';
import {
  sessionCurrencyTotals,
  topSessionViewers
} from '../../storage/repositories/viewers.mjs';
import {computeTimeline} from './hotness.mjs';
import {groupCurrencyTotals} from '../payments/totals.mjs';

/**
 * Read model for a single broadcast. Everything here is computed locally from
 * the database; no AI service is involved. AI results are attached separately
 * (M6) and are always labelled as AI output in the UI.
 */
export function buildSessionSummary(db, sessionId, {now = Date.now(), targetBuckets = 60, topLimit = 5} = {}) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const rows = listTimelineRows(db, sessionId);
  const endedAt = session.ended_at ?? now;
  const timeline = computeTimeline(rows, {
    startedAt: session.started_at,
    endedAt,
    targetBuckets,
    trimTrailingEmpty: session.ended_at === null,
    dropInProgressBucket: session.ended_at === null
  });
  const totals = groupCurrencyTotals(sessionCurrencyTotals(db, sessionId));
  const top = topSessionViewers(db, sessionId, {limit: Math.min(Math.max(Number(topLimit) || 5, 1), 100)});
  const content = contentStats(db, sessionId);
  const durationMs = Math.max(0, endedAt - session.started_at);
  const peakPerMinute = timeline.stepMs > 0
    ? Math.round((timeline.peakMessages * (60_000 / timeline.stepMs)) * 100) / 100
    : 0;

  return {
    session: {
      id: session.id,
      platform: session.platform,
      platformRoomId: session.platform_room_id,
      roomTitle: session.room_title,
      broadcasterName: session.broadcaster_name,
      broadcasterId: session.broadcaster_id ?? null,
      broadcasterIdentity: session.broadcaster_identity ?? 'unresolved',
      status: session.status,
      endReason: session.end_reason ?? null,
      archived: session.archived_at !== null && session.archived_at !== undefined,
      archivedAt: session.archived_at ?? null,
      storageMode: session.storage_mode,
      sourceQuality: session.source_quality,
      simulated: session.simulated === 1,
      startedAt: session.started_at,
      platformStartedAt: session.platform_started_at ?? null,
      endedAt: session.ended_at,
      lastEventAt: session.last_event_at,
      aiStatus: session.ai_status,
      durationMs,
      uniqueViewerCount: Number(session.unique_viewer_count ?? 0)
    },
    stats: {
      messages: Number(session.message_count ?? 0),
      giftEvents: Number(session.gift_event_count ?? 0),
      paymentEvents: Number(session.payment_event_count ?? 0),
      activeViewers: Number(session.unique_viewer_count ?? 0),
      eventCount: Number(session.event_count ?? 0),
      averageMessagesPerMinute: timeline.averageMessagesPerMinute,
      peakMessagesPerBucket: timeline.peakMessages,
      peakMessagesPerMinute: peakPerMinute,
      peakBucketStartAt: timeline.peakBucketStartAt
    },
    timeline: {
      stepMs: timeline.stepMs,
      durationMs: timeline.durationMs,
      buckets: timeline.buckets
    },
    support: totals,
    top,
    storage: {
      events: Number(content.total ?? 0),
      eventsWithContent: Number(content.with_content ?? 0),
      contentBytes: Number(content.content_bytes ?? 0)
    }
  };
}
