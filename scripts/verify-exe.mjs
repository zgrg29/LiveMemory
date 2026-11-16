import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  mkdirSync,
  openSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
  statSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {APP_VERSION} from '../src/shared/app-info.mjs';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Real executable verification matrix.
 *
 * Usage: node scripts/verify-exe.mjs [path\to\LiveMemory.exe]
 *
 * RC0-ADMIN-MANIFEST: the shipped EXE is requireAdministrator, so Windows shows
 * the standard UAC prompt on double-click. An automated session cannot accept
 * that prompt, so the functional scenarios launch a test-only asInvoker copy of
 * the same binary (never the shipped file). Every launched server writes its
 * one-time browser URL to a temporary bootstrap file; the script exchanges it for
 * a session cookie before calling protected APIs, the same path the browser uses.
 * Real UAC acceptance remains a manual user check.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-${stamp}`);
mkdirSync(root, {recursive: true});
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});

const results = [];
let childCounter = 0;
let authCookie = null;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

const distManifest = manifestLevel(readFileSync(distExe));
record('shipped EXE requests administrator rights (requireAdministrator, UAC prompt)', distManifest === 'requireAdministrator', [
  `manifest level: ${distManifest}`,
  `functional scenarios use a test-only asInvoker copy: ${exe}`
]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function httpJson(url, {method = 'GET', body = null} = {}) {
  const headers = body ? {'content-type': 'application/json'} : {};
  if (authCookie) headers.cookie = authCookie;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {status: response.status, json, text};
}

async function waitFor(predicate, {timeoutMs = 25000, intervalMs = 250} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`);
}

function launch({args, env = {}, cwd = process.cwd(), exePath = exe}) {
  childCounter += 1;
  const stdoutFile = join(root, `stdout-${childCounter}.log`);
  const stderrFile = join(root, `stderr-${childCounter}.log`);
  const bootstrapFile = join(root, `bootstrap-${childCounter}.url`);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const child = spawn(exePath, args, {
    cwd,
    env: {
      ...process.env,
      // Test-only handoff: the launcher/server writes the one-time browser URL
      // here so this non-interactive matrix can use the real auth exchange.
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile,
      ...env
    },
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  const info = {
    child,
    stdoutFile,
    stderrFile,
    bootstrapFile,
    readStdout: () => {
      try {
        return readFileSync(stdoutFile, 'utf8');
      } catch {
        return '';
      }
    },
    readStderr: () => {
      try {
        return readFileSync(stderrFile, 'utf8');
      } catch {
        return '';
      }
    },
    async exitCode(timeoutMs = 20000) {
      return Promise.race([
        new Promise((done) => {
          if (exitInfo) {
            done(exitInfo);
            return;
          }
          child.once('exit', (code, signal) => done({code, signal}));
        }),
        sleep(timeoutMs).then(() => ({code: null, signal: 'timeout'}))
      ]);
    },
    async stop() {
      if (exitInfo) return true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* fall through to taskkill */
      }
      const exited = await Promise.race([
        new Promise((done) => {
          if (exitInfo) {
            done(true);
            return;
          }
          child.once('exit', () => done(true));
        }),
        sleep(4000).then(() => false)
      ]);
      if (!exited) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore'});
        await Promise.race([
          new Promise((done) => {
            if (exitInfo) {
              done(true);
              return;
            }
            child.once('exit', () => done(true));
          }),
          sleep(4000)
        ]);
      }
      return exitInfo !== null;
    }
  };
  return info;
}

function runtimeInfo(dataDir) {
  const file = join(dataDir, 'runtime', 'runtime.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Exchange the launcher's one-time fragment token for the same HttpOnly cookie a
 * normal browser receives. The token is never printed.
 */
async function authenticate(baseUrl, bootstrapFile) {
  const browserUrl = await waitFor(() => {
    if (!bootstrapFile || !existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeoutMs: 10000});
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
  authCookie = cookie;
}

async function waitForServer(dataDir, bootstrapFile) {
  return waitFor(async () => {
    const info = runtimeInfo(dataDir);
    if (!info?.url) return null;
    const health = await httpJson(new URL('/api/health', info.url).href);
    if (health.status !== 200 || health.json?.name !== 'LiveMemory') return null;
    await authenticate(info.url, bootstrapFile);
    return {info, health};
  });
}

function readStartupLogs(dataDir) {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith('startup-') || name.startsWith('bootstrap-'))
    .map((name) => readFileSync(join(dir, name), 'utf8'));
}

/** The bootstrap may extract outside the data folder when the profile is read-only. */
function bootstrapLogFiles() {
  const candidates = [
    join(tmpdir(), 'LiveMemory-logs'),
    join(process.env.LOCALAPPDATA ?? '', 'LiveMemory', 'logs')
  ].filter((dir) => dir && existsSync(dir));
  const files = [];
  for (const dir of candidates) {
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith('bootstrap-'))) {
      const file = join(dir, name);
      files.push({file, mtime: statSync(file).mtimeMs});
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function bootstrapLogText() {
  return bootstrapLogFiles().map((entry) => readFileSync(entry.file, 'utf8')).join('\n');
}

function findExtractedAppRoot() {
  for (const entry of bootstrapLogFiles()) {
    // One bootstrap log is appended across runs, so the newest run is the last
    // matching line inside the newest file.
    const lines = readFileSync(entry.file, 'utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.step === 'app-root.ready' && record.path) return record.path;
      } catch {
        /* skip malformed line */
      }
    }
  }
  return null;
}

async function scenarioFreshStart() {
  const dataDir = join(root, 'data-fresh');
  const app = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49100', '--lang', 'en']});
  try {
    const {info} = await waitForServer(dataDir, app.bootstrapFile);
    const health = await httpJson(new URL('/api/health', info.url).href);
    const bootstrap = await httpJson(new URL('/api/bootstrap', info.url).href);
    await httpJson(new URL('/api/simulate/start', info.url).href, {method: 'POST', body: {title: 'Verification', speed: 'fast'}});
    await sleep(4000);
    const sessions = await httpJson(new URL('/api/sessions', info.url).href);
    const current = await httpJson(new URL('/api/sessions/current', info.url).href);
    const viewers = await httpJson(new URL('/api/viewers?limit=100', info.url).href);
    await httpJson(new URL('/api/simulate/stop', info.url).href, {method: 'POST'});
    const dbFile = join(dataDir, 'database', 'livememory.db');
    const details = [
      `port ${info.port}, url ${info.url}`,
      `health ${health.status}, bootstrap ${bootstrap.status}`,
      `sessions ${sessions.json?.sessions?.length ?? 0}, viewers ${viewers.json?.viewers?.length ?? 0}`,
      `db ${existsSync(dbFile) ? `${statSync(dbFile).size} bytes` : 'missing'}`
    ];
    const passed = health.status === 200
      && bootstrap.status === 200
      && existsSync(dbFile)
      && (sessions.json?.sessions?.length ?? 0) >= 1
      && (viewers.json?.viewers?.length ?? 0) >= 1
      && (current.json?.session?.stats?.messages ?? 0) > 0;
    const startupLogInDataDir = readdirSync(join(dataDir, 'logs')).some((name) => name.startsWith('startup-'));
    record('fresh data folder: full startup, HTTP API, SQLite writes, live console data', passed && startupLogInDataDir, details.concat([
      `startup log inside the data folder: ${startupLogInDataDir}`
    ]));
    return {
      dataDir,
      info,
      counts: {sessions: sessions.json?.sessions?.length ?? 0, viewers: viewers.json?.viewers?.length ?? 0}
    };
  } finally {
    await app.stop();
  }
}

async function scenarioRestartKeepsData({dataDir, before}) {
  const app = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49101', '--lang', 'en']});
  try {
    const {info} = await waitForServer(dataDir, app.bootstrapFile);
    const sessions = await httpJson(new URL('/api/sessions', info.url).href);
    const viewers = await httpJson(new URL('/api/viewers?limit=100', info.url).href);
    const after = {sessions: sessions.json?.sessions?.length ?? 0, viewers: viewers.json?.viewers?.length ?? 0};
    const passed = after.sessions >= before.sessions && after.viewers >= before.viewers && after.sessions >= 1;
    record('restart on an existing database keeps all records', passed, [
      `before ${JSON.stringify(before)}`,
      `after  ${JSON.stringify(after)}`,
      'startup log: ' + (readStartupLogs(dataDir).join('\n').includes('"step":"startup.begin"') ? 'written' : 'missing')
    ]);
    return after;
  } finally {
    await app.stop();
  }
}

async function scenarioCrashRecovery() {
  const dataDir = join(root, 'data-crash');
  const first = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49102', '--lang', 'en']});
  const {info} = await waitForServer(dataDir, first.bootstrapFile);
  await httpJson(new URL('/api/simulate/start', info.url).href, {method: 'POST', body: {title: 'Crash test', speed: 'fast'}});
  await sleep(3500);
  const live = await httpJson(new URL('/api/sessions/current', info.url).href);
  const messageCount = live.json?.session?.stats?.messages ?? 0;
  const sessionId = live.json?.session?.session?.id ?? null;
  const killed = await first.stop(); // hard kill: simulates closing the console window

  const second = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49103', '--lang', 'en']});
  try {
    const restarted = await waitForServer(dataDir, second.bootstrapFile);
    const sessions = await httpJson(new URL('/api/sessions', restarted.info.url).href);
    const row = (sessions.json?.sessions ?? []).find((session) => session.id === sessionId)
      ?? (sessions.json?.sessions ?? [])[0];
    const passed = killed
      && restarted.info.port === 49103
      && messageCount > 0
      && Boolean(row)
      && ['interrupted', 'ended'].includes(row.status)
      && (row.messageCount ?? 0) >= Math.min(messageCount, 1);
    record('hard kill then restart marks the live session interrupted and keeps its messages', passed, [
      `first process really terminated: ${killed}`,
      `messages before kill: ${messageCount}`,
      `restarted on port ${restarted.info.port}`,
      `session after restart: ${row?.status ?? 'missing'} with ${row?.messageCount ?? 0} messages`
    ]);
    return dataDir;
  } finally {
    await second.stop();
  }
}

async function scenarioPortConflict() {
  const dataDir = join(root, 'data-port');
  const blocker = createServer(() => {});
  await new Promise((done) => blocker.listen(49110, '127.0.0.1', done));
  const app = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49110', '--lang', 'en']});
  try {
    const {info} = await waitForServer(dataDir, app.bootstrapFile);
    const health = await httpJson(new URL('/api/health', info.url).href);
    const passed = info.port !== 49110 && health.status === 200;
    record('an occupied port moves the server to a free one instead of failing', passed, [
      `requested 49110, actual ${info.port}, health ${health.status}`
    ]);
  } finally {
    await app.stop();
    await new Promise((done) => blocker.close(done));
  }
}

async function scenarioSecondInstance() {
  const dataDir = join(root, 'data-single');
  const first = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49120', '--lang', 'en']});
  try {
    const {info} = await waitForServer(dataDir, first.bootstrapFile);
    const second = launch({args: ['--no-open', '--data-dir', dataDir, '--lang', 'en']});
    const exited = await second.exitCode(20000);
    const output = second.readStdout() + second.readStderr();
    const health = await httpJson(new URL('/api/health', info.url).href);
    const passed = exited.code === 0 && /already running/i.test(output) && health.status === 200;
    record('a second launch does not start a second writer and exits cleanly', passed, [
      `exit code ${exited.code}${exited.signal ? ` (${exited.signal})` : ''}`,
      `mentions already running: ${/already running/i.test(output)}`,
      `first instance still healthy: ${health.status}`
    ]);
    if (!passed) log(output.slice(0, 800));
  } finally {
    await first.stop();
  }
}

async function scenarioUnwritable() {
  const dataDir = join(root, 'data-denied');
  mkdirSync(dataDir, {recursive: true});
  const user = process.env.USERNAME ?? '';
  const deny = spawnSync('icacls', [dataDir, '/deny', `${user}:(OI)(CI)(W)`], {encoding: 'utf8'});
  let target;
  let mode;
  if (deny.status === 0) {
    target = dataDir;
    mode = 'ACL deny write';
  } else {
    // No ACL editing available: a protected system folder is denied to a
    // non-elevated account by Windows itself, which is the same failure class.
    target = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `LiveMemoryVerify-${Date.now()}`);
    mode = 'protected system folder';
  }
  const logDir = join(root, 'denied-logs');
  const app = launch({
    args: ['--no-open', '--no-wait', '--data-dir', target, '--lang', 'en'],
    env: {LIVE_MEMORY_LOG_DIR: logDir}
  });
  const exited = await app.exitCode(30000);
  const output = app.readStdout() + app.readStderr();
  const logFiles = existsSync(logDir) ? readdirSync(logDir) : [];
  const startupLog = logFiles.find((name) => name.startsWith('startup-'));
  const logText = startupLog ? readFileSync(join(logDir, startupLog), 'utf8') : '';
  const passed = exited.code === 1
    && /could not start/i.test(output)
    && /(not writable|denied|Failed step)/i.test(output)
    && Boolean(startupLog)
    && /"ok":false/.test(logText);
  record('an unwritable data folder is reported, logged, and exits with code 1 (no silent flash)', passed, [
    `simulation: ${mode}`,
    `target: ${target}`,
    `exit code ${exited.code}`,
    `localized message: ${/could not start/i.test(output)}`,
    `startup log written: ${Boolean(startupLog)}`,
    `log records the failure: ${/"ok":false/.test(logText)}`,
    `code shown: ${(output.match(/Error code: (\w+)/) ?? [])[1] ?? 'n/a'}`,
    `first line: ${output.trim().split('\n')[0] ?? ''}`
  ]);
  if (deny.status === 0) spawnSync('icacls', [dataDir, '/remove:d', user], {stdio: 'ignore'});
}

async function scenarioOtherDirectory() {
  const otherDir = join(root, 'Downloads');
  mkdirSync(otherDir, {recursive: true});
  const copy = join(otherDir, 'LiveMemory.exe');
  copyFileSync(exe, copy);
  const dataDir = join(root, 'data-other');
  const app = launch({
    exePath: copy,
    cwd: root,
    args: ['--no-open', '--data-dir', dataDir, '--port', '49130', '--lang', 'en']
  });
  try {
    const {info} = await waitForServer(dataDir, app.bootstrapFile);
    const health = await httpJson(new URL('/api/health', info.url).href);
    const appRoot = findExtractedAppRoot();
    const logs = readStartupLogs(dataDir).join('\n');
    record('the EXE works from another folder with an unrelated working directory', health.status === 200 && Boolean(appRoot), [
      `exe ${copy}`,
      `cwd ${root}`,
      `health ${health.status}`,
      `extracted app: ${appRoot ?? 'not found in bootstrap log'}`,
      `startup log in data folder: ${logs.includes('"step":"startup.begin"')}`
    ]);
    const before = appRoot && existsSync(appRoot) ? statSync(appRoot).mtimeMs : null;
    return {dataDir, appRoot, before};
  } finally {
    await app.stop();
  }
}

async function scenarioReuseExtraction({dataDir, appRoot, before}) {
  if (!appRoot || before === null) {
    record('a second start reuses the extracted application files instead of rewriting them', false, ['no extraction folder was found']);
    return;
  }
  const app = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49131', '--lang', 'en']});
  try {
    await waitForServer(dataDir, app.bootstrapFile);
    const bootstrapText = bootstrapLogText();
    const sameMtime = statSync(appRoot).mtimeMs === before;
    record('a second start reuses the extracted application files instead of rewriting them', sameMtime && bootstrapText.includes('app-root.reuse'), [
      `marker reuse logged: ${bootstrapText.includes('app-root.reuse')}`,
      `extraction folder untouched: ${sameMtime}`,
      `folder: ${appRoot}`
    ]);
  } finally {
    await app.stop();
  }
}

async function scenarioCli() {
  const version = launch({args: ['--version']});
  const versionExit = await version.exitCode(15000);
  const versionOut = (version.readStdout() + version.readStderr()).trim();
  const helpJa = launch({args: ['--help', '--lang', 'ja']});
  const helpExit = await helpJa.exitCode(15000);
  const helpOut = helpJa.readStdout() + helpJa.readStderr();
  const diagnoseDir = join(root, 'data-diagnose');
  const diagnose = launch({args: ['--diagnose', '--lang', 'en', '--data-dir', diagnoseDir]});
  const diagnoseExit = await diagnose.exitCode(25000);
  const diagnoseOut = diagnose.readStdout() + diagnose.readStderr();
  const passed = versionExit.code === 0
    && versionOut.includes(`LiveMemory ${APP_VERSION}`)
    && helpExit.code === 0
    && helpOut.includes('起動オプション')
    && diagnoseExit.code === 0
    && /Startup environment diagnostics/.test(diagnoseOut)
    && /writable/i.test(diagnoseOut);
  record('CLI: version, Japanese help and --diagnose', passed, [
    `--version exit ${versionExit.code}: ${versionOut}`,
    `--help --lang ja exit ${helpExit.code}, Japanese help: ${helpOut.includes('起動オプション')}`,
    `--diagnose exit ${diagnoseExit.code}, candidates listed: ${/writable/i.test(diagnoseOut)}`
  ]);
}

async function scenarioI18nAssets() {
  const dataDir = join(root, 'data-i18n');
  const app = launch({args: ['--no-open', '--data-dir', dataDir, '--port', '49140', '--lang', 'en']});
  try {
    const {info} = await waitForServer(dataDir, app.bootstrapFile);
    const bootstrap = await httpJson(new URL('/api/bootstrap', info.url).href);
    const available = bootstrap.json?.locales?.available ?? [];
    const dictionaries = [];
    for (const entry of available) {
      const dictionary = await httpJson(new URL(`/i18n/${entry.code}.json`, info.url).href);
      dictionaries.push({code: entry.code, status: dictionary.status, native: dictionary.json?.settings?.language?.zh});
    }
    const headers = authCookie ? {cookie: authCookie} : {};
    const sharedResponse = await fetch(new URL('/shared/locales.mjs', info.url), {headers});
    const sharedText = await sharedResponse.text();
    const controlResponse = await fetch(new URL('/js/language-control.js', info.url), {headers});
    const controlText = await controlResponse.text();
    const indexResponse = await fetch(new URL('/', info.url), {headers});
    const indexText = await indexResponse.text();
    const codes = available.map((entry) => entry.code);
    // P41: every shipped language is a real AI output language, and the
    // bootstrap lists (interface + AI output) must match the shared registry.
    const expected = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];
    const passed = bootstrap.status === 200
      && JSON.stringify(codes) === JSON.stringify(expected)
      && available.every((entry) => typeof entry.nativeName === 'string' && entry.nativeName.length > 0)
      && bootstrap.json?.locales?.default === 'en'
      && expected.includes(bootstrap.json?.effective?.locale)
      && JSON.stringify((bootstrap.json?.locales?.aiOutput ?? []).map((entry) => entry.code)) === JSON.stringify(expected)
      && bootstrap.json?.settings?.aiOutputLocale === 'follow-ui'
      && expected.includes(bootstrap.json?.effective?.aiOutputLocale)
      && dictionaries.every((entry) => entry.status === 200 && entry.native === '简体中文')
      && sharedResponse.status === 200
      && /text\/javascript/.test(sharedResponse.headers.get('content-type') ?? '')
      && /LOCALE_REGISTRY/.test(sharedText)
      && controlResponse.status === 200
      && /renderLanguageControl/.test(controlText)
      && indexResponse.status === 200
      && /id="language-segmented"/.test(indexText)
      && /id="language-select"/.test(indexText);
    record('i18n assets: shared registry, ten dictionaries, ten AI output languages, dynamic language control', passed, [
      `locales: ${codes.join(', ')}`,
      `native names: ${available.map((entry) => entry.nativeName).join(' / ')}`,
      `default: ${bootstrap.json?.locales?.default}, effective: ${bootstrap.json?.effective?.locale}`,
      `dictionaries: ${dictionaries.map((entry) => `${entry.code}=${entry.status}`).join(', ')}`,
      `ai output: ${(bootstrap.json?.locales?.aiOutput ?? []).map((entry) => entry.code).join(', ')}`,
      `ai output preference: ${bootstrap.json?.settings?.aiOutputLocale}, effective: ${bootstrap.json?.effective?.aiOutputLocale}`,
      `shared registry: ${sharedResponse.status}, ${sharedResponse.headers.get('content-type')}`,
      `language-control.js: ${controlResponse.status}`,
      `header controls in index.html: ${/id="language-segmented"/.test(indexText) && /id="language-select"/.test(indexText)}`
    ]);
  } finally {
    await app.stop();
  }
}

async function main() {
  log(`LiveMemory executable verification`);
  log(`  shipped exe: ${distExe}`);
  log(`  shipped sha256: ${createHash('sha256').update(readFileSync(distExe)).digest('hex')}`);
  log(`  test copy: ${exe} (asInvoker; automated sessions cannot accept UAC)`);
  log(`  work: ${root}`);
  log('');

  try {
    const fresh = await scenarioFreshStart();
    await scenarioRestartKeepsData({dataDir: fresh.dataDir, before: fresh.counts});
    await scenarioCrashRecovery();
    await scenarioPortConflict();
    await scenarioSecondInstance();
    await scenarioUnwritable();
    const other = await scenarioOtherDirectory();
    await scenarioReuseExtraction(other);
    await scenarioI18nAssets();
    await scenarioCli();
  } catch (error) {
    record('verification matrix aborted', false, [`${error?.stack ?? error}`]);
  }

  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  log('');
  log(`Summary: ${passed} passed, ${failed} failed, ${results.length} scenarios`);
  writeFileSync(join(root, 'report.json'), JSON.stringify({exe, results}, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main();
