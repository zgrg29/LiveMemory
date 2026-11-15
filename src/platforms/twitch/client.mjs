import {TwitchError, TWITCH_ERRORS} from './errors.mjs';

/**
 * Read-only Twitch public metadata client.
 *
 * The anonymous IRC gateway gives us chat and a stable `room-id`, but not the
 * channel title, live/offline state or broadcast start. Those are read from the
 * same public GraphQL endpoint the Twitch website itself uses, with Twitch's
 * public web client id. There is no login, OAuth token, cookie or API key here,
 * and no third-party paid service.
 *
 * This is an unofficial compatibility path: Twitch does not document it as a
 * stable public API. Failures are explicit and never turned into "offline" or
 * "success".
 */

export const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
/**
 * Public client id embedded in Twitch's own web client. It is not a secret and
 * is not tied to a LiveMemory developer account.
 */
export const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const CHANNEL_QUERY = `query LiveMemoryChannel($login: String!) {
  user(login: $login) {
    id
    login
    displayName
    broadcastSettings { title game { name } }
    stream { id createdAt viewersCount }
    lastBroadcast { startedAt }
  }
}`;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function epochOrNull(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export class TwitchMetadataClient {
  constructor({
    fetchImpl = globalThis.fetch,
    now = Date.now,
    gqlUrl = TWITCH_GQL_URL,
    clientId = TWITCH_WEB_CLIENT_ID,
    timeoutMs = 10000,
    userAgent = DEFAULT_USER_AGENT
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.gqlUrl = gqlUrl;
    this.clientId = clientId;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  /**
   * @param {string} login lower-case Twitch channel login
   * @returns {Promise<object>} channel view (never null; a missing channel throws)
   */
  async getChannel(login) {
    const normalized = String(login ?? '').trim().toLowerCase();
    if (!normalized) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        details: {reason: 'login_missing'}
      });
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new TwitchError(TWITCH_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.twitchNotConfigured',
        httpStatus: 503
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(this.gqlUrl, {
        method: 'POST',
        headers: {
          'client-id': this.clientId,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': this.userAgent
        },
        body: JSON.stringify({query: CHANNEL_QUERY, variables: {login: normalized}}),
        signal: controller.signal
      });
    } catch (error) {
      throw new TwitchError(TWITCH_ERRORS.NETWORK, {
        messageKey: 'errors.twitchNetwork',
        httpStatus: 502,
        cause: error,
        details: {reason: error?.name === 'AbortError' ? 'timeout' : 'fetch'}
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new TwitchError(TWITCH_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.twitchRateLimit',
        httpStatus: 429,
        status: 429,
        retryAfterMs: retryAfterMs(response)
      });
    }
    if (response.status >= 500) {
      throw new TwitchError(TWITCH_ERRORS.NETWORK, {
        messageKey: 'errors.twitchNetwork',
        httpStatus: 502,
        status: response.status
      });
    }
    if (!response.ok) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        status: response.status,
        details: {reason: 'http'}
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        cause: error,
        details: {reason: 'invalid_json'}
      });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        details: {reason: 'invalid_payload'}
      });
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        details: {reason: 'graphql_error'}
      });
    }

    const user = payload.data?.user ?? null;
    if (!user || typeof user !== 'object') {
      throw new TwitchError(TWITCH_ERRORS.CHANNEL_NOT_FOUND, {
        messageKey: 'errors.twitchChannelNotFound',
        httpStatus: 404,
        details: {login: normalized}
      });
    }
    const channelId = String(user.id ?? '').trim();
    if (!/^\d+$/.test(channelId)) {
      throw new TwitchError(TWITCH_ERRORS.PROTOCOL, {
        messageKey: 'errors.twitchProtocol',
        httpStatus: 502,
        details: {reason: 'channel_id_missing'}
      });
    }

    const stream = user.stream && typeof user.stream === 'object' ? user.stream : null;
    const streamId = stream?.id === null || stream?.id === undefined ? null : String(stream.id);
    const startedAt = epochOrNull(stream?.createdAt) ?? epochOrNull(user.lastBroadcast?.startedAt);
    const viewers = Number(stream?.viewersCount);
    return {
      login: String(user.login ?? normalized).toLowerCase(),
      channelId,
      displayName: String(user.displayName ?? user.login ?? normalized),
      title: user.broadcastSettings?.title ?? null,
      game: user.broadcastSettings?.game?.name ?? null,
      isLive: Boolean(stream && streamId),
      streamId,
      startedAt,
      viewers: Number.isFinite(viewers) ? viewers : null,
      checkedAt: this.now()
    };
  }

  /** Only the live/offline state, kept as a small named method for detectors. */
  async getStatus(login) {
    return this.getChannel(login);
  }
}

export const __internal = {CHANNEL_QUERY, DEFAULT_USER_AGENT, retryAfterMs, epochOrNull};
