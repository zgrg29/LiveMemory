import {PRICING_STATUS, PRICING_STATUSES} from './catalog.mjs';

/**
 * Cost status and estimates.
 *
 * A provider name is never enough to call a model "free". The status is one of:
 *   anonymous_free — keyless, verified anonymous route;
 *   api_free       — the provider/model metadata explicitly reports zero price;
 *   paid           — verified pricing is stored for the exact model/region;
 *   unknown        — no reliable pricing information.
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
  return {
    currency,
    inputPerMillion,
    outputPerMillion,
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

export function estimateTokensFromText(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

/**
 * Estimate a request cost. Returns null when pricing is absent or the currency
 * does not match. The result is an estimate, never a final bill.
 */
export function estimateCost({pricing, inputTokens, outputTokens, currency = null}) {
  if (!pricing) return null;
  if (currency && pricing.currency !== currency) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const amount = (input / 1_000_000) * Number(pricing.inputPerMillion ?? 0)
    + (output / 1_000_000) * Number(pricing.outputPerMillion ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    amount,
    currency: pricing.currency,
    inputTokens: input,
    outputTokens: output,
    basis: 'estimated_tokens_x_published_price'
  };
}

export function normalizeBudget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const currency = String(input.currency ?? 'USD').toUpperCase().slice(0, 8);
  if (!/^[A-Z]{3,8}$/.test(currency)) return null;
  return {amount, currency};
}

/** Add usage returned by a provider and cost it if pricing is available. */
export function addUsage(total, usage, pricing) {
  const next = {
    inputTokens: Number(total?.inputTokens ?? 0) + Number(usage?.inputTokens ?? 0),
    outputTokens: Number(total?.outputTokens ?? 0) + Number(usage?.outputTokens ?? 0),
    requests: Number(total?.requests ?? 0) + 1,
    cost: total?.cost ?? null
  };
  if (pricing) {
    const cost = estimateCost({
      pricing,
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens
    });
    next.cost = cost;
  }
  return next;
}

export function budgetRemaining(budget, usage) {
  if (!budget || !usage?.cost) return null;
  if (budget.currency !== usage.cost.currency) return null;
  return {
    amount: Math.max(0, budget.amount - usage.cost.amount),
    currency: budget.currency,
    exceeded: usage.cost.amount >= budget.amount
  };
}

/**
 * Gate for long-term profiling. All conditions are required:
 * paid status, explicit pricing, capability test specifically for memory, and
 * the user's explicit opt-in.
 */
export function memoryPermission({pricingStatus, pricing, capabilities, optIn}) {
  const reasons = [];
  if (optIn !== true) reasons.push('OPT_IN_REQUIRED');
  if (pricingStatus !== PRICING_STATUS.PAID) reasons.push('PAID_MODEL_REQUIRED');
  if (!pricing) reasons.push('PRICING_UNKNOWN');
  if (capabilities?.memory !== true) reasons.push('MEMORY_CAPABILITY_UNVERIFIED');
  if (capabilities?.session !== true) reasons.push('SESSION_CAPABILITY_UNVERIFIED');
  return {allowed: reasons.length === 0, reasons};
}
