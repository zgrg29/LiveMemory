import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

test('AI pages never inject HTML or execute AI content', () => {
  for (const file of ['src/web/js/pages/ai.js', 'src/web/js/pages/ai-report.js', 'src/web/js/pages/history.js', 'src/web/js/pages/ai-settings.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /insertAdjacentHTML/, `${file} must not use insertAdjacentHTML`);
    assert.doesNotMatch(source, /outerHTML\s*=/, `${file} must not assign outerHTML`);
    assert.doesNotMatch(source, /document\.write/, `${file} must not use document.write`);
    assert.doesNotMatch(source, /\beval\s*\(/, `${file} must not eval`);
    assert.doesNotMatch(source, /new Function\s*\(/, `${file} must not build functions from strings`);
  }
  const report = read('src/web/js/pages/ai-report.js');
  assert.match(report, /text: ref\.content/, 'AI evidence is rendered as text');
  assert.match(report, /evidenceUnavailable/);
  assert.match(report, /evidencePurged/);
  assert.match(report, /clipNotice/, 'clip suggestions must state that no video was analysed');
});

test('the AI centre wires the complete manual round trip', () => {
  const source = read('src/web/js/pages/ai.js');
  for (const endpoint of [
    '/api/ai/jobs',
    '/api/ai/instructions',
    '/api/ai/import/preview',
    '/api/ai/import',
    '/api/ai/sessions/'
  ]) {
    assert.ok(source.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  assert.match(source, /type: 'file'/);
  assert.match(source, /textarea/);
  assert.match(source, /confirmVersion/);
  assert.match(source, /fileTooLarge/);
  assert.match(source, /setPreview|previewTarget|import-target/);
  const routes = read('src/server/routes.mjs');
  for (const path of [
    "path: '/api/ai/jobs'",
    "path: '/api/ai/jobs/:id'",
    "path: '/api/ai/jobs/:id/aggregate'",
    "path: '/api/ai/import/preview'",
    "path: '/api/ai/import'",
    "path: '/api/ai/sessions/:id/report'",
    "path: '/api/ai/results/:id'",
    "path: '/api/ai/results/:id/download'"
  ]) {
    assert.ok(routes.includes(path), `missing route ${path}`);
  }
});

test('the automatic analysis entry point is wired without replacing manual controls', () => {
  const source = read('src/web/js/pages/ai.js');
  assert.ok(source.includes('autoButton'), 'missing automatic button');
  assert.ok(source.includes('startAuto'), 'missing start handler');
  assert.ok(source.includes('refreshAutoStatus'), 'missing progress polling');
  assert.ok(source.includes('cancelAuto'), 'missing cancel handler');
  assert.ok(source.includes("AUTO_CONSENT_KEY = 'livememory.aiAutoConsent.v1'"), 'missing first-use consent');
  assert.ok(source.includes('ai.auto.error.summary'), 'missing simple failure message');
  assert.ok(source.includes('ai.auto.status.'), 'missing real stage labels');
  assert.doesNotMatch(source, /\bwindow\.alert\s*\(/, 'must not use browser alert()');
  assert.doesNotMatch(source, /innerHTML\s*=/, 'automatic UI must stay text-only');
  // The manual create/import controls must remain in the same page.
  assert.ok(source.includes('ai.setup.create'));
  assert.ok(source.includes('ai.import.validate'));
  assert.ok(source.includes('createButton.addEventListener'));
  assert.ok(source.includes('validateButton.addEventListener'));

  const routes = read('src/server/routes.mjs');
  for (const path of [
    "path: '/api/ai/auto/services'",
    "path: '/api/ai/auto/status'",
    "path: '/api/ai/auto/run'",
    "path: '/api/ai/auto/cancel'"
  ]) {
    assert.ok(routes.includes(path), `missing automatic route ${path}`);
  }
  const server = read('src/server/index.mjs');
  assert.ok(server.includes('AutoAnalysisRunner'));
  assert.ok(server.includes('instance.auto?.shutdown()'));
  const config = read('src/ai/auto/config.mjs');
  assert.ok(config.includes("id: 'ovh-gpt-oss-20b'"));
  assert.doesNotMatch(config, /id: '(murakumo|llmfaucet|llm7|pollinations)/i, 'unverified services must not enter the fallback list');
});

test('automatic analysis exposes the exact simple failure copy in three languages', () => {
  const expected = {
    'zh-CN': '目前免费 AI 自动分析暂时不可用，请使用下方的手动 AI 分析功能。',
    ja: '現在、無料AI自動分析は利用できません。下の手動AI分析機能をご利用ください。',
    en: 'Free automatic AI analysis is currently unavailable. Please use the manual AI analysis option below.'
  };
  for (const [locale, text] of Object.entries(expected)) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    assert.equal(dict.ai.auto.error.summary, text);
    for (const key of [
      'ai.auto.button',
      'ai.auto.buttonBusy',
      'ai.auto.status.preparing',
      'ai.auto.status.connecting',
      'ai.auto.status.analyzing',
      'ai.auto.status.validating',
      'ai.auto.status.updating',
      'ai.auto.status.aggregating',
      'ai.auto.status.complete',
      'ai.auto.consentBody',
      'ai.auto.details',
      'ai.auto.reason.AUTO_PROVIDER_UNAVAILABLE',
      'ai.auto.reason.AUTO_RATE_LIMITED',
      'ai.auto.reason.AUTO_INVALID_JSON',
      'ai.auto.reason.AUTO_TIMEOUT',
      'ai.auto.reason.AUTO_ALL_PROVIDERS_FAILED',
      'ai.auto.reason.AUTO_CONTEXT_TOO_LARGE'
    ]) {
      const parts = key.split('.');
      let node = dict;
      for (const part of parts) {
        assert.ok(node && typeof node === 'object' && part in node, `${locale} missing ${key}`);
        node = node[part];
      }
      assert.equal(typeof node, 'string');
      assert.ok(node.trim().length > 0);
    }
  }
});

test('the history detail surfaces the AI report instead of pretending analysis is missing', () => {
  const source = read('src/web/js/pages/history.js');
  assert.ok(source.includes('/api/ai/sessions/'));
  assert.ok(source.includes('aiViewReport'));
  assert.ok(source.includes('ai-report-summary'));
  assert.ok(source.includes('ai.report.incompleteTitle'));
  const shared = read('src/web/js/pages/shared.js');
  assert.match(shared, /aiStatus === 'partial'/);
});

test('all M6 interface strings exist in Chinese, Japanese and English', () => {
  const keys = [
    'ai.report.title',
    'ai.report.aiBadge',
    'ai.report.summaryTitle',
    'ai.report.topicsTitle',
    'ai.report.sentimentTitle',
    'ai.report.disputesTitle',
    'ai.report.highlightsTitle',
    'ai.report.clipNotice',
    'ai.report.evidenceTitle',
    'ai.report.evidenceUnavailable',
    'ai.report.evidencePurged',
    'ai.report.incompleteTitle',
    'ai.report.partialBatchTitle',
    'ai.report.provenanceTitle',
    'ai.report.sampleSize',
    'ai.report.tone.positive',
    'ai.report.tone.mixed',
    'ai.import.title',
    'ai.import.validate',
    'ai.import.previewTitle',
    'ai.import.errorsTitle',
    'ai.import.warningsTitle',
    'ai.import.confirm',
    'ai.import.confirmVersion',
    'ai.import.duplicateTitle',
    'ai.import.versionTitle',
    'ai.import.successTitle',
    'ai.import.field',
    'ai.import.reason.INVALID_JSON',
    'ai.import.reason.SCHEMA_REQUIRED',
    'ai.import.reason.MESSAGE_REF_UNKNOWN',
    'ai.import.reason.VIEWER_UNKNOWN',
    'ai.import.reason.AGGREGATE_NOT_READY',
    'ai.import.fix.missing',
    'ai.import.fix.message_ref',
    'ai.import.fix.viewer',
    'ai.import.fix.aggregate',
    'ai.job.status.awaiting_import',
    'ai.job.status.partial',
    'ai.job.status.awaiting_aggregate',
    'ai.job.status.complete',
    'ai.job.status.invalid',
    'ai.jobs.title',
    'ai.jobs.aggregate',
    'ai.jobs.reanalyze',
    'ai.jobs.batch',
    'ai.setup.title',
    'ai.setup.batchSize',
    'ai.setup.created',
    'history.detail.aiViewReport',
    'history.ai.partial',
    'history.ai.complete',
    'errors.aiImportInvalid',
    'errors.aiVersionRequired'
  ];
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    for (const key of keys) {
      const parts = key.split('.');
      let node = dict;
      for (const part of parts) {
        assert.ok(node && typeof node === 'object' && part in node, `${locale} missing ${key}`);
        node = node[part];
      }
      assert.equal(typeof node, 'string', `${locale}.${key} must be a string`);
      assert.ok(node.trim().length > 0, `${locale}.${key} must not be empty`);
    }
  }
});

test('the AI report separates AI output from local statistics and never claims video analysis', () => {
  const report = read('src/web/js/pages/ai-report.js');
  assert.match(report, /aiBadge/);
  assert.match(report, /AI output|deterministic local statistics/);
  const dictionaries = ['zh-CN', 'ja', 'en'].map((locale) => JSON.parse(read(`src/web/i18n/${locale}.json`)));
  for (const dict of dictionaries) {
    assert.match(dict.ai.report.clipNotice, /video|映像|视频/);
    assert.match(dict.ai.report.sentimentNote, /sarcasm|反讽|皮肉/i);
    assert.match(dict.ai.report.viewerProfilesNote, /broadcaster|主播|配信者/i);
  }
});
