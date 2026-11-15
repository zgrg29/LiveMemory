import {gunzipSync} from 'node:zlib';
import {EVENT_TYPES, SOURCE_QUALITY, VALUE_KIND} from '../../shared/events.mjs';
import {cleanText} from '../../shared/text.mjs';
import {decodeMessage, MESSAGE_SCHEMAS, bigintText} from './protobuf.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';

/**
 * Douyin webcast push framing and canonical event mapping.
 *
 * Transport shape: WebSocket binary frame -> PushFrame -> gzip payload ->
 * Response -> Message[] -> a concrete body (chat, gift, member, ...).
 *
 * Only chat and gifts become stored events. Member/like/follow/room-stat
 * messages are counted for diagnostics but never turned into a payment event:
 * entering a room or tapping "like" is not a gift.
 */

export const METHOD = Object.freeze({
  CHAT: 'WebcastChatMessage',
  EMOJI_CHAT: 'WebcastEmojiChatMessage',
  GIFT: 'WebcastGiftMessage',
  MEMBER: 'WebcastMemberMessage',
  LIKE: 'WebcastLikeMessage',
  SOCIAL: 'WebcastSocialMessage',
  ROOM_USER_SEQ: 'WebcastRoomUserSeqMessage'
});

const BODY_BY_METHOD = Object.freeze({
  [METHOD.CHAT]: 'ChatMessage',
  [METHOD.EMOJI_CHAT]: 'EmojiChatMessage',
  [METHOD.GIFT]: 'GiftMessage',
  [METHOD.MEMBER]: 'MemberMessage',
  [METHOD.LIKE]: 'LikeMessage',
  [METHOD.SOCIAL]: 'SocialMessage',
  [METHOD.ROOM_USER_SEQ]: 'RoomUserSeqMessage'
});

const MAX_GIFT_QUANTITY = 100000;
const COMBO_TTL_MS = 2 * 60 * 1000;
const MAX_COMBO_ENTRIES = 2000;

function headersOf(frame) {
  const headers = {};
  for (const entry of frame?.headersList ?? []) {
    const key = String(entry?.key ?? '').trim();
    if (!key) continue;
    headers[key] = String(entry?.value ?? '');
  }
  return headers;
}

/**
 * Decode one WebSocket binary frame.
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 */
export function decodeFrame(input) {
  const raw = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof ArrayBuffer ? input : (input?.buffer ?? input));
  if (raw.length === 0) throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {details: {reason: 'empty_frame'}});
  let frame;
  try {
    frame = decodeMessage(raw, MESSAGE_SCHEMAS.PushFrame);
  } catch (error) {
    throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {
      messageKey: 'errors.douyinProtocol',
      details: {reason: 'push_frame'},
      cause: error
    });
  }
  const headers = headersOf(frame);
  const payloadType = String(frame.payloadType ?? '');
  const result = {
    payloadType,
    logId: bigintText(frame.logId),
    headers,
    internalExt: '',
    needAck: false,
    messages: []
  };
  if (!frame.payload || frame.payload.length === 0) return result;

  let payload = frame.payload;
  const gzip = headers.compress_type === 'gzip'
    || (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b);
  if (gzip) {
    try {
      payload = gunzipSync(payload);
    } catch (error) {
      throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {
        messageKey: 'errors.douyinProtocol',
        details: {reason: 'gzip'},
        cause: error
      });
    }
  }

  if (payloadType !== 'msg' && payloadType !== 'push') return result;
  let response;
  try {
    response = decodeMessage(payload, MESSAGE_SCHEMAS.Response);
  } catch (error) {
    throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {
      messageKey: 'errors.douyinProtocol',
      details: {reason: 'response'},
      cause: error
    });
  }
  result.internalExt = String(response.internalExt ?? '');
  result.needAck = response.needAck === true;
  for (const message of response.messagesList ?? []) {
    const method = String(message?.method ?? '');
    if (!method) continue;
    result.messages.push({
      method,
      msgId: bigintText(message.msgId),
      payload: message.payload ?? Buffer.alloc(0)
    });
  }
  return result;
}

/** @returns {object|null} decoded body for a known method */
export function decodeMessageBody(method, payload) {
  const schemaName = BODY_BY_METHOD[method];
  if (!schemaName) return null;
  try {
    return decodeMessage(payload, MESSAGE_SCHEMAS[schemaName]);
  } catch (error) {
    throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {
      messageKey: 'errors.douyinProtocol',
      details: {reason: 'body', method},
      cause: error
    });
  }
}

function secondsToMs(value) {
  try {
    const big = BigInt(String(value ?? 0));
    if (big <= 0n) return null;
    // Douyin sends seconds. Values already in milliseconds are accepted too.
    const number = Number(big);
    if (!Number.isFinite(number)) return null;
    return number > 1e12 ? number : number * 1000;
  } catch {
    return null;
  }
}

export function occurredAt(common, receivedAt) {
  const ms = secondsToMs(common?.createTime);
  if (!ms) return receivedAt;
  // A device clock or a replayed batch must not move the timestamp far outside
  // the receiving window; keep the local receive time in that case.
  if (ms < receivedAt - 15 * 60 * 1000 || ms > receivedAt + 60 * 1000) return receivedAt;
  return ms;
}

function userIdentity(user) {
  const uid = bigintText(user?.id) || cleanText(user?.idStr ?? null, 40) || '';
  const normalized = uid.replace(/^0+$/, '');
  return {
    uid: normalized || null,
    displayName: cleanText(user?.nickName, 120) || null,
    secUid: cleanText(user?.secUid, 200) || null
  };
}

/**
 * Map a decoded message body to a canonical draft.
 * Gifts are intentionally *not* emitted here: a combo must be finalized first.
 * @returns {{kind:string, draft:object|null, online?:number}}
 */
export function mapDouyinMessage({method, msgId, body, receivedAt, roomId = null}) {
  if (!body) return {kind: 'unknown', draft: null};
  if (method === METHOD.CHAT || method === METHOD.EMOJI_CHAT) {
    const person = userIdentity(body.user);
    const externalId = cleanText(msgId || bigintText(body.common?.msgId), 200) || null;
    const content = method === METHOD.EMOJI_CHAT
      ? (cleanText(body.defaultContent, 4000) || null)
      : (cleanText(body.content, 4000) || null);
    if (content === null) return {kind: 'ignored', draft: null};
    return {
      kind: 'chat',
      draft: {
        platform: 'douyin',
        external_id: externalId,
        event_type: EVENT_TYPES.CHAT,
        viewer_uid: person.uid,
        display_name: person.displayName,
        content,
        occurred_at: occurredAt(body.common, receivedAt),
        received_at: receivedAt,
        is_paid: false,
        source_quality: person.uid && externalId ? SOURCE_QUALITY.VERIFIED : SOURCE_QUALITY.UNKNOWN
      }
    };
  }
  if (method === METHOD.ROOM_USER_SEQ) {
    const online = Number(body.total ?? 0);
    return {kind: 'stats', draft: null, online: Number.isFinite(online) && online >= 0 ? online : null};
  }
  if (method === METHOD.MEMBER) return {kind: 'member', draft: null};
  if (method === METHOD.LIKE) return {kind: 'like', draft: null};
  if (method === METHOD.SOCIAL) return {kind: 'follow', draft: null};
  return {kind: 'unknown', draft: null};
}

function giftQuantity(body) {
  for (const candidate of [body.repeatCount, body.comboCount, body.groupCount]) {
    try {
      const value = Number(BigInt(String(candidate ?? 0)));
      if (Number.isFinite(value) && value > 0) return Math.min(MAX_GIFT_QUANTITY, Math.trunc(value));
    } catch {
      /* try the next field */
    }
  }
  return 1;
}

function giftDraft(body, {receivedAt, quantity, msgId}) {
  const person = userIdentity(body.user);
  const gift = body.gift ?? {};
  const giftId = bigintText(body.giftId) || bigintText(gift.id);
  const giftName = cleanText(gift.name, 120) || null;
  const unitDiamonds = Number(gift.diamondCount ?? 0);
  const totalDiamonds = Number.isFinite(unitDiamonds) && unitDiamonds > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(unitDiamonds) * quantity)
    : null;
  const externalId = cleanText(msgId || bigintText(body.common?.msgId), 200) || null;
  return {
    platform: 'douyin',
    external_id: externalId,
    event_type: EVENT_TYPES.GIFT,
    viewer_uid: person.uid,
    display_name: person.displayName,
    content: null,
    gift_id: giftId || null,
    gift_name: giftName,
    gift_type: 'paid',
    gift_quantity: quantity,
    // Diamond count is a platform display value, not the streamer's income.
    // No currency and no minor-unit amount is invented from it.
    amount_minor: null,
    unit_amount_minor: null,
    amount_display: totalDiamonds === null ? null : `${totalDiamonds} 抖音币`,
    currency: null,
    value_kind: VALUE_KIND.UNKNOWN,
    is_paid: true,
    occurred_at: occurredAt(body.common, receivedAt),
    received_at: receivedAt,
    source_quality: person.uid && externalId ? SOURCE_QUALITY.VERIFIED : SOURCE_QUALITY.UNKNOWN
  };
}

/**
 * Collapse a gift combo into one event.
 *
 * Douyin emits a message per combo step and a final message with
 * `repeat_end = 1`. Writing every step would multiply the gift count, so only
 * the final state is written. If a combo never gets a final message it is
 * dropped after `ttlMs` instead of being counted as a guess.
 */
export class GiftComboTracker {
  constructor({ttlMs = COMBO_TTL_MS, maxEntries = MAX_COMBO_ENTRIES, now = Date.now} = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.pending = new Map();
    this.stats = {pending: 0, finalized: 0, dropped: 0, superseded: 0};
  }

  #key(body) {
    const groupId = bigintText(body.groupId);
    if (groupId && groupId !== '0') return `g:${groupId}`;
    const person = userIdentity(body.user);
    const giftId = bigintText(body.giftId) || bigintText(body.gift?.id);
    return `u:${person.uid ?? 'unknown'}:${giftId || 'gift'}`;
  }

  #prune(now) {
    for (const [key, entry] of this.pending) {
      if (now - entry.lastAt > this.ttlMs) {
        this.pending.delete(key);
        this.stats.dropped += 1;
      }
    }
    while (this.pending.size > this.maxEntries) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
      this.stats.dropped += 1;
    }
  }

  /**
   * @param {object} body decoded GiftMessage
   * @returns {{draft:object|null, pending:boolean, quantity:number}}
   */
  ingest(body, {receivedAt = this.now(), msgId = ''} = {}) {
    if (!body) return {draft: null, pending: false, quantity: 0};
    const now = receivedAt;
    this.#prune(now);
    const key = this.#key(body);
    const quantity = giftQuantity(body);
    const previous = this.pending.get(key);
    const final = Number(body.repeatEnd ?? 0) === 1;
    const bestQuantity = Math.max(quantity, previous?.quantity ?? 0);
    if (!final) {
      const entry = {
        quantity: bestQuantity,
        firstAt: previous?.firstAt ?? now,
        lastAt: now,
        messages: (previous?.messages ?? 0) + 1
      };
      this.pending.set(key, entry);
      this.stats.pending += 1;
      return {draft: null, pending: true, quantity: bestQuantity};
    }
    this.pending.delete(key);
    if (previous) this.stats.superseded += 1;
    this.stats.finalized += 1;
    return {
      draft: giftDraft(body, {receivedAt: previous?.firstAt ?? now, quantity: bestQuantity, msgId}),
      pending: false,
      quantity: bestQuantity
    };
  }

  /** Drop unfinished combos; never emits them as a guessed gift. */
  clear() {
    const count = this.pending.size;
    this.pending.clear();
    return {dropped: count};
  }

  snapshot() {
    return {...this.stats, open: this.pending.size};
  }
}

export const __internal = {BODY_BY_METHOD, secondsToMs, giftQuantity, userIdentity};
