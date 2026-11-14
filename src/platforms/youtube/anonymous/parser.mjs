import {cleanText} from '../../../shared/text.mjs';
import {parseAmountToMinor} from '../../../shared/money.mjs';

/**
 * Pure parsers for YouTube's public web live-chat client.
 *
 * This module contains no network code and no persistence. It turns the HTML
 * bootstrapping pages and the JSON continuation responses into a small native
 * shape. All canonical mapping still happens in `../mapper.mjs`, and all writes
 * still go through EventIngest.
 *
 * The web client is an undocumented, unauthenticated interface. It is isolated
 * here so a protocol change cannot leak into the database, UI or service layer.
 */

export const YOUTUBE_WEB_BASE = 'https://www.youtube.com';
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
export const DEFAULT_POLL_TIMEOUT_MS = 10000;

/** Extract a balanced `{...}` object starting at a known `{` index. */
export function extractObjectAt(text, start) {
  if (typeof text !== 'string' || start < 0 || text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonObjectAt(text, index) {
  const start = text.indexOf('{', index);
  if (start < 0) return null;
  const raw = extractObjectAt(text, start);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Find the first `ytInitialData` object, supporting both common assignments. */
export function parseInitialData(html) {
  for (const marker of ['window["ytInitialData"] = ', 'window[\'ytInitialData\'] = ', 'ytInitialData = ', 'var ytInitialData = ']) {
    const at = html.indexOf(marker);
    if (at >= 0) {
      const data = parseJsonObjectAt(html, at + marker.length);
      if (data) return data;
    }
  }
  return null;
}

export function parsePlayerResponse(html) {
  for (const marker of [
    'window["ytInitialPlayerResponse"] = ',
    'window[\'ytInitialPlayerResponse\'] = ',
    'ytInitialPlayerResponse = ',
    'var ytInitialPlayerResponse = '
  ]) {
    const at = html.indexOf(marker);
    if (at >= 0) {
      const data = parseJsonObjectAt(html, at + marker.length);
      if (data) return data;
    }
  }
  return null;
}

/**
 * The page contains several `ytcfg.set(...)` calls. Only the object with an
 * `INNERTUBE_CONTEXT` is useful for the chat POST. Never guess a client version.
 */
export function parseYouTubeConfig(html) {
  let position = 0;
  let fallback = null;
  while ((position = html.indexOf('ytcfg.set({', position)) >= 0) {
    const config = parseJsonObjectAt(html, position);
    if (config) {
      if (config.INNERTUBE_CONTEXT) return config;
      fallback ??= config;
    }
    position += 11;
  }
  return fallback;
}

function textOfRuns(runs) {
  if (!Array.isArray(runs)) return '';
  return runs.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('');
}

function parseCount(text) {
  const raw = cleanText(text, 40);
  if (!raw) return null;
  // Localized compact forms ("1.2K", "3万") cannot be converted reliably.
  if (/[KMB万億千]/i.test(raw)) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? String(value) : null;
}

/**
 * Convert the watch page into the small video descriptor used by the service.
 * No official API call is involved.
 */
export function parseWatchPage(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return {ok: false, reason: 'empty', video: null};
  }
  const player = parsePlayerResponse(html);
  const initial = parseInitialData(html) ?? {};
  if (!player?.videoDetails) {
    const limited = /consent\.youtube\.com|Before you continue to YouTube|confirm your age|Sign in to confirm/i.test(html);
    return {ok: false, reason: limited ? 'restricted' : 'no-player', video: null};
  }
  const details = player.videoDetails;
  const playability = player.playabilityStatus ?? {};
  if (!['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status)) {
    return {
      ok: false,
      reason: playability.status === 'LOGIN_REQUIRED' ? 'restricted' : 'unavailable',
      playabilityStatus: playability.status ?? null,
      video: null
    };
  }
  const micro = player.microformat?.playerMicroformatRenderer ?? {};
  const live = micro.liveBroadcastDetails ?? {};
  const isLive = details.isLive === true || live.isLiveNow === true;
  const isUpcoming = details.isUpcoming === true;
  const isLiveContent = details.isLiveContent === true || Boolean(live.startTimestamp) || Boolean(live.endTimestamp);
  let state = 'video';
  if (isLive) state = 'live';
  else if (isUpcoming) state = 'upcoming';
  else if (isLiveContent) state = 'ended';

  const primary = initial?.contents?.twoColumnWatchNextResults?.results?.results?.contents
    ?.find?.((entry) => entry?.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
  const viewText = primary?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText
    ?? primary?.viewCount?.videoViewCountRenderer?.shortViewCount?.simpleText
    ?? null;

  return {
    ok: true,
    reason: null,
    video: {
      videoId: cleanText(details.videoId, 40) || null,
      title: cleanText(details.title, 300) || null,
      channelId: cleanText(details.channelId, 80) || null,
      channelTitle: cleanText(details.author, 200) || null,
      state,
      isLive,
      liveBroadcastContent: state === 'live' ? 'live' : (state === 'upcoming' ? 'upcoming' : 'none'),
      scheduledStartTime: isoOrNull(live.startTimestamp),
      actualStartTime: isoOrNull(live.startTimestamp),
      actualEndTime: isoOrNull(live.endTimestamp),
      concurrentViewers: isLive ? parseCount(viewText) : null,
      activeLiveChatId: null,
      chatAvailable: null,
      privacyStatus: micro.isFamilySafe === true ? 'public' : null,
      isLiveContent,
      isUpcoming,
      playabilityStatus: playability.status ?? null
    }
  };
}

export function extractContinuation(continuations) {
  if (!Array.isArray(continuations)) return {continuation: null, timeoutMs: null};
  for (const entry of continuations) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['reloadContinuationData', 'invalidationContinuationData', 'timedContinuationData', 'liveChatReplayContinuationData']) {
      const data = entry[key];
      if (data && typeof data.continuation === 'string' && data.continuation) {
        const timeout = Number(data.timeoutMs);
        return {
          continuation: data.continuation,
          timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
          kind: key
        };
      }
    }
  }
  return {continuation: null, timeoutMs: null, kind: null};
}

/** Classify a chat page that has no `liveChatRenderer`. */
export function chatUnavailableReason(initial) {
  const text = textOfRuns(initial?.contents?.messageRenderer?.text?.runs).toLowerCase();
  if (!text) return 'unavailable';
  if (text.includes('disabled') || text.includes('turned off') || text.includes('off.')) return 'disabled';
  if (text.includes('ended') || text.includes('finished')) return 'ended';
  if (text.includes('sign in') || text.includes('login')) return 'restricted';
  if (text.includes('unavailable') || text.includes('not available')) return 'unavailable';
  return 'unavailable';
}

/**
 * Parse the initial `/live_chat` HTML page.
 * @returns {{ok:boolean, reason?:string, config?:object, actions?:object[], continuation?:string|null, timeoutMs?:number|null}}
 */
export function parseChatPage(html) {
  const initial = parseInitialData(html);
  const config = parseYouTubeConfig(html);
  const renderer = initial?.contents?.liveChatRenderer;
  if (!renderer) {
    return {
      ok: false,
      reason: chatUnavailableReason(initial),
      config,
      actions: [],
      continuation: null,
      timeoutMs: null
    };
  }
  const continuation = extractContinuation(renderer.continuations);
  return {
    ok: true,
    config,
    actions: Array.isArray(renderer.actions) ? renderer.actions : [],
    continuation: continuation.continuation,
    timeoutMs: continuation.timeoutMs,
    continuationKind: continuation.kind
  };
}

function invalidChatResponse(reason) {
  return {
    actions: [],
    continuation: null,
    timeoutMs: null,
    continuationKind: null,
    ended: false,
    invalid: true,
    invalidReason: reason
  };
}

/**
 * Parse one `get_live_chat` JSON response.
 *
 * A missing `continuationContents` is **not** proof that the broadcast ended:
 * an HTTP 200 with an empty body, an error envelope or a changed structure also
 * produces it. It is reported as `invalid` so the adapter can retry or confirm
 * the end through an independent watch-page read. `ended` is reserved for an
 * explicit platform end signal; this parser never infers one from absence.
 */
export function parseChatResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalidChatResponse('payload-not-object');
  }
  const contents = payload.continuationContents;
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) {
    return invalidChatResponse('missing-continuation-contents');
  }
  const live = contents.liveChatContinuation;
  if (!live || typeof live !== 'object' || Array.isArray(live)) {
    return invalidChatResponse('missing-live-chat-continuation');
  }
  const actions = Array.isArray(live.actions) ? live.actions : [];
  const continuation = extractContinuation(live.continuations);
  if (!continuation.continuation) {
    // Keeping the previous continuation would poll a page that can no longer
    // advance. Treat it as a transient/invalid structure, not as an end.
    return {...invalidChatResponse('missing-continuation-token'), actions};
  }
  return {
    actions,
    continuation: continuation.continuation,
    timeoutMs: continuation.timeoutMs,
    continuationKind: continuation.kind,
    ended: false,
    invalid: false
  };
}

/**
 * Convert message runs into original text plus minimal custom-emote metadata.
 * Unicode emoji stay literal in the text. Custom emoji never contribute an image
 * URL to `content`.
 */
export function runsToContent(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return {content: null, emotes: null};
  let content = '';
  const emotes = [];
  for (const run of runs) {
    if (typeof run?.text === 'string') {
      content += run.text;
      continue;
    }
    const emoji = run?.emoji;
    if (!emoji || typeof emoji !== 'object') continue;
    const shortcuts = Array.isArray(emoji.shortcuts) ? emoji.shortcuts.filter((value) => typeof value === 'string') : [];
    const code = cleanText(shortcuts[0], 200);
    const emojiId = cleanText(emoji.emojiId, 200);
    const label = cleanText(emoji.image?.accessibility?.accessibilityData?.label, 120)
      ?? cleanText(shortcuts[0]?.replace(/^:+|:+$/g, ''), 120);
    if (emoji.isCustomEmoji === true) {
      const fallback = code ?? (label ? `:${label}:` : (emojiId ? `[emote:${emojiId}]` : ''));
      content += fallback;
      if (emojiId || code || label) {
        emotes.push({
          ...(emojiId ? {id: emojiId} : {}),
          ...(code ? {code} : {}),
          ...(label ? {name: label} : {}),
          source: 'youtube.liveChat.runs'
        });
      }
      continue;
    }
    // Standard Unicode emoji: the emojiId is the literal character sequence.
    content += emojiId || label || code || '';
  }
  const text = content.length > 0 ? content : null;
  return {content: text, emotes: emotes.length > 0 ? emotes : null};
}

const BADGE_TYPES = {
  OWNER: 'owner',
  MODERATOR: 'moderator',
  VERIFIED: 'verified',
  MEMBER: 'member'
};

export function parseAuthorBadges(authorBadges) {
  if (!Array.isArray(authorBadges)) return null;
  const output = [];
  const seen = new Set();
  for (const entry of authorBadges) {
    const badge = entry?.liveChatAuthorBadgeRenderer;
    if (!badge || typeof badge !== 'object') continue;
    const iconType = String(badge.icon?.iconType ?? '').toUpperCase();
    const label = cleanText(
      badge.accessibility?.accessibilityData?.label ?? badge.tooltip,
      80
    );
    let type = BADGE_TYPES[iconType] ?? null;
    if (!type && badge.customThumbnail) type = 'member';
    if (!type) type = label ? 'unknown' : null;
    if (!type) continue;
    const key = `${type}\u0001${label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({type, ...(label ? {label} : {})});
  }
  return output.length > 0 ? output : null;
}

const COUNTRY_CURRENCY = Object.freeze({
  US: 'USD', AU: 'AUD', CA: 'CAD', NZ: 'NZD', SG: 'SGD', HK: 'HKD',
  TW: 'TWD', MX: 'MXN', BR: 'BRL', GB: 'GBP', IE: 'EUR', DE: 'EUR',
  FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', AT: 'EUR', BE: 'EUR',
  PT: 'EUR', FI: 'EUR', GR: 'EUR', JP: 'JPY', CN: 'CNY', KR: 'KRW',
  IN: 'INR', ID: 'IDR', PH: 'PHP', TH: 'THB', VN: 'VND', TR: 'TRY',
  IL: 'ILS', RU: 'RUB', PL: 'PLN', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  CH: 'CHF', CZ: 'CZK', HU: 'HUF', RO: 'RON', ZA: 'ZAR', AE: 'AED',
  SA: 'SAR', MY: 'MYR', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN'
});

const SYMBOLS = Object.freeze([
  ['HK$', 'HKD'], ['AU$', 'AUD'], ['A$', 'AUD'], ['CA$', 'CAD'], ['C$', 'CAD'],
  ['NZ$', 'NZD'], ['SG$', 'SGD'], ['S$', 'SGD'], ['NT$', 'TWD'], ['MX$', 'MXN'],
  ['R$', 'BRL'], ['US$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['₹', 'INR'],
  ['₩', 'KRW'], ['￦', 'KRW'], ['₽', 'RUB'], ['₺', 'TRY'], ['₪', 'ILS'],
  ['₱', 'PHP'], ['฿', 'THB'], ['₫', 'VND'], ['¥', null], ['￥', null], ['$', null]
]);

function normalizeNumberText(text) {
  const match = String(text).match(/\d[\d\s.,\u00a0']*/);
  if (!match) return null;
  let value = match[0].replace(/[\s\u00a0']/g, '').replace(/[.,]+$/, '');
  if (!value) return null;
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');
  let decimalIndex = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalIndex = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0) {
    if (value.split('.').length === 2 && value.length - lastDot - 1 <= 2) decimalIndex = lastDot;
  } else if (lastComma >= 0) {
    if (value.split(',').length === 2 && value.length - lastComma - 1 <= 2) decimalIndex = lastComma;
  }
  if (decimalIndex >= 0) {
    const whole = value.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fraction = value.slice(decimalIndex + 1).replace(/[.,]/g, '');
    value = `${whole || '0'}.${fraction || '0'}`;
  } else {
    value = value.replace(/[.,]/g, '');
  }
  return value;
}

/**
 * Parse a platform-displayed amount such as "HK$2,000.00".
 *
 * A formatted string is not a reliable currency contract. We only accept an
 * explicitly displayed ISO code or a symbol that is unambiguous, or a bare `$`/`¥`
 * resolved by the page's country context. If neither is available, the amount is
 * left unknown rather than guessed.
 */
export function parseDisplayedAmount(displayText, {gl = null} = {}) {
  const display = cleanText(displayText, 80);
  if (!display) return {amountMinor: null, currency: null, display: null, currencySource: 'none'};
  const uppercase = display.toUpperCase();
  const codeMatch = uppercase.match(/\b([A-Z]{3})\b/);
  let currency = codeMatch ? codeMatch[1] : null;
  let currencySource = codeMatch ? 'explicit' : 'none';

  if (!currency) {
    const trimmed = display.trim();
    for (const [symbol, code] of SYMBOLS) {
      if (trimmed.startsWith(symbol)) {
        currency = code;
        currencySource = code ? 'explicit' : 'country';
        break;
      }
    }
    if (!currency) {
      for (const [symbol, code] of SYMBOLS) {
        if (trimmed.endsWith(symbol)) {
          currency = code;
          currencySource = code ? 'explicit' : 'country';
          break;
        }
      }
    }
  }

  if (!currency && (display.includes('$') || display.includes('¥') || display.includes('￥'))) {
    const country = String(gl ?? '').toUpperCase();
    if (display.includes('$')) currency = COUNTRY_CURRENCY[country] ?? null;
    else if (country === 'JP') currency = 'JPY';
    else if (country === 'CN') currency = 'CNY';
    if (currency) currencySource = 'country';
  }

  const number = normalizeNumberText(display);
  if (!currency || !number) {
    return {amountMinor: null, currency, display, currencySource};
  }
  const amountMinor = parseAmountToMinor(number, currency);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return {amountMinor: null, currency, display, currencySource};
  }
  return {amountMinor, currency, display, currencySource};
}

/** Return the first `addChatItemAction.item` renderer, or null. */
export function chatItemOfAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.addChatItemAction?.item) return action.addChatItemAction.item;
  return null;
}

export function timestampUsecToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const micros = BigInt(String(value).trim());
    if (micros <= 0n) return null;
    const ms = micros / 1000n;
    const number = Number(ms);
    return Number.isSafeInteger(number) ? number : null;
  } catch {
    return null;
  }
}

export const __internal = {
  textOfRuns,
  parseCount,
  normalizeNumberText,
  SYMBOLS,
  COUNTRY_CURRENCY
};
