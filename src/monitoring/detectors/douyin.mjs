import {isAppError} from '../../shared/errors.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {parseDouyinInput} from '../../platforms/douyin/link.mjs';
import {DOUYIN_ERRORS} from '../../platforms/douyin/errors.mjs';

/**
 * Douyin public room discovery.
 *
 * A target is the numeric `web_rid` (what the share URL contains). One
 * read-only public page request per check; no WebSocket is opened while
 * waiting, and a failed read is never treated as "offline".
 */

export function douyinMonitorError(error) {
  const code = String(error?.code ?? '');
  if (Object.values(MONITOR_ERROR).includes(code)) return error;
  switch (code) {
    case DOUYIN_ERRORS.LINK_INVALID:
      return monitorError(MONITOR_ERROR.INVALID_INPUT, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.ROOM_NOT_FOUND:
      return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.ROOM_OFFLINE:
    case DOUYIN_ERRORS.ROOM_ENDED:
      return monitorError(MONITOR_ERROR.OFFLINE_RACE, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.RATE_LIMITED:
      return monitorError(MONITOR_ERROR.RATE_LIMITED, {
        cause: error,
        details: {causeCode: code, retryAfterMs: error.retryAfterMs ?? null}
      });
    case DOUYIN_ERRORS.BLOCKED:
    case DOUYIN_ERRORS.LOGIN_BLOCKED:
      return monitorError(MONITOR_ERROR.BLOCKED, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.NETWORK:
    case DOUYIN_ERRORS.CONNECT_TIMEOUT:
      return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.PROTOCOL:
    case DOUYIN_ERRORS.SIGNATURE_FAILED:
      return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
    case DOUYIN_ERRORS.NOT_CONFIGURED:
      return monitorError(MONITOR_ERROR.NOT_CONFIGURED, {cause: error, details: {causeCode: code}});
    default:
      return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: code || 'unknown'}});
  }
}

export class DouyinRoomDetector {
  constructor({client, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('douyin', this.policy?.requestGapMs);
  }

  async resolve(input) {
    const parsed = parseDouyinInput(input);
    try {
      await this.#pace();
      const room = await this.client.fetchRoom(parsed.webRid);
      const identity = resolveBroadcasterIdentity({
        platform: 'douyin',
        platformRoomId: String(room.roomId),
        broadcasterUid: room.anchorId ?? room.roomId,
        broadcasterName: room.anchorName
      });
      return {
        platform: 'douyin',
        targetKey: room.webRid,
        displayName: room.anchorName ?? room.title ?? `Douyin ${room.webRid}`,
        platformUid: room.anchorId ?? room.roomId,
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          webRid: room.webRid,
          roomId: room.roomId,
          anchorName: room.anchorName,
          anchorUid: room.anchorId,
          anchorSecUid: room.anchorSecUid,
          title: room.title,
          status: room.status,
          isLive: room.isLive,
          userCount: room.userCount,
          checkedAt: room.checkedAt ?? this.now()
        }
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw douyinMonitorError(error);
    }
  }

  async detect(target) {
    const webRid = String(target?.target_key ?? target?.targetKey ?? target?.meta?.webRid ?? '').trim();
    if (!/^\d{6,20}$/.test(webRid)) {
      throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    }
    try {
      await this.#pace();
      const room = await this.client.fetchRoom(webRid);
      const observedAt = this.now();
      return {
        webRid: room.webRid,
        roomId: room.roomId,
        roomStatus: room.status,
        anchorName: room.anchorName,
        anchorUid: room.anchorId,
        anchorSecUid: room.anchorSecUid,
        channelTitle: room.anchorName ?? room.title,
        title: room.title,
        online: room.userCount,
        observedAt,
        status: room.isLive ? 'live' : 'offline'
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw douyinMonitorError(error);
    }
  }
}
