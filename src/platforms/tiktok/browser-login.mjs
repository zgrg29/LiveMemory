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
    isCaptureActive = null,
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
    this.isCaptureActive = typeof isCaptureActive === 'function' ? isCaptureActive : () => false;
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
    this.roomAccess = {state: 'unknown', status: null, at: null};
    this.loginWindowClosedAt = null;
    this.restoredFromDisk = false;
    this.revalidationRequired = false;
    this.persisted = this.#loadPersisted();
    if (this.persisted?.state === TIKTOK_LOGIN_STATES.LOGGED_IN) {
      const profileReady = Boolean(this.profileDir && existsSync(join(this.profileDir, BROWSER_MARKER)));
      this.state = !profileReady || this.persisted.stale ? TIKTOK_LOGIN_STATES.EXPIRED : TIKTOK_LOGIN_STATES.LOGGED_IN;
      this.verifiedAt = this.persisted.verifiedAt ?? null;
      this.verifiedBy = this.persisted.verifiedBy ?? null;
      this.updatedAt = this.persisted.at ?? null;
      this.restoredFromDisk = this.state === TIKTOK_LOGIN_STATES.LOGGED_IN;
      // The marker is not proof that the cookie still works. The next capture
      // or explicit verification has to confirm it against TikTok.
      this.revalidationRequired = this.restoredFromDisk;
    } else if (this.persisted?.state === TIKTOK_LOGIN_STATES.EXPIRED) {
      this.state = TIKTOK_LOGIN_STATES.EXPIRED;
      this.updatedAt = this.persisted.at ?? null;
    }
  }

  setCaptureActiveProvider(fn) {
    if (typeof fn === 'function') this.isCaptureActive = fn;
  }

  #captureActive() {
    try {
      return Boolean(this.isCaptureActive?.());
    } catch {
      return false;
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
      room: this.room,
      roomAccess: {...this.roomAccess},
      loginWindowClosedAt: this.loginWindowClosedAt,
      restoredFromDisk: this.restoredFromDisk,
      revalidationRequired: this.revalidationRequired,
      captureActive: this.#captureActive()
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
    this.loginWindowClosedAt = this.now();
    if (this.state === TIKTOK_LOGIN_STATES.WAITING || this.state === TIKTOK_LOGIN_STATES.VERIFYING) {
      const profileReady = Boolean(this.profileDir && existsSync(join(this.profileDir, BROWSER_MARKER)));
      const persistedLoggedIn = this.persisted?.state === TIKTOK_LOGIN_STATES.LOGGED_IN && profileReady && !this.persisted.stale;
      this.#setState(persistedLoggedIn ? TIKTOK_LOGIN_STATES.LOGGED_IN : TIKTOK_LOGIN_STATES.IDLE, {reason: 'browser_closed'});
      if (persistedLoggedIn) this.revalidationRequired = true;
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
    if (this.state === TIKTOK_LOGIN_STATES.WAITING || this.state === TIKTOK_LOGIN_STATES.EXPIRED || this.state === TIKTOK_LOGIN_STATES.REFUSED) {
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
    this.revalidationRequired = false;
    this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: this.verifiedBy});
  }

  async verify({uniqueId = null, timeoutMs = this.verifyTimeoutMs} = {}) {
    if (uniqueId) this.uniqueId = String(uniqueId).replace(/^@/, '');
    this.capture = null;
    if (!this.session?.isAlive?.()) {
      const started = await this.start({uniqueId: this.uniqueId});
      if (!started || ![TIKTOK_LOGIN_STATES.WAITING, TIKTOK_LOGIN_STATES.LOGGED_IN, TIKTOK_LOGIN_STATES.VERIFYING].includes(this.state)) {
        this.capture = {
          state: 'error',
          reason: started?.error?.reason ?? 'browser_launch_failed',
          eventsReceived: 0,
          uniqueId: this.uniqueId ?? null,
          checkedAt: this.now()
        };
        return this.status();
      }
    }
    if (!this.uniqueId) {
      // A missing room is a missing input, not a broken login window. Do not
      // poison the login state with `error`; report exactly what is missing.
      this.capture = {
        state: 'needs_room',
        reason: 'unique_id_required',
        eventsReceived: 0,
        roomEnterStatus: null,
        uniqueId: null,
        checkedAt: this.now()
      };
      return this.status();
    }
    this.#setState(TIKTOK_LOGIN_STATES.VERIFYING, {reason: 'verify_room'});
    const liveUrl = `https://www.tiktok.com/@${this.uniqueId}/live`;
    try {
      await this.session.navigate(liveUrl);
    } catch (error) {
      this.lastError = {code: 'TIKTOK_BROWSER_FAILED', reason: error?.message ?? 'navigate_failed'};
      this.capture = {
        state: 'error',
        reason: 'navigate_failed',
        eventsReceived: 0,
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      if (this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
        this.#setState(TIKTOK_LOGIN_STATES.ERROR, {error: this.lastError});
      }
      return this.status();
    }
    const ready = this.session.waitForReady
      ? await this.session.waitForReady({timeoutMs})
      : {
        loginRequired: this.session.requiresLogin?.(),
        roomRefused: this.session.roomAccessRefused?.(),
        events: 0,
        roomEnterStatus: this.session.roomEnterStatus ?? null,
        closed: false
      };
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
    this.roomAccess = {
      state: this.room.roomEnterStatus === 200
        ? 'ok'
        : (this.room.roomEnterStatus === 403 ? 'refused' : 'unknown'),
      status: this.room.roomEnterStatus,
      at: this.now()
    };
    if (ready.closed) {
      this.capture = {
        state: 'error',
        reason: 'browser_closed',
        eventsReceived: 0,
        roomEnterStatus: this.room.roomEnterStatus,
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      return this.status();
    }
    if (!hasCookie || ready.loginRequired) {
      // The browser page itself lost the login. This is the only path that
      // changes the account state; a room-entry 403 does not.
      this.#setState(TIKTOK_LOGIN_STATES.EXPIRED, {reason: hasCookie ? 'login_required' : 'no_valid_session_cookie'});
      this.capture = {
        state: 'login_required',
        reason: hasCookie ? 'login_required' : 'no_session_cookie',
        eventsReceived: 0,
        roomEnterStatus: this.room.roomEnterStatus,
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      return this.status();
    }
    const eventsReceived = Number(this.room.eventsReceived ?? 0);
    if (eventsReceived > 0) {
      // Real frames beat a room-entry 403: the event socket is working.
      this.verifiedAt = this.now();
      this.verifiedBy = 'live_room';
      this.revalidationRequired = false;
      this.capture = {
        state: 'events_received',
        reason: 'events_received',
        eventsReceived,
        roomEnterStatus: this.room.roomEnterStatus,
        roomAccess: {...this.roomAccess},
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: 'live_room', reason: 'events_received'});
      return this.status();
    }
    if (ready.roomRefused || this.room.roomEnterStatus === 403) {
      // The account can still be logged in while TikTok refuses this room.
      // Report the room refusal separately; never turn it into "login expired".
      this.capture = {
        state: 'platform_refused',
        reason: 'room_enter_403',
        eventsReceived: 0,
        roomEnterStatus: this.room.roomEnterStatus ?? 403,
        roomAccess: {...this.roomAccess},
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'room_access_refused'});
      return this.status();
    }
    if (this.room.roomEnterStatus === 200) {
      this.verifiedAt = this.now();
      this.verifiedBy = 'live_room';
      this.revalidationRequired = false;
      this.capture = {
        state: 'connected_no_events',
        reason: ready.timedOut ? 'no_events_timeout' : 'connected_no_events',
        eventsReceived: 0,
        roomEnterStatus: 200,
        roomAccess: {...this.roomAccess},
        timedOut: Boolean(ready.timedOut),
        uniqueId: this.uniqueId,
        liveUrl,
        checkedAt: this.now()
      };
      this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: 'live_room'});
      return this.status();
    }
    // The page opened but neither a room-entry confirmation nor an event was
    // observed. Do not claim a working connection.
    this.capture = {
      state: 'room_unconfirmed',
      reason: ready.timedOut ? 'room_not_confirmed_timeout' : 'room_not_confirmed',
      eventsReceived: 0,
      roomEnterStatus: this.room.roomEnterStatus,
      roomAccess: {...this.roomAccess},
      timedOut: Boolean(ready.timedOut),
      uniqueId: this.uniqueId,
      liveUrl,
      checkedAt: this.now()
    };
    this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'room_not_confirmed'});
    return this.status();
  }

  /**
   * Mirror evidence from the capture adapter back into the login badge.
   * Called by TikTokService after the relay really opened the live page.
   */
  markCaptureVerified({eventsReceived = 0, roomEnterStatus = null, uniqueId = null, liveUrl = null, roomAccess = null} = {}) {
    const count = Number(eventsReceived) || 0;
    this.verifiedAt = this.now();
    this.verifiedBy = 'live_room';
    this.revalidationRequired = false;
    this.roomAccess = roomAccess ?? {
      state: roomEnterStatus === 200 ? 'ok' : (roomEnterStatus === 403 ? 'refused' : 'unknown'),
      status: roomEnterStatus ?? null,
      at: this.now()
    };
    this.capture = {
      state: count > 0 ? 'events_received' : 'connected_no_events',
      reason: count > 0 ? 'events_received' : (roomEnterStatus === 200 ? 'connected_no_events' : 'capture_started'),
      eventsReceived: count,
      roomEnterStatus: roomEnterStatus ?? null,
      roomAccess: {...this.roomAccess},
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      liveUrl,
      checkedAt: this.now()
    };
    this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {verifiedBy: 'live_room', reason: 'capture_verified'});
    return this.status();
  }

  /**
   * The page opened and the account is still valid, but no room-entry response
   * or event was observed. This is explicitly not a success.
   */
  markCaptureUnconfirmed({reason = 'room_not_confirmed', uniqueId = null, liveUrl = null, roomEnterStatus = null} = {}) {
    this.roomAccess = {
      state: roomEnterStatus === 200 ? 'ok' : (roomEnterStatus === 403 ? 'refused' : 'unknown'),
      status: roomEnterStatus ?? null,
      at: this.now()
    };
    this.capture = {
      state: 'room_unconfirmed',
      reason,
      eventsReceived: 0,
      roomEnterStatus: roomEnterStatus ?? null,
      roomAccess: {...this.roomAccess},
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      liveUrl,
      checkedAt: this.now()
    };
    if (this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
      this.revalidationRequired = true;
    }
    return this.status();
  }

  /**
   * The official page refused this room (HTTP 403 on room entry) and no event
   * socket frame arrived. The account session can still be valid: do not
   * overwrite it with "refused"/"expired".
   */
  markCaptureRefused({reason = 'room_enter_403', roomEnterStatus = 403, uniqueId = null, liveUrl = null} = {}) {
    this.roomAccess = {state: 'refused', status: roomEnterStatus, at: this.now()};
    this.capture = {
      state: 'platform_refused',
      reason,
      eventsReceived: 0,
      roomEnterStatus,
      roomAccess: {...this.roomAccess},
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      liveUrl,
      checkedAt: this.now()
    };
    if (this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
      // Do not turn a room denial into a login success. The login badge keeps
      // whatever the cookie/page check established.
      this.revalidationRequired = true;
    }
    return this.status();
  }

  /** The browser page itself requires a login again (cookie gone/invalid). */
  markCaptureLoginRequired({reason = 'login_required', roomEnterStatus = null, uniqueId = null} = {}) {
    this.revalidationRequired = true;
    this.capture = {
      state: 'login_required',
      reason,
      eventsReceived: 0,
      roomEnterStatus,
      roomAccess: {state: 'unknown', status: roomEnterStatus ?? null, at: this.now()},
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      checkedAt: this.now()
    };
    this.#setState(TIKTOK_LOGIN_STATES.EXPIRED, {reason});
    return this.status();
  }

  /** The user stopped the recording; keep the login evidence, update capture. */
  markCaptureStopped({reason = 'user', uniqueId = null} = {}) {
    this.capture = {
      state: 'stopped',
      reason,
      eventsReceived: 0,
      roomEnterStatus: null,
      roomAccess: {...this.roomAccess},
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      checkedAt: this.now()
    };
    return this.status();
  }

  /** Browser launch/target failure: keep the login identity but record why. */
  markCaptureFailed({reason = 'browser_failed', uniqueId = null} = {}) {
    this.lastError = {code: 'TIKTOK_BROWSER_FAILED', reason};
    this.capture = {
      state: 'error',
      reason,
      eventsReceived: 0,
      roomEnterStatus: null,
      uniqueId: uniqueId ?? this.uniqueId ?? null,
      checkedAt: this.now()
    };
    if (this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
      this.#setState(TIKTOK_LOGIN_STATES.ERROR, {error: this.lastError});
    }
    return this.status();
  }

  async cancel() {
    this.#stopPolling();
    const captureActive = this.#captureActive();
    const wasLoggedIn = this.state === TIKTOK_LOGIN_STATES.LOGGED_IN;
    await this.#closeBrowser({keepOwnedBrowser: captureActive});
    this.loginWindowClosedAt = this.now();
    if (captureActive) {
      // The capture adapter still owns a tab in the same dedicated browser.
      // Closing the login page must not terminate that browser.
      if (wasLoggedIn && this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
        this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'login_window_closed_capture_active'});
      }
      return this.status();
    }
    if (wasLoggedIn) {
      this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'browser_closed'});
      this.revalidationRequired = true;
    } else {
      this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'cancelled'});
      this.room = null;
      this.capture = null;
    }
    return this.status();
  }

  async closeBrowser() {
    this.#stopPolling();
    const captureActive = this.#captureActive();
    const wasLoggedIn = this.state === TIKTOK_LOGIN_STATES.LOGGED_IN;
    await this.#closeBrowser({keepOwnedBrowser: captureActive});
    this.loginWindowClosedAt = this.now();
    // Keep the persisted login state: closing the window is not a logout.
    if (captureActive) {
      if (wasLoggedIn && this.state !== TIKTOK_LOGIN_STATES.LOGGED_IN) {
        this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'login_window_closed_capture_active'});
      }
    } else if (wasLoggedIn) {
      this.#setState(TIKTOK_LOGIN_STATES.LOGGED_IN, {reason: 'browser_closed'});
      this.revalidationRequired = true;
    } else if (this.state === TIKTOK_LOGIN_STATES.WAITING || this.state === TIKTOK_LOGIN_STATES.VERIFYING) {
      this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'browser_closed'});
    }
    return this.status();
  }

  async logout() {
    if (this.#captureActive()) {
      // Removing the dedicated profile would terminate the capture tab. Ask
      // the user to stop recording first; never silently kill a live recording.
      this.lastError = {code: 'TIKTOK_CAPTURE_ACTIVE', reason: 'stop_capture_first'};
      return this.status();
    }
    this.#stopPolling();
    await this.#closeBrowser();
    this.#clearProfile();
    this.persisted = null;
    this.verifiedAt = null;
    this.verifiedBy = null;
    this.room = null;
    this.capture = null;
    this.roomAccess = {state: 'unknown', status: null, at: null};
    this.cookieNames = [];
    this.restoredFromDisk = false;
    this.revalidationRequired = false;
    this.lastError = null;
    this.#setState(TIKTOK_LOGIN_STATES.IDLE, {reason: 'logged_out'});
    return this.status();
  }

  async shutdown() {
    this.#stopPolling();
    await this.#closeBrowser({force: true});
  }

  async #closeBrowser({keepOwnedBrowser = false, force = false} = {}) {
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    if (this.profileDir && (force || !keepOwnedBrowser)) {
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
