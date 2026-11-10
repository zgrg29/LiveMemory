import {signParams, extractWbiKey, mixinKey} from './wbi.mjs';

/**
 * Minimal Bilibili live HTTP client.
 *
 * Only public/undocumented web endpoints are used, with the same headers a
 * browser sends. Cookies are attached when the user has logged in; nothing is
 * written to the log here (the logger redacts cookie/token fragments, and this
 * module never logs a cookie header).
 */

export const LIVE_API = 'https://api.live.bilibili.com';
export const PASSPORT_API = 'https://passport.bilibili.com';
export const WEB_API = 'https://api.bilibili.com';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const WBI_TTL_MS = 30 * 60 * 1000;

export class BilibiliError extends Error {
  constructor(code, message, {biliCode = null, status = null, cause = null} = {}) {
    super(message);
    this.name = 'BilibiliError';
    this.code = code;
    this.biliCode = biliCode;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function isAuthCode(code) {
  return code === -101 || code === -400 || code === -403;
}

export class BilibiliApi {
  constructor({cookie = '', fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000} = {}) {
    this.cookie = String(cookie ?? '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.wbi = null;
    this.buvid = null;
    this.user = null;
  }

  setCookie(cookie) {
    this.cookie = String(cookie ?? '');
    this.wbi = null;
    this.user = null;
  }

  get loggedIn() {
    return /(?:^|;\s*)SESSDATA=/.test(this.cookie);
  }

  cookieHeader({withBuvid = true} = {}) {
    const parts = [];
    if (this.cookie) parts.push(this.cookie.replace(/;\s*$/, ''));
    if (withBuvid && this.buvid && !/(?:^|;\s*)buvid3=/.test(this.cookie)) {
      parts.push(`buvid3=${this.buvid}`);
    }
    return parts.join('; ');
  }

  async request(url, {referer = 'https://live.bilibili.com/', timeoutMs = this.timeoutMs, withBuvid = false, allowCodes = []} = {}) {
    const headers = {
      'User-Agent': USER_AGENT,
      Referer: referer,
      Accept: 'application/json, text/plain, */*'
    };
    const cookie = this.cookieHeader({withBuvid});
    if (cookie) headers.Cookie = cookie;
    let response;
    try {
      response = await this.fetchImpl(url, {headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow'});
    } catch (error) {
      throw new BilibiliError('NETWORK', `request failed: ${error?.message ?? error}`, {cause: error});
    }
    let payload = null;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new BilibiliError('BAD_RESPONSE', `response is not JSON (HTTP ${response.status})`, {status: response.status});
    }
    if (!response.ok) {
      throw new BilibiliError('HTTP', `HTTP ${response.status}`, {status: response.status});
    }
    const code = Number(payload?.code ?? 0);
    if (code !== 0 && !allowCodes.includes(code)) {
      throw new BilibiliError(isAuthCode(code) ? 'AUTH' : 'PLATFORM', `bilibili code ${code}: ${payload?.message ?? ''}`, {
        biliCode: code,
        status: response.status
      });
    }
    return {data: payload?.data ?? null, payload, response, code};
  }

  async ensureBuvid() {
    if (this.buvid) return this.buvid;
    const fromCookie = /(?:^|;\s*)buvid3=([^;]+)/.exec(this.cookie)?.[1] ?? null;
    if (fromCookie) {
      this.buvid = fromCookie;
      return this.buvid;
    }
    const {data} = await this.request(`${WEB_API}/x/frontend/finger/spi`, {referer: 'https://www.bilibili.com/'});
    this.buvid = data?.b_3 ?? null;
    return this.buvid;
  }

  /** WBI keys from the unauthenticated `nav` endpoint, cached for 30 minutes. */
  async ensureWbi({force = false} = {}) {
    if (!force && this.wbi && this.now() - this.wbi.at < WBI_TTL_MS) return this.wbi;
    // -101 ("not logged in") is the normal anonymous answer; the WBI images are
    // still present, so it must not be treated as a failure.
    const {data} = await this.request(`${WEB_API}/x/web-interface/nav`, {
      referer: 'https://www.bilibili.com/',
      withBuvid: true,
      allowCodes: [-101]
    });
    const img = extractWbiKey(data?.wbi_img?.img_url);
    const sub = extractWbiKey(data?.wbi_img?.sub_url);
    if (!img || !sub) throw new BilibiliError('WBI', 'nav response has no WBI image keys');
    this.wbi = {img, sub, key: mixinKey(img, sub), at: this.now()};
    return this.wbi;
  }

  signedQuery(params) {
    if (!this.wbi) throw new BilibiliError('WBI', 'WBI keys are not loaded');
    return signParams(params, this.wbi.key, {now: this.now()});
  }

  async roomInit(roomId) {
    const {data} = await this.request(`${LIVE_API}/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`, {withBuvid: true});
    const resolved = Number(data?.room_id);
    if (!Number.isInteger(resolved) || resolved <= 0) {
      throw new BilibiliError('ROOM_NOT_FOUND', 'room does not exist');
    }
    return {
      roomId: resolved,
      shortId: Number(data?.short_id ?? 0) || null,
      uid: Number(data?.uid ?? 0) || null,
      liveStatus: Number(data?.live_status ?? 0),
      liveTime: Number(data?.live_time ?? 0) || null
    };
  }

  /**
   * Current live status from the public room endpoint.
   *
   * `live_status` is 0 (not started), 1 (live) or 2 (carousel). The field is
   * required: a missing/unknown value is a failure, never an implicit 0. Rate
   * limits, risk control (-352) and timeouts surface as BilibiliError so the
   * caller can back off without declaring the broadcast over.
   */
  async roomStatus(roomId, {timeoutMs = 8000} = {}) {
    const {data} = await this.request(
      `${LIVE_API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
      {withBuvid: true, timeoutMs}
    );
    const status = Number(data?.live_status);
    if (!Number.isInteger(status) || ![0, 1, 2].includes(status)) {
      throw new BilibiliError('STATUS_INVALID', 'room response has no valid live_status');
    }
    const resolvedRoom = Number(data?.room_id);
    if (!Number.isInteger(resolvedRoom) || resolvedRoom <= 0) {
      throw new BilibiliError('STATUS_INVALID', 'room response has no valid room_id');
    }
    return {
      roomId: resolvedRoom,
      liveStatus: status,
      liveTime: data?.live_time ?? null,
      title: data?.title ?? null,
      online: Number(data?.online ?? 0) || null
    };
  }

  /** Room metadata used for the session title. Optional: failures are tolerated. */
  async roomInfo(roomId) {
    const {data} = await this.request(`${LIVE_API}/xlive/web-room/v1/index/getInfoByRoom?room_id=${encodeURIComponent(roomId)}`, {withBuvid: true});
    const info = data?.room_info ?? {};
    const anchor = data?.anchor_info?.base_info ?? {};
    return {
      title: info.title ?? null,
      areaName: info.area_name ?? null,
      parentAreaName: info.parent_area_name ?? null,
      liveStatus: Number(info.live_status ?? 0),
      online: Number(info.online ?? 0) || null,
      anchorName: anchor.uname ?? null,
      anchorUid: Number(anchor.uid ?? 0) || null
    };
  }

  async danmuInfo(roomId) {
    await this.ensureBuvid();
    await this.ensureWbi();
    const query = this.signedQuery({id: roomId, type: 0});
    const {data} = await this.request(`${LIVE_API}/xlive/web-room/v1/index/getDanmuInfo?${query}`, {withBuvid: true});
    const token = data?.token;
    const hosts = Array.isArray(data?.host_list) ? data.host_list : [];
    if (!token || hosts.length === 0) throw new BilibiliError('DANMU_INFO', 'getDanmuInfo returned no token or hosts');
    return {
      token,
      hosts: hosts.map((host) => ({
        host: host.host,
        port: Number(host.wss_port ?? host.port ?? 443) || 443,
        wsPort: Number(host.port ?? 2244) || 2244
      }))
    };
  }

  async navUser() {
    const {data} = await this.request(`${WEB_API}/x/web-interface/nav`, {
      referer: 'https://www.bilibili.com/',
      withBuvid: true,
      allowCodes: [-101]
    });
    this.user = data?.isLogin
      ? {uid: String(data.mid ?? ''), name: data.uname ?? '', face: data.face ?? null}
      : null;
    return this.user;
  }

  async qrGenerate() {
    const {data} = await this.request(`${PASSPORT_API}/x/passport-login/web/qrcode/generate`, {
      referer: 'https://www.bilibili.com/',
      withBuvid: true
    });
    if (!data?.url || !data?.qrcode_key) throw new BilibiliError('QR', 'QR generation returned no url/key');
    return {url: data.url, key: data.qrcode_key, expiresInMs: 180000};
  }

  async qrPoll(key) {
    const {data, response} = await this.request(
      `${PASSPORT_API}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
      {referer: 'https://www.bilibili.com/', withBuvid: true}
    );
    return {
      code: Number(data?.code ?? -1),
      message: data?.message ?? '',
      url: data?.url ?? null,
      setCookies: readSetCookies(response)
    };
  }
}

/**
 * Cookies from a poll response. `headers.getSetCookie()` is the undici API; the
 * fallback keeps older runtimes working.
 */
export function readSetCookies(response) {
  try {
    if (typeof response?.headers?.getSetCookie === 'function') {
      return response.headers.getSetCookie();
    }
    const raw = response?.headers?.get?.('set-cookie');
    if (raw) return [raw];
  } catch {
    /* ignore */
  }
  return [];
}

export const __internal = {USER_AGENT, WBI_TTL_MS};
