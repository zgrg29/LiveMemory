import {DOUYIN_UA, computeSignature} from './sign.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';

/**
 * Douyin public live page client.
 *
 * Responsibilities:
 *   - read one public room page (no account required) and parse the live state,
 *     the stable room id and the anchor identity;
 *   - keep the short-lived anonymous cookies (`ttwid`, ...) the WebSocket
 *     handshake needs;
 *   - build the signed WebSocket URL.
 *
 * It never sends the broadcaster's account cookie anywhere except to
 * `live.douyin.com` / `webcast*.douyin.com`, never stores a page body and never
 * logs a cookie value.
 */

const DEFAULT_OPTIONS = Object.freeze({
  pageUrl: 'https://live.douyin.com',
  wsBase: 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/',
  requestTimeoutMs: 12000,
  cookieTtlMs: 15 * 60 * 1000,
  maxCookieBytes: 8192
});

const ROOM_STATUS = Object.freeze({
  LIVE: 2,
  ENDED: 4
});

/** Cookies that must never leave the machine except to Douyin itself. */
const ALLOWED_COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function unescapeJson(text) {
  return String(text ?? '').replace(/\\"/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function safeJsonString(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return String(value);
  }
}

/** Parse the live room state out of the public page HTML. */
export function parseRoomPage(html) {
  const text = unescapeJson(html);
  // The page embeds several serialized chunks. The authoritative room id is the
  // one next to `web_rid`; the live state lives in the `roomStore` chunk and is
  // matched by the same id instead of by position.
  const webRid = text.match(/"web_rid":"(\d{6,20})"/)?.[1] ?? null;
  let roomId = null;
  if (webRid) {
    const at = text.indexOf(`"web_rid":"${webRid}"`);
    const around = at >= 0 ? text.slice(Math.max(0, at - 2500), at + 2500) : '';
    roomId = around.match(/"roomId":"(\d{6,20})"/)?.[1] ?? null;
  }
  roomId = roomId
    ?? text.match(/"roomStore"[\s\S]{0,4000}?"room":\{"id_str":"(\d{6,20})"/)?.[1]
    ?? text.match(/"roomId":"(\d{6,20})"/)?.[1]
    ?? null;

  let status = null;
  let title = null;
  let userCount = null;
  if (roomId) {
    const withStatus = new RegExp(`"id_str":"${roomId}","status":(\\d+)`).exec(text);
    if (withStatus) {
      status = Number(withStatus[1]);
      const start = Math.max(0, withStatus.index);
      const block = text.slice(start, start + 2500);
      title = safeJsonString(block.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ?? null);
      userCount = safeJsonString(block.match(/"user_count_str":"([^"]*)"/)?.[1] ?? null);
    } else {
      // A room id without a status is still useful for monitoring; status stays
      // unknown instead of being guessed as offline.
      const start = text.indexOf(`"id_str":"${roomId}"`);
      const block = start >= 0 ? text.slice(start, start + 2500) : '';
      title = safeJsonString(block.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ?? null);
      userCount = safeJsonString(block.match(/"user_count_str":"([^"]*)"/)?.[1] ?? null);
    }
  }
  const anchorBlock = text.match(/"anchor":\{"id_str":"(\d+)","sec_uid":"([^"]*)","nickname":"((?:[^"\\]|\\.)*)"/);
  const anchorId = anchorBlock?.[1] ?? null;
  const anchorSecUid = anchorBlock?.[2] ?? null;
  const anchorName = anchorBlock ? safeJsonString(anchorBlock[3]) : null;
  return {
    roomId,
    webRid,
    status,
    isLive: status === ROOM_STATUS.LIVE,
    ended: status === ROOM_STATUS.ENDED,
    title,
    userCount,
    anchorId,
    anchorSecUid,
    anchorName
  };
}

export class DouyinWebClient {
  constructor({
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = null,
    pageUrl = DEFAULT_OPTIONS.pageUrl,
    wsBase = DEFAULT_OPTIONS.wsBase,
    requestTimeoutMs = DEFAULT_OPTIONS.requestTimeoutMs,
    cookieTtlMs = DEFAULT_OPTIONS.cookieTtlMs
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.pageUrl = String(pageUrl ?? DEFAULT_OPTIONS.pageUrl).replace(/\/+$/, '');
    this.wsBase = String(wsBase ?? DEFAULT_OPTIONS.wsBase);
    this.requestTimeoutMs = requestTimeoutMs;
    this.cookieTtlMs = cookieTtlMs;
    this.cookies = new Map();
    this.cookiesAt = 0;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  setCookieHeader(header) {
    for (const part of String(header ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!ALLOWED_COOKIE_NAME.test(name) || !value) continue;
      this.cookies.set(name, value);
    }
    this.cookiesAt = this.now();
  }

  clearCookies() {
    this.cookies.clear();
    this.cookiesAt = 0;
  }

  #storeResponseCookies(response) {
    const lines = typeof response?.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const line of lines) {
      const pair = String(line ?? '').split(';')[0];
      if (!pair) continue;
      this.setCookieHeader(pair);
    }
  }

  async #request(url, {headers = {}, method = 'GET'} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': DOUYIN_UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: 'https://live.douyin.com/',
          ...headers
        }
      });
      return response;
    } catch (error) {
      throw new DouyinError(DOUYIN_ERRORS.NETWORK, {
        messageKey: 'errors.douyinNetwork',
        details: {reason: 'fetch'},
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read one public room page. The page itself sets `ttwid`, so this also
   * refreshes the anonymous cookie jar.
   */
  async fetchRoom(webRid) {
    const rid = String(webRid ?? '').trim();
    if (!/^\d{6,20}$/.test(rid)) {
      throw new DouyinError(DOUYIN_ERRORS.LINK_INVALID, {
        messageKey: 'errors.douyinLinkInvalid',
        httpStatus: 400
      });
    }
    const url = `${this.pageUrl}/${rid}`;
    const cookie = this.cookieHeader();
    const response = await this.#request(url, {
      headers: cookie ? {cookie} : {}
    });
    this.#storeResponseCookies(response);
    if (response.status === 429) {
      throw new DouyinError(DOUYIN_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.douyinRateLimit',
        httpStatus: 429,
        details: {status: response.status}
      });
    }
    if (response.status === 403 || response.status === 401) {
      throw new DouyinError(DOUYIN_ERRORS.BLOCKED, {
        messageKey: 'errors.douyinBlocked',
        httpStatus: 403,
        details: {status: response.status}
      });
    }
    if (!response.ok) {
      throw new DouyinError(response.status === 404 ? DOUYIN_ERRORS.ROOM_NOT_FOUND : DOUYIN_ERRORS.NETWORK, {
        messageKey: response.status === 404 ? 'errors.douyinRoomNotFound' : 'errors.douyinNetwork',
        httpStatus: response.status === 404 ? 404 : 502,
        details: {status: response.status}
      });
    }
    let html;
    try {
      html = await response.text();
    } catch (error) {
      throw new DouyinError(DOUYIN_ERRORS.NETWORK, {messageKey: 'errors.douyinNetwork', cause: error});
    }
    const room = parseRoomPage(html);
    if (!room.roomId) {
      const blocked = /验证|verify|captcha|安全风险/i.test(html.slice(0, 4000));
      throw new DouyinError(blocked ? DOUYIN_ERRORS.BLOCKED : DOUYIN_ERRORS.ROOM_NOT_FOUND, {
        messageKey: blocked ? 'errors.douyinBlocked' : 'errors.douyinRoomNotFound',
        httpStatus: blocked ? 403 : 404,
        details: {webRid: rid, blocked}
      });
    }
    return {
      ...room,
      webRid: room.webRid ?? rid,
      checkedAt: this.now(),
      pageUrl: `${this.pageUrl}/${rid}`
    };
  }

  /**
   * Build the signed handshake URL. `userUniqueId` is the room id, matching
   * the web client for an anonymous audience connection.
   */
  buildWebSocketUrl({roomId, userUniqueId = null, cookie = null}) {
    const signature = computeSignature({roomId, userUniqueId: userUniqueId ?? roomId});
    const now = this.now();
    const cursor = `r-${roomId}_d-1_u-1_fh-${roomId}_t-${now}`;
    const internalExt = [
      'internal_src:dim',
      `wss_push_room_id:${roomId}`,
      `wss_push_did:${roomId}`,
      `first_req_ms:${now}`,
      `fetch_time:${now}`,
      'seq:1',
      `wss_info:0-${now}-0-0`,
      `wrds_v:${roomId}`
    ].join('|');
    const params = [
      ['app_name', 'douyin_web'],
      ['version_code', '180800'],
      ['webcast_sdk_version', '1.0.14-beta.0'],
      ['update_version_code', '1.0.14-beta.0'],
      ['compress', 'gzip'],
      ['device_platform', 'web'],
      ['cookie_enabled', 'true'],
      ['screen_width', '1536'],
      ['screen_height', '864'],
      ['browser_language', 'zh-CN'],
      ['browser_platform', 'Win32'],
      ['browser_name', 'Mozilla'],
      ['browser_version', DOUYIN_UA.replace(/^Mozilla\//, '')],
      ['browser_online', 'true'],
      ['tz_name', 'Asia/Shanghai'],
      ['cursor', cursor],
      ['internal_ext', internalExt],
      ['host', 'https://live.douyin.com'],
      ['aid', '6383'],
      ['live_id', '1'],
      ['did_rule', '3'],
      ['endpoint', 'live_pc'],
      ['support_wrds', '1'],
      ['user_unique_id', String(userUniqueId ?? roomId)],
      ['im_path', '/webcast/im/fetch/'],
      ['identity', 'audience'],
      ['need_persist_msg_count', '15'],
      ['insert_task_id', ''],
      ['live_reason', ''],
      ['room_id', String(roomId)],
      ['heartbeatDuration', '0']
    ];
    const query = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return {
      url: `${this.wsBase}?${query}&signature=${encodeURIComponent(signature)}`,
      headers: {
        'user-agent': DOUYIN_UA,
        referer: `https://live.douyin.com/${roomId}`,
        ...(cookie ? {cookie} : {})
      },
      signature
    };
  }

  /** Read the room again to confirm live/ended state. */
  async checkRoom(webRid) {
    const room = await this.fetchRoom(webRid);
    return room;
  }
}

export const __internal = {ROOM_STATUS, unescapeJson, safeJsonString};
