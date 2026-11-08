import {AppError, ERROR_CODES} from '../../shared/errors.mjs';

/**
 * YouTube live link parsing.
 *
 * LiveMemory never analyses uploaded videos or comments: a YouTube URL is only a
 * way to *locate* a broadcast. This module therefore accepts the documented
 * watch/live/youtu.be/embed/shorts forms and a bare 11-character video id, and
 * rejects everything else (playlists, channels, clips, other hosts).
 *
 * No network access happens here, so the parser is trivially testable.
 */

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be'
]);

/** Path prefixes that carry a video id in the last path segment. */
const PATH_FORMS = new Set(['live', 'embed', 'shorts', 'v']);

export class YouTubeLinkError extends AppError {
  constructor(code = 'YOUTUBE_LINK_INVALID', messageKey = 'errors.youtubeLinkInvalid') {
    super(code, {messageKey, httpStatus: 400});
    this.name = 'YouTubeLinkError';
  }
}

function invalid() {
  return new YouTubeLinkError();
}

function normalizeId(value) {
  const text = String(value ?? '').trim();
  return VIDEO_ID_PATTERN.test(text) ? text : null;
}

/**
 * @param {string} input a link or a bare video id
 * @returns {{videoId: string, form: 'watch'|'live'|'youtu.be'|'embed'|'shorts'|'id'|'v', normalizedUrl: string}}
 * @throws {YouTubeLinkError} when the input is not a locatable YouTube video
 */
export function parseYouTubeInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw invalid();

  // A bare video id is accepted so a streamer can paste what the platform shows.
  const bare = normalizeId(text);
  if (bare) {
    return {videoId: bare, form: 'id', normalizedUrl: `https://www.youtube.com/watch?v=${bare}`};
  }

  let url;
  try {
    // `new URL` needs a scheme; accept "youtube.com/live/x" style pastes too.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid();
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw invalid();

  const segments = url.pathname.split('/').filter(Boolean);
  let videoId = null;
  let form = null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    videoId = normalizeId(segments[0]);
    form = 'youtu.be';
  } else if (segments[0] === 'watch') {
    videoId = normalizeId(url.searchParams.get('v'));
    form = 'watch';
  } else if (segments.length >= 2 && PATH_FORMS.has(segments[0])) {
    videoId = normalizeId(segments[1]);
    form = segments[0] === 'v' ? 'v' : segments[0];
  }

  if (!videoId) throw invalid();
  return {videoId, form, normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`};
}

export function extractVideoId(input) {
  try {
    return parseYouTubeInput(input).videoId;
  } catch {
    return null;
  }
}

export const __internal = {ALLOWED_HOSTS, PATH_FORMS, ERROR_CODES};
