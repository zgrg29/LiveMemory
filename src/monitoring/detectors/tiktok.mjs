import {isAppError} from '../../shared/errors.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {parseTikTokInput} from '../../platforms/tiktok/link.mjs';
import {TIKTOK_ERRORS} from '../../platforms/tiktok/errors.mjs';

/**
 * TikTok public room discovery.
 *
 * A target is the creator handle (stable) plus the current room id. One
 * read-only public API request is used per check while the target is offline;
 * no browser and no signed transport is opened just to ask "are you live?".
 * The detector never ends a recording: the adapter owns capture health.
 */

export function tiktokMonitorError(error) {
  const code = String(error?.code ?? '');
  if (isAppError(error) && Object.values(MONITOR_ERROR).includes(code)) return error;
  switch (code) {
    case TIKTOK_ERRORS.LINK_INVALID:
      return monitorError(MONITOR_ERROR.INVALID_INPUT, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.ROOM_NOT_FOUND:
      return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.RATE_LIMITED:
      return monitorError(MONITOR_ERROR.RATE_LIMITED, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.ROOM_UNAVAILABLE:
    case TIKTOK_ERRORS.ROOM_REFUSED:
      return monitorError(MONITOR_ERROR.BLOCKED, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.LOGIN_REQUIRED:
      return monitorError(MONITOR_ERROR.CHAT_UNAVAILABLE, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.NETWORK:
    case TIKTOK_ERRORS.CONNECT_TIMEOUT:
      return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.PROTOCOL:
    case TIKTOK_ERRORS.SIGNER_UNAVAILABLE:
      return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
    case TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED:
      return monitorError(MONITOR_ERROR.NOT_CONFIGURED, {cause: error, details: {causeCode: code}});
    default:
      break;
  }
  return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: code || 'unknown'}});
}

export class TikTokRoomDetector {
  constructor({client, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('tiktok', this.policy?.requestGapMs);
  }

  async resolve(input) {
    const parsed = parseTikTokInput(input);
    try {
      await this.#pace();
      const room = await this.client.resolveRoom(parsed);
      const identity = resolveBroadcasterIdentity({
        platform: 'tiktok',
        platformRoomId: room.roomId,
        broadcasterUid: room.anchorUid,
        broadcasterName: room.anchorName
      });
      return {
        platform: 'tiktok',
        targetKey: room.uniqueId,
        displayName: room.anchorName ?? room.uniqueId,
        platformUid: room.anchorUid ?? null,
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          uniqueId: room.uniqueId,
          roomId: room.roomId,
          anchorUid: room.anchorUid ?? null,
          anchorName: room.anchorName ?? null,
          title: room.title ?? null,
          isLive: room.isLive,
          roomStatus: room.status,
          checkedAt: room.checkedAt ?? this.now()
        }
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw tiktokMonitorError(error);
    }
  }

  async detect(target) {
    const uniqueId = String(target?.target_key ?? target?.targetKey ?? target?.meta?.uniqueId ?? '').trim();
    if (!uniqueId) throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    try {
      await this.#pace();
      const room = await this.client.resolveRoom(uniqueId);
      let info = null;
      if (room.isLive) {
        try {
          info = await this.client.fetchRoomInfo(room.roomId);
        } catch (error) {
          if (error?.code === TIKTOK_ERRORS.RATE_LIMITED) throw error;
          info = null;
        }
      }
      const observedAt = this.now();
      return {
        uniqueId: room.uniqueId,
        targetKey: room.uniqueId,
        roomId: room.roomId,
        anchorUid: info?.anchorUid ?? room.anchorUid ?? target?.platform_uid ?? null,
        anchorName: info?.anchorName ?? room.anchorName ?? target?.display_name ?? null,
        channelTitle: info?.anchorName ?? room.anchorName ?? target?.display_name ?? null,
        title: info?.title ?? room.title ?? null,
        roomStatus: room.status,
        totalViewers: info?.totalViewers ?? null,
        likeCount: info?.likeCount ?? null,
        liveStartedAt: info?.startedAt ?? null,
        startedAt: info?.startedAt ?? null,
        observedAt,
        status: room.isLive ? 'live' : 'offline'
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw tiktokMonitorError(error);
    }
  }
}
