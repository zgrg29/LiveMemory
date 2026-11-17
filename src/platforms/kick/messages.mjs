import {normalizeBadges} from '../../shared/badges.mjs';
import {normalizeEmotes} from '../../shared/emoticons.mjs';

/**
 * Kick realtime payload parsing.
 *
 * Kick's Centrifugo publications wrap a Laravel event name and a JSON string:
 *
 *   {"push":{"channel":"chatrooms.123.v2","pub":{"data":{
 *      "event":"App\\Events\\ChatMessageEvent",
 *      "data":"{\"id\":\"<uuid>\",\"content\":\"...\", ...}"}}}}
 *
 * This module only turns those payloads into canonical drafts. It never writes
 * to the database, never translates `content`, and never invents an amount: an
 * event it does not fully understand is reported as `unknown` so the adapter
 * can count it instead of guessing.
 *
 * Field names come from real publications captured on 2026-11-16/17 (odablock
 * and other live rooms); the shapes below are the observed ones, not README
 * examples.
 */

export const KICK_CHAT_EVENTS = Object.freeze([
  'App\\Events\\ChatMessageEvent',
  'App\\Events\\ChatMessageSentEvent'
]);

/** Event names seen in the wild or referenced by the web client. */
export const KICK_EVENT_KINDS = Object.freeze({
  'App\\Events\\ChatMessageEvent': 'chat',
  'App\\Events\\ChatMessageSentEvent': 'chat',
  'App\\Events\\ChatMessageDeletedEvent': 'chat_deleted',
  'App\\Events\\SubscriptionEvent': 'subscription',
  'App\\Events\\GiftedSubscriptionsEvent': 'gifted_subscriptions',
  'App\\Events\\KicksGifted': 'kicks_gifted',
  'App\\Events\\StreamHostEvent': 'host',
  'App\\Events\\StreamHostedEvent': 'host',
  'App\\Events\\ChatMoveToSupportedChannelEvent': 'host_leave',
  'App\\Events\\RaidEvent': 'raid',
  'App\\Events\\UserBannedEvent': 'user_banned',
  'App\\Events\\UserUnbannedEvent': 'user_unbanned',
  'App\\Events\\MessageDeletedEvent': 'message_deleted',
  'App\\Events\\PinnedMessageCreatedEvent': 'pin_created',
  'App\\Events\\PinnedMessageDeletedEvent': 'pin_deleted',
  'App\\Events\\ChatroomClearEvent': 'chat_cleared',
  'App\\Events\\StreamerIsLive': 'live',
  'App\\Events\\StopStreamBroadcast': 'offline',
  'App\\Events\\PollUpdateEvent': 'poll',
  'App\\Events\\PollDeleteEvent': 'poll_deleted',
  // Four of the feeds publish unprefixed names (no `App\Events\` namespace).
  GiftedSubscriptionsEvent: 'gifted_subscriptions',
  KicksGifted: 'kicks_gifted',
  RewardRedeemedEvent: 'reward_redemption',
  StreamHostedEvent: 'host'
});

const EMOTE_PATTERN = /\[emote:(\d+):([^\]\s]+)\]/g;

/** Split one WebSocket text message into its JSON documents. */
export function splitFrameText(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw ?? '').toString('utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Event name / payload from a Centrifugo publication, or null. */
export function extractPublication(push) {
  if (!push || typeof push !== 'object') return null;
  const channel = typeof push.channel === 'string' ? push.channel : null;
  const pub = push.pub ?? (Array.isArray(push.pubs) ? push.pubs[0] : null);
  if (!pub || typeof pub !== 'object') return null;
  const wrapped = pub.data;
  if (!wrapped || typeof wrapped !== 'object') return null;
  const event = typeof wrapped.event === 'string' ? wrapped.event : null;
  let data = wrapped.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return {channel, event, data: null, raw: wrapped.data, decodeFailed: true};
    }
  }
  return {channel, event, data: data ?? null, raw: null, decodeFailed: false};
}

export function kickEventKind(eventName) {
  return KICK_EVENT_KINDS[eventName] ?? 'unknown';
}

export function isKickChatEvent(eventName) {
  return KICK_CHAT_EVENTS.includes(eventName);
}

/** Parse `[emote:37226:pepe]` markers. The raw content is never rewritten. */
export function parseKickEmotes(content) {
  if (typeof content !== 'string' || !content.includes('[emote:')) return null;
  const found = [];
  EMOTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = EMOTE_PATTERN.exec(content)) !== null) {
    found.push({id: match[1], name: match[2], source: 'kick'});
  }
  return normalizeEmotes(found);
}

/**
 * Map Kick's badge list to the canonical, deliberately small badge set.
 * Labels are the platform's own text; nothing is translated or inferred.
 */
export function mapKickBadges(identity) {
  const source = identity?.badges;
  if (!Array.isArray(source)) return null;
  const mapped = [];
  for (const badge of source) {
    if (!badge || typeof badge !== 'object') continue;
    const type = String(badge.type ?? '').toLowerCase();
    const label = typeof badge.text === 'string' ? badge.text : (typeof badge.type === 'string' ? badge.type : null);
    let canonical = 'unknown';
    if (type === 'subscriber' || type === 'founder' || type === 'sub_gifter') canonical = 'member';
    else if (type === 'moderator') canonical = 'moderator';
    else if (type === 'broadcaster' || type === 'owner' || type === 'streamer') canonical = 'owner';
    else if (type === 'verified') canonical = 'verified';
    mapped.push({type: canonical, label});
  }
  return normalizeBadges(mapped);
}

/**
 * Kick timestamps are ISO-8601 with an explicit offset (`+00:00`). A value
 * without an offset is treated as UTC, because the platform backend is UTC;
 * the adapter records that the fallback happened instead of silently calling it
 * local time.
 */
export function parseKickTimestamp(value) {
  if (value === null || value === undefined || value === '') return {ms: null, assumedUtc: false};
  const text = String(value).trim();
  const noZone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text);
  const ms = Date.parse(noZone ? `${text.replace(' ', 'T')}Z` : text);
  return {ms: Number.isFinite(ms) ? ms : null, assumedUtc: noZone};
}

function positiveId(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text || text === '0') return null;
  return text;
}

/**
 * Build the canonical chat draft for one real Kick message.
 *
 * @param {object} data parsed `ChatMessageEvent.data`
 * @param {{sessionId?: string|null, room?: object|null, receivedAt?: number}} context
 * @returns {{draft: object|null, reason: string|null, assumedUtc: boolean}}
 */
export function mapKickChatEvent(data, {sessionId = null, room = null, receivedAt = Date.now()} = {}) {
  if (!data || typeof data !== 'object') return {draft: null, reason: 'not_object', assumedUtc: false};
  const sender = data.sender && typeof data.sender === 'object' ? data.sender : null;
  const viewerUid = positiveId(sender?.id);
  const displayName = typeof sender?.username === 'string' ? sender.username : null;
  if (typeof data.content !== 'string') return {draft: null, reason: 'content_missing', assumedUtc: false};
  if (!displayName) return {draft: null, reason: 'username_missing', assumedUtc: false};

  const timestamp = parseKickTimestamp(data.created_at);
  const externalId = typeof data.id === 'string' && data.id ? data.id : null;
  const occurredAt = timestamp.ms ?? receivedAt;
  const hasStableId = viewerUid !== null;
  const verified = Boolean(hasStableId && externalId && timestamp.ms && displayName);

  const draft = {
    session_id: sessionId,
    platform: 'kick',
    event_type: 'chat',
    external_id: externalId,
    viewer_uid: viewerUid,
    display_name: displayName,
    content: data.content,
    occurred_at: occurredAt,
    received_at: receivedAt,
    emotes: parseKickEmotes(data.content),
    badges: mapKickBadges(sender?.identity),
    source_quality: verified ? 'verified' : 'unknown',
    // Internal diagnostics only; normalizeEvent ignores these keys.
    _kick: {
      chatroomId: positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId),
      channelId: positiveId(room?.channelId),
      slug: room?.slug ?? null,
      messageType: typeof data.type === 'string' ? data.type : null,
      replyTo: typeof data.metadata?.original_message?.id === 'string' ? data.metadata.original_message.id : null,
      timestampSource: timestamp.ms ? 'created_at' : 'received_at',
      assumedUtc: timestamp.assumedUtc
    }
  };
  return {draft, reason: null, assumedUtc: timestamp.assumedUtc};
}

/**
 * KICKs gift (`KicksGifted`, published on `channel_<channelId>`).
 *
 * Kick reports how many KICKs were sent but never a fiat amount or currency, so
 * the event keeps the KICKs count as display-only text and leaves
 * `amount_minor`/`currency` NULL with `value_kind=unknown`. The transaction id
 * becomes `external_id`, and the sender id is the stable viewer identity.
 */
export function mapKickGiftEvent(data, {sessionId = null, room = null, receivedAt = Date.now()} = {}) {
  if (!data || typeof data !== 'object') return {drafts: [], reason: 'not_object'};
  const sender = data.sender && typeof data.sender === 'object' ? data.sender : null;
  const gift = data.gift && typeof data.gift === 'object' ? data.gift : null;
  const displayName = typeof sender?.username === 'string' && sender.username ? sender.username : null;
  if (!displayName) return {drafts: [], reason: 'username_missing'};
  if (!gift || typeof gift !== 'object') return {drafts: [], reason: 'gift_missing'};

  const transactionId = typeof data.gift_transaction_id === 'string' && data.gift_transaction_id
    ? data.gift_transaction_id
    : null;
  const timestamp = parseKickTimestamp(data.created_at);
  const amount = Number(gift.amount);
  const typeParts = [gift.type, gift.tier].filter((part) => typeof part === 'string' && part);
  const displayParts = [];
  if (Number.isFinite(amount) && amount >= 0) displayParts.push(`${Math.trunc(amount)} KICKs`);
  if (typeParts.length > 0) displayParts.push(typeParts.join('/'));
  const message = typeof data.message === 'string' && data.message ? data.message : null;

  const draft = {
    session_id: sessionId,
    platform: 'kick',
    event_type: 'gift',
    external_id: transactionId,
    viewer_uid: positiveId(sender?.id),
    display_name: displayName,
    content: message,
    occurred_at: timestamp.ms ?? receivedAt,
    received_at: receivedAt,
    emotes: null,
    badges: mapKickBadges(sender?.identity),
    gift_id: typeof gift.gift_id === 'string' && gift.gift_id ? gift.gift_id : null,
    gift_name: typeof gift.name === 'string' && gift.name ? gift.name : null,
    gift_type: 'paid',
    gift_quantity: 1,
    // KICKs are not a fiat currency: no amount, no currency, no income total.
    amount_minor: null,
    unit_amount_minor: null,
    currency: null,
    value_kind: 'unknown',
    amount_display: displayParts.length > 0 ? displayParts.join(' · ').slice(0, 80) : null,
    is_paid: true,
    source_quality: transactionId && timestamp.ms && positiveId(sender?.id) ? 'verified' : 'unknown',
    _kick: {
      chatroomId: positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId),
      channelId: positiveId(room?.channelId),
      slug: room?.slug ?? null,
      transactionId,
      kicks: Number.isFinite(amount) ? Math.trunc(amount) : null,
      giftType: typeof gift.type === 'string' ? gift.type : null,
      giftTier: typeof gift.tier === 'string' ? gift.tier : null,
      timestampSource: timestamp.ms ? 'created_at' : 'received_at'
    }
  };
  return {drafts: [draft], reason: null};
}

/**
 * Gifted subscriptions (`GiftedSubscriptionsEvent`, published on
 * `chatroom_<chatroomId>`).
 *
 * The platform event carries only usernames: `gifter_username` and
 * `gifted_usernames[]`, with no stable user ids. Following the existing
 * YouTube gifted-membership shape, the gifter becomes one paid membership event
 * with the gifted total, and every recipient becomes one free membership event.
 * No recipient gets a viewer identity, and no fiat amount is invented.
 */
export function mapKickGiftedSubscriptions(data, {sessionId = null, room = null, receivedAt = Date.now()} = {}) {
  if (!data || typeof data !== 'object') return {drafts: [], reason: 'not_object'};
  const gifter = typeof data.gifter_username === 'string' && data.gifter_username ? data.gifter_username : null;
  const names = Array.isArray(data.gifted_usernames)
    ? data.gifted_usernames.filter((name) => typeof name === 'string' && name).slice(0, 100)
    : [];
  if (!gifter && names.length === 0) return {drafts: [], reason: 'gifted_subscription_empty'};

  const rawTotal = Number(data.gifted_total);
  const total = Number.isFinite(rawTotal) && rawTotal > 0
    ? Math.min(Math.trunc(rawTotal), 100000)
    : Math.max(1, names.length);
  const correlationId = typeof data.correlation_id === 'string' && data.correlation_id ? data.correlation_id : null;
  // A stable dedupe id even if Kick omits correlation_id: the event has no
  // message id of its own, and the usernames/total identify it well enough.
  const base = (correlationId
    ?? `giftsub:${positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId) ?? ''}:${gifter ?? 'unknown'}:${total}:${names.join(',')}`)
    .slice(0, 180);

  const drafts = [];
  if (gifter) {
    drafts.push({
      session_id: sessionId,
      platform: 'kick',
      event_type: 'membership',
      external_id: base,
      viewer_uid: null,
      display_name: gifter,
      content: null,
      occurred_at: receivedAt,
      received_at: receivedAt,
      emotes: null,
      badges: null,
      gift_id: 'gifted-subscriptions',
      gift_name: null,
      gift_type: 'paid',
      gift_quantity: total,
      amount_minor: null,
      unit_amount_minor: null,
      currency: null,
      value_kind: 'unknown',
      amount_display: null,
      is_paid: true,
      source_quality: correlationId ? 'verified' : 'unknown',
      _kick: {
        chatroomId: positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId),
        channelId: positiveId(room?.channelId),
        slug: room?.slug ?? null,
        correlationId,
        gifterTotal: Number.isFinite(Number(data.gifter_total)) ? Number(data.gifter_total) : null,
        recipientCount: names.length
      }
    });
  }
  names.forEach((name, index) => {
    drafts.push({
      session_id: sessionId,
      platform: 'kick',
      event_type: 'membership',
      external_id: `${base}:recipient:${index}`.slice(0, 200),
      viewer_uid: null,
      display_name: name,
      content: null,
      occurred_at: receivedAt,
      received_at: receivedAt,
      emotes: null,
      badges: null,
      gift_id: 'gifted-subscription-received',
      gift_name: null,
      gift_type: 'free',
      gift_quantity: 1,
      amount_minor: null,
      unit_amount_minor: null,
      currency: null,
      value_kind: 'unknown',
      amount_display: null,
      // The recipient did not pay: never counted as a payer.
      is_paid: false,
      source_quality: correlationId ? 'verified' : 'unknown',
      _kick: {
        chatroomId: positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId),
        channelId: positiveId(room?.channelId),
        slug: room?.slug ?? null,
        correlationId,
        recipientIndex: index
      }
    });
  });
  return {drafts, reason: null};
}

/**
 * A plain subscription/renewal (`SubscriptionEvent`). Never observed live so
 * far; the documented shape is `{username, months}` with no user id. Kept
 * mapped so a real event is not dropped, and marked as no stable identity.
 */
export function mapKickSubscriptionEvent(data, {sessionId = null, room = null, receivedAt = Date.now()} = {}) {
  if (!data || typeof data !== 'object') return {drafts: [], reason: 'not_object'};
  const username = typeof data.username === 'string' && data.username ? data.username : null;
  if (!username) return {drafts: [], reason: 'username_missing'};
  const months = Number(data.months);
  return {
    drafts: [{
      session_id: sessionId,
      platform: 'kick',
      event_type: 'membership',
      external_id: null,
      viewer_uid: null,
      display_name: username,
      content: null,
      occurred_at: receivedAt,
      received_at: receivedAt,
      emotes: null,
      badges: null,
      gift_id: 'subscription',
      gift_name: null,
      gift_type: 'paid',
      gift_quantity: 1,
      amount_minor: null,
      unit_amount_minor: null,
      currency: null,
      value_kind: 'unknown',
      amount_display: Number.isFinite(months) && months > 0 ? `${Math.trunc(months)} mo` : null,
      is_paid: true,
      source_quality: 'unknown',
      _kick: {
        chatroomId: positiveId(data.chatroom_id) ?? positiveId(room?.chatroomId),
        channelId: positiveId(room?.channelId),
        slug: room?.slug ?? null,
        months: Number.isFinite(months) ? Math.trunc(months) : null
      }
    }],
    reason: null
  };
}

/**
 * Route one non-chat publication to its canonical drafts.
 * Unknown/unsupported events return an empty list so the adapter can count them
 * without inventing a user-visible event.
 */
export function mapKickEvent(eventName, data, context = {}) {
  const kind = kickEventKind(eventName);
  switch (kind) {
    case 'kicks_gifted':
      return {...mapKickGiftEvent(data, context), kind};
    case 'gifted_subscriptions':
      return {...mapKickGiftedSubscriptions(data, context), kind};
    case 'subscription':
      return {...mapKickSubscriptionEvent(data, context), kind};
    default:
      return {drafts: [], reason: kind === 'unknown' ? 'unknown_event' : 'unsupported_event', kind};
  }
}

/** Decode the JWT payload of the anonymous guest token (no signature trust). */
export function decodeJwtPayload(token) {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export const __internal = {EMOTE_PATTERN, positiveId};
