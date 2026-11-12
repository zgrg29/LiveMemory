import {join} from 'node:path';
import {getJob, listJobBatches, setJobUsage} from '../../storage/repositories/ai-jobs.mjs';
import {getJobPackage} from '../../storage/repositories/ai-packages.mjs';
import {latestResultForScope, listResults} from '../../storage/repositories/ai-results.mjs';
import {getSession} from '../../storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {computeJobStatus} from '../tasks/status.mjs';
import {validateAnalysisImport} from '../import/validate.mjs';
import {importAnalysisResult} from '../import/importer.mjs';
import {createSessionAnalysisJob, createViewerMemoryJob} from '../export/split-jobs.mjs';
import {ANALYSIS_MODE, MAX_ANALYSIS_VIEWERS, TASK_KIND} from '../constants.mjs';
import {callProvider, ProviderHttpError} from '../providers/adapters.mjs';
import {assertSafeResolvedUrl} from '../providers/url-safety.mjs';
import {memoryPermission, addUsage, estimateCost, budgetRemaining} from '../providers/pricing.mjs';
import {PRICING_STATUS} from '../providers/catalog.mjs';
import {AnalysisState} from '../runtime/state.mjs';
import {
  extractJsonObject,
  sleepWithSignal,
  cancellationError,
  looksDegenerate
} from '../runtime/json.mjs';
import {ProviderRequestScheduler, retryDelayMs} from '../runtime/scheduler.mjs';
import {
  ERROR_KIND,
  attemptRecord,
  createTaskBudget,
  isCanceledError,
  shouldRetryAttempt,
  taskBudgetRemaining
} from '../runtime/attempt.mjs';
import {
  resolveBatchInputTokens,
  resolveOutputTokens
} from '../batching/tokens.mjs';
import {
  SESSION_FILES,
  MEMORY_FILES,
  buildSessionPrompt,
  buildMemoryPrompt,
  buildTargetedMemoryPrompt,
  buildSessionAggregatePrompt,
  condenseBatchResult,
  buildRepairMessages,
  readAnalysisPackage
} from './prompts.mjs';
import {
  assembleMemoryCompact,
  mergeMemorySupplement,
  assembleSessionAnswer,
  assembleSessionAggregateAnswer
} from './compact.mjs';

/**
 * Configured-provider analysis runner.
 *
 * The only supported AI path is a user-supplied API key and a user-configured
 * provider/model. There is no anonymous free route and no manual prompt/JSON
 * round trip in the product UI. Session and memory are separate jobs:
 *
 *   - a session report is imported as soon as each batch succeeds;
 *   - a large session is split by an input-token budget and finished with one
 *     aggregate answer, so one oversized request can never block the report;
 *   - viewer memory batches are independent and may run with bounded
 *     concurrency inside one job;
 *   - a failed batch never aborts sibling batches that already produced or are
 *     producing a valid answer;
 *   - a memory failure never invalidates a saved session report, and already
 *     imported batches remain valid and are skipped on resume.
 *
 * Every answer still goes through the existing schema/business validator and
 * the single transactional importer. The runner never writes analysis tables
 * directly.
 */

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const MIN_ATTEMPT_WINDOW_MS = 15000;
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

function emptyAttemptStats() {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    timedOut: 0,
    retried: 0,
    usageUnknown: 0
  };
}

function providerFromConfig(config, {responseMode = null} = {}) {
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
    batchInputTokens: Number(config.batchInputTokens) > 0 ? Number(config.batchInputTokens) : null,
    responseMode: responseMode === 'non_streaming' ? 'non_streaming' : 'streaming',
    pricingStatus: config.pricingStatus,
    pricing: config.pricing,
    allowLocalNetwork: config.allowLocalNetwork === true,
    contextLength: config.contextLength ?? null,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(config.concurrency) || 3)),
    configId: config.id
  };
}

/**
 * Viewer batch size is a model property, not a global constant. The token
 * planner reduces the batch further when excerpts or existing memory would not
 * fit the request budget; this cap is only the outer viewer bound.
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

/**
 * Run a worker pool over independent batches with safe isolation.
 *
 * A failure stops *scheduling* new batches but does not abort requests that are
 * already running: those imports are valuable and may already have been paid
 * for. Only user cancel/pause/shutdown aborts in-flight work, through the
 * external signal. The first error is re-thrown after every worker settles.
 */
async function runPool(items, limit, worker, signal) {
  let nextIndex = 0;
  let firstError = null;
  let stopped = false;
  const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const workers = Array.from({length: maxWorkers}, async () => {
    for (;;) {
      if (signal?.aborted) {
        if (!firstError) firstError = abortError();
        return;
      }
      if (stopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index, signal);
      } catch (error) {
        if (!firstError) {
          firstError = signal?.aborted ? abortError() : error;
          // Stop pulling new work; in-flight siblings finish and are imported.
          stopped = true;
        }
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
    random = Math.random,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
  }) {
    this.db = db;
    this.paths = paths;
    this.configStore = configStore;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.maxRetries = Math.max(0, Math.min(5, Number(maxRetries) || 0));
    this.random = random;
    this.taskTimeoutMs = Math.max(60000, Number(taskTimeoutMs) || DEFAULT_TASK_TIMEOUT_MS);
    this.idleTimeoutMs = Math.max(10000, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS);
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

  /**
   * True while an in-process analysis is actively using this config. Editing or
   * deleting it now would change the credential/model underneath a running task.
   */
  isConfigInUse(configId) {
    if (!configId) return false;
    for (const active of this.active.values()) {
      if (active?.context?.provider?.configId === configId) return true;
    }
    return false;
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
    const provider = providerFromConfig(config, {
      responseMode: this.state.getProviderMode(configId)
    });
    return {provider, config};
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
    // Resume only when the same config, provider/region/model and mode are still
    // selected. Otherwise the old job would mix two models; start a new task
    // instead and keep the old reports untouched.
    const sameConfiguration = state
      && state.providerId === checked.provider.providerId
      && (state.regionId ?? checked.provider.regionId) === checked.provider.regionId
      && state.modelId === checked.provider.modelId;
    const resumable = sameConfiguration
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
      regionId: checked.provider.regionId,
      modelId: checked.provider.modelId,
      pricingStatus: checked.provider.pricingStatus,
      sessionReportDone: false,
      memoryDone: mode === ANALYSIS_MODE.SESSION,
      memorySkipped: false,
      memorySkipReason: null,
      // A new task must not inherit the previous task's job ids. Keeping them
      // made a memory-only run appear to own an older, already complete session
      // report and changed a real failure into "partial".
      sessionJobId: null,
      memoryJobId: null,
      sessionBatchTotal: 0,
      sessionBatchesCompleted: 0,
      batchTotal: 0,
      batchIndex: 0,
      usage: null,
      budget: budget ?? null,
      error: null,
      batchesCompleted: 0,
      activeBatches: 0,
      batchDurationMsTotal: 0,
      batchSamples: 0,
      sessionBatchTotal: 0,
      sessionBatchesCompleted: 0,
      attemptStats: emptyAttemptStats(),
      currentRequest: null,
      lastRequest: null,
      startedAt: this.now()
    });
    return this.launch({sessionId, provider: checked.provider, mode, budget, resume: false});
  }

  launch({sessionId, provider, mode, budget, resume}) {
    const controller = new AbortController();
    const timeBudget = createTaskBudget({now: this.now, taskTimeoutMs: this.taskTimeoutMs});
    const previous = this.state.get(sessionId);
    this.state.set(sessionId, {
      status: 'running',
      taskStartedAt: timeBudget.startedAt,
      taskDeadlineAt: timeBudget.deadlineAt,
      taskTimeoutMs: timeBudget.taskTimeoutMs,
      currentRequest: null,
      attemptStats: resume
        ? (previous?.attemptStats ?? emptyAttemptStats())
        : emptyAttemptStats()
    });
    const context = {
      sessionId,
      provider,
      mode,
      budget: budget ?? null,
      controller,
      signal: controller.signal,
      paused: false,
      timeBudget,
      streamFallbackUsed: false
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
    const sessionBatchTotal = Number(sessionStatus?.batchTotal ?? entry.sessionBatchTotal ?? 0);
    const sessionBatchesCompleted = Number(
      sessionStatus?.batchesImported ?? entry.sessionBatchesCompleted ?? 0
    );
    const memoryBatchTotal = entry.memoryJobId
      ? Number(entry.batchTotal ?? memoryStatus?.batchTotal ?? 0)
      : 0;
    const memoryBatchesCompleted = entry.memoryJobId
      ? Number(
        entry.batchesCompleted
          ?? memoryStatus?.batchesImported
          ?? (memoryDone ? memoryBatchTotal : 0)
      )
      : 0;
    const batchTotal = entry.memoryJobId ? memoryBatchTotal : sessionBatchTotal;
    const batchesCompleted = entry.memoryJobId ? memoryBatchesCompleted : sessionBatchesCompleted;
    const averageBatchMs = Number(entry.batchSamples ?? 0) > 0
      ? Number(entry.batchDurationMsTotal ?? 0) / Number(entry.batchSamples)
      : null;
    const remainingBatches = Math.max(0, batchTotal - batchesCompleted);
    const hasBasisForEta = Number(entry.batchSamples ?? 0) >= 3
      && averageBatchMs !== null
      && remainingBatches > 0
      && Boolean(requestStats);
    const estimatedRemainingMs = (status === 'running' && hasBasisForEta)
      ? Math.round((averageBatchMs * remainingBatches)
        / Math.max(1, requestStats.concurrency))
      : null;
    const currentRequest = (status === 'running' && active)
      ? (entry.currentRequest ?? null)
      : null;
    const attemptStats = entry.attemptStats ?? emptyAttemptStats();
    const taskDeadlineAt = entry.taskDeadlineAt
      ?? (entry.taskStartedAt && entry.taskTimeoutMs
        ? entry.taskStartedAt + entry.taskTimeoutMs
        : null);
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
      regionId: entry.regionId ?? null,
      modelId: entry.modelId ?? null,
      pricingStatus: entry.pricingStatus ?? null,
      batchIndex: batchesCompleted,
      batchTotal,
      batchesCompleted,
      activeBatches: Number(entry.activeBatches ?? 0),
      sessionBatchIndex: sessionBatchesCompleted,
      sessionBatchTotal,
      sessionBatchesCompleted,
      sessionAggregateRequired: Boolean(sessionJob && sessionJob.batchTotal > 1),
      sessionAggregateDone: Boolean(sessionStatus?.aggregateImported),
      memoryBatchIndex: memoryBatchesCompleted,
      memoryBatchTotal,
      memoryBatchesCompleted,
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
      usageKnown: entry.usage !== null && entry.usage !== undefined,
      usageUnknownAttempts: Number(attemptStats.usageUnknown ?? 0),
      budget: entry.budget ?? null,
      estimatedCost: entry.estimatedCost ?? null,
      requestStats,
      attemptStats,
      currentRequest,
      lastRequest: entry.lastRequest ?? null,
      requestMode: currentRequest?.mode ?? entry.lastRequest?.mode ?? entry.responseMode ?? null,
      retrying: currentRequest?.retrying === true,
      outputReceived: currentRequest?.receivedOutput === true,
      taskStartedAt: entry.taskStartedAt ?? null,
      taskDeadlineAt,
      taskRemainingMs: taskDeadlineAt === null ? null : Math.max(0, taskDeadlineAt - this.now()),
      taskTimeoutMs: entry.taskTimeoutMs ?? this.taskTimeoutMs,
      saved: {
        sessionReport: sessionReportDone,
        sessionBatches: sessionBatchesCompleted,
        memoryBatches: memoryBatchesCompleted,
        // A session-only task must not claim that long-term profiles were
        // saved; only a real memory job can do that. A skipped memory half is
        // reported separately, never as "saved".
        memory: entry.memoryJobId ? memoryDone : false
      },
      lastProvider: entry.lastProvider ?? null,
      lastModel: entry.lastModel ?? null,
      updatedAt: entry.updatedAt ?? null,
      error
    };
  }

  #setRunning(sessionId, patch) {
    const previous = this.state.get(sessionId);
    const current = previous?.currentRequest ?? null;
    return this.state.set(sessionId, {
      status: 'running',
      stage: patch.stage ?? previous?.stage ?? 'running',
      ...patch,
      currentRequest: Object.prototype.hasOwnProperty.call(patch, 'currentRequest')
        ? patch.currentRequest
        : current
    });
  }

  #taskRemaining(context) {
    if (!context?.timeBudget) return null;
    return taskBudgetRemaining(context.timeBudget, this.now());
  }

  #assertTaskBudget(context, {minWindowMs = MIN_ATTEMPT_WINDOW_MS} = {}) {
    const remaining = this.#taskRemaining(context);
    if (remaining === null) return;
    if (remaining < minWindowMs) {
      throw Object.assign(new Error('TASK_TIME_BUDGET'), {
        code: 'ANALYSIS_TASK_TIMEOUT',
        detail: 'task-time-budget',
        kind: ERROR_KIND.TIMEOUT
      });
    }
  }

  #beginRequest(context, {
    kind,
    batchIndex = null,
    attempt = 1,
    maxAttempts = 1,
    mode = null,
    timeoutMs = null,
    idleTimeoutMs = null,
    stage = null
  }) {
    const currentRequest = {
      kind,
      batchIndex,
      attempt,
      maxAttempts,
      mode,
      streaming: mode === 'streaming',
      startedAt: this.now(),
      timeoutMs,
      idleTimeoutMs,
      receivedHeaders: false,
      receivedOutput: false,
      retrying: false,
      nextRetryAt: null
    };
    this.#setRunning(context.sessionId, {
      ...(stage ? {stage} : {}),
      currentRequest
    });
    return currentRequest;
  }

  #clearCurrentRequest(context) {
    this.#setRunning(context.sessionId, {currentRequest: null});
  }

  #markRetrying(context, {error, attempt, maxAttempts, nextRetryAt, stage}) {
    const previous = this.state.get(context.sessionId)?.currentRequest;
    this.#setRunning(context.sessionId, {
      ...(stage ? {stage} : {}),
      currentRequest: {
        ...(previous ?? {}),
        attempt,
        maxAttempts,
        retrying: true,
        nextRetryAt,
        lastErrorCode: error?.code ?? null,
        lastErrorKind: error?.kind ?? null
      }
    });
  }

  #recordAttempt(context, record) {
    const entry = this.state.get(context.sessionId);
    const stats = {...emptyAttemptStats(), ...(entry?.attemptStats ?? {})};
    stats.total += 1;
    if (record.outcome === 'succeeded') stats.succeeded += 1;
    else if (record.outcome === 'canceled') stats.canceled += 1;
    else if (record.outcome === 'timeout') stats.timedOut += 1;
    else stats.failed += 1;
    if (record.retry) stats.retried += 1;
    if (record.outcome !== 'succeeded' && record.usageKnown !== true) stats.usageUnknown += 1;
    const lastRequest = {
      kind: record.kind ?? null,
      batchIndex: record.batchIndex ?? null,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      mode: record.mode ?? null,
      outcome: record.outcome,
      errorCode: record.errorCode ?? null,
      errorKind: record.errorKind ?? null,
      httpStatus: record.httpStatus ?? null,
      elapsedMs: record.elapsedMs ?? null,
      receivedHeaders: record.receivedHeaders === true,
      receivedOutput: record.receivedOutput === true,
      timeToFirstByteMs: record.timeToFirstByteMs ?? null,
      usageKnown: record.usageKnown === true,
      at: this.now()
    };
    this.state.set(context.sessionId, {
      attemptStats: stats,
      lastRequest,
      currentRequest: record.retry ? entry?.currentRequest ?? null : null
    });
    this.logger?.info?.({
      event: 'ai.request.attempt',
      sessionId: context.sessionId,
      kind: record.kind,
      batchIndex: record.batchIndex,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      mode: record.mode,
      outcome: record.outcome,
      errorCode: record.errorCode ?? null,
      errorKind: record.errorKind ?? null,
      httpStatus: record.httpStatus ?? null,
      elapsedMs: record.elapsedMs ?? null,
      timeoutMs: record.timeoutMs ?? null,
      receivedHeaders: record.receivedHeaders === true,
      receivedOutput: record.receivedOutput === true,
      retry: record.retry === true,
      usageKnown: record.usageKnown === true,
      timeToFirstByteMs: record.timeToFirstByteMs ?? null
    });
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
        currentRequest: null,
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
          error: {code: 'ANALYSIS_PAUSED', detail: null},
          currentRequest: null
        });
        return;
      }
      if (signal.aborted || isCanceledError(error) || error?.code === 'ANALYSIS_CANCELED') {
        this.state.set(sessionId, {
          status: 'canceled',
          stage: 'canceled',
          error: null,
          currentRequest: null
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
    const sessionJob = entry?.sessionJobId ? getJob(this.db, entry.sessionJobId) : null;
    const sessionStatus = sessionJob ? computeJobStatus(this.db, sessionJob) : null;
    const sessionDone = entry?.sessionReportDone === true || Boolean(sessionStatus?.complete);
    this.state.set(context.sessionId, {
      // A successful session report makes a later memory failure "partial"; a
      // memory-only task that fails stays "failed" even though its already
      // imported batches are preserved and resumable (see `saved`).
      status: sessionDone ? 'partial' : 'failed',
      stage: 'failed',
      error: {
        code,
        detail,
        kind: error?.kind ?? null,
        httpStatus: error?.status ?? null,
        retryAfterMs: error?.retryAfterMs ?? null,
        receivedHeaders: error?.receivedHeaders === true,
        receivedOutput: error?.receivedOutput === true,
        elapsedMs: Number.isFinite(Number(error?.elapsedMs)) ? Number(error.elapsedMs) : null
      },
      sessionReportDone: sessionDone,
      memoryDone: false,
      currentRequest: null
    });
    this.logger?.warn?.({
      event: 'ai.analysis.failed',
      sessionId: context.sessionId,
      mode: context.mode,
      provider: context.provider?.providerId ?? null,
      model: context.provider?.modelId ?? null,
      code,
      detail,
      errorKind: error?.kind ?? null,
      retryAfterMs: error?.retryAfterMs ?? null,
      httpStatus: error?.status ?? null,
      receivedHeaders: error?.receivedHeaders === true,
      receivedOutput: error?.receivedOutput === true
    });
  }

  #sessionOutputTokens(provider, prompt) {
    return resolveOutputTokens({
      desired: 8000,
      inputTokens: prompt?.estimatedTokens ?? 0,
      contextLength: provider.contextLength
    });
  }

  async runSession(context) {
    const {sessionId, provider} = context;
    const entry = this.state.get(sessionId);
    let job = entry?.sessionJobId ? getJob(this.db, entry.sessionJobId) : null;
    if (!job) {
      this.#setRunning(sessionId, {stage: 'packaging_session'});
      const tokenBudget = resolveBatchInputTokens({
        configured: provider.batchInputTokens,
        contextLength: provider.contextLength,
        outputReserve: 8000
      });
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
        tokenBudget,
        contextLength: provider.contextLength,
        now: this.now()
      });
      if (!created) throw Object.assign(new Error('SESSION_EMPTY'), {code: 'AUTO_SESSION_EMPTY'});
      job = getJob(this.db, created.job.id);
      this.state.set(sessionId, {
        sessionJobId: job.id,
        locale: job.locale,
        sessionBatchTotal: job.batchTotal,
        sessionBatchesCompleted: 0,
        batchTotal: job.batchTotal,
        batchIndex: 0,
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget
      });
      this.logger?.info?.({
        event: 'ai.analysis.session.packaged',
        sessionId,
        jobId: job.id,
        batches: job.batchTotal,
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget
      });
    }
    const batches = listJobBatches(this.db, job.id);
    const total = Math.max(1, Number(job.batchTotal) || batches.length);
    const pending = batches.filter((batch) => (
      !latestResultForScope(this.db, job.id, `batch:${batch.batchIndex}`)
    ));
    let completed = total - pending.length;
    this.#setRunning(sessionId, {
      stage: 'session_analyzing',
      sessionBatchIndex: completed,
      sessionBatchTotal: total,
      sessionBatchesCompleted: completed,
      batchTotal: total,
      batchIndex: completed,
      activeBatches: 0
    });
    let active = 0;
    await runPool(
      pending,
      Math.max(1, Math.min(provider.concurrency ?? 3, pending.length || 1)),
      async (batch, _index, workerSignal) => {
        if (workerSignal?.aborted) throw abortError();
        const pkg = getJobPackage(this.db, {
          jobId: job.id,
          stage: 'session',
          batchIndex: batch.batchIndex
        });
        if (!pkg) throw Object.assign(new Error('PACKAGE_MISSING'), {code: 'ANALYSIS_PACKAGE_MISSING'});
        const files = readAnalysisPackage(join(this.paths.exports, pkg.file_name), SESSION_FILES);
        const prompt = buildSessionPrompt(files);
        prompt.files = files;
        const estimate = estimateCost({
          pricing: provider.pricing,
          inputTokens: prompt.estimatedTokens,
          outputTokens: this.#sessionOutputTokens(provider, prompt)
        });
        if (context.budget && estimate
          && context.budget.currency === estimate.currency
          && estimate.amount > context.budget.amount) {
          throw Object.assign(new Error('BUDGET_EXCEEDED'), {code: 'ANALYSIS_BUDGET_EXCEEDED'});
        }
        active += 1;
        this.#setRunning(sessionId, {
          stage: 'session_analyzing',
          sessionBatchIndex: completed,
          sessionBatchTotal: total,
          sessionBatchesCompleted: completed,
          batchTotal: total,
          batchIndex: completed,
          activeBatches: active
        });
        const batchStartedAt = this.now();
        try {
          const generated = await this.requestWithRepair({
            context: {...context, signal: workerSignal},
            prompt,
            kind: 'session',
            batchIndex: batch.batchIndex,
            stage: 'session_analyzing',
            outputTokens: this.#sessionOutputTokens(provider, prompt)
          });
          this.#setRunning(sessionId, {
            stage: 'session_importing',
            sessionBatchIndex: completed,
            sessionBatchTotal: total,
            sessionBatchesCompleted: completed,
            activeBatches: active
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
            stage: 'session_batch_done',
            sessionBatchIndex: completed,
            sessionBatchTotal: total,
            sessionBatchesCompleted: completed,
            batchTotal: total,
            batchIndex: completed,
            activeBatches: active,
            batchDurationMsTotal: Number(current?.batchDurationMsTotal ?? 0) + batchMs,
            batchSamples: Number(current?.batchSamples ?? 0) + 1,
            usage: updated?.usage ?? null,
            lastProvider: generated.providerId,
            lastModel: generated.model
          });
          this.logger?.info?.({
            event: 'ai.analysis.session.batch',
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
              sessionBatchIndex: completed,
              sessionBatchTotal: total,
              sessionBatchesCompleted: completed,
              batchTotal: total,
              batchIndex: completed
            });
          }
        }
      },
      context.signal
    );

    const final = latestResultForScope(this.db, job.id, 'final');
    if (!final && total > 1) {
      await this.#runSessionAggregate(context, job);
    } else if (!final && total === 1) {
      const single = latestResultForScope(this.db, job.id, 'batch:1');
      if (!single) throw Object.assign(new Error('SESSION_INCOMPLETE'), {code: 'ANALYSIS_INCOMPLETE'});
    }
    this.state.set(sessionId, {
      sessionReportDone: true,
      stage: 'session_done',
      sessionBatchesCompleted: total,
      sessionBatchTotal: total,
      batchIndex: this.state.get(sessionId)?.memoryJobId ? this.state.get(sessionId).batchIndex : total,
      batchesCompleted: this.state.get(sessionId)?.memoryJobId ? this.state.get(sessionId).batchesCompleted : total,
      currentRequest: null
    });
  }

  #buildAggregatePrompt(job) {
    const packages = getJobPackage(this.db, {jobId: job.id, stage: 'session', batchIndex: 1});
    if (!packages) throw Object.assign(new Error('PACKAGE_MISSING'), {code: 'ANALYSIS_PACKAGE_MISSING'});
    const files = readAnalysisPackage(join(this.paths.exports, packages.file_name), ['result.schema.json']);
    const resultSchema = JSON.parse(files['result.schema.json']);
    const rows = listResults(this.db, job.id, {includeJson: true})
      .filter((row) => row.batchIndex !== null);
    const latest = new Map();
    for (const row of rows) {
      const current = latest.get(row.batchIndex);
      if (!current || current.resultVersion < row.resultVersion) latest.set(row.batchIndex, row);
    }
    const batchRows = new Map(listJobBatches(this.db, job.id).map((batch) => [batch.batchIndex, batch]));
    const batchResults = [...latest.values()]
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((row) => {
        const batch = batchRows.get(row.batchIndex);
        return {
          batch_index: row.batchIndex,
          task_id: row.taskId,
          coverage: batch
            ? {
              from_seq: batch.fromSeq,
              to_seq: batch.toSeq,
              message_count: batch.messageCount
            }
            : null,
          result: condenseBatchResult(row.result, {batchIndex: row.batchIndex})
        };
      });
    if (batchResults.length === 0) {
      throw Object.assign(new Error('AGGREGATE_NOT_READY'), {code: 'ANALYSIS_AGGREGATE_NOT_READY'});
    }
    const manifest = {
      job_id: job.id,
      session_id: job.sessionId,
      locale: job.locale,
      broadcaster_id: job.broadcasterId ?? null,
      tasks: [{
        task_id: job.aggregateTaskId ?? `${job.sessionId}-analysis-final`,
        kind: TASK_KIND.SESSION_AGGREGATE,
        session_id: job.sessionId
      }]
    };
    const prompt = buildSessionAggregatePrompt({manifest, batchResults, resultSchema});
    return {prompt, resultSchema};
  }

  async #runSessionAggregate(context, job) {
    const {sessionId, provider} = context;
    this.#setRunning(sessionId, {stage: 'session_aggregating'});
    const {prompt} = this.#buildAggregatePrompt(job);
    const contextLimit = Number(provider.contextLength ?? 0);
    if (contextLimit > 0 && prompt.estimatedTokens > contextLimit - 2000) {
      throw Object.assign(new Error('AGGREGATE_TOO_LARGE'), {
        code: 'ANALYSIS_AGGREGATE_TOO_LARGE',
        detail: `estimated ${prompt.estimatedTokens} input tokens, context ${contextLimit}; all batch results are preserved`
      });
    }
    const generated = await this.requestWithRepair({
      context,
      prompt,
      kind: 'session-aggregate',
      batchIndex: null,
      stage: 'session_aggregating',
      outputTokens: resolveOutputTokens({
        desired: 8000,
        inputTokens: prompt.estimatedTokens,
        contextLength: provider.contextLength
      }),
      evaluate: (text, aggregatePrompt) => this.evaluateSessionAggregateAnswer(text, aggregatePrompt)
    });
    this.#setRunning(sessionId, {stage: 'session_importing'});
    const outcome = importAnalysisResult({
      db: this.db,
      text: generated.text,
      source: 'api',
      now: this.now()
    });
    this.state.set(sessionId, {
      sessionReportDone: true,
      stage: 'session_done',
      lastProvider: generated.providerId,
      lastModel: generated.model,
      currentRequest: null
    });
    this.logger?.info?.({
      event: 'ai.analysis.session.aggregate',
      sessionId,
      jobId: job.id,
      batches: job.batchTotal,
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
    const {sessionId, provider} = context;
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
      const tokenBudget = resolveBatchInputTokens({
        configured: provider.batchInputTokens,
        contextLength: provider.contextLength,
        outputReserve: 6000
      });
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
        tokenBudget,
        contextLength: provider.contextLength,
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
        stage: 'memory_ready',
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget
      });
      this.logger?.info?.({
        event: 'ai.analysis.memory.packaged',
        sessionId,
        jobId: job.id,
        batches: job.batchTotal,
        viewers: created.job.memoryViewersTotal,
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget
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
          Math.max(1, Math.min(provider.concurrency ?? 3, pending.length || 1)),
          async (batch, _index, workerSignal) => {
            if (workerSignal?.aborted) throw abortError();
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
                batchIndex: batch.batchIndex,
                stage: 'memory_analyzing'
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
          context.signal
        );
        const updated = getJob(this.db, job.id);
        if (!updated || !computeJobStatus(this.db, updated).complete) {
          throw Object.assign(new Error('MEMORY_INCOMPLETE'), {code: 'ANALYSIS_INCOMPLETE'});
        }
        this.state.set(sessionId, {memoryDone: true, stage: 'memory_done'});
      }
    );
  }

  async generateMemoryAnswer({context, prompt, batchIndex = null, stage = 'memory_analyzing', outputTokens = 6000}) {
    const budgetFor = (sourcePrompt) => resolveOutputTokens({
      desired: outputTokens,
      inputTokens: sourcePrompt?.estimatedTokens ?? 0,
      contextLength: context.provider?.contextLength ?? null
    });
    const generated = await this.requestOnce({
      context,
      prompt,
      kind: 'memory',
      batchIndex,
      stage,
      outputTokens: budgetFor(prompt)
    });
    this.#assertUsableOutput(generated);
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
        supplement = await this.requestOnce({
          context,
          prompt: targeted,
          kind: 'memory-targeted',
          batchIndex,
          stage,
          outputTokens: Math.min(3000, budgetFor(targeted))
        });
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
        kind: 'memory-repair',
        batchIndex,
        stage,
        outputTokens: budgetFor(prompt)
      });
      this.#assertUsableOutput(repaired);
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

  #assertUsableOutput(generated) {
    if (generated?.finishReason === 'length') {
      throw Object.assign(new Error('OUTPUT_TRUNCATED'), {
        code: 'AUTO_OUTPUT_TRUNCATED',
        detail: 'finish-reason-length',
        kind: ERROR_KIND.INVALID_RESPONSE
      });
    }
    if (looksDegenerate(generated?.content)) {
      throw Object.assign(new Error('OUTPUT_DEGENERATED'), {
        code: 'AUTO_OUTPUT_DEGENERATED',
        detail: 'repeated-structure',
        kind: ERROR_KIND.INVALID_RESPONSE
      });
    }
  }

  async requestWithRepair({
    context,
    prompt,
    kind,
    batchIndex = null,
    stage = null,
    outputTokens = 8000,
    evaluate = null
  }) {
    const evaluateAnswer = evaluate ?? ((text, sourcePrompt) => this.evaluateSessionAnswer(text, sourcePrompt));
    let generated = await this.requestOnce({context, prompt, kind, batchIndex, stage, outputTokens});
    // A length-truncated or degenerate answer must not trigger a second copy of
    // the same large request: that was the original 3× timeout/cost failure.
    this.#assertUsableOutput(generated);
    let evaluation = evaluateAnswer(generated.content, prompt);
    if (evaluation.ok) return {...generated, text: JSON.stringify(evaluation.sanitized)};
    const repair = buildRepairMessages({
      prompt,
      previousText: generated.content,
      errors: evaluation.errors,
      locale: prompt.locale
    });
    generated = await this.requestOnce({
      context,
      prompt: {...prompt, messages: repair.messages},
      kind: `${kind}-repair`,
      batchIndex,
      stage,
      outputTokens
    });
    this.#assertUsableOutput(generated);
    evaluation = evaluateAnswer(generated.content, prompt);
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

  evaluateSessionAggregateAnswer(text, prompt) {
    const object = extractJsonObject(text);
    if (!object) {
      return {ok: false, errors: [{path: '', code: 'AUTO_INVALID_JSON'}]};
    }
    const assembled = assembleSessionAggregateAnswer({answer: object, manifest: prompt.manifest});
    if (!assembled.ok) return {ok: false, errors: assembled.issues};
    const validation = this.validate(JSON.stringify(assembled.result));
    if (!validation.ok) return {ok: false, errors: validation.errors ?? []};
    return {ok: true, sanitized: validation.sanitized, errors: []};
  }

  validate(text) {
    try {
      return validateAnalysisImport({db: this.db, text, source: 'api', now: this.now()});
    } catch (error) {
      return {ok: false, errors: [{path: '', code: error?.code ?? 'VALIDATION_FAILED'}]};
    }
  }

  #isStreamUnsupported(error) {
    if (!error || error.kind !== ERROR_KIND.CLIENT) return false;
    if (![400, 404, 415, 422].includes(Number(error.status))) return false;
    return /stream|sse|chunk|stream_options/i.test(String(error.detail ?? ''));
  }

  #retryingStage(kind, fallback) {
    if (kind === 'session-aggregate') return 'session_aggregating';
    if (kind.startsWith('memory')) return 'memory_analyzing';
    if (kind.startsWith('session')) return 'session_analyzing';
    return fallback ?? 'running';
  }

  async requestOnce({
    context,
    prompt,
    kind,
    batchIndex = null,
    stage = null,
    outputTokens = 8000
  }) {
    const {provider, signal} = context;
    const scheduler = this.#schedulerFor(provider);
    await this.#ensureSafeProviderUrl(provider);

    const maxAttempts = Math.min(3, Math.max(1, this.maxRetries + 1));
    let attempt = 0;
    let lastError = null;
    let fallbackUsed = false;
    while (attempt < maxAttempts) {
      if (signal.aborted) throw abortError();
      const remaining = this.#taskRemaining(context);
      if (remaining !== null && remaining < MIN_ATTEMPT_WINDOW_MS) {
        this.#assertTaskBudget(context);
      }
      const effectiveTimeout = remaining === null
        ? provider.timeoutMs
        : Math.max(MIN_ATTEMPT_WINDOW_MS, Math.min(provider.timeoutMs, remaining));
      const idleTimeout = Math.max(10000, Math.min(this.idleTimeoutMs, effectiveTimeout));
      const streaming = provider.responseMode !== 'non_streaming';
      const mode = streaming ? 'streaming' : 'non_streaming';
      const startedAt = this.now();
      this.#beginRequest(context, {
        kind,
        batchIndex,
        attempt: attempt + 1,
        maxAttempts,
        mode,
        timeoutMs: effectiveTimeout,
        idleTimeoutMs: idleTimeout,
        stage: stage ?? this.#retryingStage(kind)
      });
      try {
        const reportProgress = (patch) => {
          if (!patch) return;
          const stateEntry = this.state.get(context.sessionId);
          const current = stateEntry?.currentRequest;
          if (!current || current.attempt !== attempt + 1) return;
          const next = {...current};
          let changed = false;
          if (patch.receivedHeaders === true && current.receivedHeaders !== true) {
            next.receivedHeaders = true;
            next.headersAt = patch.headersAt ?? this.now();
            changed = true;
          }
          if (patch.receivedOutput === true && current.receivedOutput !== true) {
            next.receivedOutput = true;
            next.firstTokenAt = patch.firstTokenAt ?? this.now();
            changed = true;
          }
          if (changed) {
            this.#setRunning(context.sessionId, {
              stage: stateEntry.stage,
              currentRequest: next
            });
          }
        };
        const result = await scheduler.run(() => callProvider(provider, {
          apiKey: provider.configId ? this.configStore.secret(provider.configId) : null,
          messages: prompt.messages,
          maxTokens: Math.max(256, Number(outputTokens) || 8000),
          responseSchema: prompt.answerSchema ?? null,
          responseFormat: prompt.answerSchema
            ? (provider.supportsStructuredOutputs ? 'json_schema' : 'json_object')
            : 'none',
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: effectiveTimeout,
          idleTimeoutMs: idleTimeout,
          maxTotalMs: remaining ?? null,
          streaming,
          now: this.now,
          onProgress: reportProgress
        }), {signal});
        const usage = result.usage ?? null;
        const entry = this.state.get(context.sessionId);
        const nextUsage = usage ? addUsage(entry?.usage, usage, provider.pricing) : (entry?.usage ?? null);
        if (usage) {
          this.state.set(context.sessionId, {
            usage: nextUsage,
            lastProvider: result.providerId,
            lastModel: result.model,
            lastRoutedProvider: result.routedProvider ?? null,
            responseMode: result.responseMode ?? mode
          });
          if (entry?.memoryJobId) {
            const job = getJob(this.db, entry.memoryJobId);
            if (job) setJobUsage(this.db, job.id, nextUsage, {now: this.now()});
          } else if (entry?.sessionJobId) {
            const job = getJob(this.db, entry.sessionJobId);
            if (job) setJobUsage(this.db, job.id, nextUsage, {now: this.now()});
          }
          this.#checkBudget(context, nextUsage);
        }
        // A provider that ignores `stream` and returns JSON is handled by the
        // adapter, but remember the verified mode so the next batch does not
        // repeat the probe.
        if (streaming && result.responseMode !== 'streaming' && provider.configId) {
          provider.responseMode = 'non_streaming';
          this.state.setProviderMode(provider.configId, 'non_streaming', {reason: 'provider-returned-json'});
        } else if (streaming && result.responseMode === 'streaming' && provider.configId) {
          this.state.setProviderMode(provider.configId, 'streaming');
        }
        const durationMs = this.now() - startedAt;
        this.#recordAttempt(context, attemptRecord({
          kind,
          batchIndex,
          attempt,
          maxAttempts,
          mode: result.responseMode ?? mode,
          outcome: 'succeeded',
          elapsedMs: durationMs,
          timeoutMs: effectiveTimeout,
          receivedHeaders: true,
          receivedOutput: true,
          usageKnown: Boolean(usage),
          usage,
          metrics: result.metrics
        }));
        this.state.set(context.sessionId, {
          currentRequest: null,
          receivedOutput: true
        });
        return {
          content: result.text,
          text: result.text,
          providerId: result.providerId,
          model: result.model,
          usage,
          finishReason: result.finishReason,
          responseMode: result.responseMode ?? mode,
          metrics: result.metrics ?? null,
          durationMs
        };
      } catch (error) {
        lastError = error;
        if (error?.code === 'ANALYSIS_BUDGET_EXCEEDED') throw error;
        const canceled = isCanceledError(error) || signal.aborted;
        const outcome = canceled ? 'canceled' : (error?.kind === ERROR_KIND.TIMEOUT ? 'timeout' : 'failed');
        const durationMs = this.now() - startedAt;
        const failedAttempt = attempt;
        const recordFailure = (extra = {}) => this.#recordAttempt(context, attemptRecord({
          kind,
          batchIndex,
          attempt: failedAttempt,
          maxAttempts,
          mode,
          outcome,
          error,
          elapsedMs: durationMs,
          timeoutMs: effectiveTimeout,
          receivedHeaders: error?.receivedHeaders === true,
          receivedOutput: error?.receivedOutput === true,
          metrics: error?.metrics ?? null,
          ...extra
        }));
        if (canceled) {
          recordFailure();
          throw abortError();
        }
        const budgetLeft = this.#taskRemaining(context);
        if (String(error?.detail ?? '') === 'attempt-budget-exhausted'
          || (budgetLeft !== null && budgetLeft < MIN_ATTEMPT_WINDOW_MS)) {
          recordFailure();
          throw Object.assign(new Error('TASK_TIME_BUDGET'), {
            code: 'ANALYSIS_TASK_TIMEOUT',
            detail: 'task-time-budget',
            kind: ERROR_KIND.TIMEOUT
          });
        }
        // One verified non-streaming fallback when the provider rejects the
        // streaming transport itself. This is not a general retry: it happens
        // once per task, and only for a clear stream-transport rejection.
        if (!fallbackUsed && mode === 'streaming' && this.#isStreamUnsupported(error)) {
          recordFailure({retry: true});
          fallbackUsed = true;
          context.streamFallbackUsed = true;
          provider.responseMode = 'non_streaming';
          if (provider.configId) {
            this.state.setProviderMode(provider.configId, 'non_streaming', {reason: 'streaming-rejected'});
          }
          this.logger?.warn?.({
            event: 'ai.stream.fallback',
            sessionId: context.sessionId,
            kind,
            httpStatus: error?.status ?? null,
            reason: 'streaming-rejected'
          });
          continue;
        }
        const retry = shouldRetryAttempt(error, {
          attempt,
          maxRetries: this.maxRetries,
          random: this.random
        }) && (budgetLeft === null || budgetLeft >= MIN_ATTEMPT_WINDOW_MS);
        if (!retry || attempt + 1 >= maxAttempts) {
          recordFailure();
          throw this.#normalizeProviderError(error);
        }
        attempt += 1;
        const retryAfter = Number(error.retryAfterMs);
        const delay = error.kind === ERROR_KIND.RATE_LIMIT
          ? Math.min(300000, Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 1500)
          : retryDelayMs(attempt - 1, {
            baseMs: 1000,
            maxMs: 30000,
            random: this.random,
            retryAfterMs: error.retryAfterMs
          });
        const nextRetryAt = this.now() + delay;
        this.#markRetrying(context, {
          error,
          attempt: attempt + 1,
          maxAttempts,
          nextRetryAt,
          stage: stage ?? this.#retryingStage(kind)
        });
        recordFailure({retry: true, nextRetryAt});
        await sleepWithSignal(delay, signal);
        // The repeat attempt starts now; its own beginRequest replaces the
        // "retrying" marker.
      }
    }
    throw this.#normalizeProviderError(lastError);
  }

  #normalizeProviderError(error) {
    if (!error) {
      return Object.assign(new Error('PROVIDER_FAILED'), {code: 'PROVIDER_FAILED', kind: ERROR_KIND.NETWORK});
    }
    if (error instanceof AnalysisPermissionError || error?.code === 'ANALYSIS_BUDGET_EXCEEDED') return error;
    if (isCanceledError(error)) return abortError();
    const normalized = Object.assign(new Error(error?.code ?? 'PROVIDER_FAILED'), {
      code: error?.code ?? 'PROVIDER_FAILED',
      detail: error?.detail ?? error?.message,
      status: error?.status ?? null,
      retryAfterMs: error?.retryAfterMs ?? null,
      kind: error?.kind ?? null,
      receivedHeaders: error?.receivedHeaders === true,
      receivedOutput: error?.receivedOutput === true,
      elapsedMs: error?.elapsedMs ?? null,
      timeoutMs: error?.timeoutMs ?? null
    });
    return normalized;
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
      this.state.set(sessionId, {status: 'canceled', stage: 'canceled', error: null, currentRequest: null});
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
    const changed = entry.providerId
      && (config.providerId !== entry.providerId
        || config.modelId !== entry.modelId
        || (entry.regionId && config.regionId !== entry.regionId));
    if (changed) {
      throw new AnalysisPermissionError('CONFIG_CHANGED', {
        previousModelId: entry.modelId ?? null,
        currentModelId: config.modelId ?? null
      });
    }
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
    const provider = providerFromConfig(config, {
      responseMode: this.state.getProviderMode(config.id)
    });
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
        this.state.set(sessionId, {
          status: 'interrupted',
          stage: 'interrupted',
          error: {code: 'ANALYSIS_INTERRUPTED'},
          currentRequest: null
        });
      }
    }
  }
}
