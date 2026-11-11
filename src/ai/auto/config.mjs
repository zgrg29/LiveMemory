/**
 * Automatic AI analysis configuration.
 *
 * Only providers that were actually exercised against a real LiveMemory package
 * during development may appear here. A provider that merely answers HTTP 200,
 * or that requires an account/token, must not be added "just in case": the
 * runner would then send viewer data to an unverified destination.
 *
 * The provider below is the anonymous, keyless, OpenAI-compatible endpoint that
 * returned a schema-valid LiveMemory result in the live probe. See
 * docs/ANONYMOUS_AI_RESEARCH.md for the failed candidates.
 */

export const AUTO_SCHEMA_VERSION = '1.2.0';

/** One automatic task may create at most this many batches (user-visible). */
export const MAX_AUTO_BATCHES = 12;

/**
 * Automatic packaging is deliberately smaller than the manual default. The
 * free anonymous routes have a modest output budget and a shared rate limit;
 * smaller batches keep one bad answer from losing a large part of the stream.
 * These limits are passed into createAnalysisJob(), so coverage and evidence
 * mapping stay exactly the same as the manual path.
 */
export const AUTO_BATCH_MESSAGES = 250;
export const AUTO_MEMORY_VIEWERS_PER_BATCH = 25;
export const AUTO_MEMORY_EXCERPTS_PER_BATCH = 600;
export const AUTO_MAX_OUTPUT_TOKENS = 12000;

/** Conservative prompt budget for a 131k-context route. */
export const AUTO_MAX_PROMPT_TOKENS = 90000;
/** Do not wait longer than this for a provider's Retry-After. */
export const AUTO_MAX_RETRY_AFTER_MS = 90000;
/** One repair request per answer, no infinite "fix the JSON" loops. */
export const AUTO_MAX_REPAIRS = 1;

export const AUTO_ERROR = Object.freeze({
  ALREADY_RUNNING: 'AUTO_ALREADY_RUNNING',
  CONSENT_REQUIRED: 'AUTO_CONSENT_REQUIRED',
  SESSION_EMPTY: 'AUTO_SESSION_EMPTY',
  TOO_MANY_BATCHES: 'AUTO_TOO_MANY_BATCHES',
  CONTEXT_TOO_LARGE: 'AUTO_CONTEXT_TOO_LARGE',
  ALL_PROVIDERS_FAILED: 'AUTO_ALL_PROVIDERS_FAILED',
  RATE_LIMITED: 'AUTO_RATE_LIMITED',
  TIMEOUT: 'AUTO_TIMEOUT',
  INVALID_JSON: 'AUTO_INVALID_JSON',
  SCHEMA_INVALID: 'AUTO_SCHEMA_INVALID',
  IMPORT_FAILED: 'AUTO_IMPORT_FAILED',
  AGGREGATE_FAILED: 'AUTO_AGGREGATE_FAILED',
  CANCELED: 'AUTO_CANCELED',
  INTERRUPTED: 'AUTO_INTERRUPTED',
  PROVIDER_UNAVAILABLE: 'AUTO_PROVIDER_UNAVAILABLE',
  INTERNAL: 'AUTO_INTERNAL'
});

/**
 * Provider order is quality-first, not speed-first. The runner tries each
 * verified provider in order. Requests are serialised and rate limited per
 * provider; no provider is probed in the background.
 *
 * Pollinations (anonymous GPT-OSS 20B) passed the basic JSON/multilingual
 * probes but returned HTTP 400 for a real LiveMemory package, so it is
 * deliberately absent until it passes the full contract.
 */
export const AUTO_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'ovh-gpt-oss-20b',
    label: 'OVHcloud AI Endpoints',
    endpoint: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    model: 'gpt-oss-20b',
    timeoutMs: 180000,
    reasoningEffort: 'low',
    rateLimit: Object.freeze({limit: 2, windowMs: 60000}),
    supportsResponseFormat: true
  })
]);

export function providerSummary() {
  return AUTO_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: provider.model
  }));
}
