// Kuaishou G1.5 research prototype — event normalizer.
//
// Output is validated by the production canonical model
// (src/shared/events.mjs) so the research prototype cannot drift into its own
// private event shape. Viewer ids are namespaced (`h5:` / `ws:`) because the
// two routes have NOT been proven to share an identity namespace.

import {normalizeEvent} from '../../../src/shared/events.mjs';

export const PLATFORM = 'kuaishou';

/** Identity namespaces. Never collapse them without explicit evidence. */
export const NAMESPACE = Object.freeze({H5: 'h5', WS: 'ws'});

export function qualifyUid(namespace, rawUid) {
  const raw = rawUid === null || rawUid === undefined ? '' : String(rawUid).trim();
  if (!raw || raw === '0') return null;
  if (namespace !== NAMESPACE.H5 && namespace !== NAMESPACE.WS) throw new Error(`未知身份命名空间：${namespace}`);
  return `${namespace}:${raw}`;
}

/**
 * @param {object} opts
 * @param {'h5'|'ws'} opts.namespace
 * @param {string} opts.sessionId local session id (research: stable per run)
 * @param {string} opts.roomId broadcaster eid
 * @param {string} opts.liveStreamId current live stream id
 */
export function createNormalizer({namespace, sessionId, roomId, liveStreamId}) {
  if (!sessionId || !roomId || !liveStreamId) throw new Error('normalizer 需要 sessionId/roomId/liveStreamId');

  const base = {
    platform: PLATFORM,
    session_id: sessionId,
    room: roomId,
    platform_room_id: liveStreamId,
    // Identity is field-level only until cross-room / cross-route evidence exists.
    source_quality: 'unknown'
  };

  return {
    namespace,
    chat({id = null, principalId = null, nickname = '', content = '', time = null}, receivedAt = Date.now()) {
      return normalizeEvent({
        ...base,
        event_type: 'chat',
        external_id: id ? `${namespace}:${id}` : null,
        viewer_uid: qualifyUid(namespace, principalId),
        display_name: nickname || '',
        content: content ?? '',
        occurred_at: time ?? receivedAt,
        received_at: receivedAt
      });
    },

    gift({id = null, principalId = null, nickname = '', giftId = null, giftName = '', count = 1, time = null}, receivedAt = Date.now()) {
      return normalizeEvent({
        ...base,
        event_type: 'gift',
        external_id: id ? `${namespace}:${id}` : null,
        viewer_uid: qualifyUid(namespace, principalId),
        display_name: nickname || '',
        gift_id: giftId == null ? null : String(giftId),
        gift_name: giftName || '',
        gift_type: 'paid',
        gift_quantity: count,
        occurred_at: time ?? receivedAt,
        received_at: receivedAt,
        // Kuaishou's live feed has no currency amount. Never invent one.
        amount_minor: null,
        unit_amount_minor: null,
        currency: null,
        value_kind: 'unknown',
        is_paid: true,
        content: ''
      });
    },

    /** System notices are informational, tied to no viewer identity. */
    system({id = null, content = '', time = null}, receivedAt = Date.now()) {
      return normalizeEvent({
        ...base,
        event_type: 'system',
        external_id: id ? `${namespace}:${id}` : null,
        viewer_uid: null,
        display_name: '',
        content: content ?? '',
        occurred_at: time ?? receivedAt,
        received_at: receivedAt,
        is_paid: false
      });
    }
  };
}
