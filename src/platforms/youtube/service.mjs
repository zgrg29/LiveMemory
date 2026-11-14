import {AppError} from '../../shared/errors.mjs';
import {duplicateRoomError, sessionIdRequiredError} from '../../shared/recording.mjs';
import {SOURCE_QUALITY} from '../../shared/events.mjs';
import {YouTubeApiError, YOUTUBE_ERRORS} from './errors.mjs';
import {YouTubeAnonymousClient} from './anonymous/client.mjs';
import {YouTubeAnonymousLiveChatAdapter, checkAnonymousRecordable} from './anonymous/adapter.mjs';
import {parseYouTubeInput} from './link.mjs';
import {retentionStatus, runRetention, normalizeRetentionDays} from '../../storage/retention.mjs';

/**
 * YouTube Live chat via the public live web page.
 *
 * This is the only YouTube connection path. It needs no Google account, API key
 * or cookie. The public page's own client context is used read-only. The
 * interface is not a stable official API and may change; the UI explains this
 * once in the settings/about area instead of blocking every connection attempt.
 *
 * Several broadcasts may be recorded concurrently; each one has its own adapter
 * owned by SessionManager. All events still flow through EventIngest. Stable
 * identities are preserved; events without a Channel ID remain
 * identity-incomplete.
 */

const SOURCE_QUALITY_ESTIMATED = SOURCE_QUALITY.ESTIMATED;

function epochOrNull(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Map adapter/client errors to stable API errors with translatable keys. */
export function toApiError(error) {
  if (error instanceof AppError) return error;
  const code = error?.code ?? 'UNKNOWN';
  const map = {
    YOUTUBE_LINK_INVALID: [400, 'errors.youtubeLinkInvalid'],
    YOUTUBE_NOT_LIVE_UPCOMING: [409, 'errors.youtubeUpcoming'],
    YOUTUBE_NOT_LIVE_ENDED: [409, 'errors.youtubeEnded'],
    YOUTUBE_NOT_LIVE_VIDEO: [409, 'errors.youtubeNotLive'],
    YOUTUBE_NOT_LIVE: [409, 'errors.youtubeNotLive'],
    [YOUTUBE_ERRORS.VIDEO_NOT_FOUND]: [404, 'errors.youtubeVideoNotFound'],
    [YOUTUBE_ERRORS.CHAT_DISABLED]: [409, 'errors.youtubeChatDisabled'],
    [YOUTUBE_ERRORS.CHAT_NOT_FOUND]: [404, 'errors.youtubeChatUnavailable'],
    [YOUTUBE_ERRORS.CHAT_ENDED]: [410, 'errors.youtubeChatEnded'],
    [YOUTUBE_ERRORS.RATE_LIMITED]: [429, 'errors.youtubeRateLimit'],
    [YOUTUBE_ERRORS.WEB_NETWORK]: [502, 'errors.youtubeWebNetwork'],
    [YOUTUBE_ERRORS.WEB_BLOCKED]: [429, 'errors.youtubeWebBlocked'],
    [YOUTUBE_ERRORS.WEB_PROTOCOL]: [502, 'errors.youtubeWebProtocol'],
    [YOUTUBE_ERRORS.WEB_RESPONSE_INVALID]: [502, 'errors.youtubeWebResponseInvalid'],
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
    sessionManager,
    db = null,
    settings = null,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    webBase = null,
    anonymousClient = null,
    adapterOptions = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.adapterOptions = adapterOptions;
    this.anonymous = anonymousClient ?? new YouTubeAnonymousClient({
      fetchImpl,
      now,
      logger,
      ...(webBase ? {baseUrl: webBase} : {})
    });
    this.lastEnd = null;
  }

  #recordings() {
    return this.sessionManager.status().recordings.filter((recording) => recording.platform === 'youtube');
  }

  status() {
    const recordings = this.#recordings();
    const latest = recordings.at(-1) ?? null;
    const days = this.#retentionDays();
    return {
      // Deliberately simple: there is no credential or mode to configure.
      available: true,
      mode: 'web',
      connection: latest
        ? {
          state: latest.connection.state,
          detail: latest.connection.detail,
          videoId: latest.meta?.video?.videoId ?? latest.platformRoomId,
          title: latest.meta?.video?.title ?? latest.roomTitle,
          viewers: latest.connection.detail?.viewers ?? latest.meta?.video?.concurrentViewers ?? null,
          lastEnd: this.lastEnd
        }
        : {state: 'idle', detail: null, videoId: null, title: null, viewers: null, lastEnd: this.lastEnd},
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
      policy: this.db ? retentionStatus(this.db, {days, now: this.now()}) : null,
      capabilities: {
        requiresApiKey: false,
        requiresLogin: false,
        requiresCookie: false,
        liveOnly: true
      }
    };
  }

  #retentionDays() {
    return normalizeRetentionDays(this.settings?.get?.().youtubeRawRetentionDays);
  }

  /**
   * Locate a broadcast and verify that its public chat page can be opened.
   * A normal video, an upcoming/ended stream or disabled chat is refused with a
   * specific reason instead of being presented as ready.
   */
  async checkVideo(input) {
    const parsed = parseYouTubeInput(input);
    const video = await this.anonymous.getVideo(parsed.videoId);
    let blocker = checkAnonymousRecordable(video);
    let chatError = null;
    if (video.isLive) {
      try {
        await this.anonymous.openChat(video.videoId);
        video.chatAvailable = true;
      } catch (error) {
        chatError = error;
        if ([
          YOUTUBE_ERRORS.CHAT_DISABLED,
          YOUTUBE_ERRORS.CHAT_ENDED,
          YOUTUBE_ERRORS.CHAT_NOT_FOUND
        ].includes(error?.code)) {
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
      chatChecked: true,
      chatError: chatError?.code ?? null,
      startedAtEpochMs: epochOrNull(video.actualStartTime)
    };
  }

  /**
   * Start a capture for a broadcast that the automatic monitor already
   * identified. The public watch page was parsed by the detector, so no extra
   * metadata request is made here; the adapter still opens the public chat page
   * and fails honestly if chat is unavailable, members-only or disabled.
   */
  async connectDetected(video, {monitorTargetId = null, input = null} = {}) {
    const blocker = checkAnonymousRecordable(video);
    if (blocker) throw toApiError(blocker);
    const adapter = new YouTubeAnonymousLiveChatAdapter({
      videoId: video.videoId,
      video,
      client: this.anonymous,
      logger: this.logger,
      now: this.now,
      ...(this.adapterOptions ? {options: this.adapterOptions} : {})
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'youtube',
      platformRoomId: video.videoId,
      roomTitle: video.title ?? `YouTube ${video.videoId}`,
      broadcasterName: video.channelTitle ?? null,
      broadcasterUid: video.channelId ?? null,
      sourceQuality: SOURCE_QUALITY_ESTIMATED,
      simulated: false,
      platformStartedAt: epochOrNull(video.actualStartTime),
      monitorTargetId,
      createAdapter: () => adapter,
      meta: {video, detection: 'monitor', input: input ?? null},
      onEnded: ({reason}) => {
        this.lastEnd = {reason, at: this.now(), mode: 'web'};
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
      event: 'youtube.session.started',
      sessionId: result.session.id,
      videoId: video.videoId,
      mode: 'web',
      monitorTargetId: monitorTargetId ?? null
    });
    return {session: result.session, video: {...video, input: input ?? null}, connection: adapter.snapshot()};
  }

  async connect(input) {
    const video = await this.checkVideo(input);
    const blocker = checkAnonymousRecordable(video);
    if (blocker) throw toApiError(blocker);

    const adapter = new YouTubeAnonymousLiveChatAdapter({
      videoId: video.videoId,
      video,
      client: this.anonymous,
      logger: this.logger,
      now: this.now,
      ...(this.adapterOptions ? {options: this.adapterOptions} : {})
    });
    const result = await this.sessionManager.startPlatform({
      platform: 'youtube',
      platformRoomId: video.videoId,
      roomTitle: video.title ?? `YouTube ${video.videoId}`,
      broadcasterName: video.channelTitle ?? null,
      broadcasterUid: video.channelId ?? null,
      sourceQuality: SOURCE_QUALITY_ESTIMATED,
      simulated: false,
      platformStartedAt: epochOrNull(video.actualStartTime),
      createAdapter: () => adapter,
      meta: {video},
      onEnded: ({reason}) => {
        this.lastEnd = {reason, at: this.now(), mode: 'web'};
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
      event: 'youtube.session.started',
      sessionId: result.session.id,
      videoId: video.videoId,
      mode: 'web'
    });
    return {
      session: result.session,
      video: {...video, input: String(input ?? '')},
      connection: adapter.snapshot()
    };
  }

  async disconnect({sessionId = null} = {}) {
    const result = await this.sessionManager.stopPlatform('youtube', {sessionId, status: 'ended', reason: 'user'});
    if (result.reason === 'session_id_required') {
      throw sessionIdRequiredError({count: result.count, platform: 'youtube'});
    }
    if (result.stopped) this.#applyRetention();
    return result;
  }

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {now: this.now(), days: this.#retentionDays(), logger: this.logger});
  }

  applyRetention() {
    const summary = this.#applyRetention();
    return {summary, status: this.db ? retentionStatus(this.db, {days: this.#retentionDays(), now: this.now()}) : null};
  }
}

export const __internal = {epochOrNull, SOURCE_QUALITY_ESTIMATED};
