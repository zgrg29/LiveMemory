import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import {manifestLevel} from './pe-manifest.mjs';

/**
 * RC0 P0-5 formal EXE verification.
 *
 * Proves, against the packaged binary and an isolated data directory:
 * - the shipped manifest is asInvoker (it launches without UAC in this
 *   low-integrity session);
 * - unauthenticated API/SSE access is rejected;
 * - the launcher-provided fragment token exchanges for the real HttpOnly
 *   SameSite=Strict cookie;
 * - authenticated core operations work, including SSE;
 * - a restart invalidates the old cookie/token and a new launch works;
 * - shutdown stops the HTTP listener and removes runtime files;
 * - the token/cookie never appears in runtime.json or logs.
 *
 * This is NOT a real browser click test and NOT a real UAC interaction test.
 * It uses the same HTTP handshake a browser performs.
 *
 * Usage: node scripts/verify-p0-5-exe.mjs [path/to/LiveMemory.exe]
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `p05-exe-${stamp}`);
const dataDir = join(root, 'data');
const bootstrapFile = join(root, 'bootstrap.url');
mkdirSync(dataDir, {recursive: true});

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let cookie = null;
let browserUrl = null;

function log(line) {
  process.stdout.write(`[p0-5-exe] ${line}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

async function waitFor(check, {timeout = 30000, interval = 200, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

function headersFor(extra = {}) {
  return cookie ? {cookie, ...extra} : extra;
}

async function json(path, {method = 'GET', body = undefined, headers = {}} = {}) {
  const requestHeaders = headersFor(headers);
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {status: response.status, payload, headers: response.headers, text};
}

function rawStatus({path = '/api/health', method = 'GET', headers = {}}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({host: '127.0.0.1', port, path, method, headers}, (response) => {
      response.resume();
      response.on('end', () => resolvePromise(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function openSse() {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events/stream',
      headers: headersFor({accept: 'text/event-stream'})
    }, (response) => {
      const status = response.statusCode;
      const type = response.headers['content-type'] ?? null;
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (status === 200 && text.includes('event: hello')) {
          request.destroy();
          response.destroy();
          resolvePromise({status, type, text});
        }
      });
      response.on('end', () => resolvePromise({status, type, text}));
    });
    request.on('error', reject);
    request.end();
  });
}

async function readBootstrap() {
  return waitFor(() => {
    if (!existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeout: 15000, label: 'bootstrap URL'});
}

async function exchange() {
  browserUrl = await readBootstrap();
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)})
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  return {token, setCookie};
}

const port = await freePort();
const stdoutFile = join(root, 'stdout.log');
const stderrFile = join(root, 'stderr.log');
let child = null;
let exitInfo = null;

function launch() {
  child = spawn(distExe, ['--no-open', '--port', String(port), '--data-dir', dataDir, '--lang', 'en'], {
    cwd: root,
    env: {
      ...process.env,
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile
    },
    stdio: ['ignore', openSync(stdoutFile, 'w'), openSync(stderrFile, 'w')],
    windowsHide: true
  });
  exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = {code, signal}; });
}

async function stop() {
  if (!child || child.exitCode !== null) return {code: child?.exitCode ?? null};
  child.kill('SIGTERM');
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (exitInfo) return exitInfo;
    await sleep(100);
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  return {code: null, signal: 'forced'};
}

function logText() {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

try {
  log(`exe ${distExe}`);
  log(`data ${dataDir}`);
  const manifest = manifestLevel(readFileSync(distExe));
  record('packaged EXE manifest is asInvoker (no UAC elevation)', manifest === 'asInvoker', [`manifest: ${manifest}`]);

  launch();
  const health = await waitFor(async () => {
    if (exitInfo) throw new Error(`EXE exited early: ${JSON.stringify(exitInfo)} ${readFileSync(stderrFile, 'utf8')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1000)});
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }, {timeout: 45000, label: 'health'});
  const buildInfo = JSON.parse(readFileSync(join(resolve('build'), 'build-info.json'), 'utf8'));
  record('the EXE launches as the current user and serves /api/health', health.buildId === buildInfo.buildId, [
    `buildId ${health.buildId}`,
    `commit ${health.commit}`,
    `port ${health.port}`
  ]);

  const noAuthRead = await json('/api/viewers');
  const noAuthWrite = await json('/api/settings', {method: 'PATCH', body: {theme: 'dark'}});
  const noAuthDanger = await json('/api/storage/location', {method: 'POST', body: {targetDir: 'relative/path'}});
  const noAuthSse = await openSse();
  record('unauthenticated read/write/dangerous/SSE requests are rejected', (
    noAuthRead.status === 401
    && noAuthWrite.status === 401
    && noAuthDanger.status === 401
    && noAuthSse.status === 401
    && !String(noAuthSse.type ?? '').includes('event-stream')
  ), [
    `GET /api/viewers ${noAuthRead.status}`,
    `PATCH /api/settings ${noAuthWrite.status}`,
    `POST /api/storage/location ${noAuthDanger.status}`,
    `SSE ${noAuthSse.status} ${noAuthSse.type}`
  ]);

  const wrongOrigin = await json('/api/viewers', {headers: {origin: 'http://evil.example'}});
  const nullOrigin = await json('/api/viewers', {headers: {origin: 'null'}});
  const badHost = await rawStatus({headers: {host: 'evil.example'}});
  record('forged Origin, Origin:null and malicious Host are rejected', (
    wrongOrigin.status === 403 && nullOrigin.status === 403 && badHost === 403
  ), [
    `forged Origin ${wrongOrigin.status}`,
    `Origin:null ${nullOrigin.status}`,
    `Host spoof ${badHost}`
  ]);

  const invalidSession = await json('/api/status', {headers: {cookie: 'lm_session=invalid'}});
  const invalidBootstrap = await json('/api/auth/session', {method: 'POST', body: {token: 'invalid-token'}});
  record('invalid sessions and invalid bootstrap tokens are rejected', (
    invalidSession.status === 401 && invalidBootstrap.status === 401
  ), [`invalid cookie ${invalidSession.status}`, `invalid token ${invalidBootstrap.status}`]);

  const exchanged = await exchange();
  record('launcher fragment token exchanges for the browser session cookie', (
    /#lm_bootstrap=/.test(browserUrl)
    && !/\?lm_bootstrap=/.test(browserUrl)
    && /HttpOnly/i.test(exchanged.setCookie)
    && /SameSite=Strict/i.test(exchanged.setCookie)
    && !/;\s*Secure/i.test(exchanged.setCookie)
  ), [
    `fragment URL: ${browserUrl.replace(/lm_bootstrap=.*/, 'lm_bootstrap=[redacted]')}`,
    `Set-Cookie flags: HttpOnly=${/HttpOnly/i.test(exchanged.setCookie)}, SameSite=${/SameSite=Strict/i.test(exchanged.setCookie)}`,
    `Secure attribute: ${/;\s*Secure/i.test(exchanged.setCookie)} (loopback HTTP cannot use Secure)`
  ]);

  const bootstrap = await json('/api/bootstrap');
  const status = await json('/api/status');
  const settings = await json('/api/settings', {method: 'PATCH', body: {theme: 'dark'}});
  const started = await json('/api/simulate/start', {method: 'POST', body: {title: 'P0-5 EXE auth'}});
  const sessionId = started.payload?.session?.id ?? null;
  const sse = await openSse();
  const stopped = sessionId
    ? await json(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {method: 'POST', body: {}})
    : {status: 0};
  record('authenticated browser session completes core operations and SSE', (
    bootstrap.status === 200
    && status.status === 200
    && settings.status === 200
    && started.status === 201
    && Boolean(sessionId)
    && sse.status === 200
    && String(sse.type ?? '').includes('event-stream')
    && stopped.status === 200
  ), [
    `bootstrap ${bootstrap.status}, status ${status.status}, settings ${settings.status}`,
    `simulate ${started.status}, session ${sessionId}`,
    `SSE ${sse.status} ${sse.type}`,
    `stop ${stopped.status}`
  ]);

  const replay = await json('/api/auth/session', {method: 'POST', body: {token: exchanged.token}});
  record('the one-time bootstrap token cannot be replayed', replay.status === 401, [`replay ${replay.status}`]);

  const runtimeFile = join(dataDir, 'runtime', 'runtime.json');
  const runtimeText = existsSync(runtimeFile) ? readFileSync(runtimeFile, 'utf8') : '';
  const logs = logText();
  const token = exchanged.token;
  record('the session token/cookie is absent from runtime.json and logs', (
    !runtimeText.includes(token)
    && !runtimeText.includes('lm_session=')
    && !runtimeText.includes('lm_bootstrap=')
    && !logs.includes(token)
    && !logs.includes('lm_session=')
    && !logs.includes('lm_bootstrap=')
  ), [`runtime.json contains token: ${runtimeText.includes(token)}`, `logs contain token: ${logs.includes(token)}`]);

  const closed = await stop();
  const listenerClosed = await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(500)});
      return false;
    } catch {
      return true;
    }
  }, {timeout: 10000, label: 'listener closed'});
  // On Windows a console-window close terminates the process before Node can run
  // its SIGTERM handler. This scenario is the real "window closed" behaviour; the
  // runtime marker is expected to remain and the next start takes over safely.
  record('closing the EXE stops the HTTP listener and leaves no live server', (
    (closed.code === 0 || closed.signal === 'SIGTERM' || closed.signal === 'SIGKILL')
    && listenerClosed
  ), [
    `exit ${JSON.stringify(closed)}`,
    `listener closed: ${listenerClosed}`,
    `runtime.json remains after forced close: ${existsSync(runtimeFile)} (cleaned on next start)`
  ]);

  // Restart with the same data directory: the old cookie and old token are dead,
  // but a new launcher URL and the recorded data are available.
  const oldCookie = cookie;
  const oldToken = token;
  cookie = null;
  launch();
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1000)});
      return response.ok;
    } catch {
      return false;
    }
  }, {timeout: 45000, label: 'restart health'});
  const oldCookieStatus = await json('/api/status', {headers: {cookie: oldCookie}});
  const oldTokenStatus = await json('/api/auth/session', {method: 'POST', body: {token: oldToken}});
  const fresh = await exchange();
  const sessions = await json('/api/sessions');
  record('restart invalidates old credentials; a new launch works and keeps data', (
    oldCookieStatus.status === 401
    && oldTokenStatus.status === 401
    && /lm_session=/.test(fresh.setCookie)
    && sessions.status === 200
    && (sessions.payload?.sessions ?? []).some((row) => row.id === sessionId)
  ), [
    `old cookie after restart: ${oldCookieStatus.status}`,
    `old token after restart: ${oldTokenStatus.status}`,
    `new exchange: ${fresh.setCookie.split(';')[0].replace(/=.*/, '=[redacted]')}`,
    `sessions: ${sessions.payload?.sessions?.length ?? 0}, original session present: ${(sessions.payload?.sessions ?? []).some((row) => row.id === sessionId)}`
  ]);

  const finalClosed = await stop();
  record('second process stop also releases the HTTP listener', (
    (finalClosed.code === 0 || finalClosed.signal === 'SIGTERM' || finalClosed.signal === 'SIGKILL')
  ), [`exit ${JSON.stringify(finalClosed)}`]);

  const exeBytes = readFileSync(distExe);
  const sha256 = createHash('sha256').update(exeBytes).digest('hex');
  log('');
  log(`summary: ${results.filter((item) => item.passed).length}/${results.length} passed`);
  log(`buildId: ${buildInfo.buildId}`);
  log(`commit: ${buildInfo.commit}`);
  log(`sha256: ${sha256}`);
  log(`size: ${statSync(distExe).size} bytes`);
  log(`manifest: ${manifest}`);
  const failed = results.filter((item) => !item.passed).length;
  console.log(JSON.stringify({distExe, buildInfo, sha256, manifest, results}, null, 2));
  process.exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  record('verification aborted', false, [`${error?.stack ?? error}`]);
  await stop();
  process.exitCode = 1;
} finally {
  if (!process.exitCode) {
    // Keep the isolated data directory for the report; test cleanup is explicit.
  }
}
