/**
 * Session timeline (message density / activity heat).
 *
 * The bucket size adapts to the session length so a 40 minute stream and a 6
 * hour stream both render as a readable chart. Only bucketed aggregates leave
 * this module; the web console never needs the raw event list to draw a chart.
 */

export const BUCKET_STEPS_MS = Object.freeze([
  10_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000
]);

const MAX_BUCKETS = 240;

export function chooseBucketStep(durationMs, {targetBuckets = 60} = {}) {
  const duration = Math.max(Number(durationMs) || 0, 1000);
  for (const step of BUCKET_STEPS_MS) {
    if (duration / step <= targetBuckets) return step;
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

/**
 * @param {Array<{occurred_at:number, event_type:string, viewer_id:string|null, is_paid:number, amount_minor:number|null, currency:string|null, value_kind:string}>} rows
 * @param {{startedAt:number, endedAt?:number|null, targetBuckets?:number}} options
 */
export function computeTimeline(rows, {
  startedAt,
  endedAt = null,
  targetBuckets = 60,
  trimTrailingEmpty = false,
  dropInProgressBucket = false
} = {}) {
  const start = Number(startedAt) || Date.now();
  const lastEventAt = rows.length > 0
    ? Math.max(...rows.map((row) => Number(row.occurred_at) || start))
    : start;
  const end = Math.max(Number(endedAt) || 0, lastEventAt, start + 1000);
  const stepMs = chooseBucketStep(end - start, {targetBuckets});
  const count = Math.min(Math.max(Math.ceil((end - start) / stepMs), 1), MAX_BUCKETS);

  const buckets = [];
  for (let index = 0; index < count; index += 1) {
    buckets.push({
      startAt: start + index * stepMs,
      endAt: start + (index + 1) * stepMs,
      messages: 0,
      paymentEvents: 0,
      uniqueViewers: new Set(),
      payments: new Map()
    });
  }

  for (const row of rows) {
    const offset = Math.floor(((Number(row.occurred_at) || start) - start) / stepMs);
    const index = Math.min(Math.max(offset, 0), count - 1);
    const bucket = buckets[index];
    if (row.event_type === 'chat' || row.event_type === 'super_chat') {
      bucket.messages += 1;
      if (row.viewer_id) bucket.uniqueViewers.add(row.viewer_id);
    }
    if (row.is_paid === 1 && Number(row.amount_minor) > 0 && (row.value_kind === 'actual' || row.value_kind === 'display')) {
      bucket.paymentEvents += 1;
      const key = `${row.currency}:${row.value_kind}`;
      const current = bucket.payments.get(key) ?? {
        currency: row.currency,
        valueKind: row.value_kind,
        totalMinor: 0,
        eventCount: 0
      };
      current.totalMinor += Number(row.amount_minor);
      current.eventCount += 1;
      bucket.payments.set(key, current);
    }
  }

  // While a stream is still running, the newest bucket has usually just begun.
  // Dropping empty trailing buckets avoids drawing a misleading cliff to zero.
  if (dropInProgressBucket && buckets.length > 2) {
    const last = buckets[buckets.length - 1];
    if (last.endAt > end) buckets.pop();
  }
  if (trimTrailingEmpty) {
    while (buckets.length > 2) {
      const last = buckets[buckets.length - 1];
      if (last.messages === 0 && last.paymentEvents === 0) buckets.pop();
      else break;
    }
  }

  let peakMessages = 0;
  let peakIndex = 0;
  const serialized = buckets.map((bucket, index) => {
    if (bucket.messages > peakMessages) {
      peakMessages = bucket.messages;
      peakIndex = index;
    }
    return {
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      messages: bucket.messages,
      uniqueViewers: bucket.uniqueViewers.size,
      paymentEvents: bucket.paymentEvents,
      payments: [...bucket.payments.values()]
    };
  });

  const minutes = Math.max((end - start) / 60_000, 1 / 60);
  return {
    stepMs,
    durationMs: end - start,
    buckets: serialized,
    peakMessages,
    peakBucketIndex: peakMessages > 0 ? peakIndex : null,
    peakBucketStartAt: peakMessages > 0 ? serialized[peakIndex].startAt : null,
    averageMessagesPerMinute: Math.round((rows.filter((row) => row.event_type === 'chat' || row.event_type === 'super_chat').length / minutes) * 100) / 100
  };
}
