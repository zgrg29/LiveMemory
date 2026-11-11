import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderRequestScheduler,
  retryDelayMs
} from '../../src/ai/runtime/scheduler.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('provider scheduler runs independent requests concurrently and never exceeds its limit', async () => {
  const scheduler = new ProviderRequestScheduler({
    key: 'config:test',
    initialConcurrency: 3,
    maxConcurrency: 3
  });
  let active = 0;
  let peak = 0;
  const started = Date.now();
  await Promise.all(Array.from({length: 9}, () => scheduler.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(15);
    active -= 1;
    return true;
  })));
  const elapsed = Date.now() - started;
  const stats = scheduler.stats();
  assert.equal(peak, 3);
  assert.equal(stats.total, 9);
  assert.equal(stats.completed, 9);
  assert.equal(stats.failed, 0);
  assert.equal(stats.active, 0);
  assert.equal(stats.concurrency, 3);
  // Nine 15 ms tasks at three-way concurrency take about 45 ms. The old free
  // route's 2 requests/60 s limiter would have taken more than four minutes.
  assert.ok(elapsed < 1000, `unexpected fixed rate-limit wait: ${elapsed} ms`);
});

test('a 429 reduces concurrency and pauses only that provider key', async () => {
  const limited = new ProviderRequestScheduler({
    key: 'config:limited',
    initialConcurrency: 4,
    maxConcurrency: 4
  });
  const other = new ProviderRequestScheduler({
    key: 'config:other',
    initialConcurrency: 2,
    maxConcurrency: 2
  });
  const events = [];
  const first = limited.run(async () => {
    events.push('limited:first');
    throw Object.assign(new Error('rate limited'), {status: 429, retryAfterMs: 120});
  }).catch(() => {});
  await first;
  assert.equal(limited.stats().concurrency, 2);
  assert.equal(limited.stats().rateLimited, 1);
  assert.ok(limited.stats().throttleRemainingMs > 0);

  const otherStart = Date.now();
  await other.run(async () => {
    events.push('other:fast');
    return true;
  });
  const otherElapsed = Date.now() - otherStart;
  assert.ok(otherElapsed < 100, `independent provider was blocked: ${otherElapsed} ms`);

  const limitedStart = Date.now();
  await limited.run(async () => true);
  const limitedElapsed = Date.now() - limitedStart;
  assert.ok(limitedElapsed >= 80, `Retry-After/cooldown was not honoured: ${limitedElapsed} ms`);
});

test('cancellation rejects a queued request instead of waiting for a slot', async () => {
  const scheduler = new ProviderRequestScheduler({
    key: 'config:cancel',
    initialConcurrency: 1,
    maxConcurrency: 1
  });
  const controller = new AbortController();
  const running = scheduler.run(() => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 200);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('ANALYSIS_CANCELED');
      error.code = 'ANALYSIS_CANCELED';
      reject(error);
    }, {once: true});
  }), {signal: controller.signal});
  await delay(10);
  const queued = scheduler.run(() => delay(10), {signal: controller.signal});
  controller.abort();
  await assert.rejects(queued, (error) => error?.code === 'ANALYSIS_CANCELED');
  await assert.rejects(running, (error) => error?.code === 'ANALYSIS_CANCELED');
});

test('retry backoff respects Retry-After and stays inside the bounded jitter range', () => {
  assert.equal(retryDelayMs(0, {retryAfterMs: 4200, random: () => 0}), 4200);
  assert.equal(retryDelayMs(5, {retryAfterMs: 999999, maxMs: 30000, random: () => 0.5}), 30000);
  const low = retryDelayMs(2, {baseMs: 1000, maxMs: 30000, random: () => 0});
  const high = retryDelayMs(2, {baseMs: 1000, maxMs: 30000, random: () => 0.999});
  assert.equal(low, 2000);
  assert.ok(high <= 4000 && high >= 2000, `unexpected backoff ${high}`);
});
