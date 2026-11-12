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

test('the AI centre exposes exactly one API-key analysis flow', () => {
  const source = read('src/web/js/pages/ai.js');
  for (const endpoint of [
    '/api/ai/providers',
    '/api/ai/analyze/run',
    '/api/ai/analyze/status',
    '/api/ai/analyze/pause',
    '/api/ai/analyze/cancel',
    '/api/ai/analyze/resume',
    '/api/ai/sessions/'
  ]) {
    assert.ok(source.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  assert.ok(source.includes('ai.center.start'), 'missing single start action');
  assert.ok(source.includes('ai.center.scopeLabel'), 'missing scope selection');
  assert.ok(source.includes('ai.center.scaleTitle'), 'missing task-size / cost review');
  assert.ok(source.includes("query?.get('session')"), 'missing stable session query selection');
  assert.ok(source.includes('syncUrl()'), 'missing URL state restore');
  assert.ok(source.includes('history.replaceState'), 'missing manual-selection URL update');
  assert.ok(source.includes('statusEpoch'), 'missing stale status response guard');
  assert.ok(source.includes('reportEpoch'), 'missing stale report response guard');
  assert.equal((source.match(/reportHost\.append/g) ?? []).length, 1, 'report must be mounted in exactly one place');
  assert.ok(source.includes('analysis-progress'), 'missing progress bar');
  assert.ok(source.includes('buildAnalysisProgress'), 'missing counted progress calculation');
  assert.ok(source.includes('configWarning'), 'missing config-state warning');
  assert.ok(source.includes("providerConfigState"), 'missing config state helper');
  assert.ok(source.includes('memorySkipped'), 'missing skipped-memory status');
  assert.doesNotMatch(source, /ai\.v13\.billing\.confirm/, 'spend confirmation must be gone');
  assert.doesNotMatch(source, /budgetInput|budgetPayload/, 'per-task budget UI must be gone');
  assert.doesNotMatch(source, /optInMemory/, 'billing/price opt-in must be gone');
  assert.ok(source.includes('requestStats'), 'missing local request statistics');
  assert.ok(source.includes('estimatedRemainingMs'), 'missing ETA support');
  assert.doesNotMatch(source, /\bwindow\.alert\s*\(/, 'must not use browser alert()');
  assert.doesNotMatch(source, /type: 'file'/, 'manual file import must be gone');
  assert.doesNotMatch(source, /textarea/, 'manual JSON paste box must be gone');
  assert.doesNotMatch(source, /\/api\/ai\/import/, 'manual import endpoint must be gone');
  assert.doesNotMatch(source, /\/api\/ai\/instructions/, 'prompt copying must be gone');
  assert.doesNotMatch(source, /\/api\/ai\/auto\//, 'anonymous auto route must be gone');
  assert.doesNotMatch(source, /methodSelect|runMethod/, 'manual/anonymous method selector must be gone');
  assert.doesNotMatch(source, /ai\.auto\./, 'free-auto copy must be gone');

  const routes = read('src/server/routes.mjs');
  for (const path of [
    "path: '/api/ai/analyze/run'",
    "path: '/api/ai/analyze/status'",
    "path: '/api/ai/analyze/pause'",
    "path: '/api/ai/analyze/cancel'",
    "path: '/api/ai/analyze/resume'",
    "path: '/api/ai/sessions/:id/report'",
    "path: '/api/ai/results/:id'",
    "path: '/api/ai/results/:id/download'"
  ]) {
    assert.ok(routes.includes(path), `missing route ${path}`);
  }
  for (const removed of [
    "path: '/api/ai/auto/services'",
    "path: '/api/ai/auto/status'",
    "path: '/api/ai/auto/run'",
    "path: '/api/ai/auto/cancel'",
    "path: '/api/ai/import/preview'",
    "path: '/api/ai/import'",
    "path: '/api/ai/instructions'",
    "path: '/api/ai/packages/:id/download'",
    "path: '/api/ai/jobs/:id/aggregate'"
  ]) {
    assert.ok(!routes.includes(removed), `removed route still present: ${removed}`);
  }
  const server = read('src/server/index.mjs');
  assert.ok(!server.includes('AutoAnalysisRunner'));
  assert.ok(server.includes('instance.analysisRunner?.shutdown()'));
});

test('the unified AI centre has complete Chinese, Japanese and English copy', () => {
  const keys = [
    'ai.center.stepSession',
    'ai.center.stepConfig',
    'ai.center.stepScope',
    'ai.center.stepStart',
    'ai.center.setupTitle',
    'ai.center.sessionLabel',
    'ai.center.languageLabel',
    'ai.center.configLabel',
    'ai.center.scopeLabel',
    'ai.center.openSettings',
    'ai.center.noConfig',
    'ai.center.scaleTitle',
    'ai.center.scaleMessages',
    'ai.center.scaleViewers',
    'ai.center.scaleRequests',
    'ai.center.start',
    'ai.center.starting',
    'ai.center.configLoadFailed',
    'ai.center.configMissingKey',
    'ai.center.configTestFailed',
    'ai.center.configUntested',
    'ai.center.progressSession',
    'ai.center.progressMemory',
    'ai.center.progressViewers',
    'ai.center.progressMemorySkipped',
    'ai.center.progressIndeterminate',
    'ai.center.memorySkipped',
    'ai.center.reason.ANALYSIS_MEMORY_NO_VIEWERS',
    'ai.center.statusTitle',
    'ai.center.complete',
    'ai.center.failed',
    'ai.center.canceled',
    'ai.center.consentTitle',
    'ai.center.consentBody',
    'ai.center.consentContinue',
    'ai.center.stats.total',
    'ai.center.stats.done',
    'ai.center.stats.failed',
    'ai.center.stats.active',
    'ai.center.stats.queued',
    'ai.center.stats.modelTime',
    'ai.center.stats.queueWait',
    'ai.center.stats.throttleWait',
    'ai.center.stats.rateLimited',
    'ai.center.stats.tokens',
    'ai.center.stats.cost',
    'ai.center.stats.eta',
    'ai.center.reason.ANALYSIS_MEMORY_OUT_OF_ORDER',
    'ai.center.reason.PROVIDER_RATE_LIMITED',
    'ai.center.reason.AI_PROVIDER_CONFIG_REQUIRED',
    'ai.center.task.elapsed',
    'ai.center.task.waitingAggregate',
    'ai.center.task.needsAction',
    'ai.center.needsAction',
    'ai.v13.price.optional',
    'ai.v13.providers.concurrency',
    'ai.v13.providers.concurrencyHint',
    'ai.report.sourceAuto',
    'errors.aiProviderConfigRequired'
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
    assert.equal(dict.ai.auto, undefined, `${locale} still contains removed free-auto copy`);
    assert.equal(dict.ai.v13.method, undefined, `${locale} still contains removed manual/anonymous methods`);
  }
});

test('the history and report surfaces still read saved analyses without a manual import UI', () => {
  const source = read('src/web/js/pages/history.js');
  assert.ok(source.includes('/api/ai/sessions/'));
  assert.ok(source.includes('aiViewReport'));
  assert.ok(source.includes('ai-report-summary'));
  const shared = read('src/web/js/pages/shared.js');
  assert.match(shared, /aiStatus === 'partial'/);
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
