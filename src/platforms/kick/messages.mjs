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
