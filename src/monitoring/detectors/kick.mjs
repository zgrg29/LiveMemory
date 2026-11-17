import {isAppError} from '../../shared/errors.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {parseKickInput} from '../../platforms/kick/link.mjs';
import {KICK_ERRORS} from '../../platforms/kick/errors.mjs';

/**
 * Kick public channel discovery for the shared monitor.
 *
 * One read-only public channel request per check while the channel is offline.
 * An existing-but-offline channel is a normal `offline` observation, not an
 * error: monitoring a channel before it goes live is the whole point. The
 * detector never ends a recording; the adapter owns capture health.
 */

export function kickMonitorError(error) {
  const code = String(error?.code ?? '');
  if (isAppError(error) && Object.values(MONITOR_ERROR).includes(code)) return error;
  switch (code) {
    case KICK_ERRORS.LINK_INVALID:
      return monitorError(MONITOR_ERROR.INVALID_INPUT, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.ROOM_NOT_FOUND:
      return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.ROOM_OFFLINE:
      // Offline is reported through the observation, never as a failure.
      return monitorError(MONITOR_ERROR.OFFLINE_RACE, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.ROOM_UNAVAILABLE:
    case KICK_ERRORS.BLOCKED:
      return monitorError(MONITOR_ERROR.BLOCKED, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.RATE_LIMITED:
      return monitorError(MONITOR_ERROR.RATE_LIMITED, {
        cause: error,
        details: {causeCode: code},
        httpStatus: 429
      });
    case KICK_ERRORS.NETWORK:
    case KICK_ERRORS.CONNECT_TIMEOUT:
      return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.PROTOCOL:
    case KICK_ERRORS.SOCKET_FAILED:
      return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
    case KICK_ERRORS.NOT_CONFIGURED:
      return monitorError(MONITOR_ERROR.NOT_CONFIGURED, {cause: error, details: {causeCode: code}});
    default:
      break;
  }
  return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: code || 'unknown'}});
}

function slugOf(row) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : null;
  if (meta?.slug) return String(meta.slug);
  try {
    return parseKickInput(row?.input ?? '').slug;
  } catch {
    return '';
  }
}

export class KickRoomDetector {
  constructor({service, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.service = service;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('kick', this.policy?.requestGapMs);
  }

  async resolve(input) {
    const parsed = parseKickInput(input);
    try {
      await this.#pace();
      const channel = await this.service.observeChannel(parsed.slug);
      const identity = resolveBroadcasterIdentity({
        platform: 'kick',
        platformRoomId: channel.channelId,
        broadcasterUid: channel.userId ?? channel.channelId,
        broadcasterName: channel.slug
      });
      return {
        platform: 'kick',
        // The numeric channel id survives a rename; the slug is only needed to
        // ask Kick for the channel and is kept in meta.
        targetKey: channel.channelId,
        displayName: channel.slug,
        platformUid: channel.userId ?? null,
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          slug: channel.slug,
          channelId: channel.channelId,
          chatroomId: channel.chatroomId,
          userId: channel.userId ?? null,
          isLive: channel.isLive,
          title: channel.title ?? null,
          liveId: channel.livestreamId ?? null,
          liveStartedAt: channel.startedAt ?? null,
          viewerCount: channel.viewerCount ?? null,
          checkedAt: this.now()
        }
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw kickMonitorError(error);
    }
  }

  async detect(target) {
    const slug = slugOf(target);
    if (!slug) throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    try {
      await this.#pace();
      const channel = await this.service.observeChannel(slug);
      const observedAt = this.now();
      return {
        slug: channel.slug,
        targetKey: channel.channelId,
        channelId: channel.channelId,
        chatroomId: channel.chatroomId,
        anchorUid: channel.userId ?? target?.platform_uid ?? null,
        anchorName: channel.slug,
        channelTitle: channel.title ?? channel.slug,
        title: channel.title ?? null,
        viewerCount: channel.viewerCount ?? null,
        liveId: channel.livestreamId ?? null,
        liveStartedAt: channel.startedAt ?? null,
        startedAt: channel.startedAt ?? null,
        observedAt,
        status: channel.isLive ? 'live' : 'offline'
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw kickMonitorError(error);
    }
  }
}
