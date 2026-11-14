import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseBucketStep, computeTimeline} from '../../src/analytics/sessions/hotness.mjs';
import {groupCurrencyTotals} from '../../src/analytics/payments/totals.mjs';

const START = Date.parse('2026-11-08T10:00:00.000Z');

function row(offsetMs, overrides = {}) {
  return {
    occurred_at: START + offsetMs,
    event_type: 'chat',
    viewer_id: 'mock:a',
    is_paid: 0,
    amount_minor: null,
    currency: null,
    value_kind: 'unknown',
    ...overrides
  };
}

test('bucket size adapts to session length', () => {
  assert.equal(chooseBucketStep(5 * 60_000), 10_000);
  assert.equal(chooseBucketStep(40 * 60_000), 60_000);
  assert.equal(chooseBucketStep(6 * 60 * 60_000), 10 * 60_000);
  assert.ok(chooseBucketStep(0) >= 10_000);
});

test('timeline counts messages, unique viewers and payments per bucket', () => {
  const rows = [
    row(0, {viewer_id: 'mock:a'}),
    row(1_000, {viewer_id: 'mock:b'}),
    row(2_000, {viewer_id: 'mock:a'}),
    row(75_000, {viewer_id: 'mock:c'})
  ];
  const timeline = computeTimeline(rows, {startedAt: START, endedAt: START + 90_000, targetBuckets: 6});
  assert.equal(timeline.stepMs, 30_000);
  assert.equal(timeline.buckets.length, 3);
  assert.equal(timeline.buckets[0].messages, 3);
  assert.equal(timeline.buckets[0].uniqueViewers, 2);
  assert.equal(timeline.buckets[2].messages, 1);
  assert.equal(timeline.peakMessages, 3);
  assert.equal(timeline.peakBucketIndex, 0);
  assert.equal(timeline.durationMs, 90_000);
});

test('payments are grouped by currency and value kind inside buckets', () => {
  const rows = [
    row(0, {is_paid: 1, amount_minor: 500, currency: 'CNY', value_kind: 'actual'}),
    row(1_000, {is_paid: 1, amount_minor: 500, currency: 'CNY', value_kind: 'actual'}),
    row(2_000, {is_paid: 1, amount_minor: 1000, currency: 'JPY', value_kind: 'display'}),
    row(3_000, {is_paid: 0, amount_minor: 999, currency: 'CNY', value_kind: 'actual'})
  ];
  const timeline = computeTimeline(rows, {startedAt: START, endedAt: START + 60_000, targetBuckets: 4});
  const payments = timeline.buckets[0].payments;
  assert.equal(payments.length, 2);
  const cny = payments.find((entry) => entry.currency === 'CNY');
  assert.equal(cny.totalMinor, 1000);
  assert.equal(cny.eventCount, 2);
  assert.equal(payments.find((entry) => entry.currency === 'JPY').valueKind, 'display');
});

test('trimTrailingEmpty keeps a live chart from dropping to zero', () => {
  const rows = [row(0), row(11_000), row(21_000)];
  const timeline = computeTimeline(rows, {
    startedAt: START,
    endedAt: START + 300_000,
    targetBuckets: 30,
    trimTrailingEmpty: true
  });
  assert.equal(timeline.stepMs, 10_000);
  assert.equal(timeline.buckets.length, 3);
  assert.ok(timeline.buckets.at(-1).messages > 0);
  assert.equal(timeline.peakMessages, 1);
});

test('dropInProgressBucket removes the partially filled newest bucket', () => {
  const rows = [row(0), row(11_000), row(21_000), row(300_000)];
  const timeline = computeTimeline(rows, {
    startedAt: START,
    endedAt: START + 305_000,
    targetBuckets: 30,
    dropInProgressBucket: true
  });
  // The final bucket (300s..310s) is still in progress, so it is not drawn yet.
  assert.ok(timeline.buckets.every((bucket) => bucket.endAt <= START + 305_000));
  assert.equal(timeline.buckets.at(-1).messages, 0);
  assert.ok(timeline.buckets.length >= 2);
});

test('an empty session still produces a valid one bucket timeline', () => {
  const timeline = computeTimeline([], {startedAt: START, endedAt: START});
  assert.equal(timeline.buckets.length, 1);
  assert.equal(timeline.peakMessages, 0);
  assert.equal(timeline.peakBucketIndex, null);
});

test('currency totals keep actual and display values apart', () => {
  const grouped = groupCurrencyTotals([
    {currency: 'CNY', value_kind: 'actual', total_minor: 500, event_count: 2},
    {currency: 'CNY', value_kind: 'display', total_minor: 900, event_count: 1},
    {currency: 'JPY', value_kind: 'actual', total_minor: 1000, event_count: 1}
  ]);
  const cny = grouped.find((entry) => entry.currency === 'CNY');
  assert.equal(cny.actualMinor, 500);
  assert.equal(cny.displayMinor, 900);
  assert.equal(cny.eventCount, 3);
  assert.equal(grouped.find((entry) => entry.currency === 'JPY').actualMinor, 1000);
});
