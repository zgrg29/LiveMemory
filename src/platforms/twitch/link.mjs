import {AppError} from '../../shared/errors.mjs';

/**
 * Twitch live input parsing.
 *
 * LiveMemory only attaches to a public live channel. Accepted inputs are a
 * channel URL (`https://www.twitch.tv/<login>`, also m/player/popout forms) or
 * a bare channel login. Video, clip, directory and search URLs are rejected:
 * those are not a live channel and must never be recorded as if they were.
 */

export const TWITCH_LOGIN_PATTERN = /^[A-Za-z0-9_]{3,25}$/;

const ALLOWED_HOSTS = new Set([
  'twitch.tv',
  'www.twitch.tv',
  'm.twitch.tv',
  'go.twitch.tv',
  'player.twitch.tv'
]);

/** First path segments that are site sections, never a channel login. */
const RESERVED_SEGMENTS = new Set([
  'videos',
  'video',
  'directory',
  'search',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'turbo',
  'friends',
  'messages',
  'downloads',
  'jobs',
  'p',
  'store',
  'collections',
  'privacy',
  'legal',
  'about',
  'creatorcamp'
]);

export class TwitchLinkError extends AppError {
  constructor(messageKey = 'errors.twitchLinkInvalid') {
    super('TWITCH_LINK_INVALID', {messageKey, httpStatus: 400});
    this.name = 'TwitchLinkError';
  }
}

function invalid() {
  return new TwitchLinkError();
}

export function normalizeTwitchLogin(value) {
  const text = String(value ?? '').trim();
  return TWITCH_LOGIN_PATTERN.test(text) ? text.toLowerCase() : null;
}

/**
 * @param {string} input channel URL or login
 * @returns {{login:string, form:'login'|'channel'|'player'|'popout', normalizedUrl:string, input:string}}
 * @throws {TwitchLinkError} for non-channel / non-live-target inputs
 */
export function parseTwitchInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw invalid();

  const bare = normalizeTwitchLogin(text);
  if (bare) {
    return {login: bare, form: 'login', normalizedUrl: `https://www.twitch.tv/${bare}`, input: text};
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid();
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw invalid();

  if (host === 'player.twitch.tv') {
    const login = normalizeTwitchLogin(url.searchParams.get('channel'));
    if (!login) throw invalid();
    return {login, form: 'player', normalizedUrl: `https://www.twitch.tv/${login}`, input: text};
  }

  const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  let candidate = null;
  let form = 'channel';

  if (segments[0] === 'popout' && segments.length >= 2) {
    candidate = segments[1];
    form = 'popout';
  } else if (segments.length === 1) {
    candidate = segments[0];
  } else if (segments.length === 0) {
    // twitch.tv/?channel=<login> is used by some embeds.
    candidate = url.searchParams.get('channel');
  }

  if (!candidate || RESERVED_SEGMENTS.has(String(candidate).toLowerCase())) throw invalid();
  const login = normalizeTwitchLogin(candidate);
  if (!login) throw invalid();
  return {login, form, normalizedUrl: `https://www.twitch.tv/${login}`, input: text};
}

export function extractTwitchLogin(input) {
  try {
    return parseTwitchInput(input).login;
  } catch {
    return null;
  }
}

export const __internal = {ALLOWED_HOSTS, RESERVED_SEGMENTS};
