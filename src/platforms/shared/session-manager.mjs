import {
  createSession,
  endSession,
  findLiveSessionByRoom,
  getSession,
  listLiveSessions,
  recoverInterruptedSessions
} from '../../storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../storage/repositories/broadcasters.mjs';
import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {EventIngest} from './ingest.mjs';
import {MockLiveSource} from '../mock/mock-source.mjs';
import {CONNECTION_STATE} from './adapter.mjs';

/**
 * Owns every currently recording session and its adapter.
 *
 * Multiple independent broadcasts may record at the same time. Each recording
 * has its own adapter, connection state, session row and ingest closure; the
 * database remains the source of truth for counts and for whether a row is
 * still live. A second start for the same platform + room is refused both from
 * memory and from the database, so a room can never be recorded twice.
 *
 * The manager never depends on an HTTP request or an open browser page: an
 * adapter keeps running until it ends, fails, or is stopped explicitly.
 */

function connectionRank(state) {
  switch (state) {
    case CONNECTION_STATE.CONNECTED: return 6;
    case CONNECTION_STATE.CONNECTING: return 5;
    case CONNECTION_STATE.RECONNECTING: return 4;
    case CONNECTION_STATE.AUTH_REQUIRED: return 3;
    case CONNECTION_STATE.FAILED: return 2;
    case CONNECTION_STATE.STOPPED: return 1;
    default: return 0;
  }
}

/** Worst-to-best aggregate for the sidebar/console status line. */
function aggregateConnection(recordings) {
  if (recordings.length === 0) return CONNECTION_STATE.IDLE;
  return recordings
    .map((recording) => recording.connection?.state ?? recording.connection)
    .sort((a, b) => connectionRank(b) - connectionRank(a))[0] ?? CONNECTION_STATE.IDLE;
}

export class SessionManager {
  constructor({db, settings, logger = null, onEvent = () => {}, onStatusChange = () => {}, now = () => Date.now()} = {}) {
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.onEvent = onEvent;
    this.onStatusChange = onStatusChange;
    this.now = now;
    this.ingest = new EventIngest({db, now, logger});
    /** @type {Map<string, object>} sessionId -> active recording */
    this.recordings = new Map();
    this.ingest.onInserted((event) => this.onEvent(event));
  }

  /** Close sessions left open by a previous crash. Must run before serving. */
  recoverInterrupted() {
    const recovered = recoverInterruptedSessions(this.db, {now: this.now()});
    this.recordings.clear();
    if (recovered.length > 0) {
      this.logger?.warn({event: 'session.recovered', count: recovered.length, sessions: recovered});
    }
    return recovered;
  }

  /* -------------------------------------------------------------- read side */

  listRecordings() {
    return [...this.recordings.values()].sort((a, b) => (
      a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId)
    ));
  }

  getRecording(sessionId) {
    return this.recordings.get(String(sessionId)) ?? null;
  }

  #publicRecording(recording) {
    return {
      sessionId: recording.sessionId,
      platform: recording.platform,
      platformRoomId: recording.platformRoomId,
      roomTitle: recording.roomTitle,
      broadcasterName: recording.broadcasterName,
      broadcasterId: recording.broadcasterId,
      broadcasterIdentity: recording.broadcasterIdentity,
      simulated: recording.simulated,
      startedAt: recording.startedAt,
      platformStartedAt: recording.platformStartedAt,
      connection: {
        state: recording.connection,
        detail: recording.detail
      },
      meta: recording.meta ?? null
    };
  }

  #legacyActiveSession(recording) {
    const row = getSession(this.db, recording.sessionId);
    return {
      id: recording.sessionId,
      platform: recording.platform,
      broadcasterId: recording.broadcasterId,
      broadcasterIdentity: recording.broadcasterIdentity,
      roomTitle: recording.roomTitle ?? row?.room_title ?? null,
      startedAt: recording.startedAt,
      platformStartedAt: recording.platformStartedAt,
      simulated: recording.simulated,
      messageCount: Number(row?.message_count ?? 0),
      uniqueViewerCount: Number(row?.unique_viewer_count ?? 0)
    };
  }

  /**
   * Status shape used by the console, the sidebar and platform services.
   * `recordings` is the authoritative multi-recording list; `activeSession`
   * keeps the old single-stream summary for the launcher status line.
   */
  status() {
    const list = this.listRecordings();
    const recordings = list.map((recording) => this.#publicRecording(recording));
    const latest = list.at(-1) ?? null;
    return {
      connection: aggregateConnection(recordings),
      adapter: latest?.adapter?.snapshot?.() ?? null,
      recordings,
      activeCount: recordings.length,
      activeSession: latest ? this.#legacyActiveSession(latest) : null
    };
  }

  #emitStatus() {
    try {
      this.onStatusChange(this.status());
    } catch (error) {
      this.logger?.warn({event: 'session.status.failed', code: error?.code ?? 'unknown'});
    }
  }

  /* ---------------------------------------------------------- duplicate guard */

  /** @returns {null | {reason:string, sessionId:string, session:object|null}} */
  findDuplicate(platform, platformRoomId) {
    const room = String(platformRoomId ?? '');
    if (!room) return null;
    for (const recording of this.recordings.values()) {
      if (recording.platform === platform && String(recording.platformRoomId) === room) {
        return {
          reason: 'duplicate_room',
          sessionId: recording.sessionId,
          session: getSession(this.db, recording.sessionId)
        };
      }
    }
    const row = findLiveSessionByRoom(this.db, platform, room);
    if (row) {
      return {reason: 'duplicate_room', sessionId: row.id, session: row};
    }
    return null;
  }

  #ensureBroadcaster(resolved, seenAt) {
    if (!resolved?.id) return null;
    upsertBroadcaster(this.db, {
      id: resolved.id,
      platform: resolved.platform,
      platformUid: resolved.platformUid,
      displayName: resolved.displayName,
      identity: resolved.identity,
      seenAt,
      now: seenAt
    });
    return resolved.id;
  }

  #onAdapterState(sessionId, state, detail) {
    const recording = this.recordings.get(String(sessionId));
    if (!recording) return;
    recording.connection = state;
    recording.detail = detail ?? null;
    this.#emitStatus();
  }

  async #handleAdapterEnd(sessionId, info) {
    const recording = this.recordings.get(String(sessionId));
    if (!recording || recording.stopping) return;
    try {
      await this.stopSession(sessionId, {
        status: 'ended',
        reason: info?.reason ?? 'adapter_end',
        adapterAlreadyEnded: true
      });
    } catch (error) {
      this.logger?.warn({event: 'session.end.failed', code: error?.code ?? 'unknown'});
    }
  }

  /* ---------------------------------------------------------------- start */

  async #startRecording({
    platform,
    platformRoomId,
    roomTitle = null,
    broadcasterName = null,
    broadcasterUid = null,
    sourceQuality = null,
    simulated = false,
    platformStartedAt = null,
    createAdapter,
    startOptions = {},
    meta = null,
    onEnded = null
  }) {
    const roomId = String(platformRoomId ?? '');
    const duplicate = this.findDuplicate(platform, roomId);
    if (duplicate) {
      return {started: false, reason: 'duplicate_room', duplicate, session: duplicate.session};
    }
    const startedAt = this.now();
    // Resolve the stable broadcaster before the session row exists. YouTube uses
    // the channel id; Bilibili uses the anchor uid or a marked room fallback.
    const broadcaster = resolveBroadcasterIdentity({
      platform,
      platformRoomId: roomId,
      broadcasterUid,
      broadcasterName: broadcasterName ?? (platform === 'mock' ? roomTitle : null)
    });
    this.#ensureBroadcaster(broadcaster, startedAt);
    const session = createSession(this.db, {
      platform,
      platformRoomId: roomId,
      roomTitle,
      broadcasterName,
      broadcasterId: broadcaster.id,
      broadcasterIdentity: broadcaster.identity,
      storageMode: this.settings.get().storageMode,
      sourceQuality,
      simulated,
      startedAt,
      platformStartedAt,
      now: startedAt
    });
    const adapter = createAdapter({sessionId: session.id});
    const recording = {
      sessionId: session.id,
      platform,
      platformRoomId: roomId,
      roomTitle,
      broadcasterName,
      broadcasterId: broadcaster.id,
      broadcasterIdentity: broadcaster.identity,
      simulated,
      startedAt,
      platformStartedAt,
      adapter,
      connection: CONNECTION_STATE.CONNECTING,
      detail: null,
      meta,
      onEnded,
      stopping: false
    };
    this.recordings.set(session.id, recording);
    this.#onAdapterState(session.id, CONNECTION_STATE.CONNECTING, {platform, roomId});

    try {
      await adapter.start({
        ...startOptions,
        onEvent: (draft) => {
          try {
            // The session id is always the one this adapter was started for, so
            // two simultaneous broadcasts can never cross-write events.
            this.ingest.record({...draft, session_id: session.id});
          } catch (error) {
            this.logger?.error({event: 'ingest.failed', sessionId: session.id, code: error?.code ?? 'unknown'});
          }
        },
        onStateChange: (change) => this.#onAdapterState(session.id, change?.state, change?.detail),
        onEnd: (info) => {
          this.#handleAdapterEnd(session.id, info).catch(() => {});
        }
      });
    } catch (error) {
      this.recordings.delete(session.id);
      recording.stopping = true;
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
      endSession(this.db, session.id, {status: 'ended', endedAt: this.now(), reason: 'failed'});
      this.logger?.warn({
        event: 'session.start.failed',
        platform,
        sessionId: session.id,
        code: error?.code ?? 'unknown'
      });
      this.#emitStatus();
      throw error;
    }

    const current = this.recordings.get(session.id);
    if (current && [CONNECTION_STATE.CONNECTING, CONNECTION_STATE.IDLE].includes(current.connection)) {
      this.#onAdapterState(
        session.id,
        CONNECTION_STATE.CONNECTED,
        adapter.snapshot?.().detail ?? current.detail
      );
    }
    this.logger?.info({event: 'session.started', sessionId: session.id, platform, roomId});
    return {
      started: true,
      session: getSession(this.db, session.id),
      recording: this.#publicRecording(this.recordings.get(session.id) ?? recording)
    };
  }

  async startPlatform({
    platform,
    platformRoomId,
    roomTitle = null,
    broadcasterName = null,
    broadcasterUid = null,
    sourceQuality = null,
    simulated = false,
    platformStartedAt = null,
    createAdapter,
    meta = null,
    onEnded = null
  }) {
    return this.#startRecording({
      platform,
      platformRoomId,
      roomTitle,
      broadcasterName,
      broadcasterUid,
      sourceQuality,
      simulated,
      platformStartedAt,
      createAdapter,
      meta,
      onEnded
    });
  }

  async startSimulation({title = 'Simulated stream', intervalMs = 750, seed = null} = {}) {
    return this.#startRecording({
      platform: 'mock',
      platformRoomId: 'simulation',
      roomTitle: title,
      broadcasterName: null,
      sourceQuality: 'mock',
      simulated: true,
      createAdapter: ({sessionId}) => new MockLiveSource({
        sessionId,
        roomTitle: title,
        seed: seed ?? (Date.now() % 2147483647),
        now: this.now
      }),
      startOptions: {intervalMs},
      meta: {simulated: true}
    });
  }

  /* ----------------------------------------------------------------- stop */

  /**
   * Stop exactly one recording. Other adapters are untouched.
   * @param {string} sessionId
   * @param {{status?:string, reason?:string|null, adapterAlreadyEnded?:boolean}} options
   */
  async stopSession(sessionId, {status = 'ended', reason = null, adapterAlreadyEnded = false} = {}) {
    const id = String(sessionId);
    const recording = this.recordings.get(id);
    if (recording) {
      if (recording.stopping && !adapterAlreadyEnded) {
        return {stopped: false, reason: 'stopping', session: getSession(this.db, id)};
      }
      recording.stopping = true;
      if (!adapterAlreadyEnded) {
        try {
          await recording.adapter.stop();
        } catch (error) {
          this.logger?.warn({event: 'session.adapter.stop.failed', sessionId: id, code: error?.code ?? 'unknown'});
        }
      }
      this.recordings.delete(id);
    }
    const row = getSession(this.db, id);
    if (!row) {
      if (recording) this.#emitStatus();
      return {stopped: false, reason: 'not_found', session: null};
    }
    if (row.status !== 'live') {
      if (recording) this.#emitStatus();
      return {stopped: false, reason: 'not_live', session: row};
    }
    const session = endSession(this.db, id, {
      status,
      endedAt: this.now(),
      reason: reason ?? (status === 'interrupted' ? 'shutdown' : null)
    });
    if (recording) {
      try {
        recording.onEnded?.({
          sessionId: id,
          platform: recording.platform,
          reason: reason ?? (status === 'interrupted' ? 'shutdown' : 'stopped'),
          status,
          session
        });
      } catch (error) {
        this.logger?.warn({event: 'session.onended.failed', sessionId: id, code: error?.code ?? 'unknown'});
      }
    }
    this.#emitStatus();
    this.logger?.info({event: 'session.ended', sessionId: id, status, reason});
    return {stopped: true, session};
  }

  /**
   * Stop recordings of one platform. A explicit `sessionId` always wins; without
   * one, the call is only allowed when exactly one recording of that platform is
   * active, so a hidden second stream is never stopped by accident.
   */
  async stopPlatform(platform, {sessionId = null, status = 'ended', reason = null} = {}) {
    const list = this.listRecordings().filter((recording) => recording.platform === platform);
    if (sessionId) {
      const target = list.find((recording) => recording.sessionId === String(sessionId));
      if (!target) return {stopped: false, reason: 'not_active', session: getSession(this.db, sessionId)};
      return this.stopSession(target.sessionId, {status, reason});
    }
    if (list.length === 0) return {stopped: false, reason: 'not_active', session: null};
    if (list.length > 1) return {stopped: false, reason: 'session_id_required', count: list.length};
    return this.stopSession(list[0].sessionId, {status, reason});
  }

  /** Compatibility helper: stop the most recently started recording. */
  async stopActive({status = 'ended'} = {}) {
    const latest = this.listRecordings().at(-1) ?? null;
    if (!latest) return {stopped: false, session: null};
    return this.stopSession(latest.sessionId, {status});
  }

  async shutdown() {
    for (const recording of this.listRecordings()) {
      try {
        await this.stopSession(recording.sessionId, {status: 'interrupted', reason: 'shutdown'});
      } catch (error) {
        this.logger?.error({event: 'shutdown.session.failed', sessionId: recording.sessionId, code: error?.code ?? 'unknown'});
      }
    }
    // Defensive: an orphaned live row must never be shown as running after the
    // process shuts down, even if its adapter was already gone.
    for (const row of listLiveSessions(this.db)) {
      try {
        endSession(this.db, row.id, {status: 'interrupted', endedAt: this.now()});
      } catch (error) {
        this.logger?.error({event: 'shutdown.session.orphan.failed', sessionId: row.id, code: error?.code ?? 'unknown'});
      }
    }
  }
}
