import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {retentionStatus, runRetention} from '../../storage/retention.mjs';
import {TwitchMetadataClient} from './client.mjs';
import {TwitchIrcAdapter} from './adapter.mjs';
import {parseTwitchInput} from './link.mjs';
import {TWITCH_ERRORS, TwitchError} from './errors.mjs';

/**
 * Glue between HTTP routes, the public metadata client, the anonymous IRC
 * adapter and SessionManager.
 *
 * No login, OAuth token, API key, cookie or paid collection service is used.
 * The same stable Twitch user id (`user-id` tag / channel id) becomes both the
 * broadcaster identity and each viewer's long-term identity.
 */

export const TWITCH_RAW_RETENTION_DAYS = 30;

const HTTP_BY_CODE = new Map([
  [TWITCH_ERRORS.LINK_INVALID, [400, 'errors.twitchLinkInvalid']],
  [TWITCH_ERRORS.CHANNEL_NOT_FOUND, [404, 'errors.twitchChannelNotFound']],
  [TWITCH_ERRORS.CHANNEL_OFFLINE, [409, 'errors.twitchChannelOffline']],
  [TWITCH_ERRORS.CHANNEL_UNAVAILABLE, [403, 'errors.twitchChatUnavailable']],
  [TWITCH_ERRORS.CHAT_UNAVAILABLE, [403, 'errors.twitchChatUnavailable']],
  [TWITCH_ERRORS.RATE_LIMITED, [429, 'errors.twitchRateLimit']],
  [TWITCH_ERRORS.NETWORK, [502, 'errors.twitchNetwork']],
  [TWITCH_ERRORS.PROTOCOL, [502, 'errors.twitchProtocol']],
  [TWITCH_ERRORS.CONNECT_TIMEOUT, [504, 'errors.twitchConnectTimeout']],
  [TWITCH_ERRORS.WEBSOCKET_UNAVAILABLE, [503, 'errors.twitchWebSocketUnavailable']],
  [TWITCH_ERRORS.NOT_CONFIGURED, [503, 'errors.twitchNotConfigured']]
]);

/** Map adapter/client errors to stable API errors with translatable keys. */
export function toApiError(error) {
  if (error instanceof AppError) return error;
  const entry = HTTP_BY_CODE.get(error?.code);
  if (entry) {
    return new AppError(error.code, {
      messageKey: entry[1],
      httpStatus: entry[0],
      details: error?.details ?? null,
      cause: error
    });
  }
  return new AppError('TWITCH_ERROR', {
    messageKey: 'errors.twitchError',
    httpStatus: 502,
    cause: error
  });
}

function channelView(channel, input) {
  return {
    login: channel.login,
    channelId: channel.channelId,
    displayName: channel.displayName,
    isLive: Boolean(channel.isLive),
    title: channel.title ?? null,
    game: channel.game ?? null,
    viewers: channel.viewers ?? null,
    startedAt: channel.startedAt ?? null,
    streamId: channel.streamId ?? null,
    checkedAt: channel.checkedAt ?? Date.now(),
    input: String(input ?? ''),
    liveUrl: `https://www.twitch.tv/${channel.login}`,
    recordable: Boolean(channel.isLive),
    reason: channel.isLive ? null : TWITCH_ERRORS.CHANNEL_OFFLINE
  };
}

export class TwitchService {
  constructor({
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    client = null,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.client = client ?? new TwitchMetadataClient({fetchImpl, now});
    this.adapterOptions = adapterOptions;
    this.lastEnd = null;
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'twitch');
  }

  #retentionDays() {
    return TWITCH_RAW_RETENTION_DAYS;
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    return {
      available: true,
      mode: 'anonymous-irc',
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          login: latest.meta?.channel?.login ?? latest.meta?.login ?? latest.platformRoomId,
          channelId: latest.broadcasterId ?? latest.meta?.channel?.channelId ?? null,
          title: latest.meta?.channel?.title ?? latest.roomTitle,
          viewers: latest.connection.detail?.viewers ?? latest.meta?.channel?.viewers ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, login: null, channelId: null, title: null, viewers: null, lastEnd: this.lastEnd},
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
          days: this.#retentionDays(),
          now: this.now(),
          platforms: ['twitch'],
          policy: 'twitch-raw-content'
        })
        : null,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        requiresCookie: false,
        liveOnly: true,
        stableUserId: true,
        messageId: true,
        anonymousIrc: true,
        subscriptions: 'resub-verified',
        giftedSubscriptions: 'parsed-not-verified',
        bits: 'parsed-not-verified',
        eventSub: 'requires-oauth-not-configured'
      }
    };
  }

  async checkChannel(input) {
    const parsed = parseTwitchInput(input);
    const channel = await this.client.getChannel(parsed.login);
    return channelView(channel, input);
  }

  /**
   * Start a capture for a channel the caller has already confirmed live.
   * The adapter repeats the channel id check via ROOMSTATE.
   */
  async #startWithChannel(channel, {monitorTargetId = null, input = null} = {}) {
    if (!channel?.isLive) {
      throw new TwitchError(TWITCH_ERRORS.CHANNEL_OFFLINE, {
        messageKey: 'errors.twitchChannelOffline',
        httpStatus: 409,
        details: {login: channel?.login ?? null}
      });
    }
    const adapter = new TwitchIrcAdapter({
      login: channel.login,
      channelId: channel.channelId,
      channel,
      client: this.client,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      now: this.now,
      ...(this.adapterOptions ? this.adapterOptions : {})
    });
    const identity = resolveBroadcasterIdentity({
      platform: 'twitch',
      platformRoomId: channel.channelId,
      broadcasterUid: channel.channelId,
      broadcasterName: channel.displayName
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'twitch',
      platformRoomId: channel.channelId,
      roomTitle: channel.title ?? `Twitch ${channel.displayName}`,
      broadcasterName: channel.displayName,
      broadcasterUid: channel.channelId,
      sourceQuality: SOURCE_QUALITY.ESTIMATED,
      simulated: false,
      platformStartedAt: channel.startedAt ?? null,
      monitorTargetId,
      createAdapter: () => adapter,
      meta: {
        channel: {...channel},
        login: channel.login,
        mode: 'anonymous-irc',
        broadcasterIdentity: identity.identity,
        input: input ?? null
      },
      onEnded: ({reason}) => {
        this.lastEnd = {reason, at: this.now(), mode: 'anonymous-irc'};
        this.#applyRetention();
      }
    });
    if (!result.started) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      throw duplicateRoomError(result.duplicate);
    }
    this.logger?.info({
      event: 'twitch.session.started',
      sessionId: result.session.id,
      login: channel.login,
      channelId: channel.channelId,
      monitorTargetId: monitorTargetId ?? null
    });
    return {
      session: result.session,
      channel: channelView(channel, input),
      connection: adapter.snapshot()
    };
  }

  async connect(input) {
    const channel = await this.checkChannel(input);
    if (!channel.isLive) {
      throw new TwitchError(TWITCH_ERRORS.CHANNEL_OFFLINE, {
        messageKey: 'errors.twitchChannelOffline',
        httpStatus: 409,
        details: {login: channel.login}
      });
    }
    return this.#startWithChannel(channel, {input});
  }

  /**
   * Start a capture discovered by the automatic monitor. The detector already
   * read the public metadata, so no extra request is made here.
   */
  async connectDetected(observation, {monitorTargetId = null, input = null} = {}) {
    const login = observation?.login ?? observation?.targetKey ?? null;
    const channel = {
      login,
      channelId: observation?.channelId ?? observation?.anchorUid ?? null,
      displayName: observation?.channelTitle ?? observation?.displayName ?? login,
      isLive: observation?.status === 'live',
      title: observation?.title ?? null,
      game: observation?.game ?? null,
      viewers: observation?.viewers ?? null,
      startedAt: observation?.liveStartedAt ?? observation?.startedAt ?? null,
      streamId: observation?.streamId ?? null,
      checkedAt: observation?.observedAt ?? this.now()
    };
    if (!channel.login || !channel.channelId) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        details: {reason: 'detected_channel_incomplete'}
      });
    }
    return this.#startWithChannel(channel, {monitorTargetId, input: input ?? observation?.input ?? null});
  }

  async disconnect({sessionId = null} = {}) {
    const result = await this.sessionManager.stopPlatform('twitch', {
      sessionId,
      status: 'ended',
      reason: 'user'
    });
    if (result.stopped) this.#applyRetention();
    return result;
  }

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {
      now: this.now(),
      days: this.#retentionDays(),
      platforms: ['twitch'],
      logger: this.logger
    });
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {
      summary,
      status: this.db
        ? retentionStatus(this.db, {
          days: this.#retentionDays(),
          now: this.now(),
          platforms: ['twitch'],
          policy: 'twitch-raw-content'
        })
        : null
    };
  }
}

export const __internal = {HTTP_BY_CODE, channelView};
