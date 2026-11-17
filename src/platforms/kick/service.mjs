import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {KICK_ERRORS, KickError} from './errors.mjs';
import {KickHttp} from './http.mjs';
import {KickAdapter} from './adapter.mjs';
import {parseKickInput} from './link.mjs';
import {resolveChannel} from './transport.mjs';

/**
 * Glue between HTTP routes, the Kick public endpoints and SessionManager.
 *
 * One capture path: the anonymous Centrifugo feed. No account, no cookie, no
 * API key and no third-party service. Kick's own web endpoints are unofficial:
 * they can change without notice, so every failure is reported as itself and is
 * never turned into a fake success. There is no replay cursor, so a reconnect
 * can miss messages; duplicates are removed by message/transaction id.
 */

export const KICK_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [KICK_ERRORS.LINK_INVALID, [400, 'errors.kickLinkInvalid']],
  [KICK_ERRORS.ROOM_NOT_FOUND, [404, 'errors.kickRoomNotFound']],
  [KICK_ERRORS.ROOM_OFFLINE, [409, 'errors.kickRoomOffline']],
  [KICK_ERRORS.ROOM_UNAVAILABLE, [403, 'errors.kickRoomUnavailable']],
  [KICK_ERRORS.BLOCKED, [403, 'errors.kickBlocked']],
  [KICK_ERRORS.RATE_LIMITED, [429, 'errors.kickRateLimit']],
  [KICK_ERRORS.NETWORK, [502, 'errors.kickNetwork']],
  [KICK_ERRORS.PROTOCOL, [502, 'errors.kickProtocol']],
  [KICK_ERRORS.CONNECT_TIMEOUT, [504, 'errors.kickConnectTimeout']],
  [KICK_ERRORS.SOCKET_FAILED, [502, 'errors.kickSocketFailed']],
  [KICK_ERRORS.NOT_CONFIGURED, [503, 'errors.kickNotConfigured']],
  [KICK_ERRORS.STOPPED, [409, 'errors.kickStopped']]
]);

export function toApiError(error) {
  const entry = HTTP_BY_CODE.get(error?.code);
  // Platform errors are created without a message key; map them here so the UI
  // always receives a translatable key instead of a bare code.
  if (entry && (!error.messageKey || error.messageKey === error.code)) {
    return new AppError(error.code, {
      messageKey: entry[1],
      httpStatus: entry[0],
      details: error?.details ?? null,
      cause: error
    });
  }
  if (error instanceof AppError) return error;
  return new AppError('KICK_ERROR', {messageKey: 'errors.kickError', httpStatus: 502, cause: error});
}

function roomView(channel, input) {
  return {
    slug: channel.slug,
    channelId: channel.channelId,
    chatroomId: channel.chatroomId,
    userId: channel.userId ?? null,
    isLive: Boolean(channel.isLive),
    title: channel.title ?? null,
    startedAt: channel.startedAt ?? null,
    viewerCount: channel.viewerCount ?? null,
    followersCount: channel.followersCount ?? null,
    checkedAt: Date.now(),
    input: String(input ?? ''),
    liveUrl: `https://kick.com/${channel.slug}`,
    recordable: Boolean(channel.isLive),
    reason: channel.isLive ? null : KICK_ERRORS.ROOM_OFFLINE
  };
}

export class KickService {
  constructor({
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    http = null,
    WebSocketImpl = globalThis.WebSocket,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.http = http ?? new KickHttp({logger, now});
    this.ownsHttp = !http;
    this.WebSocketImpl = WebSocketImpl;
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
    this.lastCapture = null;
  }

  #http() {
    return this.http;
  }

  /** One public channel observation; used by the manual check and the monitor. */
  async observeChannel(slug) {
    return resolveChannel(this.http, slug);
  }

  #recordings() {
    return this.sessionManager.listRecordings()
      .filter((recording) => recording.platform === 'kick')
      .map((recording) => {
        // Internal recordings hold the adapter (and its socket); never spread
        // them into an API payload. Only the public fields plus the capture
        // summary leave the server.
        const row = this.db
          ? this.db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(recording.sessionId)
          : null;
        return {
          sessionId: recording.sessionId,
          platform: recording.platform,
          platformRoomId: recording.platformRoomId,
          roomTitle: recording.roomTitle,
          broadcasterName: recording.broadcasterName,
          broadcasterId: recording.broadcasterId,
          broadcasterIdentity: recording.broadcasterIdentity,
          startedAt: recording.startedAt,
          messageCount: Number(row?.message_count ?? 0),
          uniqueViewerCount: null,
          connection: {state: recording.connection, detail: recording.detail ?? null},
          meta: recording.meta ?? null,
          capture: this.#recordingCapture(recording)
        };
      });
  }

  #recordingCapture(recording) {
    try {
      const active = this.sessionManager.getRecording?.(recording.sessionId);
      return active?.adapter?.capture?.() ?? active?.adapter?.snapshot?.() ?? null;
    } catch {
      return null;
    }
  }

  transport() {
    return {
      protocol: 'kick-centrifugo',
      unofficial: true,
      requiresLogin: false,
      requiresCookie: false,
      requiresApiKey: false,
      requiresPaidService: false,
      requiresBrowser: false,
      captureActive: this.#recordings().length > 0
    };
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    return {
      available: true,
      transport: this.transport(),
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          slug: latest.meta?.slug ?? null,
          channelId: latest.platformRoomId,
          chatroomId: latest.meta?.chatroomId ?? null,
          title: latest.roomTitle,
          viewers: latest.meta?.room?.viewerCount ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, slug: null, channelId: null, chatroomId: null, title: null, viewers: null, lastEnd: this.lastEnd},
      capture: latest?.capture ?? this.lastCapture,
      captureSource: latest?.capture ? 'recording' : (this.lastCapture ? 'last_attempt' : null),
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
          days: KICK_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['kick'],
          policy: 'kick-raw-content'
        })
        : null,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        requiresCookie: false,
        requiresPaidPlan: false,
        requiresBrowser: false,
        liveOnly: true,
        stableUserId: true,
        messageId: true,
        chat: 'verified-real-sample',
        emotes: 'verified-real-sample',
        gifts: 'verified-real-sample',
        giftedSubscriptions: 'verified-real-sample',
        subscriptions: 'not-observed',
        moderation: 'observed-counted-not-timeline',
        follow: 'unsupported-local'
      }
    };
  }

  async checkRoom(input) {
    const parsed = parseKickInput(input);
    const channel = await resolveChannel(this.#http(), parsed.slug);
    return roomView(channel, input);
  }

  async #startWithRoom(room, {monitorTargetId = null, input = null} = {}) {
    if (!room?.isLive) {
      throw new KickError(KICK_ERRORS.ROOM_OFFLINE, {httpStatus: 409, details: {slug: room?.slug ?? null}});
    }
    const adapter = new KickAdapter({
      slug: room.slug,
      channel: {
        slug: room.slug,
        channelId: room.channelId,
        chatroomId: room.chatroomId,
        userId: room.userId,
        isLive: room.isLive,
        title: room.title,
        startedAt: room.startedAt,
        viewerCount: room.viewerCount
      },
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now,
      http: this.http,
      ...(this.adapterOptions ? {options: this.adapterOptions} : {})
    });
    const identity = resolveBroadcasterIdentity({
      platform: 'kick',
      platformRoomId: room.channelId,
      broadcasterUid: room.userId ?? room.channelId,
      broadcasterName: room.slug
    });
    let result;
    try {
      result = await this.sessionManager.startPlatform({
        platform: 'kick',
        platformRoomId: room.channelId,
        roomTitle: room.title ?? `Kick ${room.slug}`,
        broadcasterName: room.slug,
        broadcasterUid: room.userId ?? room.channelId,
        sourceQuality: SOURCE_QUALITY.VERIFIED,
        simulated: false,
        platformStartedAt: room.startedAt ?? null,
        monitorTargetId,
        createAdapter: () => adapter,
        meta: {
          slug: room.slug,
          channelId: room.channelId,
          chatroomId: room.chatroomId,
          room: {...room},
          transport: 'centrifugo',
          protocol: 'kick-centrifugo',
          broadcasterIdentity: identity.identity,
          input: input ?? null
        },
        onEnded: ({reason}) => {
          this.lastEnd = {reason, at: this.now(), transport: 'centrifugo'};
          this.#applyRetention();
        }
      });
    } catch (error) {
      this.lastCapture = {
        transport: 'centrifugo-ws',
        protocol: 'kick-centrifugo',
        state: error?.code === KICK_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        category: error?.code === KICK_ERRORS.ROOM_OFFLINE ? 'ended' : 'failed',
        captureState: error?.code === KICK_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        reason: error?.code ?? 'connect_failed',
        eventsReceived: 0,
        eventsVerified: false,
        slug: room.slug,
        channelId: room.channelId,
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
      event: 'kick.session.started',
      sessionId: result.session.id,
      slug: room.slug,
      channelId: room.channelId,
      chatroomId: room.chatroomId
    });
    return {
      session: result.session,
      room,
      connection: adapter.capture()
    };
  }

  async connect(input) {
    const room = await this.checkRoom(input);
    return this.#startWithRoom(room, {input});
  }

  /**
   * Start a capture discovered by the monitoring scheduler.
   *
   * The observation comes from the Kick detector (public channel JSON), which
   * already confirmed `live`. The room identity is built here so the session,
   * metadata and broadcaster identity match a manual start exactly.
   */
  async connectDetected(observation, {monitorTargetId = null, input = null} = {}) {
    const slug = String(
      observation?.slug
      ?? observation?.targetKey
      ?? observation?.meta?.slug
      ?? ''
    ).trim();
    const channelId = observation?.channelId === undefined || observation?.channelId === null
      ? null
      : String(observation.channelId);
    const chatroomId = observation?.chatroomId === undefined || observation?.chatroomId === null
      ? null
      : String(observation.chatroomId);
    if (!slug || !channelId || !chatroomId) {
      throw new KickError(KICK_ERRORS.PROTOCOL, {httpStatus: 502, details: {reason: 'detected_room_incomplete'}});
    }
    const room = {
      slug,
      channelId,
      chatroomId,
      userId: observation?.anchorUid === undefined || observation?.anchorUid === null
        ? null
        : String(observation.anchorUid),
      isLive: true,
      title: observation?.title ?? observation?.channelTitle ?? null,
      startedAt: observation?.liveStartedAt ?? observation?.startedAt ?? null,
      viewerCount: observation?.viewerCount ?? null,
      followersCount: null,
      recordable: true,
      reason: null,
      liveUrl: `https://kick.com/${slug}`,
      input: input ?? observation?.input ?? null
    };
    return this.#startWithRoom(room, {monitorTargetId, input: room.input});
  }

  async disconnect({sessionId = null} = {}) {
    const result = await this.sessionManager.stopPlatform('kick', {
      sessionId,
      status: 'ended',
      reason: 'user'
    });
    if (result.stopped) this.#applyRetention();
    if (result.stopped && this.#recordings().length === 0) {
      this.lastCapture = {
        transport: 'centrifugo-ws',
        protocol: 'kick-centrifugo',
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
      days: KICK_RAW_RETENTION_DAYS,
      platforms: ['kick'],
      logger: this.logger
    });
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {
      summary,
      status: this.db
        ? retentionStatus(this.db, {
          days: KICK_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['kick'],
          policy: 'kick-raw-content'
        })
        : null
    };
  }

  async shutdown() {
    if (this.ownsHttp) {
      try {
        await this.http.close();
      } catch {
        /* ignore */
      }
    }
    return true;
  }
}

export const __internal = {HTTP_BY_CODE, roomView};
