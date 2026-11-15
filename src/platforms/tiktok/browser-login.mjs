import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserSession, findBrowserExecutable, tiktokBrowserProfileDir, terminateOwnedBrowsers} from './browser-relay.mjs';
import {BROWSER_MARKER, ensureOwnedProfile} from './browser-launch.mjs';

/**
 * Browser-assisted TikTok login.
 *
 * TikTok's official login page offers QR-code login and phone/email/username
 * login in the user's own Chrome/Edge. LiveMemory does not generate a QR code,
 * does not solve a captcha and does not replay a password. It opens the official
 * page in the controlled profile, watches the official cookies/DOM for a real
 * login, and then verifies the live room separately.
 *
 * State split (important for honest UI):
 *   - `login` describes whether TikTok accepted a user session;
 *   - `capture` describes whether the live page actually delivered events.
 * "Logged in" is never shown as "chat capture works".
 *
 * Only the dedicated profile (`<data>/browser/tiktok/account`) is managed. No
 * user browser profile is read or removed, and no cookie/token is logged or
 * written to configuration.
 */

export const TIKTOK_LOGIN_PAGE = 'https://www.tiktok.com/login';

export const TIKTOK_LOGIN_STATES = Object.freeze({
  IDLE: 'idle',
  OPENING: 'opening',
  WAITING: 'waiting',
  VERIFYING: 'verifying',
  LOGGED_IN: 'logged_in',
  EXPIRED: 'expired',
  REFUSED: 'refused',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

const ACTIVE_STATES = new Set([
  TIKTOK_LOGIN_STATES.OPENING,
  TIKTOK_LOGIN_STATES.WAITING,
  TIKTOK_LOGIN_STATES.VERIFYING,
  TIKTOK_LOGIN_STATES.LOGGED_IN
]);

const SESSION_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt'];
const STATE_FILE = 'login-state.json';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function cookieExpired(cookie, now) {
  const expires = Number(cookie?.expires);
  return Number.isFinite(expires) && expires > 0 && expires * 1000 <= now;
}

function hasSessionCookie(cookies, now) {
  return (cookies ?? []).some((cookie) => SESSION_COOKIES.includes(String(cookie?.name ?? '').toLowerCase())
    && String(cookie?.value ?? '').length > 0
    && !cookieExpired(cookie, now));
}

export class TikTokBrowserLogin {
  constructor({
    dataDir = null,
    logger = null,
    now = Date.now,
    sessionFactory = null,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    env = process.env,
    browserPath = null,
    terminateBrowser = null,
    uniqueId = null,
    pollIntervalMs = 2000,
    loggedInPollIntervalMs = 5000,
    verifyTimeoutMs = 25000,
    sessionGraceMs = 15000,
    launchTimeoutMs = 25000
  } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.sessionFactory = sessionFactory;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.env = env;
    this.browserPath = browserPath ?? null;
    this.terminateBrowser = terminateBrowser ?? terminateOwnedBrowsers;
    this.uniqueId = uniqueId ? String(uniqueId).replace(/^@/, '') : null;
    this.pollIntervalMs = pollIntervalMs;
    this.loggedInPollIntervalMs = loggedInPollIntervalMs;
    this.verifyTimeoutMs = verifyTimeoutMs;
    this.sessionGraceMs = sessionGraceMs;
    this.launchTimeoutMs = launchTimeoutMs;
    this.profileDir = dataDir ? tiktokBrowserProfileDir(dataDir) : null;
    this.state = TIKTOK_LOGIN_STATES.IDLE;
    this.session = null;
    this.startPromise = null;
    this.pollTimer = null;
    this.startedAt = null;
    this.updatedAt = null;
    this.verifiedAt = null;
    this.lastCheckedAt = null;
    this.lastError = null;
    this.cookieNames = [];
    this.verifiedBy = null;
    this.capture = null;
    this.room = null;
    this.persisted = this.#loadPersisted();
    if (this.persisted?.state === TIKTOK_LOGIN_STATES.LOGGED_IN) {
      const profileReady = Boolean(this.profileDir && existsSync(join(this.profileDir, BROWSER_MARKER)));
      this.state = !profileReady || this.persisted.stale ? TIKTOK_LOGIN_STATES.EXPIRED : TIKTOK_LOGIN_STATES.LOGGED_IN;
      this.verifiedAt = this.persisted.verifiedAt ?? null;
      this.verifiedBy = this.persisted.verifiedBy ?? null;
      this.updatedAt = this.persisted.at ?? null;
    } else if (this.persisted?.state === TIKTOK_LOGIN_STATES.EXPIRED) {
      this.state = TIKTOK_LOGIN_STATES.EXPIRED;
      this.updatedAt = this.persisted.at ?? null;
    }
  }

  #statePath() {
    return this.dataDir ? join(this.dataDir, 'browser', 'tiktok', STATE_FILE) : null;
  }

  #loadPersisted() {
    try {
      const path = this.#statePath();
      if (!path || !existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (!data || typeof data !== 'object') return null;
      const at = Number(data.at) || null;
      const stale = !at || this.now() - at > STALE_AFTER_MS;
      return {
        state: String(data.state ?? ''),
        at,
        verifiedAt: Number(data.verifiedAt) || null,
        verifiedBy: data.verifiedBy ? String(data.verifiedBy) : null,
        uniqueId: data.uniqueId ? String(data.uniqueId) : null,
        stale
      };
    } catch {
      return null;
    }
  }

  #savePersisted(extra = {}) {
    try {
      if (!this.dataDir) return;
      const dir = join(this.dataDir, 'browser', 'tiktok');
      ensureOwnedProfile(this.profileDir);
      writeFileSync(this.#statePath(), JSON.stringify({
        state: this.state,
        at: this.updatedAt ?? this.now(),
        verifiedAt: this.verifiedAt,
        verifiedBy: this.verifiedBy,
        uniqueId: this.room?.uniqueId ?? this.uniqueId ?? null,
        ...extra
      }), {mode: 0o600});
    } catch {
      /* state persistence is best effort; it contains no credentials */
    }
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.updatedAt = this.now();
    if (extra.error !== undefined) this.lastError = extra.error;
    if (extra.verifiedBy !== undefined) this.verifiedBy = extra.verifiedBy;
    if (extra.sessionOpen !== undefined) this.sessionOpen = extra.sessionOpen;
    this.logger?.info({
      event: 'tiktok.login.state',
      state,
      browserOpen: Boolean(this.session?.isAlive?.()),
      cookieNames: this.cookieNames,
      reason: extra.reason ?? null
    });
    if ([TIKTOK_LOGIN_STATES.LOGGED_IN, TIKTOK_LOGIN_STATES.EXPIRED, TIKTOK_LOGIN_STATES.REFUSED].includes(state)) {
      this.#savePersisted();
    }
  }

  status() {
    const browserOpen = Boolean(this.session?.isAlive?.());
    const browser = this.browserPath ?? findBrowserExecutable({env: this.env});
    return {
      state: this.state,
      browserOpen,
      supported: Boolean(this.profileDir && browser),
      profile: this.profileDir ? {
        owned: existsSync(join(this.profileDir, BROWSER_MARKER)),
        path: this.profileDir
      } : null,
      uniqueId: this.room?.uniqueId ?? this.uniqueId ?? null,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      lastCheckedAt: this.lastCheckedAt,
      verifiedAt: this.verifiedAt,
      verifiedBy: this.verifiedBy,
      cookieNames: [...this.cookieNames],
      error: this.lastError,
      capture: this.capture,
      room: this.room
    };
  }

  #focus() {
    try {
      this.session?.cdp?.send('Page.bringToFront', {}, {timeoutMs: 2000}).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async start({uniqueId = null} = {}) {
    if (uniqueId) this.uniqueId = String(uniqueId).replace(/^@/, '');
    if (this.uniqueId) this.#savePersisted({uniqueId: this.uniqueId});
    if (this.startPromise) {
      this.#focus();
      return this.status();
    }
    if (ACTIVE_STATES.has(this.state) && this.session?.isAlive?.()) {
      this.#focus();
      return this.status();
    }
    this.startPromise = this.#startOnce();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startOnce() {
    if (!this.dataDir || !this.profileDir) {
      this.#setState(TIKTOK_LOGIN_STATES.UNAVAILABLE, {
        error: {code: 'TIKTOK_BROWSER_UNAVAILABLE', reason: 'no_data_dir'}
      });
      return this.status();
    }
    if (!findBrowserExecutable({env: this.env}) && !this.browserPath) {
      this.#setState(TIKTOK_LOGIN_STATES.UNAVAILABLE, {
        error: {code: 'TIKTOK_BROWSER_UNAVAILABLE', reason: 'browser_not_found'}
      });
      return this.status();
    }
    this.#setState(TIKTOK_LOGIN_STATES.OPENING);
    this.startedAt = this.now();
    const session = this.#createSession();
    this.session = session;
    try {
      await session.launch();
    } catch (error) {
      this.session = null;
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      this.#setState(TIKTOK_LOGIN_STATES.ERROR, {
        error: {code: error?.code ?? 'TIKTOK_BROWSER_FAILED', reason: error?.details?.reason ?? error?.reason ?? 'launch_failed'}
      });
      return this.status();
    }
    this.#setState(TIKTOK_LOGIN_STATES.WAITING);
    session.onClose = () => this.#onBrowserClosed();
    this.#startPolling();
    return this.status();
  }

  #createSession() {
    if (this.sessionFactory) {
      const session = this.sessionFactory({
        uniqueId: this.uniqueId,
        roomId: null,
        liveUrl: TIKTOK_LOGIN_PAGE,
        dataDir: this.dataDir,
        logger: this.logger,
        now: this.now,
        env: this.env,
        WebSocketImpl: this.WebSocketImpl
      });
      session.onClose = () => this.#onBrowserClosed();
      return session;
    }
    return new BrowserSession({
      uniqueId: this.uniqueId,
      roomId: null,
      liveUrl: TIKTOK_LOGIN_PAGE,
      dataDir: this.dataDir,
      logger: this.logger,
      now: this.now,
      env: this.env,
      WebSocketImpl: this.WebSocketImpl,
      launchTimeoutMs: this.launchTimeoutMs
    });
  }

  #onBrowserClosed() {
    if (this.state === TIKTOK_LOGIN_STATES.OPENING) return;
    this.logger?.info({event: 'tiktok.login.browser_closed', state: this.state});
    this.#stopPolling();
    if (this.state === TIKTOK_LOGIN_STATES.WAITING || this.state === TIKTOK_LOGIN_STATES.VERIFYING) {
      this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'browser_closed'});
    }
    // A persisted logged-in profile stays "logged in" without an open window;
    // the UI shows the status and can reopen the browser later.
  }

  #startPolling() {
    this.#stopPolling();
    const tick = async () => {
      if (!this.session?.isAlive?.()) return;
      await this.#checkLogin();
      if (!this.session?.isAlive?.()) return;
      const delay = this.state === TIKTOK_LOGIN_STATES.LOGGED_IN ? this.loggedInPollIntervalMs : this.pollIntervalMs;
      this.pollTimer = setTimeout(tick, delay);
      this.pollTimer.unref?.();
    };
    this.pollTimer = setTimeout(tick, 300);
    this.pollTimer.unref?.();
  }

  #stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async checkNow() {
    await this.#checkLogin();
    return this.status();
  }

  async #checkLogin() {
    if (!this.session?.getCookies) return;
    this.lastCheckedAt = this.now();
    let cookies = [];
    try {
      cookies = await this.session.getCookies();
    } catch {
      return;
    }
    const sessionCookies = (cookies ?? []).filter((cookie) => SESSION_COOKIES.includes(String(cookie?.name ?? '').toLowerCase()));
    this.cookieNames = sessionCookies.map((cookie) => String(cookie.name)).sort();
    if (sessionCookies.length === 0) {
      if (this.state === TIKTOK_LOGIN_STATES.LOGGED_IN) {
        this.#setState(TIKTOK_LOGIN_STATES.EXPIRED, {reason: 'session_cookie_removed'});
      } else if (this.state !== TIKTOK_LOGIN_STATES.WAITING) {
        this.#setState(TIKTOK_LOGIN_STATES.WAITING);
      }
      return;
    }
    if (!hasSessionCookie(cookies, this.now())) {
      if (this.state !== TIKTOK_LOGIN_STATES.EXPIRED) {
        this.#setState(TIKTOK_LOGIN_STATES.EXPIRED, {reason: 'session_cookie_expired'});
      }
      return;
    }
    if (this.state === TIKTOK_LOGIN_STATES.WAITING) {
      this.#setState(TIKTOK_LOGIN_STATES.VERIFYING, {reason: 'session_cookie_found'});
      await this.#verifyCookie();
    }
  }

  async #verifyCookie() {
    const dom = await this.session?.evaluate?.(`(() => {
      const text = (document.body && document.body.innerText) || '';
      return {
        url: location.href,
        title: document.title,
        hasProfileLink: Boolean(document.querySelector('a[href*="/@"]')),
        hasLoginLink: Boolean(document.querySelector('a[href*="/login"]')),
        loginText: /log in|ログイン|登录/i.test(text)
      };
    })()`) ?? null;
    if (dom?.hasLoginLink && !dom.hasProfileLink) {
      // The cookie exists but the page still presents the login entry: keep
      // waiting rather than claiming a login the page itself does not show.
      this.#setState(TIKTOK_LOGIN_STATES.WAITING, {reason: 'page_still_shows_login'});
      return;
    }
    this.verifiedAt = this.now();
    this.verifiedBy = dom?.hasProfileLink ? 'page_profile' : 'session_cookie';
    this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: this.verifiedBy});
  }

  async verify({uniqueId = null, timeoutMs = this.verifyTimeoutMs} = {}) {
    if (uniqueId) this.uniqueId = String(uniqueId).replace(/^@/, '');
    if (!this.session?.isAlive?.()) {
      const started = await this.start({uniqueId: this.uniqueId});
      if (!started || ![TIKTOK_LOGIN_STATES.WAITING, TIKTOK_LOGIN_STATES.LOGGED_IN, TIKTOK_LOGIN_STATES.VERIFYING].includes(this.state)) {
        return this.status();
      }
    }
    if (!this.uniqueId) {
      this.#setState(TIKTOK_LOGIN_STATES.ERROR, {
        error: {code: 'TIKTOK_LOGIN_VERIFY_NO_ROOM', reason: 'unique_id_required'}
      });
      return this.status();
    }
    this.#setState(TIKTOK_LOGIN_STATES.VERIFYING, {reason: 'verify_room'});
    const liveUrl = `https://www.tiktok.com/@${this.uniqueId}/live`;
    try {
      await this.session.navigate(liveUrl);
    } catch (error) {
      this.#setState(TIKTOK_LOGIN_STATES.ERROR, {
        error: {code: 'TIKTOK_BROWSER_FAILED', reason: error?.message ?? 'navigate_failed'}
      });
      return this.status();
    }
    const ready = this.session.waitForReady
      ? await this.session.waitForReady({timeoutMs})
      : {loginRequired: this.session.requiresLogin?.(), events: 0, roomEnterStatus: null, closed: false};
    const cookies = await this.session.getCookies?.() ?? [];
    const hasCookie = hasSessionCookie(cookies, this.now());
    this.lastCheckedAt = this.now();
    this.room = {
      uniqueId: this.uniqueId,
      roomEnterStatus: ready.roomEnterStatus ?? this.session.roomEnterStatus ?? null,
      eventsReceived: Number(ready.events ?? 0),
      checkedAt: this.now(),
      liveUrl
    };
    if (ready.closed) {
      this.#setState(TIKTOK_LOGIN_STATES.ERROR, {
        error: {code: 'TIKTOK_BROWSER_FAILED', reason: 'browser_closed'}
      });
      this.capture = {state: 'error', eventsReceived: 0, checkedAt: this.now()};
      return this.status();
    }
    if (!hasCookie) {
      this.#setState(TIKTOK_LOGIN_STATES.EXPIRED, {reason: 'no_valid_session_cookie'});
      this.capture = {state: 'login_required', eventsReceived: 0, checkedAt: this.now()};
      return this.status();
    }
    if (ready.loginRequired || this.room.roomEnterStatus === 403) {
      // A valid cookie plus a 403 from the official room-entry endpoint is the
      // platform refusing this browser, not a login success and not a reason
      // to forge frames.
      this.#setState(TIKTOK_LOGIN_STATES.REFUSED, {reason: 'room_enter_403'});
      this.capture = {state: 'platform_refused', eventsReceived: 0, checkedAt: this.now()};
      return this.status();
    }
    this.verifiedAt = this.now();
    this.verifiedBy = 'live_room';
    this.capture = {
      state: this.room.eventsReceived > 0 ? 'events_received' : 'connected_no_events',
      eventsReceived: this.room.eventsReceived,
      roomEnterStatus: this.room.roomEnterStatus,
      checkedAt: this.now()
    };
    this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: 'live_room'});
    return this.status();
  }

  async cancel() {
    this.#stopPolling();
    await this.#closeBrowser();
    this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'cancelled'});
    this.room = null;
    this.capture = null;
    return this.status();
  }

  async closeBrowser() {
    this.#stopPolling();
    await this.#closeBrowser();
    // Keep the persisted login state: closing the window is not a logout.
    if (this.state === TIKTOK_LOGIN_STATES.WAITING || this.state === TIKTOK_LOGIN_STATES.VERIFYING) {
      this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'browser_closed'});
    }
    return this.status();
  }

  async logout() {
    this.#stopPolling();
    await this.#closeBrowser();
    this.#clearProfile();
    this.persisted = null;
    this.verifiedAt = null;
    this.verifiedBy = null;
    this.room = null;
    this.capture = null;
    this.cookieNames = [];
    this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'logged_out'});
    return this.status();
  }

  async shutdown() {
    this.#stopPolling();
    await this.#closeBrowser();
  }

  async #closeBrowser() {
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    if (this.profileDir) {
      // The profile belongs to LiveMemory; closing its browser cannot affect
      // the user's daily Chrome/Edge windows because the command line must
      // contain this exact profile path.
      await this.terminateBrowser({profileDir: this.profileDir, env: this.env});
    }
  }

  #clearProfile() {
    try {
      const statePath = this.#statePath();
      if (statePath) rmSync(statePath, {force: true});
    } catch {
      /* ignore */
    }
    if (!this.profileDir) return {removed: false, reason: 'no_profile'};
    try {
      if (!existsSync(this.profileDir)) return {removed: false, reason: 'missing'};
      const marker = join(this.profileDir, BROWSER_MARKER);
      if (!existsSync(marker)) return {removed: false, reason: 'not_owned'};
      rmSync(this.profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      return {removed: true, reason: null};
    } catch {
      return {removed: false, reason: 'locked'};
    }
  }
}

export const __internal = {SESSION_COOKIES, hasSessionCookie, cookieExpired, STALE_AFTER_MS};
