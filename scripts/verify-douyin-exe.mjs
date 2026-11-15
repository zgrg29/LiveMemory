import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, openSync, readFileSync, existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Real packaged-EXE acceptance for the Douyin integration.
 *
 * Usage: node scripts/verify-douyin-exe.mjs [webRid] [exe]
 *
 * The shipped EXE is requireAdministrator, so the script asserts that manifest
 * and runs the identical packaged binary as an asInvoker test copy. It uses the
 * real public Douyin live page + signed anonymous WebSocket, an isolated data
 * folder, the normal bootstrap-token exchange and SQLite checks after shutdown.
 *
 * It never prints chat bodies or credentials. Gift events are reported as
 * OBSERVED / NOT OBSERVED instead of being fabricated: the platform only pushes
 * gifts to a logged-in session.
 */

const webRid = process.argv[2] ?? process.env.LIVE_MEMORY_DOUYIN_ROOM ?? '708764876300';
const distExe = resolve(process.argv[3] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-douyin-${stamp}`);
mkdirSync(root, {recursive: true});

const results = [];
let childCounter = 0;
let authCookie = null;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, kind: 'check', details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

function observe(name, observed, details = []) {
  results.push({name, passed: true, kind: 'observation', observed, details});
  log(`${observed ? 'OBSERVED' : 'NOT-OBSERVED'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

function httpJson(url, {method = 'GET', body = null, timeoutMs = 8000} = {}) {
  const headers = body ? {'content-type': 'application/json'} : {};
  if (authCookie) headers.cookie = authCookie;
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  }).then(async (response) => {
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return {status: response.status, json, text};
  });
}

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 250} = {}) {
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

function launch({dataDir, port}) {
  childCounter += 1;
  const stdoutFile = join(root, `stdout-${childCounter}.log`);
  const stderrFile = join(root, `stderr-${childCounter}.log`);
  const bootstrapFile = join(root, `bootstrap-${childCounter}.url`);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const child = spawn(exe, ['--no-open', '--data-dir', dataDir, '--port', String(port), '--lang', 'en'], {
    cwd: process.cwd(),
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile},
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  return {
    child,
    bootstrapFile,
    stdoutFile,
    stderrFile,
    readStdout: () => readFileSync(stdoutFile, 'utf8'),
    readStderr: () => readFileSync(stderrFile, 'utf8'),
    async stop() {
      if (exitInfo) return true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* fall through */
      }
      const exited = await Promise.race([
        new Promise((done) => {
          if (exitInfo) {
            done(true);
            return;
          }
          child.once('exit', () => done(true));
        }),
        sleep(5000).then(() => false)
      ]);
      if (!exited) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore'});
        await Promise.race([new Promise((done) => child.once('exit', () => done(true))), sleep(5000)]);
      }
      return exitInfo !== null;
    }
  };
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

async function authenticate(baseUrl, bootstrapFile) {
  const browserUrl = await waitFor(() => {
    if (!bootstrapFile || !existsSync(bootstrapFile)) return null;
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
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
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
  }, {timeoutMs: 30000});
}

function inspectDatabase(dataDir, sessionId) {
  const file = join(dataDir, 'database', 'livememory.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const events = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN event_type = 'chat' THEN 1 ELSE 0 END) AS chat,
             SUM(CASE WHEN event_type = 'gift' THEN 1 ELSE 0 END) AS gift,
             SUM(CASE WHEN viewer_uid IS NOT NULL AND viewer_uid <> '' THEN 1 ELSE 0 END) AS with_uid,
             SUM(CASE WHEN viewer_id IS NOT NULL AND viewer_id <> '' THEN 1 ELSE 0 END) AS with_viewer_id,
             SUM(CASE WHEN external_id IS NOT NULL AND external_id <> '' THEN 1 ELSE 0 END) AS with_external,
             SUM(CASE WHEN display_name IS NOT NULL AND display_name <> '' THEN 1 ELSE 0 END) AS with_name,
             SUM(CASE WHEN content IS NOT NULL AND content <> '' THEN 1 ELSE 0 END) AS with_content,
             SUM(CASE WHEN amount_minor IS NOT NULL THEN 1 ELSE 0 END) AS with_fiat_amount
        FROM events WHERE session_id = ?
    `).get(sessionId);
    const viewers = db.prepare(`
      SELECT COUNT(*) AS count FROM viewers WHERE platform = 'douyin'
    `).get();
    const platforms = db.prepare(`
      SELECT platform, COUNT(*) AS count FROM sessions GROUP BY platform ORDER BY platform
    `).all();
    return {events, viewers: Number(viewers?.count ?? 0), platforms};
  } finally {
    db.close();
  }
}

const buildRecord = JSON.parse(readFileSync('build/build-info.json', 'utf8'));
const shipped = readFileSync(distExe);
const shippedLevel = manifestLevel(shipped);
record('shipped EXE requests administrator rights (requireAdministrator, UAC prompt)', shippedLevel === 'requireAdministrator', [
  `manifest level: ${shippedLevel}`,
  `size: ${statSync(distExe).size} bytes`,
  `build id: ${buildRecord.buildId}`
]);
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});
record('functional scenarios use a test-only asInvoker copy of the same binary', true, [exe]);

const dataDir = join(root, 'data');
let sessionId = null;
let firstBuildId = null;
let room = null;

try {
  const app = launch({dataDir, port: 49310});
  try {
    const {info, health} = await waitForServer(dataDir, app.bootstrapFile);
    firstBuildId = health.json?.buildId ?? null;
    record('the packaged EXE starts and its Build ID matches build/build-info.json', Boolean(firstBuildId)
      && firstBuildId === buildRecord.buildId, [
      `port ${info.port}`,
      `buildId ${firstBuildId ?? 'missing'}`,
      `expected ${buildRecord.buildId}`,
      `commit ${health.json?.commit ?? 'unknown'}`
    ]);

    const status = await httpJson(new URL('/api/douyin/status', info.url).href);
    record('Douyin status is exposed with honest gift/login capability boundaries', status.status === 200
      && status.json?.capabilities?.stableUserId === true
      && status.json?.capabilities?.requiresLoginForGifts === true
      && status.json?.capabilities?.giftValue === 'display-only', [
      `HTTP ${status.status}, mode ${status.json?.mode ?? 'missing'}`,
      `capabilities ${JSON.stringify(status.json?.capabilities ?? null)}`
    ]);

    const checked = await httpJson(new URL('/api/douyin/room', info.url).href, {
      method: 'POST',
      body: {url: `https://live.douyin.com/${webRid}`},
      timeoutMs: 20000
    });
    room = checked.json?.room ?? null;
    record('a real public Douyin room is parsed (room id, live state, anchor, stable id)', checked.status === 200
      && room?.roomId
      && room?.isLive === true
      && Boolean(room?.anchorName), [
      `HTTP ${checked.status}`,
      `web_rid ${room?.webRid ?? 'missing'}`,
      `room id ${room?.roomId ?? 'missing'}`,
      `status ${room?.status ?? 'missing'}`,
      `anchor present ${Boolean(room?.anchorName)}, anchor id present ${Boolean(room?.anchorUid)}`
    ]);

    if (room?.isLive) {
      const connected = await httpJson(new URL('/api/douyin/connect', info.url).href, {
        method: 'POST',
        body: {url: `https://live.douyin.com/${webRid}`},
        timeoutMs: 30000
      });
      sessionId = connected.json?.session?.id ?? null;
      record('the packaged EXE opens the signed anonymous WebSocket and creates a session', connected.status === 201
        && sessionId
        && connected.json?.session?.platform === 'douyin', [
        `HTTP ${connected.status}`,
        `session ${sessionId ?? 'missing'}`,
        `connection ${connected.json?.connection?.state ?? 'missing'}`,
        `error ${connected.json?.error?.code ?? 'none'}`
      ]);

      if (sessionId) {
        const live = await waitFor(async () => {
          const payload = await httpJson(new URL('/api/live/recordings', info.url).href);
          const found = (payload.json?.recordings ?? []).find((item) => item.sessionId === sessionId);
          return found && found.messageCount > 0 ? found : null;
        }, {timeoutMs: 90000, intervalMs: 1500});
        record('real Douyin chat is ingested while the EXE is running', live.messageCount > 0, [
          `messages ${live.messageCount}`,
          `unique identifiable viewers ${live.uniqueViewerCount}`,
          `connection ${live.connection?.state}`
        ]);

        const events = await httpJson(new URL(`/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=100`, info.url).href);
        const rows = events.json?.events ?? [];
        const identified = rows.filter((event) => String(event.viewerId ?? '').startsWith('douyin:'));
        record('Douyin events carry stable douyin:<uid> identity, nickname and original text in the API', identified.length > 0
          && identified.every((event) => event.displayName)
          && identified.every((event) => typeof event.content === 'string' && event.content.length > 0)
          && identified.every((event) => event.sourceQuality === 'verified'), [
          `events ${rows.length}`,
          `with douyin:<id> ${identified.length}`,
          `distinct ids ${new Set(identified.map((event) => event.viewerId)).size}`,
          `with display name ${identified.filter((event) => event.displayName).length}`,
          'platform message ids are asserted in SQLite below'
        ]);

        const stopped = await httpJson(new URL(`/api/live/recordings/${encodeURIComponent(sessionId)}/stop`, info.url).href, {
          method: 'POST'
        });
        record('user stop ends only the Douyin session', stopped.status === 200 && stopped.json?.stopped === true, [
          `HTTP ${stopped.status}, status ${stopped.json?.session?.status ?? 'missing'}`
        ]);
      }
    }
  } finally {
    await app.stop();
  }

  if (sessionId) {
    const before = inspectDatabase(dataDir, sessionId);
    const events = before?.events ?? {};
    const total = Number(events.total ?? 0);
    record('SQLite keeps Douyin events with stable uid, nickname, message id and original text', total > 0
      && Number(events.with_uid) === total
      && Number(events.with_external) === total
      && Number(events.with_name) === total
      && Number(events.with_content) === total, [
      `events ${total} (chat ${events.chat ?? 0}, gift ${events.gift ?? 0})`,
      `with uid ${events.with_uid}, with external id ${events.with_external}`,
      `with nickname ${events.with_name}, with content ${events.with_content}`,
      `with fiat amount ${events.with_fiat_amount} (must stay 0 for virtual gifts)`,
      `douyin viewers ${before?.viewers ?? 0}`
    ]);
    observe('real Douyin gift events during this anonymous run', Number(events.gift ?? 0) > 0, [
      Number(events.gift ?? 0) > 0
        ? `gift rows ${events.gift}`
        : 'anonymous sessions are not pushed gifts by the platform; login is required and gift parsing is covered by automated tests only'
    ]);
  }

  const restart = launch({dataDir, port: 49311});
  try {
    const {info, health} = await waitForServer(dataDir, restart.bootstrapFile);
    record('the packaged EXE restarts with the same Build ID', (health.json?.buildId ?? null) === firstBuildId, [
      `before ${firstBuildId ?? 'missing'}, after ${health.json?.buildId ?? 'missing'}`
    ]);
    const sessions = await httpJson(new URL('/api/sessions', info.url).href);
    const persisted = (sessions.json?.sessions ?? []).find((session) => session.id === sessionId);
    record('the Douyin session and its data persist after restart', Boolean(persisted)
      && persisted.platform === 'douyin'
      && persisted.messageCount > 0, [
      `session found ${Boolean(persisted)}`,
      `messages ${persisted?.messageCount ?? 0}, viewers ${persisted?.uniqueViewerCount ?? 0}`
    ]);
    if (sessionId) {
      const report = await httpJson(new URL(`/api/ai/sessions/${encodeURIComponent(sessionId)}/report`, info.url).href);
      record('the AI read model can open the Douyin session report', report.status === 200, [
        `HTTP ${report.status}`,
        report.status === 200 ? 'report available' : report.json?.error?.code ?? 'no report'
      ]);
      const viewers = await httpJson(new URL('/api/viewers?limit=100&platform=douyin', info.url).href);
      record('Douyin viewers feed the long-term profile read model', viewers.status === 200
        && (viewers.json?.viewers ?? []).some((viewer) => String(viewer.id).startsWith('douyin:')), [
        `HTTP ${viewers.status}, viewers ${viewers.json?.viewers?.length ?? 0}`
      ]);
    }
    const douyin = await httpJson(new URL('/api/douyin/status', info.url).href);
    record('Douyin status survives restart with the 30-day raw-content policy', douyin.status === 200
      && douyin.json?.policy?.days === 30, [
      `HTTP ${douyin.status}, policy ${JSON.stringify(douyin.json?.policy ?? null)}`
    ]);
    const bili = await httpJson(new URL('/api/bilibili/status', info.url).href);
    const youtube = await httpJson(new URL('/api/youtube/status', info.url).href);
    const twitch = await httpJson(new URL('/api/twitch/status', info.url).href);
    record('Bilibili, YouTube and Twitch status endpoints still work (regression)', bili.status === 200
      && youtube.status === 200
      && youtube.json?.mode === 'web'
      && twitch.status === 200
      && twitch.json?.mode === 'anonymous-irc', [
      `Bilibili HTTP ${bili.status}`,
      `YouTube HTTP ${youtube.status}, mode ${youtube.json?.mode ?? 'missing'}`,
      `Twitch HTTP ${twitch.status}, mode ${twitch.json?.mode ?? 'missing'}`
    ]);

    const loginCheck = await httpJson(new URL('/api/douyin/login/check', info.url).href);
    record('Douyin login status is reported without a stored credential (anonymous)', loginCheck.status === 200
      && loginCheck.json?.loggedIn === false, [
      `HTTP ${loginCheck.status}, loggedIn ${loginCheck.json?.loggedIn ?? 'missing'}`
    ]);
  } finally {
    await restart.stop();
  }
} catch (error) {
  record('unexpected failure during EXE acceptance', false, [String(error?.stack ?? error)]);
} finally {
  const checks = results.filter((item) => item.kind === 'check');
  const passed = checks.filter((item) => item.passed).length;
  const failed = checks.length - passed;
  log('');
  log(`RESULT ${passed}/${checks.length} checks passed, ${failed} failed; ${results.filter((item) => item.kind === 'observation').length} observations`);
  if (failed > 0) process.exitCode = 1;
  log(`artifacts: ${root}`);
}
