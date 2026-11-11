import {joinUrl, assertSafeResolvedUrl} from './url-safety.mjs';
import {getProvider} from './catalog.mjs';
import {perMillionFromTokenPrice, pricingFromOpenRouterModel} from './pricing.mjs';
import {parseRetryAfter} from '../runtime/json.mjs';

/**
 * Low-level provider transport.
 *
 * One adapter interface, two protocol families:
 *   - OpenAI Chat Completions (OpenAI, DeepSeek, MiniMax, DashScope, OpenRouter,
 *     custom OpenAI-compatible);
 *   - Anthropic Messages.
 *
 * The adapters only move JSON and usage numbers. They do not interpret LiveMemory
 * results, and they never log credentials or prompt content.
 */

export class ProviderHttpError extends Error {
  constructor(code, {
    status = null,
    detail = null,
    retryable = false,
    providerId = null,
    cause = null,
    retryAfterMs = null
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
  CONFIG: 'PROVIDER_CONFIG_INVALID'
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

export function normalizeUsage(payload) {
  const usage = payload?.usage ?? {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    totalTokens: Number(usage.total_tokens ?? (input + output)) || 0,
    raw: {
      input_tokens: Number.isFinite(input) ? input : 0,
      output_tokens: Number.isFinite(output) ? output : 0
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
  if (status === 401 || status === 403) {
    return new ProviderHttpError(PROVIDER_ERROR.AUTH, {status, detail, providerId});
  }
  if (status === 404) {
    return new ProviderHttpError(PROVIDER_ERROR.NOT_FOUND, {status, detail, providerId});
  }
  if (status === 429) {
    return new ProviderHttpError(PROVIDER_ERROR.RATE_LIMIT, {
      status,
      detail,
      retryable: true,
      providerId,
      retryAfterMs
    });
  }
  return new ProviderHttpError(PROVIDER_ERROR.HTTP, {
    status,
    detail: type && detail ? `${type}: ${detail}` : detail,
    retryable: status >= 500 || status === 408 || status === 425,
    providerId,
    retryAfterMs
  });
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * OpenAI-compatible request.
 * `responseFormat` values: 'json_schema' | 'json_object' | 'none'.
 */
export async function callOpenAICompatible({
  config,
  apiKey,
  messages,
  maxTokens = 4096,
  responseSchema = null,
  responseFormat = 'json_schema',
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 180000,
  headers = {}
}) {
  const provider = getProvider(config.providerId);
  if (!provider && config.protocol !== 'openai') {
    throw new ProviderHttpError(PROVIDER_ERROR.CONFIG, {providerId: config.providerId});
  }
  const auth = apiKey ? {authorization: `Bearer ${apiKey}`} : {};
  const body = {
    model: config.modelId,
    messages,
    max_tokens: Math.max(64, Math.min(Number(maxTokens) || 4096, 32000)),
    temperature: 0
  };
  const structured = responseSchema && responseFormat !== 'none';
  if (structured && responseFormat === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {name: 'livememory_result', schema: responseSchema, strict: false}
    };
  } else if (structured) {
    body.response_format = {type: 'json_object'};
  }
  // OpenRouter recommends attribution headers; they contain no local path or key.
  if (config.providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/zgrg29/LiveMemory';
    headers['X-Title'] = 'LiveMemory';
  }

  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...auth,
        ...headers
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(signal, timeoutMs)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
        detail: 'request-timeout',
        retryable: true,
        providerId: config.providerId,
        cause: error
      });
    }
    throw new ProviderHttpError(PROVIDER_ERROR.NETWORK, {
      detail: String(error?.code ?? error?.name ?? 'network-error').slice(0, 120),
      retryable: true,
      providerId: config.providerId,
      cause: error
    });
  }
  const payload = await safeJson(response);
  if (!response.ok) throw errorFromResponse(response, payload, config.providerId);
  const text = contentFromOpenAI(payload).trim();
  if (!text) {
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'empty-content',
      providerId: config.providerId
    });
  }
  return {
    text,
    providerId: config.providerId,
    model: payload?.model ?? config.modelId,
    usage: normalizeUsage(payload),
    finishReason: finishFromOpenAI(payload),
    responseFormat,
    routedProvider: payload?.provider ?? null,
    rawCost: payload?.usage?.cost ?? null,
    raw: null
  };
}

export async function callAnthropic({
  config,
  apiKey,
  messages,
  maxTokens = 4096,
  responseSchema = null,
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = 180000
}) {
  if (!apiKey) {
    throw new ProviderHttpError(PROVIDER_ERROR.CONFIG, {detail: 'api-key-required', providerId: config.providerId});
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
  // Anthropic Messages has no portable json_schema parameter across models;
  // the prompt builder includes the schema and asks for JSON only.
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': getProvider('anthropic')?.anthropicVersion ?? '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(signal, timeoutMs)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderHttpError(PROVIDER_ERROR.TIMEOUT, {
        detail: 'request-timeout',
        retryable: true,
        providerId: config.providerId,
        cause: error
      });
    }
    throw new ProviderHttpError(PROVIDER_ERROR.NETWORK, {
      detail: String(error?.code ?? error?.name ?? 'network-error').slice(0, 120),
      retryable: true,
      providerId: config.providerId,
      cause: error
    });
  }
  const payload = await safeJson(response);
  if (!response.ok) throw errorFromResponse(response, payload, config.providerId);
  const text = Array.isArray(payload?.content)
    ? payload.content.filter((part) => part?.type === 'text').map((part) => part.text).join('').trim()
    : '';
  if (!text) {
    throw new ProviderHttpError(PROVIDER_ERROR.FORMAT, {
      status: response.status,
      detail: 'empty-content',
      providerId: config.providerId
    });
  }
  const usage = normalizeUsage(payload);
  return {
    text,
    providerId: config.providerId,
    model: payload?.model ?? config.modelId,
    usage,
    finishReason: payload?.stop_reason === 'max_tokens' ? 'length' : (payload?.stop_reason ?? null),
    responseFormat: 'prompt',
    routedProvider: null,
    rawCost: null,
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
  timeoutMs = 30000
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
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, '/models'), {
      method: 'GET',
      headers,
      signal: timeoutSignal(signal, timeoutMs)
    });
  } catch (error) {
    throw new ProviderHttpError(PROVIDER_ERROR.NETWORK, {
      detail: String(error?.code ?? error?.name ?? 'network-error').slice(0, 120),
      retryable: true,
      providerId: config.providerId,
      cause: error
    });
  }
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
