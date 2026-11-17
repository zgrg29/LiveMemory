import {isAppError} from '../../shared/errors.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {parseMeta} from '../model.mjs';
import {parseKuaishouInput} from '../../platforms/kuaishou/link.mjs';
import {KUAISHOU_ERRORS} from '../../platforms/kuaishou/errors.mjs';
import {ROOM_STATUS} from '../../platforms/kuaishou/status.mjs';

/**
 * Kuaishou room discovery for the shared monitor.
 *
 * The monitor is only reachable while collection is authorised. Before that,
 * `observeRoom` throws KUAISHOU_AUTHORIZATION_REQUIRED and this detector maps
 * it to MONITOR_RESTRICTED without making a network request.
 *
 * Absence from a recommendation list is never an offline signal (G1.6). Only a
 * room-specific observation is used; an inconclusive page is a retryable
 * protocol error, never an end of broadcast.
 */

export function kuaishouMonitorError(error) {
  const code = String(error?.code ?? '');
  if (isAppError(error) && Object.values(MONITOR_ERROR).includes(code)) return error;
  switch (code) {
    case KUAISHOU_ERRORS.LINK_INVALID:
      return monitorError(MONITOR_ERROR.INVALID_INPUT, {cause: error, details: {causeCode: code}});
    case KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED:
    case KUAISHOU_ERRORS.ACCESS_DENIED:
    case KUAISHOU_ERRORS.RISK_CONTROL:
      return monitorError(MONITOR_ERROR.RESTRICTED, {cause: error, details: {causeCode: code}, httpStatus: 403});
    case KUAISHOU_ERRORS.ROOM_NOT_FOUND:
      return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code}});
    case KUAISHOU_ERRORS.ROOM_OFFLINE:
      return monitorError(MONITOR_ERROR.OFFLINE_RACE, {cause: error, details: {causeCode: code}});
    case KUAISHOU_ERRORS.RATE_LIMITED:
      return monitorError(MONITOR_ERROR.RATE_LIMITED, {
        cause: error,
        details: {causeCode: code},
        httpStatus: 429
      });
    case KUAISHOU_ERRORS.NETWORK:
    case KUAISHOU_ERRORS.TIMEOUT:
      return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
    case KUAISHOU_ERRORS.PROTOCOL:
    case KUAISHOU_ERRORS.UPSTREAM:
    case KUAISHOU_ERRORS.HTTP:
    case KUAISHOU_ERRORS.STATUS_UNKNOWN:
      return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
    case KUAISHOU_ERRORS.NOT_CONFIGURED:
      return monitorError(MONITOR_ERROR.NOT_CONFIGURED, {cause: error, details: {causeCode: code}});
    default:
      break;
  }
  return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: code || 'unknown'}});
}

function eidOf(row) {
  const meta = parseMeta(row?.meta_json) ?? (typeof row?.meta === 'object' ? row.meta : null);
  if (meta?.eid) return String(meta.eid);
  try {
    return parseKuaishouInput(row?.input ?? row?.target_key ?? '').eid;
  } catch {
    return '';
  }
}

export class KuaishouRoomDetector {
  constructor({service, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.service = service;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('kuaishou', this.policy?.requestGapMs);
  }

  async resolve(input) {
    const parsed = parseKuaishouInput(input);
    try {
      await this.#pace();
      const status = await this.service.observeRoom(parsed.eid);
      const identity = resolveBroadcasterIdentity({
        platform: 'kuaishou',
        platformRoomId: parsed.eid,
        broadcasterUid: parsed.eid,
        broadcasterName: parsed.eid
      });
      return {
        platform: 'kuaishou',
        // The room id is the stable input; each broadcast carries its own H5
        // liveStreamId and is therefore a separate capture cycle.
        targetKey: parsed.eid,
        displayName: parsed.eid,
        platformUid: parsed.eid,
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          eid: parsed.eid,
          liveStreamId: status.liveStreamId ?? null,
          isLive: status.state === ROOM_STATUS.LIVE,
          status: status.state,
          title: status.title ?? null,
          checkedAt: this.now()
        }
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw kuaishouMonitorError(error);
    }
  }

  async detect(target) {
    const eid = eidOf(target);
    if (!eid) throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    try {
      await this.#pace();
      const status = await this.service.observeRoom(eid);
      const observedAt = this.now();
      if (status.state === ROOM_STATUS.LIVE) {
        return {
          status: 'live',
          eid,
          targetKey: eid,
          liveStreamId: status.liveStreamId,
          liveId: status.liveStreamId,
          anchorUid: eid,
          anchorName: eid,
          channelTitle: status.title ?? eid,
          title: status.title ?? null,
          startedAt: null,
          observedAt
        };
      }
      if (status.state === ROOM_STATUS.OFFLINE) {
        return {
          status: 'offline',
          eid,
          targetKey: eid,
          anchorUid: eid,
          anchorName: eid,
          channelTitle: status.title ?? eid,
          title: status.title ?? null,
          observedAt
        };
      }
      if (status.state === ROOM_STATUS.RATE_LIMITED) {
        throw monitorError(MONITOR_ERROR.RATE_LIMITED, {
          httpStatus: 429,
          details: {status: status.state}
        });
      }
      if (status.state === ROOM_STATUS.NOT_FOUND) {
        throw monitorError(MONITOR_ERROR.NOT_FOUND, {
          httpStatus: 404,
          details: {status: status.state}
        });
      }
      // A generic page or a page without a room marker proves nothing. Retry
      // later; never turn it into an offline observation.
      throw monitorError(MONITOR_ERROR.PROTOCOL, {
        httpStatus: 502,
        details: {status: status.state, reason: status.reason ?? null}
      });
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw kuaishouMonitorError(error);
    }
  }
}
