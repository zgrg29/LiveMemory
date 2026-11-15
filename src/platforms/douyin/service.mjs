import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {getSession, listSessions} from '../../storage/repositories/sessions.mjs';
import {DouyinWebClient} from './client.mjs';
import {DouyinLiveAdapter} from './adapter.mjs';
import {DouyinCookieStore} from './cookie-store.mjs';
import {DouyinLogin} from './login.mjs';
import {DouyinBrowserLogin, BROWSER_LOGIN_STATES} from './browser-login.mjs';
import {parseDouyinInput} from './link.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';

/**
 * Glue between HTTP routes, the public room client, the anonymous adapter,
 * the optional login and SessionManager.
 *
 * Anonymous chat/identity/room-status need no account, no API key and no paid
 * service. Login is only used to make the platform push gift events; when it is
 * unavailable the UI must say so instead of pretending gifts are supported.
 */

export const DOUYIN_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [DOUYIN_ERRORS.LINK_INVALID, [400, 'errors.douyinLinkInvalid']],
  [DOUYIN_ERRORS.ROOM_NOT_FOUND, [404, 'errors.douyinRoomNotFound']],
  [DOUYIN_ERRORS.ROOM_OFFLINE, [409, 'errors.douyinRoomOffline']],
  [DOUYIN_ERRORS.ROOM_ENDED, [409, 'errors.douyinRoomEnded']],
  [DOUYIN_ERRORS.NETWORK, [502, 'errors.douyinNetwork']],
  [DOUYIN_ERRORS.RATE_LIMITED, [429, 'errors.douyinRateLimit']],
  [DOUYIN_ERRORS.BLOCKED, [403, 'errors.douyinBlocked']],
  [DOUYIN_ERRORS.PROTOCOL, [502, 'errors.douyinProtocol']],
  [DOUYIN_ERRORS.SIGNATURE_FAILED, [502, 'errors.douyinSignatureFailed']],
  [DOUYIN_ERRORS.CONNECT_TIMEOUT, [504, 'errors.douyinConnectTimeout']],
  [DOUYIN_ERRORS.WEBSOCKET_UNAVAILABLE, [503, 'errors.douyinWebSocketUnavailable']],
  [DOUYIN_ERRORS.LOGIN_BLOCKED, [409, 'errors.douyinLoginBlocked']],
  [DOUYIN_ERRORS.LOGIN_EXPIRED, [401, 'errors.douyinLoginExpired']],
  [DOUYIN_ERRORS.LOGIN_INVALID, [401, 'errors.douyinAuth']],
  [DOUYIN_ERRORS.QR_MISSING, [400, 'errors.douyinQrMissing']],
  [DOUYIN_ERRORS.AUTH, [401, 'errors.douyinAuth']],
  [DOUYIN_ERRORS.COOKIE_FORMAT, [400, 'errors.douyinCookieFormat']],
  [DOUYIN_ERRORS.COOKIE_INCOMPLETE, [400, 'errors.douyinCookieIncomplete']],
  [DOUYIN_ERRORS.BROWSER_UNAVAILABLE, [503, 'errors.douyinBrowserUnavailable']],
  [DOUYIN_ERRORS.BROWSER_LAUNCH_FAILED, [502, 'errors.douyinBrowserLaunchFailed']],
  [DOUYIN_ERRORS.LOGIN_VERIFY_UNAVAILABLE, [503, 'errors.douyinLoginVerifyUnavailable']],
  [DOUYIN_ERRORS.NOT_CONFIGURED, [503, 'errors.douyinNotConfigured']]
]);

export function toApiError(error) {
  if (error instanceof AppError) return error;
  const entry = HTTP_BY_CODE.get(error?.code);
  if (entry) {
    return new AppError(error.code, {
      messageKey: entry[1],
      httpStatus: entry[0],
      details: error?.details ?? null,
      cause: error
    });
  }
  return new AppError('DOUYIN_ERROR', {
    messageKey: 'errors.douyinError',
    httpStatus: 502,
    cause: error
  });
}

function roomView(room, input) {
  return {
    webRid: room.webRid,
    roomId: room.roomId,
    isLive: Boolean(room.isLive),
    status: room.status,
    title: room.title ?? null,
    anchorName: room.anchorName ?? null,
    anchorUid: room.anchorId ?? null,
    anchorSecUid: room.anchorSecUid ?? null,
    userCount: room.userCount ?? null,
    checkedAt: room.checkedAt ?? Date.now(),
    input: String(input ?? ''),
    liveUrl: `https://live.douyin.com/${room.webRid}`,
    recordable: Boolean(room.isLive),
    reason: room.isLive ? null : (room.ended ? DOUYIN_ERRORS.ROOM_ENDED : DOUYIN_ERRORS.ROOM_OFFLINE)
  };
}

export class DouyinService {
  constructor({
    sessionManager,
    secretsDir = null,
    dataDir = null,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    client = null,
    store = null,
    login = null,
    browserLogin = null,
    browserLoginOptions = null,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.client = client ?? new DouyinWebClient({fetchImpl, now, logger});
    this.store = store ?? (secretsDir ? new DouyinCookieStore({dir: secretsDir}) : null);
    this.login = login ?? new DouyinLogin({store: this.store, fetchImpl, logger, now});
    this.dataDir = dataDir;
    this.browserLogin = browserLogin ?? (dataDir
      ? new DouyinBrowserLogin({
        dataDir,
        login: this.login,
        logger,
        now,
        fetchImpl,
        WebSocketImpl,
        ...(browserLoginOptions ?? {})
      })
      : null);
    this.adapterOptions = adapterOptions;
    this.adapters = new Map();
    this.lastGiftObservation = null;
    this.lastEnd = null;
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'douyin');
  }

  #giftCounts(sessionId) {
    if (!this.db || !sessionId) return {stored: 0, lastGiftAt: null};
    let stored = 0;
    let lastGiftAt = null;
    try {
      const row = getSession(this.db, sessionId);
      stored = Number(row?.gift_event_count ?? 0);
      const aggregate = this.db.prepare(
        `SELECT COUNT(*) AS count, MAX(occurred_at) AS at
           FROM events WHERE session_id = ? AND event_type = 'gift'`
      ).get(String(sessionId));
      stored = Math.max(stored, Number(aggregate?.count ?? 0));
      lastGiftAt = Number.isFinite(Number(aggregate?.at)) ? Number(aggregate.at) : null;
    } catch {
      /* the database may be closing during shutdown */
    }
    return {stored, lastGiftAt};
  }

  #observeGifts(sessionId, adapter = null) {
    const counts = this.#giftCounts(sessionId);
    const decoded = Number.isFinite(Number(adapter?.counters?.giftFinal))
      ? Number(adapter.counters.giftFinal)
      : null;
    const state = counts.stored > 0
      ? 'observed'
      : decoded !== null && decoded > 0
        ? 'ingest_gap'
        : 'not_observed';
    this.lastGiftObservation = {
      state,
      sessionId: sessionId ?? null,
      decoded,
      stored: counts.stored,
      lastGiftAt: counts.lastGiftAt,
      checkedAt: this.now()
    };
    return this.lastGiftObservation;
  }

  #giftObservation(latest) {
    if (latest?.sessionId) {
      return this.#observeGifts(latest.sessionId, this.adapters.get(latest.sessionId) ?? null);
    }
    if (this.lastGiftObservation?.sessionId) {
      return this.#observeGifts(this.lastGiftObservation.sessionId, null);
    }
    const row = this.db
      ? listSessions(this.db, {platform: 'douyin', limit: 1})[0] ?? null
      : null;
    if (row) return this.#observeGifts(row.id, null);
    return {
      state: 'unknown',
      sessionId: null,
      decoded: null,
      stored: 0,
      lastGiftAt: null,
      checkedAt: this.now()
    };
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    const login = this.login?.status() ?? {
      loggedIn: false,
      state: 'anonymous',
      verified: null,
      sessionAvailable: false,
      user: null,
      cookiePresent: false
    };
    const browser = this.browserLogin?.status() ?? {
      supported: false,
      browser: null,
      state: BROWSER_LOGIN_STATES.UNAVAILABLE,
      messageKey: 'live.source.douyinBrowserUnavailable',
      qr: null,
      error: {code: 'DOUYIN_BROWSER_UNAVAILABLE', reason: 'not_configured'},
      active: false
    };
    const gifts = this.#giftObservation(latest);
    const captureState = latest?.connection?.state ?? 'idle';
    return {
      available: true,
      mode: login.sessionAvailable ? 'web-session' : 'anonymous',
      login,
      browserLogin: browser,
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          webRid: latest.meta?.room?.webRid ?? latest.platformRoomId,
          roomId: latest.meta?.room?.roomId ?? null,
          title: latest.meta?.room?.title ?? latest.roomTitle,
          online: latest.connection.detail?.online ?? latest.meta?.room?.userCount ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, webRid: null, roomId: null, title: null, online: null, lastEnd: this.lastEnd},
      recordings,
      recording: latest?.connection.state ?? 'idle',
      session: latest
        ? {
          id: latest.sessionId,
          platform: latest.platform,
          broadcasterId: latest.broadcasterId,
          broadcasterIdentity: latest.broadcasterIdentity,
          roomTitle: latest.roomTitle
        }
        : null,
      giftVerification: {
        scan: browser.state,
        session: login.state,
        capture: captureState,
        gifts: gifts.state
      },
      gifts,
      policy: this.db
        ? retentionStatus(this.db, {
          days: DOUYIN_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['douyin'],
          policy: 'douyin-raw-content'
        })
        : null,
      capabilities: {
        requiresLoginForChat: false,
        requiresLoginForGifts: true,
        requiresApiKey: false,
        requiresPaidService: false,
        liveOnly: true,
        stableUserId: true,
        messageId: true,
        secUid: true,
        chat: 'verified',
        gifts: !login.sessionAvailable
          ? 'requires-login'
          : gifts.state === 'observed'
            ? 'observed'
            : 'session-valid-gift-not-observed',
        combo: 'parsed-not-live-verified',
        giftValue: 'display-only',
        browserQrLogin: browser.state,
        login: login.state
      }
    };
  }

  async checkRoom(input) {
    const parsed = parseDouyinInput(input);
    const room = await this.client.fetchRoom(parsed.webRid);
    return roomView(room, input);
  }

  async #startWithRoom(room, {monitorTargetId = null, input = null} = {}) {
    if (!room?.isLive) {
      throw new DouyinError(room?.ended ? DOUYIN_ERRORS.ROOM_ENDED : DOUYIN_ERRORS.ROOM_OFFLINE, {
        messageKey: room?.ended ? 'errors.douyinRoomEnded' : 'errors.douyinRoomOffline',
        httpStatus: 409,
        details: {webRid: room?.webRid ?? null, status: room?.status ?? null}
      });
    }
    const adapter = new DouyinLiveAdapter({
      webRid: room.webRid,
      roomId: room.roomId,
      room,
      client: this.client,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now,
      cookie: this.login?.sessionCookie?.() ?? '',
      ...(this.adapterOptions ? this.adapterOptions : {})
    });
    const anchorUid = room.anchorUid ?? room.anchorId ?? room.roomId ?? null;
    const identity = resolveBroadcasterIdentity({
      platform: 'douyin',
      platformRoomId: String(room.roomId),
      broadcasterUid: anchorUid,
      broadcasterName: room.anchorName
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'douyin',
      platformRoomId: String(room.roomId),
      roomTitle: room.title ?? `Douyin ${room.webRid}`,
      broadcasterName: room.anchorName ?? null,
      broadcasterUid: anchorUid,
      sourceQuality: SOURCE_QUALITY.ESTIMATED,
      simulated: false,
      platformStartedAt: null,
      monitorTargetId,
      createAdapter: () => adapter,
      meta: {
        room: {...room},
        webRid: room.webRid,
        mode: this.login?.sessionAvailable ? 'web-session' : 'anonymous',
        broadcasterIdentity: identity.identity,
        input: input ?? null
      },
      onEnded: ({reason}) => {
        this.#observeGifts(result.session.id, adapter);
        this.adapters.delete(result.session.id);
        this.lastEnd = {reason, at: this.now(), mode: this.login?.sessionAvailable ? 'web-session' : 'anonymous'};
        this.#applyRetention();
      }
    });
    if (!result.started) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      throw duplicateRoomError(result.duplicate);
    }
    this.adapters.set(result.session.id, adapter);
    this.#observeGifts(result.session.id, adapter);
    this.logger?.info({
      event: 'douyin.session.started',
      sessionId: result.session.id,
      webRid: room.webRid,
      roomId: room.roomId,
      monitorTargetId: monitorTargetId ?? null
    });
    return {
      session: result.session,
      room: roomView(room, input),
      connection: adapter.snapshot()
    };
  }

  async connect(input) {
    const room = await this.checkRoom(input);
    if (!room.isLive) {
      throw new DouyinError(room.reason === DOUYIN_ERRORS.ROOM_ENDED ? DOUYIN_ERRORS.ROOM_ENDED : DOUYIN_ERRORS.ROOM_OFFLINE, {
        messageKey: room.reason === DOUYIN_ERRORS.ROOM_ENDED ? 'errors.douyinRoomEnded' : 'errors.douyinRoomOffline',
        httpStatus: 409,
        details: {webRid: room.webRid}
      });
    }
    return this.#startWithRoom(room, {input});
  }

  async connectDetected(observation, {monitorTargetId = null, input = null} = {}) {
    const room = {
      webRid: observation?.webRid ?? observation?.targetKey ?? null,
      roomId: observation?.roomId ?? observation?.anchorUid ?? null,
      isLive: observation?.status === 'live',
      ended: false,
      status: observation?.roomStatus ?? 2,
      title: observation?.title ?? null,
      anchorName: observation?.anchorName ?? observation?.channelTitle ?? null,
      anchorId: observation?.anchorUid ?? null,
      anchorSecUid: observation?.anchorSecUid ?? null,
      userCount: observation?.online ?? null,
      checkedAt: observation?.observedAt ?? this.now()
    };
    if (!room.webRid || !room.roomId) {
      throw new DouyinError(DOUYIN_ERRORS.PROTOCOL, {
        messageKey: 'errors.douyinProtocol',
        httpStatus: 502,
        details: {reason: 'detected_room_incomplete'}
      });
    }
    return this.#startWithRoom(room, {monitorTargetId, input: input ?? observation?.input ?? null});
  }

  async disconnect({sessionId = null} = {}) {
    const recordings = this.#recordings();
    const targetSessionId = sessionId
      ? String(sessionId)
      : recordings.length === 1
        ? recordings[0].sessionId
        : null;
    const target = targetSessionId ? this.adapters.get(targetSessionId) ?? null : null;
    const result = await this.sessionManager.stopPlatform('douyin', {
      sessionId,
      status: 'ended',
      reason: 'user'
    });
    const stoppedId = result?.session?.id ?? targetSessionId ?? null;
    if (stoppedId) {
      this.#observeGifts(stoppedId, target);
      this.adapters.delete(String(stoppedId));
    }
    if (result.stopped) this.#applyRetention();
    return result;
  }

  /* --------------------------------------------------------------- login */

  async startBrowserLogin() {
    if (!this.browserLogin) {
      throw new DouyinError(DOUYIN_ERRORS.BROWSER_UNAVAILABLE, {
        messageKey: 'errors.douyinBrowserUnavailable',
        httpStatus: 503,
        details: {reason: 'not_configured'}
      });
    }
    return this.browserLogin.start();
  }

  browserLoginStatus() {
    return this.browserLogin?.status() ?? {
      supported: false,
      state: BROWSER_LOGIN_STATES.UNAVAILABLE,
      messageKey: 'live.source.douyinBrowserUnavailable',
      error: {code: 'DOUYIN_BROWSER_UNAVAILABLE', reason: 'not_configured'}
    };
  }

  async cancelBrowserLogin() {
    if (!this.browserLogin) {
      return {
        supported: false,
        state: BROWSER_LOGIN_STATES.UNAVAILABLE,
        error: {code: 'DOUYIN_BROWSER_UNAVAILABLE', reason: 'not_configured'}
      };
    }
    return this.browserLogin.cancel();
  }

  async logout() {
    try {
      await this.browserLogin?.shutdown();
    } catch {
      /* the browser may already be closed */
    }
    const profile = this.browserLogin?.clearProfile?.() ?? {removed: false, reason: 'not_configured'};
    this.browserLogin?.reset?.();
    await this.login.logout();
    return {profile, ...this.status()};
  }

  async checkLogin() {
    const result = await this.login.checkStored();
    return {...result, status: this.login.status()};
  }

  async applyCookie(cookie) {
    const result = await this.login.applyCookie(cookie);
    return {...result, status: this.login.status()};
  }

  async shutdown() {
    try {
      await this.browserLogin?.shutdown();
    } catch {
      /* best effort */
    }
    this.adapters.clear();
  }

  /* ------------------------------------------------------------ retention */

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {
      now: this.now(),
      days: DOUYIN_RAW_RETENTION_DAYS,
      platforms: ['douyin'],
      logger: this.logger
    });
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {
      summary,
      status: this.db
        ? retentionStatus(this.db, {
          days: DOUYIN_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['douyin'],
          policy: 'douyin-raw-content'
        })
        : null
    };
  }
}

export const __internal = {HTTP_BY_CODE, roomView};
