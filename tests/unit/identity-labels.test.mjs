import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * Structural guard for the identity-coverage labels and warnings.
 *
 * The counts must stay honest: a session whose messages mostly have no platform
 * UID may never present the identified-viewer count as total viewers, and every
 * page must show how many messages could not be attributed.
 */

const historySource = readFileSync(new URL('../../src/web/js/pages/history.js', import.meta.url), 'utf8');
const liveSource = readFileSync(new URL('../../src/web/js/pages/live.js', import.meta.url), 'utf8');
const aiSource = readFileSync(new URL('../../src/web/js/pages/ai.js', import.meta.url), 'utf8');
const actionsSource = readFileSync(new URL('../../src/web/js/session-actions.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/web/styles/pages.css', import.meta.url), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(new URL(`../../src/web/i18n/${locale}.json`, import.meta.url), 'utf8'));
}

test('all three locales label the metric as identified viewers, not total viewers', () => {
  const zh = dictionary('zh-CN');
  assert.equal(zh.live.stats.viewers, '可识别观众');
  assert.equal(zh.history.columns.viewers, '可识别观众');
  assert.equal(zh.history.manage.viewers, '可识别观众');
  assert.match(zh.live.stats.viewersSub, /UID/);
  assert.match(zh.live.identity.warningBody, /\{unidentified\}/);
  assert.match(zh.ai.center.identityWarning, /\{identified\}/);

  for (const locale of ['ja', 'en']) {
    const dict = dictionary(locale);
    for (const key of ['live.identity.warningTitle', 'live.identity.warningBody', 'history.identity.badge', 'ai.center.scaleUnidentified', 'ai.center.identityWarning', 'history.manage.unidentified']) {
      const value = key.split('.').reduce((node, part) => node?.[part], dict);
      assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
      assert.ok(value.length > 0, `${locale} has an empty ${key}`);
    }
  }
});

test('history shows the unidentified count per row and in the detail warning', () => {
  assert.match(historySource, /row\.unidentifiedMessageCount/);
  assert.match(historySource, /history\.identity\.badge/);
  assert.match(historySource, /history\.identity\.body/);
  assert.match(historySource, /stats\.unidentifiedMessages/);
  assert.match(css, /\.history-identity-warning/);
});

test('live and AI surfaces expose the same identity warning', () => {
  assert.match(liveSource, /summary\.stats\?\.unidentifiedMessages/);
  assert.match(liveSource, /live\.identity\.warningBody/);
  assert.match(liveSource, /session\.unidentifiedMessageCount/);
  assert.match(aiSource, /session\?\.unidentifiedMessageCount/);
  assert.match(aiSource, /ai\.center\.scaleUnidentified/);
  assert.match(aiSource, /ai\.center\.identityWarning/);
  assert.match(actionsSource, /history\.manage\.unidentified/);
});
