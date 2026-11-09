import {BilibiliApi} from './api.mjs';
import {BilibiliLiveAdapter} from './adapter.mjs';
import {BilibiliLogin} from './login.mjs';
import {CookieStore} from './cookie-store.mjs';
import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';

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
    return {
      roomId: room.roomId,
      inputRoomId: parsed,
      shortId: room.shortId,
      liveStatus: info?.liveStatus ?? room.liveStatus,
      title: info?.title ?? null,
      anchorName: info?.anchorName ?? null,
      anchorUid: info?.anchorUid ?? null,
      areaName: info?.areaName ?? null,
      parentAreaName: info?.parentAreaName ?? null,
      online: info?.online ?? null
    };
  }

  async connect(roomId, {sourceQuality = SOURCE_QUALITY.ESTIMATED} = {}) {
    const room = await this.checkRoom(roomId);
    const adapter = new BilibiliLiveAdapter({
      roomId: room.roomId,
      api: this.api,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'bilibili',
      platformRoomId: String(room.roomId),
      roomTitle: room.title ?? `Bilibili ${room.roomId}`,
      broadcasterName: room.anchorName ?? null,
      broadcasterUid: room.anchorUid ?? null,
      sourceQuality,
      simulated: false,
      createAdapter: () => adapter,
      meta: {room}
    });
    if (!result.started) throw duplicateRoomError(result.duplicate);
    this.logger?.info({event: 'bilibili.session.started', sessionId: result.session.id, roomId: room.roomId});
    return {session: result.session, room, connection: adapter.snapshot()};
  }

  async disconnect({sessionId = null} = {}) {
    return this.sessionManager.stopPlatform('bilibili', {sessionId});
  }
}
