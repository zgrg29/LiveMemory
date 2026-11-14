/**
 * Derive the visible state of one API configuration.
 *
 * A saved config is not the same as a usable key, and a usable key is not the
 * same as a passed capability test. Price is display-only and never gates a
 * request or long-term memory.
 */
export function providerConfigState(config) {
  if (!config) return {kind: 'none', usable: false};
  if (config.hasCredential !== true) {
    return {kind: 'missing_key', usable: false};
  }
  const testStatus = config.lastTestStatus?.status ?? 'untested';
  if (testStatus === 'failed') {
    return {
      kind: 'test_failed',
      usable: false,
      detail: config.lastTestStatus?.error ?? null
    };
  }
  if (config.capabilities?.session !== true) {
    return {kind: 'untested', usable: false};
  }
  return {kind: 'ready', usable: true};
}

export const __internal = {};
