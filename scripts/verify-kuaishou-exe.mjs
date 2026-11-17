#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {APP_VERSION} from '../src/shared/app-info.mjs';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Kuaishou preview EXE verification.
 *
 * The shipped EXE requests administrator rights; this script runs an asInvoker
 * copy (same build id) because an automated session cannot accept UAC. It checks
 * the parts that do not require written permission:
 *   - the preview is registered but collection is disabled by default;
 *   - link parsing works with no network request;
 *   - connect is refused with KUAISHOU_AUTHORIZATION_REQUIRED before any request;
 *   - all ten dictionaries and the mandatory disclosure are packaged;
 *   - the EXE embeds the required Kuaishou modules and build id.
 *
 * It does NOT claim a real Kuaishou capture acceptance.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-kuaishou-${stamp}`);
mkdirSync(root, {recursive: true});
if (!existsSync(distExe)) throw new Error(`shipped EXE not found: ${distExe}`);
const shippedBytes = readFileSync(distExe);
const buildInfo = JSON.parse(readFileSync('build/build-info.json', 'utf8'));
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});
const localAppData = join(root, 'localappdata');
const tempDir = join(root, 'temp');
mkdirSync(localAppData, {recursive: true});
mkdirSync(tempDir, {recursive: true});

const results = [];
const record = (name, passed, details = []) => {
  results.push({name, passed, details});
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`);
  for (const line of details) process.stdout.write(`      ${line}\n`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, {timeout = 25000, interval = 200} = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout${lastError ? `: ${lastError.message}` : ''}`);
}

function launch(args) {
  const stdout = join(root, 'stdout.log');
  const stderr = join(root, 'stderr.log');
  const bootstrapFile = join(root, 'bootstrap.url');
  try { rmSync(bootstrapFile, {force: true}); } catch { /* ignore */ }
  const child = spawn(exe, args, {
    cwd: root,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      TEMP: tempDir,
      TMP: tempDir,
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile,
      // Explicitly remove a potential internal opt-in so this verification can
      // prove the default (disabled) production state.
      LIVEMEMORY_KUAISHOU_H5_OPT_IN: '',
      LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK: ''
    },
    stdio: ['ignore', openSync(stdout, 'w'), openSync(stderr, 'w')],
    windowsHide: true
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = {code, signal}; });
  return {
    child,
    bootstrapFile,
    stdout: () => readFileSync(stdout, 'utf8'),
    stderr: () => readFileSync(stderr, 'utf8'),
    exitInfo: () => exitInfo,
    async stop() {
      if (exitInfo) return;
      child.kill('SIGKILL');
      await waitFor(() => exitInfo, {timeout: 8000}).catch(() => {});
    }
  };
}

function runtimeInfo(dataDir) {
  const file = join(dataDir, 'runtime', 'runtime.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

let cookie = null;
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? {cookie} : {})
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(8000)
  });
  return {status: response.status, json: await response.json().catch(() => null)};
}
async function getJson(url) {
  const response = await fetch(url, {
    headers: cookie ? {cookie} : {},
    signal: AbortSignal.timeout(8000)
  });
  return {status: response.status, json: await response.json().catch(() => null)};
}

async function authenticate(baseUrl, bootstrapFile) {
  const browserUrl = await waitFor(() => {
    if (!bootstrapFile || !existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeout: 15000});
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await fetch(new URL('/api/auth/session', baseUrl), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)}),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie.startsWith('lm_session=')) throw new Error('no session cookie');
}

const dataDir = join(root, 'data');
const app = launch(['--no-open', '--data-dir', dataDir, '--port', '49180', '--lang', 'en']);
try {
  const info = await waitFor(async () => {
    const runtime = runtimeInfo(dataDir);
    if (!runtime?.url) return null;
    const health = await getJson(new URL('/api/health', runtime.url).href);
    if (health.status !== 200 || health.json?.name !== 'LiveMemory') return null;
    await authenticate(runtime.url, app.bootstrapFile);
    return runtime;
  });
  const base = info.url;

  record('the shipped EXE requests administrator rights', manifestLevel(shippedBytes) === 'requireAdministrator', [
    `manifest: ${manifestLevel(shippedBytes)}`,
    `test copy: ${exe} (asInvoker, same build id)`
  ]);

  const health = await getJson(new URL('/api/health', base).href);
  record('the packaged server starts and reports the current version', health.json?.version === APP_VERSION, [
    `health ${health.status}, version ${health.json?.version ?? 'missing'}, expected ${APP_VERSION}`
  ]);

  const bootstrap = await getJson(new URL('/api/bootstrap', base).href);
  const capability = (bootstrap.json?.capabilities?.platforms ?? []).find((entry) => entry.id === 'kuaishou');
  record('the Kuaishou preview is registered with capture disabled', Boolean(capability)
    && capability.state === 'preview'
    && capability.captureEnabled === false
    && capability.authorizationRequired === true
    && capability.unofficial === true
    && JSON.stringify(capability.events) === JSON.stringify(['chat']), [
    `capability: ${JSON.stringify(capability)}`
  ]);

  const status = await getJson(new URL('/api/kuaishou/status', base).href);
  record('the production access gate is closed in the packaged EXE', status.status === 200
    && status.json?.access?.enabled === false
    && status.json?.access?.authorizationRequired === true
    && status.json?.transport?.authorizationRequired === true
    && status.json?.capabilities?.gifts === 'not-observed'
    && status.json?.capabilities?.likes === 'not-observed'
    && status.json?.capabilities?.stableUserId === 'unproven', [
    `access: ${JSON.stringify(status.json?.access)}`,
    `capabilities: ${JSON.stringify(status.json?.capabilities)}`
  ]);

  const parsed = await postJson(new URL('/api/kuaishou/room', base).href, {
    url: 'https://live.kuaishou.com/u/abc12345'
  });
  record('link parsing works without authorisation and makes clear that recording is disabled', parsed.status === 200
    && parsed.json?.room?.eid === 'abc12345'
    && parsed.json?.room?.recordable === false
    && parsed.json?.room?.reason === 'KUAISHOU_AUTHORIZATION_REQUIRED', [
    `room: ${JSON.stringify(parsed.json?.room)}`
  ]);

  const invalid = await postJson(new URL('/api/kuaishou/room', base).href, {
    url: 'https://www.kuaishou.com/short-video/3xabc'
  });
  record('a non-live Kuaishou URL is rejected with a translated error key', invalid.status === 400
    && invalid.json?.error?.messageKey === 'errors.kuaishouLinkInvalid', [
    `status ${invalid.status}, messageKey ${invalid.json?.error?.messageKey}`
  ]);

  const refused = await postJson(new URL('/api/kuaishou/connect', base).href, {
    url: 'https://live.kuaishou.com/u/abc12345'
  });
  record('connect is refused before any collection without written permission', refused.status === 403
    && refused.json?.error?.code === 'KUAISHOU_AUTHORIZATION_REQUIRED'
    && refused.json?.error?.messageKey === 'errors.kuaishouAuthorizationRequired', [
    `status ${refused.status}, code ${refused.json?.error?.code}`
  ]);

  const dictionaries = [];
  for (const code of ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id']) {
    const response = await fetch(new URL(`/i18n/${code}.json`, base), {headers: {cookie}});
    const dictionary = await response.json().catch(() => null);
    dictionaries.push({code, status: response.status, notice: dictionary?.live?.source?.kuaishouNotice ?? null});
  }
  const zh = dictionaries.find((entry) => entry.code === 'zh-CN')?.notice;
  record('all ten dictionaries carry the mandatory Kuaishou disclosure', dictionaries.every((entry) => entry.status === 200
    && typeof entry.notice === 'string'
    && entry.notice.length > 80)
    && zh === '快手平台对未经授权的自动数据采集存在限制。LiveMemory 并非快手官方产品。使用者应遵守快手平台协议，并确保拥有必要的数据访问权限。第三方接口可能随时变更或停止服务。', [
    `dictionaries: ${dictionaries.map((entry) => `${entry.code}=${entry.status}`).join(', ')}`,
    `zh-CN exact notice: ${zh === '快手平台对未经授权的自动数据采集存在限制。LiveMemory 并非快手官方产品。使用者应遵守快手平台协议，并确保拥有必要的数据访问权限。第三方接口可能随时变更或停止服务。'}`
  ]);

  const dbFile = join(dataDir, 'database', 'livememory.db');
  const sessions = await getJson(new URL('/api/sessions', base).href);
  const kuaishouSessions = (sessions.json?.sessions ?? []).filter((row) => row.platform === 'kuaishou');
  record('the packaged EXE creates its local database without a Kuaishou session', existsSync(dbFile)
    && statSync(dbFile).size > 0
    && kuaishouSessions.length === 0, [
    `db: ${existsSync(dbFile) ? `${statSync(dbFile).size} bytes` : 'missing'}`,
    `Kuaishou sessions: ${kuaishouSessions.length}`
  ]);

  const embedded = shippedBytes;
  const markers = [
    'src/platforms/kuaishou/adapter.mjs',
    'src/platforms/kuaishou/policy.mjs',
    'src/platforms/kuaishou/service.mjs',
    'src/monitoring/detectors/kuaishou.mjs',
    'LIVEMEMORY_KUAISHOU_H5_OPT_IN',
    buildInfo.buildId
  ];
  record('the shipped EXE embeds the Kuaishou modules, gate and build id', markers.every((marker) => embedded.includes(Buffer.from(marker, 'utf8'))), [
    `buildId ${buildInfo.buildId}, commit ${buildInfo.commit ?? 'unknown'}`,
    `sha256 ${createHash('sha256').update(shippedBytes).digest('hex')}`
  ]);
} catch (error) {
  record('Kuaishou EXE verification aborted', false, [`${error?.stack ?? error}`]);
} finally {
  await app.stop();
}

const passed = results.filter((entry) => entry.passed).length;
const failed = results.length - passed;
writeFileSync(join(root, 'report.json'), JSON.stringify({exe, distExe, results}, null, 2));
process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed, ${results.length} checks\n`);
process.stdout.write(`Work dir: ${root}\n`);
process.exit(failed > 0 ? 1 : 0);
