import {isMessageEvent, isPaymentEvent, normalizeEvent} from '../../shared/events.mjs';
import {insertEvent} from '../../storage/repositories/events.mjs';
import {getSession, incrementSessionCounters} from '../../storage/repositories/sessions.mjs';
import {ensureViewer, recordSessionPayment, recordViewerActivity} from '../../storage/repositories/viewers.mjs';
import {recordViewerBroadcasterActivity} from '../../storage/repositories/broadcasters.mjs';
import {withTransaction} from '../../storage/database/connection.mjs';

/**
 * Single write path for every platform.
 *
 * Ordering inside one transaction:
 *   insert raw event (UNIQUE dedupe) -> if new: update viewer aggregates,
 *   session payment totals and session counters -> commit -> notify UI.
 *
 * Duplicated deliveries therefore cannot inflate counts or money: the second
 * insert is ignored and no aggregate is touched.
 */
export class EventIngest {
  constructor({db, now = () => Date.now(), logger = null}) {
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.listeners = new Set();
  }

  onInserted(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a UI listener must never break ingestion */
      }
    }
  }

  /**
   * @param {object} draft platform payload in canonical shape
   * @returns {{inserted:boolean, duplicate:boolean, skipped:boolean, event:object|null}}
   */
  record(draft) {
    const receivedNow = this.now();
    const event = normalizeEvent(draft, {now: receivedNow});
    const session = getSession(this.db, event.session_id);
    if (!session) return {inserted: false, duplicate: false, skipped: true, event: null};
    if (session.status !== 'live') return {inserted: false, duplicate: false, skipped: true, event: null};

    let inserted = false;
    withTransaction(this.db, () => {
      // The event row references viewers(id); create the identity first. The
      // counters are only touched when the insert below actually happens.
      ensureViewer(this.db, event, {now: receivedNow});
      const result = insertEvent(this.db, event);
      if (!result.inserted) return;
      inserted = true;
      recordViewerActivity(this.db, event, {now: receivedNow, sessionId: event.session_id});
      // Per-broadcaster context. Sessions whose broadcaster could not be
      // identified keep global viewer statistics only; they are never folded
      // into another channel's profile.
      recordViewerBroadcasterActivity(this.db, event, {
        broadcasterId: session.broadcaster_id ?? null,
        now: receivedNow
      });
      recordSessionPayment(this.db, event);
      incrementSessionCounters(this.db, event.session_id, {
        messages: isMessageEvent(event.event_type) ? 1 : 0,
        gifts: event.event_type === 'gift' ? 1 : 0,
        // A payment event must actually have been paid: a received gifted
        // membership or a free gift is a membership/gift event, not a payment.
        payments: isPaymentEvent(event.event_type) && event.is_paid ? 1 : 0,
        lastEventAt: event.occurred_at,
        now: receivedNow
      });
    });

    if (!inserted) return {inserted: false, duplicate: true, skipped: false, event};
    this.#emit(event);
    return {inserted: true, duplicate: false, skipped: false, event};
  }

  recordBatch(drafts) {
    const summary = {received: 0, inserted: 0, duplicate: 0, skipped: 0};
    for (const draft of drafts) {
      summary.received += 1;
      const result = this.record(draft);
      if (result.inserted) summary.inserted += 1;
      else if (result.duplicate) summary.duplicate += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  /** Test/diagnostic helper: how many events a session currently holds. */
  countSessionEvents(sessionId) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(String(sessionId));
    return Number(row?.count ?? 0);
  }
}
