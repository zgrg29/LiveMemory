import test from 'node:test';
import assert from 'node:assert/strict';
import {providerConfigState} from '../../src/web/js/pages/ai-config-state.js';

const base = {
  hasCredential: true,
  pricingStatus: 'paid',
  pricing: {currency: 'USD', inputPerMillion: 1, outputPerMillion: 2},
  capabilities: {session: true, memory: true},
  lastTestStatus: {status: 'passed'}
};

test('a missing configuration is distinct from a missing key', () => {
  assert.equal(providerConfigState(null).kind, 'none');
  assert.equal(providerConfigState({...base, hasCredential: false}).kind, 'missing_key');
});

test('a saved key is not reported as missing when the capability test is pending', () => {
  const state = providerConfigState({...base, capabilities: {}, lastTestStatus: {status: 'untested'}});
  assert.equal(state.kind, 'untested');
  assert.equal(state.usable, false);
});

test('a saved key with a failed test is a test failure, not a missing key', () => {
  const state = providerConfigState({
    ...base,
    lastTestStatus: {status: 'failed', error: 'auth failed'}
  });
  assert.equal(state.kind, 'test_failed');
  assert.equal(state.detail, 'auth failed');
});

test('a usable key is ready regardless of pricing or billing confirmation', () => {
  assert.deepEqual(providerConfigState(base), {
    kind: 'ready',
    usable: true
  });
  assert.equal(providerConfigState({...base, pricing: null}).kind, 'ready');
  assert.equal(providerConfigState({...base, pricingStatus: 'api_free'}).usable, true);
});
