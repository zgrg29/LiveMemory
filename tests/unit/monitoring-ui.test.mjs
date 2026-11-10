import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MONITOR_ERROR, MONITOR_ERROR_KEYS, MONITOR_STATES} from '../../src/monitoring/constants.mjs';

/**
 * Structural guard for the persistent monitoring tabs.
 *
 * Behaviour is covered by the manager and HTTP integration tests. This file
 * catches the regressions that would silently break the product requirement:
 * a tab that only follows a single session, missing translations, hard-coded
 * colours, or reintroduced innerHTML.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const pagesCss = read('src/web/styles/pages.css');
const LOCALES = ['zh-CN', 'ja', 'en'];

function dictionary(locale) {
  return JSON.parse(read(`src/web/i18n/${locale}.json`));
}

function valueAt(object, key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

function literalKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bt\(\s*`([a-zA-Z0-9_.${}]+)`/g)) {
    // Only literal template keys are checked; the dynamic platform suffix is
    // asserted explicitly below.
    if (!match[1].includes('${')) keys.add(match[1]);
  }
  return [...keys];
}

test('every literal monitoring translation key exists in all three dictionaries', () => {
  for (const locale of LOCALES) {
    const dict = dictionary(locale);
    for (const key of literalKeys(liveSource)) {
      if (!key.startsWith('monitoring.') && !key.startsWith('errors.')) continue;
      const value = valueAt(dict, key);
      if (typeof value !== 'string') {
        // `monitoring.add.*Placeholder` keys are built dynamically and checked
        // separately; anything else must exist.
        assert.fail(`${locale} is missing ${key} (used in live.js)`);
      }
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('all monitor states and error codes have labels in every language', () => {
  for (const locale of LOCALES) {
    const dict = dictionary(locale);
    for (const state of MONITOR_STATES) {
      assert.equal(typeof valueAt(dict, `monitoring.state.${state}`), 'string', `${locale} missing state ${state}`);
    }
    for (const code of Object.values(MONITOR_ERROR)) {
      const key = MONITOR_ERROR_KEYS[code];
      assert.equal(typeof valueAt(dict, key), 'string', `${locale} missing ${key}`);
    }
    for (const platform of ['bilibili', 'youtube']) {
      for (const suffix of ['Placeholder', 'Label']) {
        assert.equal(
          typeof valueAt(dict, `monitoring.add.${platform}${suffix}`),
          'string',
          `${locale} missing monitoring.add.${platform}${suffix}`
        );
      }
    }
  }
});

test('the live page keeps monitor tabs independent from session tabs', () => {
  assert.match(liveSource, /\/api\/monitoring/);
  assert.match(liveSource, /selectedTargetId/);
  assert.match(liveSource, /appendMonitorTab/);
  assert.match(liveSource, /tabsHint/);
  // A monitored recording must not be rendered as a second session-only tab.
  assert.match(liveSource, /const manualRecordings = recordings\.filter/);
  assert.match(liveSource, /monitorTargetId/);
  // Selecting a target whose recording ended must return to the target view.
  assert.match(liveSource, /async function openTarget/);
  assert.match(liveSource, /openDeleteTargetDialog/);
  assert.doesNotMatch(liveSource, /innerHTML/);
});

test('monitor tab states have styles and the new styles use design tokens', () => {
  for (const state of ['waiting', 'checking', 'connecting', 'recording', 'reconnecting', 'ending', 'paused', 'error']) {
    assert.match(
      pagesCss,
      new RegExp(`\\.recording-tab-dot\\[data-state="${state}"\\]`),
      `missing tab style for ${state}`
    );
  }
  assert.match(pagesCss, /\.recording-tab-group--monitor/);
  assert.match(pagesCss, /\.monitor-toggle/);
  assert.match(pagesCss, /\.monitor-info-row/);
  assert.match(pagesCss, /\.monitor-session/);
  assert.match(pagesCss, /@media \(max-width: 700px\)[\s\S]*\.monitor-session/);
  // No literal colours in the monitoring block: only tokens.
  const block = pagesCss.slice(pagesCss.indexOf('automatic monitoring'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /rgba?\(/);
});
