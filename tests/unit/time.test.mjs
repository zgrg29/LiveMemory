import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDuration, isoFromEpochMs, MINUTE, toEpochMs} from '../../src/shared/time.mjs';

test('toEpochMs accepts ISO strings, seconds and milliseconds', () => {
  assert.equal(toEpochMs('2026-11-08T10:00:00.000Z'), Date.parse('2026-11-08T10:00:00.000Z'));
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs('1700000000'), 1_700_000_000_000);
  assert.equal(toEpochMs(new Date(1000)), 1000);
});

test('toEpochMs returns the fallback for unusable values', () => {
  assert.equal(toEpochMs(null, 7), 7);
  assert.equal(toEpochMs('not a date', 9), 9);
  assert.equal(toEpochMs(Number.NaN, 11), 11);
  assert.equal(toEpochMs(undefined, null), null);
});

test('isoFromEpochMs round-trips', () => {
  const ms = Date.parse('2026-01-02T03:04:05.000Z');
  assert.equal(isoFromEpochMs(ms), '2026-01-02T03:04:05.000Z');
  assert.equal(isoFromEpochMs(null), null);
});

test('formatDuration is human readable and never negative', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(2 * MINUTE + 5000), '2m 05s');
  assert.equal(formatDuration(3 * 60 * MINUTE), '3h 00m');
  assert.equal(formatDuration(-100), '0s');
});
