import {isAppError} from '../../shared/errors.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {parseTwitchInput} from '../../platforms/twitch/link.mjs';
import {TWITCH_ERRORS} from '../../platforms/twitch/errors.mjs';

/**
 * Twitch public channel discovery.
 *
 * A Twitch target is the channel login (case-insensitive) and the stable channel
 * id. One read-only public metadata request is used per check; no IRC socket is
 * opened while waiting. The detector never ends a recording: the adapter owns
 * capture health and confirmed platform end.
 */

export function twitchMonitorError(error) {
  if (isAppError(error)) {
    const code = String(error.code ?? '');
    if (Object.values(MONITOR_ERROR).includes(code)) return error;
    switch (code) {
      case TWITCH_ERRORS.LINK_INVALID:
        return monitorError(MONITOR_ERROR.INVALID_INPUT, {cause: error, details: {causeCode: code}});
      case TWITCH_ERRORS.CHANNEL_NOT_FOUND:
        return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error, details: {causeCode: code}});
      case TWITCH_ERRORS.RATE_LIMITED:
        return monitorError(MONITOR_ERROR.RATE_LIMITED, {
          cause: error,
          details: {causeCode: code, retryAfterMs: error.retryAfterMs ?? null}
        });
      case TWITCH_ERRORS.CHANNEL_UNAVAILABLE:
      case TWITCH_ERRORS.CHAT_UNAVAILABLE:
        return monitorError(MONITOR_ERROR.CHAT_UNAVAILABLE, {cause: error, details: {causeCode: code}});
      case TWITCH_ERRORS.NETWORK:
      case TWITCH_ERRORS.CONNECT_TIMEOUT:
        return monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: code}});
      case TWITCH_ERRORS.PROTOCOL:
        return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
      case TWITCH_ERRORS.NOT_CONFIGURED:
        return monitorError(MONITOR_ERROR.NOT_CONFIGURED, {cause: error, details: {causeCode: code}});
      default:
        break;
    }
  }
  return monitorError(MONITOR_ERROR.UNKNOWN, {cause: error, details: {causeCode: error?.code ?? 'unknown'}});
}

export class TwitchChannelDetector {
  constructor({client, logger = null, now = Date.now, pacer = null, policy = null} = {}) {
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.pacer = pacer;
    this.policy = policy;
  }

  async #pace() {
    if (this.pacer) await this.pacer.wait('twitch', this.policy?.requestGapMs);
  }

  /**
   * Resolve a URL/login into the stable target. Called once when a target is
   * added, not on every check.
   */
  async resolve(input) {
    const parsed = parseTwitchInput(input);
    try {
      await this.#pace();
      const channel = await this.client.getChannel(parsed.login);
      const identity = resolveBroadcasterIdentity({
        platform: 'twitch',
        platformRoomId: channel.channelId,
        broadcasterUid: channel.channelId,
        broadcasterName: channel.displayName
      });
      return {
        platform: 'twitch',
        targetKey: channel.login,
        displayName: channel.displayName,
        platformUid: channel.channelId,
        broadcasterId: identity.id,
        broadcasterIdentity: identity,
        input: String(input ?? '').trim(),
        meta: {
          login: channel.login,
          channelId: channel.channelId,
          displayName: channel.displayName,
          title: channel.title,
          game: channel.game,
          isLive: channel.isLive,
          streamId: channel.streamId,
          startedAt: channel.startedAt,
          viewers: channel.viewers,
          checkedAt: channel.checkedAt ?? this.now()
        }
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw twitchMonitorError(error);
    }
  }

  /**
   * @returns {Promise<object>} observation consumed by MonitoringManager
   */
  async detect(target) {
    const login = String(target?.target_key ?? target?.targetKey ?? target?.meta?.login ?? '').trim().toLowerCase();
    if (!login) {
      throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    }
    try {
      await this.#pace();
      const channel = await this.client.getChannel(login);
      const observedAt = this.now();
      const base = {
        login: channel.login,
        channelId: channel.channelId,
        channelTitle: channel.displayName,
        anchorName: channel.displayName,
        anchorUid: channel.channelId,
        title: channel.title,
        game: channel.game,
        viewers: channel.viewers,
        streamId: channel.streamId,
        liveStartedAt: channel.startedAt,
        startedAt: channel.startedAt,
        observedAt
      };
      return {
        ...base,
        status: channel.isLive ? 'live' : 'offline'
      };
    } catch (error) {
      if (isAppError(error) && Object.values(MONITOR_ERROR).includes(error.code)) throw error;
      throw twitchMonitorError(error);
    }
  }
}
