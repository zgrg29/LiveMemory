import {AppError} from '../shared/errors.mjs';
import {getSession} from '../storage/repositories/sessions.mjs';
import {
  createMonitorTarget,
  deleteMonitorTarget,
  findMonitorTargetByKey,
  getMonitorTarget,
  listMonitorTargets,
  listMonitorTargetSessions,
  updateMonitorTarget
} from '../storage/repositories/monitor-targets.mjs';
import {
  MONITOR_ERROR,
  MONITOR_ERROR_RETRY_MS,
  MONITOR_INITIAL_STAGGER_MS,
  MONITOR_MAX_CONCURRENT_CHECKS,
  MONITOR_PLATFORMS,
  MONITOR_POLICY,
  MONITOR_STATE,
  MONITOR_TICK_MS,
  monitorPolicy
} from './constants.mjs';
import {
  classifyMonitorError,
  initialCheckDelay,
  isRecordingState,
  liveCycleKey,
  parseMeta,
  retryDelay,
  serializeMonitorTarget,
  summarizeTargets
} from './model.mjs';
import {monitorError} from './errors.mjs';
import {RequestPacer} from './pacer.mjs';
import {BilibiliRoomDetector} from './detectors/bilibili.mjs';
import {YouTubeChannelDetector} from './detectors/youtube.mjs';

/**
 * Unified automatic-monitoring scheduler.
 *
 * One target (room or channel) produces many sessions over time. The manager
 * owns the target state machine; `SessionManager` still owns every adapter and
 * `EventIngest` still owns every write. Monitoring never writes events itself.
 *
 * Key invariants:
 *   - A network error is never an end of broadcast and never creates a session.
 *   - A reconnecting adapter keeps its existing session; only a confirmed live
 *     observation after the previous session ended may create a new one.
 *   - Checks run only while a target is NOT recording, one read per target, with
 *     per-platform pacing, jitter and exponential backoff.
 *   - The target row is never deleted when a broadcast ends; only an explicit
 *     user delete removes it, and only while it is not recording.
 */

export class MonitoringManager {
  constructor({
    db,
    sessionManager,
    bilibili = null,
    youtube = null,
    logger = null,
    now = Date.now,
    detectors = null,
    onChange = () => {},
    random = Math.random,
    timers = null
  } = {}) {
    this.db = db;
    this.sessionManager = sessionManager;
    this.bilibili = bilibili;
    this.youtube = youtube;
    this.logger = logger;
    this.now = now;
    this.onChange = onChange;
    this.random = random;
    this.timers = timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle)
    };
    this.pacer = new RequestPacer({now, minGapMs: MONITOR_POLICY.youtube.requestGapMs});
    this.detectors = detectors ?? this.#buildDetectors();
    this.inFlight = new Set();
    this.timer = null;
    this.stopped = false;
    this.started = false;
    this.lastTickAt = null;
  }

  #buildDetectors() {
    const detectors = {};
    if (this.bilibili?.api) {
      detectors.bilibili = new BilibiliRoomDetector({
        api: this.bilibili.api,
        logger: this.logger,
        now: this.now,
        pacer: this.pacer,
        policy: MONITOR_POLICY.bilibili
      });
    }
    if (this.youtube?.anonymous) {
      detectors.youtube = new YouTubeChannelDetector({
        client: this.youtube.anonymous,
        fetchImpl: this.youtube.anonymous.fetchImpl ?? globalThis.fetch,
        baseUrl: this.youtube.anonymous.baseUrl,
        logger: this.logger,
        now: this.now,
        pacer: this.pacer,
        policy: MONITOR_POLICY.youtube
      });
    }
    return detectors;
  }

  /* ----------------------------------------------------------- lifecycle */

  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.recover();
    this.#schedule(0);
  }

  stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  #schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick()
        .catch((error) => {
          this.logger?.warn({event: 'monitor.tick.failed', code: error?.code ?? 'unknown'});
        })
        .finally(() => this.#schedule(MONITOR_TICK_MS));
    }, Math.max(0, Number(delayMs) || 0));
    this.timer?.unref?.();
  }

  /**
   * Normalise targets left behind by a crash/shutdown. Called once at startup
   * and again when a target is created, so a stale `checking` row can never
   * block a target forever.
   */
  recover() {
    const now = this.now();
    for (const row of listMonitorTargets(this.db)) {
      const patch = {};
      if ([MONITOR_STATE.CHECKING, MONITOR_STATE.CONNECTING, MONITOR_STATE.ENDING].includes(row.state)) {
        patch.state = row.active_session_id ? MONITOR_STATE.RECORDING : (row.enabled ? MONITOR_STATE.WAITING : MONITOR_STATE.PAUSED);
      }
      if (row.active_session_id) {
        const session = getSession(this.db, row.active_session_id);
        if (!session || session.status !== 'live') {
          patch.active_session_id = null;
          patch.last_session_id = row.last_session_id ?? row.active_session_id;
          patch.state = row.enabled ? MONITOR_STATE.WAITING : MONITOR_STATE.PAUSED;
          patch.next_check_at = now + (MONITOR_POLICY[row.platform]?.endCooldownMs ?? 15000);
        }
      } else if (row.state === MONITOR_STATE.RECORDING) {
        patch.state = row.enabled ? MONITOR_STATE.WAITING : MONITOR_STATE.PAUSED;
      }
      if (row.enabled && patch.next_check_at === undefined && (!row.next_check_at || row.next_check_at < now - MONITOR_TICK_MS)) {
        // Restore a missing/past schedule, but stagger it instead of checking
        // every target at the same instant after a restart.
        patch.next_check_at = now + initialCheckDelay(row.id, {now, random: this.random});
      }
      if (row.enabled && row.state === MONITOR_STATE.ERROR && !row.next_check_at) {
        patch.next_check_at = now + MONITOR_ERROR_RETRY_MS;
      }
      if (Object.keys(patch).length > 0) {
        updateMonitorTarget(this.db, row.id, {...patch, updated_at: now});
      }
    }
  }

  /* -------------------------------------------------------------- read */

  getTarget(targetId) {
    const row = getMonitorTarget(this.db, targetId);
    return row ? this.#serialize(row) : null;
  }

  listTargets() {
    return listMonitorTargets(this.db).map((row) => this.#serialize(row));
  }

  listSessions(targetId, {limit = 20} = {}) {
    const row = getMonitorTarget(this.db, targetId);
    if (!row) throw monitorError(MONITOR_ERROR.NOT_FOUND, {httpStatus: 404});
    return listMonitorTargetSessions(this.db, row.id, {limit});
  }

  status() {
    const targets = this.listTargets();
    return {
      enabled: true,
      policy: {
        bilibili: {checkIntervalMs: MONITOR_POLICY.bilibili.baseMs},
        youtube: {checkIntervalMs: MONITOR_POLICY.youtube.baseMs}
      },
      summary: summarizeTargets(targets),
      targets
    };
  }

  #serialize(row) {
    const recording = row.active_session_id
      ? this.sessionManager.getRecording(row.active_session_id)
      : null;
    return serializeMonitorTarget(row, {now: this.now(), recording});
  }

  #emit() {
    try {
      this.onChange();
    } catch (error) {
      this.logger?.warn({event: 'monitor.change.failed', code: error?.code ?? 'unknown'});
    }
  }

  /* ------------------------------------------------------------ create */

  async createTarget({platform, input, enabled = true} = {}) {
    const platformName = String(platform ?? '');
    if (!MONITOR_PLATFORMS.includes(platformName)) {
      throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    }
    const detector = this.detectors[platformName];
    if (!detector) throw monitorError(MONITOR_ERROR.NOT_CONFIGURED, {httpStatus: 409});
    const resolved = await detector.resolve(input);
    const existing = findMonitorTargetByKey(this.db, resolved.platform, resolved.targetKey);
    if (existing) {
      throw new AppError('MONITOR_TARGET_EXISTS', {
        messageKey: 'errors.monitorTargetExists',
        details: {targetId: existing.id},
        httpStatus: 409
      });
    }
    const now = this.now();
    const row = createMonitorTarget(this.db, {
      platform: resolved.platform,
      targetKey: resolved.targetKey,
      displayName: resolved.displayName,
      input: resolved.input ?? String(input ?? ''),
      broadcasterId: resolved.broadcasterId ?? null,
      platformUid: resolved.platformUid ?? null,
      enabled: enabled !== false,
      state: enabled === false ? MONITOR_STATE.PAUSED : MONITOR_STATE.WAITING,
      nextCheckAt: enabled === false ? null : now + Math.round(500 + this.random() * 2500),
      meta: resolved.meta ?? null,
      now
    });
    this.logger?.info({
      event: 'monitor.target.created',
      targetId: row.id,
      platform: row.platform,
      targetKey: row.target_key
    });
    this.#emit();
    return this.#serialize(row);
  }

  /* ------------------------------------------------------------ actions */

  async updateTarget(targetId, {action = null, enabled = null} = {}) {
    const row = getMonitorTarget(this.db, targetId);
    if (!row) throw monitorError(MONITOR_ERROR.NOT_FOUND, {httpStatus: 404});
    const now = this.now();
    const recording = row.active_session_id && this.sessionManager.getRecording(row.active_session_id);

    if (action === 'resume_capture') {
      const updated = updateMonitorTarget(this.db, row.id, {
        enabled: 1,
        state: MONITOR_STATE.WAITING,
        paused_at: null,
        consecutive_failures: 0,
        last_error_code: null,
        last_error_at: null,
        next_check_at: now,
        meta_json: mergeMeta(row.meta_json, {manualStop: null}),
        updated_at: now
      });
      await this.#runCheck(updated.id);
      this.#emit();
      return this.getTarget(updated.id);
    }

    if (action === 'pause' || enabled === false) {
      if (row.enabled === 0) return this.#serialize(row);
      const nextState = recording ? row.state : MONITOR_STATE.PAUSED;
      const updated = updateMonitorTarget(this.db, row.id, {
        enabled: 0,
        state: nextState,
        paused_at: now,
        next_check_at: null,
        updated_at: now
      });
      this.#emit();
      return this.#serialize(updated);
    }

    if (action === 'resume' || enabled === true || action === 'retry') {
      const updated = updateMonitorTarget(this.db, row.id, {
        enabled: 1,
        state: recording ? row.state : MONITOR_STATE.WAITING,
        paused_at: null,
        consecutive_failures: 0,
        last_error_code: null,
        last_error_at: null,
        next_check_at: now + 800,
        updated_at: now
      });
      this.#emit();
      return this.#serialize(updated);
    }

    throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
  }

  /**
   * Called after a user explicitly stops capture for one session.
   *
   * The target stays enabled: monitoring may keep checking the platform. A
   * persisted suppression record prevents any automatic path from recreating a
   * capture for the same live cycle, including after a process restart.
   */
  noteManualStop(sessionId) {
    const id = String(sessionId ?? '');
    const session = getSession(this.db, id);
    if (!session) return null;
    const targetId = session.monitor_target_id ?? null;
    const target = targetId
      ? getMonitorTarget(this.db, targetId)
      : listMonitorTargets(this.db).find((row) => row.active_session_id === id || row.last_session_id === id) ?? null;
    if (!target) return null;
    if (target.enabled === 0) {
      // A paused target must not become an active capture target. Keep the
      // suppression record so resuming the whole monitor does not restart this
      // same live cycle either.
      const paused = updateMonitorTarget(this.db, target.id, {
        active_session_id: null,
        last_session_id: id,
        state: MONITOR_STATE.PAUSED,
        next_check_at: null,
        meta_json: mergeMeta(target.meta_json, {
          manualStop: {
            sessionId: id,
            liveKey: this.#suppressedLiveKey(target),
            stoppedAt: this.now(),
            awaitingOffline: !this.#suppressedLiveKey(target)
          }
        }),
        updated_at: this.now()
      });
      this.#emit();
      return this.#serialize(paused);
    }
    const liveKey = this.#suppressedLiveKey(target);
    const suppression = {
      sessionId: id,
      liveKey,
      stoppedAt: this.now(),
      awaitingOffline: !liveKey
    };
    const updated = updateMonitorTarget(this.db, target.id, {
      active_session_id: null,
      last_session_id: id,
      state: MONITOR_STATE.LIVE_STOPPED,
      next_check_at: this.now() + Math.round(monitorPolicy(target.platform).baseMs),
      meta_json: mergeMeta(target.meta_json, {
        manualStop: suppression,
        lastCheck: {
          lastObservation: 'live_stopped',
          liveStoppedAt: this.now()
        }
      }),
      updated_at: this.now()
    });
    this.logger?.info({
      event: 'monitor.capture.manual_stop',
      targetId: target.id,
      sessionId: id,
      liveKey
    });
    this.#emit();
    return this.#serialize(updated);
  }

  #suppressedLiveKey(target) {
    const meta = parseMeta(target?.meta_json) ?? {};
    return meta?.lastCheck?.lastLiveKey
      ?? meta?.manualStop?.liveKey
      ?? null;
  }

  async deleteTarget(targetId, {confirm = false} = {}) {
    if (confirm !== true) {
      throw new AppError('DELETE_CONFIRM_REQUIRED', {messageKey: 'errors.deleteConfirmRequired', httpStatus: 400});
    }
    const row = getMonitorTarget(this.db, targetId);
    if (!row) throw monitorError(MONITOR_ERROR.NOT_FOUND, {httpStatus: 404});
    const recording = row.active_session_id
      ? (this.sessionManager.getRecording(row.active_session_id) ?? getSession(this.db, row.active_session_id))
      : null;
    if (recording && (recording.status === 'live' || this.sessionManager.getRecording(row.active_session_id))) {
      throw new AppError('MONITOR_TARGET_RECORDING', {
        messageKey: 'errors.monitorTargetRecording',
        details: {sessionId: row.active_session_id},
        httpStatus: 409
      });
    }
    const deleted = deleteMonitorTarget(this.db, row.id);
    this.logger?.info({event: 'monitor.target.deleted', targetId: row.id, deleted});
    this.#emit();
    return {deleted};
  }

  /**
   * Force one check now. It still goes through the same detector, pacing and
   * state machine; it only bypasses the scheduled delay.
   */
  async checkNow(targetId) {
    const row = getMonitorTarget(this.db, targetId);
    if (!row) throw monitorError(MONITOR_ERROR.NOT_FOUND, {httpStatus: 404});
    if (!row.enabled) {
      throw new AppError('MONITOR_TARGET_PAUSED', {messageKey: 'errors.monitorTargetPaused', httpStatus: 409});
    }
    if (this.inFlight.has(row.id)) return this.#serialize(row);
    if (row.active_session_id && this.sessionManager.getRecording(row.active_session_id)) {
      return this.#serialize(row);
    }
    await this.#runCheck(row.id);
    return this.getTarget(row.id);
  }

  /* ----------------------------------------------------------- scheduler */

  async tick() {
    if (this.stopped) return;
    this.lastTickAt = this.now();
    this.#reconcile();
    const now = this.now();
    const candidates = listMonitorTargets(this.db)
      .filter((row) => row.enabled === 1)
      .filter((row) => !isRecordingState(row.state))
      .filter((row) => !this.inFlight.has(row.id))
      .filter((row) => !row.next_check_at || row.next_check_at <= now)
      .sort((a, b) => (a.next_check_at ?? 0) - (b.next_check_at ?? 0));
    const pending = [];
    for (const row of candidates) {
      if (this.inFlight.size >= MONITOR_MAX_CONCURRENT_CHECKS) break;
      pending.push(this.#runCheck(row.id).catch((error) => {
        this.logger?.warn({event: 'monitor.check.failed', targetId: row.id, code: error?.code ?? 'unknown'});
      }));
    }
    await Promise.allSettled(pending);
  }

  #reconcile() {
    const now = this.now();
    for (const row of listMonitorTargets(this.db)) {
      if (this.inFlight.has(row.id)) continue;
      if (row.active_session_id) {
        const session = getSession(this.db, row.active_session_id);
        if (session && session.status === 'live') {
          const ending = ['ended', 'carousel', 'not_started'].includes(session.platform_status);
          const nextState = ending ? MONITOR_STATE.ENDING : MONITOR_STATE.RECORDING;
          if (row.state !== nextState) {
            updateMonitorTarget(this.db, row.id, {state: nextState, updated_at: now});
            this.#emit();
          }
          continue;
        }
        // The broadcast ended (platform end, adapter end, user stop or startup
        // recovery). The target survives; only its active pointer is cleared.
        const endedId = row.last_session_id ?? row.active_session_id;
        const suppression = parseMeta(row.meta_json)?.manualStop ?? null;
        updateMonitorTarget(this.db, row.id, {
          active_session_id: null,
          last_session_id: endedId,
          state: row.enabled
            ? (suppression ? MONITOR_STATE.LIVE_STOPPED : MONITOR_STATE.WAITING)
            : MONITOR_STATE.PAUSED,
          next_check_at: row.enabled
            ? now + (suppression
              ? Math.round(monitorPolicy(row.platform).baseMs)
              : (MONITOR_POLICY[row.platform]?.endCooldownMs ?? 15000))
            : null,
          consecutive_failures: 0,
          last_error_code: null,
          last_error_at: null,
          updated_at: now
        });
        this.logger?.info({
          event: 'monitor.session.ended',
          targetId: row.id,
          sessionId: row.active_session_id
        });
        this.#emit();
        continue;
      }
      if (isRecordingState(row.state)) {
        // Stale lifecycle state without a session: never leave the target stuck.
        updateMonitorTarget(this.db, row.id, {
          state: row.enabled ? MONITOR_STATE.WAITING : MONITOR_STATE.PAUSED,
          next_check_at: row.enabled ? now + 2000 : null,
          updated_at: now
        });
        this.#emit();
      }
    }
  }

  async #runCheck(targetId) {
    const id = String(targetId);
    if (this.inFlight.has(id) || this.stopped) return;
    const row = getMonitorTarget(this.db, id);
    if (!row || !row.enabled) return;
    const detector = this.detectors[row.platform];
    if (!detector) {
      this.#recordFailure(row, monitorError(MONITOR_ERROR.NOT_CONFIGURED, {httpStatus: 409}));
      return;
    }
    this.inFlight.add(id);
    const startedAt = this.now();
    updateMonitorTarget(this.db, id, {
      state: MONITOR_STATE.CHECKING,
      last_check_at: startedAt,
      updated_at: startedAt
    });
    this.#emit();
    try {
      const observation = await detector.detect(row);
      if (this.stopped) return;
      const current = getMonitorTarget(this.db, id);
      if (!current || !current.enabled) return;
      if (observation?.status === 'live') {
        const suppression = parseMeta(current.meta_json)?.manualStop ?? null;
        if (suppression) {
          const observationKey = liveCycleKey(current.platform, current, observation);
          const newCycle = Boolean(suppression.liveKey)
            && Boolean(observationKey)
            && suppression.liveKey !== observationKey;
          if (!newCycle) {
            this.#holdManualStop(current, observation, suppression);
            return;
          }
          // A reliable platform cycle key changed (Bilibili live_time or a new
          // YouTube video). This is a genuinely new broadcast; clear the old
          // suppression and start a new session.
        }
        await this.#beginRecording(current, observation);
      } else {
        this.#afterNotLive(current, observation);
      }
    } catch (error) {
      if (this.stopped) return;
      const current = getMonitorTarget(this.db, id);
      if (current && current.enabled) this.#recordFailure(current, error);
    } finally {
      this.inFlight.delete(id);
    }
  }

  #holdManualStop(row, observation, suppression) {
    const now = this.now();
    const delay = retryDelay({
      policy: monitorPolicy(row.platform),
      kind: 'offline',
      random: this.random
    });
    const displayName = observation?.anchorName
      || observation?.channelTitle
      || row.display_name;
    const meta = mergeMeta(row.meta_json, {
      manualStop: suppression,
      lastCheck: {
        lastObservation: 'live_stopped',
        lastTitle: observation?.title ?? null,
        lastOnline: observation?.online ?? null,
        lastLiveKey: this.#suppressedLiveKey(row),
        observedAt: now
      }
    });
    applyMetadataMeta(meta, observation);
    const updated = updateMonitorTarget(this.db, row.id, {
      state: MONITOR_STATE.LIVE_STOPPED,
      next_check_at: now + delay,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_at: null,
      display_name: displayName,
      platform_uid: observation?.anchorUid === null || observation?.anchorUid === undefined
        ? row.platform_uid
        : String(observation.anchorUid),
      meta_json: meta,
      updated_at: now
    });
    this.logger?.info({
      event: 'monitor.check.live_stopped',
      targetId: row.id,
      sessionId: suppression?.sessionId ?? null,
      nextCheckInMs: delay
    });
    this.#emit();
    return updated;
  }

  #afterNotLive(row, observation = {}) {
    const now = this.now();
    const kind = observation?.status === 'upcoming' ? 'upcoming' : 'offline';
    const delay = retryDelay({
      policy: monitorPolicy(row.platform),
      kind,
      random: this.random
    });
    const meta = mergeMeta(row.meta_json, {
      manualStop: null,
      lastObservation: observation?.status ?? 'offline',
      lastVideoId: observation?.videoId ?? null,
      lastLiveKey: null,
      metadataAttemptedAt: observation?.metadataAttemptedAt ?? null,
      anchorName: observation?.anchorName ?? null,
      anchorUid: observation?.anchorUid === null || observation?.anchorUid === undefined
        ? null
        : String(observation.anchorUid),
      areaName: observation?.areaName ?? null,
      parentAreaName: observation?.parentAreaName ?? null,
      lastTitle: observation?.title ?? null,
      lastOnline: observation?.online ?? null,
      carousel: observation?.carousel === true,
      observedAt: now
    });
    applyMetadataMeta(meta, observation);
    const displayName = row.platform === 'youtube' && observation?.channelTitle
      ? observation.channelTitle
      : (row.platform === 'bilibili' && observation?.anchorName
        ? observation.anchorName
        : row.display_name);
    updateMonitorTarget(this.db, row.id, {
      state: MONITOR_STATE.WAITING,
      next_check_at: now + delay,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_at: null,
      display_name: displayName,
      platform_uid: observation?.anchorUid === null || observation?.anchorUid === undefined
        ? row.platform_uid
        : String(observation.anchorUid),
      meta_json: meta,
      updated_at: now
    });
    this.logger?.info({
      event: 'monitor.check.not_live',
      targetId: row.id,
      platform: row.platform,
      status: observation?.status ?? 'offline',
      nextCheckInMs: delay
    });
    this.#emit();
  }

  async #beginRecording(row, observation) {
    const now = this.now();
    updateMonitorTarget(this.db, row.id, {
      state: MONITOR_STATE.CONNECTING,
      next_check_at: null,
      last_error_code: null,
      last_error_at: null,
      updated_at: now
    });
    this.#emit();
    try {
      const result = await this.#startPlatformSession(row, observation);
      if (this.stopped) return;
      const sessionId = result?.session?.id
        ?? result?.session?.sessionId
        ?? result?.duplicate?.sessionId
        ?? null;
      if (!sessionId) throw new Error('session id missing');
      const startedAt = this.now();
      const liveKey = liveCycleKey(row.platform, row, observation);
      const meta = mergeMeta(row.meta_json, {
        manualStop: null,
        lastCheck: {
          lastLiveAt: startedAt,
          lastSessionId: sessionId,
          lastVideoId: observation?.videoId ?? null,
          lastTitle: observation?.title ?? null,
          lastLiveKey: liveKey,
          lastObservation: 'live'
        }
      });
      applyMetadataMeta(meta, observation);
      const displayName = row.platform === 'youtube' && observation?.channelTitle
        ? observation.channelTitle
        : (row.platform === 'bilibili' && observation?.anchorName
          ? observation.anchorName
          : row.display_name);
      updateMonitorTarget(this.db, row.id, {
        state: MONITOR_STATE.RECORDING,
        active_session_id: sessionId,
        last_session_id: sessionId,
        last_live_at: startedAt,
        consecutive_failures: 0,
        last_error_code: null,
        last_error_at: null,
        display_name: displayName,
        platform_uid: observation?.anchorUid === null || observation?.anchorUid === undefined
          ? row.platform_uid
          : String(observation.anchorUid),
        meta_json: meta,
        updated_at: startedAt
      });
      this.logger?.info({
        event: 'monitor.session.started',
        targetId: row.id,
        platform: row.platform,
        sessionId
      });
      this.#emit();
    } catch (error) {
      if (this.stopped) return;
      const current = getMonitorTarget(this.db, row.id);
      if (current && current.enabled) this.#recordFailure(current, error, {phase: 'start'});
    }
  }

  async #startPlatformSession(row, observation) {
    if (row.platform === 'bilibili') {
      if (!this.bilibili?.connectResolved) throw monitorError(MONITOR_ERROR.NOT_CONFIGURED);
      return this.bilibili.connectResolved({
        roomId: Number(row.target_key),
        title: observation?.title ?? null,
        anchorName: observation?.anchorName ?? row.display_name ?? null,
        anchorUid: observation?.anchorUid ?? row.platform_uid ?? null,
        liveStartedAt: observation?.liveStartedAt ?? null
      }, {monitorTargetId: row.id});
    }
    if (row.platform === 'youtube') {
      if (!this.youtube?.connectDetected) throw monitorError(MONITOR_ERROR.NOT_CONFIGURED);
      return this.youtube.connectDetected({
        videoId: observation?.videoId,
        title: observation?.title ?? null,
        channelId: row.target_key,
        channelTitle: observation?.channelTitle ?? row.display_name ?? null,
        isLive: true,
        state: 'live',
        isUpcoming: false,
        actualStartTime: observation?.startedAt ?? null,
        concurrentViewers: observation?.concurrentViewers ?? null
      }, {monitorTargetId: row.id, input: row.input});
    }
    throw monitorError(MONITOR_ERROR.NOT_CONFIGURED);
  }

  #recordFailure(row, error, {phase = 'check'} = {}) {
    if (!row?.id) return;
    if (error?.code === 'SESSION_DUPLICATE_ROOM' && error?.details?.sessionId) {
      const existing = getSession(this.db, error.details.sessionId);
      if (existing && existing.status === 'live') {
        const now = this.now();
        updateMonitorTarget(this.db, row.id, {
          state: MONITOR_STATE.RECORDING,
          active_session_id: existing.id,
          last_session_id: existing.id,
          last_live_at: now,
          next_check_at: null,
          consecutive_failures: 0,
          last_error_code: null,
          last_error_at: null,
          updated_at: now
        });
        this.#emit();
        return;
      }
    }
    const classified = classifyMonitorError(error);
    const now = this.now();
    const failures = Number(row.consecutive_failures ?? 0) + 1;
    const limit = monitorPolicy(row.platform).maxConsecutiveFailures;
    const fatal = failures >= limit;
    const kind = classified.code === MONITOR_ERROR.RATE_LIMITED ? 'rate_limited' : 'error';
    const delay = fatal
      ? MONITOR_ERROR_RETRY_MS
      : retryDelay({
        policy: monitorPolicy(row.platform),
        kind,
        failures,
        retryAfterMs: classified.retryAfterMs,
        random: this.random
      });
    updateMonitorTarget(this.db, row.id, {
      state: fatal ? MONITOR_STATE.ERROR : MONITOR_STATE.WAITING,
      next_check_at: now + delay,
      consecutive_failures: failures,
      last_error_code: classified.code,
      last_error_at: now,
      updated_at: now
    });
    this.logger?.warn({
      event: 'monitor.check.failed',
      targetId: row.id,
      platform: row.platform,
      phase,
      code: classified.code,
      failures,
      nextCheckInMs: delay,
      causeCode: error?.code ?? 'unknown'
    });
    this.#emit();
  }
}

function applyMetadataMeta(meta, observation) {
  if (!meta || !observation) return meta;
  if (observation.anchorName) meta.anchorName = String(observation.anchorName);
  if (observation.anchorUid !== null && observation.anchorUid !== undefined) {
    meta.anchorUid = String(observation.anchorUid);
  }
  if (observation.areaName) meta.areaName = String(observation.areaName);
  if (observation.parentAreaName) meta.parentAreaName = String(observation.parentAreaName);
  if (observation.metadataAttemptedAt) meta.lastMetadataAttemptAt = Number(observation.metadataAttemptedAt);
  return meta;
}

const TOP_LEVEL_META_KEYS = new Set([
  'manualStop',
  'anchorName',
  'anchorUid',
  'areaName',
  'parentAreaName',
  'lastMetadataAttemptAt'
]);

function mergeMeta(raw, patch) {
  let base = {};
  if (raw && typeof raw === 'object') base = {...raw};
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = {...parsed};
    } catch {
      base = {};
    }
  }
  const patchObject = patch && typeof patch === 'object' && !Array.isArray(patch) ? {...patch} : {};
  const nested = patchObject.lastCheck && typeof patchObject.lastCheck === 'object'
    ? {...patchObject.lastCheck}
    : null;
  delete patchObject.lastCheck;
  const top = {};
  for (const key of TOP_LEVEL_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patchObject, key)) {
      top[key] = patchObject[key];
      delete patchObject[key];
    }
  }
  const lastCheck = {...(base.lastCheck ?? {}), ...(nested ?? {}), ...patchObject};
  return {...base, ...top, lastCheck};
}

export const __internal = {mergeMeta};
