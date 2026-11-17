import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';
import {KUAISHOU_LIVE_ORIGIN, KUAISHOU_USER_AGENT, requestText} from './http.mjs';

/**
 * Public room status for Kuaishou.
 *
 * The H5 `home/list` endpoint is a rotating recommendation snapshot: G1.6
 * proved that a room can be live and absent from the next snapshot, so absence
 * is NEVER treated as offline. A room-specific page is used instead.
 *
 * The page can answer with a rate-limit shell ("请求过快"), a real profile /
 * room page, or an unknown document. Only a positive live-stream id or an
 * unambiguous offline room page is accepted; everything else stays `unknown`
 * so a live broadcaster is never reported as ended by mistake.
 */

export const ROOM_STATUS = Object.freeze({
  LIVE: 'live',
  OFFLINE: 'offline',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found',
  UNKNOWN: 'unknown'
});

/** The live page embeds the active broadcast as `playList[0].liveStream.id`. */
const LIVE_STREAM_RE = /"liveStream"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/;
const LIVE_STREAM_NULL_RE = /"liveStream"\s*:\s*null/;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Parse one room page. Exported so the offline/rate-limit distinction is
 * unit-tested without network access.
 */
export function parseRoomPage(html, eid) {
  const text = String(html ?? '');
  const live = LIVE_STREAM_RE.exec(text);
  const title = decodeHtml(TITLE_RE.exec(text)?.[1] ?? '');
  const rateLimited = text.includes('请求过快') || text.includes('"errorType":{"type":2');
  const genericTitle = title === '快手直播';
  const escaped = String(eid ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const eidMarker = escaped
    ? new RegExp(`"(?:userId|principalId|authorId)"\\s*:\\s*"${escaped}"`).test(text)
    : false;
  const liveStreamNull = LIVE_STREAM_NULL_RE.test(text);
  return {
    live: Boolean(live?.[1]),
    liveStreamId: live?.[1] ?? null,
    title,
    genericTitle,
    eidMarker,
    liveStreamNull,
    rateLimited,
    bytes: text.length
  };
}

/**
 * Read the room-specific public page and classify the broadcast state.
 *
 * @returns {Promise<{state:string, liveStreamId:string|null, title:string|null,
 *   reason:string|null, httpStatus:number, checkedAt:number, bytes:number}>}
 */
export async function detectKuaishouStatus(eid, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  now = Date.now,
  userAgent = KUAISHOU_USER_AGENT
} = {}) {
  const roomId = String(eid ?? '').trim();
  if (!roomId) {
    throw new KuaishouError(KUAISHOU_ERRORS.LINK_INVALID, {
      httpStatus: 400,
      details: {field: 'eid'},
      retryable: false
    });
  }
  const url = `${KUAISHOU_LIVE_ORIGIN}/u/${encodeURIComponent(roomId)}`;
  const response = await requestText(url, {
    fetchImpl,
    timeoutMs,
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml',
      referer: `${KUAISHOU_LIVE_ORIGIN}/`
    }
  });
  const checkedAt = now();
  if (response.status === 404) {
    return {state: ROOM_STATUS.NOT_FOUND, liveStreamId: null, title: null, reason: 'HTTP_404', httpStatus: 404, checkedAt, bytes: response.text.length};
  }
  if (response.status === 429) {
    return {state: ROOM_STATUS.RATE_LIMITED, liveStreamId: null, title: null, reason: 'HTTP_429', httpStatus: 429, checkedAt, bytes: response.text.length};
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      state: ROOM_STATUS.UNKNOWN,
      liveStreamId: null,
      title: null,
      reason: `HTTP_${response.status}`,
      httpStatus: response.status,
      checkedAt,
      bytes: response.text.length
    };
  }

  const parsed = parseRoomPage(response.text, roomId);
  if (parsed.rateLimited) {
    return {
      state: ROOM_STATUS.RATE_LIMITED,
      liveStreamId: null,
      title: parsed.title || null,
      reason: 'RATE_LIMIT_SHELL',
      httpStatus: response.status,
      checkedAt,
      bytes: parsed.bytes
    };
  }
  if (parsed.live && parsed.liveStreamId) {
    return {
      state: ROOM_STATUS.LIVE,
      liveStreamId: parsed.liveStreamId,
      title: parsed.title || null,
      reason: null,
      httpStatus: response.status,
      checkedAt,
      bytes: parsed.bytes
    };
  }
  // A real room page with the broadcaster's own id and no active stream is the
  // only offline shape accepted. The rate-limit shell and a generic document
  // must stay `unknown`.
  if (!parsed.genericTitle && (parsed.eidMarker || parsed.liveStreamNull)) {
    return {
      state: ROOM_STATUS.OFFLINE,
      liveStreamId: null,
      title: parsed.title || null,
      reason: 'NO_ACTIVE_STREAM',
      httpStatus: response.status,
      checkedAt,
      bytes: parsed.bytes
    };
  }
  return {
    state: ROOM_STATUS.UNKNOWN,
    liveStreamId: null,
    title: parsed.title || null,
    reason: parsed.genericTitle ? 'GENERIC_PAGE' : 'NO_ROOM_MARKER',
    httpStatus: response.status,
    checkedAt,
    bytes: parsed.bytes
  };
}

/** Convert an inconclusive status into a typed error for connect/monitor paths. */
export function assertLiveStatus(status) {
  if (status?.state === ROOM_STATUS.LIVE) return status;
  if (status?.state === ROOM_STATUS.OFFLINE) {
    throw new KuaishouError(KUAISHOU_ERRORS.ROOM_OFFLINE, {
      httpStatus: 409,
      details: {status: status.state},
      retryable: false
    });
  }
  if (status?.state === ROOM_STATUS.NOT_FOUND) {
    throw new KuaishouError(KUAISHOU_ERRORS.ROOM_NOT_FOUND, {
      httpStatus: 404,
      details: {status: status.state},
      retryable: false
    });
  }
  if (status?.state === ROOM_STATUS.RATE_LIMITED) {
    throw new KuaishouError(KUAISHOU_ERRORS.RATE_LIMITED, {
      httpStatus: 429,
      details: {status: status.state, reason: status.reason ?? null},
      retryable: true
    });
  }
  throw new KuaishouError(KUAISHOU_ERRORS.STATUS_UNKNOWN, {
    httpStatus: 409,
    details: {status: status?.state ?? 'unknown', reason: status?.reason ?? null},
    retryable: true
  });
}
