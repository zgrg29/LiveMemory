import {AppError, ERROR_CODES} from './errors.mjs';
import {normalizeCurrency, multiplyMinor} from './money.mjs';
import {toEpochMs} from './time.mjs';
import {sha256Hex} from './ids.mjs';
import {cleanText} from './text.mjs';
import {normalizeEmotes} from './emoticons.mjs';
import {normalizeBadges} from './badges.mjs';

/**
 * Canonical internal event model.
 *
 * Every platform adapter converts its native payload into this shape before it
 * reaches storage. UI, analytics and the AI package format therefore never
 * depend on Bilibili/YouTube specifics.
 */
export const EVENT_TYPES = Object.freeze({
  CHAT: 'chat',
  GIFT: 'gift',
  SUPER_CHAT: 'super_chat',
  SUPER_STICKER: 'super_sticker',
  GUARD: 'guard',
  MEMBERSHIP: 'membership',
  SYSTEM: 'system'
});

export const EVENT_TYPE_VALUES = Object.freeze(Object.values(EVENT_TYPES));

/** Event types that count as a message ("弹幕/聊天"). */
export const MESSAGE_EVENT_TYPES = Object.freeze([EVENT_TYPES.CHAT, EVENT_TYPES.SUPER_CHAT]);

/** Event types that carry an economic contribution. */
export const PAYMENT_EVENT_TYPES = Object.freeze([
  EVENT_TYPES.GIFT,
  EVENT_TYPES.SUPER_CHAT,
  EVENT_TYPES.SUPER_STICKER,
  EVENT_TYPES.GUARD,
  EVENT_TYPES.MEMBERSHIP
]);

export const SOURCE_QUALITY = Object.freeze({
  VERIFIED: 'verified',
  ESTIMATED: 'estimated',
  UNKNOWN: 'unknown',
  MOCK: 'mock'
});

export const VALUE_KIND = Object.freeze({
  /** Amount the viewer actually paid, as reported by the platform. */
  ACTUAL: 'actual',
  /** Display value of a gift (may differ from real payment, e.g. discounts). */
  DISPLAY: 'display',
  UNKNOWN: 'unknown'
});

const MAX_CONTENT_LENGTH = 4000;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isMessageEvent(eventType) {
  return MESSAGE_EVENT_TYPES.includes(eventType);
}

export function isPaymentEvent(eventType) {
  return PAYMENT_EVENT_TYPES.includes(eventType);
}

/** Viewer identity is namespaced by platform: nickname is never an identity. */
export function buildViewerId(platform, platformUid) {
  const uid = platformUid === null || platformUid === undefined ? '' : String(platformUid).trim();
  // Bilibili reports UID 0 when it withholds an identity (guest/risk control).
  // Treating it as an id would put every anonymous viewer into one profile,
  // which the product forbids. No supported platform uses 0 as a real user id.
  if (!uid || uid === '0') return null;
  return `${platform}:${uid}`;
}

function defaultPaid(eventType) {
  if (eventType === EVENT_TYPES.CHAT || eventType === EVENT_TYPES.SYSTEM) return false;
  return true;
}

/**
 * Normalize a platform agnostic event draft into the canonical model.
 * Throws AppError(EVENT_INVALID) rather than storing half-valid rows.
 * @param {object} draft
 * @param {{now?: number, requireSession?: boolean}} options
 */
export function normalizeEvent(draft, {now = Date.now(), requireSession = true} = {}) {
  if (!draft || typeof draft !== 'object') {
    throw new AppError(ERROR_CODES.EVENT_INVALID, {messageKey: 'errors.eventInvalid', httpStatus: 400});
  }
  const platform = String(draft.platform ?? '').trim().toLowerCase();
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new AppError(ERROR_CODES.EVENT_INVALID, {
      messageKey: 'errors.eventInvalid',
      details: {field: 'platform'},
      httpStatus: 400
    });
  }
  const eventType = String(draft.event_type ?? draft.eventType ?? '').trim();
  if (!EVENT_TYPE_VALUES.includes(eventType)) {
    throw new AppError(ERROR_CODES.EVENT_INVALID, {
      messageKey: 'errors.eventInvalid',
      details: {field: 'event_type'},
      httpStatus: 400
    });
  }
  const sessionId = draft.session_id ?? draft.sessionId ?? null;
  if (requireSession && !sessionId) {
    throw new AppError(ERROR_CODES.EVENT_INVALID, {
      messageKey: 'errors.eventInvalid',
      details: {field: 'session_id'},
      httpStatus: 400
    });
  }

  const receivedAt = toEpochMs(draft.received_at ?? draft.receivedAt, now) ?? now;
  const occurredAt = toEpochMs(draft.occurred_at ?? draft.occurredAt, receivedAt) ?? receivedAt;
  const platformUid = draft.viewer_uid ?? draft.viewerUid ?? draft.viewer_id ?? draft.viewerId ?? null;
  const uidText = platformUid === null || platformUid === undefined ? '' : String(platformUid).trim();
  // `0` and `"0"` are the platform's "identity withheld" marker, not a person.
  // Keep viewer_uid NULL so a missing identity can never be aggregated as one
  // shared viewer, and so the UI can count these messages as unidentified.
  const uid = uidText === '0' ? '' : uidText;

  const giftQuantityRaw = Number(draft.gift_quantity ?? draft.giftQuantity ?? 1);
  const giftQuantity = Number.isFinite(giftQuantityRaw) && giftQuantityRaw > 0
    ? Math.min(Math.trunc(giftQuantityRaw), 100000)
    : 1;

  // A platform that reports no amount also reports no currency (e.g. YouTube
  // memberships): keep it NULL instead of inventing a default currency.
  const currency = draft.currency === null || draft.currency === undefined
    ? null
    : normalizeCurrency(draft.currency);
  const rawUnit = draft.unit_amount_minor ?? draft.unitAmountMinor ?? null;
  const unitAmountMinor = rawUnit === null || rawUnit === undefined ? null : Math.trunc(Number(rawUnit));
  const rawAmount = draft.amount_minor ?? draft.amountMinor ?? null;
  let amountMinor = rawAmount === null || rawAmount === undefined ? null : Math.trunc(Number(rawAmount));
  if (amountMinor === null && unitAmountMinor !== null) {
    amountMinor = multiplyMinor(unitAmountMinor, giftQuantity);
  }
  const safeAmount = Number.isFinite(amountMinor) ? amountMinor : null;
  const safeUnit = Number.isFinite(unitAmountMinor) ? unitAmountMinor : null;

  const giftType = draft.gift_type ?? draft.giftType ?? null;
  const isPaid = typeof draft.is_paid === 'boolean'
    ? draft.is_paid
    : (typeof draft.isPaid === 'boolean'
      ? draft.isPaid
      : (giftType === 'free' ? false : defaultPaid(eventType)));

  const explicitValueKind = draft.value_kind ?? draft.valueKind;
  const valueKind = Object.values(VALUE_KIND).includes(explicitValueKind)
    ? explicitValueKind
    : (safeAmount !== null && isPaid ? VALUE_KIND.ACTUAL : VALUE_KIND.UNKNOWN);

  const sourceQuality = Object.values(SOURCE_QUALITY).includes(draft.source_quality ?? draft.sourceQuality)
    ? (draft.source_quality ?? draft.sourceQuality)
    : (platform === 'mock' ? SOURCE_QUALITY.MOCK : SOURCE_QUALITY.UNKNOWN);

  // Emote metadata only belongs to messages with text. It never replaces the
  // original `content`; it is a small, de-duplicated annotation for the UI and
  // the AI package.
  const emotes = isMessageEvent(eventType) ? normalizeEmotes(draft.emotes) : null;
  const badges = normalizeBadges(draft.badges);
  const amountDisplay = cleanText(draft.amount_display ?? draft.amountDisplay, 80);

  const event = {
    session_id: sessionId,
    platform,
    external_id: cleanText(draft.external_id ?? draft.externalId ?? null, 200),
    event_type: eventType,
    viewer_uid: uid || null,
    viewer_id: buildViewerId(platform, uid),
    display_name: cleanText(draft.display_name ?? draft.displayName, 120),
    occurred_at: occurredAt,
    received_at: receivedAt,
    content: cleanText(draft.content, MAX_CONTENT_LENGTH),
    emotes,
    badges,
    gift_id: cleanText(draft.gift_id ?? draft.giftId, 120),
    gift_name: cleanText(draft.gift_name ?? draft.giftName, 120),
    gift_type: giftType === 'free' || giftType === 'paid' ? giftType : null,
    gift_quantity: isPaymentEvent(eventType) ? giftQuantity : 1,
    unit_amount_minor: safeUnit,
    amount_minor: eventType === EVENT_TYPES.CHAT ? null : safeAmount,
    amount_display: amountDisplay,
    currency,
    value_kind: eventType === EVENT_TYPES.CHAT ? VALUE_KIND.UNKNOWN : valueKind,
    is_paid: isPaid,
    source_quality: sourceQuality
  };
  event.dedupe_key = buildDedupeKey(event);
  return event;
}

/**
 * Dedupe key. Platform ids are authoritative when present; otherwise a
 * deterministic hash of the identifying fields prevents double counting after
 * reconnects or replayed batches.
 */
export function buildDedupeKey(event) {
  if (event.external_id) return `ext:${event.external_id}`;
  const emoteFingerprint = normalizeEmotes(event.emotes)
    ?.map((emote) => emote.id ?? emote.code ?? emote.name)
    .join(',') ?? '';
  const fingerprint = [
    event.platform,
    event.event_type,
    event.viewer_uid ?? '',
    event.occurred_at ?? '',
    event.content ?? '',
    emoteFingerprint,
    event.gift_id ?? '',
    event.gift_name ?? '',
    event.gift_quantity ?? '',
    event.amount_minor ?? '',
    event.currency ?? '',
    event.amount_display ?? '',
    normalizeBadges(event.badges)?.map((badge) => `${badge.type}:${badge.label ?? ''}`).join(',') ?? ''
  ].join('\u0001');
  return `fp:${sha256Hex(fingerprint)}`;
}
