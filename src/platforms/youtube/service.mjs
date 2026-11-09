import {AppError, ERROR_CODES} from '../../shared/errors.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {YouTubeApi, YOUTUBE_ERRORS, DEFAULT_DAILY_QUOTA} from './api.mjs';
import {YouTubeLiveChatAdapter, checkRecordable} from './adapter.mjs';
import {YouTubeAnonymousClient} from './anonymous/client.mjs';
import {YouTubeAnonymousLiveChatAdapter, checkAnonymousRecordable} from './anonymous/adapter.mjs';
import {YouTubeOAuthManager, LOGIN_STATE} from './oauth-manager.mjs';
import {describeOAuthClient, describeApiKey, OAUTH_CONFIG_FILE_NAME, resolveOAuthClient, resolveApiKey} from './oauth-config.mjs';
import {parseYouTubeInput} from './link.mjs';
import {retentionStatus, runRetention, normalizeRetentionDays} from '../../storage/retention.mjs';

/**
 * Glue between the HTTP layer, the OAuth login, the API client and the adapter.
 *
 * One Google account and one broadcast per data folder. Recording itself still
 * goes through SessionManager -> EventIngest, so de-duplication, viewer
 * aggregation and per-currency totals are identical to Bilibili and the mock.
 *
 * No API key is ever used or accepted: the streamer signs in once and the app
 * holds an encrypted refresh token. See `oauth-config.mjs` for the one-time
 * maintainer configuration.
 */

const SOURCE_QUALITY_ESTIMATED = SOURCE_QUALITY.ESTIMATED;

function epochOrNull(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Map adapter/API errors to stable API errors with translatable keys. */
export function toApiError(error) {
  // Broadcaster identity comes from the channel, never from the video id. If a
  // platform response ever omits the channel id the session is kept but marked
  // unresolved, so it cannot be merged into another broadcaster by accident.
  if (error instanceof AppError) return error;
  const code = error?.code ?? 'UNKNOWN';
  const map = {
    YOUTUBE_LINK_INVALID: [400, 'errors.youtubeLinkInvalid'],
    YOUTUBE_NOT_LIVE_UPCOMING: [409, 'errors.youtubeUpcoming'],
    YOUTUBE_NOT_LIVE_ENDED: [409, 'errors.youtubeEnded'],
    YOUTUBE_NOT_LIVE_VIDEO: [409, 'errors.youtubeNotLive'],
    YOUTUBE_NOT_LIVE: [409, 'errors.youtubeNotLive'],
    [YOUTUBE_ERRORS.CHAT_DISABLED]: [409, 'errors.youtubeChatDisabled'],
    [YOUTUBE_ERRORS.CHAT_NOT_FOUND]: [404, 'errors.youtubeChatUnavailable'],
    [YOUTUBE_ERRORS.CHAT_ENDED]: [410, 'errors.youtubeChatEnded'],
    [YOUTUBE_ERRORS.VIDEO_NOT_FOUND]: [404, 'errors.youtubeVideoNotFound'],
    [YOUTUBE_ERRORS.AUTH_REQUIRED]: [401, 'errors.youtubeAuthRequired'],
    [YOUTUBE_ERRORS.AUTH_EXPIRED]: [401, 'errors.youtubeAuthExpired'],
    [YOUTUBE_ERRORS.QUOTA_EXCEEDED]: [429, 'errors.youtubeQuota'],
    [YOUTUBE_ERRORS.RATE_LIMITED]: [429, 'errors.youtubeRateLimit'],
    [YOUTUBE_ERRORS.FORBIDDEN]: [403, 'errors.youtubeForbidden'],
    [YOUTUBE_ERRORS.NETWORK]: [502, 'errors.youtubeNetwork'],
    YOUTUBE_NOT_CONFIGURED: [409, 'errors.youtubeNotConfigured'],
    YOUTUBE_LOGIN_DENIED: [403, 'errors.youtubeLoginDenied'],
    YOUTUBE_LOGIN_TIMEOUT: [408, 'errors.youtubeLoginTimeout'],
    YOUTUBE_OAUTH_CLIENT_INVALID: [500, 'errors.youtubeClientInvalid'],
    YOUTUBE_OAUTH_STATE: [400, 'errors.youtubeLoginFailed'],
    YOUTUBE_OAUTH_NETWORK: [502, 'errors.youtubeNetwork'],
    [YOUTUBE_ERRORS.WEB_NETWORK]: [502, 'errors.youtubeWebNetwork'],
    [YOUTUBE_ERRORS.WEB_BLOCKED]: [429, 'errors.youtubeWebBlocked'],
    [YOUTUBE_ERRORS.WEB_PROTOCOL]: [502, 'errors.youtubeWebProtocol'],
    [YOUTUBE_ERRORS.WEB_STALE]: [409, 'errors.youtubeWebStale'],
    [YOUTUBE_ERRORS.WEB_RESTRICTED]: [403, 'errors.youtubeWebRestricted'],
    [YOUTUBE_ERRORS.WEB_NOT_CONFIGURED]: [409, 'errors.youtubeWebNotConfigured']
  };
  const entry = map[code];
  if (entry) return new AppError(code, {messageKey: entry[1], httpStatus: entry[0], cause: error});
  return new AppError('YOUTUBE_ERROR', {messageKey: 'errors.youtubeApi', httpStatus: 502, cause: error});
}

export class YouTubeService {
  constructor({
    secretsDir,
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    configFile = null,
    apiKeyConfigFile = null,
    oauthClient = null,
    apiKey = null,
    quotaLimit = DEFAULT_DAILY_QUOTA,
    apiBase = null,
    webBase = null,
    anonymousClient = null,
    receiverFactory = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.client = oauthClient ?? resolveOAuthClient({configFile, logger});
    this.apiKey = apiKey ?? resolveApiKey({configFile: apiKeyConfigFile, logger});
    this.oauth = new YouTubeOAuthManager({
      secretsDir,
      client: this.client,
      logger,
      now,
      fetchImpl,
      receiverFactory,
      onSignedIn: (manager) => this.#loadChannel(manager)
    });
    this.api = new YouTubeApi({
      getAccessToken: () => this.#accessTokenOrNull(),
      apiKey: this.apiKey.configured ? this.apiKey.apiKey : null,
      fetchImpl,
      now,
      logger,
      ...(apiBase ? {baseUrl: apiBase} : {})
    });
    this.api.quotaLimit = Number(quotaLimit) || DEFAULT_DAILY_QUOTA;
    this.anonymous = anonymousClient ?? new YouTubeAnonymousClient({
      fetchImpl,
      now,
      logger,
      ...(webBase ? {baseUrl: webBase} : {})
    });
    this.adapter = null;
    this.video = null;
    this.lastEnd = null;
    this.ending = false;
  }

  /* ----------------------------------------------------------------- status */

  status() {
    const live = this.sessionManager.status();
    const days = this.#retentionDays();
    const login = this.oauth.status();
    const officialConfigured = Boolean(this.client?.configured) || Boolean(this.apiKey?.configured);
    const captureMode = this.#mode();
    return {
      // Kept for compatibility: `configured` means the official API path has
      // credentials. The anonymous web client is always available but is
      // deliberately reported separately because it is experimental.
      configured: officialConfigured,
      officialConfigured,
      captureMode,
      mode: captureMode,
      anonymous: {
        available: true,
        experimental: true,
        reason: 'unofficial-web-client',
        requiresApiKey: false,
        requiresLogin: false
      },
      oauthConfigured: Boolean(this.client?.configured),
      apiKey: describeApiKey(this.apiKey),
      authMode: this.#authMode(),
      client: describeOAuthClient(this.client),
      login,
      loginState: this.oauth.state,
      connection: {
        state: this.adapter?.state ?? 'idle',
        detail: this.adapter?.snapshot().detail ?? null,
        videoId: this.video?.videoId ?? null,
        title: this.video?.title ?? null,
        viewers: this.adapter?.hotness ?? this.video?.concurrentViewers ?? null,
        mode: this.adapter?.snapshot?.().detail?.mode ?? captureMode,
        lastEnd: this.lastEnd
      },
      quota: {
        used: this.api.quotaUsed,
        limit: this.api.quotaLimit,
        remaining: this.api.quotaRemaining
      },
      policy: this.db ? retentionStatus(this.db, {days, now: this.now()}) : null,
      recording: live.connection,
      session: live.activeSession,
      capabilities: {
        // Sign-in is only *required* for the official OAuth path when no
        // anonymous public-data key exists. The experimental web path needs
        // neither an API key nor a Google account.
        requiresSignIn: captureMode === 'official' && Boolean(this.client?.configured) && !this.#apiKeyActive(),
        anonymousReadSupported: true,
        anonymousExperimental: true,
        officialConfigured,
        oauthScopes: login.scopes,
        liveOnly: true,
        modes: ['official', 'anonymous']
      }
    };
  }

  /** `official` (Data API) | `anonymous` (experimental web client). */
  #mode(requested = null) {
    const allowed = ['official', 'anonymous'];
    if (allowed.includes(requested)) return requested;
    const configured = this.settings?.get?.().youtubeCaptureMode;
    return allowed.includes(configured) ? configured : 'official';
  }

  /** `api-key` (anonymous, public data) | `oauth` (streamer signed in) | `none`. */
  #authMode() {
    if (this.oauth.status().signedIn) return 'oauth';
    if (this.#apiKeyActive()) return 'api-key';
    return 'none';
  }

  #apiKeyActive() {
    return Boolean(this.apiKey?.configured);
  }

  /**
   * The bearer token for OAuth mode, or null when this installation only has an
   * anonymous API key. A missing/expired Google session must fall back to the
   * key instead of turning a public-data request into an error.
   */
  async #accessTokenOrNull() {
    const login = this.oauth.status();
    if (!login.configured && !login.hasRefreshToken) return null;
    try {
      return await this.oauth.getAccessToken();
    } catch (error) {
      this.logger?.debug?.({event: 'youtube.oauth.token.unavailable', code: error?.code ?? 'unknown'});
      return null;
    }
  }

  /** Fail early with a clear message instead of a generic 401 from Google. */
  #requireCredential() {
    if (this.#apiKeyActive() || this.oauth.status().signedIn || this.oauth.status().hasRefreshToken) return;
    throw new AppError('YOUTUBE_NOT_CONFIGURED', {
      messageKey: 'errors.youtubeNotConfigured',
      httpStatus: 409
    });
  }

  #retentionDays() {
    const value = this.settings?.get?.().youtubeRawRetentionDays;
    return normalizeRetentionDays(value);
  }

  /* ------------------------------------------------------------------ login */

  async startLogin({locale = 'en'} = {}) {
    const result = await this.oauth.startLogin({locale});
    return {
      authUrl: result.authUrl,
      expiresAt: result.expiresAt,
      reused: result.reused,
      client: describeOAuthClient(this.client)
    };
  }

  async waitForLogin() {
    return this.oauth.waitForLogin();
  }

  async loginStatus() {
    return this.oauth.status();
  }

  async logout() {
    await this.disconnect();
    const result = await this.oauth.logout();
    return {...this.oauth.status(), revoked: result.revoked};
  }

  /** Read the authorized channel so the UI can show "connected as …". */
  async #loadChannel(manager) {
    const channel = await this.api.myChannel();
    if (channel) {
      manager.setChannel(channel);
      this.logger?.info({event: 'youtube.channel.resolved', channelId: channel.id ?? null});
    }
  }

  /* --------------------------------------------------------------- broadcast */

  /**
   * Locate a broadcast from a link or a video id.
   * Returns metadata plus an explicit `recordable` flag and a reason code, so a
   * normal video or an ended stream can never be presented as "ready".
   */
  async checkVideo(input, {mode = null} = {}) {
    const selected = this.#mode(mode);
    const parsed = parseYouTubeInput(input);
    if (selected === 'anonymous') {
      const video = await this.anonymous.getVideo(parsed.videoId);
      let blocker = checkAnonymousRecordable(video);
      let chatError = null;
      if (video.isLive) {
        try {
          await this.anonymous.openChat(video.videoId);
          video.chatAvailable = true;
        } catch (error) {
          chatError = error;
          if ([YOUTUBE_ERRORS.CHAT_DISABLED, YOUTUBE_ERRORS.CHAT_ENDED, YOUTUBE_ERRORS.CHAT_NOT_FOUND].includes(error?.code)) {
            video.chatAvailable = false;
          } else {
            throw toApiError(error);
          }
        }
      }
      blocker = checkAnonymousRecordable(video) ?? blocker;
      return {
        ...video,
        input: String(input ?? ''),
        form: parsed.form,
        liveUrl: `https://www.youtube.com/live/${parsed.videoId}`,
        recordable: !blocker,
        reason: blocker?.code ?? null,
        mode: 'anonymous',
        experimental: true,
        chatChecked: true,
        chatError: chatError?.code ?? null,
        startedAtEpochMs: epochOrNull(video.actualStartTime)
      };
    }

    this.#requireCredential();
    const video = await this.api.videos({videoId: parsed.videoId});
    const blocker = checkRecordable(video);
    return {
      ...video,
      input: String(input ?? ''),
      form: parsed.form,
      liveUrl: `https://www.youtube.com/live/${parsed.videoId}`,
      recordable: !blocker,
      reason: blocker?.code ?? null,
      mode: 'official',
      experimental: false,
      startedAtEpochMs: epochOrNull(video.actualStartTime)
    };
  }

  async connect(input, {mode = null} = {}) {
    const selected = this.#mode(mode);
    const existing = this.sessionManager.status().activeSession;
    if (existing) {
      throw new AppError(ERROR_CODES.SESSION_ACTIVE, {
        messageKey: 'errors.sessionActive',
        details: {sessionId: existing.id},
        httpStatus: 409
      });
    }
    if (selected === 'anonymous') {
      return this.#connectAnonymous(input);
    }
    this.#requireCredential();
    const video = await this.checkVideo(input, {mode: 'official'});
    const blocker = checkRecordable(video);
    if (blocker) throw toApiError(blocker);

    const adapter = new YouTubeLiveChatAdapter({
      videoId: video.videoId,
      video,
      api: this.api,
      logger: this.logger,
      now: this.now
    });
    adapter.onEnd = ({reason}) => {
      this.lastEnd = {reason, at: this.now(), mode: 'official'};
      this.#endSession(reason).catch(() => {});
    };
    adapter.onAuthError = () => this.oauth.handleAuthFailure();
    this.adapter = adapter;
    this.video = video;
    return this.#startAdapter({
      adapter,
      input,
      video,
      mode: 'official',
      sourceQuality: SOURCE_QUALITY_ESTIMATED,
      broadcasterName: video.channelTitle ?? null
    });
  }

  async #connectAnonymous(input) {
    const video = await this.checkVideo(input, {mode: 'anonymous'});
    const blocker = checkAnonymousRecordable(video);
    if (blocker) throw toApiError(blocker);

    const adapter = new YouTubeAnonymousLiveChatAdapter({
      videoId: video.videoId,
      video,
      client: this.anonymous,
      logger: this.logger,
      now: this.now
    });
    adapter.onEnd = ({reason}) => {
      this.lastEnd = {reason, at: this.now(), mode: 'anonymous'};
      this.#endSession(reason).catch(() => {});
    };
    this.adapter = adapter;
    this.video = video;
    return this.#startAdapter({
      adapter,
      input,
      video,
      mode: 'anonymous',
      sourceQuality: SOURCE_QUALITY.ESTIMATED,
      broadcasterName: video.channelTitle ?? null
    });
  }

  async #startAdapter({adapter, input, video, mode, sourceQuality, broadcasterName}) {
    try {
      const result = await this.sessionManager.startPlatform({
        platform: 'youtube',
        platformRoomId: video.videoId,
        roomTitle: video.title ?? `YouTube ${video.videoId}`,
        broadcasterName,
        broadcasterUid: video.channelId ?? null,
        sourceQuality,
        simulated: false,
        platformStartedAt: epochOrNull(video.actualStartTime),
        createAdapter: () => adapter
      });
      if (!result.started) {
        throw new AppError(ERROR_CODES.SESSION_ACTIVE, {
          messageKey: 'errors.sessionActive',
          details: {sessionId: result.session?.id ?? null},
          httpStatus: 409
        });
      }
      this.logger?.info({
        event: 'youtube.session.started',
        sessionId: result.session.id,
        videoId: video.videoId,
        mode
      });
      return {
        session: result.session,
        video: {...video, input: String(input ?? ''), mode},
        connection: adapter.snapshot()
      };
    } catch (error) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      if (this.adapter === adapter) this.adapter = null;
      throw toApiError(error);
    }
  }

  async #endSession(reason) {
    if (this.ending) return;
    this.ending = true;
    try {
      const active = this.sessionManager.status().activeSession;
      if (active && active.platform === 'youtube') {
        await this.sessionManager.stopActive({status: 'ended'});
        this.logger?.info({event: 'youtube.session.autoEnded', reason});
      }
    } finally {
      this.adapter = null;
      this.ending = false;
      this.#applyRetention();
    }
  }

  async disconnect() {
    const active = this.sessionManager.status().activeSession;
    if (!active || active.platform !== 'youtube') {
      if (this.adapter) {
        await this.adapter.stop().catch(() => {});
        this.adapter = null;
      }
      return {stopped: false};
    }
    const result = await this.sessionManager.stopActive({status: 'ended'});
    this.adapter = null;
    this.#applyRetention();
    return result;
  }

  /* --------------------------------------------------------------- retention */

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {now: this.now(), days: this.#retentionDays(), logger: this.logger});
  }

  /** Apply the YouTube raw-content retention policy now (also runs at startup). */
  applyRetention() {
    const summary = this.#applyRetention();
    return {summary, status: this.db ? retentionStatus(this.db, {days: this.#retentionDays(), now: this.now()}) : null};
  }

  async shutdown() {
    if (this.adapter) {
      await this.adapter.stop().catch(() => {});
      this.adapter = null;
    }
  }
}

export {LOGIN_STATE, OAUTH_CONFIG_FILE_NAME};
export const __internal = {epochOrNull, SOURCE_QUALITY_ESTIMATED};
