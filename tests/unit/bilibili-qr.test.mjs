import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';

/**
 * The QR login panel renders the code in the page with the vendored MIT
 * qrcode-generator (same library the reference project ships). These tests load
 * it headlessly and check the generated matrix, so a broken/truncated vendor
 * file or an incompatible API cannot silently break login.
 */
const vendorUrl = new URL('../../src/web/js/vendor/qrcode.js', import.meta.url);
const licenseUrl = new URL('../../src/web/js/vendor/qrcode.LICENSE.txt', import.meta.url);

function loadQr() {
  const source = readFileSync(vendorUrl, 'utf8');
  const sandbox = {window: {}, self: null, module: undefined, exports: undefined};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: 'qrcode.js'});
  return sandbox.qrcode;
}

function matrixFor(text) {
  const factory = loadQr();
  assert.equal(typeof factory, 'function');
  const qr = factory(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const cells = [];
    for (let col = 0; col < count; col += 1) cells.push(qr.isDark(row, col));
    rows.push(cells);
  }
  return {count, isDark: (r, c) => rows[r][c], rows};
}

function assertFinder(matrix, top, left) {
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const edge = row === 0 || row === 6 || col === 0 || col === 6;
      const ring = row === 1 || row === 5 || col === 1 || col === 5;
      const expected = edge || (!ring && row >= 2 && row <= 4 && col >= 2 && col <= 4);
      assert.equal(matrix.isDark(top + row, left + col), expected, `finder (${top},${left}) at ${row},${col}`);
    }
  }
}

test('the vendored QR generator is present and MIT licensed', () => {
  assert.ok(existsSync(vendorUrl));
  assert.ok(existsSync(licenseUrl));
  assert.match(readFileSync(licenseUrl, 'utf8'), /MIT/i);
  assert.equal(typeof loadQr(), 'function');
});

test('a Bilibili login URL produces a scannable QR matrix', () => {
  const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=bb6ccac80f87708810c9c161b1f6044d&from=';
  assert.ok(url.length > 100);
  const matrix = matrixFor(url);
  assert.ok(matrix.count >= 37, `module count ${matrix.count}`);
  assert.equal(matrix.count % 4, 1);
  assertFinder(matrix, 0, 0);
  assertFinder(matrix, 0, matrix.count - 7);
  assertFinder(matrix, matrix.count - 7, 0);
});

test('the same login URL always renders the same matrix', () => {
  const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=0123456789abcdef';
  const first = matrixFor(url);
  const second = matrixFor(url);
  assert.equal(first.count, second.count);
  assert.deepEqual(first.rows, second.rows);
});

test('longer login URLs still encode', () => {
  const url = `https://account.bilibili.com/h5/account-h5/auth/scan-web?${'k'.repeat(200)}`;
  const matrix = matrixFor(url);
  assert.ok(matrix.count >= 41);
  assert.equal(matrix.count % 4, 1);
});
