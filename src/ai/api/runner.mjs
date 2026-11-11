import {join} from 'node:path';
import {getJob, listJobBatches, setJobUsage} from '../../storage/repositories/ai-jobs.mjs';
import {listPackages} from '../../storage/repositories/ai-packages.mjs';
import {latestResultForScope} from '../../storage/repositories/ai-results.mjs';
import {computeJobStatus} from '../tasks/status.mjs';
import {validateAnalysisImport} from '../import/validate.mjs';
import {importAnalysisResult} from '../import/importer.mjs';
import {createSessionAnalysisJob, createViewerMemoryJob} from '../export/split-jobs.mjs';
import {promptVersionFor, ANALYSIS_MODE} from '../constants.mjs';
import {callProvider, ProviderHttpError, PROVIDER_ERROR} from '../providers/adapters.mjs';
import {assertSafeResolvedUrl} from '../providers/url-safety.mjs';
import {memoryPermission, addUsage, estimateCost, budgetRemaining} from '../providers/pricing.mjs';
import {PRICING_STATUS} from '../providers/catalog.mjs';
import {AutoAnalysisState} from '../auto/state.mjs';
import {extractJsonObject, sleepWithSignal} from '../auto/client.mjs';
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
  buildMemoryRefs
} from './compact.mjs';

/**
 * Configured-provider analysis runner.
 *
 * It supports four paths under one permission model:
 *   - anonymous free session analysis (the existing verified OVH route);
 *   - API-key free model session analysis;
 *   - paid model session analysis;
 *   - paid model long-term viewer memory analysis.
 *
 * Session and memory are separate jobs. The session report is imported as soon
 * as it succeeds. A memory failure never invalidates it; already imported memory
 * batches remain valid and are skipped on resume.
 */

const ANONYMOUS_PROVIDER = Object.freeze({
  id: 'anonymous-ovh',
  label: 'OVHcloud AI Endpoints',
  providerId: 'anonymous',
  protocol: 'openai',
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  modelId: 'gpt-oss-20b',
  supportsStructuredOutputs: true,
  timeoutMs: 300000,
  pricingStatus: PRICING_STATUS.ANONYMOUS_FREE,
  pricing: null
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
  const error = new Error('ANALYSIS_CANCELED');
  error.code = 'ANALYSIS_CANCELED';
  return error;
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
    timeoutMs: 180000,
    pricingStatus: config.pricingStatus,
    pricing: config.pricing,
    allowLocalNetwork: config.allowLocalNetwork === true,
    contextLength: config.contextLength ?? null,
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

export class AnalysisRunner {
  constructor({
    db,
    paths,
    configStore,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    anonymousProvider = ANONYMOUS_PROVIDER,
    maxRetries = 1
  }) {
    this.db = db;
    this.paths = paths;
    this.configStore = configStore;
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.anonymousProvider = anonymousProvider;
    this.maxRetries = maxRetries;
    this.active = new Map();
    const runtimeDir = paths.runtime ?? join(paths.root, 'runtime');
    this.state = new AutoAnalysisState({runtimeDir, now, fileName: 'ai-v13.json'});
    this.state.recoverInterrupted();
  }

  services() {
    return {
      anonymous: [{
        id: this.anonymousProvider.id,
        label: this.anonymousProvider.label,
        model: this.anonymousProvider.modelId,
        pricingStatus: PRICING_STATUS.ANONYMOUS_FREE
      }],
      configured: this.configStore.list()
    };
  }

  #checkProvider({mode, configId, consent, confirmBilling, optInMemory}) {
    if (consent !== true) throw new AnalysisPermissionError('CONSENT_REQUIRED');
    if (!configId) {
      if (mode !== ANALYSIS_MODE.SESSION) {
        throw new AnalysisPermissionError('PAID_MODEL_REQUIRED');
      }
      return {provider: this.anonymousProvider, config: null, anonymous: true};
    }
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
    if (config.pricingStatus !== PRICING_STATUS.ANONYMOUS_FREE
      && config.pricingStatus !== PRICING_STATUS.API_FREE
      && confirmBilling !== true) {
      throw new AnalysisPermissionError('SPEND_CONFIRMATION_REQUIRED');
    }
    return {provider: providerFromConfig(config), config, anonymous: false};
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
      usage: null,
      budget: budget ?? null,
      error: null,
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
        canCancel: false,
        services: this.services()
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
    const memoryDone = !entry.memoryJobId
      ? entry.mode === ANALYSIS_MODE.SESSION
      : Boolean(memoryStatus?.complete);
    if (status === 'running' && sessionReportDone && (memoryDone || !entry.memoryJobId)) {
      // Do not mark complete while a memory job exists but is not ready.
    }
    return {
      sessionId,
      status,
      stage,
      running: status === 'running',
      canPause: status === 'running' && Boolean(active),
      canResume: status !== 'complete' && Boolean(sessionJob || memoryJob),
      canCancel: status === 'running' && Boolean(active),
      mode: entry.mode ?? ANALYSIS_MODE.SESSION,
      configId: entry.configId ?? null,
      providerName: entry.providerName ?? null,
      providerId: entry.providerId ?? null,
      modelId: entry.modelId ?? null,
      pricingStatus: entry.pricingStatus ?? null,
      batchIndex: Number(entry.batchIndex ?? 0),
      batchTotal: Number(entry.batchTotal ?? memoryStatus?.batchTotal ?? 0),
      sessionReportDone,
      memoryDone,
      sessionJobId: entry.sessionJobId ?? null,
      memoryJobId: entry.memoryJobId ?? null,
      sessionJob: sessionStatus,
      memoryJob: memoryStatus,
      usage: entry.usage ?? null,
      budget: entry.budget ?? null,
      estimatedCost: entry.estimatedCost ?? null,
      lastProvider: entry.lastProvider ?? null,
      lastModel: entry.lastModel ?? null,
      updatedAt: entry.updatedAt ?? null,
      error,
      services: this.services()
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
        await this.runMemory(context);
      }
      const entry = this.state.get(sessionId);
      this.state.set(sessionId, {
        status: 'complete',
        stage: 'complete',
        error: null,
        completedAt: this.now(),
        sessionReportDone: entry?.sessionReportDone === true,
        memoryDone: entry?.memoryJobId ? true : entry?.mode === ANALYSIS_MODE.SESSION
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
      httpStatus: error?.status ?? null
    });
  }

  async runSession(context) {
    const {sessionId, provider} = context;
    let entry = this.state.get(sessionId);
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
    const pkg = listPackages(this.db, {jobId: job.id}).find((row) => row.stage === 'session');
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
      batchIndex: 1,
      batchTotal: 1,
      estimatedCost: estimate
    });
    if (context.budget && estimate
      && context.budget.currency === estimate.currency
      && estimate.amount > context.budget.amount) {
      throw Object.assign(new Error('BUDGET_EXCEEDED'), {code: 'ANALYSIS_BUDGET_EXCEEDED'});
    }
    const generated = await this.requestWithRepair({
      context,
      prompt,
      kind: 'session'
    });
    this.state.set(sessionId, {stage: 'session_importing'});
    const outcome = importAnalysisResult({
      db: this.db,
      text: generated.text,
      source: generated.anonymous ? 'auto' : 'api',
      now: this.now()
    });
    this.state.set(sessionId, {
      sessionReportDone: true,
      stage: 'session_done',
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

  async runMemory(context) {
    const {sessionId, provider, signal} = context;
    let entry = this.state.get(sessionId);
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
        maxBatches: 30,
        providerConfigId: provider.configId ?? null,
        providerId: provider.providerId,
        regionId: provider.regionId ?? null,
        modelId: provider.modelId,
        pricingStatus: provider.pricingStatus,
        budget: context.budget,
        costEstimate: null,
        now: this.now()
      });
      if (!created) throw Object.assign(new Error('MEMORY_NO_VIEWERS'), {code: 'ANALYSIS_MEMORY_EMPTY'});
      job = getJob(this.db, created.job.id);
      this.state.set(sessionId, {
        memoryJobId: job.id,
        batchTotal: job.batchTotal,
        stage: 'memory_ready'
      });
    }
    const batches = listJobBatches(this.db, job.id);
    for (const batch of batches) {
      if (signal.aborted) throw abortError();
      const existing = latestResultForScope(this.db, job.id, `batch:${batch.batchIndex}`);
      if (existing) continue;
      const pkg = listPackages(this.db, {jobId: job.id}).find((row) => (
        row.stage === 'memory' && Number(row.batch_index) === batch.batchIndex
      ));
      if (!pkg) throw Object.assign(new Error('PACKAGE_MISSING'), {code: 'ANALYSIS_PACKAGE_MISSING'});
      const files = readAnalysisPackage(join(this.paths.exports, pkg.file_name), MEMORY_FILES);
      const prompt = buildMemoryPrompt(files);
      prompt.files = files;
      this.#setRunning(sessionId, {
        stage: 'memory_analyzing',
        batchIndex: batch.batchIndex,
        batchTotal: job.batchTotal
      });
      const generated = await this.generateMemoryAnswer({context, prompt, kind: 'memory'});
      this.state.set(sessionId, {
        stage: 'memory_importing',
        batchIndex: batch.batchIndex,
        batchTotal: job.batchTotal,
        lastProvider: generated.providerId,
        lastModel: generated.model
      });
      const outcome = importAnalysisResult({
        db: this.db,
        text: generated.text,
        source: generated.anonymous ? 'auto' : 'api',
        now: this.now()
      });
      const updated = getJob(this.db, job.id);
      this.state.set(sessionId, {
        stage: 'memory_batch_done',
        batchIndex: batch.batchIndex,
        batchTotal: job.batchTotal,
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
        duplicate: outcome.duplicate
      });
    }
    this.state.set(sessionId, {memoryDone: true, stage: 'memory_done'});
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
    let validation = this.validate(generated.content);
    if (validation.ok) return {...generated, text: JSON.stringify(validation.sanitized)};
    const repair = buildRepairMessages({
      prompt,
      previousText: generated.content,
      errors: validation.errors,
      locale: prompt.locale
    });
    generated = await this.requestOnce({context, prompt: {...prompt, messages: repair.messages}, kind: `${kind}-repair`});
    validation = this.validate(generated.content);
    if (!validation.ok) {
      throw Object.assign(new Error('SCHEMA_INVALID'), {
        code: 'AUTO_SCHEMA_INVALID',
        detail: (validation.errors ?? []).slice(0, 3)
          .map((error) => `${error.path || '(root)'}:${error.code}`)
          .join(', ') || 'validation failed'
      });
    }
    return {...generated, text: JSON.stringify(validation.sanitized)};
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
    const startedAt = this.now();
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal.aborted) throw abortError();
      try {
        await assertSafeResolvedUrl(provider.baseUrl, {
          allowLocalNetwork: provider.allowLocalNetwork === true
        });
      } catch (error) {
        throw Object.assign(new Error(error?.code ?? 'PROVIDER_URL_BLOCKED'), {
          code: error?.code ?? 'PROVIDER_URL_BLOCKED',
          detail: 'base-url-rejected'
        });
      }
      try {
        const result = await callProvider(provider, {
          apiKey: provider.configId ? this.configStore.secret(provider.configId) : null,
          messages: prompt.messages,
          maxTokens: kind.startsWith('session') ? 8000 : 6000,
          responseSchema: prompt.answerSchema ?? null,
          responseFormat: prompt.answerSchema ? (provider.supportsStructuredOutputs ? 'json_schema' : 'json_object') : 'none',
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: provider.timeoutMs ?? 180000
        });
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
          durationMs: this.now() - startedAt,
          anonymous: !provider.configId
        };
      } catch (error) {
        lastError = error;
        if (error?.code === 'ANALYSIS_BUDGET_EXCEEDED') throw error;
        if (attempt >= this.maxRetries || !(error instanceof ProviderHttpError) || !error.retryable) {
          throw Object.assign(new Error(error?.code ?? 'PROVIDER_FAILED'), {
            code: error?.code ?? 'PROVIDER_FAILED',
            detail: error?.detail ?? error?.message,
            status: error?.status ?? null
          });
        }
        await sleepWithSignal(Math.min(4000, 1200 * (attempt + 1)), signal);
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
    if (entry.configId && !config) throw new AnalysisPermissionError('PROVIDER_CONFIG_NOT_FOUND');
    if (config && entry.mode !== ANALYSIS_MODE.SESSION) {
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
    if (config && config.pricingStatus !== PRICING_STATUS.API_FREE && confirmBilling !== true) {
      throw new AnalysisPermissionError('SPEND_CONFIRMATION_REQUIRED');
    }
    const provider = config ? providerFromConfig(config) : this.anonymousProvider;
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

export {ANONYMOUS_PROVIDER, PROVIDER_ERROR};
