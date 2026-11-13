import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

test('the report surface exposes a real reading-language selector and translation panel', () => {
  const report = read('src/web/js/pages/ai-report.js');
  const page = read('src/web/js/pages/ai.js');
  assert.ok(report.includes('report-language'), 'missing language selector block');
  assert.ok(report.includes('ai.report.languageTitle'), 'missing language label');
  assert.ok(report.includes('ai.report.languageSource'), 'missing original-language note');
  assert.ok(report.includes('ai.report.translationNotice'), 'missing provider/cost notice');
  assert.ok(report.includes('ai.report.translationConsent'), 'missing explicit cost consent');
  assert.ok(report.includes('ai.report.translationStart'), 'missing translate action');
  assert.ok(report.includes('ai.report.translationRetry'), 'missing retry action');
  assert.ok(report.includes('ai.report.translationRunning'), 'missing running progress');
  assert.ok(report.includes('ai.report.translationPartial'), 'missing partial failure state');
  assert.ok(report.includes('ai.report.translationShowOriginal'), 'missing original-view action');
  assert.ok(report.includes('updateTranslation'), 'report panel cannot update progress in place');
  assert.ok(page.includes('reportLocale'), 'page does not keep an independent reading locale');
  assert.ok(page.includes('/translation?locale='), 'page does not poll translation status');
  assert.ok(page.includes('api.post('), 'page does not start translation');
  assert.ok(page.includes('encodeURIComponent'), 'locale/session must be URL-encoded');
  assert.doesNotMatch(report, /innerHTML\s*=/, 'report must render text via textContent');
  assert.doesNotMatch(page, /innerHTML\s*=/, 'AI page must render text via textContent');
  // The analysis output language and the report reading language are separate
  // controls; neither is hardcoded to the UI locale.
  assert.ok(page.includes('languageSelect.value = locale'));
  assert.ok(page.includes('reportLocale = report.displayLocale'));
});

test('translation dictionaries are complete and keep placeholders identical', () => {
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    for (const key of [
      'languageTitle', 'languageHint', 'languageOriginalChip', 'languageTranslatedChip',
      'languageSource', 'languageUnavailable', 'translationNoticeTitle', 'translationNotice',
      'translationNoProvider', 'translationProvider', 'translationConsent', 'translationStart',
      'translationRetry', 'translationRunning', 'translationRunningHint', 'translationComplete',
      'translationPartial', 'translationFailed', 'translationCacheReuse', 'translationUnknownCost',
      'translationUsage', 'translationCost', 'translationSettings', 'translationShowOriginal'
    ]) {
      assert.equal(typeof dict.ai.report[key], 'string', `${locale} missing ai.report.${key}`);
      assert.ok(dict.ai.report[key].length > 0, `${locale} empty ai.report.${key}`);
    }
    assert.match(dict.ai.report.translationRunning, /\{done\}/);
    assert.match(dict.ai.report.translationRunning, /\{total\}/);
    assert.match(dict.ai.report.translationStart, /\{language\}/);
    assert.match(dict.ai.center.languageHint, /AI/);
    for (const key of [
      'translationUnavailable', 'translationLocaleInvalid', 'translationNotNeeded',
      'translationConsentRequired', 'translationProviderRequired', 'translationCredentialMissing',
      'translationAlreadyRunning', 'translationFailed'
    ]) {
      assert.equal(typeof dict.errors[key], 'string', `${locale} missing errors.${key}`);
    }
  }
});
