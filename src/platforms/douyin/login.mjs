import {DOUYIN_UA} from './sign.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';
import {hasDouyinSession, parseCookiePairs, sanitizeDouyinCookie} from './cookie-store.mjs';

/**
 * Douyin account login for gift events.
 *
 * There are two supported ways to obtain a session, both explicit and local:
 *
 *   - Browser QR login (`browser-login.mjs`): the user scans the official QR in
 *     a real Chrome/Edge window. That module only calls the small API below.
 *   - Manual Cookie import: the user copies the Cookie value from their own
 *     browser. This module validates the shape and then asks Douyin whether the
 *     session is really accepted.
 *
 * A saved Cookie is not a successful login by itself. The states are distinct:
 * anonymous / saved_unverified / logged_in / expired / invalid. Verification
 * failures are classified instead of being collapsed into "login failed".
 *
 * The Cookie is never logged, never returned over HTTP and never written to a
 * backup. Only the encrypted per-user store holds it.
 */

export const LOGIN_STATES = Object.freeze({
  ANONYMOUS: 'anonymous',
  SAVED_UNVERIFIED: 'saved_unverified',
  LOGGED_IN: 'logged_in',
  EXPIRED: 'expired',
  INVALID: 'invalid'
});

export const VERIFY_URL = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383';
export const ACCOUNT_INFO_URL = 'https://www.douyin.com/passport/web/account/info/?aid=6383';

const VERIFY_TIMEOUT_MS = 15000;
const MAX_COOKIE_LENGTH = 32768;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function expiryFromCookie(pairs, now) {
  const raw = pairs.get('sid_guard');
  if (!raw) return null;
  const parts = String(raw).split('|');
  const candidate = Number(parts[1]);
  if (!Number.isFinite(candidate) || candidate <= 0) return null;
  const ms = candidate > 1e12 ? candidate : candidate * 1000;
  if (ms < 1e12 || ms > 1e14) return null;
  return {expiresAt: ms, expired: ms <= now};
}

function hasCompanionCookies(pairs) {
  for (const name of ['ttwid', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'odin_tt', 'sessionid_ss']) {
    if (pairs.has(name)) return true;
  }
  return false;
}

/**
 * Classify the pasted header before any network request.
 *
 * This is deliberately forgiving about the surrounding text (`Cookie:` prefix,
 * quotes) because ordinary users copy from DevTools, but it never invents a
 * session id or stores unknown cookie names.
 */
export function diagnoseCookie(header, {now = Date.now()} = {}) {
  let raw = String(header ?? '').trim();
  if (raw.toLowerCase().startsWith('cookie:')) raw = raw.slice(7).trim();
  raw = raw.replace(/^["']|["']$/g, '').trim();
  if (!raw) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_FORMAT,
      reason: 'empty',
      messageKey: 'errors.douyinCookieFormat'
    };
  }
  if (raw.length > MAX_COOKIE_LENGTH) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_FORMAT,
      reason: 'too_long',
      messageKey: 'errors.douyinCookieFormat'
    };
  }
  if (CONTROL_CHARS.test(raw)) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_FORMAT,
      reason: 'control_characters',
      messageKey: 'errors.douyinCookieFormat'
    };
  }
  const pairs = parseCookiePairs(raw);
  if (pairs.size === 0) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_FORMAT,
      reason: 'no_pairs',
      messageKey: 'errors.douyinCookieFormat'
    };
  }
  const cookie = sanitizeDouyinCookie(raw);
  if (!cookie) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_FORMAT,
      reason: 'no_supported_fields',
      messageKey: 'errors.douyinCookieFormat'
    };
  }
  const cleanPairs = parseCookiePairs(cookie);
  if (!hasDouyinSession(cookie)) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_INCOMPLETE,
      reason: 'missing_sessionid',
      messageKey: 'errors.douyinCookieIncomplete'
    };
  }
  const session = cleanPairs.get('sessionid') ?? cleanPairs.get('sessionid_ss') ?? '';
  if (session.length < 8) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.COOKIE_INCOMPLETE,
      reason: 'short_sessionid',
      messageKey: 'errors.douyinCookieIncomplete'
    };
  }
  const expiry = expiryFromCookie(cleanPairs, now);
  const warnings = [];
  if (!hasCompanionCookies(cleanPairs)) warnings.push('missing_companion_cookies');
  if (expiry?.expired) {
    return {
      ok: false,
      code: DOUYIN_ERRORS.LOGIN_EXPIRED,
      reason: 'cookie_expired',
      messageKey: 'errors.douyinLoginExpired',
      expiresAt: expiry.expiresAt
    };
  }
  return {
    ok: true,
    cookie,
    pairs: cleanPairs,
    warnings,
    expiresAt: expiry?.expiresAt ?? null
  };
}

function parseUser(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const user = data.user && typeof data.user === 'object' ? data.user : null;
  if (!user) return null;
  const name = String(user.nickname ?? '').trim().slice(0, 64);
  const uid = String(user.uid ?? user.user_id_str ?? '').trim().slice(0, 40);
  if (!name && !uid) return null;
  return {name: name || null, uid: uid || null};
}

/**
 * Ask Douyin whether a Cookie is currently accepted.
 *
 * `valid` / `invalid` are definitive answers from Douyin. `blocked`, `network`
 * and `unknown` mean the check could not be completed; the UI must not present
 * those as a successful login.
 */
export async function verifyCookie(header, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = VERIFY_TIMEOUT_MS,
  url = VERIFY_URL
} = {}) {
  const cookie = sanitizeDouyinCookie(header);
  if (!hasDouyinSession(cookie)) {
    return {status: 'invalid', reason: 'missing_session', user: null};
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': DOUYIN_UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: 'application/json, text/plain, */*',
        referer: 'https://www.douyin.com/',
        cookie
      }
    });
    const text = await response.text();
    const contentType = String(response.headers.get?.('content-type') ?? '');
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return {status: 'blocked', reason: `http_${response.status}`, user: null};
    }
    if (!response.ok) {
      return {status: response.status >= 500 ? 'network' : 'blocked', reason: `http_${response.status}`, user: null};
    }
    if (/html/i.test(contentType) || /^\s*</.test(text) || /安全风险|验证码|verify/i.test(text.slice(0, 400))) {
      return {status: 'blocked', reason: 'risk_control', user: null};
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return {status: 'unknown', reason: 'invalid_json', user: null};
    }
    const statusCode = Number(payload?.status_code);
    const errorCode = Number(payload?.error_code ?? payload?.data?.error_code);
    if (errorCode === 4031) return {status: 'blocked', reason: 'platform_denied', user: null};
    if (statusCode === 0) {
      const user = parseUser(payload);
      if (user) return {status: 'valid', reason: 'ok', user, checkedAt: now()};
      return {status: 'unknown', reason: 'no_user_payload', user: null};
    }
    if (statusCode === 8 || /未登录|请登录|not\s*login/i.test(String(payload?.status_msg ?? ''))) {
      return {status: 'invalid', reason: 'not_logged_in', user: null, checkedAt: now()};
    }
    if (Number.isFinite(errorCode) && errorCode !== 0) {
      return {status: 'blocked', reason: 'platform_denied', user: null};
    }
    return {status: 'unknown', reason: 'unexpected_payload', user: null};
  } catch (error) {
    return {
      status: 'network',
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      user: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export class DouyinLogin {
  constructor({
    store = null,
    fetchImpl = globalThis.fetch,
    logger = null,
    now = Date.now,
    timeoutMs = VERIFY_TIMEOUT_MS,
    verifyUrl = VERIFY_URL
  } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.verifyUrl = verifyUrl;
    const saved = store?.load();
    this.cookie = saved?.cookie ?? '';
    this.user = saved?.user ?? null;
    this.verified = saved?.verified ?? null;
    this.verifiedAt = saved?.verifiedAt ?? null;
    this.lastCheckedAt = null;
    this.lastVerifyReason = saved?.verified === false ? (saved.reason ?? 'invalid') : null;
    this.lastError = null;
  }

  get hasCookie() {
    return Boolean(this.cookie) && hasDouyinSession(this.cookie);
  }

  /** A cookie that is not known to be invalid may still be used for the WSS. */
  get sessionAvailable() {
    return this.hasCookie && this.verified !== false;
  }

  get loggedIn() {
    return this.hasCookie && this.verified === true;
  }

  get state() {
    if (!this.hasCookie) return LOGIN_STATES.ANONYMOUS;
    if (this.verified === true) return LOGIN_STATES.LOGGED_IN;
    if (this.verified === false) {
      return this.lastVerifyReason === 'expired' || this.lastVerifyReason === 'cookie_expired'
        ? LOGIN_STATES.EXPIRED
        : LOGIN_STATES.INVALID;
    }
    return LOGIN_STATES.SAVED_UNVERIFIED;
  }

  get loginState() {
    return this.state;
  }

  /** Safe to serialize. Never contains the cookie. */
  status() {
    return {
      loggedIn: this.loggedIn,
      state: this.state,
      verified: this.verified,
      sessionAvailable: this.sessionAvailable,
      user: this.user,
      cookiePresent: this.hasCookie,
      lastCheckedAt: this.lastCheckedAt,
      lastVerifyReason: this.lastVerifyReason,
      stored: this.store
        ? this.store.status()
        : {stored: false, user: null, savedAt: null, verified: null, verifiedAt: null}
    };
  }

  async #check(header) {
    return verifyCookie(header, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      timeoutMs: this.timeoutMs,
      url: this.verifyUrl
    });
  }

  #saveVerified(cookie, user) {
    const checkedAt = this.now();
    this.cookie = cookie;
    this.user = user ?? null;
    this.verified = true;
    this.verifiedAt = checkedAt;
    this.lastCheckedAt = checkedAt;
    this.lastVerifyReason = null;
    this.lastError = null;
    if (this.store) {
      this.store.save({
        cookie,
        user: this.user,
        verified: true,
        verifiedAt: checkedAt,
        reason: null,
        now: checkedAt
      });
    }
    this.logger?.info({event: 'douyin.login.verified', remembered: Boolean(this.store)});
  }

  #saveUnverified(cookie, reason) {
    const checkedAt = this.now();
    this.cookie = cookie;
    this.user = null;
    this.verified = null;
    this.verifiedAt = null;
    this.lastCheckedAt = checkedAt;
    this.lastVerifyReason = String(reason ?? 'inconclusive');
    this.lastError = {reason: this.lastVerifyReason, at: checkedAt};
    if (this.store) {
      this.store.save({
        cookie,
        user: null,
        verified: null,
        verifiedAt: null,
        reason: this.lastVerifyReason,
        now: checkedAt
      });
    }
    this.logger?.warn({event: 'douyin.login.saved_unverified', reason: this.lastVerifyReason});
  }

  #markInvalid(reason) {
    const checkedAt = this.now();
    this.verified = false;
    this.verifiedAt = null;
    this.lastCheckedAt = checkedAt;
    this.lastVerifyReason = String(reason ?? 'invalid');
    this.lastError = {reason: this.lastVerifyReason, at: checkedAt};
    if (this.store && this.cookie) {
      this.store.save({
        cookie: this.cookie,
        user: this.user,
        verified: false,
        verifiedAt: null,
        reason: this.lastVerifyReason,
        now: checkedAt
      });
    }
  }

  /**
   * Manual Cookie import. A valid session is saved only after Douyin confirms
   * it. An inconclusive check stores the Cookie as explicitly unverified; a
   * definitive "not logged in" answer is never presented as success.
   */
  async applyCookie(header) {
    const diagnosis = diagnoseCookie(header, {now: this.now()});
    if (!diagnosis.ok) {
      throw new DouyinError(diagnosis.code, {
        messageKey: diagnosis.messageKey,
        httpStatus: diagnosis.code === DOUYIN_ERRORS.LOGIN_EXPIRED ? 401 : 400,
        details: {reason: diagnosis.reason}
      });
    }
    const outcome = await this.#check(diagnosis.cookie);
    if (outcome.status === 'valid') {
      this.#saveVerified(diagnosis.cookie, outcome.user);
      return {
        ok: true,
        verified: true,
        savedUnverified: false,
        state: LOGIN_STATES.LOGGED_IN,
        reason: 'ok',
        status: this.status()
      };
    }
    if (outcome.status === 'invalid' || outcome.status === 'expired') {
      const reason = outcome.status === 'expired' ? 'expired' : 'not_logged_in';
      if (outcome.status === 'invalid' && diagnosis.warnings.includes('missing_companion_cookies')) {
        throw new DouyinError(DOUYIN_ERRORS.COOKIE_INCOMPLETE, {
          messageKey: 'errors.douyinCookieIncomplete',
          httpStatus: 400,
          details: {reason: 'missing_companion_cookies'}
        });
      }
      throw new DouyinError(
        outcome.status === 'expired' ? DOUYIN_ERRORS.LOGIN_EXPIRED : DOUYIN_ERRORS.AUTH,
        {
          messageKey: outcome.status === 'expired' ? 'errors.douyinLoginExpired' : 'errors.douyinAuth',
          httpStatus: 401,
          details: {reason}
        }
      );
    }
    this.#saveUnverified(diagnosis.cookie, outcome.status);
    return {
      ok: true,
      verified: false,
      savedUnverified: true,
      state: LOGIN_STATES.SAVED_UNVERIFIED,
      reason: outcome.status,
      warningKey: outcome.status === 'network'
        ? 'errors.douyinCookieNetwork'
        : outcome.status === 'blocked'
          ? 'errors.douyinCookiePlatformBlocked'
          : 'errors.douyinCookieUnverified',
      status: this.status()
    };
  }

  /**
   * Called by the browser login after Chrome has written the official session.
   * It follows the same verification policy as a manual import.
   */
  async saveBrowserCookie(header, {verifiedUser = null} = {}) {
    const diagnosis = diagnoseCookie(header, {now: this.now()});
    if (!diagnosis.ok) {
      return {ok: false, verified: false, savedUnverified: false, reason: diagnosis.reason};
    }
    if (verifiedUser?.name || verifiedUser?.uid) {
      this.#saveVerified(diagnosis.cookie, verifiedUser);
      return {ok: true, verified: true, savedUnverified: false, reason: 'ok', user: verifiedUser};
    }
    const outcome = await this.#check(diagnosis.cookie);
    if (outcome.status === 'valid') {
      this.#saveVerified(diagnosis.cookie, outcome.user);
      return {ok: true, verified: true, savedUnverified: false, reason: 'ok', user: outcome.user};
    }
    if (outcome.status === 'invalid' || outcome.status === 'expired') {
      return {
        ok: false,
        verified: false,
        savedUnverified: false,
        reason: outcome.status === 'expired' ? 'expired' : 'invalid'
      };
    }
    this.#saveUnverified(diagnosis.cookie, outcome.status);
    return {
      ok: true,
      verified: false,
      savedUnverified: true,
      reason: outcome.status
    };
  }

  /**
   * Re-check the stored session. Only an explicit user action triggers this;
   * status polling never performs network requests.
   */
  async checkStored() {
    if (!this.hasCookie) {
      return {state: LOGIN_STATES.ANONYMOUS, loggedIn: false, verified: null, reason: 'no_cookie'};
    }
    const outcome = await this.#check(this.cookie);
    if (outcome.status === 'valid') {
      this.#saveVerified(this.cookie, outcome.user);
      return {
        state: LOGIN_STATES.LOGGED_IN,
        loggedIn: true,
        verified: true,
        reason: 'ok',
        user: this.user,
        status: this.status()
      };
    }
    if (outcome.status === 'invalid' || outcome.status === 'expired') {
      this.#markInvalid(outcome.status === 'expired' ? 'expired' : 'not_logged_in');
      return {
        state: this.state,
        loggedIn: false,
        verified: false,
        reason: this.lastVerifyReason,
        status: this.status()
      };
    }
    this.lastCheckedAt = this.now();
    this.lastVerifyReason = outcome.status;
    return {
      state: this.state,
      loggedIn: this.loggedIn,
      verified: this.verified,
      reason: outcome.status,
      inconclusive: true,
      status: this.status()
    };
  }

  /** Backwards-friendly summary used by old callers/tests. */
  async verify() {
    const result = await this.checkStored();
    return {
      valid: result.state === LOGIN_STATES.LOGGED_IN ? true : result.inconclusive ? null : false,
      reason: result.reason,
      user: this.user,
      state: result.state
    };
  }

  sessionCookie() {
    return this.sessionAvailable ? this.cookie : '';
  }

  async logout() {
    this.cookie = '';
    this.user = null;
    this.verified = null;
    this.verifiedAt = null;
    this.lastCheckedAt = null;
    this.lastVerifyReason = null;
    this.lastError = null;
    if (this.store) this.store.clear();
    this.logger?.info({event: 'douyin.login.logout'});
    return {loggedIn: false, state: LOGIN_STATES.ANONYMOUS};
  }
}

export const __internal = {expiryFromCookie, hasCompanionCookies, parseUser, MAX_COOKIE_LENGTH};
