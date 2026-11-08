import {createSession, endSession, findLiveSession, getSession, recoverInterruptedSessions} from '../../storage/repositories/sessions.mjs';
import {EventIngest} from './ingest.mjs';
import {MockLiveSource} from '../mock/mock-source.mjs';
import {CONNECTION_STATE} from './adapter.mjs';

/**
 * Owns the currently recording session and its adapter.
 *
 * Only one session may be live at a time. The manager keeps the database as the
 * source of truth: `status()` re-reads the live session instead of trusting an
 * in-memory copy, so a crash or an external edit can never leave the console
 * claiming a stream is being recorded when it is not.
 */
export class SessionManager {
  constructor({db, settings, logger = null, onEvent = () => {}, onStatusChange = () => {}, now = () => Date.now()} = {}) {
    this.db = db;
    this.settings = settings;
    this.logger = logger;
    this.onEvent = onEvent;
    this.onStatusChange = onStatusChange;
    this.now = now;
    this.ingest = new EventIngest({db, now, logger});
    this.adapter = null;
    this.connection = CONNECTION_STATE.IDLE;
    this.adapterDetail = null;
    this.ingest.onInserted((event) => this.onEvent(event));
  }

  /** Close sessions left open by a previous crash. Must run before serving. */
  recoverInterrupted() {
    const recovered = recoverInterruptedSessions(this.db, {now: this.now()});
    if (recovered.length > 0) {
      this.logger?.warn({event: 'session.recovered', count: recovered.length, sessions: recovered});
    }
    return recovered;
  }

  #setConnection(state, detail = null) {
    this.connection = state;
    this.adapterDetail = detail;
    this.onStatusChange(this.status());
  }

  async startSimulation({title = 'Simulated stream', intervalMs = 750, seed = null} = {}) {
    const live = findLiveSession(this.db);
    if (live) {
      return {started: false, reason: 'session_active', session: live};
    }
    const startedAt = this.now();
    const session = createSession(this.db, {
      platform: 'mock',
      platformRoomId: 'simulation',
      roomTitle: title,
      broadcasterName: null,
      storageMode: this.settings.get().storageMode,
      sourceQuality: 'mock',
      simulated: true,
      startedAt,
      now: startedAt
    });
    this.adapter = new MockLiveSource({
      sessionId: session.id,
      roomTitle: title,
      seed: seed ?? (Date.now() % 2147483647),
      now: this.now
    });
    await this.adapter.start({
      intervalMs,
      onEvent: (draft) => {
        try {
          this.ingest.record(draft);
        } catch (error) {
          this.logger?.error({event: 'ingest.failed', code: error?.code ?? 'unknown'});
        }
      },
      onStateChange: (change) => this.#setConnection(change.state, change.detail)
    });
    this.#setConnection(CONNECTION_STATE.CONNECTED, {simulated: true});
    this.logger?.info({event: 'session.started', sessionId: session.id, platform: 'mock'});
    return {started: true, session: getSession(this.db, session.id)};
  }

  async stopActive({status = 'ended'} = {}) {
    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }
    const live = findLiveSession(this.db);
    if (!live) {
      this.#setConnection(CONNECTION_STATE.IDLE);
      return {stopped: false, session: null};
    }
    const session = endSession(this.db, live.id, {status, endedAt: this.now()});
    this.#setConnection(CONNECTION_STATE.IDLE);
    this.logger?.info({event: 'session.ended', sessionId: live.id, status});
    return {stopped: true, session};
  }

  status() {
    const live = findLiveSession(this.db);
    return {
      connection: this.connection,
      adapter: this.adapter?.snapshot() ?? null,
      activeSession: live
        ? {
          id: live.id,
          platform: live.platform,
          roomTitle: live.room_title,
          startedAt: live.started_at,
          simulated: live.simulated === 1,
          messageCount: Number(live.message_count ?? 0),
          uniqueViewerCount: Number(live.unique_viewer_count ?? 0)
        }
        : null
    };
  }

  async shutdown() {
    await this.stopActive({status: 'interrupted'});
  }
}
