import {join} from 'node:path';
import {countSessionMessages} from '../../storage/repositories/events.mjs';
import {getSession} from '../../storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {
  getJob,
  listJobBatches
} from '../../storage/repositories/ai-jobs.mjs';
import {listPackages} from '../../storage/repositories/ai-packages.mjs';
import {latestResultForScope} from '../../storage/repositories/ai-results.mjs';
import {createAnalysisJob, buildAggregatePackage} from '../export/job.mjs';
import {computeJobStatus} from '../tasks/status.mjs';
import {validateAnalysisImport} from '../import/validate.mjs';
import {importAnalysisResult} from '../import/importer.mjs';
import {MAX_ANALYSIS_MESSAGES, MAX_ANALYSIS_VIEWERS, MAX_MESSAGES_PER_VIEWER_EXCERPT, promptVersionFor} from '../constants.mjs';
import {
  AUTO_BATCH_MESSAGES,
  AUTO_ERROR,
  AUTO_MAX_OUTPUT_TOKENS,
  AUTO_MAX_REPAIRS,
  AUTO_MAX_RETRY_AFTER_MS,
  AUTO_MEMORY_EXCERPTS_PER_BATCH,
  AUTO_MEMORY_VIEWERS_PER_BATCH,
  AUTO_PROVIDERS,
  MAX_AUTO_BATCHES
} from './config.mjs';
import {AutoAnalysisError, errorDetail, isAutoAnalysisError} from './errors.mjs';
import {AutoAnalysisState} from './state.mjs';
import {
  callProvider,
  extractJsonObject,
  SlidingWindowLimiter
} from './client.mjs';
import {
  buildAggregatePrompt,
  buildBatchPrompt,
  buildRepairMessages,
  buildTargetedViewerPrompt,
  readAggregatePackage,
  readBatchPackage
} from './prompt.mjs';
import {
  assembleCompactAnswer,
  inspectCompactAnswer,
  isCompactAnswer,
  mergeTargetedAnswer,
  COMPACT_ISSUE
} from './assemble.mjs';

function abortError() {
  return new AutoAnalysisError(AUTO_ERROR.CANCELED);
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Pick the most actionable failure code across provider attempts. Truncation and
 * incomplete viewer coverage are more specific than a generic schema failure and
 * must be visible in the status panel ("查看详情").
 */
function pickFailureCode(codes) {
  const priority = [
    AUTO_ERROR.RATE_LIMITED,
    AUTO_ERROR.TIMEOUT,
    AUTO_ERROR.CONTEXT_TOO_LARGE,
    AUTO_ERROR.OUTPUT_TRUNCATED,
    AUTO_ERROR.OUTPUT_DEGENERATED,
    AUTO_ERROR.VIEWER_COVERAGE_INCOMPLETE,
    AUTO_ERROR.SCHEMA_INVALID,
    AUTO_ERROR.INVALID_JSON
  ];
  for (const code of priority) {
    if (codes.includes(code)) return code;
  }
  return AUTO_ERROR.ALL_PROVIDERS_FAILED;
}

function summarizeJobStatus(jobStatus) {  if (!jobStatus) return null;
  return {
    state: jobStatus.status,
    complete: jobStatus.complete,
    batchTotal: jobStatus.batchTotal,
    batchesImported: jobStatus.batchesImported,
    missingBatches: jobStatus.missingBatches,
    aggregateRequired: jobStatus.aggregateRequired,
    aggregateImported: jobStatus.aggregateImported,
    memoryCoverage: jobStatus.memoryCoverage,
    memoryReady: jobStatus.memoryReady
  };
}

/**
 * Orchestrates the one-click path: create (or resume) the normal analysis job,
 * ask an anonymous provider for each batch, run the answer through the *existing*
 * importer, then build and import the stage-2 aggregate.
 *
 * It never writes analysis tables directly. Every model answer must pass the
 * same schema, identity, evidence and coverage validation as a pasted answer.
 */
export class AutoAnalysisRunner {
  constructor({
    db,
    paths,
    logger = null,
    now = Date.now,
    providers = AUTO_PROVIDERS,
    transport = null,
    fetchImpl = globalThis.fetch
  }) {
    this.db = db;
    this.paths = paths;
    this.logger = logger;
    this.now = now;
    this.providers = providers;
    this.transport = transport;
    this.fetchImpl = fetchImpl;
    this.stopping = false;
    this.active = new Map();
    this.limiters = new Map(providers.map((provider) => [
      provider.id,
      new SlidingWindowLimiter({
        limit: provider.rateLimit?.limit ?? 2,
        windowMs: provider.rateLimit?.windowMs ?? 60000,
        now
      })
    ]));
    const runtimeDir = paths.runtime ?? join(paths.root, 'runtime');
    this.state = new AutoAnalysisState({runtimeDir, now});
    this.state.recoverInterrupted();
  }

  services() {
    return this.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: provider.model
    }));
  }

  /**
   * Pre-check the same bounds createAnalysisJob will use. This avoids creating a
   * job (and files) that the free route cannot realistically finish.
   */
  precheck(sessionId) {
    const session = getSession(this.db, sessionId);
    if (!session) throw new AutoAnalysisError(AUTO_ERROR.SESSION_EMPTY);
    const totalMessages = countSessionMessages(this.db, sessionId);
    if (totalMessages <= 0) throw new AutoAnalysisError(AUTO_ERROR.SESSION_EMPTY);
    if (totalMessages > MAX_ANALYSIS_MESSAGES) {
      throw new AutoAnalysisError(AUTO_ERROR.TOO_MANY_BATCHES, {
        detail: `messages ${totalMessages} > ${MAX_ANALYSIS_MESSAGES}`
      });
    }
    const viewers = listSessionViewers(this.db, sessionId, {limit: MAX_ANALYSIS_VIEWERS + 1});
    if (viewers.length > MAX_ANALYSIS_VIEWERS) {
      throw new AutoAnalysisError(AUTO_ERROR.TOO_MANY_BATCHES, {
        detail: `viewers ${viewers.length} > ${MAX_ANALYSIS_VIEWERS}`
      });
    }
    const rows = this.db.prepare(`
      SELECT viewer_id, COUNT(*) AS count
        FROM events
       WHERE session_id = ? AND viewer_id IS NOT NULL
       GROUP BY viewer_id
    `).all(String(sessionId));
    const excerptTotal = rows.reduce((sum, row) => (
      sum + Math.min(Number(row.count ?? 0), MAX_MESSAGES_PER_VIEWER_EXCERPT)
    ), 0);
    const batchTotal = Math.max(
      1,
      Math.ceil(totalMessages / AUTO_BATCH_MESSAGES),
      Math.ceil(Math.max(1, viewers.length) / AUTO_MEMORY_VIEWERS_PER_BATCH),
      Math.ceil(Math.max(1, excerptTotal) / AUTO_MEMORY_EXCERPTS_PER_BATCH)
    );
    if (batchTotal > MAX_AUTO_BATCHES) {
      throw new AutoAnalysisError(AUTO_ERROR.TOO_MANY_BATCHES, {
        detail: `batches ${batchTotal} > ${MAX_AUTO_BATCHES}`
      });
    }
    return {session, totalMessages, viewerCount: viewers.length, batchTotal};
  }

  async start({sessionId, locale = 'en', consent = false} = {}) {
    if (consent !== true) throw new AutoAnalysisError(AUTO_ERROR.CONSENT_REQUIRED);
    if (this.active.has(sessionId)) throw new AutoAnalysisError(AUTO_ERROR.ALREADY_RUNNING);
    const existing = this.state.get(sessionId);
    const job = existing?.jobId ? getJob(this.db, existing.jobId) : null;
    const jobStatus = job ? computeJobStatus(this.db, job) : null;
    // The compact answer contract and the per-batch viewer cap changed. A job
    // created by the old prompt would resume with packages that still carry the
    // old instructions, so it must not be reused. Starting a new job keeps the
    // old (result-less) rows for audit instead of silently analysing with a
    // prompt that no longer matches this runner.
    const expectedPrompt = promptVersionFor(job?.locale ?? locale);
    const resumable = Boolean(job) && job.promptVersion === expectedPrompt;
    if (job && !jobStatus.complete && !resumable) {
      this.state.remove(sessionId);
    }
    if (job && !jobStatus.complete && resumable) {
      // Resume the same job, batch ids and viewer assignments. Imported batches
      // are skipped; no duplicate requests and no duplicate rows.
      this.state.set(sessionId, {
        jobId: job.id,
        locale: job.locale,
        status: 'running',
        stage: 'preparing',
        batchIndex: Number(existing?.batchIndex ?? 0),
        batchTotal: job.batchTotal,
        startedAt: existing?.startedAt ?? this.now(),
        error: null
      });
      return this.launch({sessionId, job});
    }
    const plan = this.precheck(sessionId);
    return this.createAndStart({sessionId, locale, plan});
  }

  async createAndStart({sessionId, locale, plan}) {
    const created = await createAnalysisJob({
      db: this.db,
      sessionId,
      locale,
      exportsDir: this.paths.exports,
      batchSize: AUTO_BATCH_MESSAGES,
      memoryViewersPerBatch: AUTO_MEMORY_VIEWERS_PER_BATCH,
      maxMemoryExcerptMessages: AUTO_MEMORY_EXCERPTS_PER_BATCH,
      now: this.now()
    });
    if (!created) throw new AutoAnalysisError(AUTO_ERROR.SESSION_EMPTY);
    if (created.job.batchTotal > MAX_AUTO_BATCHES) {
      throw new AutoAnalysisError(AUTO_ERROR.TOO_MANY_BATCHES, {
        detail: `batches ${created.job.batchTotal} > ${MAX_AUTO_BATCHES}`
      });
    }
    this.state.set(sessionId, {
      jobId: created.job.id,
      locale,
      status: 'running',
      stage: 'preparing',
      batchIndex: 0,
      batchTotal: created.job.batchTotal,
      startedAt: this.now(),
      error: null
    });
    this.logger?.info?.({
      event: 'ai.auto.started',
      jobId: created.job.id,
      sessionId,
      batches: created.job.batchTotal,
      messages: plan.totalMessages,
      viewers: plan.viewerCount
    });
    return this.launch({sessionId, job: getJob(this.db, created.job.id)});
  }

  launch({sessionId, job}) {
    const controller = new AbortController();
    const context = {
      controller,
      sessionId,
      jobId: job.id,
      batchTotal: job.batchTotal,
      requests: 0,
      maxRequests: Math.max(8, (job.batchTotal + 1) * 4)
    };
    const promise = this.run(context)
      .catch((error) => {
        // `run` already converts expected failures. This is a last-resort guard
        // so a detached task can never reject into the process.
        this.fail(context, error);
      })
      .finally(() => {
        this.active.delete(sessionId);
      });
    this.active.set(sessionId, {controller, promise});
    return this.getStatus(sessionId);
  }

  getStatus(sessionId) {
    const entry = this.state.get(sessionId);
    const active = this.active.get(sessionId) ?? null;
    let job = entry?.jobId ? getJob(this.db, entry.jobId) : null;
    let jobStatus = job ? computeJobStatus(this.db, job) : null;
    if (!entry) {
      return {
        sessionId,
        status: 'idle',
        stage: 'idle',
        running: false,
        canCancel: false,
        canResume: false,
        job: null,
        services: this.services()
      };
    }
    if (!job) {
      this.state.remove(sessionId);
      return {
        sessionId,
        status: 'idle',
        stage: 'idle',
        running: false,
        canCancel: false,
        canResume: false,
        job: null,
        services: this.services()
      };
    }
    let status = entry.status;
    let stage = entry.stage;
    let error = entry.error ?? null;
    if (jobStatus?.complete) {
      status = 'complete';
      stage = 'complete';
      error = null;
    } else if (status === 'running' && !active) {
      status = 'interrupted';
      stage = 'interrupted';
      error = {code: AUTO_ERROR.INTERRUPTED, detail: null};
    }
    return {
      sessionId,
      status,
      stage,
      running: status === 'running',
      canCancel: status === 'running' && Boolean(active),
      canResume: status !== 'complete' && Boolean(job),
      jobId: job.id,
      batchIndex: Number(entry.batchIndex ?? 0),
      batchTotal: job.batchTotal,
      startedAt: entry.startedAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      lastProvider: entry.lastProvider ?? null,
      estimatedTokens: entry.estimatedTokens ?? null,
      error,
      job: summarizeJobStatus(jobStatus),
      services: this.services()
    };
  }

  cancel(sessionId) {
    const active = this.active.get(sessionId);
    if (!active) {
      const entry = this.state.get(sessionId);
      if (!entry) return this.getStatus(sessionId);
      this.state.set(sessionId, {
        status: 'canceled',
        stage: 'canceled',
        error: null
      });
      return this.getStatus(sessionId);
    }
    active.controller.abort();
    return this.getStatus(sessionId);
  }

  async shutdown() {
    this.stopping = true;
    const active = [...this.active.values()];
    for (const item of active) item.controller.abort();
    if (active.length > 0) {
      await Promise.race([
        Promise.allSettled(active.map((item) => item.promise)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          timer.unref?.();
        })
      ]);
    }
    for (const [sessionId, entry] of Object.entries(this.state.all())) {
      if (entry?.status === 'running') {
        this.state.set(sessionId, {
          status: 'interrupted',
          stage: 'interrupted',
          error: {code: AUTO_ERROR.INTERRUPTED, detail: null}
        });
      }
    }
  }

  async run(context) {
    const {sessionId, jobId, controller} = context;
    const signal = controller.signal;
    try {
      assertNotAborted(signal);
      const job = getJob(this.db, jobId);
      if (!job) throw new AutoAnalysisError(AUTO_ERROR.INTERNAL, {detail: 'job-missing'});
      const batches = listJobBatches(this.db, jobId);
      for (const batch of batches) {
        assertNotAborted(signal);
        const existing = latestResultForScope(this.db, jobId, `batch:${batch.batchIndex}`);
        if (existing) continue;
        this.state.set(sessionId, {
          status: 'running',
          stage: 'preparing',
          batchIndex: batch.batchIndex,
          batchTotal: job.batchTotal,
          error: null
        });
        const packages = listPackages(this.db, {jobId});
        const pkg = packages.find((entry) => (
          entry.stage === 'batch' && Number(entry.batch_index) === batch.batchIndex
        ));
        if (!pkg) throw new AutoAnalysisError(AUTO_ERROR.INTERNAL, {detail: 'batch-package-missing'});
        const files = readBatchPackage(this.paths.exports, pkg.file_name);
        const prompt = buildBatchPrompt(files);
        this.state.set(sessionId, {
          status: 'running',
          stage: 'analyzing',
          batchIndex: batch.batchIndex,
          batchTotal: job.batchTotal,
          estimatedTokens: prompt.estimatedTokens,
          error: null
        });
        const generated = await this.generateValidated({
          context,
          prompt,
          kind: 'batch',
          signal
        });
        assertNotAborted(signal);
        this.state.set(sessionId, {
          status: 'running',
          stage: 'importing',
          batchIndex: batch.batchIndex,
          batchTotal: job.batchTotal,
          lastProvider: generated.providerId,
          error: null
        });
        const outcome = this.importValidated(generated.text);
        this.state.set(sessionId, {
          status: 'running',
          stage: 'analyzing',
          batchIndex: batch.batchIndex,
          batchTotal: job.batchTotal,
          lastProvider: generated.providerId,
          error: null
        });
        this.logger?.info?.({
          event: 'ai.auto.batch',
          jobId,
          batchIndex: batch.batchIndex,
          provider: generated.providerId,
          duplicate: outcome.duplicate
        });
      }

      assertNotAborted(signal);
      const current = getJob(this.db, jobId);
      const currentStatus = computeJobStatus(this.db, current);
      if (currentStatus.complete) {
        this.complete(sessionId, jobId);
        return;
      }
      if (current.batchTotal > 1) {
        this.state.set(sessionId, {
          status: 'running',
          stage: 'aggregating',
          batchIndex: current.batchTotal,
          batchTotal: current.batchTotal,
          error: null
        });
        const aggregate = await this.ensureAggregate(current);
        const files = readAggregatePackage(this.paths.exports, aggregate.file_name);
        const prompt = buildAggregatePrompt(files);
        const generated = await this.generateValidated({
          context,
          prompt,
          kind: 'aggregate',
          signal
        });
        assertNotAborted(signal);
        this.importValidated(generated.text);
      }

      const finalJob = getJob(this.db, jobId);
      const finalStatus = computeJobStatus(this.db, finalJob);
      if (!finalStatus.complete) {
        throw new AutoAnalysisError(AUTO_ERROR.AGGREGATE_FAILED, {
          detail: `job-state:${finalStatus.status}`
        });
      }
      this.complete(sessionId, jobId);
    } catch (error) {
      if (this.stopping || isAutoAnalysisError(error) && error.code === AUTO_ERROR.INTERRUPTED) {
        this.state.set(sessionId, {
          status: 'interrupted',
          stage: 'interrupted',
          error: {code: AUTO_ERROR.INTERRUPTED, detail: null}
        });
        return;
      }
      if (isAutoAnalysisError(error) && error.code === AUTO_ERROR.CANCELED) {
        this.state.set(sessionId, {
          status: 'canceled',
          stage: 'canceled',
          error: null
        });
        this.logger?.info?.({event: 'ai.auto.canceled', jobId});
        return;
      }
      this.fail(context, error);
    }
  }

  complete(sessionId, jobId) {
    const job = getJob(this.db, jobId);
    this.state.set(sessionId, {
      status: 'complete',
      stage: 'complete',
      batchIndex: job?.batchTotal ?? 0,
      batchTotal: job?.batchTotal ?? 0,
      error: null
    });
    this.logger?.info?.({event: 'ai.auto.complete', jobId});
  }

  fail(context, error) {
    const normalized = isAutoAnalysisError(error)
      ? error
      : new AutoAnalysisError(AUTO_ERROR.INTERNAL, {
        detail: String(error?.message ?? error?.name ?? 'unknown').slice(0, 200),
        cause: error
      });
    const detail = errorDetail(normalized);
    this.state.set(context.sessionId, {
      status: 'failed',
      stage: 'failed',
      error: {code: normalized.code, detail}
    });
    this.logger?.warn?.({
      event: 'ai.auto.failed',
      jobId: context.jobId,
      code: normalized.code,
      provider: normalized.providerId ?? null,
      httpStatus: normalized.httpStatus ?? null
    });
  }

  async ensureAggregate(job) {
    let packageRow = job.aggregatePackageId
      ? listPackages(this.db, {jobId: job.id}).find((entry) => entry.stage === 'aggregate')
      : null;
    if (packageRow) return packageRow;
    try {
      const built = await buildAggregatePackage({
        db: this.db,
        jobId: job.id,
        exportsDir: this.paths.exports,
        now: this.now()
      });
      if (!built) throw new AutoAnalysisError(AUTO_ERROR.AGGREGATE_FAILED, {detail: 'aggregate-empty'});
      packageRow = listPackages(this.db, {jobId: job.id}).find((entry) => entry.id === built.id);
      if (!packageRow) {
        throw new AutoAnalysisError(AUTO_ERROR.AGGREGATE_FAILED, {detail: 'aggregate-package-missing'});
      }
      return packageRow;
    } catch (error) {
      if (isAutoAnalysisError(error)) throw error;
      throw new AutoAnalysisError(AUTO_ERROR.AGGREGATE_FAILED, {
        detail: String(error?.code ?? error?.message ?? 'aggregate-failed').slice(0, 160),
        cause: error
      });
    }
  }

  /**
   * Ask providers in order until one answer passes the real importer preview.
   * A repair attempt is made only for a parseable but invalid answer. Network
   * failures are retried once per provider; 429 waits at most the bounded
   * Retry-After. No answer is written until preview.ok is true.
   */
  importValidated(text) {
    try {
      return importAnalysisResult({
        db: this.db,
        text,
        source: 'auto',
        now: this.now()
      });
    } catch (error) {
      if (isAutoAnalysisError(error)) throw error;
      throw new AutoAnalysisError(AUTO_ERROR.IMPORT_FAILED, {
        detail: String(error?.code ?? error?.message ?? 'import-failed').slice(0, 160),
        cause: error
      });
    }
  }

  async generateValidated({context, prompt, kind, signal}) {
    const failures = [];
    for (const provider of this.providers) {
      assertNotAborted(signal);
      let previousText = null;
      let previousErrors = null;
      let targetedUsed = false;
      for (let attempt = 0; attempt <= AUTO_MAX_REPAIRS; attempt += 1) {
        assertNotAborted(signal);
        if (context.requests >= context.maxRequests) {
          throw new AutoAnalysisError(AUTO_ERROR.ALL_PROVIDERS_FAILED, {
            detail: 'request-budget-exceeded'
          });
        }
        const messages = attempt === 0
          ? prompt.messages
          : buildRepairMessages({
            prompt,
            previousText: previousText ?? '',
            errors: previousErrors ?? [],
            locale: prompt.manifest?.locale ?? 'en'
          }).messages;
        let result;
        try {
          context.requests += 1;
          result = await this.callOne({
            provider,
            messages,
            prompt,
            kind,
            signal
          });
        } catch (error) {
          if (isAutoAnalysisError(error) && error.code === AUTO_ERROR.CANCELED) throw error;
          failures.push({
            providerId: provider.id,
            code: error?.code ?? AUTO_ERROR.PROVIDER_UNAVAILABLE,
            detail: errorDetail(error)
          });
          if (isAutoAnalysisError(error) && error.retryable) {
            if (error.code === AUTO_ERROR.RATE_LIMITED && error.retryAfterMs !== null) {
              // Bounded wait; the limiter already keeps the next slot.
              this.state.set(context.sessionId, {
                stage: 'connecting',
                error: null
              });
            }
            if (attempt === 0 && error.retryable) {
              // One network-level retry, then move to the next provider.
              await this.waitBeforeRetry(provider, error, signal);
              previousText = null;
              previousErrors = null;
              continue;
            }
          }
          break;
        }

        this.state.set(context.sessionId, {stage: 'validating', error: null});
        let evaluation = this.evaluateAnswer(result, prompt, kind);
        if (evaluation.ok) {
          return {...result, text: evaluation.text, preview: evaluation.preview};
        }
        // A compact answer can be missing viewers without any other defect.
        // Ask only for those refs, once per batch, before spending the repair
        // attempt. Every ref still has to come back from the model.
        if (prompt.format === 'compact'
          && evaluation.compact
          && evaluation.code === AUTO_ERROR.VIEWER_COVERAGE_INCOMPLETE
          && Array.isArray(evaluation.missing)
          && evaluation.missing.length > 0
          && !targetedUsed) {
          targetedUsed = true;
          context.requests += 1;
          const supplemented = await this.completeMissing({
            context,
            provider,
            prompt,
            kind,
            answer: evaluation.answer,
            missing: evaluation.missing,
            signal
          });
          if (supplemented.ok) {
            return {...result, text: supplemented.text, preview: supplemented.preview};
          }
          evaluation = supplemented.evaluation ?? evaluation;
          failures.push({
            providerId: provider.id,
            code: evaluation.code,
            detail: 'targeted-supplement-incomplete'
          });
        }

        previousText = result.content;
        previousErrors = evaluation.errors ?? [];
        failures.push({
          providerId: provider.id,
          code: evaluation.code,
          detail: evaluation.errors?.[0]?.code ?? null
        });
        if (attempt < AUTO_MAX_REPAIRS) {
          continue;
        }
        break;
      }
    }
    const codes = [...new Set(failures.map((failure) => failure.code))];
    const code = pickFailureCode(codes);
    throw new AutoAnalysisError(code, {
      detail: failures.map((failure) => `${failure.providerId}:${failure.code}`).slice(0, 4).join(', ')
    });
  }

  /**
   * Ask only for the refs a compact answer did not cover. The supplement may
   * not contain a ref that was not missing; `mergeTargetedAnswer` rejects it.
   */
  async completeMissing({context, provider, prompt, kind, answer, missing, signal}) {
    assertNotAborted(signal);
    let targeted;
    try {
      targeted = buildTargetedViewerPrompt({
        files: prompt.files,
        refs: missing,
        errors: []
      });
    } catch (error) {
      if (isAutoAnalysisError(error)) throw error;
      throw new AutoAnalysisError(AUTO_ERROR.INTERNAL, {detail: 'targeted-prompt-failed', cause: error});
    }
    this.logger?.info?.({
      event: 'ai.auto.targeted',
      jobId: context.jobId,
      batchIndex: prompt.manifest?.batch?.index ?? null,
      refs: missing.length
    });    let result;
    try {
      result = await this.callOne({
        provider,
        messages: targeted.messages,
        prompt: targeted,
        kind,
        purpose: 'targeted',
        signal
      });
    } catch (error) {
      if (isAutoAnalysisError(error) && error.code === AUTO_ERROR.CANCELED) throw error;
      return {
        ok: false,
        evaluation: {
          ok: false,
          code: error?.code ?? AUTO_ERROR.VIEWER_COVERAGE_INCOMPLETE,
          errors: [],
          compact: true,
          missing
        }
      };
    }
    const object = extractJsonObject(result.content);
    const merged = mergeTargetedAnswer({
      answer,
      supplement: object,
      missingRefs: missing
    });
    if (!merged.ok) {
      return {
        ok: false,
        evaluation: {
          ok: false,
          code: AUTO_ERROR.SCHEMA_INVALID,
          errors: merged.issues,
          compact: true,
          missing,
          answer
        }
      };
    }
    const evaluation = this.evaluateAnswer(
      {...result, content: JSON.stringify(merged.answer)},
      prompt,
      kind
    );
    return evaluation.ok
      ? {ok: true, text: evaluation.text, preview: evaluation.preview}
      : {ok: false, evaluation: {...evaluation, answer: merged.answer}};
  }

  /**
   * Turn one provider answer into a fully validated result object.
   *
   * Batch answers use the compact format: the model returns refs, never ids.
   * `assembleCompactAnswer` maps refs to the exact stable ids of this batch and
   * the assembled object goes through the same `validateAnalysisImport()` as a
   * pasted answer. Full-format answers are still accepted for compatibility, but
   * they never get their ids "repaired" or guessed.
   */
  evaluateAnswer(result, prompt, kind) {
    const object = extractJsonObject(result.content);
    if (!object) {
      const code = result.finishReason === 'length'
        ? AUTO_ERROR.OUTPUT_TRUNCATED
        : result.degenerate
          ? AUTO_ERROR.OUTPUT_DEGENERATED
          : AUTO_ERROR.INVALID_JSON;
      return {
        ok: false,
        code,
        errors: [{path: '', code}],
        compact: false,
        missing: []
      };
    }
    if (kind === 'batch' && prompt.format === 'compact' && isCompactAnswer(object)) {
      const inspected = inspectCompactAnswer(object, {viewerCount: prompt.viewerRefs.length});
      if (inspected.issues.length > 0) {
        return {
          ok: false,
          code: AUTO_ERROR.SCHEMA_INVALID,
          errors: inspected.issues,
          compact: true,
          missing: inspected.missing,
          answer: object
        };
      }
      if (inspected.missing.length > 0) {
        return {
          ok: false,
          code: AUTO_ERROR.VIEWER_COVERAGE_INCOMPLETE,
          errors: [],
          compact: true,
          missing: inspected.missing,
          answer: object
        };
      }
      const assembled = assembleCompactAnswer({
        answer: object,
        manifest: prompt.manifest,
        viewerRefs: prompt.viewerRefs
      });
      if (!assembled.ok) {
        return {
          ok: false,
          code: AUTO_ERROR.SCHEMA_INVALID,
          errors: assembled.issues,
          compact: true,
          missing: assembled.missing,
          answer: object
        };
      }
      return this.validateAssembled({
        text: JSON.stringify(assembled.result),
        prompt,
        kind,
        compact: true,
        answer: object
      });
    }
    return this.validateAssembled({
      text: result.content,
      prompt,
      kind,
      compact: false,
      answer: object
    });
  }

  validateAssembled({text, prompt, kind, compact, answer}) {
    let preview;
    try {
      preview = validateAnalysisImport({
        db: this.db,
        text,
        source: 'auto',
        now: this.now()
      });
    } catch (error) {
      return {
        ok: false,
        code: AUTO_ERROR.SCHEMA_INVALID,
        errors: [{path: '', code: 'VALIDATION_FAILED'}],
        compact,
        missing: [],
        answer
      };
    }
    if (!preview.ok) {
      const missing = compact
        ? this.missingRefsFromErrors(preview.errors, prompt)
        : [];
      return {
        ok: false,
        code: AUTO_ERROR.SCHEMA_INVALID,
        errors: preview.errors ?? [],
        compact,
        missing,
        answer,
        preview
      };
    }
    if (kind === 'aggregate' && preview.target?.mode !== 'aggregate') {
      return {
        ok: false,
        code: AUTO_ERROR.SCHEMA_INVALID,
        errors: [{path: 'batch_id', code: 'AGGREGATE_EXPECTED'}],
        compact,
        missing: [],
        answer
      };
    }
    return {
      ok: true,
      text: JSON.stringify(preview.sanitized ?? JSON.parse(text)),
      preview,
      compact,
      missing: []
    };
  }

  /** Map validator coverage errors back to local refs (no id matching heuristics). */
  missingRefsFromErrors(errors, prompt) {
    if (!prompt?.viewerRefs) return [];
    const byId = new Map(prompt.viewerRefs.map((entry) => [entry.viewerId, entry.ref]));
    const missing = new Set();
    for (const error of errors ?? []) {
      if (error?.code !== 'MEMORY_VIEWER_UPDATE_MISSING') continue;
      const ref = byId.get(error.params?.viewerId);
      if (ref) missing.add(ref);
    }
    return [...missing].sort((a, b) => a - b);
  }

  async callOne({provider, messages, prompt, kind, purpose = null, signal}) {
    if (this.transport) {
      const result = await this.transport({
        provider,
        messages,
        kind,
        purpose,
        signal,
        manifest: prompt.manifest,
        viewerIds: prompt.viewerIds,
        prompt
      });
      if (!result || typeof result.content !== 'string') {
        throw new AutoAnalysisError(AUTO_ERROR.INVALID_JSON, {
          detail: 'transport-empty',
          providerId: provider.id
        });
      }
      return {
        content: result.content,
        providerId: result.providerId ?? provider.id,
        model: result.model ?? provider.model,
        usage: result.usage ?? null,
        finishReason: result.finishReason ?? null,
        reasoningTokens: result.reasoningTokens ?? null,
        degenerate: result.degenerate === true
      };
    }
    return callProvider({
      provider,
      messages,
      maxTokens: this.maxOutputTokens(kind, prompt),
      responseSchema: prompt.answerSchema ?? null,
      signal,
      fetchImpl: this.fetchImpl,
      limiter: this.limiters.get(provider.id) ?? null,
      now: this.now
    });
  }

  maxOutputTokens(kind, prompt) {
    if (kind === 'aggregate') return AUTO_MAX_OUTPUT_TOKENS;
    const viewers = prompt.viewerRefs?.length ?? prompt.viewerIds?.length ?? 0;
    // gpt-oss spends part of the output budget on reasoning. 3k truncated a
    // real answer; 9.25k in json_object mode degenerated into repeated keys.
    // The compact format omits ids and duplicate fields, so a smaller floor is
    // enough, but keep headroom for reasoning.
    return Math.min(
      AUTO_MAX_OUTPUT_TOKENS,
      Math.max(6000, 2000 + viewers * 200)
    );
  }

  async waitBeforeRetry(provider, error, signal) {
    if (error.code === AUTO_ERROR.RATE_LIMITED && error.retryAfterMs && error.retryAfterMs > 0) {
      const wait = Math.min(error.retryAfterMs, AUTO_MAX_RETRY_AFTER_MS);
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, wait);
        timer.unref?.();
        function onAbort() {
          cleanup();
          reject(abortError());
        }
        function cleanup() {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        }
        signal?.addEventListener?.('abort', onAbort, {once: true});
      });
    }
  }
}
