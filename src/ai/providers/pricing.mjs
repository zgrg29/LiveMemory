import {PRICING_STATUS, PRICING_STATUSES} from './catalog.mjs';

/**
 * Cost status and estimates.
 *
 * A provider name is never enough to call a model "free". The status is one of:
 *   api_free  — the provider/model metadata explicitly reports zero price;
 *   paid      — verified pricing is stored for the exact model/region;
 *   unknown   — no reliable pricing information.
 *
 * Unknown is not silently treated as free. The UI asks for explicit confirmation
 * before sending a request that may cost money, and long-term viewer profiling
 * is only allowed for a `paid` model with a completed capability test.
 */

export function normalizePricingStatus(value, {fallback = PRICING_STATUS.UNKNOWN} = {}) {
  return PRICING_STATUSES.includes(value) ? value : fallback;
}

export function normalizePricing(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const inputPerMillion = Number(input.inputPerMillion);
  const outputPerMillion = Number(input.outputPerMillion);
  if (!Number.isFinite(inputPerMillion) || inputPerMillion < 0) return null;
  if (!Number.isFinite(outputPerMillion) || outputPerMillion < 0) return null;
  const currency = String(input.currency ?? 'USD').toUpperCase().slice(0, 8);
  if (!/^[A-Z]{3,8}$/.test(currency)) return null;
  // Optional: providers with prompt caching usually publish a lower price for
  // cache hits. It is never required, and an absent value is never treated as 0.
  // `Number(null) === 0`, so an explicit presence check is required: without it,
  // re-normalizing an already-normalized price turned "no cache price" into a
  // free cache and understated the estimate.
  const hasCachedPrice = input.cachedInputPerMillion !== null
    && input.cachedInputPerMillion !== undefined
    && input.cachedInputPerMillion !== '';
  const cachedInputPerMillion = hasCachedPrice ? Number(input.cachedInputPerMillion) : NaN;
  return {
    currency,
    inputPerMillion,
    outputPerMillion,
    cachedInputPerMillion: Number.isFinite(cachedInputPerMillion) && cachedInputPerMillion >= 0
      ? cachedInputPerMillion
      : null,
    sourceUrl: typeof input.sourceUrl === 'string' && input.sourceUrl.trim()
      ? input.sourceUrl.trim().slice(0, 500)
      : null,
    confirmedAt: typeof input.confirmedAt === 'string' ? input.confirmedAt : null
  };
}

/** OpenRouter (and similar) price strings are USD per token. */
export function perMillionFromTokenPrice(value, {currency = 'USD'} = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return {
    currency,
    inputPerMillion: number * 1_000_000,
    outputPerMillion: number * 1_000_000,
    sourceUrl: null,
    confirmedAt: null
  };
}

/**
 * Interpret an OpenRouter model descriptor. Missing pricing stays unknown; a
 * `:free` suffix alone is not enough to override explicit non-zero prices.
 */
export function pricingFromOpenRouterModel(model) {
  const prompt = model?.pricing?.prompt;
  const completion = model?.pricing?.completion;
  const promptNumber = Number(prompt);
  const completionNumber = Number(completion);
  if (!Number.isFinite(promptNumber) || !Number.isFinite(completionNumber)) {
    return {
      pricingStatus: model?.id && String(model.id).endsWith(':free')
        ? PRICING_STATUS.API_FREE
        : PRICING_STATUS.UNKNOWN,
      pricing: null
    };
  }
  const pricing = {
    currency: 'USD',
    inputPerMillion: promptNumber * 1_000_000,
    outputPerMillion: completionNumber * 1_000_000,
    sourceUrl: 'https://openrouter.ai/docs/guides/overview/models',
    confirmedAt: null
  };
  const free = promptNumber === 0 && completionNumber === 0;
  return {pricingStatus: free ? PRICING_STATUS.API_FREE : PRICING_STATUS.PAID, pricing};
}

/**
 * Interpret an OpenCode Console model descriptor.
 *
 * The catalogue reports `cost.text.input.price` / `cost.text.output.price` in
 * USD per million tokens (verified against the published per-1M pricing table,
 * e.g. Claude Sonnet 5.5 = 2 / 10). An absent cost block stays unknown; an
 * explicit 0 / 0 is the provider's own statement that the model is free. Free
 * *tier* models still answer HTTP 403 to non-OpenCode clients, so the price
 * label never implies "usable for free".
 */
export function pricingFromOpenCodeModel(model) {
  const input = Number(model?.cost?.text?.input?.price);
  const output = Number(model?.cost?.text?.output?.price);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return {pricingStatus: PRICING_STATUS.UNKNOWN, pricing: null};
  }
  const cacheRead = Number(model?.cost?.text?.input?.cache?.read);
  return {
    pricingStatus: input === 0 && output === 0 ? PRICING_STATUS.API_FREE : PRICING_STATUS.PAID,
    pricing: {
      currency: 'USD',
      inputPerMillion: input,
      outputPerMillion: output,
      cachedInputPerMillion: Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : null,
      sourceUrl: 'https://opencode.ai/docs/console/models',
      confirmedAt: null
    }
  };
}

export function estimateTokensFromText(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

/**
 * Estimate a request cost. Returns null when pricing is absent or the currency
 * does not match. The result is an estimate, never a final bill.
 *
 * Cache-hit input is billed separately when the user has stored a cache price;
 * otherwise cached tokens are still costed at the normal input price and the
 * result says so (`cachePriced: false`). The estimate therefore never invents a
 * discount the user did not configure.
 */
export function estimateCost({
  pricing,
  inputTokens,
  outputTokens,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
  currency = null
}) {
  if (!pricing) return null;
  if (currency && pricing.currency !== currency) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(cachedInputTokens) || 0));
  const cacheWrite = Math.min(input, Math.max(0, Number(cacheWriteInputTokens) || 0));
  const inputPrice = Number(pricing.inputPerMillion ?? 0);
  const outputPrice = Number(pricing.outputPerMillion ?? 0);
  // An absent cache price must fall back to the normal input price. The previous
  // `Number.isFinite(Number(value))` check treated `null` as 0 (because
  // `Number(null) === 0`), which made cached tokens free and understated cost.
  const cachePriceKnown = pricing.cachedInputPerMillion !== null
    && pricing.cachedInputPerMillion !== undefined
    && pricing.cachedInputPerMillion !== ''
    && Number.isFinite(Number(pricing.cachedInputPerMillion));
  const cachedPrice = cachePriceKnown ? Number(pricing.cachedInputPerMillion) : inputPrice;
  // Cache *writes* are always costed at the normal input price (the provider's
  // write surcharge is not guessed). Cache hits use the configured cache price
  // when present, otherwise the normal input price - so the estimate never
  // invents a discount the user did not configure.
  const uncached = Math.max(0, input - cached);
  const amount = (uncached / 1_000_000) * inputPrice
    + (cached / 1_000_000) * cachedPrice
    + (output / 1_000_000) * outputPrice;
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    amount,
    currency: pricing.currency,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    cachePriced: cachePriceKnown,
    basis: 'estimated_tokens_x_published_price'
  };
}

/**
 * Add usage returned by a provider and cost it if pricing is available.
 *
 * Every measured component is carried forward: input, output, reasoning (billed
 * inside the output tokens), cache hits and cache writes. The previous version
 * silently dropped reasoning tokens and all cache counters, so a long-running
 * task could not report them at all.
 */
export function addUsage(total, usage, pricing) {
  const inputTokens = Number(total?.inputTokens ?? 0) + Number(usage?.inputTokens ?? 0);
  const outputTokens = Number(total?.outputTokens ?? 0) + Number(usage?.outputTokens ?? 0);
  const next = {
    inputTokens,
    outputTokens,
    reasoningTokens: Number(total?.reasoningTokens ?? 0) + Number(usage?.reasoningTokens ?? 0),
    cachedInputTokens: Number(total?.cachedInputTokens ?? 0) + Number(usage?.cachedInputTokens ?? 0),
    cacheWriteInputTokens: Number(total?.cacheWriteInputTokens ?? 0)
      + Number(usage?.cacheWriteInputTokens ?? 0),
    // A provider may report its own charge (OpenRouter `usage.cost`). It is
    // accumulated separately from the local estimate so the two can be compared
    // without conflating them; requests without a reported charge are counted so
    // a partial sum is never presented as a full bill.
    providerReportedCost: Number(total?.providerReportedCost ?? 0)
      + Number(usage?.providerReportedCost ?? 0),
    providerCostRequests: Number(total?.providerCostRequests ?? 0)
      + (usage?.providerReportedCost === null || usage?.providerReportedCost === undefined ? 0 : 1),
    // `requests` keeps its historical meaning: responses that carried a usage
    // block. `attempts` counts every request actually sent, so a provider that
    // omits usage can no longer make a task look smaller than it was.
    requests: Number(total?.requests ?? 0) + 1,
    attempts: Math.max(Number(total?.requests ?? 0), Number(total?.attempts ?? 0)) + 1,
    unknownUsageAttempts: Number(total?.unknownUsageAttempts ?? 0),
    usageReported: total?.usageReported === false ? false : true,
    cost: total?.cost ?? null
  };
  if (pricing) {
    next.cost = estimateCost({
      pricing,
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens,
      cachedInputTokens: next.cachedInputTokens,
      cacheWriteInputTokens: next.cacheWriteInputTokens
    });
  }
  return next;
}

/**
 * Record one request that produced no usage block. Tokens stay unknown (never
 * zero), but the request is still counted so retry/progress accounting cannot
 * silently under-report how many billable calls were made.
 */
export function countRequestWithoutUsage(total) {
  const previous = total ?? {};
  const requests = Number(previous.requests ?? 0);
  const attempts = Math.max(requests, Number(previous.attempts ?? 0));
  return {
    inputTokens: Number(previous.inputTokens ?? 0),
    outputTokens: Number(previous.outputTokens ?? 0),
    reasoningTokens: Number(previous.reasoningTokens ?? 0),
    cachedInputTokens: Number(previous.cachedInputTokens ?? 0),
    cacheWriteInputTokens: Number(previous.cacheWriteInputTokens ?? 0),
    providerReportedCost: previous.providerReportedCost ?? null,
    providerCostRequests: Number(previous.providerCostRequests ?? 0),
    requests,
    attempts: attempts + 1,
    unknownUsageAttempts: Number(previous.unknownUsageAttempts ?? 0) + 1,
    usageReported: false,
    cost: previous.cost ?? null
  };
}

/**
 * Long-term profiling gate. Only a verified technical memory capability is
 * required; price, a free/paid label, and billing confirmation never block it.
 */
export function memoryPermission({capabilities} = {}) {
  const reasons = [];
  if (capabilities?.memory !== true) reasons.push('MEMORY_CAPABILITY_UNVERIFIED');
  if (capabilities?.session !== true) reasons.push('SESSION_CAPABILITY_UNVERIFIED');
  return {allowed: reasons.length === 0, reasons};
}
