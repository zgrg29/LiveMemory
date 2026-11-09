import {AppError, ERROR_CODES} from '../../shared/errors.mjs';
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
 * All events still flow through SessionManager -> EventIngest. Stable identities
 * are preserved; events without a Channel ID remain identity-incomplete.
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
    anonymousClient = null
  } = {}) {
    this.sessionManager = sessionManager;
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
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

  status() {
    const live = this.sessionManager.status();
    const days = this.#retentionDays();
    return {
      // Deliberately simple: there is no credential or mode to configure.
      available: true,
      mode: 'web',
      connection: {
        state: this.adapter?.state ?? 'idle',
        detail: this.adapter?.snapshot().detail ?? null,
        videoId: this.video?.videoId ?? null,
        title: this.video?.title ?? null,
        viewers: this.adapter?.hotness ?? this.video?.concurrentViewers ?? null,
        lastEnd: this.lastEnd
      },
      policy: this.db ? retentionStatus(this.db, {days, now: this.now()}) : null,
      recording: live.connection,
      session: live.activeSession,
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

  async connect(input) {
    const existing = this.sessionManager.status().activeSession;
    if (existing) {
      throw new AppError(ERROR_CODES.SESSION_ACTIVE, {
        messageKey: 'errors.sessionActive',
        details: {sessionId: existing.id},
        httpStatus: 409
      });
    }
    const video = await this.checkVideo(input);
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
      this.lastEnd = {reason, at: this.now(), mode: 'web'};
      this.#endSession(reason).catch(() => {});
    };
    this.adapter = adapter;
    this.video = video;
    return this.#startAdapter({adapter, input, video});
  }

  async #startAdapter({adapter, input, video}) {
    try {
      const result = await this.sessionManager.startPlatform({
        platform: 'youtube',
        platformRoomId: video.videoId,
        roomTitle: video.title ?? `YouTube ${video.videoId}`,
        broadcasterName: video.channelTitle ?? null,
        broadcasterUid: video.channelId ?? null,
        sourceQuality: SOURCE_QUALITY_ESTIMATED,
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
        mode: 'web'
      });
      return {
        session: result.session,
        video: {...video, input: String(input ?? '')},
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

  #applyRetention() {
    if (!this.db) return null;
    return runRetention(this.db, {now: this.now(), days: this.#retentionDays(), logger: this.logger});
  }

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

export const __internal = {epochOrNull, SOURCE_QUALITY_ESTIMATED};
