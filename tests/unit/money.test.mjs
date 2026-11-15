import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currencyDigits,
  formatMinorAmount,
  multiplyMinor,
  parseAmountToMinor
} from '../../src/shared/money.mjs';

test('parses two-decimal currencies into integer minor units', () => {
  assert.equal(parseAmountToMinor('12.34', 'CNY'), 1234);
  assert.equal(parseAmountToMinor('0.1', 'CNY'), 10);
  assert.equal(parseAmountToMinor('1', 'CNY'), 100);
  assert.equal(parseAmountToMinor('1,200.00', 'CNY'), 120000);
  assert.equal(parseAmountToMinor(12.34, 'CNY'), 1234);
  assert.equal(parseAmountToMinor('¥30', 'CNY'), 3000);
});

test('parses zero-decimal currencies without inventing fractions', () => {
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(parseAmountToMinor('500', 'JPY'), 500);
  assert.equal(parseAmountToMinor('500 円', 'JPY'), 500);
  assert.equal(formatMinorAmount(500, 'JPY'), '500');
});

test('rounds extra decimals half away from zero', () => {
  assert.equal(parseAmountToMinor('1.005', 'CNY'), 101);
  assert.equal(parseAmountToMinor('1.004', 'CNY'), 100);
  assert.equal(parseAmountToMinor('0.999', 'JPY'), 1);
});

test('rejects unusable amounts instead of silently storing zero', () => {
  assert.equal(parseAmountToMinor('', 'CNY'), null);
  assert.equal(parseAmountToMinor(null, 'CNY'), null);
  assert.equal(parseAmountToMinor('abc', 'CNY'), null);
  assert.equal(parseAmountToMinor(Number.NaN, 'CNY'), null);
  assert.equal(parseAmountToMinor(Number.POSITIVE_INFINITY, 'CNY'), null);
});

test('formats minor units back to exact decimal strings', () => {
  assert.equal(formatMinorAmount(1234, 'CNY'), '12.34');
  assert.equal(formatMinorAmount(10, 'CNY'), '0.10');
  assert.equal(formatMinorAmount(0, 'USD'), '0.00');
  assert.equal(formatMinorAmount(null, 'CNY'), null);
});

test('multiplication stays exact and refuses unknown unit prices', () => {
  assert.equal(multiplyMinor(10, 3), 30);
  assert.equal(multiplyMinor(100, 5), 500);
  assert.equal(multiplyMinor(null, 3), null);
  assert.equal(multiplyMinor(10, 0), null);
  assert.equal(multiplyMinor(10, -2), null);
});
