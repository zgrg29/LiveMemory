import {BilibiliApi} from './api.mjs';
import {BilibiliLiveAdapter} from './adapter.mjs';
import {BilibiliLogin} from './login.mjs';
import {CookieStore} from './cookie-store.mjs';
import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {repairBilibiliPlatformStatuses} from './recovery.mjs';

/**
 * Glue between the HTTP layer, the login flow and the live adapter.
 *
 * One Bilibili account per data folder, but any number of rooms may be recorded
 * at the same time. The service owns the credential store and the shared HTTP
 * client (WBI cache + buvid); recording lifecycle belongs to SessionManager, so
 * starting/stopping one room never touches another.
 */

const ROOM_ID_PATTERN = /^\d{1,12}$/;

export function parseRoomId(value) {
  const text = String(value ?? '').trim();
  if (!ROOM_ID_PATTERN.test(text) || Number(text) <= 0) {
    throw new AppError('ROOM_ID_INVALID', {messageKey: 'errors.roomIdInvalid', httpStatus: 400});
  }
  return Number(text);
}

export class BilibiliService {
  constructor({
    secretsDir,
    sessionManager,
    logger = null,
    now = Date.now,
    WebSocketImpl = globalThis.WebSocket,
    api = null,
    store = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.store = store ?? new CookieStore({dir: secretsDir});
    this.api = api ?? new BilibiliApi({cookie: this.store.cookie(), now});
    this.login = new BilibiliLogin({store: this.store, api: this.api, logger, now});
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'bilibili');
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    return {
      login: this.login.status(),
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          roomId: latest.meta?.room?.roomId ?? latest.platformRoomId,
          title: latest.meta?.room?.title ?? latest.roomTitle,
          popularity: latest.connection.detail?.popularity ?? latest.meta?.room?.online ?? null
        }
        : {state: 'idle', detail: null, roomId: null, title: null, popularity: null},
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
        : null
    };
  }

  async loginWithQr() {
    return this.login.startQr({remember: true});
  }

  async pollLogin() {
    return this.login.pollQr();
  }

  async logout() {
    await this.login.logout();
  }

  async refreshLogin() {
    return this.login.refreshUser();
  }

  /** Validate a room id and read its public metadata. */
  async checkRoom(roomId) {
    const parsed = parseRoomId(roomId);
    const room = await this.api.roomInit(parsed);
    const info = await this.api.roomInfo(room.roomId).catch(() => null);
    let anchorName = info?.anchorName ?? null;
    let anchorUid = info?.anchorUid ?? room.uid ?? null;
    if (!anchorName && anchorUid) {
      try {
        const master = await this.api.masterInfo(anchorUid);
        anchorName = master?.name ?? null;
        anchorUid = master?.uid ?? anchorUid;
      } catch {
        // Metadata is optional; a valid room id remains usable.
      }
    }
    return {
      roomId: room.roomId,
      inputRoomId: parsed,
      shortId: room.shortId,
      liveStatus: info?.liveStatus ?? room.liveStatus,
      title: info?.title ?? null,
      anchorName,
      anchorUid,
      areaName: info?.areaName ?? null,
      parentAreaName: info?.parentAreaName ?? null,
      online: info?.online ?? null,
      liveStartedAt: Number(room.liveTime) > 0 ? Number(room.liveTime) : null
    };
  }

  /**
   * Start a capture for a room whose live state was already verified by the
   * automatic monitor. This still creates a normal session and a normal adapter:
   * the adapter repeats the platform live check, so a race where the stream ends
   * between detection and connection is refused instead of recording an empty
   * room. Passing the resolved room only avoids duplicate metadata requests.
   */
  async connectResolved(room, {monitorTargetId = null, sourceQuality = SOURCE_QUALITY.ESTIMATED} = {}) {
    const roomId = parseRoomId(room?.roomId);
    const adapter = new BilibiliLiveAdapter({
      roomId,
      api: this.api,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'bilibili',
      platformRoomId: String(roomId),
      roomTitle: room?.title ?? `Bilibili ${roomId}`,
      broadcasterName: room?.anchorName ?? null,
      broadcasterUid: room?.anchorUid ?? null,
      sourceQuality,
      simulated: false,
      monitorTargetId,
      platformStartedAt: Number(room?.liveStartedAt) > 0 ? Number(room.liveStartedAt) : null,
      createAdapter: () => adapter,
      meta: {room: {...room, roomId}}
    });
    if (!result.started) throw duplicateRoomError(result.duplicate);
    this.logger?.info({
      event: 'bilibili.session.started',
      sessionId: result.session.id,
      roomId,
      monitorTargetId: monitorTargetId ?? null
    });
    return {session: result.session, room: {...room, roomId}, connection: adapter.snapshot()};
  }

  async connect(roomId, {sourceQuality = SOURCE_QUALITY.ESTIMATED, monitorTargetId = null} = {}) {
    const room = await this.checkRoom(roomId);
    // A capture only makes sense for an actual live broadcast. Carousel/replay
    // rooms are not live and an offline room would create a session with no
    // broadcast behind it. The adapter repeats this check to close the race
    // where the stream ends between validation and the WebSocket handshake.
    if (room.liveStatus === 0) {
      throw new AppError('BILIBILI_ROOM_OFFLINE', {
        messageKey: 'errors.bilibiliRoomNotLive',
        details: {roomId: room.roomId, liveStatus: room.liveStatus},
        httpStatus: 409
      });
    }
    if (room.liveStatus === 2) {
      throw new AppError('BILIBILI_ROOM_CAROUSEL', {
        messageKey: 'errors.bilibiliRoomCarousel',
        details: {roomId: room.roomId, liveStatus: room.liveStatus},
        httpStatus: 409
      });
    }
    return this.connectResolved(room, {monitorTargetId, sourceQuality});
  }

  /**
   * Annotate historic Bilibili captures that ended with a crash/shutdown and
   * have no platform state yet. This never touches live recordings, user stops,
   * adapter failures or the recorded end time.
   */
  async repairHistoricalSessions({limit = 25, now = this.now()} = {}) {
    const db = this.sessionManager?.db;
    if (!db) return {checked: 0, updated: 0, failed: 0, skipped: 0};
    return repairBilibiliPlatformStatuses({
      db,
      api: this.api,
      now,
      limit,
      logger: this.logger,
      onUpdated: () => this.sessionManager.emitStatus()
    });
  }

  async disconnect({sessionId = null} = {}) {
    return this.sessionManager.stopPlatform('bilibili', {sessionId, status: 'ended', reason: 'user'});
  }
}
