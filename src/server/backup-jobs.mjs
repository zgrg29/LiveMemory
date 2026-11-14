import {randomUUID} from 'node:crypto';
import {AppError} from '../shared/errors.mjs';

/**
 * In-memory registry for long-running backup/restore operations.
 *
 * Jobs are never persisted: they describe a request made by the currently open
 * console. A restart intentionally forgets them (the restore journal, not this
 * registry, is the crash-safe record).
 *
 * Only one destructive/large job may run at a time. Progress is polled through
 * `/api/backup/jobs/:id`, which also stays readable while the server is in
 * maintenance mode during a restore.
 */

function publicError(error) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      messageKey: error.messageKey,
      details: error.details ?? null,
      rolledBack: error.details?.rolledBack ?? null
    };
  }
  return {
    code: 'BACKUP_FAILED',
    messageKey: 'errors.backupFailed',
    details: {code: String(error?.code ?? 'unknown')},
    rolledBack: null
  };
}

export class BackupJobRegistry {
  constructor({now = Date.now, ttlMs = 10 * 60 * 1000, maxJobs = 20, idFactory = randomUUID} = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxJobs = maxJobs;
    this.idFactory = idFactory;
    this.jobs = new Map();
    this.controllers = new Map();
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) {
        this.jobs.delete(id);
        this.controllers.delete(id);
      }
    }
    while (this.jobs.size > this.maxJobs) {
      const oldest = [...this.jobs.values()]
        .filter((job) => job.finishedAt !== null)
        .sort((left, right) => left.finishedAt - right.finishedAt)[0];
      if (!oldest) break;
      this.jobs.delete(oldest.id);
      this.controllers.delete(oldest.id);
    }
  }

  running(kind = null) {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && (kind === null || job.kind === kind)) return job;
    }
    return null;
  }

  start({kind, run}) {
    if (!['create', 'restore'].includes(kind)) throw new Error('backup job: invalid kind');
    if (typeof run !== 'function') throw new Error('backup job: run is required');
    this.#prune();
    if (this.running()) {
      throw new AppError('BACKUP_BUSY', {
        messageKey: 'errors.backupBusy',
        details: {kind},
        httpStatus: 409
      });
    }
    const id = `bkj_${this.idFactory().replace(/-/g, '').slice(0, 16)}`;
    const controller = new AbortController();
    const job = {
      id,
      kind,
      status: 'running',
      phase: 'queued',
      percent: 0,
      detail: null,
      startedAt: this.now(),
      finishedAt: null,
      cancelling: false,
      error: null,
      result: null
    };
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    Promise.resolve()
      .then(() => run({
        jobId: id,
        signal: controller.signal,
        progress: (update) => this.progress(id, update)
      }))
      .then((result) => this.complete(id, result))
      .catch((error) => this.fail(id, error));
    return this.serialize(job);
  }

  progress(id, update = {}) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    if (typeof update.phase === 'string') job.phase = update.phase;
    if (Number.isFinite(update.percent)) job.percent = Math.max(0, Math.min(100, Math.round(update.percent)));
    if (typeof update.detail === 'string') job.detail = update.detail.slice(0, 400);
    return this.serialize(job);
  }

  complete(id, result) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.status = 'completed';
    job.phase = 'done';
    job.percent = 100;
    job.result = result ?? null;
    job.finishedAt = this.now();
    this.controllers.delete(id);
    return this.serialize(job);
  }

  fail(id, error) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const cancelled = error?.code === 'BACKUP_CANCELLED' || error?.name === 'AbortError';
    job.status = cancelled ? 'cancelled' : 'failed';
    job.phase = cancelled ? 'cancelled' : 'failed';
    job.error = cancelled
      ? {code: 'BACKUP_CANCELLED', messageKey: 'errors.backupCancelled', details: null, rolledBack: false}
      : publicError(error);
    job.finishedAt = this.now();
    this.controllers.delete(id);
    return this.serialize(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.cancelling = true;
      const controller = this.controllers.get(id);
      controller?.abort();
    }
    return this.serialize(job);
  }

  get(id) {
    this.#prune();
    const job = this.jobs.get(id);
    return job ? this.serialize(job) : null;
  }

  serialize(job) {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      detail: job.detail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cancelling: job.cancelling,
      error: job.error,
      result: job.result
    };
  }

  fileFor(id) {
    const job = this.jobs.get(id);
    const file = job?.result?.file;
    if (typeof file !== 'string') return null;
    return file;
  }
}
