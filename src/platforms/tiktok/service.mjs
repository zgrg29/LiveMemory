import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {TikTokClient} from './client.mjs';
import {TikTokSigner} from './signer.mjs';
import {TikTokAdapter} from './adapter.mjs';
import {TikTokBrowserLogin, TIKTOK_LOGIN_STATES} from './browser-login.mjs';
import {parseTikTokInput} from './link.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {TIKTOK_TRANSPORTS, normalizeTikTokTransport} from './transports.mjs';

/**
 * Glue between HTTP routes, the public TikTok metadata client, the signed
 * poll transport (or the experimental browser relay) and SessionManager.
 *
 * Two transports are available and both feed the same `EventIngest` pipeline:
 *   - `signer`  (default): free community signing endpoint. No key, no payment.
 *   - `browser` (experimental): a real Chrome session that reads the official
 *     live page. TikTok gates live chat behind login on the web page, so this
 *     transport reports `TIKTOK_LOGIN_REQUIRED` until the user is logged in.
 *
 * Room metadata and the gift catalog always work locally and never require the
 * signed transport.
 */

export const TIKTOK_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [TIKTOK_ERRORS.LINK_INVALID, [400, 'errors.tiktokLinkInvalid']],
  [TIKTOK_ERRORS.ROOM_NOT_FOUND, [404, 'errors.tiktokRoomNotFound']],
  [TIKTOK_ERRORS.ROOM_OFFLINE, [409, 'errors.tiktokRoomOffline']],
  [TIKTOK_ERRORS.ROOM_UNAVAILABLE, [403, 'errors.tiktokRoomUnavailable']],
  [TIKTOK_ERRORS.LOGIN_REQUIRED, [403, 'errors.tiktokLoginRequired']],
  [TIKTOK_ERRORS.RATE_LIMITED, [429, 'errors.tiktokRateLimit']],
  [TIKTOK_ERRORS.NETWORK, [502, 'errors.tiktokNetwork']],
  [TIKTOK_ERRORS.PROTOCOL, [502, 'errors.tiktokProtocol']],
  [TIKTOK_ERRORS.CONNECT_TIMEOUT, [504, 'errors.tiktokConnectTimeout']],
  [TIKTOK_ERRORS.SIGNER_UNAVAILABLE, [502, 'errors.tiktokSignerUnavailable']],
  [TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, [403, 'errors.tiktokSignerPremiumRequired']],
  [TIKTOK_ERRORS.NOT_CONFIGURED, [503, 'errors.tiktokNotConfigured']],
  [TIKTOK_ERRORS.BROWSER_UNAVAILABLE, [503, 'errors.tiktokBrowserUnavailable']],
  [TIKTOK_ERRORS.BROWSER_FAILED, [502, 'errors.tiktokBrowserFailed']],
  [TIKTOK_ERRORS.STOPPED, [409, 'errors.tiktokStopped']]
]);

/** Map adapter/client errors to stable API errors with translatable keys. */
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
  return new AppError('TIKTOK_ERROR', {messageKey: 'errors.tiktokError', httpStatus: 502, cause: error});
}

function roomView(room, input) {
  return {
    uniqueId: room.uniqueId,
    roomId: room.roomId,
    anchorUid: room.anchorUid ?? null,
    anchorName: room.anchorName ?? room.uniqueId,
    isLive: Boolean(room.isLive),
    status: room.status ?? null,
    title: room.title ?? null,
    startedAt: room.startedAt ?? null,
    totalViewers: room.totalViewers ?? null,
    likeCount: room.likeCount ?? null,
    checkedAt: room.checkedAt ?? Date.now(),
    input: String(input ?? ''),
    liveUrl: room.liveUrl ?? `https://www.tiktok.com/@${room.uniqueId}/live`,
    recordable: Boolean(room.isLive),
    reason: room.isLive ? null : TIKTOK_ERRORS.ROOM_OFFLINE
  };
}

export class TikTokService {
  constructor({
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    client = null,
    signer = null,
    browserRelay = null,
    browserLogin = null,
    dataDir = null,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.client = client ?? new TikTokClient({fetchImpl, now});
    this.signer = signer ?? new TikTokSigner({fetchImpl, now});
    this.browserRelay = browserRelay;
    this.browserLogin = browserLogin ?? (dataDir
      ? new TikTokBrowserLogin({
        dataDir,
        logger,
        now,
        fetchImpl,
        isCaptureActive: () => this.#hasActiveCapture()
      })
      : null);
    // An injected login module (tests, future transports) still needs to know
    // whether a capture is using the same dedicated browser profile. Closing
    // the login window must not terminate a live capture.
    if (this.browserLogin?.setCaptureActiveProvider) {
      this.browserLogin.setCaptureActiveProvider(() => this.#hasActiveCapture());
    }
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
  }

  #hasActiveCapture() {
    try {
      return this.#recordings().length > 0;
    } catch {
      return false;
    }
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'tiktok');
  }

  #recordingCapture(recording) {
    try {
      const active = this.sessionManager.getRecording?.(recording.sessionId);
      return active?.adapter?.snapshot?.() ?? null;
    } catch {
      return null;
    }
  }

  #retentionDays() {
    return TIKTOK_RAW_RETENTION_DAYS;
  }

  /** Which transport is configured, and whether it can be used right now. */
  transport() {
    const configured = String(this.settings?.get?.().tiktokTransport ?? 'auto');
    const requested = normalizeTikTokTransport(configured) ?? 'auto';
    const signerAvailable = Boolean(this.signer?.connect);
    // `TikTokBrowserRelay` exposes `createAdapter`, not `start`. Checking the
    // wrong member made an explicitly selected browser relay look
    // unconfigured, which is the real reason `connect` answered
    // TIKTOK_NOT_CONFIGURED after a successful login and room check.
    const browserAvailable = Boolean(this.browserRelay?.createAdapter);
    const active = requested === 'signer'
      ? (signerAvailable ? 'signer' : null)
      : requested === 'browser'
        ? (browserAvailable ? 'browser' : null)
        : (signerAvailable ? 'signer' : (browserAvailable ? 'browser' : null));
    const login = this.browserLogin?.status?.() ?? null;
    const profileOwned = Boolean(login?.profile?.owned);
    return {
      requested,
      active,
      signerAvailable,
      browserAvailable,
      browserRelayAvailable: browserAvailable,
      browserLoginState: login?.state ?? 'unavailable',
      browserReady: Boolean(login && login.state === TIKTOK_LOGIN_STATES.LOGGED_IN),
      profileOwned,
      captureActive: this.#hasActiveCapture(),
      revalidationRequired: Boolean(login?.revalidationRequired)
    };
  }

  /** Fresh login/capture view that never conflates login with event delivery. */
  #loginView() {
    const login = this.browserLogin?.status?.() ?? {
      state: 'unavailable',
      supported: false,
      browserOpen: false,
      error: null,
      capture: null
    };
    const recording = this.#recordings().at(-1) ?? null;
    return {
      ...login,
      verification: {
        account: {
          state: login?.state ?? 'unavailable',
          loggedIn: login?.state === TIKTOK_LOGIN_STATES.LOGGED_IN,
          browserOpen: Boolean(login?.browserOpen),
          verifiedAt: login?.verifiedAt ?? null,
          verifiedBy: login?.verifiedBy ?? null,
          revalidationRequired: Boolean(login?.revalidationRequired)
        },
        room: login?.room ?? null,
        capture: login?.capture ?? null,
        events: Number(login?.capture?.eventsReceived ?? 0),
        recording: {
          state: recording?.connection?.state ?? 'idle',
          sessionId: recording?.sessionId ?? null
        }
      }
    };
  }

  status() {
    const raw = this.#recordings();
    const recordings = raw.map((recording) => {
      const snapshot = this.#recordingCapture(recording);
      return {
        ...recording,
        capture: snapshot?.capture ?? null,
        tiktok: snapshot ? {
          counters: snapshot.counters ?? null,
          lastEventAt: snapshot.lastEventAt ?? null,
          gaps: snapshot.gaps ?? []
        } : null
      };
    });
    const latest = recordings.at(-1) ?? null;
    const transport = this.transport();
    const login = this.#loginView();
    const rateLimit = this.signer?.availability?.() ?? null;
    return {
      available: true,
      mode: transport.active ?? 'unavailable',
      transport,
      login,
      rateLimit,
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          uniqueId: latest.meta?.uniqueId ?? latest.platformRoomId,
          roomId: latest.platformRoomId,
          title: latest.meta?.room?.title ?? latest.roomTitle,
          viewers: latest.capture?.viewerCount ?? latest.connection.detail?.viewerCount ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, uniqueId: null, roomId: null, title: null, viewers: null, lastEnd: this.lastEnd},
      capture: latest?.capture ?? null,
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
      policy: this.db
        ? retentionStatus(this.db, {
          days: this.#retentionDays(),
          now: this.now(),
          platforms: ['tiktok'],
          policy: 'tiktok-raw-content'
        })
        : null,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        browserRequiresLogin: true,
        requiresPaidPlan: false,
        requiresCookie: false,
        liveOnly: true,
        stableUserId: true,
        messageId: true,
        roomMetadata: 'verified-public',
        giftCatalog: 'verified-public',
        chat: 'verified-real-sample',
        gifts: 'parsed-not-observed',
        giftStreak: 'parsed-not-observed',
        transportSigner: 'free-community-no-key',
        transportBrowser: 'experimental-login-required',
        loginRequiredForChat: transport.active === 'browser'
      }
    };
  }

  async checkRoom(input) {
    const parsed = parseTikTokInput(input);
    const room = await this.client.checkRoom(parsed);
    return roomView(room, input);
  }

  async #startWithRoom(room, {monitorTargetId = null, input = null} = {}) {
    if (!room?.isLive) {
      throw new TikTokError(TIKTOK_ERRORS.ROOM_OFFLINE, {
        messageKey: 'errors.tiktokRoomOffline',
        httpStatus: 409,
        details: {uniqueId: room?.uniqueId ?? null}
      });
    }
    const transport = this.transport();
    let adapter;
    if (!transport.active) {
      // A requested transport that exists but is unusable must not be reported
      // as "capture is not configured": that message told the user their login
      // and room check were meaningless. Keep the actionable cause instead.
      if (transport.requested === 'browser') {
        throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
          messageKey: 'errors.tiktokBrowserUnavailable',
          httpStatus: 503,
          details: {reason: 'relay_not_available'}
        });
      }
      if (transport.requested === 'signer') {
        throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
          messageKey: 'errors.tiktokSignerUnavailable',
          httpStatus: 502,
          details: {reason: 'signer_not_available'}
        });
      }
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokNotConfigured',
        httpStatus: 503,
        details: {requested: transport.requested, signerAvailable: transport.signerAvailable, browserAvailable: transport.browserAvailable}
      });
    }
    if (transport.active === 'browser') {
      if (!this.browserRelay?.createAdapter) {
        throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
          messageKey: 'errors.tiktokBrowserUnavailable',
          httpStatus: 503,
          details: {reason: 'relay_not_available'}
        });
      }
      const login = this.browserLogin?.status?.() ?? null;
      const loginState = login?.state ?? TIKTOK_LOGIN_STATES.UNAVAILABLE;
      const profileOwned = Boolean(login?.profile?.owned);
      if (!this.browserLogin) {
        throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
          messageKey: 'errors.tiktokBrowserUnavailable',
          httpStatus: 503,
          details: {reason: 'login_not_configured'}
        });
      }
      if (loginState === TIKTOK_LOGIN_STATES.UNAVAILABLE) {
        throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
          messageKey: 'errors.tiktokBrowserUnavailable',
          httpStatus: 503,
          details: {reason: 'login_unavailable'}
        });
      }
      if ([
        TIKTOK_LOGIN_STATES.OPENING,
        TIKTOK_LOGIN_STATES.WAITING,
        TIKTOK_LOGIN_STATES.VERIFYING
      ].includes(loginState)) {
        throw new TikTokError(TIKTOK_ERRORS.LOGIN_REQUIRED, {
          messageKey: 'errors.tiktokLoginRequired',
          httpStatus: 403,
          details: {reason: 'login_in_progress', loginState}
        });
      }
      // A persisted `logged_in` marker is only a hint. When the dedicated
      // profile still exists the relay is allowed to try: a stale cookie is
      // then reported as a real platform refusal instead of being trusted.
      if (loginState !== TIKTOK_LOGIN_STATES.LOGGED_IN && !profileOwned) {
        throw new TikTokError(TIKTOK_ERRORS.LOGIN_REQUIRED, {
          messageKey: 'errors.tiktokLoginRequired',
          httpStatus: 403,
          details: {reason: 'login_required', loginState}
        });
      }
      adapter = this.browserRelay.createAdapter({
        uniqueId: room.uniqueId,
        roomId: room.roomId,
        liveUrl: room.liveUrl,
        logger: this.logger,
        now: this.now
      });
    } else if (transport.active === 'signer') {
      adapter = new TikTokAdapter({
        uniqueId: room.uniqueId,
        roomId: room.roomId,
        client: this.client,
        signer: this.signer,
        logger: this.logger,
        now: this.now,
        ...(this.adapterOptions ? this.adapterOptions : {})
      });
    } else {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokNotConfigured',
        httpStatus: 503
      });
    }
    const identity = resolveBroadcasterIdentity({
      platform: 'tiktok',
      platformRoomId: room.roomId,
      broadcasterUid: room.anchorUid,
      broadcasterName: room.anchorName ?? room.uniqueId
    });
    let result;
    try {
      result = await this.sessionManager.startPlatform({
        platform: 'tiktok',
        platformRoomId: room.roomId,
        roomTitle: room.title ?? `TikTok ${room.anchorName ?? room.uniqueId}`,
        broadcasterName: room.anchorName ?? room.uniqueId,
        broadcasterUid: room.anchorUid,
        sourceQuality: SOURCE_QUALITY.VERIFIED,
        simulated: false,
        platformStartedAt: room.startedAt ?? null,
        monitorTargetId,
        createAdapter: () => adapter,
        meta: {
          room: {...room},
          uniqueId: room.uniqueId,
          roomId: room.roomId,
          transport: transport.active,
          broadcasterIdentity: identity.identity,
          input: input ?? null
        },
        onEnded: ({reason}) => {
          this.lastEnd = {reason, at: this.now(), transport: transport.active};
          this.#applyRetention();
        }
      });
    } catch (error) {
      // The adapter is the only component that actually talks to the logged-in
      // official page. Mirror its evidence back into the login badge so a stale
      // "logged in" marker cannot survive a 403/browser failure.
      if (transport.active === 'browser' && this.browserLogin) {
        if (error?.code === TIKTOK_ERRORS.LOGIN_REQUIRED) {
          this.browserLogin.markCaptureLoginRequired?.({
            roomEnterStatus: error?.details?.roomEnterStatus ?? 403,
            reason: error?.details?.reason ?? 'room_enter_403',
            uniqueId: room.uniqueId
          });
        } else if ([TIKTOK_ERRORS.BROWSER_FAILED, TIKTOK_ERRORS.BROWSER_UNAVAILABLE].includes(error?.code)) {
          this.browserLogin.markCaptureFailed?.({
            reason: error?.details?.reason ?? error?.code,
            uniqueId: room.uniqueId
          });
        }
      }
      throw error;
    }
    if (transport.active === 'browser' && this.browserLogin) {
      let capture = null;
      try {
        capture = adapter.capture?.() ?? adapter.snapshot?.()?.capture ?? null;
      } catch {
        capture = null;
      }
      if (capture?.roomEnterStatus === 403) {
        this.browserLogin.markCaptureLoginRequired?.({
          roomEnterStatus: 403,
          reason: 'room_enter_403',
          uniqueId: room.uniqueId
        });
      } else if (capture && (capture.eventsVerified === true || capture.roomEnterStatus === 200)) {
        this.browserLogin.markCaptureVerified?.({
          eventsReceived: Number(capture.counters?.messages ?? 0),
          roomEnterStatus: capture.roomEnterStatus ?? null,
          uniqueId: room.uniqueId,
          liveUrl: room.liveUrl ?? null
        });
      }
    }
    if (!result.started) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      throw duplicateRoomError(result.duplicate);
    }
    this.logger?.info({
      event: 'tiktok.session.started',
      sessionId: result.session.id,
      uniqueId: room.uniqueId,
      roomId: room.roomId,
      transport: transport.active,
      monitorTargetId: monitorTargetId ?? null
    });
    return {
      session: result.session,
      room: roomView(room, input),
      connection: adapter.capture?.() ?? adapter.snapshot()
    };
  }

  async connect(input) {
    const room = await this.checkRoom(input);
    return this.#startWithRoom(room, {input});
  }

  /** Start a capture discovered by the automatic monitor. */
  async connectDetected(observation, {monitorTargetId = null, input = null} = {}) {
    const uniqueId = String(observation?.uniqueId ?? observation?.targetKey ?? '').trim();
    const room = {
      uniqueId,
      roomId: String(observation?.roomId ?? ''),
      anchorUid: observation?.anchorUid ?? observation?.anchorId ?? null,
      anchorName: observation?.anchorName ?? observation?.channelTitle ?? uniqueId,
      isLive: observation?.status === 'live',
      status: observation?.roomStatus ?? null,
      title: observation?.title ?? null,
      startedAt: observation?.liveStartedAt ?? observation?.startedAt ?? null,
      totalViewers: observation?.totalViewers ?? null,
      likeCount: observation?.likeCount ?? null,
      checkedAt: observation?.observedAt ?? this.now(),
      liveUrl: `https://www.tiktok.com/@${uniqueId}/live`
    };
    if (!room.uniqueId || !room.roomId) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'detected_room_incomplete'}
      });
    }
    return this.#startWithRoom(room, {monitorTargetId, input: input ?? observation?.input ?? null});
  }

  async disconnect({sessionId = null} = {}) {
    const result = await this.sessionManager.stopPlatform('tiktok', {
      sessionId,
      status: 'ended',
      reason: 'user'
    });
    if (result.stopped) this.#applyRetention();
    return result;
  }

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {
      now: this.now(),
      days: this.#retentionDays(),
      platforms: ['tiktok'],
      logger: this.logger
    });
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {
      summary,
      status: this.db
        ? retentionStatus(this.db, {
          days: this.#retentionDays(),
          now: this.now(),
          platforms: ['tiktok'],
          policy: 'tiktok-raw-content'
        })
        : null
    };
  }

  /** Login lifecycle for the browser transport. */
  loginStatus() {
    if (!this.browserLogin) {
      return {
        state: 'unavailable',
        supported: false,
        browserOpen: false,
        error: {code: TIKTOK_ERRORS.BROWSER_UNAVAILABLE, reason: 'login_not_configured'},
        capture: null,
        verification: {
          account: {state: 'unavailable', loggedIn: false, browserOpen: false, verifiedAt: null, verifiedBy: null, revalidationRequired: false},
          room: null,
          capture: null,
          events: 0,
          recording: {state: this.#recordings().at(-1)?.connection?.state ?? 'idle', sessionId: this.#recordings().at(-1)?.sessionId ?? null}
        }
      };
    }
    return this.#loginView();
  }

  async loginStart({input = null, uniqueId = null} = {}) {
    if (!this.browserLogin) {
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
        messageKey: 'errors.tiktokBrowserUnavailable',
        httpStatus: 503
      });
    }
    let handle = uniqueId ? String(uniqueId).replace(/^@/, '') : null;
    if (input) handle = parseTikTokInput(input).uniqueId;
    return this.browserLogin.start({uniqueId: handle});
  }

  async loginVerify({input = null, uniqueId = null, timeoutMs = null} = {}) {
    if (!this.browserLogin) {
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
        messageKey: 'errors.tiktokBrowserUnavailable',
        httpStatus: 503
      });
    }
    let handle = uniqueId ? String(uniqueId).replace(/^@/, '') : null;
    if (input) handle = parseTikTokInput(input).uniqueId;
    const login = await this.browserLogin.verify({
      uniqueId: handle,
      ...(Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? {timeoutMs: Number(timeoutMs)} : {})
    });
    return this.#mergeLoginView(login);
  }

  #mergeLoginView(login) {
    const base = this.#loginView();
    return {
      ...base,
      ...login,
      verification: {
        ...base.verification,
        account: {
          state: login?.state ?? base.state,
          loggedIn: (login?.state ?? base.state) === TIKTOK_LOGIN_STATES.LOGGED_IN,
          browserOpen: Boolean(login?.browserOpen),
          verifiedAt: login?.verifiedAt ?? base.verifiedAt ?? null,
          verifiedBy: login?.verifiedBy ?? base.verifiedBy ?? null,
          revalidationRequired: Boolean(login?.revalidationRequired)
        },
        room: login?.room ?? base.verification.room,
        capture: login?.capture ?? base.verification.capture,
        events: Number(login?.capture?.eventsReceived ?? base.verification.events ?? 0)
      }
    };
  }

  async loginCancel() {
    if (!this.browserLogin) return this.loginStatus();
    return this.#mergeLoginView(await this.browserLogin.cancel());
  }

  async loginLogout() {
    if (!this.browserLogin) return this.loginStatus();
    return this.#mergeLoginView(await this.browserLogin.logout());
  }

  async shutdown() {
    try {
      await this.browserRelay?.stop?.();
    } catch (error) {
      this.logger?.warn({event: 'tiktok.relay.shutdown.failed', code: error?.code ?? 'unknown'});
    }
    try {
      if (this.browserLogin) await this.browserLogin.shutdown();
      else await this.browserRelay?.closeBrowser?.();
    } catch (error) {
      this.logger?.warn({event: 'tiktok.login.shutdown.failed', code: error?.code ?? 'unknown'});
    }
  }
}

export const __internal = {HTTP_BY_CODE, roomView};
