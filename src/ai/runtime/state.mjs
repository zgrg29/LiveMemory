import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Small persisted state for analysis runs, scoped to the data directory.
 *
 * It deliberately contains no prompts, chat text or model output: only the job
 * id, the current stage, counters and a stable error code. The database remains
 * the source of truth for imported results and coverage; this file only lets
 * the console explain what happened and resume the same job after a restart.
 */
export class AnalysisState {
  constructor({runtimeDir, now = Date.now, fileName = 'ai-v13.json'}) {
    this.file = join(runtimeDir, fileName);
    this.now = now;
    this.data = {version: 1, sessions: {}, providers: {}};
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || parsed.version !== 1 || typeof parsed.sessions !== 'object') return;
      this.data = {
        version: 1,
        sessions: parsed.sessions,
        providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {}
      };
    } catch {
      this.data = {version: 1, sessions: {}, providers: {}};
    }
  }

  save() {
    try {
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.file);
    } catch {
      // A failure to persist status must never fail the analysis itself.
    }
  }

  get(sessionId) {
    return this.data.sessions[String(sessionId)] ?? null;
  }

  all() {
    return {...this.data.sessions};
  }

  set(sessionId, patch) {
    const key = String(sessionId);
    const previous = this.data.sessions[key] ?? {};
    this.data.sessions[key] = {
      ...previous,
      ...patch,
      updatedAt: this.now()
    };
    this.save();
    return this.data.sessions[key];
  }

  remove(sessionId) {
    const key = String(sessionId);
    if (!(key in this.data.sessions)) return;
    delete this.data.sessions[key];
    this.save();
  }

  /**
   * Remember whether this provider/model configuration accepted streaming.
   * A model that rejects `stream` must not be probed again on every batch: the
   * next task uses the verified non-streaming mode directly.
   */
  getProviderMode(configId) {
    if (!configId) return null;
    const entry = this.data.providers?.[String(configId)];
    return entry?.responseMode === 'streaming' || entry?.responseMode === 'non_streaming'
      ? entry.responseMode
      : null;
  }

  setProviderMode(configId, responseMode, {reason = null} = {}) {
    if (!configId) return null;
    const key = String(configId);
    const mode = responseMode === 'streaming' ? 'streaming' : 'non_streaming';
    const normalizedReason = typeof reason === 'string' ? reason.slice(0, 120) : null;
    const existing = this.data.providers?.[key];
    if (existing?.responseMode === mode && existing?.reason === normalizedReason) {
      return existing;
    }
    this.data.providers = this.data.providers ?? {};
    this.data.providers[key] = {
      responseMode: mode,
      reason: normalizedReason,
      updatedAt: this.now()
    };
    this.save();
    return this.data.providers[key];
  }

  /**
   * After a restart no in-process runner exists. A persisted "running" entry is
   * therefore an interrupted task, not a live one. Imported batches are already
   * in the database and will be skipped when the user resumes.
   */
  recoverInterrupted() {
    let changed = false;
    for (const [sessionId, entry] of Object.entries(this.data.sessions)) {
      if (!entry || entry.status !== 'running') continue;
      this.data.sessions[sessionId] = {
        ...entry,
        status: 'interrupted',
        stage: 'interrupted',
        error: {code: 'ANALYSIS_INTERRUPTED', detail: null},
        updatedAt: this.now()
      };
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }
}
