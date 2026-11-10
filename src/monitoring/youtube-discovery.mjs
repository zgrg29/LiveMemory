import {AppError} from '../shared/errors.mjs';
import {parsePlayerResponse, parseWatchPage} from '../platforms/youtube/anonymous/parser.mjs';
import {VIDEO_ID_PATTERN} from '../platforms/youtube/link.mjs';

/**
 * YouTube channel discovery without the Data API, OAuth or an API key.
 *
 * Two public resources are used:
 *   1. A channel page (`/@handle`, `/channel/UC...`) to resolve a stable channel
 *      identity (`externalId` in `ytInitialData`).
 *   2. `<channel>/live` to see whether the channel currently has a broadcast.
 *      YouTube serves the watch page there while live; otherwise it serves the
 *      channel page. The embedded `ytInitialPlayerResponse` is the same public
 *      metadata the watch page uses, so a scheduled or ended video can be told
 *      apart from a live one.
 *
 * This file is pure HTML/XML parsing, so every branch can be tested from fixed
 * fixtures. Network calls live in `detectors/youtube.mjs`.
 */

export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
export const HANDLE_PATTERN = /^@[A-Za-z0-9._-]{2,100}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
]);

const VIDEO_PATH_FORMS = new Set(['live', 'shorts', 'embed', 'v']);

function invalidInput() {
  return new AppError('MONITOR_INVALID_INPUT', {
    messageKey: 'monitoring.error.invalidInput',
    httpStatus: 400
  });
}

function cleanHandle(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const withAt = text.startsWith('@') ? text : `@${text}`;
  return HANDLE_PATTERN.test(withAt) ? withAt : null;
}

/**
 * Normalize anything a user might paste for a YouTube channel.
 *
 * Accepted: channel URL, `/@handle`, bare `@handle`, bare channel id, and a
 * normal/live video link (the channel is resolved from its public watch page).
 * Playlists, clips and other hosts are rejected.
 *
 * @returns {{kind:'channel'|'handle'|'legacy'|'video', channelId?:string, handle?:string,
 *   legacy?:string, videoId?:string, normalizedUrl:string}}
 */
export function parseYouTubeChannelInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw invalidInput();

  if (CHANNEL_ID_PATTERN.test(text)) {
    return {kind: 'channel', channelId: text, normalizedUrl: `https://www.youtube.com/channel/${text}`};
  }
  if (HANDLE_PATTERN.test(text)) {
    return {kind: 'handle', handle: text, normalizedUrl: `https://www.youtube.com/${text}`};
  }
  if (VIDEO_ID_PATTERN.test(text)) {
    return {kind: 'video', videoId: text, normalizedUrl: `https://www.youtube.com/watch?v=${text}`};
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalidInput();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidInput();
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw invalidInput();

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0] ?? '';

  if (url.hostname.toLowerCase() === 'youtu.be' || url.hostname.toLowerCase() === 'www.youtu.be') {
    const videoId = segments[0];
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) throw invalidInput();
    return {kind: 'video', videoId, normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`};
  }

  if (first.startsWith('@')) {
    const handle = cleanHandle(first);
    if (!handle) throw invalidInput();
    return {kind: 'handle', handle, normalizedUrl: `https://www.youtube.com/${handle}`};
  }
  if (first === 'channel' && segments[1]) {
    const channelId = decodeURIComponent(segments[1]);
    if (!CHANNEL_ID_PATTERN.test(channelId)) throw invalidInput();
    return {kind: 'channel', channelId, normalizedUrl: `https://www.youtube.com/channel/${channelId}`};
  }
  if ((first === 'c' || first === 'user') && segments[1]) {
    const legacy = decodeURIComponent(segments[1]).replace(/^\/+/, '');
    if (!/^[A-Za-z0-9._-]{2,100}$/.test(legacy)) throw invalidInput();
    return {
      kind: 'legacy',
      legacy,
      normalizedUrl: `https://www.youtube.com/${first}/${encodeURIComponent(legacy)}`
    };
  }
  if (first === 'watch') {
    const videoId = url.searchParams.get('v');
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) throw invalidInput();
    return {kind: 'video', videoId, normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`};
  }
  if (VIDEO_PATH_FORMS.has(first) && segments[1] && VIDEO_ID_PATTERN.test(segments[1])) {
    return {
      kind: 'video',
      videoId: segments[1],
      normalizedUrl: `https://www.youtube.com/watch?v=${segments[1]}`
    };
  }
  throw invalidInput();
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanTextValue(value, max = 300) {
  const text = decodeEntities(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

function matchGroup(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

function channelMetadataChunk(html) {
  // Match the actual object, not the renderer-name list near the top of the
  // page (`"channelMetadataRenderer","twoColumn..."` has no colon).
  const objectAt = html.indexOf('"channelMetadataRenderer":{');
  if (objectAt >= 0) return html.slice(objectAt, objectAt + 6000);
  // Fallback: a window around the first stable external id. This is still
  // narrow enough to exclude recommended channels elsewhere on the page.
  const externalAt = html.search(/"externalId":"UC[A-Za-z0-9_-]{22}"/);
  if (externalAt >= 0) return html.slice(Math.max(0, externalAt - 1500), externalAt + 2500);
  return '';
}

function metaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, 'i'),
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${property}"`, 'i')
  ];
  for (const pattern of patterns) {
    const value = matchGroup(html, pattern);
    if (value) return cleanTextValue(value);
  }
  return null;
}

function decodeJsonText(raw) {
  if (!raw) return null;
  try {
    return cleanTextValue(JSON.parse(`"${raw}"`));
  } catch {
    return cleanTextValue(raw);
  }
}

/**
 * Resolve a channel identity from a public channel page and return the public
 * channel metadata.
 *
 * `externalId` is the authoritative stable id. A plain `"channelId"` is avoided:
 * channel pages contain recommended channels whose ids appear earlier.
 *
 * @returns {{channelId:string, title:string|null, handle:string|null, canonicalUrl:string|null}|null}
 */
export function parseChannelIdentity(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const chunk = channelMetadataChunk(html);
  const scopes = chunk ? [chunk, html] : [html];
  let channelId = null;
  for (const scope of scopes) {
    channelId = matchGroup(scope, /"externalId":"(UC[A-Za-z0-9_-]{22})"/)
      ?? matchGroup(scope, /<meta[^>]+itemprop="identifier"[^>]+content="(UC[A-Za-z0-9_-]{22})"/i)
      ?? matchGroup(scope, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/i);
    if (channelId) break;
  }
  if (!channelId) return null;

  const metadataTitle = chunk
    ? matchGroup(chunk, /"channelMetadataRenderer":\{"title":"((?:[^"\\]|\\.)*)"/)
    : null;
  const handle = chunk ? matchGroup(chunk, /"canonicalBaseUrl":"\/(@[A-Za-z0-9._-]{2,100})"/) : null;
  const canonicalUrl = chunk ? matchGroup(chunk, /"canonicalBaseUrl":"(\/[^"]*)"/) : null;
  // `og:title` is the page's own channel title. The metadata title is used as a
  // fallback because old cached pages can put a tab title ("Home") first.
  const title = metaContent(html, 'og:title')
    ?? decodeJsonText(metadataTitle)
    ?? cleanTextValue(matchGroup(html, /<title>([^<]*?)(?:\s+-\s+YouTube)?<\/title>/i));

  return {
    channelId,
    title,
    handle: handle ? `@${handle.replace(/^@/, '')}` : null,
    canonicalUrl: canonicalUrl ? `https://www.youtube.com${canonicalUrl}` : null
  };
}

function restrictedPage(html) {
  return /consent\.youtube\.com|Before you continue to YouTube|Sign in to confirm|confirm your age|This video isn't available anymore/i.test(html);
}

/**
 * Classify `<channel>/live`.
 *
 * @returns {{kind:'live'|'upcoming'|'offline'|'restricted'|'invalid', videoId?:string|null,
 *   title?:string|null, channelTitle?:string|null, channelId?:string|null,
 *   startedAt?:string|null, concurrentViewers?:number|null, reason?:string}}
 */
export function parseChannelLivePage(html, {channelId} = {}) {
  const expected = String(channelId ?? '');
  if (!CHANNEL_ID_PATTERN.test(expected)) return {kind: 'invalid', reason: 'channel_id_missing'};
  if (typeof html !== 'string' || html.length === 0) return {kind: 'invalid', reason: 'empty'};

  const player = parsePlayerResponse(html);
  if (!player?.videoDetails) {
    // No player: this is the channel page YouTube serves when the channel is not
    // live. Only accept it as "offline" when the page really belongs to the
    // requested channel; an error/other page must not look like a quiet channel.
    const identity = parseChannelIdentity(html);
    if (identity?.channelId === expected) {
      return {kind: 'offline', page: 'channel', title: identity.title, reason: 'not_live'};
    }
    if (restrictedPage(html)) return {kind: 'restricted', reason: 'consent_or_login'};
    if (html.includes(`"externalId":"${expected}"`) || html.includes(`/channel/${expected}`)) {
      return {kind: 'offline', page: 'channel', title: null, reason: 'not_live'};
    }
    return {kind: 'invalid', reason: 'no_player'};
  }

  const watch = parseWatchPage(html);
  if (!watch.ok || !watch.video) {
    if (watch.reason === 'restricted') return {kind: 'restricted', reason: 'restricted'};
    return {kind: 'invalid', reason: watch.reason ?? 'watch_parse_failed'};
  }
  const video = watch.video;
  if (video.channelId && video.channelId !== expected) {
    // Never attribute another channel's broadcast to this target. Even an ended
    // recommendation must not become a false "live" for the followed channel.
    return {
      kind: 'invalid',
      reason: 'owner_mismatch',
      channelId: video.channelId,
      videoId: video.videoId
    };
  }
  if (video.isLive) {
    if (!video.videoId || !VIDEO_ID_PATTERN.test(video.videoId)) {
      return {kind: 'invalid', reason: 'video_id_missing'};
    }
    return {
      kind: 'live',
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      channelId: video.channelId,
      startedAt: video.actualStartTime ?? video.scheduledStartTime ?? null,
      concurrentViewers: video.concurrentViewers ?? null,
      playabilityStatus: video.playabilityStatus ?? null
    };
  }
  if (video.isUpcoming) {
    return {
      kind: 'upcoming',
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      channelId: video.channelId,
      startedAt: video.scheduledStartTime ?? null,
      reason: 'upcoming'
    };
  }
  return {
    kind: 'offline',
    page: 'watch',
    videoId: video.videoId,
    title: video.title,
    channelTitle: video.channelTitle,
    reason: video.state === 'ended' ? 'ended' : 'not_live'
  };
}

/**
 * Parse the public channel RSS feed. The feed lists recent uploads/live
 * announcements; a live stream usually appears there when it starts. It is used
 * only as a fallback for the `<channel>/live` page and every candidate must
 * still be confirmed by its public watch page.
 *
 * @returns {{channelId:string|null, entries:Array<object>}}
 */
export function parseChannelRss(xml, {now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000} = {}) {
  if (typeof xml !== 'string' || !xml.includes('<feed')) return {channelId: null, entries: [], recent: []};
  const feedChannelId = matchGroup(xml, /<yt:channelId>(UC[A-Za-z0-9_-]{22})<\/yt:channelId>/)
    ?? matchGroup(xml, /<author>[\s\S]*?\/channel\/(UC[A-Za-z0-9_-]{22})[\s\S]*?<\/author>/);
  const entries = [];
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const videoId = matchGroup(block, /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/);
    if (!videoId) continue;
    const entryChannelId = matchGroup(block, /<yt:channelId>(UC[A-Za-z0-9_-]{22})<\/yt:channelId>/);
    if (entryChannelId && feedChannelId && entryChannelId !== feedChannelId) continue;
    const published = matchGroup(block, /<published>([^<]+)<\/published>/);
    const updated = matchGroup(block, /<updated>([^<]+)<\/updated>/);
    const publishedAt = Date.parse(published ?? '');
    const updatedAt = Date.parse(updated ?? '');
    entries.push({
      videoId,
      channelId: entryChannelId ?? feedChannelId ?? null,
      title: cleanTextValue(matchGroup(block, /<title>([\s\S]*?)<\/title>/)),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null
    });
  }
  entries.sort((a, b) => (b.updatedAt ?? b.publishedAt ?? 0) - (a.updatedAt ?? a.publishedAt ?? 0));
  const cutoff = now - maxAgeMs;
  const recent = entries.filter((entry) => {
    const at = entry.updatedAt ?? entry.publishedAt;
    return at !== null && at >= cutoff;
  });
  return {channelId: feedChannelId ?? null, entries, recent};
}

export function channelPagePath(input) {
  const parsed = typeof input === 'string' ? parseYouTubeChannelInput(input) : input;
  if (parsed.kind === 'channel') return `/channel/${parsed.channelId}`;
  if (parsed.kind === 'handle') return `/${parsed.handle}`;
  if (parsed.kind === 'legacy') return `/c/${encodeURIComponent(parsed.legacy)}`;
  throw invalidInput();
}

export const __internal = {
  decodeEntities,
  cleanTextValue,
  channelMetadataChunk,
  restrictedPage,
  ALLOWED_HOSTS
};
