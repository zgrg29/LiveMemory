import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokRateBudget, parseRateLimitHeaders} from '../../src/platforms/tiktok/rate-budget.mjs';

function headers(values) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {get: (name) => map.get(String(name).toLowerCase()) ?? null};
}

test('rate-limit headers are parsed without inventing a budget', () => {
  const at = 1_700_000_000_000;
  const parsed = parseRateLimitHeaders(headers({
    'ratelimit-limit': '30',
    'ratelimit-policy': '30;w=3600',
    'ratelimit-remaining': '0',
    'ratelimit-reset': '2708',
    'retry-after': '2708'
  }), {at});
  assert.equal(parsed.limit, 30);
  assert.equal(parsed.windowMs, 3_600_000);
  assert.equal(parsed.remaining, 0);
  assert.equal(parsed.resetAt, at + 2_708_000);
  assert.equal(parsed.retryAfterMs, 2_708_000);
  assert.equal(parseRateLimitHeaders(headers({}), {at}).limit, null);
});

test('a known budget spreads requests across the window instead of a 15 s burst', () => {
  let clock = 1_700_000_000_000;
  const budget = new TikTokRateBudget({now: () => clock, random: () => 0, minIntervalMs: 1000, safety: 1});
  budget.observe({limit: 30, windowMs: 3_600_000, remaining: 30, resetAt: clock + 3_600_000}, {at: clock});
  const first = budget.reserve({at: clock});
  assert.equal(first.allowed, true);
  assert.ok(first.intervalMs >= 100_000, `interval ${first.intervalMs}`);
  const tooSoon = budget.reserve({at: clock + 15_000});
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.reason, 'pacing');
  assert.ok(tooSoon.waitMs > 80_000);
  clock += first.intervalMs;
  assert.equal(budget.reserve({at: clock}).allowed, true);
});

test('an exhausted window waits for the advertised reset, not a 30 s retry', () => {
  let clock = 1_700_000_000_000;
  const budget = new TikTokRateBudget({now: () => clock, random: () => 0, minIntervalMs: 15_000});
  budget.observe({limit: 30, windowMs: 3_600_000, remaining: 0, resetAt: clock + 2_708_000}, {at: clock});
  const blocked = budget.reserve({at: clock + 30_000});
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'exhausted');
  assert.ok(blocked.waitMs > 2_600_000);
  // A 429 also blocks for the full advertised retry-after.
  const penalized = budget.penalize({retryAfterMs: 2_708_000, resetAt: clock + 2_708_000, at: clock});
  assert.equal(penalized.remaining, 0);
  const afterPenalty = budget.reserve({at: clock + 60_000});
  assert.equal(afterPenalty.allowed, false);
  assert.ok(afterPenalty.waitMs > 2_600_000);
});

test('the window rolls over after the reset and allows the next request', () => {
  let clock = 1_700_000_000_000;
  const budget = new TikTokRateBudget({now: () => clock, random: () => 0, minIntervalMs: 1000});
  budget.observe({limit: 2, windowMs: 60_000, remaining: 0, resetAt: clock + 60_000}, {at: clock});
  assert.equal(budget.reserve({at: clock + 59_000}).allowed, false);
  clock += 61_000;
  // At the reset the local remaining is restored from the advertised limit.
  const allowed = budget.reserve({at: clock});
  assert.equal(allowed.allowed, true);
});

test('one budget shared by two rooms serialises both requests (per-IP allowance)', () => {
  let clock = 1_700_000_000_000;
  const budget = new TikTokRateBudget({now: () => clock, random: () => 0, minIntervalMs: 1000, safety: 1});
  budget.observe({limit: 4, windowMs: 4000, remaining: 4, resetAt: clock + 4000}, {at: clock});
  const roomA = budget.reserve({at: clock});
  const roomB = budget.reserve({at: clock});
  assert.equal(roomA.allowed, true);
  assert.equal(roomB.allowed, false, 'the second room must not spend the same slot');
  assert.equal(roomB.reason, 'pacing');
});
