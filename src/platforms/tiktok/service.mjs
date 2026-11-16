import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {TikTokClient} from './client.mjs';
import {TikTokLocalAdapter} from './local-adapter.mjs';
import {parseTikTokInput} from './link.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {TtwidProvider} from './webcast.mjs';
import {createTtwidStore} from './state.mjs';
import {cleanupLegacyTikTokArtifacts} from './legacy-cleanup.mjs';

/**
 * Glue between HTTP routes, the public TikTok metadata client, the anonymous
 * local WebSocket capture and SessionManager.
 *
 * One capture path only: `local`. It connects to TikTok's webcast WebSocket with
 * an anonymous `ttwid` device cookie — no account, no OAuth, no cookie jar, no
 * paid signing service and no browser automation. Room metadata and the gift
 * catalog come from TikTok's public HTTP endpoints.
 *
 * This uses TikTok's private web protocol, not an official API: it is labelled
 * "unofficial / experimental" everywhere it is user-visible, can stop working
 * when TikTok changes the protocol, and has no resume cursor (events during a
 * reconnect can be missed; duplicates are removed by message id).
 *
 * The retired browser relay, login and free community signer paths were removed
 * after the local path passed real acceptance; `legacyCleanup` below removes the
 * leftover dedicated browser profile and login marker from older installs.
 */

export const TIKTOK_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [TIKTOK_ERRORS.LINK_INVALID, [400, 'errors.tiktokLinkInvalid']],
  [TIKTOK_ERRORS.ROOM_NOT_FOUND, [404, 'errors.tiktokRoomNotFound']],
  [TIKTOK_ERRORS.ROOM_OFFLINE, [409, 'errors.tiktokRoomOffline']],
  [TIKTOK_ERRORS.ROOM_UNAVAILABLE, [403, 'errors.tiktokRoomUnavailable']],
  [TIKTOK_ERRORS.RATE_LIMITED, [429, 'errors.tiktokRateLimit']],
  [TIKTOK_ERRORS.NETWORK, [502, 'errors.tiktokNetwork']],
  [TIKTOK_ERRORS.PROTOCOL, [502, 'errors.tiktokProtocol']],
  [TIKTOK_ERRORS.CONNECT_TIMEOUT, [504, 'errors.tiktokConnectTimeout']],
  [TIKTOK_ERRORS.SOCKET_FAILED, [502, 'errors.tiktokSocketFailed']],
  [TIKTOK_ERRORS.NOT_CONFIGURED, [503, 'errors.tiktokNotConfigured']],
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
    ttwidProvider = null,
    dataDir = null,
    adapterOptions = null,
    WebSocketImpl = globalThis.WebSocket
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.dataDir = dataDir;
    this.WebSocketImpl = WebSocketImpl;
    this.client = client ?? new TikTokClient({fetchImpl, now});
    // One anonymous device cookie for every room in this process: fewer page
    // requests, and TikTok throttles bursts of them.
    this.ttwidProvider = ttwidProvider ?? new TtwidProvider({
      fetchImpl,
      now,
      logger,
      store: dataDir ? createTtwidStore(dataDir) : null
    });
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
    // The last capture result no longer backed by an active recording, so a
    // failed or stopped start does not look identical to "idle".
    this.lastCapture = null;
    this.legacyCleanup = null;
    this.startedAt = null;
  }

  /**
   * One-time startup work: restore the cached anonymous cookie and remove
   * retired browser-relay artifacts from older installs. Both are best-effort
   * and never block the server from starting.
   */
  async startup() {
    this.startedAt = this.now();
    try {
      await this.ttwidProvider.load?.();
    } catch (error) {
      this.logger?.warn({event: 'tiktok.ttwid.restore_failed', code: error?.code ?? 'unknown'});
    }
    try {
      this.legacyCleanup = cleanupLegacyTikTokArtifacts(this.dataDir, {logger: this.logger});
    } catch (error) {
      this.legacyCleanup = {removed: [], skipped: [], errors: [{reason: error?.code ?? 'cleanup_failed'}]};
      this.logger?.warn({event: 'tiktok.legacy.cleanup.failed', code: error?.code ?? 'unknown'});
    }
    return {ttwid: this.ttwidProvider.snapshot?.() ?? null, legacyCleanup: this.legacyCleanup};
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

  /**
   * The single capture transport. Kept as a method because routes and the UI
   * show it; it no longer offers a choice, and never silently switches.
   */
  transport() {
    return {
      requested: 'local',
      active: 'local',
      protocol: 'webcast-ws',
      unofficial: true,
      requiresLogin: false,
      requiresPaidService: false,
      requiresBrowser: false,
      captureActive: this.#recordings().length > 0,
      ttwid: this.ttwidProvider.snapshot?.() ?? null
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
    // A recording can also be stopped through the shared live/history stop
    // action, which bypasses `disconnect()`. Reflect that end so the capture
    // card never falls back to "not started" right after a real recording.
    const lastEndCapture = (!latest && !this.lastCapture && this.lastEnd?.transport === 'local')
      ? {
        transport: 'local',
        state: 'stopped',
        category: this.lastEnd.reason === 'platform_ended' ? 'ended' : 'stopped',
        captureState: this.lastEnd.reason === 'platform_ended' ? 'platform_ended' : 'stopped',
        reason: this.lastEnd.reason,
        eventsReceived: 0,
        eventsVerified: false,
        checkedAt: this.lastEnd.at
      }
      : null;
    const lastCapture = this.lastCapture ?? lastEndCapture;
    return {
      available: true,
      mode: 'local',
      transport,
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
      capture: latest?.capture ?? lastCapture,
      captureSource: latest?.capture
        ? 'recording'
        : (lastCapture ? 'last_attempt' : null),
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
      ttwid: this.ttwidProvider.snapshot?.() ?? null,
      legacyCleanup: this.legacyCleanup,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        requiresCookie: false,
        requiresPaidPlan: false,
        requiresSigningService: false,
        requiresBrowser: false,
        liveOnly: true,
        stableUserId: true,
        messageId: true,
        roomMetadata: 'verified-public',
        giftCatalog: 'verified-public',
        chat: 'verified-real-sample',
        gifts: 'observed-or-not-observed-per-run',
        giftStreak: 'merged-by-group'
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
    const adapter = new TikTokLocalAdapter({
      uniqueId: room.uniqueId,
      roomId: room.roomId,
      client: this.client,
      ttwidProvider: this.ttwidProvider,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now,
      ...(this.adapterOptions ? this.adapterOptions : {})
    });
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
          transport: 'local',
          protocol: 'webcast-ws',
          broadcasterIdentity: identity.identity,
          input: input ?? null
        },
        onEnded: ({reason}) => {
          this.lastEnd = {reason, at: this.now(), transport: 'local'};
          this.#applyRetention();
        }
      });
    } catch (error) {
      this.lastCapture = {
        transport: 'local',
        state: error?.code === TIKTOK_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        category: error?.code === TIKTOK_ERRORS.ROOM_OFFLINE ? 'ended' : 'failed',
        captureState: error?.code === TIKTOK_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        reason: error?.code ?? 'connect_failed',
        eventsReceived: 0,
        eventsVerified: false,
        uniqueId: room.uniqueId,
        liveUrl: room.liveUrl ?? null,
        checkedAt: this.now()
      };
      throw error;
    }
    if (!result.started) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      throw duplicateRoomError(result.duplicate);
    }
    this.lastCapture = null;
    this.logger?.info({
      event: 'tiktok.session.started',
      sessionId: result.session.id,
      uniqueId: room.uniqueId,
      roomId: room.roomId,
      transport: 'local',
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
    if (result.stopped && !this.#recordings().length) {
      this.lastCapture = {
        transport: 'local',
        state: 'stopped',
        category: 'stopped',
        captureState: 'stopped',
        reason: 'user',
        eventsReceived: 0,
        eventsVerified: false,
        checkedAt: this.now()
      };
    }
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

  /** No background browser/login process exists for TikTok any more. */
  async shutdown() {
    return true;
  }
}

export const __internal = {HTTP_BY_CODE, roomView};
