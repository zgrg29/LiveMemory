import {join} from 'node:path';
import {getJob, listJobBatches, setJobUsage} from '../../storage/repositories/ai-jobs.mjs';
import {getJobPackage} from '../../storage/repositories/ai-packages.mjs';
import {latestResultForScope} from '../../storage/repositories/ai-results.mjs';
import {getSession} from '../../storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {computeJobStatus} from '../tasks/status.mjs';
import {validateAnalysisImport} from '../import/validate.mjs';
import {importAnalysisResult} from '../import/importer.mjs';
import {createSessionAnalysisJob, createViewerMemoryJob} from '../export/split-jobs.mjs';
import {ANALYSIS_MODE, MAX_ANALYSIS_VIEWERS} from '../constants.mjs';
import {callProvider, ProviderHttpError} from '../providers/adapters.mjs';
import {assertSafeResolvedUrl} from '../providers/url-safety.mjs';
import {memoryPermission, addUsage, estimateCost, budgetRemaining} from '../providers/pricing.mjs';
import {PRICING_STATUS} from '../providers/catalog.mjs';
import {AnalysisState} from '../runtime/state.mjs';
import {
  extractJsonObject,
  sleepWithSignal,
  cancellationError
} from '../runtime/json.mjs';
import {ProviderRequestScheduler, retryDelayMs} from '../runtime/scheduler.mjs';
import {
  SESSION_FILES,
  MEMORY_FILES,
  buildSessionPrompt,
  buildMemoryPrompt,
  buildTargetedMemoryPrompt,
  buildRepairMessages,
  readAnalysisPackage
} from './prompts.mjs';
import {
  assembleMemoryCompact,
  mergeMemorySupplement,
  assembleSessionAnswer
} from './compact.mjs';

/**
 * Configured-provider analysis runner.
 *
 * The only supported AI path is a user-supplied API key and a user-configured
 * provider/model. There is no anonymous free route and no manual prompt/JSON
 * round trip in the product UI. Session and memory are separate jobs:
 *
 *   - the session report is imported as soon as it succeeds;
 *   - viewer memory batches are independent and may run with bounded
 *     concurrency inside one job;
 *   - a memory failure never invalidates a saved session report, and already
 *     imported memory batches remain valid and are skipped on resume.
 *
 * Every answer still goes through the existing schema/business validator and
 * the single transactional importer. The runner never writes analysis tables
 * directly.
 */

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_CONCURRENCY = 8;
/**
 * Paid providers are not limited by the old anonymous 30-batch ceiling. The
 * real safety bound is MAX_ANALYSIS_VIEWERS; at the smallest tested viewer batch
 * (10) this allows every allowed viewer to be assigned. The count is explicit,
 * never silently truncated.
 */
const MAX_MEMORY_BATCHES = Math.ceil(MAX_ANALYSIS_VIEWERS / 10) + 1;

export class AnalysisPermissionError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AnalysisPermissionError';
    this.code = code;
    this.details = details;
  }
}

function abortError() {
  return cancellationError();
}

function providerFromConfig(config) {
  return {
    id: config.id,
    label: config.name || config.providerId,
    providerId: config.providerId,
    protocol: config.protocol,
    regionId: config.regionId,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    supportsStructuredOutputs: config.capabilities?.structuredOutputs === true && config.supportsStructuredOutputs !== false,
    timeoutMs: Math.max(10000, Math.min(600000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    pricingStatus: config.pricingStatus,
    pricing: config.pricing,
    allowLocalNetwork: config.allowLocalNetwork === true,
    contextLength: config.contextLength ?? null,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(config.concurrency) || 3)),
    configId: config.id
  };
}

/**
 * Viewer batch size is a model property, not a global constant. Larger declared
 * context windows get a slightly larger batch; the default stays conservative
 * because output completeness, not context length, is the usual failure mode.
 */
function memoryViewersPerBatch(provider) {
  const context = Number(provider.contextLength ?? 0);
  if (context >= 200000) return 20;
  if (context >= 100000) return 15;
  return 10;
}

function schedulerKey(provider) {
  if (provider.configId) return `config:${provider.configId}`;
  return `${provider.providerId}:${provider.regionId ?? 'default'}:${provider.modelId}`;
}

function isRetryable(error) {
  return error instanceof ProviderHttpError && error.retryable === true;
}

/**
 * Run a worker pool over independent batches. The first failure aborts the
 * remaining in-flight requests through `poolController` and is re-thrown after
 * every worker settles, so a partially failed job is reported precisely instead
 * of hanging on sibling requests.
 */
async function runPool(items, limit, worker, signal) {
  const poolController = new AbortController();
  const poolSignal = signal
    ? AbortSignal.any([signal, poolController.signal])
    : poolController.signal;
  let nextIndex = 0;
  let firstError = null;
  const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const workers = Array.from({length: maxWorkers}, async () => {
    for (;;) {
      if (poolSignal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index, poolSignal);
      } catch (error) {
        if (!firstError) {
          firstError = signal?.aborted ? abortError() : error;
          poolController.abort();
        }
        return;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError) throw firstError;
}

export class AnalysisRunner {
  constructor({
    db,
    paths,
    configStore,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    maxRetries = 2,
    random = Math.random
  }) {
    this.db = db;
    this.paths = paths;
    this.configStore = configStore;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.maxRetries = Math.max(0, Math.min(5, Number(maxRetries) || 0));
    this.random = random;
    this.active = new Map();
    this.schedulers = new Map();
    this.memoryGates = new Map();
    // Base URL safety is checked once per origin per short TTL. Re-resolving DNS
    // for every batch would add seconds of local latency to large jobs while
    // providing no additional protection within one run.
    this.urlChecks = new Map();
    this.urlCheckTtlMs = 5 * 60 * 1000;
    const runtimeDir = paths.runtime ?? join(paths.root, 'runtime');
    this.state = new AnalysisState({runtimeDir, now, fileName: 'ai-v13.json'});
    this.state.recoverInterrupted();
  }

  services() {
    return {configured: this.configStore.list()};
  }

  #schedulerFor(provider) {
    const key = schedulerKey(provider);
    let scheduler = this.schedulers.get(key);
    if (!scheduler) {
      scheduler = new ProviderRequestScheduler({
        key,
        initialConcurrency: provider.concurrency ?? 3,
        maxConcurrency: provider.concurrency ?? 3,
        minConcurrency: 1,
        now: this.now,
        random: this.random
      });
      this.schedulers.set(key, scheduler);
    }
    return scheduler;
  }

  async #ensureSafeProviderUrl(provider) {
    const key = `${provider.baseUrl}|${provider.allowLocalNetwork === true ? 'local' : 'public'}`;
    const cached = this.urlChecks.get(key);
    if (cached && this.now() - cached.at < this.urlCheckTtlMs) return;
    try {
      await assertSafeResolvedUrl(provider.baseUrl, {
        allowLocalNetwork: provider.allowLocalNetwork === true
      });
      this.urlChecks.set(key, {at: this.now()});
    } catch (error) {
      throw Object.assign(new Error(error?.code ?? 'PROVIDER_URL_BLOCKED'), {
        code: error?.code ?? 'PROVIDER_URL_BLOCKED',
        detail: 'base-url-rejected'
      });
    }
  }

  #checkProvider({mode, configId, consent, confirmBilling, optInMemory}) {
    if (consent !== true) throw new AnalysisPermissionError('CONSENT_REQUIRED');
    if (!configId) throw new AnalysisPermissionError('PROVIDER_CONFIG_REQUIRED');
    const config = this.configStore.get(configId);
    if (!config) throw new AnalysisPermissionError('PROVIDER_CONFIG_NOT_FOUND');
    if (!config.modelId) throw new AnalysisPermissionError('MODEL_REQUIRED');
    if (!config.capabilities?.session) {
      throw new AnalysisPermissionError('SESSION_CAPABILITY_REQUIRED');
    }
    if (mode !== ANALYSIS_MODE.SESSION) {
      const permission = memoryPermission({
        pricingStatus: config.pricingStatus,
        pricing: config.pricing,
        capabilities: config.capabilities,
        optIn: optInMemory === true
      });
      if (!permission.allowed) {
        throw new AnalysisPermissionError('MEMORY_PERMISSION_DENIED', {reasons: permission.reasons});
      }
    }
    if (config.pricingStatus !== PRICING_STATUS.API_FREE
      && confirmBilling !== true) {
      throw new AnalysisPermissionError('SPEND_CONFIRMATION_REQUIRED');
    }
    return {provider: providerFromConfig(config), config};
  }

  async start({
    sessionId,
    locale = 'en',
    mode = ANALYSIS_MODE.SESSION,
    configId = null,
    consent = false,
    confirmBilling = false,
    optInMemory = false,
    budget = null
  } = {}) {
    if (this.active.has(sessionId)) throw new AnalysisPermissionError('ALREADY_RUNNING');
    // The console exposes the user-facing value `both`; the database and the
    // legacy jobs use `combined` for the same task. Accept both spellings here
    // so selecting "session + memory" can never silently degrade to session-only.
    if (mode === 'both') mode = ANALYSIS_MODE.COMBINED;
    if (![ANALYSIS_MODE.SESSION, ANALYSIS_MODE.MEMORY, ANALYSIS_MODE.COMBINED].includes(mode)) {
      throw new AnalysisPermissionError('INVALID_MODE');
    }
    const checked = this.#checkProvider({mode, configId, consent, confirmBilling, optInMemory});
    const state = this.state.get(sessionId);
    if (state?.status === 'running') {
      throw new AnalysisPermissionError('ALREADY_RUNNING');
    }
    // Resume only when the same config/model and mode are still selected.
    const resumable = state
      && state.configId === configId
      && state.mode === mode
      && state.status !== 'complete'
      && (state.sessionJobId || state.memoryJobId);
    if (resumable) {
      this.state.set(sessionId, {
        status: 'running',
        stage: 'resuming',
        error: null,
        providerConfigId: configId,
        providerId: checked.provider.providerId,
        modelId: checked.provider.modelId,
        pricingStatus: checked.provider.pricingStatus
      });
      return this.launch({sessionId, provider: checked.provider, mode, budget, resume: true});
    }
    this.state.set(sessionId, {
      status: 'running',
      stage: 'preparing',
      mode,
      locale,
      configId,
      providerConfigId: configId,
      providerName: checked.provider.label,
      providerId: checked.provider.providerId,
      modelId: checked.provider.modelId,
      pricingStatus: checked.provider.pricingStatus,
      sessionReportDone: false,
      memoryDone: mode === ANALYSIS_MODE.SESSION,
      memorySkipped: false,
      memorySkipReason: null,
      usage: null,
      budget: budget ?? null,
      error: null,
      batchesCompleted: 0,
      activeBatches: 0,
      batchDurationMsTotal: 0,
      batchSamples: 0,
      startedAt: this.now()
    });
    return this.launch({sessionId, provider: checked.provider, mode, budget, resume: false});
  }

  launch({sessionId, provider, mode, budget, resume}) {
    const controller = new AbortController();
    const context = {
      sessionId,
      provider,
      mode,
      budget: budget ?? null,
      controller,
      signal: controller.signal,
      paused: false
    };
    const promise = this.run(context, {resume})
      .catch((error) => this.fail(context, error))
      .finally(() => {
        this.active.delete(sessionId);
      });
    this.active.set(sessionId, {controller, promise, context});
    return this.getStatus(sessionId);
  }

  getStatus(sessionId) {
    const entry = this.state.get(sessionId);
    if (!entry) {
      return {
        sessionId,
        status: 'idle',
        stage: 'idle',
        running: false,
        canPause: false,
        canResume: false,
        canCancel: false
      };
    }
    const active = this.active.get(sessionId) ?? null;
    const sessionJob = entry.sessionJobId ? getJob(this.db, entry.sessionJobId) : null;
    const memoryJob = entry.memoryJobId ? getJob(this.db, entry.memoryJobId) : null;
    const sessionStatus = sessionJob ? computeJobStatus(this.db, sessionJob) : null;
    const memoryStatus = memoryJob ? computeJobStatus(this.db, memoryJob) : null;
    let status = entry.status;
    let stage = entry.stage;
    let error = entry.error ?? null;
    if (status === 'running' && !active) {
      status = 'interrupted';
      stage = 'interrupted';
      error = {code: 'ANALYSIS_INTERRUPTED', detail: null};
    }
    const sessionReportDone = Boolean(sessionStatus?.complete) || entry.sessionReportDone === true;
    const memoryCoverage = memoryStatus?.memoryCoverage ?? null;
    const memoryDone = entry.memorySkipped === true
      ? true
      : (!entry.memoryJobId
        ? entry.mode === ANALYSIS_MODE.SESSION
        : Boolean(memoryStatus?.complete));
    const scheduler = entry.configId && this.schedulers.get(`config:${entry.configId}`);
    const requestStats = scheduler ? scheduler.stats() : null;
    const batchTotal = Number(entry.batchTotal ?? memoryStatus?.batchTotal ?? 0);
    const batchesCompleted = Number(
      entry.batchesCompleted
        ?? memoryStatus?.batchesImported
        ?? (memoryDone ? batchTotal : 0)
    );
    const averageBatchMs = Number(entry.batchSamples ?? 0) > 0
      ? Number(entry.batchDurationMsTotal ?? 0) / Number(entry.batchSamples)
      : null;
    const remainingBatches = Math.max(0, batchTotal - batchesCompleted);
    const estimatedRemainingMs = (
      status === 'running'
      && averageBatchMs !== null
      && remainingBatches > 0
      && requestStats
    )
      ? Math.round((averageBatchMs * remainingBatches)
        / Math.max(1, requestStats.concurrency))
      : null;
    return {
      sessionId,
      status,
      stage,
      running: status === 'running',
      canPause: status === 'running' && Boolean(active),
      canResume: status !== 'complete'
        && Boolean(sessionJob || memoryJob)
        && error?.code !== 'ANALYSIS_MEMORY_OUT_OF_ORDER',
      canCancel: status === 'running' && Boolean(active),
      mode: entry.mode ?? ANALYSIS_MODE.SESSION,
      configId: entry.configId ?? null,
      providerName: entry.providerName ?? null,
      providerId: entry.providerId ?? null,
      modelId: entry.modelId ?? null,
      pricingStatus: entry.pricingStatus ?? null,
      batchIndex: batchesCompleted,
      batchTotal,
      batchesCompleted,
      activeBatches: Number(entry.activeBatches ?? 0),
      averageBatchMs: averageBatchMs === null ? null : Math.round(averageBatchMs),
      estimatedRemainingMs,
      startedAt: entry.startedAt ?? null,
      sessionReportDone,
      memoryDone,
      memorySkipped: entry.memorySkipped === true,
      memorySkipReason: entry.memorySkipReason ?? null,
      memoryCoverage,
      memoryViewersTotal: Number(memoryCoverage?.total ?? 0),
      memoryViewersProcessed: Number(memoryCoverage?.covered ?? 0),
      sessionJobId: entry.sessionJobId ?? null,
      memoryJobId: entry.memoryJobId ?? null,
      sessionJob: sessionStatus,
      memoryJob: memoryStatus,
      usage: entry.usage ?? null,
      budget: entry.budget ?? null,
      estimatedCost: entry.estimatedCost ?? null,
      requestStats,
      lastProvider: entry.lastProvider ?? null,
      lastModel: entry.lastModel ?? null,
      updatedAt: entry.updatedAt ?? null,
      error
    };
  }

  #setRunning(sessionId, patch) {
    return this.state.set(sessionId, {status: 'running', stage: patch.stage ?? 'running', ...patch});
  }

  async run(context, {resume}) {
    const {sessionId, provider, mode, signal} = context;
    try {
      if (signal.aborted) throw abortError();
      if (mode === ANALYSIS_MODE.SESSION || mode === ANALYSIS_MODE.COMBINED) {
        await this.runSession(context);
      }
      if (mode === ANALYSIS_MODE.MEMORY || mode === ANALYSIS_MODE.COMBINED) {
        try {
          await this.runMemory(context);
        } catch (error) {
          if (mode === ANALYSIS_MODE.COMBINED && this.#isSkippableMemoryError(error)) {
            this.state.set(sessionId, {
              stage: 'memory_skipped',
              memorySkipped: true,
              memorySkipReason: error.code,
              memoryDone: true,
              error: null
            });
            this.logger?.info?.({
              event: 'ai.analysis.memory.skipped',
              sessionId,
              reason: error.code
            });
          } else {
            throw error;
          }
        }
      }
      const entry = this.state.get(sessionId);
      this.state.set(sessionId, {
        status: 'complete',
        stage: 'complete',
        error: null,
        completedAt: this.now(),
        sessionReportDone: entry?.sessionReportDone === true,
        memoryDone: entry?.memorySkipped === true
          ? true
          : (entry?.memoryJobId ? true : entry?.mode === ANALYSIS_MODE.SESSION)
      });
      this.logger?.info?.({
        event: 'ai.analysis.complete',
        sessionId,
        mode,
        provider: provider.providerId,
        model: provider.modelId
      });
    } catch (error) {
      if (context.paused) {
        this.state.set(sessionId, {
          status: 'paused',
          stage: 'paused',
          error: {code: 'ANALYSIS_PAUSED', detail: null}
        });
        return;
      }
      if (signal.aborted || error?.code === 'ANALYSIS_CANCELED') {
        this.state.set(sessionId, {
          status: 'canceled',
          stage: 'canceled',
          error: null
        });
        return;
      }
      this.fail(context, error);
    }
  }

  fail(context, error) {
    const code = error?.code ?? 'ANALYSIS_FAILED';
    const detail = error?.detail
      ?? (error instanceof AnalysisPermissionError ? JSON.stringify(error.details) : null)
      ?? String(error?.message ?? '').slice(0, 300);
    const entry = this.state.get(context.sessionId);
    const sessionDone = entry?.sessionReportDone === true;
    this.state.set(context.sessionId, {
      status: sessionDone ? 'partial' : 'failed',
      stage: 'failed',
      error: {code, detail},
      sessionReportDone: sessionDone,
      memoryDone: false
    });
    this.logger?.warn?.({
      event: 'ai.analysis.failed',
      sessionId: context.sessionId,
      mode: context.mode,
      provider: context.provider?.providerId ?? null,
      model: context.provider?.modelId ?? null,
      code,
      retryAfterMs: error?.retryAfterMs ?? null,
      httpStatus: error?.status ?? null
    });
  }

  async runSession(context) {
    const {sessionId, provider} = context;
    const entry = this.state.get(sessionId);
    let job = entry?.sessionJobId ? getJob(this.db, entry.sessionJobId) : null;
    if (!job) {
      this.#setRunning(sessionId, {stage: 'packaging_session'});
      const created = await createSessionAnalysisJob({
        db: this.db,
        sessionId,
        locale: this.state.get(sessionId)?.locale ?? 'en',
        exportsDir: this.paths.exports,
        providerConfigId: provider.configId ?? null,
        providerId: provider.providerId,
        regionId: provider.regionId ?? null,
        modelId: provider.modelId,
        pricingStatus: provider.pricingStatus,
        budget: context.budget,
        costEstimate: null,
        now: this.now()
      });
      if (!created) throw Object.assign(new Error('SESSION_EMPTY'), {code: 'AUTO_SESSION_EMPTY'});
      job = getJob(this.db, created.job.id);
      this.state.set(sessionId, {sessionJobId: job.id, locale: job.locale});
    }
    const existing = latestResultForScope(this.db, job.id, 'batch:1');
    if (existing) {
      this.state.set(sessionId, {sessionReportDone: true});
      return;
    }
    const pkg = getJobPackage(this.db, {jobId: job.id, stage: 'session'});
    if (!pkg) throw Object.assign(new Error('PACKAGE_MISSING'), {code: 'ANALYSIS_PACKAGE_MISSING'});
    const files = readAnalysisPackage(join(this.paths.exports, pkg.file_name), SESSION_FILES);
    const prompt = buildSessionPrompt(files);
    const estimate = estimateCost({
      pricing: provider.pricing,
      inputTokens: prompt.estimatedTokens,
      outputTokens: 6000
    });
    this.state.set(sessionId, {
      stage: 'session_analyzing',
      batchIndex: 0,
      batchTotal: 1,
      estimatedCost: estimate
    });
    if (context.budget && estimate
      && context.budget.currency === estimate.currency
      && estimate.amount > context.budget.amount) {
      throw Object.assign(new Error('BUDGET_EXCEEDED'), {code: 'ANALYSIS_BUDGET_EXCEEDED'});
    }
    const startedAt = this.now();
    const generated = await this.requestWithRepair({
      context,
      prompt,
      kind: 'session'
    });
    this.state.set(sessionId, {
      stage: 'session_importing',
      batchDurationMsTotal: this.now() - startedAt,
      batchSamples: 1
    });
    const outcome = importAnalysisResult({
      db: this.db,
      text: generated.text,
      source: 'api',
      now: this.now()
    });
    this.state.set(sessionId, {
      sessionReportDone: true,
      stage: 'session_done',
      batchIndex: 1,
      batchTotal: 1,
      batchesCompleted: 1,
      lastProvider: generated.providerId,
      lastModel: generated.model
    });
    this.logger?.info?.({
      event: 'ai.analysis.session',
      sessionId,
      jobId: job.id,
      provider: generated.providerId,
      model: generated.model,
      duplicate: outcome.duplicate
    });
  }

  #broadcasterGateKey(broadcasterId) {
    return String(broadcasterId ?? '__unscoped__');
  }

  /**
   * These errors mean long-term profiling cannot be created for this broadcast,
   * not that the session report failed. In a combined task the report is kept
   * and the memory half is visibly skipped with a stable reason.
   */
  #isSkippableMemoryError(error) {
    return [
      'ANALYSIS_MEMORY_NO_VIEWERS',
      'ANALYSIS_MEMORY_NO_BROADCASTER'
    ].includes(error?.code);
  }

  #assertMemoryOrder(broadcasterId, sessionId, sessionStartedAt) {
    const newer = this.db.prepare(`
      SELECT s.id, s.started_at
        FROM sessions s
        JOIN ai_jobs j ON j.session_id = s.id
       WHERE s.broadcaster_id = ?
         AND s.id <> ?
         AND s.started_at > ?
         AND j.analysis_mode IN ('memory', 'combined')
         AND EXISTS (SELECT 1 FROM ai_results r WHERE r.job_id = j.id)
       ORDER BY s.started_at DESC
       LIMIT 1
    `).get(String(broadcasterId), String(sessionId), Number(sessionStartedAt));
    if (newer) {
      throw Object.assign(new Error('MEMORY_OUT_OF_ORDER'), {
        code: 'ANALYSIS_MEMORY_OUT_OF_ORDER',
        detail: `newer session ${newer.id} already has imported memory`
      });
    }
  }

  /**
   * Serialise memory work for the same broadcaster. Memory batches inside one
   * job cover disjoint viewers and may run concurrently, but two sessions for
   * the same broadcaster must not apply memory snapshots in an unpredictable
   * order. An older session is refused after a newer session's memory has
   * already been imported, instead of silently writing older facts last.
   */
  async #withBroadcasterMemoryGate(broadcasterId, sessionId, sessionStartedAt, task) {
    const key = this.#broadcasterGateKey(broadcasterId);
    const canOrder = broadcasterId && Number.isFinite(Number(sessionStartedAt));
    if (canOrder) this.#assertMemoryOrder(broadcasterId, sessionId, sessionStartedAt);
    const previous = this.memoryGates.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (canOrder) this.#assertMemoryOrder(broadcasterId, sessionId, sessionStartedAt);
      return task();
    });
    this.memoryGates.set(key, current.catch(() => {}));
    return current;
  }

  async runMemory(context) {
    const {sessionId, provider, signal} = context;
    const entry = this.state.get(sessionId);
    const session = getSession(this.db, sessionId);
    if (!session) throw Object.assign(new Error('SESSION_NOT_FOUND'), {code: 'ANALYSIS_SESSION_NOT_FOUND'});
    const broadcasterId = session.broadcaster_id ?? session.broadcasterId ?? null;
    const sessionStartedAt = session.started_at ?? session.startedAt ?? null;
    if (!broadcasterId) {
      throw Object.assign(new Error('MEMORY_BROADCASTER_REQUIRED'), {
        code: 'ANALYSIS_MEMORY_NO_BROADCASTER',
        detail: 'session has no stable broadcaster id'
      });
    }
    const viewers = listSessionViewers(this.db, sessionId, {limit: MAX_ANALYSIS_VIEWERS + 1});
    if (viewers.length === 0) {
      throw Object.assign(new Error('MEMORY_NO_VIEWERS'), {
        code: 'ANALYSIS_MEMORY_NO_VIEWERS',
        detail: 'identifiable viewers = 0'
      });
    }
    if (viewers.length > MAX_ANALYSIS_VIEWERS) {
      throw Object.assign(new Error('ANALYSIS_TOO_MANY_VIEWERS'), {
        code: 'ANALYSIS_TOO_MANY_VIEWERS',
        detail: `identifiable viewers = ${viewers.length}`
      });
    }
    if (broadcasterId && sessionStartedAt !== null) {
      this.#assertMemoryOrder(broadcasterId, sessionId, sessionStartedAt);
    }
    let job = entry?.memoryJobId ? getJob(this.db, entry.memoryJobId) : null;
    if (!job) {
      this.#setRunning(sessionId, {stage: 'packaging_memory'});
      const created = await createViewerMemoryJob({
        db: this.db,
        sessionId,
        locale: entry?.locale ?? 'en',
        exportsDir: this.paths.exports,
        viewersPerBatch: memoryViewersPerBatch(provider),
        excerptCap: 600,
        maxBatches: MAX_MEMORY_BATCHES,
        providerConfigId: provider.configId ?? null,
        providerId: provider.providerId,
        regionId: provider.regionId ?? null,
        modelId: provider.modelId,
        pricingStatus: provider.pricingStatus,
        budget: context.budget,
        costEstimate: null,
        now: this.now()
      });
      if (!created) throw Object.assign(new Error('MEMORY_NO_VIEWERS'), {
        code: 'ANALYSIS_MEMORY_NO_VIEWERS',
        detail: 'memory job creation returned no viewers'
      });
      job = getJob(this.db, created.job.id);
      this.state.set(sessionId, {
        memoryJobId: job.id,
        batchTotal: job.batchTotal,
        batchesCompleted: 0,
        stage: 'memory_ready'
      });
    }
    const sessionForGate = getSession(this.db, sessionId);
    if (!sessionForGate) throw Object.assign(new Error('SESSION_NOT_FOUND'), {code: 'ANALYSIS_SESSION_NOT_FOUND'});
    await this.#withBroadcasterMemoryGate(
      job.broadcasterId ?? sessionForGate.broadcaster_id ?? sessionForGate.broadcasterId,
      sessionId,
      sessionForGate.started_at ?? sessionForGate.startedAt,
      async () => {
        const batches = listJobBatches(this.db, job.id);
        const pending = batches.filter((batch) => (
          !latestResultForScope(this.db, job.id, `batch:${batch.batchIndex}`)
        ));
        const total = job.batchTotal;
        let completed = total - pending.length;
        let active = 0;
        this.#setRunning(sessionId, {
          stage: 'memory_analyzing',
          batchIndex: completed,
          batchTotal: total,
          batchesCompleted: completed,
          activeBatches: 0
        });
        await runPool(
          pending,
          Math.max(1, Math.min(provider.concurrency ?? 3, pending.length)),
          async (batch, _index, workerSignal) => {
            if (workerSignal.aborted) throw abortError();
            const pkg = getJobPackage(this.db, {
              jobId: job.id,
              stage: 'memory',
              batchIndex: batch.batchIndex
            });
            if (!pkg) throw Object.assign(new Error('PACKAGE_MISSING'), {code: 'ANALYSIS_PACKAGE_MISSING'});
            const files = readAnalysisPackage(join(this.paths.exports, pkg.file_name), MEMORY_FILES);
            const prompt = buildMemoryPrompt(files);
            prompt.files = files;
            active += 1;
            this.#setRunning(sessionId, {
              stage: 'memory_analyzing',
              batchIndex: completed,
              batchTotal: total,
              batchesCompleted: completed,
              activeBatches: active
            });
            const batchStartedAt = this.now();
            try {
              const generated = await this.generateMemoryAnswer({
                context: {...context, signal: workerSignal},
                prompt,
                kind: 'memory'
              });
              this.state.set(sessionId, {
                stage: 'memory_importing',
                batchIndex: completed,
                batchTotal: total,
                batchesCompleted: completed,
                activeBatches: active,
                lastProvider: generated.providerId,
                lastModel: generated.model
              });
              const outcome = importAnalysisResult({
                db: this.db,
                text: generated.text,
                source: 'api',
                now: this.now()
              });
              completed += 1;
              const batchMs = this.now() - batchStartedAt;
              const current = this.state.get(sessionId);
              const updated = getJob(this.db, job.id);
              this.state.set(sessionId, {
                stage: 'memory_batch_done',
                batchIndex: completed,
                batchTotal: total,
                batchesCompleted: completed,
                activeBatches: active,
                batchDurationMsTotal: Number(current?.batchDurationMsTotal ?? 0) + batchMs,
                batchSamples: Number(current?.batchSamples ?? 0) + 1,
                usage: updated?.usage ?? null,
                memoryDone: computeJobStatus(this.db, updated).complete
              });
              this.logger?.info?.({
                event: 'ai.analysis.memory.batch',
                sessionId,
                jobId: job.id,
                batchIndex: batch.batchIndex,
                provider: generated.providerId,
                model: generated.model,
                durationMs: batchMs,
                duplicate: outcome.duplicate
              });
            } finally {
              active = Math.max(0, active - 1);
              const current = this.state.get(sessionId);
              if (current?.status === 'running') {
                this.state.set(sessionId, {
                  activeBatches: active,
                  batchIndex: completed,
                  batchTotal: total,
                  batchesCompleted: completed
                });
              }
            }
          },
          signal
        );
        this.state.set(sessionId, {memoryDone: true, stage: 'memory_done'});
      }
    );
  }

  async generateMemoryAnswer({context, prompt, kind}) {
    const generated = await this.requestOnce({context, prompt, kind});
    const object = extractJsonObject(generated.content);
    let answer = object;
    let assembled = assembleMemoryCompact({
      answer,
      manifest: prompt.manifest,
      refs: prompt.refs
    });
    if (assembled.ok) {
      return {...generated, text: JSON.stringify(assembled.result)};
    }
    // One bounded targeted supplement for missing refs. Unknown/duplicate refs
    // are not "repaired" by guessing; they go through the normal error path.
    if (assembled.missing?.length > 0) {
      const targeted = buildTargetedMemoryPrompt({prompt, missingRefs: assembled.missing});
      let supplement;
      try {
        supplement = await this.requestOnce({context, prompt: targeted, kind: 'memory-targeted'});
      } catch {
        supplement = null;
      }
      if (supplement) {
        const merged = mergeMemorySupplement({
          answer,
          supplement: extractJsonObject(supplement.content),
          refs: prompt.refs,
          missingRefs: assembled.missing
        });
        if (merged.ok) {
          assembled = assembleMemoryCompact({
            answer: merged.answer,
            manifest: prompt.manifest,
            refs: prompt.refs
          });
        }
      }
    }
    if (!assembled.ok) {
      throw Object.assign(new Error('MEMORY_COVERAGE_INCOMPLETE'), {
        code: 'AUTO_VIEWER_COVERAGE_INCOMPLETE',
        detail: assembled.missing?.length
          ? `missing refs: ${assembled.missing.join(', ')}`
          : (assembled.issues?.[0]?.code ?? 'memory answer invalid')
      });
    }
    let validation = this.validate(JSON.stringify(assembled.result));
    if (!validation.ok) {
      const repair = buildRepairMessages({
        prompt,
        previousText: generated.content,
        errors: validation.errors,
        locale: prompt.locale
      });
      const repaired = await this.requestOnce({
        context,
        prompt: {...prompt, messages: repair.messages},
        kind: 'memory-repair'
      });
      const repairedAnswer = extractJsonObject(repaired.content);
      const repairedAssembled = assembleMemoryCompact({
        answer: repairedAnswer,
        manifest: prompt.manifest,
        refs: prompt.refs
      });
      if (!repairedAssembled.ok) {
        throw Object.assign(new Error('MEMORY_SCHEMA_INVALID'), {
          code: 'AUTO_SCHEMA_INVALID',
          detail: repairedAssembled.issues?.[0]?.code ?? 'memory repair invalid'
        });
      }
      assembled = repairedAssembled;
      validation = this.validate(JSON.stringify(assembled.result));
    }
    if (!validation.ok) {
      throw Object.assign(new Error('MEMORY_SCHEMA_INVALID'), {
        code: 'AUTO_SCHEMA_INVALID',
        detail: validation.errors?.[0]?.code ?? 'memory validation failed'
      });
    }
    return {...generated, text: JSON.stringify(validation.sanitized)};
  }

  async requestWithRepair({context, prompt, kind}) {
    let generated = await this.requestOnce({context, prompt, kind});
    let evaluation = this.evaluateSessionAnswer(generated.content, prompt);
    if (evaluation.ok) return {...generated, text: JSON.stringify(evaluation.sanitized)};
    const repair = buildRepairMessages({
      prompt,
      previousText: generated.content,
      errors: evaluation.errors,
      locale: prompt.locale
    });
    generated = await this.requestOnce({context, prompt: {...prompt, messages: repair.messages}, kind: `${kind}-repair`});
    evaluation = this.evaluateSessionAnswer(generated.content, prompt);
    if (!evaluation.ok) {
      throw Object.assign(new Error('SCHEMA_INVALID'), {
        code: 'AUTO_SCHEMA_INVALID',
        detail: (evaluation.errors ?? []).slice(0, 3)
          .map((error) => `${error.path || '(root)'}:${error.code}`)
          .join(', ') || 'validation failed'
      });
    }
    return {...generated, text: JSON.stringify(evaluation.sanitized)};
  }

  /**
   * Session answers must go through the local assembler before the Schema 1.3
   * validator. Models frequently omit protocol/job/task/session IDs; those are
   * not semantic output and must never be required from the model.
   */
  evaluateSessionAnswer(text, prompt) {
    const object = extractJsonObject(text);
    if (!object) {
      return {
        ok: false,
        errors: [{path: '', code: 'AUTO_INVALID_JSON'}]
      };
    }
    const assembled = assembleSessionAnswer({answer: object, manifest: prompt.manifest});
    if (!assembled.ok) {
      return {ok: false, errors: assembled.issues};
    }
    const validation = this.validate(JSON.stringify(assembled.result));
    if (!validation.ok) {
      return {ok: false, errors: validation.errors ?? []};
    }
    return {
      ok: true,
      sanitized: validation.sanitized,
      errors: []
    };
  }

  validate(text) {
    try {
      return validateAnalysisImport({db: this.db, text, source: 'api', now: this.now()});
    } catch (error) {
      return {ok: false, errors: [{path: '', code: error?.code ?? 'VALIDATION_FAILED'}]};
    }
  }

  async requestOnce({context, prompt, kind}) {
    const {provider, signal} = context;
    const scheduler = this.#schedulerFor(provider);
    await this.#ensureSafeProviderUrl(provider);

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal.aborted) throw abortError();
      const startedAt = this.now();
      try {
        const result = await scheduler.run(() => callProvider(provider, {
          apiKey: provider.configId ? this.configStore.secret(provider.configId) : null,
          messages: prompt.messages,
          maxTokens: kind.startsWith('session') ? 8000 : 6000,
          responseSchema: prompt.answerSchema ?? null,
          responseFormat: prompt.answerSchema ? (provider.supportsStructuredOutputs ? 'json_schema' : 'json_object') : 'none',
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: provider.timeoutMs ?? DEFAULT_TIMEOUT_MS
        }), {signal});
        const usage = result.usage ?? {inputTokens: 0, outputTokens: 0};
        const entry = this.state.get(context.sessionId);
        const nextUsage = addUsage(entry?.usage, usage, provider.pricing);
        this.state.set(context.sessionId, {
          usage: nextUsage,
          lastProvider: result.providerId,
          lastModel: result.model,
          lastRoutedProvider: result.routedProvider ?? null,
          stage: kind
        });
        if (entry?.memoryJobId) {
          const job = getJob(this.db, entry.memoryJobId);
          if (job) setJobUsage(this.db, job.id, nextUsage, {now: this.now()});
        } else if (entry?.sessionJobId) {
          const job = getJob(this.db, entry.sessionJobId);
          if (job) setJobUsage(this.db, job.id, nextUsage, {now: this.now()});
        }
        this.#checkBudget(context, nextUsage);
        return {
          content: result.text,
          text: result.text,
          providerId: result.providerId,
          model: result.model,
          usage,
          finishReason: result.finishReason,
          durationMs: this.now() - startedAt
        };
      } catch (error) {
        lastError = error;
        if (error?.code === 'ANALYSIS_BUDGET_EXCEEDED') throw error;
        if (attempt >= this.maxRetries || !isRetryable(error)) {
          throw Object.assign(new Error(error?.code ?? 'PROVIDER_FAILED'), {
            code: error?.code ?? 'PROVIDER_FAILED',
            detail: error?.detail ?? error?.message,
            status: error?.status ?? null,
            retryAfterMs: error?.retryAfterMs ?? null
          });
        }
        // A 429 already paused the provider scheduler for Retry-After. Sleeping
        // the same value again would double the wait for every retry.
        if (error.status === 429) {
          continue;
        }
        const delay = retryDelayMs(attempt, {
          baseMs: 1000,
          maxMs: 30000,
          random: this.random,
          retryAfterMs: error.retryAfterMs
        });
        await sleepWithSignal(delay, signal);
      }
    }
    throw lastError;
  }

  #checkBudget(context, usage) {
    if (!context.budget) return;
    const remaining = budgetRemaining(context.budget, usage);
    if (remaining?.exceeded) {
      throw Object.assign(new Error('BUDGET_EXCEEDED'), {code: 'ANALYSIS_BUDGET_EXCEEDED'});
    }
  }

  pause(sessionId) {
    const active = this.active.get(sessionId);
    if (!active) return this.getStatus(sessionId);
    active.context.paused = true;
    active.controller.abort();
    return this.getStatus(sessionId);
  }

  cancel(sessionId) {
    const active = this.active.get(sessionId);
    if (!active) {
      this.state.set(sessionId, {status: 'canceled', stage: 'canceled', error: null});
      return this.getStatus(sessionId);
    }
    active.context.paused = false;
    active.controller.abort();
    return this.getStatus(sessionId);
  }

  async resume(sessionId, {consent = false, confirmBilling = false, optInMemory = false, budget = null} = {}) {
    const entry = this.state.get(sessionId);
    if (!entry || !(entry.sessionJobId || entry.memoryJobId)) {
      throw new AnalysisPermissionError('NOTHING_TO_RESUME');
    }
    if (this.active.has(sessionId)) throw new AnalysisPermissionError('ALREADY_RUNNING');
    if (consent !== true) throw new AnalysisPermissionError('CONSENT_REQUIRED');
    const config = entry.configId ? this.configStore.get(entry.configId) : null;
    if (!config) throw new AnalysisPermissionError('PROVIDER_CONFIG_NOT_FOUND');
    if (entry.mode !== ANALYSIS_MODE.SESSION) {
      const permission = memoryPermission({
        pricingStatus: config.pricingStatus,
        pricing: config.pricing,
        capabilities: config.capabilities,
        optIn: optInMemory === true
      });
      if (!permission.allowed) {
        throw new AnalysisPermissionError('MEMORY_PERMISSION_DENIED', {reasons: permission.reasons});
      }
    }
    if (config.pricingStatus !== PRICING_STATUS.API_FREE && confirmBilling !== true) {
      throw new AnalysisPermissionError('SPEND_CONFIRMATION_REQUIRED');
    }
    const provider = providerFromConfig(config);
    this.state.set(sessionId, {status: 'running', stage: 'resuming', error: null});
    return this.launch({sessionId, provider, mode: entry.mode, budget: budget ?? entry.budget, resume: true});
  }

  async shutdown() {
    for (const active of this.active.values()) active.controller.abort();
    if (this.active.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.active.values()].map((item) => item.promise)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 4000);
          timer.unref?.();
        })
      ]);
    }
    for (const [sessionId, entry] of Object.entries(this.state.all())) {
      if (entry?.status === 'running') {
        this.state.set(sessionId, {status: 'interrupted', stage: 'interrupted', error: {code: 'ANALYSIS_INTERRUPTED'}});
      }
    }
  }
}
