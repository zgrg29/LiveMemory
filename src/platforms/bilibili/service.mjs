import {BilibiliApi, BilibiliError} from './api.mjs';
import {BilibiliLiveAdapter} from './adapter.mjs';
import {BilibiliLogin} from './login.mjs';
import {CookieStore} from './cookie-store.mjs';
import {AppError, ERROR_CODES} from '../../shared/errors.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {openDefaultBrowser, isAllowedExternalUrl} from '../../shared/open-browser.mjs';

/**
 * Glue between the HTTP layer, the login flow and the live adapter.
 *
 * One Bilibili account and one live room per data folder. The service owns the
 * credential store, the shared HTTP client (WBI cache + buvid) and the active
 * adapter; recording itself still goes through SessionManager -> EventIngest.
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
    this.adapter = null;
    this.room = null;
  }

  status() {
    const live = this.sessionManager.status();
    return {
      login: this.login.status(),
      connection: {
        state: this.adapter?.state ?? 'idle',
        detail: this.adapter?.snapshot().detail ?? null,
        roomId: this.room?.roomId ?? null,
        title: this.room?.title ?? null,
        popularity: this.adapter?.popularity ?? null
      },
      recording: live.connection,
      session: live.activeSession
    };
  }

  async loginWithQr() {
    return this.login.startQr({remember: true});
  }

  /**
   * Show the login QR.
   *
   * The QR image is rendered by Bilibili's own `scan-web` page, which is opened
   * in the default browser for the same `qrcode_key` we poll. That keeps the app
   * free of a QR encoder and of any third-party rendering service; the phone
   * scans the QR shown in that tab and this process receives the cookies through
   * its own poll. The raw URL is also returned so the UI can offer a link.
   */
  async openLoginPage({openBrowser = openDefaultBrowser} = {}) {
    const qr = await this.login.startQr({remember: true});
    if (!isAllowedExternalUrl(qr.url)) {
      throw new BilibiliError('URL_REJECTED', 'the login URL is not a Bilibili origin');
    }
    const opened = openBrowser(qr.url);
    return {url: qr.url, opened: Boolean(opened?.opened), expiresAt: qr.expiresAt};
  }

  async pollLogin() {
    return this.login.pollQr();
  }

  async logout() {
    await this.disconnect();
    return this.login.logout();
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
      areaName: info?.areaName ?? null,
      parentAreaName: info?.parentAreaName ?? null,
      online: info?.online ?? null
    };
  }

  async connect(roomId, {sourceQuality = SOURCE_QUALITY.ESTIMATED} = {}) {
    const existing = this.sessionManager.status().activeSession;
    if (existing) {
      throw new AppError(ERROR_CODES.SESSION_ACTIVE, {
        messageKey: 'errors.sessionActive',
        details: {sessionId: existing.id},
        httpStatus: 409
      });
    }
    const room = await this.checkRoom(roomId);
    const adapter = new BilibiliLiveAdapter({
      roomId: room.roomId,
      api: this.api,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now
    });
    this.adapter = adapter;
    this.room = room;
    try {
      const result = await this.sessionManager.startPlatform({
        platform: 'bilibili',
        platformRoomId: String(room.roomId),
        roomTitle: room.title ?? `Bilibili ${room.roomId}`,
        broadcasterName: room.anchorName ?? null,
        sourceQuality,
        simulated: false,
        createAdapter: () => adapter
      });
      if (!result.started) {
        throw new AppError(ERROR_CODES.SESSION_ACTIVE, {
          messageKey: 'errors.sessionActive',
          details: {sessionId: result.session?.id ?? null},
          httpStatus: 409
        });
      }
      this.logger?.info({event: 'bilibili.session.started', sessionId: result.session.id, roomId: room.roomId});
      return {session: result.session, room, connection: adapter.snapshot()};
    } catch (error) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      if (this.adapter === adapter) this.adapter = null;
      throw error;
    }
  }

  async disconnect() {
    if (!this.sessionManager.status().activeSession) {
      if (this.adapter) {
        await this.adapter.stop().catch(() => {});
        this.adapter = null;
      }
      return {stopped: false};
    }
    const result = await this.sessionManager.stopActive();
    this.adapter = null;
    return result;
  }

  async shutdown() {
    if (this.adapter) {
      await this.adapter.stop().catch(() => {});
      this.adapter = null;
    }
  }
}

export const __internal = {ROOM_ID_PATTERN};
