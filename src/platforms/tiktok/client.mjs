import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {parseTikTokInput} from './link.mjs';

/**
 * Read-only TikTok LIVE metadata client.
 *
 * Two public endpoints are used, both without login, cookies, API keys or a
 * signing service:
 *   - `www.tiktok.com/api-live/user/room/` resolves a handle to the current room
 *     (room id, live state, anchor id/nickname, title).
 *   - `webcast.tiktok.com/webcast/room/info/` and `.../gift/list/` add room stats
 *     and the gift catalog (name + diamond display value).
 *
 * Chat/gift *events* are not available from these endpoints; they are delivered
 * by the signed transport (see `signer.mjs`). This client never invents events.
 *
 * TikTok answers a plain HTTP client with rate limiting (403) when requests are
 * too dense, so every call is subject to the caller's pacer.
 */

const HOST_WEB = 'https://www.tiktok.com';
const HOST_WEBCAST = 'https://webcast.tiktok.com';

export const TIKTOK_STATUS = Object.freeze({
  LIVE: 2,
  ENDED: 4
});

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Fixed client parameters. They identify a normal desktop web session. */
export const CLIENT_PARAMS = Object.freeze({
  aid: '1988',
  app_language: 'en-US',
  app_name: 'tiktok_web',
  browser_language: 'en-US',
  browser_name: 'Mozilla',
  browser_platform: 'Win32',
  browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  browser_online: 'true',
  channel: 'tiktok_web',
  cookie_enabled: 'true',
  device_platform: 'web',
  focus_state: 'true',
  from_page: 'live',
  history_len: '3',
  is_fullscreen: 'false',
  is_page_visible: 'true',
  language: 'en',
  os: 'windows',
  priority_region: '',
  referer: '',
  region: 'US',
  screen_height: '1080',
  screen_width: '1920',
  tz_name: 'Asia/Shanghai',
  webcast_language: 'en'
});

export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class TikTokClient {
  constructor({
    fetchImpl = globalThis.fetch,
    now = Date.now,
    userAgent = DEFAULT_UA,
    timeoutMs = 12000,
    giftCatalogTtlMs = 10 * 60 * 1000
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.giftCatalogTtlMs = giftCatalogTtlMs;
    this.giftCatalogCache = new Map();
  }

  async #requestJson(url, {reason} = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {messageKey: 'errors.tiktokNotConfigured', httpStatus: 503});
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          'user-agent': this.userAgent,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          referer: 'https://www.tiktok.com/'
        },
        signal: controller.signal
      });
    } catch (error) {
      throw new TikTokError(TIKTOK_ERRORS.NETWORK, {
        messageKey: 'errors.tiktokNetwork',
        httpStatus: 502,
        cause: error,
        details: {reason: error?.name === 'AbortError' ? 'timeout' : (reason ?? 'fetch')}
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429) {
      throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.tiktokRateLimit',
        httpStatus: 429,
        status: 429,
        retryAfterMs: retryAfterMs(response)
      });
    }
    if (response.status === 403) {
      throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.tiktokRateLimit',
        httpStatus: 429,
        status: 403,
        retryAfterMs: retryAfterMs(response),
        details: {reason: 'http_403'}
      });
    }
    if (response.status >= 500) {
      throw new TikTokError(TIKTOK_ERRORS.NETWORK, {
        messageKey: 'errors.tiktokNetwork',
        httpStatus: 502,
        status: response.status,
        details: {reason: reason ?? 'http_5xx'}
      });
    }
    if (!response.ok) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        status: response.status,
        details: {reason: reason ?? 'http'}
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        cause: error,
        details: {reason: 'invalid_json'}
      });
    }
  }

  /**
   * Resolve a handle to its current room view.
   * `isLive` is `liveRoom.status !== 4` only when a room object is present.
   */
  async resolveRoom(input) {
    const parsed = typeof input === 'string' ? parseTikTokInput(input) : input;
    const uniqueId = String(parsed?.uniqueId ?? '');
    const url = `${HOST_WEB}/api-live/user/room/?${buildQuery({...CLIENT_PARAMS, uniqueId, sourceType: '54'})}`;
    const payload = await this.#requestJson(url, {reason: 'api_live_user_room'});
    const statusCode = Number(payload?.statusCode ?? 0);
    if (statusCode === 19881007) {
      throw new TikTokError(TIKTOK_ERRORS.ROOM_NOT_FOUND, {
        messageKey: 'errors.tiktokRoomNotFound',
        httpStatus: 404,
        details: {uniqueId, statusCode}
      });
    }
    if (statusCode && statusCode !== 0) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'api_live_status', statusCode, message: payload?.message ?? null}
      });
    }
    const user = payload?.data?.user ?? null;
    const liveRoom = payload?.data?.liveRoom ?? null;
    if (!user || !user.roomId) {
      throw new TikTokError(TIKTOK_ERRORS.ROOM_NOT_FOUND, {
        messageKey: 'errors.tiktokRoomNotFound',
        httpStatus: 404,
        details: {uniqueId, reason: 'room_id_missing'}
      });
    }
    const status = Number(liveRoom?.status ?? 0);
    return {
      uniqueId,
      roomId: String(user.roomId),
      anchorUid: user.id === null || user.id === undefined ? null : String(user.id),
      anchorName: user.nickname ?? uniqueId,
      isLive: status !== TIKTOK_STATUS.ENDED,
      status,
      title: liveRoom?.title ?? null,
      startedAt: null,
      checkedAt: this.now()
    };
  }

  /** Room info adds the broadcast title, start time, cumulative viewers and stats. */
  async fetchRoomInfo(roomId) {
    const id = String(roomId ?? '').trim();
    if (!/^\d{6,}$/.test(id)) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'room_id_invalid'}
      });
    }
    const url = `${HOST_WEBCAST}/webcast/room/info/?${buildQuery({...CLIENT_PARAMS, room_id: id})}`;
    const payload = await this.#requestJson(url, {reason: 'webcast_room_info'});
    const statusCode = Number(payload?.status_code ?? 0);
    if (statusCode !== 0) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'room_info_status', statusCode}
      });
    }
    const data = payload?.data ?? {};
    const owner = data.owner ?? {};
    const stats = data.stats ?? {};
    const createTime = Number(data.create_time ?? 0);
    const totalUser = Number(stats.total_user ?? 0);
    return {
      roomId: String(data.id_str ?? data.id ?? id),
      status: Number(data.status ?? 0),
      isLive: Number(data.status ?? 0) === TIKTOK_STATUS.LIVE,
      title: data.title ?? null,
      anchorUid: owner.id_str ?? (owner.id === undefined ? null : String(owner.id)),
      anchorName: owner.nickname ?? null,
      anchorUniqueId: owner.unique_id ?? null,
      startedAt: createTime > 0 ? createTime * 1000 : null,
      totalViewers: totalUser > 0 ? totalUser : null,
      likeCount: Number(stats.like_count ?? 0) || null,
      checkedAt: this.now()
    };
  }

  /**
   * Gift catalog for one room: id -> {id, name, diamondCount, combo, giftType}.
   * Cached per room because the payload is ~3 MB and rarely changes.
   */
  async fetchGiftCatalog(roomId) {
    const id = String(roomId ?? '').trim();
    const cached = this.giftCatalogCache.get(id);
    if (cached && this.now() - cached.at < this.giftCatalogTtlMs) return cached.catalog;
    const url = `${HOST_WEBCAST}/webcast/gift/list/?${buildQuery({...CLIENT_PARAMS, room_id: id})}`;
    const payload = await this.#requestJson(url, {reason: 'webcast_gift_list'});
    const gifts = payload?.data?.gifts;
    if (!Array.isArray(gifts)) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'gift_list_shape'}
      });
    }
    const catalog = new Map();
    for (const gift of gifts) {
      const giftId = gift?.id === undefined || gift?.id === null ? null : String(gift.id);
      if (!giftId) continue;
      const diamondCount = Number(gift.diamond_count ?? 0);
      catalog.set(giftId, {
        id: giftId,
        name: typeof gift.name === 'string' ? gift.name : null,
        diamondCount: Number.isFinite(diamondCount) ? diamondCount : 0,
        combo: Boolean(gift.combo),
        giftType: Number(gift.type ?? 0) || null
      });
    }
    this.giftCatalogCache.set(id, {at: this.now(), catalog});
    return catalog;
  }

  /** Combined public room view used by the HTTP API and the detector. */
  async checkRoom(input) {
    const resolved = await this.resolveRoom(input);
    let info = null;
    if (resolved.isLive) {
      try {
        info = await this.fetchRoomInfo(resolved.roomId);
      } catch (error) {
        // Room info failing must not turn a live room into "offline". Keep the
        // resolve result and surface the missing fields as null.
        if (error?.code === TIKTOK_ERRORS.RATE_LIMITED) throw error;
        info = null;
      }
    }
    return {
      ...resolved,
      title: info?.title ?? resolved.title,
      startedAt: info?.startedAt ?? null,
      totalViewers: info?.totalViewers ?? null,
      likeCount: info?.likeCount ?? null,
      anchorName: info?.anchorName ?? resolved.anchorName,
      anchorUid: info?.anchorUid ?? resolved.anchorUid,
      liveUrl: `https://www.tiktok.com/@${resolved.uniqueId}/live`
    };
  }
}

export const __internal = {retryAfterMs, DEFAULT_UA};
