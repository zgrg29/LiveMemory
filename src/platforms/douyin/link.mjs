import {AppError} from '../../shared/errors.mjs';

/**
 * Douyin live input parsing.
 *
 * LiveMemory only attaches to a public, currently live room. Accepted inputs:
 *   - https://live.douyin.com/<web_rid>
 *   - a bare numeric web_rid
 *   - https://www.douyin.com/root/live/<web_rid> (current share form)
 *
 * Anything that is a user profile, a video, a search page, a short link that
 * needs an extra redirect, or a non-live room id is rejected. This product does
 * not record ordinary videos or their comments.
 */

export const WEB_RID_PATTERN = /^\d{6,20}$/;

const LIVE_HOSTS = new Set(['live.douyin.com', 'www.douyin.com', 'douyin.com']);

const RESERVED_SEGMENTS = new Set([
  'user',
  'video',
  'search',
  'discover',
  'follow',
  'recommend',
  'hot',
  'channel',
  'music',
  'hashtag',
  'note',
  'collection'
]);

export class DouyinLinkError extends AppError {
  constructor(messageKey = 'errors.douyinLinkInvalid') {
    super('DOUYIN_LINK_INVALID', {messageKey, httpStatus: 400});
    this.name = 'DouyinLinkError';
  }
}

export function normalizeWebRid(value) {
  const text = String(value ?? '').trim();
  return WEB_RID_PATTERN.test(text) ? text : null;
}

/**
 * @param {string} input room URL, share link body or bare web_rid
 * @returns {{webRid:string, form:string, normalizedUrl:string, input:string}}
 */
export function parseDouyinInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new DouyinLinkError();

  const bare = normalizeWebRid(text);
  if (bare) {
    return {
      webRid: bare,
      form: 'web_rid',
      normalizedUrl: `https://live.douyin.com/${bare}`,
      input: text
    };
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new DouyinLinkError();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DouyinLinkError();
  const host = url.hostname.toLowerCase();
  if (!LIVE_HOSTS.has(host)) throw new DouyinLinkError();

  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (segments.length === 0) throw new DouyinLinkError();
  const first = String(segments[0]).toLowerCase();
  if (RESERVED_SEGMENTS.has(first)) throw new DouyinLinkError();

  // www.douyin.com/root/live/<rid> is the current share form. A numeric
  // first segment on www.douyin.com is not a live room, so it is rejected
  // instead of being guessed into one.
  let candidate = null;
  let form = 'room';
  if (host === 'live.douyin.com') {
    candidate = segments[0];
  } else if (first === 'root' && String(segments[1] ?? '').toLowerCase() === 'live') {
    candidate = segments[2];
    form = 'share';
  } else {
    throw new DouyinLinkError();
  }

  const webRid = normalizeWebRid(candidate);
  if (!webRid) throw new DouyinLinkError();
  return {webRid, form, normalizedUrl: `https://live.douyin.com/${webRid}`, input: text};
}

export function extractDouyinWebRid(input) {
  try {
    return parseDouyinInput(input).webRid;
  } catch {
    return null;
  }
}

export const __internal = {LIVE_HOSTS, RESERVED_SEGMENTS};
