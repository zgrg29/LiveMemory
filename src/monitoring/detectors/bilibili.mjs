import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {isAppError} from '../../shared/errors.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';

/**
 * Bilibili room discovery.
 *
 * A Bilibili live room id is stable across broadcasts, so the target is simply
 * the real room id. `room_status` (the public `get_info` endpoint) is the single
 * read-only check while waiting. It is NOT a chat heartbeat: the WebSocket
 * adapter owns capture health, and this detector never ends a recording.
 */

const ROOM_INPUT_PATTERN = /^\d{1,12}$/;

export function parseBilibiliRoomInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  if (ROOM_INPUT_PATTERN.test(text)) {
    const roomId = Number(text);
    if (roomId > 0) return {roomId, shortId: roomId, input: text};
    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }
  const host = url.hostname.toLowerCase();
  if (!['live.bilibili.com', 'www.live.bilibili.com', 'm.live.bilibili.com', 'b23.tv'].includes(host)) {
    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }
  if (host === 'b23.tv') {
    // Short links need a redirect lookup; the manager resolves them through the
    // API instead of accepting an opaque id.
    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const candidate = [...segments].reverse().find((segment) => ROOM_INPUT_PATTERN.test(segment))
    ?? url.searchParams.get('roomId');
  if (!candidate || !ROOM_INPUT_PATTERN.test(String(candidate)) || Number(candidate) <= 0) {
    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }
  return {roomId: Number(candidate), shortId: Number(candidate), input: text};
}

/** Convert a Bilibili API error into a monitor code without losing the cause. */
export function bilibiliMonitorError(error) {
  const code = String(error?.code ?? '');
  const status = Number(error?.status);
  const biliCode = Number(error?.biliCode);
  if (code === 'NETWORK') return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
  if (code === 'ROOM_NOT_FOUND' || biliCode === -404) {
    return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code, biliCode}});
  }
  if (status === 429 || biliCode === -352) {
    return monitorError(MONITOR_ERROR.RATE_LIMITED, {
      cause: error,
      details: {causeCode: code, biliCode, status, retryAfterMs: null}
    });
  }
  if (status === 403 || status === 412 || code === 'AUTH' || biliCode === -412) {
    return monitorError(MONITOR_ERROR.BLOCKED, {cause: error, details: {causeCode: code, biliCode, status}});
  }
  if (['BAD_RESPONSE', 'STATUS_INVALID', 'HTTP', 'PLATFORM'].includes(code)) {
    return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code, biliCode, status}});
  }
  return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: code, biliCode, status}});
}

export class BilibiliRoomDetector {
  constructor({api, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.api = api;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('bilibili', this.policy?.requestGapMs);
  }

  /**
   * Resolve a URL/short id into the real room id and its public identity.
   * This runs once when the target is added, not on every check.
   */
  async resolve(input) {
    const parsed = parseBilibiliRoomInput(input);
    try {
      await this.#pace();
      const room = await this.api.roomInit(parsed.roomId);
      const metadata = await this.#metadata(room.roomId, {platformUid: room.uid});
      const anchorName = metadata.anchorName;
      const anchorUid = metadata.anchorUid ?? room.uid ?? null;
      const displayName = anchorName || metadata.title || `Bilibili ${room.roomId}`;
      const identity = resolveBroadcasterIdentity({
        platform: 'bilibili',
        platformRoomId: String(room.roomId),
        broadcasterUid: anchorUid,
        broadcasterName: anchorName
      });
      return {
        platform: 'bilibili',
        targetKey: String(room.roomId),
        displayName,
        platformUid: anchorUid === null ? null : String(anchorUid),
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          shortId: room.shortId ?? parsed.roomId,
          anchorName,
          anchorUid: anchorUid === null ? null : String(anchorUid),
          areaName: metadata.areaName,
          parentAreaName: metadata.parentAreaName,
          liveStatus: room.liveStatus ?? null,
          title: metadata.title
        }
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      throw bilibiliMonitorError(error);
    }
  }

  /**
   * Optional public metadata. `getInfoByRoom` is the richest source, but it can
   * fail for an offline room or under risk control. The public Master endpoint
   * still resolves the streamer name from the stable anchor uid.
   */
  async #metadata(roomId, {platformUid = null} = {}) {
    let info = null;
    try {
      info = await this.api.roomInfo(roomId);
    } catch {
      info = null;
    }
    let anchorUid = info?.anchorUid ?? (Number(platformUid) || null);
    let anchorName = info?.anchorName ?? null;
    if (!anchorName && anchorUid && typeof this.api.masterInfo === 'function') {
      try {
        const master = await this.api.masterInfo(anchorUid);
        anchorName = master?.name ?? null;
        anchorUid = master?.uid ?? anchorUid;
      } catch {
        // Metadata is optional; the room id remains usable.
      }
    }
    return {
      anchorName,
      anchorUid,
      areaName: info?.areaName ?? null,
      parentAreaName: info?.parentAreaName ?? null,
      title: info?.title ?? null,
      attemptedAt: this.now()
    };
  }

  /**
   * @returns {{status:'live'|'offline', title:string|null, online:number|null,
   *   carousel:boolean, liveStartedAt:number|null}}
   */
  async detect(target) {
    const roomId = Number(target.target_key ?? target.targetKey);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    }
    try {
      await this.#pace();
      const status = await this.api.roomStatus(roomId);
      if (Number(status.roomId) !== roomId) {
        throw monitorError(MONITOR_ERROR.PROTOCOL, {details: {reason: 'room_mismatch'}});
      }
      const meta = parseTargetMeta(target);
      const needsMetadata = !meta?.anchorName || !target.platform_uid;
      const lastAttempt = Number(meta?.lastMetadataAttemptAt ?? 0);
      const shouldRefresh = needsMetadata && this.now() - lastAttempt >= 10 * 60 * 1000;
      const metadata = shouldRefresh
        ? await this.#metadata(roomId, {platformUid: target.platform_uid ?? meta?.anchorUid})
        : null;
      const live = status.liveStatus === 1;
      return {
        status: live ? 'live' : 'offline',
        roomId,
        title: status.title ?? metadata?.title ?? null,
        online: status.online ?? null,
        carousel: status.liveStatus === 2,
        liveStartedAt: Number(status.liveTime) > 0 ? Number(status.liveTime) : null,
        liveTimeText: typeof status.liveTime === 'string' && status.liveTime.trim()
          ? status.liveTime.trim()
          : null,
        anchorName: metadata?.anchorName ?? meta?.anchorName ?? null,
        anchorUid: metadata?.anchorUid
          ?? (Number(target.platform_uid) || Number(meta?.anchorUid) || null),
        areaName: metadata?.areaName ?? meta?.areaName ?? null,
        parentAreaName: metadata?.parentAreaName ?? meta?.parentAreaName ?? null,
        metadataAttemptedAt: metadata?.attemptedAt ?? null
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      throw bilibiliMonitorError(error);
    }
  }
}

function parseTargetMeta(target) {
  const raw = target?.meta_json ?? target?.meta;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const __internal = {ROOM_INPUT_PATTERN};
