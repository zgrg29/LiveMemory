import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {TikTokClient} from './client.mjs';
import {TikTokSigner} from './signer.mjs';
import {TikTokAdapter} from './adapter.mjs';
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
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'tiktok');
  }

  #retentionDays() {
    return TIKTOK_RAW_RETENTION_DAYS;
  }

  /** Which transport is configured, and whether it can be used right now. */
  transport() {
    const configured = String(this.settings?.get?.().tiktokTransport ?? 'auto');
    const requested = normalizeTikTokTransport(configured) ?? 'auto';
    const signerAvailable = Boolean(this.signer?.connect);
    const browserAvailable = Boolean(this.browserRelay?.start);
    const active = requested === 'signer'
      ? (signerAvailable ? 'signer' : null)
      : requested === 'browser'
        ? (browserAvailable ? 'browser' : null)
        : (signerAvailable ? 'signer' : (browserAvailable ? 'browser' : null));
    return {requested, active, signerAvailable, browserAvailable};
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    const transport = this.transport();
    return {
      available: true,
      mode: transport.active ?? 'unavailable',
      transport,
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          uniqueId: latest.meta?.uniqueId ?? latest.platformRoomId,
          roomId: latest.platformRoomId,
          title: latest.meta?.room?.title ?? latest.roomTitle,
          viewers: latest.connection.detail?.viewerCount ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, uniqueId: null, roomId: null, title: null, viewers: null, lastEnd: this.lastEnd},
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
    if (transport.active === 'browser') {
      if (!this.browserRelay?.createAdapter) {
        throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
          messageKey: 'errors.tiktokBrowserUnavailable',
          httpStatus: 503
        });
      }
      adapter = this.browserRelay.createAdapter({
        uniqueId: room.uniqueId,
        roomId: room.roomId,
        client: this.client,
        logger: this.logger,
        now: this.now,
        ...(this.adapterOptions ? this.adapterOptions : {})
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
    const result = await this.sessionManager.startPlatform({
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
      connection: adapter.snapshot()
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

  async shutdown() {
    try {
      await this.browserRelay?.stop?.();
    } catch (error) {
      this.logger?.warn({event: 'tiktok.relay.shutdown.failed', code: error?.code ?? 'unknown'});
    }
  }
}

export const __internal = {HTTP_BY_CODE, roomView};
