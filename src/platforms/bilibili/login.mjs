import {BilibiliApi, BilibiliError} from './api.mjs';
import {extractLoginCookies, hasSessionCookie} from './cookie-store.mjs';

/**
 * Bilibili QR login for the broadcaster's own account.
 *
 * The QR flow is the one the reference project already used:
 *   GET passport-login/web/qrcode/generate -> {url, qrcode_key}
 *   GET passport-login/web/qrcode/poll?qrcode_key=…
 *     0     success (cookies in Set-Cookie and in the redirect URL)
 *     86101 waiting for the scan
 *     86090 scanned, waiting for confirmation on the phone
 *     86038 expired
 *
 * Watching a public live room does not require this login. It is optional and
 * only improves what the platform will return for the broadcaster's account.
 */

export const QR_STATE = Object.freeze({
  IDLE: 'idle',
  WAITING: 'waiting',
  SCANNED: 'scanned',
  EXPIRED: 'expired',
  SUCCESS: 'success',
  ERROR: 'error'
});

const POLL_CODES = new Map([
  [0, QR_STATE.SUCCESS],
  [86101, QR_STATE.WAITING],
  [86090, QR_STATE.SCANNED],
  [86038, QR_STATE.EXPIRED]
]);

export function pollState(code) {
  return POLL_CODES.get(Number(code)) ?? QR_STATE.ERROR;
}

export class BilibiliLogin {
  constructor({store = null, api = null, logger = null, now = Date.now} = {}) {
    this.store = store;
    this.api = api ?? new BilibiliApi({now});
    this.logger = logger;
    this.now = now;
    this.user = null;
    this.qr = null;
    this.remember = true;
    if (store) {
      const saved = store.load();
      if (saved?.cookie) {
        this.api.setCookie(saved.cookie);
        this.user = saved.uid ? {uid: saved.uid, name: saved.name ?? '', face: null} : null;
        this.logger?.info({event: 'bilibili.login.restored'});
      }
    }
  }

  get loggedIn() {
    return hasSessionCookie(this.api.cookie);
  }

  /** Safe to serialize: never contains the cookie. */
  status() {
    return {
      loggedIn: this.loggedIn,
      user: this.user,
      qr: this.qr ? {state: this.qr.state, expiresAt: this.qr.expiresAt} : null,
      stored: this.store ? this.store.status() : {stored: false, uid: null, name: null, savedAt: null}
    };
  }

  async refreshUser() {
    if (!this.loggedIn) {
      this.user = null;
      return null;
    }
    try {
      this.user = await this.api.navUser();
      return this.user;
    } catch (error) {
      this.logger?.warn({event: 'bilibili.login.refresh.failed', code: error?.code ?? 'unknown'});
      return this.user;
    }
  }

  async startQr({remember = true} = {}) {
    this.remember = remember !== false;
    const generated = await this.api.qrGenerate();
    this.qr = {
      ...generated,
      createdAt: this.now(),
      expiresAt: this.now() + generated.expiresInMs,
      state: QR_STATE.WAITING
    };
    this.logger?.info({event: 'bilibili.login.qr', expiresInMs: generated.expiresInMs});
    // The QR image URL is safe to show; the key is only used for polling and is
    // not written to the log.
    return {url: this.qr.url, expiresAt: this.qr.expiresAt, state: this.qr.state};
  }

  async pollQr() {
    if (!this.qr) throw new BilibiliError('QR_MISSING', 'start the QR login first');
    if (this.now() > this.qr.expiresAt) {
      this.qr.state = QR_STATE.EXPIRED;
      return {state: QR_STATE.EXPIRED, user: null};
    }
    const result = await this.api.qrPoll(this.qr.key);
    const state = pollState(result.code);
    this.qr.state = state;
    if (state !== QR_STATE.SUCCESS) {
      return {state, user: null};
    }
    const cookie = extractLoginCookies({setCookies: result.setCookies, url: result.url});
    if (!hasSessionCookie(cookie)) {
      throw new BilibiliError('AUTH', 'the login reply did not contain a session cookie');
    }
    this.api.setCookie(cookie);
    const user = await this.api.navUser();
    this.user = user;
    this.qr = null;
    if (this.remember && this.store) {
      this.store.save({cookie, uid: user?.uid ?? null, name: user?.name ?? null, now: this.now()});
    }
    this.logger?.info({event: 'bilibili.login.success', uid: user?.uid ?? null, remembered: Boolean(this.remember && this.store)});
    return {state: QR_STATE.SUCCESS, user};
  }

  async logout() {
    this.api.setCookie('');
    this.user = null;
    this.qr = null;
    if (this.store) this.store.clear();
    this.logger?.info({event: 'bilibili.login.logout'});
    return {loggedIn: false};
  }

  /** Explicit cookie injection (tests and the "paste a cookie" escape hatch). */
  async applyCookie(cookie, {remember = true} = {}) {
    if (!hasSessionCookie(cookie)) throw new BilibiliError('AUTH', 'the cookie has no SESSDATA');
    this.api.setCookie(cookie);
    const user = await this.api.navUser();
    this.user = user;
    this.remember = remember !== false;
    if (this.remember && this.store) {
      this.store.save({cookie, uid: user?.uid ?? null, name: user?.name ?? null, now: this.now()});
    }
    return {user};
  }
}

export const __internal = {POLL_CODES};
