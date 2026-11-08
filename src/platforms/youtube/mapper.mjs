import {EVENT_TYPES, SOURCE_QUALITY} from '../../shared/events.mjs';
import {cleanText} from '../../shared/text.mjs';
import {normalizeEmotes} from '../../shared/emoticons.mjs';
import {currencyDigits, normalizeCurrency} from '../../shared/money.mjs';

/**
 * YouTube Live Chat mapper.
 *
 * Input: one item of `liveChatMessages.list` (official Data API v3 shape).
 * Output: a canonical event draft, or `null` for events LiveMemory deliberately
 * does not record (message deletions, bans, tombstones, sponsor-only toggles).
 *
 * Field sources (official API):
 * - `id`                                   message id (stable, used for dedupe)
 * - `snippet.publishedAt`                  platform timestamp
 * - `snippet.type`                         event discriminator
 * - `snippet.displayMessage`               display text
 * - `snippet.textMessageDetails.messageText` raw text of a normal message
 * - `snippet.authorChannelId.value`        stable author id (snippet side)
 * - `authorDetails.channelId`              stable author id (details side)
 * - `authorDetails.displayName`            display name
 * - `snippet.superChatDetails`             Super Chat amount/currency/comment
 * - `snippet.superStickerDetails`          Super Sticker amount/currency/alt text
 * - `snippet.newSponsorDetails`            new membership level
 * - `snippet.memberMilestoneChatDetails`   membership milestone + comment
 * - `snippet.membershipGiftingDetails`     gifted memberships (count, level)
 * - `snippet.giftMembershipReceivedDetails` recipient of a gifted membership
 *
 * Honesty rules:
 * - `source_quality` stays `estimated` until a real broadcast sample is recorded;
 *   the fields are official but have not been observed live in this project yet.
 * - A missing channel id is never invented and never replaced by a nickname.
 * - Membership levels, months and gifted counts are never converted into money.
 * - The recipient of a gifted membership is never counted as a payer.
 */

export const YOUTUBE_MAPPER_STATUS = 'unverified';
export const YOUTUBE_EVENT_SOURCE_QUALITY = SOURCE_QUALITY.ESTIMATED;

const CODE_PATTERN = /(?<![\p{L}\p{N}_:/]):([A-Za-z0-9_+-]{2,64}):(?![\p{L}\p{N}_/])/gu;

/** Events LiveMemory intentionally drops (moderation/system noise, not chat). */
export const IGNORED_YOUTUBE_EVENTS = Object.freeze([
  'messageDeletedEvent',
  'userBannedEvent',
  'tombstone',
  'sponsorOnlyModeStartedEvent',
  'sponsorOnlyModeEndedEvent',
  'chatEndedEvent'
]);

/** Extract `:code:` style custom emote codes without touching the original text. */
export function extractYouTubeEmoteCodes(text) {
  if (typeof text !== 'string' || !text) return [];
  const emotes = [];
  const seen = new Set();
  for (const match of text.matchAll(CODE_PATTERN)) {
    const code = match[0];
    if (seen.has(code)) continue;
    seen.add(code);
    emotes.push({code, name: match[1], source: 'youtube.messageText'});
    if (emotes.length >= 20) break;
  }
  return emotes;
}

function occurredAtFrom(value, fallback) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Convert `amountMicros` (a string integer, 1 unit = 1e-6 of the currency) into
 * integer minor units without floating point drift.
 * Returns null for an unusable value.
 */
export function microsToMinor(amountMicros, currency) {
  if (amountMicros === null || amountMicros === undefined) return null;
  let micros;
  try {
    micros = BigInt(String(amountMicros).trim());
  } catch {
    return null;
  }
  if (micros < 0n) return null;
  const digits = Math.min(6, Math.max(0, currencyDigits(normalizeCurrency(currency))));
  const divisor = 10n ** BigInt(6 - digits);
  if (divisor === 1n) return Number(micros);
  const whole = micros / divisor;
  const remainder = micros % divisor;
  // Round half away from zero on the last supported digit.
  const rounded = remainder * 2n >= divisor ? whole + 1n : whole;
  const value = Number(rounded);
  return Number.isSafeInteger(value) ? value : null;
}

function identityOf(snippet, authorDetails) {
  const uid = cleanText(snippet?.authorChannelId?.value ?? authorDetails?.channelId, 200);
  const name = cleanText(authorDetails?.displayName ?? snippet?.displayName, 120);
  return {uid: uid || null, name, complete: Boolean(uid) && Boolean(name)};
}

function baseDraft({message, snippet, authorDetails, receivedAt, eventType}) {
  const identity = identityOf(snippet, authorDetails);
  return {
    platform: 'youtube',
    event_type: eventType,
    external_id: cleanText(message?.id, 200) || null,
    viewer_uid: identity.uid,
    display_name: identity.name,
    occurred_at: occurredAtFrom(snippet?.publishedAt, receivedAt),
    is_paid: false,
    gift_type: null,
    source_quality: YOUTUBE_EVENT_SOURCE_QUALITY,
    identity_complete: identity.complete,
    verified: false
  };
}

function amountFields(details) {
  const currency = normalizeCurrency(details?.currency, 'USD');
  return {
    amount_minor: microsToMinor(details?.amountMicros, currency),
    currency,
    value_kind: 'actual',
    is_paid: true,
    gift_type: 'paid'
  };
}

/**
 * @param {object} message a `liveChatMessages.list` item
 * @param {{receivedAt?:number}} options
 * @returns {object|null} canonical draft (without `session_id`)
 */
export function mapYouTubeChatMessage(message, {receivedAt = Date.now()} = {}) {
  const snippet = message?.snippet;
  if (!snippet || typeof snippet !== 'object') return null;
  const authorDetails = message?.authorDetails ?? null;
  const type = snippet.type ?? null;

  if (!type || IGNORED_YOUTUBE_EVENTS.includes(type)) return null;

  if (type === 'textMessageEvent' || type === 'superChatEvent') {
    const text = type === 'superChatEvent'
      ? (snippet.superChatDetails?.userComment ?? snippet.displayMessage)
      : (snippet.textMessageDetails?.messageText ?? snippet.displayMessage);
    const content = cleanText(text, 4000);
    const emotes = normalizeEmotes(extractYouTubeEmoteCodes(content));
    const draft = baseDraft({
      message,
      snippet,
      authorDetails,
      receivedAt,
      eventType: type === 'superChatEvent' ? EVENT_TYPES.SUPER_CHAT : EVENT_TYPES.CHAT
    });
    draft.content = content;
    draft.emotes = emotes;
    if (type === 'superChatEvent') {
      Object.assign(draft, amountFields(snippet.superChatDetails));
      draft.is_paid = true;
    }
    if (!content && !emotes && type !== 'superChatEvent') return null;
    return draft;
  }

  if (type === 'superStickerEvent') {
    const details = snippet.superStickerDetails ?? {};
    const meta = details.superStickerMetadata ?? {};
    const draft = baseDraft({message, snippet, authorDetails, receivedAt, eventType: EVENT_TYPES.SUPER_STICKER});
    Object.assign(draft, amountFields(details));
    draft.content = null;
    draft.emotes = null;
    // Even without a comment the payer, amount, currency and sticker identity stay.
    draft.gift_id = cleanText(meta.stickerId, 120) || null;
    draft.gift_name = cleanText(meta.altText, 120) || null;
    draft.gift_quantity = 1;
    return draft;
  }

  if (type === 'newSponsorEvent' || type === 'memberMilestoneChatEvent') {
    const isMilestone = type === 'memberMilestoneChatEvent';
    const details = isMilestone ? (snippet.memberMilestoneChatDetails ?? {}) : (snippet.newSponsorDetails ?? {});
    const draft = baseDraft({message, snippet, authorDetails, receivedAt, eventType: EVENT_TYPES.MEMBERSHIP});
    const level = cleanText(details.memberLevelName, 120) || null;
    draft.content = isMilestone ? cleanText(details.userComment, 4000) : null;
    draft.emotes = isMilestone ? normalizeEmotes(extractYouTubeEmoteCodes(draft.content)) : null;
    draft.gift_id = isMilestone && Number.isFinite(Number(details.memberMonth))
      ? `membership-month:${Number(details.memberMonth)}`
      : null;
    draft.gift_name = level;
    draft.gift_type = 'paid';
    // A membership is a paid commitment, but the API does not report an amount.
    // Level / month count are never turned into money.
    draft.is_paid = true;
    draft.amount_minor = null;
    draft.currency = null;
    draft.value_kind = 'unknown';
    draft.membership = {
      kind: isMilestone ? 'milestone' : 'new',
      level,
      month: isMilestone && Number.isFinite(Number(details.memberMonth)) ? Number(details.memberMonth) : null,
      upgrade: !isMilestone && details.isUpgrade === true
    };
    return draft;
  }

  if (type === 'membershipGiftingEvent') {
    const details = snippet.membershipGiftingDetails ?? {};
    const count = Number(details.giftMembershipsCount);
    const draft = baseDraft({message, snippet, authorDetails, receivedAt, eventType: EVENT_TYPES.MEMBERSHIP});
    draft.content = null;
    draft.emotes = null;
    draft.gift_id = 'membership-gifting';
    draft.gift_name = cleanText(details.giftMembershipsLevelName, 120) || null;
    draft.gift_quantity = Number.isFinite(count) && count > 0 ? Math.min(Math.trunc(count), 100000) : 1;
    draft.gift_type = 'paid';
    draft.is_paid = true;
    draft.amount_minor = null;
    draft.currency = null;
    draft.value_kind = 'unknown';
    draft.membership = {
      kind: 'gifting',
      level: draft.gift_name,
      count: draft.gift_quantity
    };
    return draft;
  }

  if (type === 'giftMembershipReceivedEvent') {
    const details = snippet.giftMembershipReceivedDetails ?? {};
    const draft = baseDraft({message, snippet, authorDetails, receivedAt, eventType: EVENT_TYPES.MEMBERSHIP});
    draft.content = null;
    draft.emotes = null;
    draft.gift_id = 'membership-received';
    draft.gift_name = cleanText(details.memberLevelName, 120) || null;
    draft.gift_type = 'free';
    // The recipient did NOT pay: never counted as a payer and never given a price.
    draft.is_paid = false;
    draft.amount_minor = null;
    draft.currency = null;
    draft.value_kind = 'unknown';
    draft.membership = {
      kind: 'received',
      level: draft.gift_name,
      gifter_channel_id: cleanText(details.gifterChannelId, 200) || null,
      source_message_id: cleanText(details.associatedMembershipGiftingMessageId, 200) || null
    };
    return draft;
  }

  // Unknown future event types are ignored rather than guessed into chat.
  return null;
}

/** True when the mapper understands the event type (used by diagnostics). */
export function isKnownYouTubeEvent(type) {
  return [
    'textMessageEvent',
    'superChatEvent',
    'superStickerEvent',
    'newSponsorEvent',
    'memberMilestoneChatEvent',
    'membershipGiftingEvent',
    'giftMembershipReceivedEvent'
  ].includes(type);
}

export const __internal = {CODE_PATTERN, identityOf, amountFields};
