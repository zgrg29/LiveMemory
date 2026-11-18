import {spawn, spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Real Windows EXE acceptance for the Provider save flow.
 *
 * The shipped EXE is requireAdministrator. This script verifies that manifest,
 * then runs an asInvoker copy of the identical binary (same buildId) because an
 * automated session cannot accept UAC. It never modifies the shipped EXE.
 *
 * Every scenario uses a fresh data directory under tests/.tmp; the real user
 * %LOCALAPPDATA%\LiveMemory is never read or written.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-provider-save-${stamp}`);
mkdirSync(root, {recursive: true});
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});
const dataDir = join(root, 'data');
const localAppData = join(root, 'localappdata');
const locationDir = join(root, 'location');
const backupDir = join(root, 'backups');
for (const dir of [dataDir, localAppData, locationDir, backupDir]) mkdirSync(dir, {recursive: true});

const results = [];
let childCounter = 0;
let authCookie = null;

function record(name, passed, details = []) {
  results.push({name, passed, details});
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`);
  for (const line of details) process.stdout.write(`      ${line}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function httpJson(url, {method = 'GET', body = null, cookie = authCookie} = {}) {
  const headers = body ? {'content-type': 'application/json'} : {};
  if (cookie) headers.cookie = cookie;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: response.status, json, text};
}

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 200} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms${last ? ` (${last.message})` : ''}`);
}

function runtimeInfo() {
  const file = join(dataDir, 'runtime', 'runtime.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

async function authenticate(baseUrl, bootstrapFile) {
  const browserUrl = await waitFor(() => {
    if (!existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeoutMs: 15000});
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await fetch(new URL('/api/auth/session', baseUrl), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)}),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie.startsWith('lm_session=')) throw new Error('auth exchange returned no session cookie');
  return cookie;
}

function launch({port, tag}) {
  childCounter += 1;
  const bootstrapFile = join(root, `bootstrap-${tag}-${childCounter}.url`);
  const stdoutFile = join(root, `stdout-${tag}-${childCounter}.log`);
  const stderrFile = join(root, `stderr-${tag}-${childCounter}.log`);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const child = spawn(exe, [
    '--no-open', '--data-dir', dataDir, '--port', String(port), '--lang', 'en'
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      LIVE_MEMORY_LOCATION_DIR: locationDir,
      LIVE_MEMORY_BACKUP_DIR: backupDir,
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile
    },
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = {code, signal}; });
  return {child, bootstrapFile, stdoutFile, stderrFile, exitInfo: () => exitInfo};
}

async function waitForApp(app) {
  const info = await waitFor(async () => {
    const runtime = runtimeInfo();
    if (!runtime?.url) return null;
    const health = await httpJson(new URL('/api/health', runtime.url).href, {cookie: null});
    if (health.status !== 200 || health.json?.name !== 'LiveMemory') return null;
    return {runtime, health};
  });
  authCookie = await authenticate(info.runtime.url, app.bootstrapFile);
  return info.runtime.url;
}

async function stop(app) {
  if (!app || app.exitInfo()) return;
  try { app.child.kill('SIGKILL'); } catch { /* taskkill below */ }
  const exited = await Promise.race([
    new Promise((done) => {
      if (app.exitInfo()) return done(true);
      app.child.once('exit', () => done(true));
    }),
    sleep(4000).then(() => false)
  ]);
  if (!exited) {
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], {stdio: 'ignore'});
    await Promise.race([
      new Promise((done) => {
        if (app.exitInfo()) return done(true);
        app.child.once('exit', () => done(true));
      }),
      sleep(4000)
    ]);
  }
}

function baseUrl(url) {
  return new URL('/api/ai/providers', url).href;
}

function configFile() {
  return join(dataDir, 'config', 'ai-providers.json');
}

function secretFile() {
  return join(dataDir, 'secrets', 'ai-keys.json');
}

function payload(overrides = {}) {
  return {
    name: 'DeepSeek',
    providerId: 'deepseek',
    regionId: 'global',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    pricing: null,
    concurrency: 3,
    timeoutMs: 180000,
    batchInputTokens: null,
    allowLocalNetwork: false,
    ...overrides
  };
}

async function getProviders(url) {
  return httpJson(new URL('/api/ai/providers', url).href);
}

async function createConfig(url, body) {
  return httpJson(new URL('/api/ai/providers/configs', url).href, {method: 'POST', body});
}

async function patchConfig(url, id, body) {
  return httpJson(new URL(`/api/ai/providers/configs/${encodeURIComponent(id)}`, url).href, {
    method: 'PATCH',
    body
  });
}

const shippedManifest = manifestLevel(readFileSync(distExe));
record('shipped EXE manifest is requireAdministrator', shippedManifest === 'requireAdministrator', [
  `manifest: ${shippedManifest}`,
  `functional copy: ${exe}`
]);

let app = null;
let activeUrl = null;

try {
  // 1. Fresh install.
  app = launch({port: 49200, tag: 'fresh'});
  activeUrl = await waitForApp(app);
  {
    const list = await getProviders(activeUrl);
    record('fresh install lists 8 providers and no configuration', list.status === 200
      && Array.isArray(list.json?.configs) && list.json.configs.length === 0
      && list.json?.providers?.length === 8, [`HTTP ${list.status}`]);
  }

  // 2. Save a valid config; no network is involved.
  let deepseekId = null;
  {
    const created = await createConfig(activeUrl, payload({apiKey: 'sk-exe-valid'}));
    deepseekId = created.json?.config?.id ?? null;
    record('valid DeepSeek configuration saves', created.status === 201 && Boolean(deepseekId),
      [`HTTP ${created.status}`, JSON.stringify(created.json?.error ?? null)]);
    const raw = readFileSync(configFile(), 'utf8');
    record('config JSON never contains the API key', !raw.includes('sk-exe-valid') && raw.includes('credentialReference'));
  }

  // 3. Key pasted with a trailing newline.
  {
    const created = await createConfig(activeUrl, payload({
      name: 'DeepSeek newline',
      apiKey: '  sk-exe-newline\n'
    }));
    record('key with trailing newline saves', created.status === 201 && created.json?.config?.hasCredential === true,
      [`HTTP ${created.status}`, JSON.stringify(created.json?.error ?? null)]);
  }

  // 4. Restart and edit without re-entering the key.
  await stop(app);
  app = launch({port: 49201, tag: 'restart'});
  activeUrl = await waitForApp(app);
  {
    const list = await getProviders(activeUrl);
    const listed = list.json?.configs?.find((config) => config.id === deepseekId);
    record('configuration and key survive an EXE restart', Boolean(listed) && listed.hasCredential === true,
      [`HTTP ${list.status}`]);
    const edited = await patchConfig(activeUrl, deepseekId, payload({modelId: 'deepseek-reasoner'}));
    record('saved config edits without re-entering the key', edited.status === 200
      && edited.json?.config?.hasCredential === true, [`HTTP ${edited.status}`]);
  }

  // 5. Legacy trailing-slash Base URL, after a real restart.
  await stop(app);
  {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8'));
    const entry = raw.configs.find((config) => config.id === deepseekId);
    entry.baseUrl = 'https://api.deepseek.com/';
    entry.contextLength = null;
    writeFileSync(configFile(), JSON.stringify(raw, null, 2));
  }
  app = launch({port: 49202, tag: 'legacy'});
  activeUrl = await waitForApp(app);
  {
    const edited = await patchConfig(activeUrl, deepseekId, payload({modelId: 'deepseek-chat'}));
    record('legacy trailing-slash Base URL saves from the form without a new key', edited.status === 200
      && edited.json?.config?.baseUrl === 'https://api.deepseek.com'
      && edited.json?.config?.hasCredential === true
      && edited.json?.config?.contextLength === null, [`HTTP ${edited.status}`]);
  }

  // 6. OpenCode -> DeepSeek with a new key.
  {
    const oc = await createConfig(activeUrl, {
      name: 'OpenCode',
      providerId: 'opencode',
      regionId: 'payg',
      baseUrl: 'https://opencode.ai/inference/openai/v1',
      modelId: 'kimi-k3',
      apiKey: 'oc_sk_exe'
    });
    const switched = await patchConfig(activeUrl, oc.json?.config?.id, payload({apiKey: 'sk-exe-switched'}));
    record('OpenCode switches to DeepSeek with a new key', oc.status === 201 && switched.status === 200
      && switched.json?.config?.providerId === 'deepseek' && switched.json?.config?.hasCredential === true,
    [`HTTP ${oc.status} -> ${switched.status}`]);
  }

  // 7. DeepSeek -> custom.
  {
    const custom = await patchConfig(activeUrl, deepseekId, {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'custom-chat',
      apiKey: 'custom-exe-key',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    });
    record('DeepSeek switches to a custom endpoint with a new key', custom.status === 200
      && custom.json?.config?.providerId === 'custom' && custom.json?.config?.hasCredential === true,
    [`HTTP ${custom.status}`]);
  }

  // 8. A local credential write failure is not reported as an invalid config.
  {
    const tempDir = join(dataDir, 'secrets', 'ai-keys.json.tmp');
    mkdirSync(tempDir, {recursive: true});
    const failed = await patchConfig(activeUrl, deepseekId, {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'custom-chat',
      apiKey: 'must-not-save',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    });
    record('credential write failure is not reported as invalid config', failed.status === 500
      && failed.json?.error?.code === 'AI_PROVIDER_SAVE_FAILED'
      && failed.json?.error?.messageKey === 'errors.aiProviderSaveFailed',
    [`HTTP ${failed.status}`, JSON.stringify(failed.json?.error ?? null)]);
    rmSync(tempDir, {recursive: true, force: true});
    const retried = await patchConfig(activeUrl, deepseekId, {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'custom-chat-retry',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    });
    record('a failed save can be retried after the blocker is removed', retried.status === 200
      && retried.json?.config?.hasCredential === true, [`HTTP ${retried.status}`]);
  }

  // 9. A corrupted credential store is preserved, not overwritten.
  {
    const broken = '{"version":1,"payload":"broken","iv":"AA==","tag":"AA=="}\n';
    writeFileSync(secretFile(), broken);
    const failed = await patchConfig(activeUrl, deepseekId, {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'custom-chat-retry',
      apiKey: 'overwrite-attempt',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    });
    record('corrupt credential store is reported and not overwritten', failed.status === 500
      && failed.json?.error?.code === 'AI_PROVIDER_CREDENTIAL_STORE_UNREADABLE'
      && readFileSync(secretFile(), 'utf8') === broken,
    [`HTTP ${failed.status}`, JSON.stringify(failed.json?.error ?? null)]);
  }

  await stop(app);
  app = null;

  // 10. A corrupt provider config is preserved and reported.
  {
    const broken = '{"version":1,"configs":[';
    writeFileSync(configFile(), broken);
    app = launch({port: 49203, tag: 'corrupt'});
    activeUrl = await waitForApp(app);
    const list = await getProviders(activeUrl);
    const state = list.json?.loadState;
    const backup = state?.backupFile;
    record('corrupt provider config is reported and preserved', list.status === 200
      && state?.error === 'AI_PROVIDER_CONFIG_UNREADABLE'
      && typeof backup === 'string' && existsSync(backup) && readFileSync(backup, 'utf8') === broken,
    [`HTTP ${list.status}`, JSON.stringify(state ?? null)]);
  }
} catch (error) {
  record('EXE acceptance completed without an unhandled error', false, [error?.stack ?? String(error)]);
} finally {
  await stop(app);
}

const failed = results.filter((result) => !result.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const result of failed) process.stdout.write(`  ${result.name}\n`);
  process.exitCode = 1;
}
