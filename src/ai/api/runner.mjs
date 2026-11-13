import {join} from 'node:path';
import {
  getJob,
  listJobBatches,
  listJobMemoryViewers,
  recordJobFailure,
  setJobUsage
} from '../../storage/repositories/ai-jobs.mjs';
import {getJobPackage} from '../../storage/repositories/ai-packages.mjs';
import {latestResultForScope, listResults} from '../../storage/repositories/ai-results.mjs';
import {getSession} from '../../storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {computeJobStatus} from '../tasks/status.mjs';
import {buildRecovery} from '../tasks/recovery.mjs';
import {validateAnalysisImport} from '../import/validate.mjs';
import {importAnalysisResult} from '../import/importer.mjs';
import {createSessionAnalysisJob, createViewerMemoryJob} from '../export/split-jobs.mjs';
import {ANALYSIS_MODE, TASK_KIND} from '../constants.mjs';
import {callProvider, ProviderHttpError} from '../providers/adapters.mjs';
import {assertSafeResolvedUrl} from '../providers/url-safety.mjs';
import {addUsage} from '../providers/pricing.mjs';
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
  isCanceledError,
  shouldRetryAttempt
} from '../runtime/attempt.mjs';
import {
  MIN_AGGREGATE_OUTPUT_TOKENS,
  estimateJsonTokens,
  estimateTokens,
  resolveAggregateOutputTokens,
  resolveBatchInputTokens,
  resolveMaxCompletionTokens,
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
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const MAX_CONCURRENCY = 8;

/** Repair and aggregate must never recreate an unbounded prompt. */
const MAX_REPAIR_INPUT_TOKENS = 48000;
const MAX_AGGREGATE_INPUT_TOKENS = 48000;
/** Minimum previous-answer text kept when a repair request is tightened. */
const MIN_REPAIR_PREVIOUS_CHARS = 2000;
const MAX_REPAIR_PREVIOUS_CHARS = 12000;

/**
 * Second condense pass used only when the default aggregate input does not fit
 * the model/request budget. It still includes every batch and every evidence
 * reference; it only reduces per-batch cardinality and text length.
 */
const COMPACT_AGGREGATE_LIMITS = Object.freeze({
  topics: 16,
  sentiment: 8,
  disputes: 8,
  highlights: 8,
  summaryChars: 1200,
  topicSummaryChars: 800,
  keyPoints: 5,
  keyPointChars: 180,
  messageRefs: 6
});

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

/**
 * Errors the user can fix or retry later, or transient failures where the
 * provider may already have processed the request. These must not discard the
 * completed batches; the task becomes resumable instead of a dead failure.
 */
function needsUserAction(error) {
  const code = String(error?.code ?? '');
  if ([
    'PROVIDER_AUTH_FAILED',
    'PROVIDER_ENDPOINT_NOT_FOUND',
    'PROVIDER_CONFIG_INVALID',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_NETWORK_FAILED'
  ].includes(code)) return true;
  const status = Number(error?.status ?? 0);
  if (code === 'PROVIDER_HTTP_ERROR' && [400, 401, 402, 403, 404, 408, 422, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  return false;
}

/**
 * A batch-level validation failure is local to that batch. Later batches should
 * still run; provider/auth/cancel/database failures are different and still
 * stop new scheduling to avoid repeated paid calls or corrupt state.
 */
function isBatchValidationFailure(error) {
  return ['AI_IMPORT_INVALID', 'AUTO_SCHEMA_INVALID', 'AUTO_VIEWER_COVERAGE_INCOMPLETE'].includes(error?.code);
}

function emptyAttemptStats() {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    timedOut: 0,
    retried: 0,
    usageUnknown: 0,
    // A provider HTTP success is not a usable analysis result. This counter
    // records successful responses whose output was truncated, degenerate or
    // rejected by JSON/Schema/coverage validation, so the console can explain
    // "20 API requests succeeded, but the task failed".
    outputRejected: 0
  };
}

/**
 * Batch indexes are 1-based. `Number(null)` is 0, which used to turn an
 * aggregate failure (no batch) into a fake "batch 0" in persisted errors and
 * recovery conditions. Normalize every source to null or a positive integer.
 */
function normalizeBatchIndex(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return null;
  return number;
}

/**
 * Requests belong to exactly one child job. Session and memory jobs are
 * separate rows with separate usage; a task-level cumulative total must never
 * be written into both rows, otherwise both display a bill that includes the
 * other half.
 */
function jobIdForRequestKind(entry, kind) {
  const value = String(kind ?? '');
  if (value.startsWith('memory')) return entry?.memoryJobId ?? null;
  return entry?.sessionJobId ?? null;
}

function sumUsageValues(values) {
  const list = (values ?? []).filter((value) => value && typeof value === 'object');
  if (list.length === 0) return null;
  const total = {inputTokens: 0, outputTokens: 0, requests: 0, cost: null};
  let costAmount = 0;
  let costCurrency = null;
  let costKnown = true;
  for (const usage of list) {
    total.inputTokens += Number(usage.inputTokens ?? 0);
    total.outputTokens += Number(usage.outputTokens ?? 0);
    total.requests += Number(usage.requests ?? 0);
    const cost = usage.cost;
    if (!cost || !Number.isFinite(Number(cost.amount)) || !cost.currency) {
      // Unknown is not zero: if any child job has no reliable cost, the task
      // total is unknown rather than a misleading partial amount.
      costKnown = false;
      continue;
    }
    if (costCurrency && cost.currency !== costCurrency) {
      costKnown = false;
      continue;
    }
    costCurrency = cost.currency;
    costAmount += Number(cost.amount);
  }
  total.cost = costKnown && costCurrency
    ? {
      currency: costCurrency,
      amount: costAmount,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      basis: 'sum_of_jobs'
    }
    : null;
  return total;
}

function capParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out = {};
  for (const [key, value] of Object.entries(params).slice(0, 12)) {
    if (typeof value === 'string') out[key] = value.slice(0, 160);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Field-level errors, capped and stripped of anything that is not diagnostic. */
function extractValidationErrors(error, {limit = 20} = {}) {
  const source = Array.isArray(error?.details?.errors)
    ? error.details.errors
    : (Array.isArray(error?.errors) ? error.errors : []);
  return source.slice(0, limit).map((item) => ({
    path: typeof item?.path === 'string' ? item.path.slice(0, 300) : '',
    code: typeof item?.code === 'string' ? item.code.slice(0, 80) : 'UNKNOWN',
    params: capParams(item?.params)
  }));
}

function describeValidationErrors(errors, {limit = 3} = {}) {
  return (errors ?? []).slice(0, limit)
    .map((item) => `${item.path || '(root)'}:${item.code}`)
    .join(', ');
}

export function providerFromConfig(config, {responseMode = null} = {}) {
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
async function runPool(items, limit, worker, signal, {shouldStop = () => true} = {}) {
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
          // A batch-level validation failure must not block later batches; a
          // provider/auth/cancel/database failure still stops new scheduling.
          stopped = shouldStop(error);
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

  #checkProvider({mode, configId, consent}) {
    if (consent !== true) throw new AnalysisPermissionError('CONSENT_REQUIRED');
    if (!configId) throw new AnalysisPermissionError('PROVIDER_CONFIG_REQUIRED');
    const config = this.configStore.get(configId);
    if (!config) throw new AnalysisPermissionError('PROVIDER_CONFIG_NOT_FOUND');
    if (!config.modelId) throw new AnalysisPermissionError('MODEL_REQUIRED');
    if (!config.capabilities?.session) {
      throw new AnalysisPermissionError('SESSION_CAPABILITY_REQUIRED');
    }
    // Long-term profiling depends on a verified technical capability, never on
    // price, a "paid/free" label, or a billing confirmation.
    if (mode !== ANALYSIS_MODE.SESSION && config.capabilities?.memory !== true) {
      throw new AnalysisPermissionError('MEMORY_CAPABILITY_REQUIRED');
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
    consent = false
  } = {}) {
    if (this.active.has(sessionId)) throw new AnalysisPermissionError('ALREADY_RUNNING');
    // The console exposes the user-facing value `both`; the database and the
    // legacy jobs use `combined` for the same task. Accept both spellings here
    // so selecting "session + memory" can never silently degrade to session-only.
    if (mode === 'both') mode = ANALYSIS_MODE.COMBINED;
    if (![ANALYSIS_MODE.SESSION, ANALYSIS_MODE.MEMORY, ANALYSIS_MODE.COMBINED].includes(mode)) {
      throw new AnalysisPermissionError('INVALID_MODE');
    }
    const checked = this.#checkProvider({mode, configId, consent});
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
      return this.launch({sessionId, provider: checked.provider, mode, resume: true});
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
      error: null,
      batchesCompleted: 0,
      activeBatches: 0,
      batchDurationMsTotal: 0,
      batchSamples: 0,
      attemptStats: emptyAttemptStats(),
      currentRequest: null,
      lastRequest: null,
      startedAt: this.now()
    });
    return this.launch({sessionId, provider: checked.provider, mode, resume: false});
  }

  launch({sessionId, provider, mode, resume}) {
    const controller = new AbortController();
    const previous = this.state.get(sessionId);
    // Rehydrate per-job usage from the database after a restart. A resumed task
    // must keep adding new requests to the right child job instead of copying a
    // task-level total into both jobs.
    const usageByJob = {...(previous?.usageByJob ?? {})};
    for (const jobId of [previous?.sessionJobId, previous?.memoryJobId]) {
      if (!jobId || usageByJob[jobId]) continue;
      const job = getJob(this.db, jobId);
      if (job?.usage) usageByJob[jobId] = job.usage;
    }
    this.state.set(sessionId, {
      status: 'running',
      taskStartedAt: this.now(),
      taskPausedAt: null,
      currentRequest: null,
      usageByJob,
      usage: sumUsageValues(Object.values(usageByJob)),
      usageAttribution: 'per_job',
      attemptStats: resume
        ? (previous?.attemptStats ?? emptyAttemptStats())
        : emptyAttemptStats()
    });
    const context = {
      sessionId,
      provider,
      mode,
      controller,
      signal: controller.signal,
      paused: false,
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
    let error = entry.error ? {...entry.error} : null;
    if (error && error.batchIndex !== undefined) {
      // Legacy tasks persisted `batchIndex: 0` for aggregate failures because
      // `Number(null)` is 0. Batch indexes are 1-based; expose null, never 0.
      error.batchIndex = normalizeBatchIndex(error.batchIndex);
    }
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
    const taskElapsedMs = entry.taskStartedAt
      ? Math.max(0, (entry.taskPausedAt ?? entry.completedAt ?? this.now()) - entry.taskStartedAt)
      : null;
    const sessionAggregateRequired = Boolean(sessionJob && sessionJob.batchTotal > 1);
    const sessionAggregateDone = Boolean(sessionStatus?.aggregateImported);
    const waitingAggregate = sessionAggregateRequired
      && !sessionAggregateDone
      && sessionBatchesCompleted >= sessionBatchTotal
      && sessionBatchTotal > 0;
    const pendingSessionBatches = Math.max(0, sessionBatchTotal - sessionBatchesCompleted);
    const pendingMemoryBatches = Math.max(0, memoryBatchTotal - memoryBatchesCompleted);
    const recovery = buildRecovery({
      status,
      errorCode: error?.code ?? null,
      sessionJobId: entry.sessionJobId ?? null,
      memoryJobId: entry.memoryJobId ?? null,
      sessionStatus,
      memoryStatus
    });
    // Old tasks did not persist the rejection counter. A truncation/schema
    // failure still proves at least one successful response was unusable, so
    // report a conservative 1 instead of zero for backward compatibility.
    const rejectionCodes = new Set([
      'AUTO_OUTPUT_TRUNCATED',
      'AUTO_OUTPUT_DEGENERATED',
      'AUTO_SCHEMA_INVALID',
      'AUTO_INVALID_JSON',
      'AI_IMPORT_INVALID',
      'AUTO_VIEWER_COVERAGE_INCOMPLETE'
    ]);
    const outputRejected = Math.max(
      Number(attemptStats.outputRejected ?? 0),
      rejectionCodes.has(error?.code) && status !== 'complete' ? 1 : 0
    );
    if (error) {
      // The recovery object is the current source of truth. Older persisted
      // errors only had a generic "resume"; normalize them on read without
      // rewriting historical rows.
      error.recoveryKind = recovery?.kind ?? error.recoveryKind ?? null;
      error.recoverable = recovery ? recovery.canResume : error.recoverable;
      error.suggestedAction = recovery?.action ?? error.suggestedAction ?? null;
      if (!error.finishReason && error.detail === 'finish-reason-length') {
        error.finishReason = 'length';
      }
    }
    const savedResults = sessionBatchesCompleted
      + (sessionAggregateDone ? 1 : 0)
      + memoryBatchesCompleted;
    const analysisOutcome = status === 'complete'
      ? 'complete'
      : (status === 'running' ? 'running' : (recovery ? 'incomplete' : (status === 'canceled' ? 'canceled' : 'failed')));
    return {
      sessionId,
      status,
      stage,
      running: status === 'running',
      canPause: status === 'running' && Boolean(active),
      canResume: status !== 'complete'
        && Boolean(sessionJob || memoryJob)
        && error?.code !== 'ANALYSIS_MEMORY_OUT_OF_ORDER'
        && (recovery ? recovery.canResume : true),
      canCancel: status === 'running' && Boolean(active),
      mode: entry.mode ?? ANALYSIS_MODE.SESSION,
      locale: entry.locale ?? null,
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
      sessionAggregateRequired,
      sessionAggregateDone,
      waitingAggregate,
      pendingSessionBatches,
      pendingMemoryBatches,
      analysisOutcome,
      recovery,
      savedResults,
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
      usageByJob: {
        session: entry.sessionJobId ? (entry.usageByJob?.[entry.sessionJobId] ?? sessionJob?.usage ?? null) : null,
        memory: entry.memoryJobId ? (entry.usageByJob?.[entry.memoryJobId] ?? memoryJob?.usage ?? null) : null
      },
      usageAttribution: entry.usageAttribution ?? 'per_job',
      usageKnown: entry.usage !== null && entry.usage !== undefined,
      usageUnknownAttempts: Number(attemptStats.usageUnknown ?? 0),
      estimatedCost: entry.estimatedCost ?? null,
      requestStats,
      attemptStats,
      outputStats: {
        // HTTP/provider responses that returned successfully. This is an API
        // statistic, not a claim that the model produced a valid report.
        responses: Number(attemptStats.succeeded ?? 0),
        rejected: outputRejected,
        lastCode: entry.lastOutputRejection?.code ?? null,
        lastFinishReason: entry.lastOutputRejection?.finishReason ?? error?.finishReason ?? null
      },
      lastOutputRejection: entry.lastOutputRejection ?? null,
      currentRequest,
      lastRequest: entry.lastRequest ?? null,
      batchErrors: memoryStatus?.batchErrors ?? sessionStatus?.batchErrors ?? [],
      requestMode: currentRequest?.mode ?? entry.lastRequest?.mode ?? entry.responseMode ?? null,
      retrying: currentRequest?.retrying === true,
      outputReceived: currentRequest?.receivedOutput === true,
      taskStartedAt: entry.taskStartedAt ?? null,
      taskElapsedMs,
      taskPausedAt: entry.taskPausedAt ?? null,
      needsUserAction: status === 'needs_action',
      resumeReason: status === 'needs_action' ? (entry.error?.code ?? null) : null,
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

  #beginRequest(context, {
    kind,
    batchIndex = null,
    attempt = 1,
    maxAttempts = 1,
    mode = null,
    timeoutMs = null,
    idleTimeoutMs = null,
    stage = null,
    model = null,
    maxTokens = null,
    maxCompletionTokens = null,
    estimatedInputTokens = null
  }) {
    const currentRequest = {
      kind,
      batchIndex,
      attempt,
      maxAttempts,
      mode,
      streaming: mode === 'streaming',
      model,
      maxTokens,
      maxCompletionTokens,
      estimatedInputTokens,
      requestBytes: null,
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
      model: record.model ?? null,
      maxTokens: record.maxTokens ?? null,
      maxCompletionTokens: record.maxCompletionTokens ?? null,
      estimatedInputTokens: record.estimatedInputTokens ?? null,
      requestBytes: record.requestBytes ?? null,
      reasoningChars: record.reasoningChars ?? 0,
      reasoningTokens: record.reasoningTokens ?? null,
      finishReason: record.finishReason ?? null,
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
      timeToFirstByteMs: record.timeToFirstByteMs ?? null,
      timeToFirstTokenMs: record.timeToFirstTokenMs ?? null,
      model: record.model ?? null,
      maxTokens: record.maxTokens ?? null,
      maxCompletionTokens: record.maxCompletionTokens ?? null,
      estimatedInputTokens: record.estimatedInputTokens ?? null,
      requestBytes: record.requestBytes ?? null,
      reasoningChars: record.reasoningChars ?? 0,
      reasoningTokens: record.reasoningTokens ?? null,
      finishReason: record.finishReason ?? null
    });
  }

  /**
   * Record a provider response that arrived successfully but was not usable.
   * This never decrements `succeeded` and never pretends the HTTP call failed;
   * it makes the distinction visible in the status object.
   */
  #recordOutputRejected(context, {code, kind, batchIndex = null, stage = null, finishReason = null}) {
    const entry = this.state.get(context.sessionId);
    const stats = {...emptyAttemptStats(), ...(entry?.attemptStats ?? {})};
    stats.outputRejected = Number(stats.outputRejected ?? 0) + 1;
    this.state.set(context.sessionId, {
      attemptStats: stats,
      lastOutputRejection: {
        code: code ?? 'OUTPUT_REJECTED',
        kind: kind ?? null,
        batchIndex: normalizeBatchIndex(batchIndex),
        stage: stage ?? null,
        finishReason: finishReason ?? null,
        at: this.now()
      }
    });
    this.logger?.warn?.({
      event: 'ai.analysis.output.rejected',
      sessionId: context.sessionId,
      kind,
      batchIndex: normalizeBatchIndex(batchIndex),
      stage,
      code: code ?? 'OUTPUT_REJECTED',
      finishReason: finishReason ?? null
    });
  }

  /**
   * Attach the batch identity to an error and persist a per-batch failure.
   *
   * The job-level `last_error_json` keeps one entry per batch, so a sibling
   * batch that succeeds later clears only its own entry. This is what keeps
   * "batch 2 failed, batches 1/3/4 succeeded" diagnosable after concurrency and
   * after a restart.
   */
  #recordBatchFailure(job, batch, stage, error, sessionId = null) {
    if (error && typeof error === 'object') {
      if (error.jobId === undefined || error.jobId === null) error.jobId = job?.id ?? null;
      if (error.batchIndex === undefined || error.batchIndex === null) {
        error.batchIndex = batch?.batchIndex ?? null;
      }
      if (error.batchId === undefined || error.batchId === null) error.batchId = batch?.batchId ?? null;
      if (!error.stage) error.stage = stage ?? null;
    }
    if (!job?.id) return error;
    try {
      recordJobFailure(this.db, job.id, {
        code: error?.code ?? 'ANALYSIS_FAILED',
        errors: extractValidationErrors(error),
        viewerErrors: error?.viewerErrors ?? null,
        batchIndex: error?.batchIndex ?? null,
        batchId: error?.batchId ?? null,
        stage: error?.stage ?? stage ?? null,
        now: this.now()
      });
    } catch (dbError) {
      this.logger?.warn?.({
        event: 'ai.analysis.batch_failure.persist_failed',
        sessionId,
        jobId: job.id,
        batchIndex: batch?.batchIndex ?? null,
        code: dbError?.code ?? 'UNKNOWN'
      });
    }
    return error;
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
        recovery: null,
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
          taskPausedAt: this.now(),
          currentRequest: null
        });
        return;
      }
      if (signal.aborted || isCanceledError(error) || error?.code === 'ANALYSIS_CANCELED') {
        this.state.set(sessionId, {
          status: 'canceled',
          stage: 'canceled',
          error: null,
          completedAt: this.now(),
          currentRequest: null
        });
        return;
      }
      this.fail(context, error);
    }
  }

  fail(context, error) {
    const code = error?.code ?? 'ANALYSIS_FAILED';
    const entry = this.state.get(context.sessionId);
    const fieldErrors = extractValidationErrors(error);
    const detail = error?.detail
      ?? (fieldErrors.length > 0 ? describeValidationErrors(fieldErrors, {limit: 5}) : null)
      ?? (error instanceof AnalysisPermissionError ? JSON.stringify(error.details) : null)
      ?? String(error?.message ?? '').slice(0, 300);
    const sessionJob = entry?.sessionJobId ? getJob(this.db, entry.sessionJobId) : null;
    const sessionStatus = sessionJob ? computeJobStatus(this.db, sessionJob) : null;
    const memoryJob = entry?.memoryJobId ? getJob(this.db, entry.memoryJobId) : null;
    const memoryStatus = memoryJob ? computeJobStatus(this.db, memoryJob) : null;
    const sessionDone = entry?.sessionReportDone === true || Boolean(sessionStatus?.complete);
    const memoryCoverage = memoryStatus?.memoryCoverage ?? null;
    const memoryPartial = Boolean(memoryCoverage && Number(memoryCoverage.covered ?? 0) > 0
      && memoryCoverage.complete !== true);
    const actionRequired = needsUserAction(error);
    const uncertainBilling = code === 'PROVIDER_TIMEOUT'
      && (error?.receivedHeaders === true || error?.receivedOutput === true);
    const detailWithUncertainty = uncertainBilling
      ? `${detail ?? 'request-timeout'}; the provider may have processed this request, so resume retries only the unfinished batch`
      : detail;
    const jobId = error?.jobId ?? entry?.memoryJobId ?? entry?.sessionJobId ?? null;
    const batchIndex = normalizeBatchIndex(error?.batchIndex);
    const batchId = error?.batchId ?? null;
    const stage = error?.stage ?? entry?.stage ?? null;
    const finalStatus = actionRequired ? 'needs_action' : ((sessionDone || memoryPartial) ? 'partial' : 'failed');
    // The same source of truth as GET /api/ai/analyze/status: only the missing
    // unit is offered, never a re-run of saved batches.
    const recovery = buildRecovery({
      status: finalStatus,
      errorCode: code,
      sessionJobId: entry?.sessionJobId ?? null,
      memoryJobId: entry?.memoryJobId ?? null,
      sessionStatus,
      memoryStatus
    });
    const recoverable = recovery
      ? recovery.canResume
      : ((actionRequired || Boolean(entry?.sessionJobId || entry?.memoryJobId))
        && code !== 'ANALYSIS_MEMORY_OUT_OF_ORDER');
    this.state.set(context.sessionId, {
      // A successful session report makes a later memory failure "partial"; a
      // memory-only task that fails stays "failed" even though its already
      // imported batches are preserved and resumable (see `saved`).
      status: finalStatus,
      stage: actionRequired ? 'needs_action' : 'failed',
      recovery,
      error: {
        code,
        detail: detailWithUncertainty,
        stage,
        jobId,
        batchId,
        batchIndex,
        // Exact field-level diagnostics stay attached to the task status so the
        // console can show why an answer was rejected. The model's raw answer
        // and chat text are never included.
        errors: fieldErrors,
        recoverable,
        recoveryKind: recovery?.kind ?? null,
        suggestedAction: recovery?.action
          ?? (actionRequired ? 'check-provider' : (recoverable ? 'resume' : 'check-provider')),
        kind: error?.kind ?? null,
        finishReason: error?.finishReason ?? null,
        httpStatus: error?.status ?? null,
        retryAfterMs: error?.retryAfterMs ?? null,
        receivedHeaders: error?.receivedHeaders === true,
        receivedOutput: error?.receivedOutput === true,
        elapsedMs: Number.isFinite(Number(error?.elapsedMs)) ? Number(error.elapsedMs) : null,
        actionRequired,
        uncertainBilling
      },
      sessionReportDone: sessionDone,
      memoryDone: false,
      batchErrors: memoryStatus?.batchErrors ?? sessionStatus?.batchErrors ?? [],
      completedAt: this.now(),
      currentRequest: null
    });
    this.logger?.warn?.({
      event: actionRequired ? 'ai.analysis.needs_action' : 'ai.analysis.failed',
      sessionId: context.sessionId,
      mode: context.mode,
      provider: context.provider?.providerId ?? null,
      model: context.provider?.modelId ?? null,
      code,
      stage,
      jobId,
      batchId,
      batchIndex,
      detail: detailWithUncertainty,
      validationErrorCount: fieldErrors.length,
      validationErrorCodes: fieldErrors.slice(0, 8).map((item) => item.code),
      actionRequired,
      recoverable,
      recoveryKind: recovery?.kind ?? null,
      suggestedAction: recovery?.action ?? null,
      finishReason: error?.finishReason ?? null,
      uncertainBilling,
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

  /**
   * Hard input ceiling for requests that are not planned batches (aggregate and
   * repair). Batch planning already keeps normal requests within the configured
   * budget; these two paths previously had no ceiling when `contextLength` was
   * unknown.
   */
  #maxRequestInputTokens(provider, outputReserve) {
    const context = Number(provider.contextLength ?? 0);
    const byContext = context > 0
      ? context - Math.max(1024, Number(outputReserve) || 8000) - 500
      : MAX_AGGREGATE_INPUT_TOKENS;
    return Math.max(2000, Math.min(MAX_AGGREGATE_INPUT_TOKENS, byContext));
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
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget,
        contentBudgetTokens: created.job.contentBudgetTokens ?? null,
        overheadTokens: created.job.overheadTokens ?? null,
        batchPlan: created.job.batchPlan ?? null
      });
      this.logger?.info?.({
        event: 'ai.analysis.session.packaged',
        sessionId,
        jobId: job.id,
        batches: job.batchTotal,
        totalMessages: job.totalMessages ?? null,
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget,
        contentBudgetTokens: created.job.contentBudgetTokens ?? null,
        overheadTokens: created.job.overheadTokens ?? null,
        overheadAdjusted: created.job.batchPlan?.overheadAdjusted === true,
        contextCapped: created.job.batchPlan?.contextCapped === true
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
        } catch (error) {
          throw this.#recordBatchFailure(job, batch, 'session_analyzing', error, sessionId);
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
      try {
        await this.#runSessionAggregate(context, job);
      } catch (error) {
        throw this.#recordBatchFailure(job, null, 'session_aggregating', error, sessionId);
      }
    } else if (!final && total === 1) {
      const single = latestResultForScope(this.db, job.id, 'batch:1');
      if (!single) throw Object.assign(new Error('SESSION_INCOMPLETE'), {code: 'ANALYSIS_INCOMPLETE'});
    }
    this.state.set(sessionId, {
      sessionReportDone: true,
      stage: 'session_done',
      recovery: null,
      sessionBatchesCompleted: total,
      sessionBatchTotal: total,
      batchIndex: this.state.get(sessionId)?.memoryJobId ? this.state.get(sessionId).batchIndex : total,
      batchesCompleted: this.state.get(sessionId)?.memoryJobId ? this.state.get(sessionId).batchesCompleted : total,
      currentRequest: null
    });
  }

  #buildAggregatePrompt(job, provider) {
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
    const buildBatchResults = (limits) => [...latest.values()]
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((row) => {
        const batch = batchRows.get(row.batchIndex);
        const topics = row.result?.session_topics ?? {};
        const times = [
          ...(topics.topics ?? []),
          ...(topics.disputes ?? []),
          ...(topics.highlights ?? [])
        ].flatMap((entry) => [entry?.started_at, entry?.ended_at])
          .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
          .sort();
        return {
          batch_index: row.batchIndex,
          task_id: row.taskId,
          coverage: batch
            ? {
              from_seq: batch.fromSeq,
              to_seq: batch.toSeq,
              message_count: batch.messageCount,
              from_at: times[0] ?? null,
              to_at: times[times.length - 1] ?? null
            }
            : null,
          result: condenseBatchResult(row.result, {batchIndex: row.batchIndex, limits})
        };
      });
    let batchResults = buildBatchResults(null);
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
    const build = () => buildSessionAggregatePrompt({manifest, batchResults, resultSchema});
    let prompt = build();
    let batchResultTokens = estimateJsonTokens(batchResults);
    let outputTokens = resolveAggregateOutputTokens({
      batchResultTokens,
      inputTokens: prompt.estimatedTokens,
      contextLength: provider.contextLength
    });
    let inputLimit = this.#maxRequestInputTokens(provider, outputTokens);
    let compacted = false;
    const assertAggregateBudget = () => {
      if (outputTokens >= MIN_AGGREGATE_OUTPUT_TOKENS) return;
      throw Object.assign(new Error('AGGREGATE_BUDGET_TOO_SMALL'), {
        code: 'ANALYSIS_AGGREGATE_TOO_LARGE',
        detail: `context leaves only ${outputTokens} aggregate output tokens (minimum ${MIN_AGGREGATE_OUTPUT_TOKENS}); estimated ${prompt.estimatedTokens} input tokens, batches ${job.batchTotal}`,
        estimatedTokens: prompt.estimatedTokens,
        limit: inputLimit,
        outputTokens,
        batches: job.batchTotal,
        contextLength: provider.contextLength ?? null
      });
    };
    assertAggregateBudget();
    // The actual 18-batch task was ~34k input tokens. A smaller-context model
    // cannot merge that plus a real report in one request. Retry the planning
    // with lower per-batch cardinality (all batches, all evidence preserved)
    // before declaring the input too large.
    if (prompt.estimatedTokens > inputLimit) {
      compacted = true;
      batchResults = buildBatchResults(COMPACT_AGGREGATE_LIMITS);
      prompt = build();
      batchResultTokens = estimateJsonTokens(batchResults);
      outputTokens = resolveAggregateOutputTokens({
        batchResultTokens,
        inputTokens: prompt.estimatedTokens,
        contextLength: provider.contextLength
      });
      inputLimit = this.#maxRequestInputTokens(provider, outputTokens);
      assertAggregateBudget();
    }
    return {
      prompt,
      resultSchema,
      batchResults,
      batchResultTokens,
      outputTokens,
      inputLimit,
      compacted
    };
  }

  async #runSessionAggregate(context, job) {
    const {sessionId, provider} = context;
    this.#setRunning(sessionId, {stage: 'session_aggregating'});
    const aggregate = this.#buildAggregatePrompt(job, provider);
    const {prompt, outputTokens, inputLimit: limit} = aggregate;
    if (prompt.estimatedTokens > limit) {
      throw Object.assign(new Error('AGGREGATE_TOO_LARGE'), {
        code: 'ANALYSIS_AGGREGATE_TOO_LARGE',
        detail: `estimated ${prompt.estimatedTokens} input tokens, limit ${limit}, batches ${job.batchTotal}, aggregate output ${outputTokens}; all batch results are preserved`,
        estimatedTokens: prompt.estimatedTokens,
        limit,
        aggregateOutputTokens: outputTokens,
        batches: job.batchTotal
      });
    }
    this.logger?.info?.({
      event: 'ai.analysis.session.aggregate.request',
      sessionId,
      jobId: job.id,
      batches: job.batchTotal,
      estimatedInputTokens: prompt.estimatedTokens,
      inputLimit: limit,
      batchResultTokens: aggregate.batchResultTokens,
      aggregateOutputTokens: outputTokens,
      compacted: aggregate.compacted
    });
    const generated = await this.requestWithRepair({
      context,
      prompt,
      kind: 'session-aggregate',
      batchIndex: null,
      stage: 'session_aggregating',
      outputTokens,
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
      recovery: null,
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
      duplicate: outcome.duplicate,
      aggregateOutputTokens: outputTokens
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
    const viewers = listSessionViewers(this.db, sessionId, {limit: 1000000});
    if (viewers.length === 0) {
      throw Object.assign(new Error('MEMORY_NO_VIEWERS'), {
        code: 'ANALYSIS_MEMORY_NO_VIEWERS',
        detail: 'identifiable viewers = 0'
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
        providerConfigId: provider.configId ?? null,
        providerId: provider.providerId,
        regionId: provider.regionId ?? null,
        modelId: provider.modelId,
        pricingStatus: provider.pricingStatus,
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
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget,
        contentBudgetTokens: created.job.contentBudgetTokens ?? null,
        overheadTokens: created.job.overheadTokens ?? null,
        batchPlan: created.job.batchPlan ?? null,
        oversizedViewerCount: created.job.oversizedViewerCount ?? 0
      });
      this.logger?.info?.({
        event: 'ai.analysis.memory.packaged',
        sessionId,
        jobId: job.id,
        batches: job.batchTotal,
        viewers: created.job.memoryViewersTotal,
        inputBudgetTokens: created.job.inputBudgetTokens ?? tokenBudget,
        contentBudgetTokens: created.job.contentBudgetTokens ?? null,
        overheadTokens: created.job.overheadTokens ?? null,
        oversizedViewerCount: created.job.oversizedViewerCount ?? 0
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
        const assignedViewers = listJobMemoryViewers(this.db, job.id);
        const viewersByBatch = new Map();
        for (const viewer of assignedViewers) {
          if (viewer.status !== 'pending' && viewer.status !== 'failed') continue;
          const list = viewersByBatch.get(viewer.batchIndex) ?? [];
          list.push(viewer.viewerId);
          viewersByBatch.set(viewer.batchIndex, list);
        }
        const pending = assignedViewers.length > 0
          ? batches.filter((batch) => (viewersByBatch.get(batch.batchIndex)?.length ?? 0) > 0)
          : batches.filter((batch) => (
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
            const viewerIdsForBatch = viewersByBatch.get(batch.batchIndex) ?? null;
            const prompt = buildMemoryPrompt(files, {viewerIds: viewerIdsForBatch});
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
              const hasExistingResult = Boolean(latestResultForScope(
                this.db,
                job.id,
                `batch:${batch.batchIndex}`
              ));
              const outcome = importAnalysisResult({
                db: this.db,
                text: generated.text,
                source: 'api',
                now: this.now(),
                viewerIds: generated.viewerIds ?? prompt.viewerIds ?? viewerIdsForBatch,
                createVersion: hasExistingResult,
                viewerFailures: generated.viewerFailures ?? []
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
                duplicate: outcome.duplicate,
                viewerFailures: generated.viewerFailures?.length ?? 0
              });
              if (generated.viewerFailures?.length > 0) {
                const error = Object.assign(new Error('MEMORY_VIEWERS_REJECTED'), {
                  code: 'AI_IMPORT_INVALID',
                  details: {
                    errors: generated.viewerFailures.flatMap((entry) => entry.errors)
                  },
                  viewerErrors: generated.viewerFailures,
                  stage: 'validation',
                  jobId: job.id,
                  batchId: batch.batchId,
                  batchIndex: batch.batchIndex
                });
                throw error;
              }
            } catch (error) {
              throw this.#recordBatchFailure(job, batch, 'memory_analyzing', error, sessionId);
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
          context.signal,
          {shouldStop: (error) => !isBatchValidationFailure(error)}
        );
        const updated = getJob(this.db, job.id);
        if (!updated || !computeJobStatus(this.db, updated).complete) {
          throw Object.assign(new Error('MEMORY_INCOMPLETE'), {
            code: 'ANALYSIS_INCOMPLETE',
            detail: 'some viewers are failed or pending; resume retries only those viewers'
          });
        }
        this.state.set(sessionId, {memoryDone: true, stage: 'memory_done'});
      }
    );
  }

  async generateMemoryAnswer({context, prompt, batchIndex = null, stage = 'memory_analyzing', outputTokens = 6000}) {
    const entry = this.state.get(context.sessionId);
    const jobId = entry?.memoryJobId ?? null;
    const batchId = prompt.manifest?.batch?.batch_id ?? null;
    const budgetFor = (sourcePrompt) => resolveOutputTokens({
      desired: outputTokens,
      inputTokens: sourcePrompt?.estimatedTokens ?? 0,
      contextLength: context.provider?.contextLength ?? null
    });
    const missingIssues = (missing) => (missing ?? []).map((ref) => ({
      path: 'viewers',
      code: 'MEMORY_VIEWER_UPDATE_MISSING',
      params: {ref}
    }));
    const invalidAnswer = (errors, message) => Object.assign(new Error(message ?? 'MEMORY_IMPORT_INVALID'), {
      code: 'AI_IMPORT_INVALID',
      details: {errors},
      stage: 'validation',
      jobId,
      batchId,
      batchIndex
    });
    /**
     * One answer is only usable after BOTH steps:
     *   1. compact refs assemble to program-owned stable ids;
     *   2. the assembled Schema 1.3.0 result passes the ordinary importer
     *      validation (schema, identity, evidence ownership, coverage, enums).
     * A complete ref list is not proof of a valid answer.
     */
    const promptViewerIds = prompt.viewerIds ?? prompt.refs.map((entry) => entry.viewerId);
    const evaluate = (content, sourcePrompt = prompt) => {
      const answer = extractJsonObject(content);
      if (!answer) {
        return {
          assembled: {ok: false, issues: [{path: '', code: 'AUTO_INVALID_JSON'}], missing: [], ignoredFields: []},
          validation: {ok: false, errors: [{path: '', code: 'AUTO_INVALID_JSON'}]}
        };
      }
      const assembled = assembleMemoryCompact({
        answer,
        manifest: sourcePrompt.manifest,
        refs: sourcePrompt.refs
      });
      if (assembled.ignoredFields?.length > 0) {
        // Field names only. This proves the model tried to contribute identity
        // data without ever logging its value or the raw answer.
        this.logger?.warn?.({
          event: 'ai.analysis.memory.identity_fields_ignored',
          sessionId: context.sessionId,
          jobId,
          batchIndex,
          fields: assembled.ignoredFields
        });
      }
      if (!assembled.ok) {
        return {
          assembled,
          validation: {
            ok: false,
            errors: [...(assembled.issues ?? []), ...missingIssues(assembled.missing)]
          }
        };
      }
      return {
        assembled,
        validation: this.validate(JSON.stringify(assembled.result), {
          viewerIds: sourcePrompt.viewerIds ?? sourcePrompt.refs.map((entry) => entry.viewerId)
        })
      };
    };

    const generated = await this.requestOnce({
      context,
      prompt,
      kind: 'memory',
      batchIndex,
      stage,
      outputTokens: budgetFor(prompt)
    });
    this.#assertUsableOutput(generated, {context, kind: 'memory', batchIndex, stage});
    let evaluated = evaluate(generated.content);
    if (evaluated.validation.ok) {
      return {
        ...generated,
        text: JSON.stringify(evaluated.validation.sanitized),
        viewerIds: promptViewerIds,
        viewerFailures: []
      };
    }
    this.#recordOutputRejected(context, {
      code: (evaluated.validation.errors ?? [])[0]?.code ?? 'AI_IMPORT_INVALID',
      kind: 'memory',
      batchIndex,
      stage,
      finishReason: generated.finishReason ?? null
    });

    // Exactly one bounded repair request, whether the first answer had missing
    // refs, unknown fields, illegal enums or invalid evidence. If it still
    // fails, the batch stops and stays resumable; nothing invalid is imported.
    const outputBudget = budgetFor(prompt);
    const repairLimit = this.#maxRequestInputTokens(context.provider, outputBudget);
    const errorsForRepair = evaluated.validation.errors ?? [];
    const onlyMissingRefs = !evaluated.assembled.ok
      && (evaluated.assembled.issues ?? []).length === 0
      && (evaluated.assembled.missing ?? []).length > 0;
    let repairPrompt;
    if (onlyMissingRefs) {
      // Targeted supplement: only the missing viewers and their excerpts, not a
      // copy of the whole batch.
      repairPrompt = buildTargetedMemoryPrompt({
        prompt,
        missingRefs: evaluated.assembled.missing
      });
    } else {
      const repair = buildRepairMessages({
        prompt,
        previousText: generated.content,
        errors: errorsForRepair,
        locale: prompt.locale,
        maxInputTokens: repairLimit
      });
      if (repair.truncated) {
        this.logger?.warn?.({
          event: 'ai.repair.truncated',
          sessionId: context.sessionId,
          kind: 'memory-repair',
          batchIndex,
          previousChars: repair.previousChars,
          inputLimit: repairLimit
        });
      }
      if (repair.estimatedInputTokens > repairLimit) {
        throw Object.assign(new Error('REPAIR_TOO_LARGE'), {
          code: 'ANALYSIS_REPAIR_TOO_LARGE',
          detail: `estimated ${repair.estimatedInputTokens} input tokens, limit ${repairLimit}`,
          estimatedTokens: repair.estimatedInputTokens,
          limit: repairLimit,
          stage: 'validation',
          jobId,
          batchId,
          batchIndex
        });
      }
      repairPrompt = {
        ...prompt,
        messages: repair.messages,
        estimatedTokens: repair.estimatedInputTokens
      };
    }
    this.logger?.info?.({
      event: 'ai.analysis.memory.repair',
      sessionId: context.sessionId,
      jobId,
      batchIndex,
      targeted: onlyMissingRefs,
      errorCodes: errorsForRepair.slice(0, 8).map((item) => item.code)
    });
    const repaired = await this.requestOnce({
      context,
      prompt: repairPrompt,
      kind: 'memory-repair',
      batchIndex,
      stage,
      outputTokens: onlyMissingRefs
        ? Math.min(3000, budgetFor(repairPrompt))
        : outputBudget
    });
    this.#assertUsableOutput(repaired, {context, kind: 'memory-repair', batchIndex, stage});
    evaluated = evaluate(repaired.content);
    if (!evaluated.assembled.ok) {
      this.#recordOutputRejected(context, {
        code: (evaluated.validation.errors ?? [])[0]?.code ?? 'AI_IMPORT_INVALID',
        kind: 'memory-repair',
        batchIndex,
        stage,
        finishReason: repaired.finishReason ?? null
      });
      throw invalidAnswer(
        evaluated.validation.errors,
        'memory repair did not produce a complete compact answer'
      );
    }
    if (!evaluated.validation.ok) {
      this.#recordOutputRejected(context, {
        code: (evaluated.validation.errors ?? [])[0]?.code ?? 'AI_IMPORT_INVALID',
        kind: 'memory-repair',
        batchIndex,
        stage,
        finishReason: repaired.finishReason ?? null
      });
      // One repair is spent. Instead of discarding the whole batch, salvage the
      // viewers whose updates are complete and valid, and keep only the truly
      // invalid viewers for a later targeted resume.
      const salvaged = this.#salvageMemoryViewers(evaluated.assembled, evaluated.validation);
      if (salvaged) {
        this.logger?.warn?.({
          event: 'ai.analysis.memory.partial',
          sessionId: context.sessionId,
          jobId,
          batchIndex,
          validViewers: salvaged.viewerIds.length,
          failedViewers: salvaged.viewerFailures.length,
          errorCodes: salvaged.viewerFailures
            .flatMap((entry) => entry.errors)
            .slice(0, 8)
            .map((item) => item.code)
        });
        // One bounded viewer-scoped repair: only the rejected viewers and their
        // own evidence are sent. If it fails, the already validated viewers are
        // still imported and the rejected ones remain resumable.
        if (prompt.files && salvaged.viewerFailures.length > 0) {
          const failedIds = salvaged.viewerFailures.map((entry) => entry.viewerId);
          try {
            const targetedPrompt = buildMemoryPrompt(prompt.files, {viewerIds: failedIds});
            const targeted = await this.requestOnce({
              context,
              prompt: targetedPrompt,
              kind: 'memory-viewer-repair',
              batchIndex,
              stage,
              outputTokens: Math.min(4000, budgetFor(targetedPrompt))
            });
            this.#assertUsableOutput(targeted);
            const targetedEvaluation = evaluate(targeted.content, targetedPrompt);
            if (targetedEvaluation.validation.ok) {
              const recovered = targetedEvaluation.validation.sanitized.viewer_memory_updates ?? [];
              const merged = {
                ...evaluated.assembled.result,
                viewer_memory_updates: [...salvaged.validUpdates, ...recovered]
              };
              const mergedValidation = this.validate(JSON.stringify(merged), {
                viewerIds: promptViewerIds
              });
              if (mergedValidation.ok) {
                this.logger?.info?.({
                  event: 'ai.analysis.memory.viewer_repair',
                  sessionId: context.sessionId,
                  jobId,
                  batchIndex,
                  recoveredViewers: recovered.length
                });
                return {
                  ...targeted,
                  text: JSON.stringify(mergedValidation.sanitized),
                  viewerIds: promptViewerIds,
                  viewerFailures: []
                };
              }
            }
            this.logger?.warn?.({
              event: 'ai.analysis.memory.viewer_repair',
              sessionId: context.sessionId,
              jobId,
              batchIndex,
              recoveredViewers: 0,
              errorCodes: (targetedEvaluation.validation.errors ?? [])
                .slice(0, 8)
                .map((item) => item.code)
            });
          } catch (error) {
            if (context.signal?.aborted || isCanceledError(error)) throw error;
            this.logger?.warn?.({
              event: 'ai.analysis.memory.viewer_repair.failed',
              sessionId: context.sessionId,
              jobId,
              batchIndex,
              code: error?.code ?? 'UNKNOWN'
            });
          }
        }
        return {...repaired, ...salvaged};
      }
      throw invalidAnswer(evaluated.validation.errors, 'memory repair failed validation');
    }
    return {
      ...repaired,
      text: JSON.stringify(evaluated.validation.sanitized),
      viewerIds: promptViewerIds,
      viewerFailures: []
    };
  }

  /**
   * Split a repaired answer into valid and invalid viewers.
   *
   * This is deliberately strict: it only runs when every reported error is
   * scoped to one `viewer_memory_updates[i]` entry, the remaining subset passes
   * the same full validator again, and at least one viewer remains. Global
   * protocol/schema/coverage errors never fall back to partial import.
   */
  #salvageMemoryViewers(assembled, validation) {
    const updates = Array.isArray(assembled?.result?.viewer_memory_updates)
      ? assembled.result.viewer_memory_updates
      : [];
    const errors = Array.isArray(validation?.errors) ? validation.errors : [];
    if (updates.length === 0 || errors.length === 0) return null;
    const byIndex = new Map();
    for (const error of errors) {
      const match = /^viewer_memory_updates\[(\d+)\]/.exec(String(error?.path ?? ''));
      if (!match) return null; // global error: do not create a partial batch
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= updates.length) return null;
      const list = byIndex.get(index) ?? [];
      list.push(error);
      byIndex.set(index, list);
    }
    const validUpdates = updates.filter((_entry, index) => !byIndex.has(index));
    if (validUpdates.length === 0 || byIndex.size === 0) return null;
    const validViewerIds = validUpdates.map((entry) => entry.viewer_id).filter(Boolean);
    if (validViewerIds.length !== validUpdates.length) return null;
    const subset = {...assembled.result, viewer_memory_updates: validUpdates};
    const subsetValidation = this.validate(JSON.stringify(subset), {viewerIds: validViewerIds});
    if (!subsetValidation.ok) return null;
    const viewerFailures = [...byIndex.entries()].map(([index, viewerErrors]) => ({
      viewerId: updates[index]?.viewer_id ?? null,
      errors: viewerErrors.map((error) => ({
        path: error.path,
        code: error.code,
        params: error.params ?? null
      }))
    })).filter((entry) => entry.viewerId);
    if (viewerFailures.length === 0) return null;
    return {
      text: JSON.stringify(subsetValidation.sanitized),
      viewerIds: validViewerIds,
      viewerFailures,
      validUpdates
    };
  }

  #assertUsableOutput(generated, {context = null, kind = null, batchIndex = null, stage = null} = {}) {
    if (generated?.finishReason === 'length') {
      const error = Object.assign(new Error('OUTPUT_TRUNCATED'), {
        code: 'AUTO_OUTPUT_TRUNCATED',
        detail: 'finish-reason-length',
        kind: ERROR_KIND.INVALID_RESPONSE,
        finishReason: 'length'
      });
      if (context) {
        this.#recordOutputRejected(context, {
          code: error.code,
          kind,
          batchIndex,
          stage,
          finishReason: 'length'
        });
      }
      throw error;
    }
    if (looksDegenerate(generated?.content)) {
      const error = Object.assign(new Error('OUTPUT_DEGENERATED'), {
        code: 'AUTO_OUTPUT_DEGENERATED',
        detail: 'repeated-structure',
        kind: ERROR_KIND.INVALID_RESPONSE,
        finishReason: generated?.finishReason ?? null
      });
      if (context) {
        this.#recordOutputRejected(context, {
          code: error.code,
          kind,
          batchIndex,
          stage,
          finishReason: generated?.finishReason ?? null
        });
      }
      throw error;
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
    this.#assertUsableOutput(generated, {context, kind, batchIndex, stage});
    let evaluation = evaluateAnswer(generated.content, prompt);
    if (evaluation.ok) return {...generated, text: JSON.stringify(evaluation.sanitized)};
    this.#recordOutputRejected(context, {
      code: (evaluation.errors ?? [])[0]?.code ?? 'AUTO_SCHEMA_INVALID',
      kind,
      batchIndex,
      stage,
      finishReason: generated.finishReason ?? null
    });
    const repairLimit = this.#maxRequestInputTokens(context.provider, outputTokens);
    const repair = buildRepairMessages({
      prompt,
      previousText: generated.content,
      errors: evaluation.errors,
      locale: prompt.locale,
      maxInputTokens: repairLimit
    });
    if (repair.truncated) {
      this.logger?.warn?.({
        event: 'ai.repair.truncated',
        sessionId: context.sessionId,
        kind,
        batchIndex,
        previousChars: repair.previousChars,
        inputLimit: repairLimit
      });
    }
    if (repair.estimatedInputTokens > repairLimit) {
      throw Object.assign(new Error('REPAIR_TOO_LARGE'), {
        code: 'ANALYSIS_REPAIR_TOO_LARGE',
        detail: `estimated ${repair.estimatedInputTokens} input tokens, limit ${repairLimit}`,
        estimatedTokens: repair.estimatedInputTokens,
        limit: repairLimit
      });
    }
    generated = await this.requestOnce({
      context,
      prompt: {...prompt, messages: repair.messages, estimatedTokens: repair.estimatedInputTokens},
      kind: `${kind}-repair`,
      batchIndex,
      stage,
      outputTokens
    });
    this.#assertUsableOutput(generated, {context, kind, batchIndex, stage});
    evaluation = evaluateAnswer(generated.content, prompt);
    if (!evaluation.ok) {
      this.#recordOutputRejected(context, {
        code: (evaluation.errors ?? [])[0]?.code ?? 'AUTO_SCHEMA_INVALID',
        kind,
        batchIndex,
        stage,
        finishReason: generated.finishReason ?? null
      });
      throw Object.assign(new Error('SCHEMA_INVALID'), {
        code: 'AUTO_SCHEMA_INVALID',
        detail: (evaluation.errors ?? []).slice(0, 3)
          .map((error) => `${error.path || '(root)'}:${error.code}`)
          .join(', ') || 'validation failed',
        finishReason: generated.finishReason ?? null
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

  validate(text, options = {}) {
    try {
      return validateAnalysisImport({db: this.db, text, source: 'api', now: this.now(), ...options});
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
    const answerTokens = Math.max(256, Number(outputTokens) || 8000);
    const estimatedInputTokens = Math.max(0, Number(prompt?.estimatedTokens) || 0);
    const maxCompletionTokens = resolveMaxCompletionTokens({
      providerId: provider.providerId,
      answerTokens,
      estimatedInputTokens,
      contextLength: provider.contextLength
    });

    const maxAttempts = Math.min(3, Math.max(1, this.maxRetries + 1));
    let attempt = 0;
    let lastError = null;
    let fallbackUsed = false;
    while (attempt < maxAttempts) {
      if (signal.aborted) throw abortError();
      // The task deadline never shortens an attempt that has already started.
      // A single request is bounded only by its own header/idle timeout, so an
      // active stream can finish and be saved.
      const effectiveTimeout = provider.timeoutMs;
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
        stage: stage ?? this.#retryingStage(kind),
        model: provider.modelId,
        maxTokens: answerTokens,
        maxCompletionTokens,
        estimatedInputTokens
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
          maxTokens: answerTokens,
          maxCompletionTokens,
          responseSchema: prompt.answerSchema ?? null,
          responseFormat: prompt.answerSchema
            ? (provider.supportsStructuredOutputs ? 'json_schema' : 'json_object')
            : 'none',
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: effectiveTimeout,
          idleTimeoutMs: idleTimeout,
          streaming,
          now: this.now,
          onProgress: reportProgress
        }), {signal});
        const usage = result.usage ?? null;
        const entry = this.state.get(context.sessionId);
        if (usage) {
          // Attribute this request to the child job that actually owns it. The
          // previous code wrote the cumulative task total into the memory job as
          // soon as it existed, so session and memory both displayed a request
          // count and token total that included the other half.
          const targetJobId = jobIdForRequestKind(entry, kind);
          const usageByJob = {...(entry?.usageByJob ?? {})};
          let jobUsage = null;
          if (targetJobId) {
            jobUsage = addUsage(entry?.usageByJob?.[targetJobId], usage, provider.pricing);
            usageByJob[targetJobId] = jobUsage;
          }
          const totalUsage = sumUsageValues(Object.values(usageByJob)) ?? (entry?.usage ?? null);
          this.state.set(context.sessionId, {
            usage: totalUsage,
            usageByJob,
            usageAttribution: 'per_job',
            lastProvider: result.providerId,
            lastModel: result.model,
            lastRoutedProvider: result.routedProvider ?? null,
            responseMode: result.responseMode ?? mode
          });
          if (targetJobId && jobUsage) {
            setJobUsage(this.db, targetJobId, jobUsage, {now: this.now()});
          }
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
          metrics: result.metrics,
          model: result.model ?? provider.modelId,
          maxTokens: answerTokens,
          maxCompletionTokens,
          estimatedInputTokens,
          requestBytes: result.requestBytes ?? null,
          reasoningChars: result.reasoningChars ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? null,
          finishReason: result.finishReason ?? null
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
          model: provider.modelId,
          maxTokens: answerTokens,
          maxCompletionTokens,
          estimatedInputTokens,
          requestBytes: error?.requestBytes ?? null,
          reasoningChars: 0,
          ...extra
        }));
        if (canceled) {
          recordFailure();
          throw abortError();
        }
        const retry = shouldRetryAttempt(error, {
          attempt,
          maxRetries: this.maxRetries,
          random: this.random
        });
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
    if (error instanceof AnalysisPermissionError) return error;
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

  async resume(sessionId, {consent = false} = {}) {
    const entry = this.state.get(sessionId);
    if (!entry || !(entry.sessionJobId || entry.memoryJobId)) {
      throw new AnalysisPermissionError('NOTHING_TO_RESUME');
    }
    // Idempotent: a repeated Continue after the aggregate was saved must not
    // launch another task or create a second final result.
    if (this.getStatus(sessionId).status === 'complete') {
      return this.getStatus(sessionId);
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
    if (entry.mode !== ANALYSIS_MODE.SESSION && config.capabilities?.memory !== true) {
      throw new AnalysisPermissionError('MEMORY_CAPABILITY_REQUIRED');
    }
    const provider = providerFromConfig(config, {
      responseMode: this.state.getProviderMode(config.id)
    });
    this.state.set(sessionId, {status: 'running', stage: 'resuming', error: null});
    return this.launch({sessionId, provider, mode: entry.mode, resume: true});
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
