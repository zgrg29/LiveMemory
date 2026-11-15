import {DOUYIN_UA} from './sign.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';
import {hasDouyinSession, sanitizeDouyinCookie} from './cookie-store.mjs';

/**
 * Douyin account login for gift events.
 *
 * The desired experience is the same as Bilibili: show a QR code, scan it with
 * the phone app, done. The public web login flow is:
 *   GET  sso.douyin.com/get_qrcode/     -> {token, qrcode/qrcode_index_url}
 *   GET  sso.douyin.com/check_qrconnect/ -> status + redirect_url
 *   follow the redirect chain            -> sessionid cookie
 *
 * As of 2026 the SSO endpoints are protected by a device-fingerprint challenge
 * (fpk1 / ticket-guard / a_bogus) that requires a real browser runtime. This
 * module therefore behaves conservatively:
 *   - it sends a normal, signed-as-far-as-possible request;
 *   - if the platform answers with a risk-control page instead of JSON, it
 *     reports DOUYIN_LOGIN_BLOCKED with a translatable explanation;
 *   - it never invents a QR code, a login state or a cookie;
 *   - it offers an explicit, local-only cookie import as a fallback that the
 *     user can choose, and stores it encrypted.
 *
 * Anonymous chat does not need any of this.
 */

export const QR_STATE = Object.freeze({
  IDLE: 'idle',
  WAITING: 'waiting',
  SCANNED: 'scanned',
  SUCCESS: 'success',
  EXPIRED: 'expired',
  ERROR: 'error'
});

const QR_TTL_MS = 4 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

function statusFromData(data) {
  const raw = data?.status ?? data?.status_code ?? data?.error_code;
  const number = Number(raw);
  if (number === 2) return QR_STATE.SUCCESS;
  if (number === 1) return QR_STATE.SCANNED;
  if (number === 3) return QR_STATE.EXPIRED;
  if (number === 0) return QR_STATE.WAITING;
  // Some responses only carry an explicit redirect_url on success.
  if (data?.redirect_url) return QR_STATE.SUCCESS;
  return QR_STATE.WAITING;
}

export class DouyinLogin {
  constructor({
    store = null,
    fetchImpl = globalThis.fetch,
    logger = null,
    now = Date.now,
    ssoBase = 'https://sso.douyin.com',
    homeUrl = 'https://www.douyin.com',
    timeoutMs = 12000
  } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.ssoBase = String(ssoBase).replace(/\/+$/, '');
    this.homeUrl = String(homeUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.qr = null;
    this.lastBlocked = null;
    const saved = store?.load();
    this.cookie = saved?.cookie ?? '';
    this.user = saved?.user ?? null;
  }

  get loggedIn() {
    return hasDouyinSession(this.cookie);
  }

  /** Safe to serialize. Never contains the cookie. */
  status() {
    return {
      loggedIn: this.loggedIn,
      user: this.user,
      qr: this.qr
        ? {state: this.qr.state, expiresAt: this.qr.expiresAt, blocked: this.qr.blocked ?? null}
        : null,
      blocked: this.lastBlocked,
      stored: this.store ? this.store.status() : {stored: false, user: null, savedAt: null}
    };
  }

  async #request(url, {headers = {}} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': DOUYIN_UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          accept: 'application/json, text/plain, */*',
          referer: 'https://live.douyin.com/',
          ...(this.cookie ? {cookie: this.cookie} : {}),
          ...headers
        }
      });
    } catch (error) {
      throw new DouyinError(DOUYIN_ERRORS.NETWORK, {messageKey: 'errors.douyinNetwork', cause: error});
    } finally {
      clearTimeout(timer);
    }
  }

  #blocked(reason, details = null) {
    this.lastBlocked = {reason, at: this.now()};
    return new DouyinError(DOUYIN_ERRORS.LOGIN_BLOCKED, {
      messageKey: 'errors.douyinLoginBlocked',
      httpStatus: 409,
      details: {reason, ...(details ?? {})}
    });
  }

  /**
   * Ask Douyin for a login QR code.
   * @returns {{url:string, token:string|null, image:string|null, expiresAt:number, state:string}}
   */
  async startQr() {
    const query = [
      'aid=6383',
      'service=https%3A%2F%2Flive.douyin.com',
      'need_logo=false',
      'need_short_url=false'
    ].join('&');
    const response = await this.#request(`${this.ssoBase}/get_qrcode/?${query}`);
    const contentType = String(response.headers.get?.('content-type') ?? '');
    const text = await response.text();
    if (!response.ok || /^\s*</.test(text) || !/json/i.test(contentType)) {
      // A risk-control/verification page is not a QR code. Say so plainly
      // instead of rendering an HTML page as if the user could scan it.
      throw this.#blocked(/验证|安全风险|verify|captcha/i.test(text) ? 'risk_control' : 'unexpected_response', {
        status: response.status
      });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw this.#blocked('invalid_json', {status: response.status});
    }
    const data = payload?.data ?? payload ?? {};
    const token = data.token ?? data.qrcode_token ?? null;
    const url = data.qrcode_index_url ?? data.qrcode_url ?? data.url ?? null;
    const image = data.qrcode ?? data.qrcode_base64 ?? null;
    if (!token && !url && !image) {
      throw this.#blocked('no_qrcode', {message: String(payload?.message ?? '').slice(0, 120)});
    }
    this.lastBlocked = null;
    this.qr = {
      token: token ? String(token) : null,
      url: url ? String(url) : null,
      image: image ? String(image) : null,
      createdAt: this.now(),
      expiresAt: this.now() + QR_TTL_MS,
      state: QR_STATE.WAITING
    };
    this.logger?.info({event: 'douyin.login.qr', hasToken: Boolean(token), hasUrl: Boolean(url)});
    return {
      url: this.qr.url ?? (token ? `https://www.douyin.com/login/?token=${encodeURIComponent(token)}` : null),
      token: this.qr.token,
      image: this.qr.image,
      expiresAt: this.qr.expiresAt,
      state: this.qr.state
    };
  }

  async pollQr() {
    if (!this.qr) {
      throw new DouyinError(DOUYIN_ERRORS.QR_MISSING, {
        messageKey: 'errors.douyinQrMissing',
        httpStatus: 400
      });
    }
    if (this.now() > this.qr.expiresAt) {
      this.qr.state = QR_STATE.EXPIRED;
      return {state: QR_STATE.EXPIRED, user: null};
    }
    if (!this.qr.token) {
      throw new DouyinError(DOUYIN_ERRORS.LOGIN_BLOCKED, {
        messageKey: 'errors.douyinLoginBlocked',
        httpStatus: 409,
        details: {reason: 'missing_token'}
      });
    }
    const query = [
      'aid=6383',
      `token=${encodeURIComponent(this.qr.token)}`,
      'service=https%3A%2F%2Flive.douyin.com'
    ].join('&');
    const response = await this.#request(`${this.ssoBase}/check_qrconnect/?${query}`);
    const contentType = String(response.headers.get?.('content-type') ?? '');
    const text = await response.text();
    if (!response.ok || /^\s*</.test(text) || !/json/i.test(contentType)) {
      throw this.#blocked('risk_control', {status: response.status, phase: 'poll'});
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw this.#blocked('invalid_json', {phase: 'poll'});
    }
    const data = payload?.data ?? payload ?? {};
    const state = statusFromData(data);
    this.qr.state = state;
    if (state !== QR_STATE.SUCCESS) {
      if (state === QR_STATE.EXPIRED) this.qr.state = QR_STATE.EXPIRED;
      return {state, user: null, expiresAt: this.qr.expiresAt};
    }
    const redirectUrl = data.redirect_url ?? data.redirectUrl ?? null;
    if (!redirectUrl) {
      throw this.#blocked('missing_redirect', {phase: 'confirm'});
    }
    const cookie = await this.#followLoginRedirect(redirectUrl);
    if (!hasDouyinSession(cookie)) {
      throw new DouyinError(DOUYIN_ERRORS.AUTH, {
        messageKey: 'errors.douyinAuth',
        httpStatus: 502,
        details: {reason: 'no_session_cookie'}
      });
    }
    this.cookie = cookie;
    this.user = null;
    this.qr = null;
    if (this.store) this.store.save({cookie, user: null, now: this.now()});
    this.logger?.info({event: 'douyin.login.success', remembered: Boolean(this.store)});
    return {state: QR_STATE.SUCCESS, user: this.user};
  }

  /**
   * Follow the redirect chain and collect the session cookie. Only the Douyin
   * host is followed; an off-site location is ignored instead of being fetched.
   */
  async #followLoginRedirect(redirectUrl) {
    let current = String(redirectUrl);
    const jar = new Map();
    for (const part of this.cookie.split(';')) {
      const index = part.indexOf('=');
      if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    for (let hop = 0; hop < 5; hop += 1) {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        break;
      }
      if (parsed.protocol !== 'https:' || !/(^|\.)douyin\.com$/i.test(parsed.hostname)) break;
      const cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await this.#request(current, {
        headers: cookieHeader ? {cookie: cookieHeader} : {}
      });
      const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of lines) {
        const pair = String(line ?? '').split(';')[0];
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      const location = response.headers.get?.('location');
      if (!location) break;
      current = new URL(location, current).toString();
    }
    return sanitizeDouyinCookie([...jar].map(([name, value]) => `${name}=${value}`).join('; '));
  }

  /**
   * Optional, explicit fallback for users who already have a web session.
   * This is not required for anonymous chat and is never automatic.
   */
  async applyCookie(header) {
    const cookie = sanitizeDouyinCookie(header);
    if (!hasDouyinSession(cookie)) {
      throw new DouyinError(DOUYIN_ERRORS.AUTH, {
        messageKey: 'errors.douyinAuth',
        httpStatus: 400,
        details: {reason: 'missing_session'}
      });
    }
    this.cookie = cookie;
    this.user = null;
    this.qr = null;
    if (this.store) this.store.save({cookie, user: null, now: this.now()});
    return {loggedIn: true};
  }

  /**
   * Verify that a stored session is still accepted by the public site.
   * Only called on explicit request; never on every status poll.
   */
  async verify() {
    if (!this.loggedIn) return {valid: false, reason: 'no_session'};
    const response = await this.#request(`${this.homeUrl}/`);
    const text = await response.text();
    const loginFlag = text.match(/"user_is_login":\s*(\d+)/)?.[1]
      ?? text.match(/"isLogin":\s*(true|false)/)?.[1]
      ?? null;
    if (loginFlag === '1' || loginFlag === 'true') return {valid: true};
    if (loginFlag === '0' || loginFlag === 'false') {
      return {valid: false, reason: 'expired'};
    }
    return {valid: null, reason: 'unknown'};
  }

  async logout() {
    this.cookie = '';
    this.user = null;
    this.qr = null;
    this.lastBlocked = null;
    if (this.store) this.store.clear();
    this.logger?.info({event: 'douyin.login.logout'});
    return {loggedIn: false};
  }

  get loginState() {
    if (this.loggedIn) return 'logged_in';
    if (this.lastBlocked) return 'blocked';
    return 'anonymous';
  }
}

export const __internal = {QR_TTL_MS, POLL_INTERVAL_MS, statusFromData};
