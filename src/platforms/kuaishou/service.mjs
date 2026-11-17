import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';
import {parseKuaishouInput} from './link.mjs';
import {KuaishouAdapter} from './adapter.mjs';
import {KUAISHOU_IDENTITY} from './messages.mjs';
import {assertCollectionAllowed, publicAccess} from './policy.mjs';
import {ROOM_STATUS, assertLiveStatus, detectKuaishouStatus} from './status.mjs';

/**
 * Glue between HTTP routes, the Kuaishou public H5 page/feed and SessionManager.
 *
 * Live collection is disabled unless `access.enabled` is true. Even when it is
 * enabled, there is no login, cookie, API key, browser relay or third-party
 * service. The H5 route is unofficial and may change or stop working; the UI
 * says so and the API never reports a failed capture as success.
 */

export const KUAISHOU_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [KUAISHOU_ERRORS.LINK_INVALID, [400, 'errors.kuaishouLinkInvalid']],
  [KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED, [403, 'errors.kuaishouAuthorizationRequired']],
  [KUAISHOU_ERRORS.ACCESS_DENIED, [403, 'errors.kuaishouAccessDenied']],
  [KUAISHOU_ERRORS.ROOM_NOT_FOUND, [404, 'errors.kuaishouRoomNotFound']],
  [KUAISHOU_ERRORS.ROOM_OFFLINE, [409, 'errors.kuaishouRoomOffline']],
  [KUAISHOU_ERRORS.RATE_LIMITED, [429, 'errors.kuaishouRateLimit']],
  [KUAISHOU_ERRORS.RISK_CONTROL, [403, 'errors.kuaishouAccessDenied']],
  [KUAISHOU_ERRORS.NETWORK, [502, 'errors.kuaishouNetwork']],
  [KUAISHOU_ERRORS.TIMEOUT, [504, 'errors.kuaishouConnectTimeout']],
  [KUAISHOU_ERRORS.HTTP, [502, 'errors.kuaishouProtocol']],
  [KUAISHOU_ERRORS.UPSTREAM, [502, 'errors.kuaishouProtocol']],
  [KUAISHOU_ERRORS.PROTOCOL, [502, 'errors.kuaishouProtocol']],
  [KUAISHOU_ERRORS.STATUS_UNKNOWN, [409, 'errors.kuaishouStatusUnknown']],
  [KUAISHOU_ERRORS.NOT_CONFIGURED, [503, 'errors.kuaishouNotConfigured']],
  [KUAISHOU_ERRORS.STOPPED, [409, 'errors.kuaishouStopped']]
]);

export function toApiError(error) {
  const entry = HTTP_BY_CODE.get(error?.code);
  if (entry && (!error.messageKey || error.messageKey === error.code)) {
    return new AppError(error.code, {
      messageKey: entry[1],
      httpStatus: entry[0],
      details: error?.details ?? null,
      cause: error
    });
  }
  if (error instanceof AppError) return error;
  return new AppError('KUAISHOU_ERROR', {
    messageKey: 'errors.kuaishouError',
    httpStatus: 502,
    cause: error
  });
}

function identityView() {
  return {
    mode: KUAISHOU_IDENTITY.MODE,
    stableUserId: KUAISHOU_IDENTITY.STABLE_USER_ID,
    messageId: KUAISHOU_IDENTITY.MESSAGE_ID,
    scope: 'session',
    noteKey: 'live.source.kuaishouIdentityNote'
  };
}

function roomView(parsed, status, {access, now} = {}) {
  const live = status?.state === ROOM_STATUS.LIVE;
  const recordable = Boolean(access?.enabled && live);
  let reason = null;
  if (!access?.enabled) reason = KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED;
  else if (status?.state === ROOM_STATUS.OFFLINE) reason = KUAISHOU_ERRORS.ROOM_OFFLINE;
  else if (status?.state === ROOM_STATUS.NOT_FOUND) reason = KUAISHOU_ERRORS.ROOM_NOT_FOUND;
  else if (status?.state === ROOM_STATUS.RATE_LIMITED) reason = KUAISHOU_ERRORS.RATE_LIMITED;
  else if (status && !live) reason = KUAISHOU_ERRORS.STATUS_UNKNOWN;
  return {
    platform: 'kuaishou',
    eid: parsed.eid,
    source: parsed.source,
    liveUrl: parsed.liveUrl,
    h5ShareUrl: parsed.h5ShareUrl,
    isLive: live ? true : (status?.state === ROOM_STATUS.OFFLINE ? false : null),
    liveStatus: status?.state ?? 'unknown',
    liveStreamId: status?.liveStreamId ?? null,
    title: status?.title ?? null,
    checkedAt: status?.checkedAt ?? now(),
    recordable,
    reason,
    authorization: publicAccess(access),
    identity: identityView(),
    capabilities: {
      chat: 'verified-research-sample',
      gifts: 'not-observed',
      likes: 'not-observed',
      stableUserId: KUAISHOU_IDENTITY.STABLE_USER_ID,
      messageId: KUAISHOU_IDENTITY.MESSAGE_ID
    }
  };
}

export class KuaishouService {
  constructor({
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    access = null,
    fetchImpl = globalThis.fetch,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.access = access ?? {enabled: false, status: 'authorization-required', authorizationRequired: true};
    this.fetchImpl = fetchImpl;
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
    this.lastCapture = null;
  }

  #recordings() {
    return this.sessionManager.listRecordings()
      .filter((recording) => recording.platform === 'kuaishou')
      .map((recording) => {
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
      protocol: 'kuaishou-h5',
      mode: 'anonymous-h5',
      unofficial: true,
      authorizationRequired: !this.access?.enabled,
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
    const access = publicAccess(this.access);
    return {
      available: true,
      platform: 'kuaishou',
      access,
      notice: {
        key: 'live.source.kuaishouNotice',
        authorizationRequired: access.authorizationRequired
      },
      transport: this.transport(),
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          eid: latest.meta?.eid ?? null,
          liveStreamId: latest.meta?.liveStreamId ?? null,
          title: latest.roomTitle,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, eid: null, liveStreamId: null, title: null, lastEnd: this.lastEnd},
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
          days: KUAISHOU_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['kuaishou'],
          policy: 'kuaishou-raw-content'
        })
        : null,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        requiresCookie: false,
        requiresPaidPlan: false,
        requiresBrowser: false,
        authorizationRequired: access.authorizationRequired,
        liveOnly: true,
        chat: 'verified-research-sample',
        gifts: 'not-observed',
        likes: 'not-observed',
        stableUserId: KUAISHOU_IDENTITY.STABLE_USER_ID,
        identityMode: KUAISHOU_IDENTITY.MODE,
        messageId: KUAISHOU_IDENTITY.MESSAGE_ID,
        captureWithoutAuthorization: false
      }
    };
  }

  /** Room lookup. Parsing works while collection is disabled; no request is made. */
  async checkRoom(input) {
    const parsed = parseKuaishouInput(input);
    if (!this.access?.enabled) {
      return roomView(parsed, null, {access: this.access, now: this.now});
    }
    const status = await this.observeRoom(parsed.eid);
    return roomView(parsed, status, {access: this.access, now: this.now});
  }

  /** Read one room-specific public page. Requires authorised collection. */
  async observeRoom(eid) {
    assertCollectionAllowed(this.access);
    return detectKuaishouStatus(eid, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      ...(this.adapterOptions?.timeoutMs ? {timeoutMs: this.adapterOptions.timeoutMs} : {}),
      ...(this.adapterOptions?.userAgent ? {userAgent: this.adapterOptions.userAgent} : {})
    });
  }

  async #startWithRoom(parsed, status, {monitorTargetId = null, input = null} = {}) {
    assertCollectionAllowed(this.access);
    assertLiveStatus(status);
    let adapter = null;
    const identity = resolveBroadcasterIdentity({
      platform: 'kuaishou',
      platformRoomId: parsed.eid,
      broadcasterUid: parsed.eid,
      broadcasterName: parsed.eid
    });
    let result;
    try {
      result = await this.sessionManager.startPlatform({
        platform: 'kuaishou',
        platformRoomId: parsed.eid,
        roomTitle: status?.title ?? `Kuaishou ${parsed.eid}`,
        broadcasterName: parsed.eid,
        broadcasterUid: parsed.eid,
        sourceQuality: SOURCE_QUALITY.UNKNOWN,
        simulated: false,
        platformStartedAt: null,
        monitorTargetId,
        createAdapter: ({sessionId}) => {
          adapter = new KuaishouAdapter({
            eid: parsed.eid,
            liveStreamId: status.liveStreamId,
            sessionId,
            access: this.access,
            fetchImpl: this.fetchImpl,
            logger: this.logger,
            now: this.now,
            ...(this.adapterOptions ? {options: this.adapterOptions} : {})
          });
          return adapter;
        },
        meta: {
          eid: parsed.eid,
          liveStreamId: status.liveStreamId,
          transport: 'h5-feed',
          protocol: 'kuaishou-h5',
          identityMode: KUAISHOU_IDENTITY.MODE,
          broadcasterIdentity: identity.identity,
          input: input ?? null
        },
        onEnded: ({reason}) => {
          this.lastEnd = {reason, at: this.now(), transport: 'kuaishou-h5'};
          this.#applyRetention();
        }
      });
    } catch (error) {
      this.lastCapture = {
        transport: 'kuaishou-h5-feed',
        protocol: 'kuaishou-h5',
        state: error?.code === KUAISHOU_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        category: error?.code === KUAISHOU_ERRORS.ROOM_OFFLINE ? 'ended' : 'failed',
        captureState: error?.code === KUAISHOU_ERRORS.ROOM_OFFLINE ? 'platform_ended' : 'error',
        reason: error?.code ?? 'connect_failed',
        eventsReceived: 0,
        eventsVerified: false,
        eid: parsed.eid,
        checkedAt: this.now()
      };
      throw error;
    }
    if (!result.started) {
      try {
        await adapter?.stop();
      } catch {
        /* ignore */
      }
      throw duplicateRoomError(result.duplicate);
    }
    this.lastCapture = null;
    this.logger?.info({
      event: 'kuaishou.session.started',
      sessionId: result.session.id,
      eid: parsed.eid,
      liveStreamId: status.liveStreamId
    });
    return {session: result.session, room: roomView(parsed, status, {access: this.access, now: this.now}), connection: adapter?.capture?.() ?? null};
  }

  async connect(input) {
    assertCollectionAllowed(this.access);
    const parsed = parseKuaishouInput(input);
    const status = await this.observeRoom(parsed.eid);
    return this.#startWithRoom(parsed, status, {input: String(input ?? '')});
  }

  /**
   * Start a capture discovered by the monitoring scheduler.
   * The detector already confirmed `live` and carries the current stream id.
   */
  async connectDetected(observation, {monitorTargetId = null, input = null} = {}) {
    assertCollectionAllowed(this.access);
    const eid = String(observation?.eid ?? observation?.targetKey ?? '').trim();
    const liveStreamId = String(observation?.liveStreamId ?? observation?.liveId ?? '').trim();
    if (!eid || !liveStreamId) {
      throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
        httpStatus: 502,
        details: {reason: 'detected_room_incomplete'},
        retryable: false
      });
    }
    const parsed = parseKuaishouInput(eid);
    const status = {
      state: ROOM_STATUS.LIVE,
      liveStreamId,
      title: observation?.title ?? observation?.channelTitle ?? null,
      checkedAt: this.now()
    };
    return this.#startWithRoom(parsed, status, {
      monitorTargetId,
      input: input ?? observation?.input ?? null
    });
  }

  async disconnect({sessionId = null} = {}) {
    const result = await this.sessionManager.stopPlatform('kuaishou', {
      sessionId,
      status: 'ended',
      reason: 'user'
    });
    if (result.stopped) this.#applyRetention();
    if (result.stopped && this.#recordings().length === 0) {
      this.lastCapture = {
        transport: 'kuaishou-h5-feed',
        protocol: 'kuaishou-h5',
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
      days: KUAISHOU_RAW_RETENTION_DAYS,
      platforms: ['kuaishou'],
      logger: this.logger
    });
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {
      summary,
      status: this.db
        ? retentionStatus(this.db, {
          days: KUAISHOU_RAW_RETENTION_DAYS,
          now: this.now(),
          platforms: ['kuaishou'],
          policy: 'kuaishou-raw-content'
        })
        : null
    };
  }

  async shutdown() {
    return true;
  }
}

export const __internal = {HTTP_BY_CODE, roomView, identityView};
