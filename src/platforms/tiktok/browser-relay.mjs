import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {decodeWebcastResponse, mapTikTokMessage} from './messages.mjs';
import {
  BROWSER_MARKER,
  buildBrowserArgs,
  findBrowserExecutable,
  findBrowserExecutables,
  findExistingBrowser,
  launchBrowser,
  parseDevToolsActivePort,
  terminateOwnedBrowsers,
  tiktokBrowserProfileDir
} from './browser-launch.mjs';

/**
 * Experimental browser relay ("transport B").
 *
 * TikTok's own web player is the only local client that can receive live events
 * without a third-party signer. This module launches the user's installed
 * Chrome/Edge with a dedicated LiveMemory profile, opens the official live page
 * and reads the WebSocket frames that the official page itself receives.
 *
 * It does not forge signatures, solve captchas, disable browser security or
 * inject stealth scripts. If TikTok's own page asks the visitor to log in
 * (`POST /webcast/room/enter/` answers 403 while the page is anonymous), the
 * relay reports `TIKTOK_LOGIN_REQUIRED` instead of pretending to record.
 *
 * The profile is shared with `browser-login.mjs`, so logging in once is enough
 * and starting a capture reuses the already-open window instead of opening a
 * second one. Stopping a capture closes only the tab created for it; the login
 * window and the profile stay until the user closes them.
 *
 * Verification status: the browser window, the CDP session and the page's
 * WebSocket are real (see the research notes), but logged-in chat delivery has
 * NOT been verified because no TikTok account was available. Treat transport B
 * as experimental until a logged-in capture is recorded.
 */

const MAX_SEEN_IDS = 5000;

export {
  buildBrowserArgs,
  findBrowserExecutable,
  findBrowserExecutables,
  parseDevToolsActivePort,
  tiktokBrowserProfileDir,
  terminateOwnedBrowsers,
  BROWSER_MARKER
};

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
export class CdpClient {
  constructor({url, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000} = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = true;
    this.onClose = null;
  }

  async open() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    this.closed = false;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#rejectAll(new Error('cdp closed')));
    ws.addEventListener('error', () => this.#rejectAll(new Error('cdp error')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp open timeout')), this.timeoutMs);
      timer.unref?.();
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, {once: true});
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('cdp open failed'));
      }, {once: true});
    });
    return this;
  }

  #rejectAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    try {
      this.onClose?.();
    } catch {
      /* ignore */
    }
  }

  #onMessage(event) {
    let message;
    try {
      const raw = typeof event?.data === 'string' ? event.data : String(event?.data ?? '');
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error('cdp error'), {code: 'CDP_ERROR', details: message.error}));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message?.method) {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch {
          /* listener errors must not break the protocol */
        }
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, {sessionId = null, timeoutMs = this.timeoutMs} = {}) {
    if (this.closed || !this.ws) return Promise.reject(new Error('cdp closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {resolve, reject, timer});
      const payload = {id, method, params};
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    const wasOpen = !this.closed;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (wasOpen) {
      try {
        this.onClose?.();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Frame payloads arrive base64-encoded; chat frames are gzip protobuf. */
export function decodeFramePayload(base64) {
  const buffer = Buffer.from(String(base64 ?? ''), 'base64');
  if (buffer.length === 0) return [];
  const attempts = [buffer];
  try {
    attempts.push(gunzipSync(buffer));
  } catch {
    /* not gzip */
  }
  for (const candidate of attempts) {
    try {
      const decoded = decodeWebcastResponse(candidate);
      if (decoded.messages.length > 0) return decoded.messages;
    } catch {
      /* try next */
    }
  }
  return [];
}

/**
 * One browser page per recording. The adapter below owns the lifecycle; this
 * class only manages the browser/CDP handle and the page's own network stream.
 */
export class BrowserSession {
  constructor({
    uniqueId = null,
    roomId = null,
    liveUrl,
    dataDir = null,
    logger = null,
    now = Date.now,
    spawnImpl = null,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    launchTimeoutMs = 25000,
    loginWaitMs = 20000,
    env = process.env
  } = {}) {
    this.uniqueId = uniqueId;
    this.roomId = roomId;
    this.liveUrl = liveUrl;
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.spawnImpl = spawnImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.launchTimeoutMs = launchTimeoutMs;
    this.loginWaitMs = loginWaitMs;
    this.env = env;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.createdTarget = false;
    this.port = null;
    this.profileDir = null;
    this.roomEnterStatus = null;
    this.frameCount = 0;
    this.decodedCount = 0;
    this.closed = false;
    this.reusedBrowser = false;
    this.browserPid = null;
    this.launchKind = null;
    this.onFrame = () => {};
    this.onClose = () => {};
  }

  async launch() {
    const executables = findBrowserExecutables({env: this.env});
    if (executables.length === 0) {
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
        messageKey: 'errors.tiktokBrowserUnavailable',
        httpStatus: 503,
        details: {reason: 'browser_not_found'}
      });
    }
    const base = this.dataDir ?? join(this.env.TEMP ?? this.env.TMP ?? '.', 'livememory');
    this.profileDir = tiktokBrowserProfileDir(base);
    const args = buildBrowserArgs({profileDir: this.profileDir, startUrl: 'about:blank'});
    let launched = null;
    let lastError = null;
    for (const executable of executables) {
      try {
        launched = await launchBrowser({
          profileDir: this.profileDir,
          args,
          browserPath: executable,
          spawnImpl: this.spawnImpl ?? undefined,
          env: this.env,
          timeoutMs: this.launchTimeoutMs,
          logger: this.logger
        });
        break;
      } catch (error) {
        lastError = error;
        this.logger?.warn({
          event: 'tiktok.browser.launch.failed',
          browser: executable,
          reason: error?.reason ?? error?.message ?? 'launch_failed'
        });
        // A Chromium may have opened a window but never wrote its DevTools
        // port. Close only processes carrying this exact profile before trying
        // the next installed browser, so fallback never creates a second window.
        await terminateOwnedBrowsers({profileDir: this.profileDir, env: this.env});
      }
    }
    if (!launched) {
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_FAILED, {
        messageKey: 'errors.tiktokBrowserFailed',
        httpStatus: 502,
        details: {reason: lastError?.reason ?? 'browser_did_not_start'}
      });
    }
    this.reusedBrowser = launched.kind === 'reuse';
    this.browserPid = launched.pid ?? null;
    this.launchKind = launched.kind;
    this.port = launched.port;

    const page = await this.#openPage(launched.port);
    this.targetId = page.id;
    this.createdTarget = page.created;
    this.cdp = new CdpClient({
      url: page.webSocketDebuggerUrl,
      WebSocketImpl: this.WebSocketImpl
    });
    this.cdp.onClose = () => {
      if (this.closed) return;
      this.closed = true;
      try {
        this.onClose();
      } catch {
        /* ignore */
      }
    };
    await this.cdp.open();
    // Page-level CDP: this is the same approach as the working Douyin browser
    // flow. Browser-level `Target.attachToTarget` sessions are much more
    // fragile on recent Edge/Chrome builds.
    await this.cdp.send('Page.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('Runtime.enable').catch(() => {});
    this.cdp.onEvent((message) => this.#onEvent(message));
    await this.cdp.send('Page.navigate', {url: this.liveUrl});
    this.logger?.info({
      event: 'tiktok.browser.navigated',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      kind: this.launchKind,
      reusedBrowser: this.reusedBrowser
    });
    return this;
  }

  /**
   * Reuse the tab that already points at the target URL, otherwise create a
   * fresh tab over the HTTP DevTools endpoint. Each tab has its own page-level
   * CDP socket, so login and capture never fight over one session.
   */
  async #openPage(port) {
    const base = `http://127.0.0.1:${port}`;
    let pages = [];
    try {
      const response = await this.fetchImpl(`${base}/json/list`, {
        headers: {accept: 'application/json'},
        signal: AbortSignal.timeout?.(5000)
      });
      if (response.ok) pages = await response.json();
    } catch {
      /* create below */
    }
    const wanted = String(this.liveUrl ?? '').split('?')[0];
    const existing = Array.isArray(pages)
      ? pages.find((target) => target?.type === 'page' && wanted && String(target.url ?? '').startsWith(wanted))
      : null;
    if (existing?.webSocketDebuggerUrl) {
      return {id: existing.id, webSocketDebuggerUrl: existing.webSocketDebuggerUrl, created: false};
    }
    const attempts = [
      {method: 'PUT', url: `${base}/json/new?${encodeURIComponent('about:blank')}`},
      {method: 'PUT', url: `${base}/json/new?url=${encodeURIComponent('about:blank')}`},
      {method: 'GET', url: `${base}/json/new?about:blank`}
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await this.fetchImpl(attempt.url, {
          method: attempt.method,
          headers: {accept: 'application/json'},
          signal: AbortSignal.timeout?.(5000)
        });
        if (!response.ok) continue;
        const created = await response.json();
        if (created?.webSocketDebuggerUrl) {
          return {id: created.id, webSocketDebuggerUrl: created.webSocketDebuggerUrl, created: true};
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw new TikTokError(TIKTOK_ERRORS.BROWSER_FAILED, {
      messageKey: 'errors.tiktokBrowserFailed',
      httpStatus: 502,
      details: {reason: 'page_target_unavailable', message: String(lastError?.message ?? '').slice(0, 80)}
    });
  }

  #onEvent(message) {
    const params = message.params;
    if (message.method === 'Network.responseReceived') {
      const url = String(params?.response?.url ?? '');
      if (url.includes('/webcast/room/enter/')) {
        this.roomEnterStatus = Number(params.response.status);
        this.logger?.info({
          event: 'tiktok.browser.room_enter',
          status: this.roomEnterStatus,
          uniqueId: this.uniqueId
        });
      }
      return;
    }
    if (message.method !== 'Network.webSocketFrameReceived') return;
    const url = String(params?.response?.url ?? '');
    const payload = params?.response?.payloadData ?? '';
    this.frameCount += 1;
    let messages = [];
    try {
      messages = decodeFramePayload(payload);
    } catch {
      messages = [];
    }
    if (messages.length === 0) return;
    this.decodedCount += messages.length;
    for (const item of messages) {
      try {
        this.onFrame(item, url);
      } catch (error) {
        this.logger?.warn({event: 'tiktok.browser.frame.failed', code: error?.code ?? 'unknown'});
      }
    }
  }

  /** True when the page itself was refused room entry, i.e. login is required. */
  requiresLogin() {
    return this.roomEnterStatus === 403;
  }

  isAlive() {
    return !this.closed && Boolean(this.cdp) && !this.cdp.closed;
  }

  async waitForReady({timeoutMs = this.loginWaitMs} = {}) {
    const startedAt = this.now();
    for (;;) {
      if (this.closed || !this.isAlive()) return {closed: true, loginRequired: false, events: this.decodedCount, roomEnterStatus: this.roomEnterStatus};
      if (this.requiresLogin()) return {closed: false, loginRequired: true, events: this.decodedCount, roomEnterStatus: this.roomEnterStatus};
      if (this.decodedCount > 0 || this.roomEnterStatus === 200) {
        return {closed: false, loginRequired: false, events: this.decodedCount, roomEnterStatus: this.roomEnterStatus};
      }
      if (this.now() - startedAt >= timeoutMs) {
        return {closed: false, loginRequired: false, events: this.decodedCount, roomEnterStatus: this.roomEnterStatus, timedOut: true};
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
      });
    }
  }

  async navigate(url) {
    if (!this.cdp || this.cdp.closed) throw new Error('browser session is not open');
    await this.cdp.send('Page.navigate', {url});
  }

  async getCookies(urls = ['https://www.tiktok.com', 'https://www.tiktok.com/login']) {
    if (!this.cdp || this.cdp.closed) return [];
    try {
      const result = await this.cdp.send('Network.getCookies', {urls});
      return Array.isArray(result?.cookies) ? result.cookies : [];
    } catch {
      return [];
    }
  }

  async evaluate(expression) {
    if (!this.cdp || this.cdp.closed) return null;
    try {
      const result = await this.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      return result?.result?.value ?? null;
    } catch {
      return null;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.createdTarget && this.targetId && this.port) {
      try {
        await this.fetchImpl(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(this.targetId)}`, {
          signal: AbortSignal.timeout?.(2000)
        });
      } catch {
        /* the tab may already be gone */
      }
    }
    try {
      this.cdp?.close();
    } catch {
      /* ignore */
    }
    this.cdp = null;
  }
}

function captureCategory(state, detail) {
  if (state === CONNECTION_STATE.CONNECTED) {
    return detail?.eventsVerified ? 'normal' : 'waiting_events';
  }
  if (state === CONNECTION_STATE.RECONNECTING) return 'auto_reconnect';
  if (state === CONNECTION_STATE.AUTH_REQUIRED) return 'user_action';
  if (state === CONNECTION_STATE.RATE_LIMITED) return 'rate_limit';
  if (state === CONNECTION_STATE.FAILED) return 'failed';
  if (state === CONNECTION_STATE.STOPPED) return detail?.reason === 'platform_ended' ? 'ended' : 'stopped';
  if (state === CONNECTION_STATE.CONNECTING) return 'connecting';
  return 'idle';
}

/** Adapter over a browser session: same ingest contract as the signer adapter. */
export class TikTokBrowserAdapter extends PlatformAdapter {
  constructor({
    uniqueId,
    roomId,
    liveUrl = null,
    dataDir = null,
    logger = null,
    now = Date.now,
    sessionFactory = null,
    loginWaitMs = 20000,
    env = process.env,
    ...options
  } = {}) {
    super({id: 'tiktok-browser', platform: 'tiktok', label: 'TikTok Live (browser)', capabilities: ['chat', 'gift']});
    this.uniqueId = String(uniqueId ?? '').replace(/^@/, '');
    this.roomId = roomId === null || roomId === undefined ? null : String(roomId);
    this.liveUrl = liveUrl ?? `https://www.tiktok.com/@${this.uniqueId}/live`;
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.env = env;
    this.sessionFactory = sessionFactory ?? ((args) => new BrowserSession(args));
    this.options = options;
    this.loginWaitMs = loginWaitMs;
    this.session = null;
    this.started = false;
    this.seen = new Set();
    this.counters = {frames: 0, messages: 0, chats: 0, gifts: 0, duplicates: 0, ignored: 0};
    this.loginRequired = false;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.eventsVerified = false;
    this.roomEnterStatus = null;
    this.reconnectAttempts = 0;
    this.recoveries = 0;
    this.nextRetryAt = null;
    this.lastFailure = null;
    this.timer = null;
    this.reconnecting = false;
  }

  #detail(extra = {}) {
    return {
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      transport: 'browser',
      category: captureCategory(this.state, {eventsVerified: this.eventsVerified, reason: extra.reason}),
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      lastSuccessAt: this.eventsVerified ? this.lastEventAt : null,
      eventsVerified: this.eventsVerified,
      waitingForEvents: Boolean(this.session?.isAlive?.()) && !this.eventsVerified,
      roomEnterStatus: this.roomEnterStatus,
      browserOpen: Boolean(this.session?.isAlive?.()),
      browserReused: Boolean(this.session?.reusedBrowser),
      reconnectAttempts: this.reconnectAttempts,
      recoveries: this.recoveries,
      nextRetryAt: this.nextRetryAt,
      lastFailure: this.lastFailure,
      loginRequired: this.loginRequired,
      counters: {...this.counters},
      ...extra
    };
  }

  #setState(state, extra = {}) {
    this.setState(state, this.#detail(extra));
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? (() => {});
    this.onPlatformStatus = onPlatformStatus ?? (() => {});
    this.started = true;
    this.eventsVerified = false;
    this.#setState(CONNECTION_STATE.CONNECTING, {uniqueId: this.uniqueId, roomId: this.roomId, transport: 'browser'});
    const session = this.#createSession();
    this.session = session;
    try {
      await session.launch();
    } catch (error) {
      this.started = false;
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      this.lastFailure = {code: error?.code ?? 'unknown', at: this.now(), reason: error?.details?.reason ?? null};
      this.#setState(CONNECTION_STATE.FAILED, {code: error?.code ?? 'unknown', messageKey: error?.messageKey ?? null});
      throw error;
    }
    const ready = session.waitForReady
      ? await session.waitForReady({timeoutMs: this.loginWaitMs})
      : {loginRequired: session.requiresLogin?.(), events: 0};
    this.roomEnterStatus = ready.roomEnterStatus ?? null;
    if (ready.loginRequired) {
      this.loginRequired = true;
      this.#setState(CONNECTION_STATE.AUTH_REQUIRED, {reason: 'login_required', code: TIKTOK_ERRORS.LOGIN_REQUIRED});
      await this.stop();
      throw new TikTokError(TIKTOK_ERRORS.LOGIN_REQUIRED, {
        messageKey: 'errors.tiktokLoginRequired',
        httpStatus: 403,
        details: {reason: 'room_enter_403'}
      });
    }
    if (ready.closed) {
      this.started = false;
      await this.stop();
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_FAILED, {
        messageKey: 'errors.tiktokBrowserFailed',
        httpStatus: 502,
        details: {reason: 'page_closed'}
      });
    }
    this.eventsVerified = Number(ready.events ?? 0) > 0;
    this.#setState(CONNECTION_STATE.CONNECTED, {
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      transport: 'browser',
      eventsVerified: this.eventsVerified,
      waitingForEvents: !this.eventsVerified,
      roomEnterStatus: this.roomEnterStatus
    });
    this.#startWatchdog();
  }

  #createSession() {
    const session = this.sessionFactory({
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      liveUrl: this.liveUrl,
      dataDir: this.dataDir,
      logger: this.logger,
      now: this.now,
      env: this.env,
      loginWaitMs: this.loginWaitMs
    });
    session.onFrame = (message) => this.#handleMessage(message);
    session.onClose = () => this.#onBrowserClosed();
    return session;
  }

  #onBrowserClosed() {
    if (!this.started || this.reconnecting) return;
    this.logger?.warn({event: 'tiktok.browser.closed', uniqueId: this.uniqueId});
    this.nextRetryAt = this.now();
    this.#setState(CONNECTION_STATE.RECONNECTING, {
      category: 'auto_reconnect',
      code: TIKTOK_ERRORS.BROWSER_FAILED,
      reason: 'browser_closed'
    });
    this.#reconnect().catch(() => {});
  }

  #startWatchdog() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.started) return;
      if (!this.session?.isAlive?.() && !this.reconnecting) {
        this.nextRetryAt = this.now();
        this.#setState(CONNECTION_STATE.RECONNECTING, {
          category: 'auto_reconnect',
          code: TIKTOK_ERRORS.BROWSER_FAILED,
          reason: 'browser_unavailable'
        });
        this.#reconnect().catch(() => {});
      }
    }, 15000);
    this.timer.unref?.();
  }

  async #reconnect() {
    if (!this.started || this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= 3 && this.started; attempt += 1) {
        this.reconnectAttempts += 1;
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        if (!this.started) return;
        try {
          await this.session?.close?.();
        } catch {
          /* ignore */
        }
        const session = this.#createSession();
        this.session = session;
        try {
          await session.launch();
          const ready = session.waitForReady
            ? await session.waitForReady({timeoutMs: this.loginWaitMs})
            : {loginRequired: false, events: 0};
          if (ready.loginRequired) {
            this.loginRequired = true;
            this.lastFailure = {code: TIKTOK_ERRORS.LOGIN_REQUIRED, at: this.now(), reason: 'login_required'};
            this.#setState(CONNECTION_STATE.AUTH_REQUIRED, {reason: 'login_required'});
            this.started = false;
            this.recoveries += 1;
            return;
          }
          this.roomEnterStatus = ready.roomEnterStatus ?? null;
          this.eventsVerified = Number(ready.events ?? 0) > 0;
          this.nextRetryAt = null;
          this.recoveries += 1;
          this.#setState(CONNECTION_STATE.CONNECTED, {
            category: this.eventsVerified ? 'normal' : 'waiting_events',
            eventsVerified: this.eventsVerified,
            waitingForEvents: !this.eventsVerified,
            recoveredAt: this.now(),
            roomEnterStatus: this.roomEnterStatus
          });
          return;
        } catch (error) {
          this.lastFailure = {code: error?.code ?? 'unknown', at: this.now(), reason: error?.details?.reason ?? null};
          this.logger?.warn({event: 'tiktok.browser.reconnect.failed', attempt, code: error?.code ?? 'unknown'});
        }
      }
      if (this.started) {
        this.#setState(CONNECTION_STATE.FAILED, {
          category: 'failed',
          code: TIKTOK_ERRORS.BROWSER_FAILED,
          retrying: false,
          needsUserAction: true,
          retryAfterMs: null,
          nextRetryAt: null
        });
      }
    } finally {
      this.reconnecting = false;
    }
  }

  #handleMessage(message) {
    this.counters.frames += 1;
    let mapped;
    try {
      mapped = mapTikTokMessage(message, {now: this.now()});
    } catch {
      this.counters.ignored += 1;
      return;
    }
    if (mapped.kind !== 'event') {
      this.counters.ignored += 1;
      return;
    }
    const event = mapped.event;
    const id = event.external_id ? String(event.external_id) : null;
    if (id) {
      if (this.seen.has(id)) {
        this.counters.duplicates += 1;
        return;
      }
      this.seen.add(id);
      if (this.seen.size > MAX_SEEN_IDS) this.seen.delete(this.seen.values().next().value);
    }
    this.counters.messages += 1;
    if (event.event_type === 'chat') this.counters.chats += 1;
    if (event.event_type === 'gift') this.counters.gifts += 1;
    this.lastEventAt = this.now();
    this.lastEventType = event.event_type;
    this.eventsVerified = true;
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger?.warn({event: 'tiktok.browser.emit.failed', code: error?.code ?? 'unknown'});
    }
  }

  async stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    this.#setState(CONNECTION_STATE.STOPPED, {uniqueId: this.uniqueId, loginRequired: this.loginRequired, reason: 'user'});
  }

  capture() {
    return this.#detail();
  }

  snapshot() {
    return {
      ...super.snapshot(),
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      counters: {...this.counters},
      loginRequired: this.loginRequired,
      lastEventAt: this.lastEventAt,
      capture: this.capture()
    };
  }
}

/** Wires browser adapters into TikTokService (transport `browser`). */
export class TikTokBrowserRelay {
  constructor({dataDir = null, logger = null, now = Date.now, sessionFactory = null} = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.sessionFactory = sessionFactory;
    this.sessions = new Set();
  }

  createAdapter({uniqueId, roomId, liveUrl = null, logger = null}) {
    const adapter = new TikTokBrowserAdapter({
      uniqueId,
      roomId,
      liveUrl,
      dataDir: this.dataDir,
      logger: logger ?? this.logger,
      now: this.now,
      ...(this.sessionFactory ? {sessionFactory: this.sessionFactory} : {})
    });
    this.sessions.add(adapter);
    return adapter;
  }

  async stop() {
    for (const adapter of this.sessions) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }

  /** Close only the dedicated LiveMemory TikTok profile's browser windows. */
  async closeBrowser() {
    if (!this.dataDir) return false;
    return terminateOwnedBrowsers({profileDir: tiktokBrowserProfileDir(this.dataDir)});
  }
}

export const __internal = {BROWSER_MARKER, MAX_SEEN_IDS};
