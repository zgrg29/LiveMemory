/**
 * Token-budget batching.
 *
 * Three quantities are deliberately kept separate:
 *
 *   - `overheadTokens`  fixed prompt cost measured from the real instructions,
 *                       session context and answer schema;
 *   - `contentTokens`   the budget actually available for chat messages or
 *                       viewer excerpts;
 *   - `outputReserve`   completion budget that must also fit the model context
 *                       but never consumes input budget.
 *
 * Earlier versions subtracted the full overhead from the configured total. With
 * the real 889-message Japanese package the fixed overhead is ~6.9k tokens, so an
 * 8k total left only ~0.8k for chat and produced ~125 tiny requests. The planner
 * now guarantees that at least half of the configured total (and at least
 * `MIN_CONTENT_TOKENS`) is available for content, and reports the effective
 * total when fixed overhead forces it upward.
 *
 * The budget is still an estimate, not a tokenizer: UTF-8 bytes / 3 is
 * optimistic for mixed Japanese/ASCII JSON and conservative for dense CJK. The
 * runner records both the estimate and the provider-reported usage so the
 * calibration can be checked against real data.
 */

export const MIN_BATCH_INPUT_TOKENS = 2000;
export const MAX_BATCH_INPUT_TOKENS = 32000;

/**
 * 24k input + 8k output fits a 32k-context model with a small safety margin and
 * is the smallest default that keeps a large session at a handful of requests.
 */
export const DEFAULT_BATCH_INPUT_TOKENS = 24000;

/** Absolute floor for chat/excerpt content in one request. */
export const MIN_CONTENT_TOKENS = 1000;

/** At least this share of the configured total must be usable for content. */
export const MIN_CONTENT_SHARE = 0.5;

/** Safety margin between input + output and the declared context window. */
export const CONTEXT_SAFETY_TOKENS = 500;

/** DashScope thinking headroom; see resolveMaxCompletionTokens. */
export const THINKING_RESERVE_TOKENS = 16000;
export const MAX_COMPLETION_TOKENS = 96000;

/**
 * Total output cap (answer + thinking) for providers whose `max_tokens` only
 * limits the answer. qwen3.8-max defaults to a 131k thinking budget, so an
 * explicit total cap is required to keep one attempt bounded. The cap never
 * disables thinking; a provider that still needs more reports
 * `finish_reason=length` instead of generating indefinitely.
 */
export function resolveMaxCompletionTokens({
  providerId = null,
  answerTokens = 8000,
  estimatedInputTokens = 0,
  contextLength = null,
  thinkingReserve = THINKING_RESERVE_TOKENS,
  maxCompletionTokens = MAX_COMPLETION_TOKENS
} = {}) {
  if (providerId !== 'dashscope') return null;
  const answer = Math.max(64, Number(answerTokens) || 8000);
  const desired = answer + Math.max(0, Number(thinkingReserve) || 0);
  const context = Number(contextLength);
  const byContext = Number.isFinite(context) && context > 0
    ? context - Math.max(0, Number(estimatedInputTokens) || 0) - CONTEXT_SAFETY_TOKENS
    : maxCompletionTokens;
  return Math.max(answer, Math.min(desired, byContext, maxCompletionTokens));
}

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
 * Pick the configured *total input* target.
 *
 * `configured` wins when it is a positive number. Otherwise the default is 24k,
 * shrunk only when the declared context cannot fit the default input plus the
 * output reserve. The returned value is the target, not the final content
 * budget; `planBatchBudget` separates the fixed overhead afterwards.
 */
export function resolveBatchInputTokens({
  configured = null,
  contextLength = null,
  outputReserve = 8000,
  fallback = DEFAULT_BATCH_INPUT_TOKENS
} = {}) {
  const input = Number(configured);
  const base = (Number.isFinite(input) && input > 0)
    ? clamp(Math.floor(input), MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS)
    : clamp(Math.floor(Number(fallback) || DEFAULT_BATCH_INPUT_TOKENS),
      MIN_BATCH_INPUT_TOKENS, MAX_BATCH_INPUT_TOKENS);
  const context = Number(contextLength);
  if (!Number.isFinite(context) || context <= 0) return base;
  const affordable = context - Math.max(1024, Number(outputReserve) || 8000) - CONTEXT_SAFETY_TOKENS;
  return clamp(affordable, MIN_BATCH_INPUT_TOKENS, Math.min(base, MAX_BATCH_INPUT_TOKENS));
}

/**
 * Split a total input target into fixed overhead and usable content.
 *
 * @returns {{
 *   configuredTotalTokens:number,
 *   totalInputTokens:number,
 *   contentTokens:number,
 *   overheadTokens:number,
 *   outputReserve:number,
 *   contextLength:number|null,
 *   overheadAdjusted:boolean,
 *   contextCapped:boolean,
 *   fitsContext:boolean
 * }}
 */
export function planBatchBudget({
  totalInputTokens = DEFAULT_BATCH_INPUT_TOKENS,
  overheadTokens = 0,
  outputReserve = 8000,
  contextLength = null
} = {}) {
  const target = clamp(
    Math.floor(Number(totalInputTokens) || DEFAULT_BATCH_INPUT_TOKENS),
    MIN_BATCH_INPUT_TOKENS,
    MAX_BATCH_INPUT_TOKENS
  );
  const overhead = Math.max(0, Math.ceil(Number(overheadTokens) || 0));
  const reserve = Math.max(512, Math.ceil(Number(outputReserve) || 8000));
  const shareFloor = Math.ceil(target * MIN_CONTENT_SHARE);
  let content = Math.max(MIN_CONTENT_TOKENS, target - overhead, shareFloor);
  let total = overhead + content;
  let contextCapped = false;
  let fitsContext = true;
  const context = Number(contextLength);
  if (Number.isFinite(context) && context > 0) {
    const maxTotal = context - reserve - CONTEXT_SAFETY_TOKENS;
    if (total > maxTotal) {
      contextCapped = true;
      total = maxTotal;
      content = total - overhead;
      if (content < MIN_CONTENT_TOKENS) {
        // The fixed overhead alone nearly fills the context. Still send the
        // minimum content and flag it; callers can log/refuse before spending.
        content = MIN_CONTENT_TOKENS;
        total = overhead + content;
        fitsContext = total + reserve + CONTEXT_SAFETY_TOKENS <= context;
      }
    }
  }
  return {
    configuredTotalTokens: target,
    totalInputTokens: total,
    contentTokens: content,
    overheadTokens: overhead,
    outputReserve: reserve,
    contextLength: Number.isFinite(context) && context > 0 ? context : null,
    overheadAdjusted: total > target,
    contextCapped,
    fitsContext
  };
}

/** Bound the output budget so input + output can fit the declared context. */
export function resolveOutputTokens({desired = 8000, inputTokens = 0, contextLength = null} = {}) {
  const wanted = clamp(Math.floor(Number(desired) || 8000), 512, 32000);
  const context = Number(contextLength);
  if (!Number.isFinite(context) || context <= 0) return wanted;
  const room = Math.floor(context - Math.max(0, Number(inputTokens) || 0) - CONTEXT_SAFETY_TOKENS);
  return clamp(room, 512, wanted);
}

/**
 * Output budget for the whole-session aggregate.
 *
 * The aggregate must merge every validated batch report, so it is not a normal
 * batch and must not inherit the batch output budget. The previous code reused
 * 8,000 tokens for an 18-batch merge; the provider stopped at exactly 8,000 with
 * `finish_reason=length` after spending ~3m20s. This budget is independent,
 * bounded and derived from the real condensed input instead of an unbounded
 * "raise the limit" value:
 *
 *   - a merge is expected to be much shorter than its input, so 60% of the
 *     condensed batch-result tokens plus a fixed report allowance;
 *   - at least 12,000 answer tokens, so an 18-batch report is not artificially
 *     squeezed into the batch budget;
 *   - never more than 16,000 answer tokens, even when the input is huge; the
 *     bounded aggregate schema needs far less than this, so there is no reason
 *     to risk a provider's output-limit rejection with an unbounded ceiling;
 *   - reduced by the model context when the context length is known.
 */
export const MIN_AGGREGATE_OUTPUT_TOKENS = 12000;
export const MAX_AGGREGATE_OUTPUT_TOKENS = 16000;

export function resolveAggregateOutputTokens({
  batchResultTokens = 0,
  inputTokens = 0,
  contextLength = null
} = {}) {
  const condensed = Math.max(0, Number(batchResultTokens) || 0);
  const desired = clamp(
    Math.ceil(condensed * 0.6) + 3000,
    MIN_AGGREGATE_OUTPUT_TOKENS,
    MAX_AGGREGATE_OUTPUT_TOKENS
  );
  return resolveOutputTokens({desired, inputTokens, contextLength});
}

/**
 * Split a session into contiguous message batches under a *content* budget.
 *
 * @param messageTokens per-message estimated tokens, in chronological order
 * @param contentBudget tokens available for messages (overhead already removed)
 * @param overheadTokens fixed prompt cost, added back only for reporting
 * @returns [{startIndex, endIndex, messageCount, messageTokens, estimatedTokens}]
 */
export function planSessionMessageBatches({
  messageTokens,
  contentBudget = null,
  overheadTokens = 0,
  inputBudget = null,
  maxMessages = 5000
}) {
  const tokens = Array.isArray(messageTokens) ? messageTokens.map((value) => Math.max(1, Number(value) || 1)) : [];
  if (tokens.length === 0) return [];
  const overhead = Math.max(0, Number(overheadTokens) || 0);
  const available = contentBudget !== null && contentBudget !== undefined
    ? Math.max(500, Math.floor(Number(contentBudget) || 0))
    : Math.max(500, Math.floor(Number(inputBudget) || DEFAULT_BATCH_INPUT_TOKENS) - overhead);
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
      estimatedTokens: used + overhead
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
  const covered = batches.reduce((total, batch) => total + batch.messageCount, 0);
  return batches.map((batch) => ({...batch, coveredMessages: covered}));
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
 * content budget it is placed alone; `maxSingleViewerTokens` is a hard request
 * cap, and exceeding it fails explicitly instead of silently dropping excerpts
 * or sending an unbounded request.
 */
export function planMemoryViewerBatches({
  viewers = [],
  viewerCap = 10,
  excerptCap = 600,
  contentBudget = null,
  overheadTokens = 0,
  inputBudget = null,
  maxBatches = Number.MAX_SAFE_INTEGER,
  maxSingleViewerTokens = null
} = {}) {
  const cap = Math.max(1, Math.floor(Number(viewerCap) || 10));
  const excerptLimit = Math.max(1, Math.floor(Number(excerptCap) || 600));
  const overhead = Math.max(0, Number(overheadTokens) || 0);
  const available = contentBudget !== null && contentBudget !== undefined
    ? Math.max(500, Math.floor(Number(contentBudget) || 0))
    : Math.max(500, Math.floor(Number(inputBudget) || DEFAULT_BATCH_INPUT_TOKENS) - overhead);
  const singleLimit = Number(maxSingleViewerTokens);
  const batches = [];
  let current = null;
  let oversized = false;
  let oversizedViewerCount = 0;
  const flush = () => {
    if (current && current.viewerIds.length > 0) batches.push(current);
    current = null;
  };
  for (const viewer of viewers) {
    const excerptCount = Math.max(0, Number(viewer?.excerptCount ?? 0));
    const cost = viewerCost(viewer);
    if (Number.isFinite(singleLimit) && singleLimit > 0 && overhead + cost > singleLimit) {
      throw Object.assign(new Error('MEMORY_VIEWER_TOO_LARGE'), {
        code: 'ANALYSIS_MEMORY_VIEWER_TOO_LARGE',
        detail: `one viewer needs ${Math.ceil(overhead + cost)} input tokens; limit ${singleLimit}`,
        estimatedTokens: Math.ceil(overhead + cost),
        limit: singleLimit
      });
    }
    if (!current) {
      current = {
        viewerIds: [],
        excerptCount: 0,
        estimatedTokens: overhead,
        oversized: false
      };
    }
    const nextExcerpts = current.excerptCount + excerptCount;
    const nextTokens = current.estimatedTokens + cost;
    const wouldOverflow = current.viewerIds.length >= cap
      || (current.viewerIds.length > 0 && (nextExcerpts > excerptLimit || nextTokens > available + overhead));
    if (wouldOverflow) {
      flush();
      current = {
        viewerIds: [],
        excerptCount: 0,
        estimatedTokens: overhead,
        oversized: false
      };
    }
    current.viewerIds.push(viewer?.viewerId ?? viewer?.viewer_id);
    current.excerptCount += excerptCount;
    current.estimatedTokens += cost;
    if (current.estimatedTokens > overhead + available && current.viewerIds.length === 1) {
      current.oversized = true;
      oversized = true;
      oversizedViewerCount += 1;
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
  return {
    batches,
    oversized,
    oversizedViewerCount,
    contentBudget: available,
    overheadTokens: overhead,
    totalViewers: viewers.length
  };
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

/** True when a planning result is the pathological many-tiny-batches shape. */
export function isFragmentedPlan(plan, {maxBatches = 24, minMessagesPerBatch = 8} = {}) {
  if (!Array.isArray(plan) || plan.length === 0) return false;
  if (plan.length > maxBatches) return true;
  const average = plan.reduce((total, batch) => total + batch.messageCount, 0) / plan.length;
  return average < minMessagesPerBatch;
}
