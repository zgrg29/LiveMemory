import {EVENT_TYPES, SOURCE_QUALITY, VALUE_KIND} from '../../shared/events.mjs';
import {cleanText} from '../../shared/text.mjs';
import {normalizeEmotes} from '../../shared/emoticons.mjs';
import {normalizeCommand} from './protocol.mjs';

/**
 * Bilibili native payload -> canonical event draft.
 *
 * Field paths were checked against the reference project (bili-gift-drop) and,
 * where possible, against a real live room (see docs/PLATFORM_INTEGRATIONS.md).
 * Rules that matter for the long-term viewer profile:
 *
 * - UID comes from the platform message only. A nickname alone never identifies
 *   a viewer; when the UID is missing the event is still recorded but the
 *   identity is marked incomplete instead of guessing.
 * - Money: gifts and guard prices are reported in gold coins (1 CNY = 1000 gold
 *   coins, i.e. 1 gold coin = 0.1 fen). Super Chat prices are reported in CNY.
 *   Guard prices could not be confirmed, so they are stored as unknown value.
 * - Free (silver) gifts never add money.
 */

export const BILIBILI_CURRENCY = 'CNY';
export const GOLD_COIN_PER_YUAN = 1000;
export const MINOR_PER_YUAN = 100;
export const GOLD_COIN_TO_MINOR = MINOR_PER_YUAN / GOLD_COIN_PER_YUAN; // 0.1

export const GUARD_LEVELS = Object.freeze({
  1: 'governor',
  2: 'admiral',
  3: 'captain'
});

/**
 * How much trust each event type carries. `verified` is reserved for fields that
 * were observed in a real live room; money that is derived through a confirmed
 * unit conversion is `actual`, money whose unit is unconfirmed stays unknown.
 */
export const SOURCE_QUALITY_BY_TYPE = Object.freeze({
  chat: SOURCE_QUALITY.VERIFIED,
  gift: SOURCE_QUALITY.VERIFIED,
  super_chat: SOURCE_QUALITY.VERIFIED,
  guard: SOURCE_QUALITY.ESTIMATED
});

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value, max = 4000) {
  return cleanText(value, max);
}

/** Platform timestamps are Unix seconds; a few fields are milliseconds. */
export function toOccurredAt(value, fallback) {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return fallback;
  if (parsed > 1e12) return Math.trunc(parsed);
  return Math.trunc(parsed * 1000);
}

/**
 * Convert gold coins to CNY minor units (fen).
 * @returns {{amountMinor:number|null, exact:boolean}}
 */
export function goldCoinsToMinor(coins) {
  const value = number(coins);
  if (value === null || value < 0) return {amountMinor: null, exact: false};
  const exact = Number.isInteger(value * GOLD_COIN_TO_MINOR);
  return {amountMinor: Math.round(value * GOLD_COIN_TO_MINOR), exact};
}

function identity(uid, name) {
  const normalizedUid = uid === null || uid === undefined ? '' : String(uid).trim();
  // UID 0 means "not provided" on Bilibili. Keeping it as an identity would
  // merge every anonymous viewer into one profile, which the product forbids.
  const usableUid = normalizedUid && normalizedUid !== '0' ? normalizedUid : '';
  return {
    viewer_uid: usableUid || null,
    display_name: text(name, 120),
    complete: Boolean(usableUid) && Boolean(text(name, 120))
  };
}

/** `DANMU_MSG` user array: `[uid, uname, …]`, message at `info[1]`. */
export function readDanmu(info) {
  const userArray = Array.isArray(info?.[2]) ? info[2] : (Array.isArray(info?.[1]) ? info[1] : null);
  const content = typeof info?.[1] === 'string' ? info[1] : (Array.isArray(info?.[0]) ? info[0][0] : null);
  return {
    uid: userArray?.[0] ?? null,
    name: userArray?.[1] ?? null,
    content,
    guardLevel: number(info?.[7]),
    timestamp: info?.[9]?.ts ?? null
  };
}

/**
 * Platform emote metadata from `DANMU_MSG.info[0][13]`.
 *
 * Real-room observation (2026-11-08, room 5050): when a viewer sends a room
 * emote, `info[1]` already contains the emote's text label (for example "就这"
 * or "乐") and `info[0][13]` carries `emoticon_unique`, `url`, `width`,
 * `height`, `is_dynamic`. We keep the label and the unique id; we do not
 * download the image and we never guess the emote's emotion.
 *
 * `dm_v2` was empty in every sampled message. If a future platform version
 * moves emote data there, this function will not invent an id; the raw text is
 * still preserved.
 */
export function readBilibiliEmotes(info, content) {
  const meta = info?.[0]?.[13];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const id = text(meta.emoticon_unique, 200) ?? text(meta.emoticon_id, 200);
  // Real room emotes send their label as the whole body ("就这"). When the
  // body mixes text and a bracketed emote label, prefer the bracket token as
  // the name; we only use text that the platform actually sent.
  const bracket = typeof content === 'string' ? content.match(/\[[^\]\n]{1,32}\]/)?.[0] ?? null : null;
  const name = bracket
    ? bracket.slice(1, -1)
    : text(content, 120);
  return normalizeEmotes([{id, name, source: 'bilibili.info13'}]);
}

function mapChat(data, {receivedAt}) {
  const parsed = readDanmu(data?.info);
  const emotes = readBilibiliEmotes(data?.info, parsed.content);
  if (!parsed.content && !emotes) return null;
  const person = identity(parsed.uid, parsed.name);
  return {
    platform: 'bilibili',
    event_type: EVENT_TYPES.CHAT,
    viewer_uid: person.viewer_uid,
    display_name: person.display_name,
    content: text(parsed.content, 4000),
    emotes,
    occurred_at: toOccurredAt(parsed.timestamp, receivedAt),
    is_paid: false,
    gift_type: null,
    source_quality: person.complete ? SOURCE_QUALITY_BY_TYPE.chat : SOURCE_QUALITY.UNKNOWN,
    identity_complete: person.complete,
    guard_level: parsed.guardLevel
  };
}

function mapGift(data, {receivedAt}) {
  if (!data || typeof data !== 'object') return null;
  const quantity = number(data.num);
  const unitCoins = number(data.price);
  const totalCoins = number(data.total_coin) ?? (unitCoins !== null && quantity !== null ? unitCoins * quantity : null);
  if (quantity === null || quantity < 1) return null;
  const paid = data.coin_type === 'gold';
  const person = identity(data.uid, data.uname);
  const converted = paid && totalCoins !== null ? goldCoinsToMinor(totalCoins) : {amountMinor: null, exact: false};
  const unitConverted = paid && unitCoins !== null ? goldCoinsToMinor(unitCoins) : {amountMinor: null, exact: false};
  return {
    platform: 'bilibili',
    event_type: EVENT_TYPES.GIFT,
    viewer_uid: person.viewer_uid,
    display_name: person.display_name,
    occurred_at: toOccurredAt(data.timestamp, receivedAt),
    gift_id: data.giftId === undefined || data.giftId === null ? null : `gift_${data.giftId}`,
    gift_name: text(data.giftName, 120),
    gift_type: paid ? 'paid' : 'free',
    gift_quantity: Math.trunc(quantity),
    unit_amount_minor: unitConverted.amountMinor,
    amount_minor: paid ? converted.amountMinor : null,
    currency: BILIBILI_CURRENCY,
    value_kind: paid
      ? (converted.exact && unitConverted.exact ? VALUE_KIND.ACTUAL : VALUE_KIND.DISPLAY)
      : VALUE_KIND.UNKNOWN,
    is_paid: paid,
    external_id: data.tid ? `gift:${data.tid}` : null,
    source_quality: person.complete ? SOURCE_QUALITY_BY_TYPE.gift : SOURCE_QUALITY.UNKNOWN,
    identity_complete: person.complete,
    raw_coin_type: data.coin_type ?? null
  };
}

function mapSuperChat(data, {receivedAt}) {
  if (!data || data.id === undefined || data.id === null) return null;
  const person = identity(data.uid ?? data.user_info?.uid, data.user_info?.uname);
  const price = Number(data.price);
  const amountMinor = Number.isFinite(price) && price >= 0 ? Math.round(price * MINOR_PER_YUAN) : null;
  return {
    platform: 'bilibili',
    event_type: EVENT_TYPES.SUPER_CHAT,
    viewer_uid: person.viewer_uid,
    display_name: person.display_name,
    content: text(data.message),
    occurred_at: toOccurredAt(data.start_time, receivedAt),
    amount_minor: amountMinor,
    unit_amount_minor: amountMinor,
    currency: BILIBILI_CURRENCY,
    value_kind: amountMinor === null ? VALUE_KIND.UNKNOWN : VALUE_KIND.ACTUAL,
    is_paid: true,
    gift_type: 'paid',
    external_id: `sc:${data.id}`,
    source_quality: person.complete ? SOURCE_QUALITY_BY_TYPE.super_chat : SOURCE_QUALITY.UNKNOWN,
    identity_complete: person.complete
  };
}

function guardFields(data) {
  if (data?.guard_info || data?.pay_info || data?.sender_uinfo) {
    return {
      uid: data.sender_uinfo?.uid ?? null,
      name: data.sender_uinfo?.base?.name ?? null,
      level: number(data.guard_info?.guard_level),
      count: number(data.pay_info?.num),
      price: number(data.pay_info?.price),
      unit: data.pay_info?.unit ?? null,
      startTime: data.guard_info?.start_time ?? null,
      source: number(data.option?.source),
      id: data.payflow_id ?? data.msg_id ?? null
    };
  }
  return {
    uid: data?.uid ?? null,
    name: data?.username ?? null,
    level: number(data?.guard_level),
    count: number(data?.num),
    price: number(data?.price),
    unit: data?.unit ?? null,
    startTime: data?.start_time ?? data?.timestamp ?? null,
    source: number(data?.source),
    id: data?.payflow_id ?? data?.msg_id ?? null
  };
}

function mapGuard(data, {receivedAt}) {
  const fields = guardFields(data);
  if (!GUARD_LEVELS[fields.level]) return null;
  // Toast notifications can replay a purchase that GUARD_BUY already reported.
  if (Number.isFinite(fields.source) && fields.source !== 0) return null;
  const person = identity(fields.uid, fields.name);
  if (!person.viewer_uid) return null;
  const occurredAt = toOccurredAt(fields.startTime, receivedAt);
  const count = fields.count && fields.count > 0 ? Math.trunc(fields.count) : 1;
  return {
    platform: 'bilibili',
    event_type: EVENT_TYPES.GUARD,
    viewer_uid: person.viewer_uid,
    display_name: person.display_name,
    occurred_at: occurredAt,
    // Guard prices are reported in an amount unit the project has not confirmed,
    // so no money is booked. The event itself is still recorded.
    amount_minor: null,
    currency: BILIBILI_CURRENCY,
    value_kind: VALUE_KIND.UNKNOWN,
    is_paid: true,
    gift_type: 'paid',
    gift_id: `guard_${fields.level}`,
    gift_name: GUARD_LEVELS[fields.level],
    gift_quantity: count,
    external_id: fields.id ? `guard:${fields.id}` : `guard:${person.viewer_uid}:${fields.level}:${occurredAt}:${count}`,
    source_quality: SOURCE_QUALITY_BY_TYPE.guard,
    identity_complete: person.complete,
    guard_level: fields.level
  };
}

/**
 * @param {{cmd:string, data:any, receivedAt:number}} message
 * @returns {{draft:object, kind:string}|null}
 */
export function mapBilibiliMessage({cmd, data, receivedAt = Date.now()}) {
  const kind = normalizeCommand(cmd);
  switch (kind) {
    case 'DANMU_MSG': {
      const draft = mapChat(data, {receivedAt});
      return draft ? {draft, kind: 'chat'} : null;
    }
    case 'SEND_GIFT': {
      const draft = mapGift(data, {receivedAt});
      return draft ? {draft, kind: 'gift'} : null;
    }
    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JPN': {
      const draft = mapSuperChat(data, {receivedAt});
      return draft ? {draft, kind: 'super_chat'} : null;
    }
    case 'GUARD_BUY':
    case 'USER_TOAST_MSG':
    case 'USER_TOAST_MSG_V2': {
      const draft = mapGuard(data, {receivedAt});
      return draft ? {draft, kind: 'guard'} : null;
    }
    default:
      return null;
  }
}

/** Commands the console can show as "connection is alive" without storing them. */
export const IGNORED_COMMANDS = Object.freeze([
  'INTERACT_WORD',
  'INTERACT_WORD_V2',
  'WATCHED_CHANGE',
  'ONLINE_RANK_COUNT',
  'ONLINE_RANK_V2',
  'ONLINE_RANK_TOP3',
  'ENTRY_EFFECT',
  'COMBO_SEND',
  'LIKE_INFO_V3_CLICK',
  'LIKE_INFO_V3_UPDATE',
  'STOP_LIVE',
  'PREPARING',
  'ROOM_REAL_TIME_MESSAGE_UPDATE',
  'NOTICE_MSG',
  'SUPER_CHAT_MESSAGE_DELETE'
]);

export const __internal = {identity, guardFields, mapChat, mapGift, mapGuard, mapSuperChat, readBilibiliEmotes};
