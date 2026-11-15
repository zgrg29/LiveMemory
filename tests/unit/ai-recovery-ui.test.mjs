import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const aiJs = readFileSync(join(ROOT, 'src/web/js/pages/ai.js'), 'utf8');
const pagesCss = readFileSync(join(ROOT, 'src/web/styles/pages.css'), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(join(ROOT, `src/web/i18n/${locale}.json`), 'utf8'));
}

test('the AI centre has an explicit recovery panel with a real backend action', () => {
  assert.match(aiJs, /recoveryPanel/);
  assert.match(aiJs, /renderRecovery\(current\)/);
  assert.match(aiJs, /resumeAggregate/);
  assert.match(aiJs, /resumeSession/);
  assert.match(aiJs, /resumeMemory/);
  assert.match(aiJs, /recoveryPrimary\.addEventListener\('click', activateRecovery\)/);
  assert.match(aiJs, /\/api\/ai\/analyze\/resume/);
  assert.match(aiJs, /noteAggregate/);
  // The old generic pause/resume toggle must not be the only recovery entry.
  assert.doesNotMatch(aiJs, /pauseButton\.textContent = canResume/);
  assert.match(aiJs, /pauseButton\.hidden = !running/);
  assert.match(aiJs, /errorMeta\.aggregateStage/);
  assert.match(aiJs, /errorMeta\.finishReason/);
  assert.match(pagesCss, /\.recovery-panel/);
  assert.match(pagesCss, /\.auto-status--warning/);
});

test('the recovery panel shows saved batches, the reason and the aggregate note', () => {
  assert.match(aiJs, /ai\.center\.recovery\.title/);
  assert.match(aiJs, /ai\.center\.recovery\.sessionSaved/);
  assert.match(aiJs, /ai\.center\.recovery\.aggregate/);
  assert.match(aiJs, /ai\.center\.recovery\.reason/);
  assert.match(aiJs, /noteKeys/);
  assert.match(aiJs, /aggregate: 'noteAggregate'/);
  assert.match(aiJs, /'resume-aggregate': 'resumeAggregate'/);
  assert.match(aiJs, /ai\.center\.stats\.apiNotAnalysis/);
  assert.match(aiJs, /ai\.center\.stats\.outputRejected/);
});

test('all three locales define the same recovery keys and the exact aggregate action', () => {
  const locales = ['zh-CN', 'ja', 'en'];
  const dictionaries = Object.fromEntries(locales.map((locale) => [locale, dictionary(locale)]));
  const expected = [
    'ai.center.incomplete',
    'ai.center.recovery.title',
    'ai.center.recovery.resumeAggregate',
    'ai.center.recovery.resumeSession',
    'ai.center.recovery.resumeMemory',
    'ai.center.recovery.noteAggregate',
    'ai.center.recovery.noteSession',
    'ai.center.recovery.noteMemory',
    'ai.center.recovery.valueSaved',
    'ai.center.stats.outputRejected',
    'ai.center.stats.apiNotAnalysis',
    'ai.center.errorMeta.aggregateStage',
    'ai.center.errorMeta.finishReason',
    'ai.center.errorMeta.actionResumeAggregate'
  ];
  for (const key of expected) {
    const values = locales.map((locale) => key.split('.').reduce((value, part) => value?.[part], dictionaries[locale]));
    for (const value of values) {
      assert.equal(typeof value, 'string', `${key} missing in one locale`);
      assert.ok(value.trim().length > 0, `${key} empty in one locale`);
    }
    assert.equal(new Set(values).size, 3, `${key} must be localized, not copied`);
  }
  assert.equal(
    dictionaries['zh-CN'].ai.center.recovery.resumeAggregate,
    '继续最终汇总'
  );
  assert.match(dictionaries['zh-CN'].ai.center.recovery.noteAggregate, /\{saved\}\/\{total\}/);
  assert.match(dictionaries['ja'].ai.center.recovery.noteAggregate, /\{saved\}\/\{total\}/);
  assert.match(dictionaries['en'].ai.center.recovery.noteAggregate, /\{saved\}\/\{total\}/);
  assert.match(dictionaries['zh-CN'].ai.center.reason.AUTO_OUTPUT_TRUNCATED, /继续/);
  assert.match(dictionaries['ja'].ai.center.reason.AUTO_OUTPUT_TRUNCATED, /続行/);
  assert.match(dictionaries['en'].ai.center.reason.AUTO_OUTPUT_TRUNCATED, /continuing/i);
});

test('the AI page never uses innerHTML or alert()', () => {
  assert.doesNotMatch(aiJs, /\.innerHTML\s*=/);
  assert.doesNotMatch(aiJs, /\balert\s*\(/);
});
