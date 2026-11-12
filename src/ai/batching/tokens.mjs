/**
 * Token-budget batching.
 *
 * Message-count batches are a poor proxy for request size: 500 short messages
 * and 500 long messages differ by an order of magnitude, and a whole-session
 * request can silently reach hundreds of thousands of tokens. The planners here
 * pack by *estimated input tokens* instead, while still honouring the existing
 * message/viewer/excerpt caps and the rule that one viewer is never split
 * across memory batches.
 *
 * The budget is intentionally configurable and derived from the model's declared
 * context window when the user has not set one. It is not an exact tokenizer:
 * the estimate is deliberately conservative (UTF-8 bytes / 3) and every request
 * records its own estimate so an operator can see the real numbers.
 */

export const MIN_BATCH_INPUT_TOKENS = 2000;
export const MAX_BATCH_INPUT_TOKENS = 32000;
export const DEFAULT_BATCH_INPUT_TOKENS = 8000;

/** Rough cost of the system prompt + wrapper lines (not the instructions). */
const PROMPT_WRAPPER_TOKENS = 200;

/** Estimated tokens in one UTF-8 text block. */
export function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  return Math.ceil(Buffer.byteLength(String(value), 'utf8') / 3);
}

export function estimateJsonTokens(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTokens(value);
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pick the per-request input budget.
 *
 * `configured` wins when it is a positive number (the settings UI exposes it).
 * Otherwise the budget stays at the documented default unless the model's
 * context window is small enough that 8k input + output budget would not fit;
 * in that case it shrinks, never below 2k.
 */
export function resolveBatchInputTokens({
  configured = null,
  contextLength = null,
  outputReserve = 8000,
  fallback = DEFAULT_BATCH_INPUT_TOKENS
} = {}) {
  const input = Number(configured);
  if (Number.isFinite(input) && input > 0) {
    return clamp(Math.floor(input), MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS);
  }
  const base = clamp(Math.floor(Number(fallback) || DEFAULT_BATCH_INPUT_TOKENS),
    MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS);
  const context = Number(contextLength);
  if (!Number.isFinite(context) || context <= 0) return base;
  const affordable = context - Math.max(1024, Number(outputReserve) || 8000) - 1500;
  return clamp(affordable, MIN_BATCH_INPUT_TOKENS, Math.min(base, MAX_BATCH_INPUT_TOKENS));
}

/** Bound the output budget so input + output can fit the declared context. */
export function resolveOutputTokens({desired = 8000, inputTokens = 0, contextLength = null} = {}) {
  const wanted = clamp(Math.floor(Number(desired) || 8000), 512, 32000);
  const context = Number(contextLength);
  if (!Number.isFinite(context) || context <= 0) return wanted;
  const room = Math.floor(context - Math.max(0, Number(inputTokens) || 0) - 500);
  return clamp(room, 512, wanted);
}

/**
 * Split a session into contiguous message batches under a token budget.
 *
 * @param messageTokens per-message estimated tokens, in chronological order
 * @returns [{startIndex, endIndex, messageCount, messageTokens, estimatedTokens}]
 */
export function planSessionMessageBatches({
  messageTokens,
  overheadTokens = 0,
  inputBudget = DEFAULT_BATCH_INPUT_TOKENS,
  maxMessages = 5000
}) {
  const tokens = Array.isArray(messageTokens) ? messageTokens.map((value) => Math.max(1, Number(value) || 1)) : [];
  if (tokens.length === 0) return [];
  const budget = clamp(Math.floor(Number(inputBudget) || DEFAULT_BATCH_INPUT_TOKENS),
    MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS);
  const available = Math.max(500, budget - Math.max(0, Number(overheadTokens) || 0));
  const cap = Math.max(1, Math.floor(Number(maxMessages) || 5000));
  const batches = [];
  let start = 0;
  let count = 0;
  let used = 0;
  const flush = (end) => {
    if (count === 0) return;
    batches.push({
      startIndex: start,
      endIndex: end,
      messageCount: count,
      messageTokens: used,
      estimatedTokens: used + Math.max(0, Number(overheadTokens) || 0)
    });
    start = end;
    count = 0;
    used = 0;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const size = tokens[index];
    const overBudget = count > 0 && (used + size > available || count + 1 > cap);
    if (overBudget) flush(index);
    count += 1;
    used += size;
  }
  flush(tokens.length);
  return batches;
}

function viewerCost(viewer) {
  return Math.max(1,
    Number(viewer?.excerptTokens ?? 0)
    + Number(viewer?.memoryTokens ?? 0)
    + 48);
}

/**
 * Assign viewers to memory batches.
 *
 * A viewer is never split and never dropped. When one viewer alone exceeds the
 * batch budget it is placed alone: a larger request is preferable to losing its
 * long-term memory coverage, and the runner reports the real prompt size.
 */
export function planMemoryViewerBatches({
  viewers = [],
  viewerCap = 10,
  excerptCap = 600,
  overheadTokens = 0,
  inputBudget = DEFAULT_BATCH_INPUT_TOKENS,
  maxBatches = 2001
} = {}) {
  const cap = Math.max(1, Math.floor(Number(viewerCap) || 10));
  const excerptLimit = Math.max(1, Math.floor(Number(excerptCap) || 600));
  const budget = clamp(Math.floor(Number(inputBudget) || DEFAULT_BATCH_INPUT_TOKENS),
    MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS);
  const available = Math.max(500, budget - Math.max(0, Number(overheadTokens) || 0));
  const batches = [];
  let current = null;
  let oversized = false;
  const flush = () => {
    if (current && current.viewerIds.length > 0) batches.push(current);
    current = null;
  };
  for (const viewer of viewers) {
    const excerptCount = Math.max(0, Number(viewer?.excerptCount ?? 0));
    const cost = viewerCost(viewer);
    if (!current) {
      current = {
        viewerIds: [],
        excerptCount: 0,
        estimatedTokens: Math.max(0, Number(overheadTokens) || 0),
        oversized: false
      };
    }
    const nextExcerpts = current.excerptCount + excerptCount;
    const nextTokens = current.estimatedTokens + cost;
    const wouldOverflow = current.viewerIds.length >= cap
      || (current.viewerIds.length > 0 && (nextExcerpts > excerptLimit || nextTokens > available));
    if (wouldOverflow) {
      flush();
      current = {
        viewerIds: [],
        excerptCount: 0,
        estimatedTokens: Math.max(0, Number(overheadTokens) || 0),
        oversized: false
      };
    }
    current.viewerIds.push(viewer?.viewerId ?? viewer?.viewer_id);
    current.excerptCount += excerptCount;
    current.estimatedTokens += cost;
    if (current.estimatedTokens > available && current.viewerIds.length === 1) {
      current.oversized = true;
      oversized = true;
    }
  }
  flush();
  if (batches.length > Math.max(1, Number(maxBatches) || 2001)) {
    throw Object.assign(new Error('ANALYSIS_TOO_MANY_BATCHES'), {
      code: 'ANALYSIS_TOO_MANY_BATCHES',
      batches: batches.length,
      limit: Math.max(1, Number(maxBatches) || 2001)
    });
  }
  return {batches, oversized, inputBudget: budget, availableTokens: available};
}

/**
 * The compact answer schema is a large part of every prompt. Its size is
 * measured from the real schema instead of being guessed here.
 */
export function promptOverheadTokens({instructions = '', context = null, schema = null} = {}) {
  const schemaTokens = typeof schema === 'number' ? schema : estimateJsonTokens(schema);
  return PROMPT_WRAPPER_TOKENS
    + estimateTokens(instructions)
    + estimateJsonTokens(context)
    + schemaTokens;
}
