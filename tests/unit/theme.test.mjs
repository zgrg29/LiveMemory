import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTheme, resolveTheme, THEMES} from '../../src/shared/theme.mjs';
import {
  normalizeStorageMode,
  DEFAULT_STORAGE_MODE,
  STORAGE_MODES
} from '../../src/shared/storage-mode.mjs';

test('theme preference accepts exactly the three documented values', () => {
  assert.deepEqual([...THEMES], ['system', 'light', 'dark']);
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('LIGHT'), 'light');
  assert.equal(normalizeTheme('system'), 'system');
  assert.equal(normalizeTheme('sepia'), 'system');
  assert.equal(normalizeTheme(null), 'system');
});

test('resolved theme follows the system only when the preference is "system"', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('nonsense', true), 'dark');
});

test('storage mode defaults to compact and rejects unknown values', () => {
  assert.deepEqual([...STORAGE_MODES], ['compact', 'full']);
  assert.equal(DEFAULT_STORAGE_MODE, 'compact');
  assert.equal(normalizeStorageMode('full'), 'full');
  assert.equal(normalizeStorageMode('archive'), 'compact');
  assert.equal(normalizeStorageMode(null), 'compact');
});
