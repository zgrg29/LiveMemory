/**
 * Derive the visible state of one API configuration.
 *
 * A saved config is not the same as a usable key, and a usable key is not the
 * same as a passed capability test. The UI must never collapse those states into
 * "no API key configured".
 */
export function providerConfigState(config) {
  if (!config) return {kind: 'none', usable: false, needsBilling: false};
  if (config.hasCredential !== true) {
    return {kind: 'missing_key', usable: false, needsBilling: false};
  }
  const testStatus = config.lastTestStatus?.status ?? 'untested';
  if (testStatus === 'failed') {
    return {
      kind: 'test_failed',
      usable: false,
      needsBilling: false,
      detail: config.lastTestStatus?.error ?? null
    };
  }
  if (config.capabilities?.session !== true) {
    return {kind: 'untested', usable: false, needsBilling: false};
  }
  const needsBilling = config.pricingStatus !== 'api_free';
  if (config.pricingStatus === 'paid' && !config.pricing) {
    return {kind: 'pricing_missing', usable: false, needsBilling};
  }
  return {kind: 'ready', usable: true, needsBilling};
}

export const __internal = {};
