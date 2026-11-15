import {EVENT_TYPES, SOURCE_QUALITY} from '../../shared/events.mjs';
import {cleanText} from '../../shared/text.mjs';
import {normalizeEmotes} from '../../shared/emoticons.mjs';
import {normalizeBadges} from '../../shared/badges.mjs';
import {parseBadgesTag, parseEmotesTag, stripActionWrapper} from './irc.mjs';

/**
 * Twitch chat → canonical event mapping.
 *
 * Evidence levels are explicit per event (see `docs/PLATFORM_INTEGRATIONS.md`):
 * - PRIVMSG chat and resub notifications were observed in real public channels;
 * - new subscriptions, gifted subscriptions, Cheer/Bits and other USERNOTICE
 *   variants are parsed from documented IRC tags but may not have been observed
 *   live yet, so their `source_quality` stays `estimated`.
 *
 * Twitch never reports a fiat amount for Bits, subscriptions or gifted subs.
 * Those events therefore keep `amount_minor = null`, `currency = null` and
 * `value_kind = unknown`; the tier / month count / Bits count is stored as a
 * display label only and is never converted into money.
 */

export const TWITCH_EVENT_SOURCE_QUALITY = Object.freeze({
  chat: SOURCE_QUALITY.VERIFIED,
  resub: SOURCE_QUALITY.VERIFIED,
  sub: SOURCE_QUALITY.ESTIMATED,
  subgift: SOURCE_QUALITY.ESTIMATED,
  cheer: SOURCE_QUALITY.ESTIMATED
});

export const IGNORED_TWITCH_USERNOTICE = Object.freeze([
  // Informational total that precedes each `subgift`. Counting both would
  // double-count the same gifted subscriptions.
  'submysterygift',
  // Watch-streak celebration; not a payment and not a chat message.
  'viewermilestone',
  // Badge/announcement/raid notices are system events, not viewer chat.
  'bitsbadgetier',
  'announcement',
  'raid',
  'unraid',
  'rewardgift',
  'charitydonation'
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** `1000/2000/3000` or `Prime` → a display label, never a price. */
export function subscriptionPlanLabel(plan) {
  const text = String(plan ?? '').trim();
  if (!text) return 'Subscription';
  const normalized = text.toLowerCase();
  if (normalized === 'prime') return 'Prime';
  const tier = {1: '1000', 2: '2000', 3: '3000'}[normalized] ?? normalized;
  if (tier === '1000') return 'Tier 1';
  if (tier === '2000') return 'Tier 2';
  if (tier === '3000') return 'Tier 3';
  // Unknown plan codes are shown verbatim; never guessed into a tier.
  return `Plan ${text}`;
}

function badgeInfoOf(tags) {
  return normalizeBadges(parseBadgesTag(tags.badges, tags['badge-info']));
}

function identityOf(tags) {
  const uid = cleanText(tags['user-id'], 200) || null;
  const name = cleanText(tags['display-name'] ?? tags.login, 120) || null;
  return {uid, name, complete: Boolean(uid) && Boolean(name)};
}

function timestampOf(tags, fallback) {
  const raw = Number(tags['tmi-sent-ts']);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

function baseDraft(tags, {eventType, receivedAt, sourceQuality}) {
  const identity = identityOf(tags);
  return {
    platform: 'twitch',
    event_type: eventType,
    external_id: cleanText(tags.id, 200) || null,
    viewer_uid: identity.uid,
    display_name: identity.name,
    occurred_at: timestampOf(tags, receivedAt),
    is_paid: false,
    gift_type: null,
    source_quality: sourceQuality,
    identity_complete: identity.complete,
    badges: badgeInfoOf(tags)
  };
}

/**
 * Map a PRIVMSG. A message carrying `bits` is a Cheer: it is both a paid
 * contribution and a message with text, so it uses the existing `super_chat`
 * type (a paid message) rather than inventing a schema change.
 *
 * @param {object} parsed result of `parseIrcLine`
 * @param {{receivedAt?:number}} options
 * @returns {object|null} canonical draft without `session_id`
 */
export function mapTwitchPrivmsg(parsed, {receivedAt = Date.now()} = {}) {
  if (!parsed || parsed.command !== 'PRIVMSG') return null;
  const tags = parsed.tags ?? {};
  const content = cleanText(stripActionWrapper(parsed.trailing ?? ''), 4000);
  const emotes = normalizeEmotes(parseEmotesTag(tags.emotes));
  const bits = positiveInteger(tags.bits);
  if (!content && !emotes && !bits) return null;

  if (bits) {
    const draft = baseDraft(tags, {
      eventType: EVENT_TYPES.SUPER_CHAT,
      receivedAt,
      sourceQuality: TWITCH_EVENT_SOURCE_QUALITY.cheer
    });
    draft.content = content;
    draft.emotes = emotes;
    draft.gift_id = 'twitch-bits';
    draft.gift_name = 'Bits';
    draft.gift_type = 'paid';
    draft.gift_quantity = bits;
    draft.amount_minor = null;
    draft.currency = null;
    draft.value_kind = 'unknown';
    draft.amount_display = `${bits} Bits`;
    draft.is_paid = true;
    return draft;
  }

  const draft = baseDraft(tags, {
    eventType: EVENT_TYPES.CHAT,
    receivedAt,
    sourceQuality: TWITCH_EVENT_SOURCE_QUALITY.chat
  });
  draft.content = content;
  draft.emotes = emotes;
  return draft;
}

/**
 * Map a subscription/resub/gifted-sub USERNOTICE.
 *
 * `submysterygift` is skipped because Twitch also emits one `subgift` per
 * recipient; counting the announcement as well would double count. Other
 * system notices are skipped rather than being reported as viewer chat.
 *
 * @param {object} parsed result of `parseIrcLine`
 * @param {{receivedAt?:number}} options
 */
export function mapTwitchUsernotice(parsed, {receivedAt = Date.now()} = {}) {
  if (!parsed || parsed.command !== 'USERNOTICE') return null;
  const tags = parsed.tags ?? {};
  const msgId = String(tags['msg-id'] ?? '').trim().toLowerCase();
  if (!msgId || IGNORED_TWITCH_USERNOTICE.includes(msgId)) return null;
  const content = cleanText(stripActionWrapper(parsed.trailing ?? ''), 4000);
  const emotes = normalizeEmotes(parseEmotesTag(tags.emotes));

  if (msgId === 'sub' || msgId === 'resub') {
    const plan = subscriptionPlanLabel(tags['msg-param-sub-plan'] ?? tags['msg-param-sub-plan-name']);
    const months = positiveInteger(tags['msg-param-cumulative-months'])
      ?? positiveInteger(tags['msg-param-months']);
    const draft = baseDraft(tags, {
      eventType: EVENT_TYPES.MEMBERSHIP,
      receivedAt,
      sourceQuality: msgId === 'resub'
        ? TWITCH_EVENT_SOURCE_QUALITY.resub
        : TWITCH_EVENT_SOURCE_QUALITY.sub
    });
    draft.content = content || null;
    draft.emotes = content ? emotes : null;
    draft.gift_id = 'twitch-sub';
    draft.gift_name = `Subscription · ${plan}`;
    draft.gift_type = 'paid';
    draft.gift_quantity = 1;
    draft.amount_minor = null;
    draft.currency = null;
    draft.value_kind = 'unknown';
    draft.amount_display = months ? `${months} month${months === 1 ? '' : 's'}` : null;
    draft.is_paid = true;
    return draft;
  }

  if (msgId === 'subgift') {
    const gifterUid = cleanText(
      tags['user-id'] ?? tags['msg-param-gifter-id'] ?? tags['msg-param-sender-id'],
      200
    ) || null;
    const gifterName = cleanText(
      tags['display-name'] ?? tags.login ?? tags['msg-param-gifter-login'] ?? tags['msg-param-sender-login'],
      120
    ) || null;
    const recipientUid = cleanText(tags['msg-param-recipient-id'], 200) || null;
    const recipientName = cleanText(
      tags['msg-param-recipient-display-name'] ?? tags['msg-param-recipient-user-name'],
      120
    ) || null;
    const plan = subscriptionPlanLabel(tags['msg-param-sub-plan'] ?? tags['msg-param-sub-plan-name']);
    const months = positiveInteger(tags['msg-param-months']);
    const recipient = recipientName || recipientUid || null;
    const identity = {uid: gifterUid, name: gifterName, complete: Boolean(gifterUid) && Boolean(gifterName)};
    return {
      platform: 'twitch',
      event_type: EVENT_TYPES.GIFT,
      external_id: cleanText(tags.id, 200) || null,
      viewer_uid: identity.uid,
      display_name: identity.name,
      occurred_at: timestampOf(tags, receivedAt),
      content: null,
      emotes: null,
      badges: badgeInfoOf(tags),
      gift_id: 'twitch-gifted-sub',
      gift_name: `Gifted subscription · ${plan}`,
      gift_type: 'paid',
      gift_quantity: 1,
      amount_minor: null,
      currency: null,
      value_kind: 'unknown',
      // Recipient is a display detail, not a second payer. The gifter above is
      // the only viewer counted as having paid.
      amount_display: recipient
        ? `to ${recipient}${months ? ` · ${months} month${months === 1 ? '' : 's'}` : ''}`
        : (months ? `${months} month${months === 1 ? '' : 's'}` : null),
      is_paid: true,
      source_quality: TWITCH_EVENT_SOURCE_QUALITY.subgift,
      identity_complete: identity.complete
    };
  }

  // Unknown future USERNOTICE variants are ignored instead of guessed into
  // chat or payment events.
  return null;
}

/** `ROOMSTATE #xqc` carries the broadcaster's stable Twitch user id. */
export function mapTwitchRoomState(parsed) {
  if (!parsed || parsed.command !== 'ROOMSTATE') return null;
  const roomId = cleanText(parsed.tags?.['room-id'], 120) || null;
  const channel = String(parsed.params?.[0] ?? '').replace(/^#/, '').toLowerCase() || null;
  if (!roomId && !channel) return null;
  return {roomId, channel};
}

/** True when the line is a Twitch system/moderation notice, not chat. */
export function isTwitchSystemCommand(command) {
  return [
    'CLEARCHAT',
    'CLEARMSG',
    'USERSTATE',
    'GLOBALUSERSTATE',
    'CAP',
    '001',
    '002',
    '003',
    '004',
    '375',
    '372',
    '376',
    'JOIN',
    'PART',
    'NOTICE',
    'RECONNECT'
  ].includes(String(command ?? '').toUpperCase());
}

export const __internal = {identityOf, timestampOf, positiveInteger};
