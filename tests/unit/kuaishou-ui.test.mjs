import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const liveSource = read('src/web/js/pages/live.js');
const routesSource = read('src/server/routes.mjs');
const buildSource = read('scripts/build-windows.mjs');
const policySource = read('src/platforms/kuaishou/policy.mjs');
const serviceSource = read('src/platforms/kuaishou/service.mjs');
const locales = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

const KUAISHOU_SOURCE_KEYS = [
  'live.source.kuaishouTab',
  'live.source.kuaishouIntro',
  'live.source.kuaishouNotice',
  'live.source.kuaishouNoLoginNote',
  'live.source.kuaishouUnofficialNote',
  'live.source.kuaishouLinkLabel',
  'live.source.kuaishouLinkPlaceholder',
  'live.source.kuaishouCheck',
  'live.source.kuaishouEid',
  'live.source.kuaishouCaptureTitle',
  'live.source.kuaishouActiveTitle',
  'live.source.kuaishouAccessTitle',
  'live.source.kuaishouAccessRequired',
  'live.source.kuaishouAccessEnabled',
  'live.source.kuaishouIdentityNote',
  'live.source.kuaishouMessageIdNote',
  'live.source.kuaishouGiftNote',
  'live.source.kuaishouStatusUnknown',
  'live.source.kuaishouPolicyBody',
  'live.source.kuaishouRetentionApplied',
  'live.source.kuaishouStartDisabled',
  'live.source.kuaishouCaptureNotCompleteNote',
  'live.source.kuaishouTechnicalCounters',
  'live.source.kuaishouTechnicalIdentity'
];

const KUAISHOU_ERROR_KEYS = [
  'errors.kuaishouLinkInvalid',
  'errors.kuaishouAuthorizationRequired',
  'errors.kuaishouAccessDenied',
  'errors.kuaishouRoomOffline',
  'errors.kuaishouRoomNotFound',
  'errors.kuaishouRateLimit',
  'errors.kuaishouNetwork',
  'errors.kuaishouProtocol',
  'errors.kuaishouStatusUnknown',
  'errors.kuaishouConnectTimeout',
  'errors.kuaishouNotConfigured',
  'errors.kuaishouStopped',
  'errors.kuaishouError'
];

function get(dict, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), dict);
}

test('the live page has a Kuaishou tab, an always-visible disclosure and a disabled-by-default capture panel', () => {
  assert.match(liveSource, /kuaishouTab/);
  assert.match(liveSource, /buildKuaishouPanel/);
  assert.match(liveSource, /\/api\/kuaishou\/status/);
  assert.match(liveSource, /\/api\/kuaishou\/room/);
  assert.match(liveSource, /\/api\/kuaishou\/connect/);
  assert.match(liveSource, /\/api\/kuaishou\/disconnect/);
  assert.match(liveSource, /\/api\/kuaishou\/retention\/apply/);
  assert.match(liveSource, /live\.source\.kuaishouNotice/);
  assert.match(liveSource, /live\.source\.kuaishouAccessRequired/);
  assert.match(liveSource, /live\.source\.kuaishouIdentityNote/);
  assert.match(liveSource, /live\.source\.kuaishouGiftNote/);
  assert.match(liveSource, /kuaishouAutoMonitor/);
  assert.match(liveSource, /autoMonitorToggle\('kuaishou'/);
});

test('the required Kuaishou disclosure is exact in Simplified Chinese', () => {
  const dict = JSON.parse(read('src/web/i18n/zh-CN.json'));
  assert.equal(
    dict.live.source.kuaishouNotice,
    '快手平台对未经授权的自动数据采集存在限制。LiveMemory 并非快手官方产品。使用者应遵守快手平台协议，并确保拥有必要的数据访问权限。第三方接口可能随时变更或停止服务。'
  );
  for (const other of locales.filter((locale) => locale !== 'zh-CN')) {
    const translated = JSON.parse(read(`src/web/i18n/${other}.json`)).live.source.kuaishouNotice;
    assert.equal(typeof translated, 'string');
    assert.ok(translated.length > 80, `${other} notice must remain a full disclosure`);
    assert.match(translated, /LiveMemory/, `${other} notice names LiveMemory`);
    assert.match(translated, /Kuaishou|快手/, `${other} notice names the platform`);
  }
});

test('every shipped dictionary has the Kuaishou UI and error keys', () => {
  for (const locale of locales) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    for (const key of [...KUAISHOU_SOURCE_KEYS, ...KUAISHOU_ERROR_KEYS]) {
      const value = get(dict, key);
      assert.equal(typeof value, 'string', `${locale} ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
    }
    assert.equal(typeof get(dict, 'monitoring.add.kuaishouPlaceholder'), 'string', `${locale} placeholder`);
    assert.equal(typeof get(dict, 'monitoring.add.kuaishouLabel'), 'string', `${locale} label`);
    assert.equal(typeof get(dict, 'common.platform.kuaishou'), 'string', `${locale} platform label`);
  }
});

test('the server registers Kuaishou routes and a preview capability, never a supported claim', () => {
  assert.match(routesSource, /path: '\/api\/kuaishou\/status'/);
  assert.match(routesSource, /path: '\/api\/kuaishou\/room'/);
  assert.match(routesSource, /path: '\/api\/kuaishou\/connect'/);
  assert.match(routesSource, /path: '\/api\/kuaishou\/disconnect'/);
  assert.match(routesSource, /id: 'kuaishou'/);
  assert.match(routesSource, /state: 'preview'/);
  assert.match(routesSource, /mode: 'anonymous-h5'/);
  assert.match(routesSource, /captureEnabled: false/);
  assert.match(routesSource, /authorizationRequired: true/);
  assert.match(routesSource, /gifts: 'not-observed'/);
  assert.match(routesSource, /likes: 'not-observed'/);
});

test('collection is gated in code and defaults to disabled', () => {
  assert.match(policySource, /LIVEMEMORY_KUAISHOU_H5_OPT_IN/);
  assert.match(policySource, /LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK/);
  assert.match(policySource, /const enabled = optIn && ack\.length >= 3/);
  assert.match(serviceSource, /assertCollectionAllowed\(this\.access\)/);
  assert.match(serviceSource, /captureWithoutAuthorization: false/);
});

test('the Windows build requires every Kuaishou module so the EXE cannot silently miss them', () => {
  for (const module of [
    'src/platforms/kuaishou/adapter.mjs',
    'src/platforms/kuaishou/errors.mjs',
    'src/platforms/kuaishou/http.mjs',
    'src/platforms/kuaishou/link.mjs',
    'src/platforms/kuaishou/messages.mjs',
    'src/platforms/kuaishou/policy.mjs',
    'src/platforms/kuaishou/service.mjs',
    'src/platforms/kuaishou/status.mjs',
    'src/platforms/kuaishou/transport.mjs',
    'src/monitoring/detectors/kuaishou.mjs'
  ]) {
    assert.ok(buildSource.includes(module), `build requires ${module}`);
  }
});
