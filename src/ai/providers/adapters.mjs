import {joinUrl, assertSafeResolvedUrl} from './url-safety.mjs';
import {getProvider} from './catalog.mjs';
import {perMillionFromTokenPrice, pricingFromOpenRouterModel} from './pricing.mjs';
import {parseRetryAfter} from '../runtime/json.mjs';
import {consumeEventStream, createStreamAccumulator, StreamIdleTimeoutError} from '../runtime/stream.mjs';
import {ERROR_KIND, ATTEMPT_PHASE} from '../runtime/attempt.mjs';

/**
 * Low-level provider transport.
 *
 * One adapter interface, two protocol families:
 *   - OpenAI Chat Completions (OpenAI, DeepSeek, MiniMax, DashScope, OpenRouter,
 *     custom OpenAI-compatible);
 *   - Anthropic Messages.
 *
 * Streaming is chosen automatically by the caller. When a provider supports SSE
 * the answer is buffered here and returned as finished text; if the provider
 * ignores `stream` and returns JSON, that JSON is accepted as a normal answer
 * instead of being treated as an error. Nothing is written to the database by
 * this module.
 *
 * Timeouts are split into:
 *   - header timeout: no response headers within `timeoutMs`;
 *   - idle timeout: streaming started but no bytes for `idleTimeoutMs`;
 *   - total attempt cap: the remaining task budget (`maxTotalMs`).
 * A timeout is never reported as a generic network failure, and an external
 * abort (pause/cancel/shutdown) is never reported as a timeout.
 */

export class ProviderHttpError extends Error {
  constructor(code, {
    status = null,
    detail = null,
    retryable = false,
    providerId = null,
    cause = null,
    retryAfterMs = null,
    kind = null,
    phase = null,
    receivedHeaders = false,
    receivedOutput = false,
    elapsedMs = null,
    timeoutMs = null,
    metrics = null
  } = {}) {
    super(code);
    this.name = 'ProviderHttpError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
    this.providerId = providerId;
    this.cause = cause;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
    this.phase = phase;
    this.receivedHeaders = receivedHeaders === true;
    this.receivedOutput = receivedOutput === true;
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
    this.metrics = metrics;
  }
}

export const PROVIDER_ERROR = Object.freeze({
  AUTH: 'PROVIDER_AUTH_FAILED',
  NETWORK: 'PROVIDER_NETWORK_FAILED',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  RATE_LIMIT: 'PROVIDER_RATE_LIMITED',
  NOT_FOUND: 'PROVIDER_ENDPOINT_NOT_FOUND',
  HTTP: 'PROVIDER_HTTP_ERROR',
  FORMAT: 'PROVIDER_RESPONSE_INVALID',
  STREAM_INTERRUPTED: 'PROVIDER_STREAM_INTERRUPTED',
  STREAM_ERROR: 'PROVIDER_STREAM_ERROR',
  CONFIG: 'PROVIDER_CONFIG_INVALID',
  CANCELED: 'ANALYSIS_CANCELED'
});

function contentFromOpenAI(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

function finishFromOpenAI(payload) {
  const reason = payload?.choices?.[0]?.finish_reason ?? null;
  return reason === 'max_tokens' ? 'length' : reason;
}

/**
 * Count (never store) reasoning text. DashScope returns thinking in
 * `reasoning_content`; keeping only the length makes the default thinking mode
 * observable in the attempt log without ever persisting model reasoning.
 */
export function reasoningCharsFromPayload(payload) {
  const reasoning = payload?.choices?.[0]?.message?.reasoning_content;
  return typeof reasoning === 'string' ? reasoning.length : 0;
}

export function normalizeUsage(payload) {
  const usage = payload?.usage ?? {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const reasoning = Number(
    usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens
    ?? 0
  );
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    reasoningTokens: Number.isFinite(reasoning) ? reasoning : 0,
    totalTokens: Number(usage.total_tokens ?? (input + output)) || 0,
    raw: {
      input_tokens: Number.isFinite(input) ? input : 0,
      output_tokens: Number.isFinite(output) ? output : 0,
      reasoning_tokens: Number.isFinite(reasoning) ? reasoning : 0
    }
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFromResponse(response, payload, providerId) {
  const status = response.status;
  const type = payload?.error?.type ?? payload?.error?.code ?? payload?.type ?? null;
  const detail = String(payload?.error?.message ?? payload?.message ?? '').slice(0, 300) || null;
  const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
  const base = {
    status,
    detail,
    providerId,
    retryAfterMs,
    receivedHeaders: true,
    phase: ATTEMPT_PHASE.HEADERS
  };
  if (status === 401 || status === 403) {
    return new ProviderHttpError(PROVIDER_ERROR.AUTH, {...base, kind: ERROR_KIND.CLIENT});
  }
  if (status === 404) {
    return new ProviderHttpError(PROVIDER_ERROR.NOT_FOUND, {...base, kind: ERROR_KIND.CLIENT});
  }
  if (status === 429) {
    return new ProviderHttpError(PROVIDER_ERROR.RATE_LIMIT, {
      ...base,
      kind: ERROR_KIND.RATE_LIMIT,
      retryable: true
    });
  }
  return new ProviderHttpError(PROVIDER_ERROR.HTTP, {
    ...base,
    detail: type && detail ? `${type}: ${detail}` : detail,
    kind: status >= 500 || status === 408 || status === 425
      ? ERROR_KIND.SERVER
      : ERROR_KIND.CLIENT,
    retryable: status >= 500 || status === 408 || status === 425
  });
}

function cancelError(providerId, extra = {}) {
  return new ProviderHttpError(PROVIDER_ERROR.CANCELED, {
    detail: 'request-canceled',
    providerId,
    kind: ERROR_KIND.CANCELED,
    retryable: false,
    ...extra
  });
}

/**
 * Compose an abort controller from the caller's signal plus timers. The flags
 * are essential: an `AbortError` may mean "the user canceled", "no headers in
 * time" or "the task budget ran out", and those must never share one error code.
 */
function createRequestControl({
  externalSignal = null,
  headerTimeoutMs = 180000,
  maxTotalMs = null
}) {
  const controller = new AbortController();
  const flags = {
    externalAborted: false,
    headerTimedOut: false,
    totalTimedOut: false,
    headersReceived: false
  };
  const onExternalAbort = () => {
    flags.externalAborted = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      flags.externalAborted = true;
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, {once: true});
    }
  }
  const headerTimer = setTimeout(() => {
    if (flags.headersReceived) return;
    flags.headerTimedOut = true;
    controller.abort();
  }, Math.max(1000, Number(headerTimeoutMs) || 180000));
  headerTimer.unref?.();
  let totalTimer = null;
  if (Number.isFinite(Number(maxTotalMs)) && Number(maxTotalMs) > 0) {
    totalTimer = setTimeout(() => {
      flags.totalTimedOut = true;
      controller.abort();
    }, Math.max(1000, Number(maxTotalMs)));
    totalTimer.unref?.();
  }
  return {
    controller,
    flags,
    signal: controller.signal,
    markHeaders() {
      flags.headersReceived = true;
      clearTimeout(headerTimer);
    },
    cleanup() {
      clearTimeout(headerTimer);
      if (totalTimer) clearTimeout(totalTimer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    }
  };
}

function transportError(error, {
  providerId,
  control,
  startedAt,
  now,
  timeoutMs,
  metrics = null
}) {
  const elapsedMs = Math.max(0, now() - startedAt);
  const phase = control.flags.headersReceived ? ATTEMPT_PHASE.BODY : ATTEMPT_PHASE.HEADERS;
  if (control.flags.externalAborted) {
    return cancelError(providerId, {elapsedMs, metrics});
  }
  if (control.flags.headerTimedOut || control.flags.totalTimedOut
    || error?.name === 'TimeoutError') {
    return new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
      detail: control.flags.totalTimedOut ? 'attempt-budget-exhausted' : 'response-timeout',
      retryable: false,
      providerId,
      cause: error,
      kind: ERROR_KIND.TIMEOUT,
      phase: control.flags.headersReceived ? ATTEMPT_PHASE.STREAM : ATTEMPT_PHASE.HEADERS,
      receivedHeaders: control.flags.headersReceived,
      elapsedMs,
      timeoutMs,
      metrics
    });
  }
  const causeCode = String(error?.cause?.code ?? error?.code ?? error?.name ?? 'network-error').slice(0, 120);
  // A connection that never opened is safe to retry once. A connection reset
  // after the request was written may already have executed on the server, so it
  // is reported without automatic resend.
  const safeToRetry = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']
    .includes(causeCode);
  return new ProviderHttpError(PROVIDER_ERROR.NETWORK, {
    detail: causeCode,
    retryable: safeToRetry,
    providerId,
    cause: error,
    kind: ERROR_KIND.NETWORK,
    phase,
    receivedHeaders: control.flags.headersReceived,
    elapsedMs,
    timeoutMs,
    metrics
  });
}

function streamErrorMessage(providerId, message, metrics) {
  return new ProviderHttpError(PROVIDER_ERROR.STREAM_ERROR, {
    detail: String(message ?? 'stream-error').slice(0, 300),
    providerId,
    kind: ERROR_KIND.INVALID_RESPONSE,
    retryable: false,
    receivedHeaders: true,
    receivedOutput: true,
    phase: ATTEMPT_PHASE.STREAM,
    metrics
  });
}

function streamInterruptedError(providerId, detail, metrics) {
  return new ProviderHttpError(PROVIDER_ERROR.STREAM_INTERRUPTED, {
    detail,
    providerId,
    kind: ERROR_KIND.STREAM_INTERRUPTED,
    retryable: false,
    receivedHeaders: true,
    receivedOutput: true,
    phase: ATTEMPT_PHASE.STREAM,
    metrics
  });
}

function timeoutFromIdle(error, {providerId, control, startedAt, now, timeoutMs, metrics}) {
  if (control.flags.externalAborted) return cancelError(providerId, {metrics});
  return new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
    detail: 'stream-idle-timeout',
    retryable: false,
    providerId,
    cause: error,
    kind: ERROR_KIND.TIMEOUT,
    phase: ATTEMPT_PHASE.STREAM,
    receivedHeaders: true,
    receivedOutput: true,
    elapsedMs: Math.max(0, now() - startedAt),
    timeoutMs,
    metrics
  });
}

/* -------------------------------------------------------------- OpenAI family */

const STREAM_USAGE_PROVIDERS = new Set(['openai', 'deepseek', 'openrouter', 'dashscope']);

function openAiStreamOptions(config) {
  // `stream_options` is an OpenAI extension. Sending it to an unknown
  // OpenAI-compatible server can turn a working stream into a 400, so it is
  // only added for providers known to accept it. Without it, usage may be
  // absent — the caller then reports "usage unknown", never zero cost.
  return STREAM_USAGE_PROVIDERS.has(config.providerId)
    ? {include_usage: true}
    : null;
}

/**
 * OpenAI-compatible request.
 * `responseFormat` values: 'json_schema' | 'json_object' | 'none'.
 * `streaming` is chosen by the runner; `false` keeps the legacy JSON path.
 */
export async function callOpenAICompatible({
  config,
  apiKey,
  messages,
  maxTokens = 4096,
  maxCompletionTokens = null,
  responseSchema = null,
  responseFormat = 'json_schema',
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 180000,
  idleTimeoutMs = 60000,
  maxTotalMs = null,
  streaming = false,
  now = Date.now,
  onProgress = null,
  headers = {}
}) {
  const provider = getProvider(config.providerId);
  if (!provider && config.protocol !== 'openai') {
    throw new ProviderHttpError(PROVIDER_ERROR.CONFIG, {
      providerId: config.providerId,
      kind: ERROR_KIND.CONFIG
    });
  }
  const auth = apiKey ? {authorization: `Bearer ${apiKey}`} : {};
  const body = {
    model: config.modelId,
    messages,
    max_tokens: Math.max(64, Math.min(Number(maxTokens) || 4096, 32000)),
    temperature: 0
  };
  // DashScope models that support thinking treat `max_tokens` as the answer
  // limit only; Chain-of-Thought is billed separately and its default can be
  // very large. `max_completion_tokens` bounds the whole output. It is sent only
  // where the provider documents support, so other OpenAI-compatible endpoints
  // never receive an unknown parameter.
  const completionLimit = Number(maxCompletionTokens);
  if (Number.isFinite(completionLimit) && completionLimit > 0 && config.providerId === 'dashscope') {
    body.max_completion_tokens = Math.max(
      body.max_tokens,
      Math.min(Math.floor(completionLimit), 96000)
    );
  }
  const structured = responseSchema && responseFormat !== 'none';
  if (structured && responseFormat === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {name: 'livememory_result', schema: responseSchema, strict: false}
    };
  } else if (structured) {
    body.response_format = {type: 'json_object'};
  }
  if (streaming) {
    body.stream = true;
    const streamOptions = openAiStreamOptions(config);
    if (streamOptions) body.stream_options = streamOptions;
  }
  // OpenRouter recommends attribution headers; they contain no local path or key.
  if (config.providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/zgrg29/LiveMemory';
    headers['X-Title'] = 'LiveMemory';
  }

  const startedAt = now();
  const bodyText = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(bodyText, 'utf8');
  const control = createRequestControl({externalSignal: signal, headerTimeoutMs: timeoutMs, maxTotalMs});
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream, application/json' : 'application/json',
        ...auth,
        ...headers
      },
      body: bodyText,
      signal: control.signal
    });
  } catch (error) {
    control.cleanup();
    const failure = transportError(error, {
      providerId: config.providerId,
      control,
      startedAt,
      now,
      timeoutMs
    });
    failure.requestBytes = requestBytes;
    throw failure;
  }
  const headersAt = now();
  control.markHeaders();
  onProgress?.({receivedHeaders: true, headersAt});
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  const isEventStream = contentType.includes('text/event-stream');

  if (!response.ok) {
    const payload = await safeJson(response);
    control.cleanup();
    const failure = errorFromResponse(response, payload, config.providerId);
    failure.elapsedMs = now() - startedAt;
    failure.requestBytes = requestBytes;
    throw failure;
  }

  if (streaming && isEventStream) {
    const accumulator = createStreamAccumulator({protocol: 'openai'});
    let reportedOutput = false;
    const reportOutput = () => {
      if (reportedOutput || accumulator.state.text.length === 0) return;
      reportedOutput = true;
      onProgress?.({receivedOutput: true, firstTokenAt: now()});
    };
    let streamMetrics;
    try {
      streamMetrics = await consumeEventStream(response, {
        signal,
        idleTimeoutMs,
        now,
        abort: () => control.controller.abort(),
        onEvent: (event, data) => {
          accumulator.add(event, data);
          reportOutput();
        }
      });
    } catch (error) {
      control.cleanup();
      const partial = error?.name === 'StreamIdleTimeoutError';
      if (partial) {
        throw timeoutFromIdle(error, {
          providerId: config.providerId,
          control,
          startedAt,
          now,
          timeoutMs,
          metrics: {mode: 'streaming', startedAt, headersAt}
        });
      }
      if (control.flags.externalAborted) throw cancelError(config.providerId);
      if (control.flags.totalTimedOut) {
        throw new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
          detail: 'attempt-budget-exhausted',
          retryable: false,
          providerId: config.providerId,
          kind: ERROR_KIND.TIMEOUT,
          phase: ATTEMPT_PHASE.STREAM,
          receivedHeaders: true,
          receivedOutput: true,
          elapsedMs: now() - startedAt,
          timeoutMs
        });
      }
      if (error instanceof StreamIdleTimeoutError) {
        throw timeoutFromIdle(error, {
          providerId: config.providerId,
          control,
          startedAt,
          now,
          timeoutMs,
          metrics: {mode: 'streaming', startedAt, headersAt}
        });
      }
      throw new ProviderHttpError(PROVIDER_ERROR.STREAM_INTERRUPTED, {
        detail: String(error?.code ?? error?.name ?? 'stream-read-failed').slice(0, 120),
        retryable: false,
        providerId: config.providerId,
        cause: error,
        kind: ERROR_KIND.STREAM_INTERRUPTED,
        phase: ATTEMPT_PHASE.STREAM,
        receivedHeaders: true,
        receivedOutput: true,
        elapsedMs: now() - startedAt,
        metrics: {mode: 'streaming', startedAt, headersAt}
      });
    }
    control.cleanup();
    const result = accumulator.result();
    const finishedAt = now();
    const metrics = {
      ...streamMetrics,
      mode: 'streaming',
      startedAt,
      headersAt,
      finishedAt,
      timeToHeadersMs: headersAt - startedAt,
      timeToFirstTokenMs: streamMetrics.firstEventAt === null
        ? null
        : streamMetrics.firstEventAt - startedAt,
      receivedHeaders: true
    };
    if (result.error) {
      throw streamErrorMessage(
        config.providerId,
        result.error.message ?? result.error.type ?? result.error.code,
        metrics
      );
    }
    if (!result.finishReason && !result.done) {
      throw streamInterruptedError(config.providerId, 'stream-ended-without-finish', metrics);
    }
    const text = result.text;
    if (!text) {
      throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
        status: response.status,
        detail: 'empty-content',
        providerId: config.providerId,
        kind: ERROR_KIND.INVALID_RESPONSE,
        receivedHeaders: true,
        phase: ATTEMPT_PHASE.STREAM,
        metrics
      });
    }
    return {
      text,
      providerId: config.providerId,
      model: result.model ?? config.modelId,
      usage: normalizeUsage({usage: result.usage}),
      finishReason: result.finishReason,
      responseFormat,
      responseMode: 'streaming',
      routedProvider: result.routedProvider ?? null,
      rawCost: result.usage?.cost ?? null,
      reasoningChars: result.reasoningChars ?? 0,
      requestBytes,
      metrics,
      raw: null
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    control.cleanup();
    if (control.flags.externalAborted) throw cancelError(config.providerId);
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'invalid-json-body',
      providerId: config.providerId,
      cause: error,
      kind: ERROR_KIND.INVALID_RESPONSE,
      receivedHeaders: true,
      phase: ATTEMPT_PHASE.BODY,
      elapsedMs: now() - startedAt,
      metrics: {mode: streaming ? 'streaming-ignored' : 'non_streaming', startedAt, headersAt}
    });
  }
  control.cleanup();
  const finishedAt = now();
  const metrics = {
    mode: streaming ? 'non_streaming_fallback' : 'non_streaming',
    startedAt,
    headersAt,
    finishedAt,
    timeToHeadersMs: headersAt - startedAt,
    timeToFirstByteMs: headersAt - startedAt,
    streamDurationMs: finishedAt - headersAt,
    totalMs: finishedAt - startedAt,
    receivedHeaders: true
  };
  const text = contentFromOpenAI(payload).trim();
  if (!text) {
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'empty-content',
      providerId: config.providerId,
      kind: ERROR_KIND.INVALID_RESPONSE,
      receivedHeaders: true,
      metrics
    });
  }
  onProgress?.({receivedOutput: true, firstTokenAt: finishedAt});
  return {
    text,
    providerId: config.providerId,
    model: payload?.model ?? config.modelId,
    usage: normalizeUsage(payload),
    finishReason: finishFromOpenAI(payload),
    responseFormat,
    responseMode: 'non_streaming',
    routedProvider: payload?.provider ?? null,
    rawCost: payload?.usage?.cost ?? null,
    reasoningChars: reasoningCharsFromPayload(payload),
    requestBytes,
    metrics,
    raw: null
  };
}

/* ------------------------------------------------------------ Anthropic family */

export async function callAnthropic({
  config,
  apiKey,
  messages,
  maxTokens = 4096,
  responseSchema = null,
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 180000,
  idleTimeoutMs = 60000,
  maxTotalMs = null,
  streaming = false,
  now = Date.now,
  onProgress = null
}) {
  if (!apiKey) {
    throw new ProviderHttpError(PROVIDER_ERROR.CONFIG, {
      detail: 'api-key-required',
      providerId: config.providerId,
      kind: ERROR_KIND.CONFIG
    });
  }
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content ?? ''))
    .join('\n\n');
  const turns = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content ?? '')
    }));
  const body = {
    model: config.modelId,
    max_tokens: Math.max(64, Math.min(Number(maxTokens) || 4096, 32000)),
    temperature: 0,
    system,
    messages: turns.length > 0 ? turns : [{role: 'user', content: 'Return a JSON object.'}]
  };
  if (streaming) body.stream = true;
  // Anthropic Messages has no portable json_schema parameter across models;
  // the prompt builder includes the schema and asks for JSON only.
  const startedAt = now();
  const bodyText = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(bodyText, 'utf8');
  const control = createRequestControl({externalSignal: signal, headerTimeoutMs: timeoutMs, maxTotalMs});
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream, application/json' : 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': getProvider('anthropic')?.anthropicVersion ?? '2023-06-01'
      },
      body: bodyText,
      signal: control.signal
    });
  } catch (error) {
    control.cleanup();
    const failure = transportError(error, {
      providerId: config.providerId,
      control,
      startedAt,
      now,
      timeoutMs
    });
    failure.requestBytes = requestBytes;
    throw failure;
  }
  const headersAt = now();
  control.markHeaders();
  onProgress?.({receivedHeaders: true, headersAt});
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  const isEventStream = contentType.includes('text/event-stream');

  if (!response.ok) {
    const payload = await safeJson(response);
    control.cleanup();
    const failure = errorFromResponse(response, payload, config.providerId);
    failure.elapsedMs = now() - startedAt;
    failure.requestBytes = requestBytes;
    throw failure;
  }

  if (streaming && isEventStream) {
    const accumulator = createStreamAccumulator({protocol: 'anthropic'});
    let reportedOutput = false;
    const reportOutput = () => {
      if (reportedOutput || accumulator.state.text.length === 0) return;
      reportedOutput = true;
      onProgress?.({receivedOutput: true, firstTokenAt: now()});
    };
    let streamMetrics;
    try {
      streamMetrics = await consumeEventStream(response, {
        signal,
        idleTimeoutMs,
        now,
        abort: () => control.controller.abort(),
        onEvent: (event, data) => {
          accumulator.add(event, data);
          reportOutput();
        }
      });
    } catch (error) {
      control.cleanup();
      if (error instanceof StreamIdleTimeoutError) {
        throw timeoutFromIdle(error, {
          providerId: config.providerId,
          control,
          startedAt,
          now,
          timeoutMs,
          metrics: {mode: 'streaming', startedAt, headersAt}
        });
      }
      if (control.flags.externalAborted) throw cancelError(config.providerId);
      if (control.flags.totalTimedOut) {
        throw new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
          detail: 'attempt-budget-exhausted',
          retryable: false,
          providerId: config.providerId,
          kind: ERROR_KIND.TIMEOUT,
          phase: ATTEMPT_PHASE.STREAM,
          receivedHeaders: true,
          receivedOutput: true,
          elapsedMs: now() - startedAt,
          timeoutMs
        });
      }
      throw new ProviderHttpError(PROVIDER_ERROR.STREAM_INTERRUPTED, {
        detail: String(error?.code ?? error?.name ?? 'stream-read-failed').slice(0, 120),
        retryable: false,
        providerId: config.providerId,
        cause: error,
        kind: ERROR_KIND.STREAM_INTERRUPTED,
        phase: ATTEMPT_PHASE.STREAM,
        receivedHeaders: true,
        receivedOutput: true,
        elapsedMs: now() - startedAt,
        metrics: {mode: 'streaming', startedAt, headersAt}
      });
    }
    control.cleanup();
    const result = accumulator.result();
    const finishedAt = now();
    const metrics = {
      ...streamMetrics,
      mode: 'streaming',
      startedAt,
      headersAt,
      finishedAt,
      timeToHeadersMs: headersAt - startedAt,
      timeToFirstTokenMs: streamMetrics.firstEventAt === null
        ? null
        : streamMetrics.firstEventAt - startedAt,
      receivedHeaders: true
    };
    if (result.error) {
      throw streamErrorMessage(
        config.providerId,
        result.error.message ?? result.error.type ?? result.error.code,
        metrics
      );
    }
    if (!result.finishReason && !result.done) {
      throw streamInterruptedError(config.providerId, 'stream-ended-without-finish', metrics);
    }
    if (!result.text) {
      throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
        status: response.status,
        detail: 'empty-content',
        providerId: config.providerId,
        kind: ERROR_KIND.INVALID_RESPONSE,
        receivedHeaders: true,
        phase: ATTEMPT_PHASE.STREAM,
        metrics
      });
    }
    return {
      text: result.text,
      providerId: config.providerId,
      model: result.model ?? config.modelId,
      usage: normalizeUsage({usage: result.usage}),
      finishReason: result.finishReason,
      responseFormat: 'prompt',
      responseMode: 'streaming',
      routedProvider: null,
      rawCost: null,
      reasoningChars: result.reasoningChars ?? 0,
      requestBytes,
      metrics,
      raw: null
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    control.cleanup();
    if (control.flags.externalAborted) throw cancelError(config.providerId);
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'invalid-json-body',
      providerId: config.providerId,
      cause: error,
      kind: ERROR_KIND.INVALID_RESPONSE,
      receivedHeaders: true,
      phase: ATTEMPT_PHASE.BODY,
      elapsedMs: now() - startedAt,
      metrics: {mode: streaming ? 'streaming-ignored' : 'non_streaming', startedAt, headersAt}
    });
  }
  control.cleanup();
  const finishedAt = now();
  const metrics = {
    mode: streaming ? 'non_streaming_fallback' : 'non_streaming',
    startedAt,
    headersAt,
    finishedAt,
    timeToHeadersMs: headersAt - startedAt,
    timeToFirstByteMs: headersAt - startedAt,
    streamDurationMs: finishedAt - headersAt,
    totalMs: finishedAt - startedAt,
    receivedHeaders: true
  };
  const text = Array.isArray(payload?.content)
    ? payload.content.filter((part) => part?.type === 'text').map((part) => part.text).join('').trim()
    : '';
  if (!text) {
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'empty-content',
      providerId: config.providerId,
      kind: ERROR_KIND.INVALID_RESPONSE,
      receivedHeaders: true,
      metrics
    });
  }
  const usage = normalizeUsage(payload);
  onProgress?.({receivedOutput: true, firstTokenAt: finishedAt});
  return {
    text,
    providerId: config.providerId,
    model: payload?.model ?? config.modelId,
    usage,
    finishReason: payload?.stop_reason === 'max_tokens' ? 'length' : (payload?.stop_reason ?? null),
    responseFormat: 'prompt',
    responseMode: 'non_streaming',
    routedProvider: null,
    rawCost: null,
    reasoningChars: 0,
    requestBytes,
    metrics,
    raw: null
  };
}

export async function callProvider(config, options) {
  if (config.protocol === 'anthropic') return callAnthropic({config, ...options});
  return callOpenAICompatible({config, ...options});
}

/** Best-effort provider model listing, used by the settings UI. */
export async function listProviderModels({
  config,
  apiKey,
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 30000,
  now = Date.now
}) {
  await assertSafeResolvedUrl(config.baseUrl, {
    allowLocalNetwork: config.allowLocalNetwork === true
  });
  const headers = {accept: 'application/json'};
  if (apiKey) {
    if (config.protocol === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = getProvider('anthropic')?.anthropicVersion ?? '2023-06-01';
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }
  const control = createRequestControl({externalSignal: signal, headerTimeoutMs: timeoutMs});
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/models'), {
      method: 'GET',
      headers,
      signal: control.signal
    });
  } catch (error) {
    control.cleanup();
    throw transportError(error, {
      providerId: config.providerId,
      control,
      startedAt: now(),
      now,
      timeoutMs
    });
  }
  control.markHeaders();
  control.cleanup();
  const payload = await safeJson(response);
  if (!response.ok) throw errorFromResponse(response, payload, config.providerId);
  const list = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : (Array.isArray(payload) ? payload : []));
  return list
    .map((entry) => normalizeModelEntry(entry, config))
    .filter((entry) => entry.id);
}

function normalizeModelEntry(entry, config) {
  const id = String(entry?.id ?? entry?.name ?? '').trim();
  const name = String(entry?.name ?? entry?.display_name ?? id).trim();
  const contextLength = Number(entry?.context_length ?? entry?.context_window ?? entry?.top_provider?.context_length ?? NaN);
  let pricingStatus = null;
  let pricing = null;
  if (config.providerId === 'openrouter') {
    const parsed = pricingFromOpenRouterModel(entry);
    pricingStatus = parsed.pricingStatus;
    pricing = parsed.pricing;
  }
  if (pricingStatus === null) {
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      pricing = perMillionFromTokenPrice(prompt);
      if (pricing) pricing.outputPerMillion = completion * 1_000_000;
      pricingStatus = prompt === 0 && completion === 0 ? 'api_free' : 'paid';
    }
  }
  const supported = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : [];
  return {
    id,
    name,
    providerId: config.providerId,
    contextLength: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null,
    pricingStatus,
    pricing,
    structuredOutputs: supported.includes('structured_outputs')
      ? true
      : (supported.includes('response_format') ? 'response_format' : null),
    description: typeof entry?.description === 'string' ? entry.description.slice(0, 500) : null,
    free: pricingStatus === 'api_free',
    raw: entry
  };
}
