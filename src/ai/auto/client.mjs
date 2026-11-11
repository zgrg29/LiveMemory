import {AUTO_ERROR} from './config.mjs';
import {AutoAnalysisError} from './errors.mjs';

/**
 * Zero-dependency HTTP client for anonymous OpenAI-compatible chat routes.
 *
 * Rules:
 * - no Authorization header, no cookies, no user identifiers;
 * - one request at a time per provider, with a sliding-window limiter;
 * - respect Retry-After for 429/503;
 * - never log the prompt or the answer.
 */

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

export function sleepWithSignal(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AutoAnalysisError(AUTO_ERROR.CANCELED));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      cleanup();
      reject(new AutoAnalysisError(AUTO_ERROR.CANCELED));
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    signal?.addEventListener?.('abort', onAbort, {once: true});
  });
}

/** Sliding-window limiter; `limit` requests per `windowMs`. */
export class SlidingWindowLimiter {
  constructor({limit, windowMs, now = Date.now}) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    this.now = now;
    this.timestamps = [];
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);
  }

  /** Wait until a slot is free. Does not record the slot; call `record()`. */
  async acquire(signal) {
    for (;;) {
      this.prune();
      if (this.timestamps.length < this.limit) return;
      const waitMs = this.timestamps[0] + this.windowMs - this.now() + 25;
      await sleepWithSignal(waitMs, signal);
    }
  }

  record(at = this.now()) {
    this.timestamps.push(at);
    this.prune();
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * Extract exactly one JSON object. A single Markdown fence is accepted because
 * many chat models add one; prose around the object is tolerated only when the
 * object itself is balanced and parses. Schema validation still decides whether
 * the answer is usable.
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let source = text.replace(/^\uFEFF/, '').trim();
  if (source === '') return null;
  const fence = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(source);
  if (fence) source = fence[1].trim();
  // A top-level array is not a LiveMemory result. Reject it before the
  // balanced-object scan, otherwise an array wrapper could be mistaken for a
  // legitimate answer.
  if (source.startsWith('[')) return null;
  const attempt = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(source);
  if (direct) return direct;

  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return attempt(source.slice(start, index + 1));
    }
  }
  return null;
}

/**
 * Perform one provider attempt.
 * @returns {Promise<{content:string, providerId:string, model:string, usage:object|null, durationMs:number}>}
 */
export async function callProvider({
  provider,
  messages,
  maxTokens,
  signal = null,
  fetchImpl = globalThis.fetch,
  limiter = null,
  now = Date.now
}) {
  if (typeof fetchImpl !== 'function') {
    throw new AutoAnalysisError(AUTO_ERROR.PROVIDER_UNAVAILABLE, {
      detail: 'fetch-unavailable',
      providerId: provider.id
    });
  }
  if (signal?.aborted) throw new AutoAnalysisError(AUTO_ERROR.CANCELED);
  await (limiter ?? {acquire: async () => {}}).acquire(signal);
  limiter?.record?.();

  const startedAt = now();
  const timeoutSignal = AbortSignal.timeout(provider.timeoutMs ?? 180000);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const body = {
    model: provider.model,
    messages,
    max_tokens: Math.max(256, Math.min(Number(maxTokens) || 4096, 32000)),
    temperature: 0
  };
  if (provider.supportsResponseFormat !== false) {
    body.response_format = {type: 'json_object'};
  }
  if (provider.reasoningEffort) body.reasoning_effort = provider.reasoningEffort;

  let response;
  try {
    response = await fetchImpl(provider.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'LiveMemory/AutoAnalysis'
      },
      body: JSON.stringify(body),
      signal: combined
    });
  } catch (error) {
    if (signal?.aborted) throw new AutoAnalysisError(AUTO_ERROR.CANCELED);
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AutoAnalysisError(AUTO_ERROR.TIMEOUT, {
        detail: 'request-timeout',
        providerId: provider.id,
        retryable: true
      });
    }
    throw new AutoAnalysisError(AUTO_ERROR.PROVIDER_UNAVAILABLE, {
      detail: String(error?.code ?? error?.name ?? 'fetch-failed').slice(0, 120),
      providerId: provider.id,
      retryable: true,
      cause: error
    });
  }

  const durationMs = now() - startedAt;
  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    const retryable = response.status === 429
      || response.status === 408
      || response.status === 425
      || response.status >= 500;
    const code = response.status === 429
      ? AUTO_ERROR.RATE_LIMITED
      : response.status >= 500
        ? AUTO_ERROR.PROVIDER_UNAVAILABLE
        : AUTO_ERROR.SCHEMA_INVALID;
    throw new AutoAnalysisError(code, {
      detail: `http-${response.status}`,
      providerId: provider.id,
      httpStatus: response.status,
      retryable,
      retryAfterMs
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AutoAnalysisError(AUTO_ERROR.INVALID_JSON, {
      detail: 'response-not-json',
      providerId: provider.id,
      retryable: true,
      cause: error
    });
  }
  const content = responseContent(payload).trim();
  if (content === '') {
    throw new AutoAnalysisError(AUTO_ERROR.INVALID_JSON, {
      detail: 'empty-content',
      providerId: provider.id,
      retryable: true
    });
  }
  return {
    content,
    providerId: provider.id,
    model: payload?.model ?? provider.model,
    usage: payload?.usage ?? null,
    durationMs
  };
}
