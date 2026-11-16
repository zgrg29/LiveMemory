import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';

/**
 * TikTok LIVE link parsing.
 *
 * Only live sources are accepted: `https://www.tiktok.com/@creator/live`,
 * `https://www.tiktok.com/@creator` (the creator page is where the live player
 * lives), and a bare `@creator` / `creator`. Video, photo, short-link and
 * search URLs are rejected instead of being guessed into a room.
 */

const UNIQUE_ID = /^[A-Za-z0-9._]{2,24}$/;
const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);

function invalid(reason) {
  return new TikTokError(TIKTOK_ERRORS.LINK_INVALID, {
    messageKey: 'errors.tiktokLinkInvalid',
    httpStatus: 400,
    details: {reason}
  });
}

/** Extract the creator handle from an accepted TikTok live URL. */
export function uniqueIdFromUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  if (!first.startsWith('@')) return null;
  const handle = first.slice(1);
  if (!UNIQUE_ID.test(handle)) return null;
  // Reject non-live sections explicitly: /@user/video/123, /@user/photo/123.
  const section = parts[1] ?? null;
  if (section && section !== 'live') return null;
  return handle;
}

/**
 * @param {string} input URL, `@handle` or bare handle
 * @returns {{uniqueId: string, url: string, liveUrl: string, input: string}}
 */
export function parseTikTokInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw invalid('empty');
  if (text.startsWith('@')) {
    const handle = text.slice(1);
    if (!UNIQUE_ID.test(handle)) throw invalid('unique_id');
    return {
      uniqueId: handle,
      url: `https://www.tiktok.com/@${handle}/live`,
      liveUrl: `https://www.tiktok.com/@${handle}/live`,
      input: text
    };
  }
  if (/^https?:\/\//i.test(text)) {
    const uniqueId = uniqueIdFromUrl(text);
    if (!uniqueId) throw invalid('url');
    return {
      uniqueId,
      url: `https://www.tiktok.com/@${uniqueId}/live`,
      liveUrl: `https://www.tiktok.com/@${uniqueId}/live`,
      input: text
    };
  }
  if (/^[A-Za-z0-9._]{2,24}$/.test(text)) {
    return {
      uniqueId: text,
      url: `https://www.tiktok.com/@${text}/live`,
      liveUrl: `https://www.tiktok.com/@${text}/live`,
      input: text
    };
  }
  throw invalid('format');
}

/** Public live-page URL for a handle. */
export function tiktokLiveUrl(uniqueId) {
  return `https://www.tiktok.com/@${String(uniqueId ?? '').replace(/^@/, '')}/live`;
}

export const __internal = {UNIQUE_ID, HOSTS};
