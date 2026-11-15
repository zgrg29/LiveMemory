import {EVENT_TYPES, SOURCE_QUALITY, VALUE_KIND} from '../../shared/events.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {allFields, asDecimal, asString, field, nested, readFields} from './protobuf.mjs';

/**
 * TikTok Webcast message decoding.
 *
 * Two envelopes exist:
 *   - `ProtoMessageFetchResult` — what the signed bootstrap/poll endpoint
 *     returns (messages[] + cursor + internalExt + wsUrl).
 *   - `WebcastResponse` — the classic WebSocket frame payload (gzip).
 *
 * Both carry the same `Webcast*Message` payloads, so mapping lives in one place.
 * Field numbers follow the public Webcast schema and are re-checked against real
 * captured payloads in the tests.
 *
 * Semantics kept deliberately conservative:
 *   - chat text is stored verbatim (Unicode/emoji untouched);
 *   - the stable identity is `user.userId` (never the nickname);
 *   - a gift's diamonds are a display value, never income: `amount_minor=null`,
 *     `currency=null`, `value_kind=unknown`;
 *   - streak gifts are only emitted by the caller on their final state.
 */

export const TIKTOK_METHODS = Object.freeze({
  CHAT: 'WebcastChatMessage',
  EMOTE_CHAT: 'WebcastEmoteChatMessage',
  GIFT: 'WebcastGiftMessage',
  MEMBER: 'WebcastMemberMessage',
  LIKE: 'WebcastLikeMessage',
  SOCIAL: 'WebcastSocialMessage',
  ROOM_USER_SEQ: 'WebcastRoomUserSeqMessage',
  CONTROL: 'WebcastControlMessage',
  ROOM: 'WebcastRoomMessage',
  SUB_NOTIFY: 'WebcastSubNotifyMessage'
});

const EMPTY_RESULT = Object.freeze({
  messages: [],
  cursor: null,
  internalExt: null,
  fetchInterval: null,
  fetchType: null,
  pushServer: null,
  needsAck: false,
  routeParams: [],
  liveCursor: null,
  historyNoMore: null
});

function protocolError(reason) {
  return new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
    messageKey: 'errors.tiktokProtocol',
    httpStatus: 502,
    details: {reason}
  });
}

/** Route parameters are repeated {name=1,value=2} pairs. */
function readRouteParams(fields) {
  const params = new Map();
  for (const entry of allFields(fields, 7, 2)) {
    const pair = readFields(entry.bytes);
    const name = asString(field(pair, 1, 2));
    const value = asString(field(pair, 2, 2));
    if (name && value) params.set(name, value);
  }
  return params;
}

/** Message envelope ids appear as int64 (varint) in the fetch result and as
 * strings in some WebSocket frames. Accept both; never invent one. */
function readEnvelopeId(messageFields) {
  const entry = field(messageFields, 3);
  if (!entry) return null;
  if (entry.wire === 0) return entry.value.toString();
  if (entry.wire === 2) {
    const text = entry.bytes.toString('utf8').trim();
    return text || null;
  }
  return null;
}

/** Decode `ProtoMessageFetchResult` from the signed bootstrap endpoint. */
export function decodeFetchResult(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw protocolError('empty_fetch_result');
  const fields = readFields(buffer);
  const messages = [];
  for (const entry of allFields(fields, 1, 2)) {
    const messageFields = readFields(entry.bytes);
    const method = asString(field(messageFields, 1, 2)) ?? '';
    const payloadEntry = field(messageFields, 2, 2);
    const envelopeMsgId = readEnvelopeId(messageFields);
    if (!method || !payloadEntry) continue;
    messages.push({method, payload: payloadEntry.bytes, envelopeMsgId});
  }
  return {
    messages,
    cursor: asString(field(fields, 2, 2)),
    internalExt: asString(field(fields, 5, 2)),
    fetchInterval: Number(field(fields, 3, 0)?.value ?? 0) || null,
    fetchType: Number(field(fields, 6, 0)?.value ?? 0) || null,
    pushServer: asString(field(fields, 10, 2)),
    needsAck: field(fields, 9, 0)?.value === 1n,
    routeParams: readRouteParams(fields),
    liveCursor: asDecimal(field(fields, 11, 0)),
    historyNoMore: asString(field(fields, 12, 2))
  };
}

/**
 * Decode a `WebcastResponse` (classic WebSocket frame payload).
 * The caller is responsible for gzip inflation.
 */
export function decodeWebcastResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return {...EMPTY_RESULT};
  const fields = readFields(buffer);
  const messages = [];
  for (const entry of allFields(fields, 1, 2)) {
    const messageFields = readFields(entry.bytes);
    const method = asString(field(messageFields, 1, 2)) ?? '';
    const payloadEntry = field(messageFields, 2, 2);
    const envelopeMsgId = readEnvelopeId(messageFields);
    if (!method || !payloadEntry) continue;
    messages.push({method, payload: payloadEntry.bytes, envelopeMsgId});
  }
  return {
    ...EMPTY_RESULT,
    messages,
    cursor: asString(field(fields, 2, 2)),
    fetchInterval: Number(field(fields, 3, 0)?.value ?? 0) || null,
    internalExt: asString(field(fields, 5, 2)),
    fetchType: Number(field(fields, 6, 0)?.value ?? 0) || null,
    needsAck: field(fields, 9, 0)?.value === 1n,
    pushServer: asString(field(fields, 10, 2))
  };
}

/** Read an id field that TikTok may encode as int64 or as a decimal string. */
function readId(fields, number) {
  const entry = field(fields, number);
  if (!entry) return null;
  if (entry.wire === 0) return entry.value.toString();
  if (entry.wire === 2) return entry.bytes.toString('utf8').trim() || null;
  return null;
}

/** Read `WebcastMessageEvent` (method/msgId/roomId/createTime). */
export function readCommon(fields) {
  const common = nested(fields, 1);
  const method = asString(field(common, 1, 2));
  const msgId = readId(common, 2);
  const roomId = readId(common, 3);
  const createTime = readId(common, 4);
  return {method, msgId, roomId, createTime};
}

/** Read a `User` payload. `id` is the stable identity; the nickname is display only. */
export function readUser(fields) {
  const user = fields;
  const id = asDecimal(field(user, 1, 0));
  const nickname = asString(field(user, 3, 2));
  // Field 38 is `uniqueId` (handle), 46 is `secUid`. Both are display metadata;
  // only the numeric id is used as the long-term identity.
  const uniqueId = asString(field(user, 38, 2));
  const secUid = asString(field(user, 46, 2));
  return {
    id,
    nickname: nickname || null,
    uniqueId: uniqueId || null,
    secUid: secUid || null
  };
}

function baseDraft({eventType, viewer, common, receivedAt, externalId}) {
  return {
    platform: 'tiktok',
    event_type: eventType,
    viewer_uid: viewer?.id ?? null,
    display_name: viewer?.nickname ?? viewer?.uniqueId ?? null,
    external_id: externalId ?? common?.msgId ?? null,
    occurred_at: common?.createTime ? Number(common.createTime) : receivedAt,
    received_at: receivedAt,
    source_quality: SOURCE_QUALITY.VERIFIED,
    emotes: null,
    badges: null
  };
}

/**
 * Map one decoded message into a canonical draft (or a non-event observation).
 *
 * @param {{method: string, payload: Buffer, envelopeMsgId?: string|null}} message
 * @param {{giftCatalog?: Map<string, object>|null, now?: number}} options
 * @returns {{kind: 'event', event: object}
 *   | {kind: 'ignored', counter: string, viewer?: object|null}
 *   | {kind: 'viewers', viewerCount: number|null}
 *   | {kind: 'control', action: number|null}}
 */
export function mapTikTokMessage(message, {giftCatalog = null, now = Date.now()} = {}) {
  const method = String(message?.method ?? '');
  if (!message?.payload || message.payload.length === 0) return {kind: 'ignored', counter: 'empty'};
  const fields = readFields(message.payload);
  const common = readCommon(fields);
  const externalId = common.msgId ?? message.envelopeMsgId ?? null;

  if (method === TIKTOK_METHODS.CHAT || method === TIKTOK_METHODS.EMOTE_CHAT) {
    const viewer = readUser(nested(fields, 2));
    const content = asString(field(fields, 3, 2));
    if (content === null || content === '') return {kind: 'ignored', counter: 'empty_chat', viewer};
    return {
      kind: 'event',
      event: {
        ...baseDraft({eventType: EVENT_TYPES.CHAT, viewer, common, receivedAt: now, externalId}),
        content,
        gift_id: null,
        gift_name: null,
        gift_quantity: 1,
        amount_minor: null,
        unit_amount_minor: null,
        amount_display: null,
        currency: null,
        value_kind: VALUE_KIND.UNKNOWN,
        is_paid: false
      }
    };
  }

  if (method === TIKTOK_METHODS.GIFT) {
    const giftId = asDecimal(field(fields, 2, 0));
    const repeatCount = Math.max(1, Number(field(fields, 5, 0)?.value ?? 1n));
    const repeatEnd = Number(field(fields, 9, 0)?.value ?? 1n);
    const groupId = asDecimal(field(fields, 11, 0));
    const viewer = readUser(nested(fields, 7));
    const details = nested(fields, 15);
    const giftName = asString(field(details, 16, 2)) ?? null;
    const diamondCount = Number(field(details, 12, 0)?.value ?? 0n) || 0;
    const giftTypeId = Number(field(details, 11, 0)?.value ?? 0n) || null;
    const catalogEntry = giftId && giftCatalog ? giftCatalog.get(String(giftId)) ?? null : null;
    const name = giftName || catalogEntry?.name || null;
    const diamonds = diamondCount || catalogEntry?.diamondCount || 0;
    const totalDiamonds = diamonds > 0 ? diamonds * repeatCount : null;
    return {
      kind: 'gift',
      final: repeatEnd === 1,
      // A streak group keeps the same groupId across repeat updates; fall back
      // to viewer+gift when TikTok omits it so two viewers never merge.
      groupKey: groupId ? `g:${groupId}` : `u:${viewer?.id ?? '?'}:${giftId ?? '?'}`,
      event: {
        ...baseDraft({eventType: EVENT_TYPES.GIFT, viewer, common, receivedAt: now, externalId}),
        content: null,
        gift_id: giftId ?? (catalogEntry ? String(catalogEntry.id) : null),
        gift_name: name,
        gift_type: 'paid',
        gift_quantity: repeatCount,
        amount_minor: null,
        unit_amount_minor: null,
        amount_display: totalDiamonds === null ? null : `${totalDiamonds} TikTok Diamonds`,
        currency: null,
        value_kind: VALUE_KIND.UNKNOWN,
        is_paid: true,
        // Diamonds are a display value; the schema is parsed but a real gift
        // event is still required before claiming verified gift support.
        source_quality: SOURCE_QUALITY.ESTIMATED,
        meta: {giftTypeId, groupId, repeatEnd, catalogName: catalogEntry?.name ?? null}
      }
    };
  }

  if (method === TIKTOK_METHODS.MEMBER) {
    const viewer = readUser(nested(fields, 2));
    return {kind: 'ignored', counter: 'member', viewer};
  }

  if (method === TIKTOK_METHODS.LIKE) {
    const viewer = readUser(nested(fields, 5));
    return {kind: 'ignored', counter: 'like', viewer};
  }

  if (method === TIKTOK_METHODS.SOCIAL) {
    const viewer = readUser(nested(fields, 2));
    return {kind: 'ignored', counter: 'social', viewer};
  }

  if (method === TIKTOK_METHODS.ROOM_USER_SEQ) {
    const viewerCount = Number(field(fields, 3, 0)?.value ?? 0n);
    return {kind: 'viewers', viewerCount: Number.isFinite(viewerCount) ? viewerCount : null};
  }

  if (method === TIKTOK_METHODS.CONTROL) {
    const action = Number(field(fields, 2, 0)?.value ?? 0n);
    return {kind: 'control', action};
  }

  if (method === TIKTOK_METHODS.SUB_NOTIFY) {
    const viewer = readUser(nested(fields, 2));
    const subMonth = Number(field(fields, 4, 0)?.value ?? 0n) || 0;
    return {
      kind: 'event',
      event: {
        ...baseDraft({eventType: EVENT_TYPES.MEMBERSHIP, viewer, common, receivedAt: now, externalId}),
        content: null,
        gift_id: null,
        gift_name: 'TikTok LIVE subscription',
        gift_type: 'paid',
        gift_quantity: 1,
        amount_minor: null,
        unit_amount_minor: null,
        amount_display: subMonth > 0 ? `${subMonth} month(s)` : null,
        currency: null,
        value_kind: VALUE_KIND.UNKNOWN,
        is_paid: true,
        source_quality: SOURCE_QUALITY.ESTIMATED
      }
    };
  }

  return {kind: 'ignored', counter: 'unknown'};
}

export const __internal = {EMPTY_RESULT, baseDraft};
