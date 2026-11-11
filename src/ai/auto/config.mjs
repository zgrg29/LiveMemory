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

/**
 * One automatic task may create at most this many batches (user-visible).
 *
 * v0.12.1 lowered the per-batch viewer cap from 25 to 10. The previous 12-batch
 * ceiling would then have supported only 120 viewers instead of 300, so the
 * ceiling is raised in the same change. A real 52-viewer, 99-message session now
 * needs six batches; 300 viewers still fit (30 × 10).
 */
export const MAX_AUTO_BATCHES = 30;

/**
 * Automatic packaging is deliberately smaller than the manual default. The
 * free anonymous routes have a modest output budget and a shared rate limit;
 * smaller batches keep one bad answer from losing a large part of the stream.
 * These limits are passed into createAnalysisJob(), so coverage and evidence
 * mapping stay exactly the same as the manual path.
 *
 * 25 viewers per request was measured to fail against gpt-oss-20b: a batch with
 * 25 assigned viewers either degenerated into repeated field names (json_object
 * mode, finish_reason=length) or produced updates for viewers from another
 * batch. 52 viewers in one request produced zero memory updates at all. 10 is
 * the tested compromise; see docs/ANONYMOUS_AI_RESEARCH.md §11.
 */
export const AUTO_BATCH_MESSAGES = 250;
export const AUTO_MEMORY_VIEWERS_PER_BATCH = 10;
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
  OUTPUT_TRUNCATED: 'AUTO_OUTPUT_TRUNCATED',
  OUTPUT_DEGENERATED: 'AUTO_OUTPUT_DEGENERATED',
  VIEWER_COVERAGE_INCOMPLETE: 'AUTO_VIEWER_COVERAGE_INCOMPLETE',
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
    // A real 25-viewer request took 169 s before the output budget was hit and
    // the answer degenerated. Structured output is much faster, but the timeout
    // must not be the thing that fails a slow free request.
    timeoutMs: 300000,
    reasoningEffort: 'low',
    rateLimit: Object.freeze({limit: 2, windowMs: 60000}),
    supportsResponseFormat: true,
    // Verified against this endpoint: `response_format: {type:"json_schema"}`
    // returns valid JSON with finish_reason=stop on the same real package that
    // degenerated in json_object mode.
    supportsStructuredOutputs: true
  })
]);

export function providerSummary() {
  return AUTO_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: provider.model
  }));
}
