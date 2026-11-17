import {KICK_ERRORS, KickError} from './errors.mjs';

/**
 * Kick URL parsing.
 *
 * Only live channels are accepted: `https://kick.com/<slug>`,
 * `https://kick.com/<slug>/chat` and a bare `<slug>`. VOD (`/video/...`),
 * category, clip, search and settings URLs are rejected instead of being
 * guessed into a room, because LiveMemory only records live broadcasts.
 */

/** Kick slugs are lower-case ASCII letters, digits, `_` and `-` in practice. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOSTS = new Set(['kick.com', 'www.kick.com', 'm.kick.com']);

/**
 * First path segments that are site sections, never channel slugs. Rejecting
 * them explicitly keeps `/video/abc` or `/category/chess` from being recorded
 * as a channel named "video" or "category".
 */
const RESERVED = new Set([
  'about',
  'browse',
  'categories',
  'category',
  'clips',
  'community-guidelines',
  'dashboard',
  'following',
  'help',
  'login',
  'messages',
  'privacy',
  'search',
  'settings',
  'signup',
  'stream',
  'subscriptions',
  'terms',
  'video',
  'videos',
  'wallet'
]);

function invalid(reason) {
  return new KickError(KICK_ERRORS.LINK_INVALID, {
    httpStatus: 400,
    details: {reason}
  });
}

/** Extract the channel slug from an accepted Kick live URL. */
export function slugFromUrl(raw) {
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
  const first = decodeURIComponent(parts[0]);
  if (!SLUG.test(first)) return null;
  if (RESERVED.has(first.toLowerCase())) return null;
  // `/slug/chat` is the chat route; any other known sub-page is not a channel.
  const section = parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : null;
  if (section === 'video' || section === 'videos' || section === 'clips' || section === 'about') {
    return null;
  }
  return first;
}

/**
 * @param {string} input URL, `kick.com/<slug>` or a bare slug
 * @returns {{slug: string, url: string, liveUrl: string, input: string}}
 */
export function parseKickInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw invalid('empty');
  if (/^https?:\/\//i.test(text)) {
    const slug = slugFromUrl(text);
    if (!slug) throw invalid('url');
    return {
      slug,
      url: `https://kick.com/${slug}`,
      liveUrl: `https://kick.com/${slug}`,
      input: text
    };
  }
  if (/^(kick\.com|www\.kick\.com|m\.kick\.com)\//i.test(text)) {
    const slug = slugFromUrl(`https://${text}`);
    if (!slug) throw invalid('url');
    return {slug, url: `https://kick.com/${slug}`, liveUrl: `https://kick.com/${slug}`, input: text};
  }
  const slug = text.replace(/^\/+/, '');
  if (!SLUG.test(slug) || RESERVED.has(slug.toLowerCase())) throw invalid('format');
  return {
    slug,
    url: `https://kick.com/${slug}`,
    liveUrl: `https://kick.com/${slug}`,
    input: text
  };
}

/** Public channel page for a slug. */
export function kickChannelUrl(slug) {
  return `https://kick.com/${String(slug ?? '').replace(/^\/+/, '')}`;
}

export const __internal = {SLUG, HOSTS, RESERVED};
