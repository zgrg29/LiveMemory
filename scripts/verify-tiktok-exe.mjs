import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, openSync, readFileSync, existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Real packaged-EXE acceptance for TikTok M1.
 *
 * Usage: node scripts/verify-tiktok-exe.mjs [exe] [live-url]
 *
 * The shipped EXE is requireAdministrator, so this script asserts that manifest
 * and runs the identical packaged binary as an asInvoker test copy. It uses the
 * real TikTok public live page through the free community signing transport (no
 * key, no payment), a fresh isolated data folder, the same one-time bootstrap
 * token exchange as the browser, and SQLite checks after a clean shutdown.
 *
 * It never prints chat bodies or credentials. The anonymous free signer has a
 * discovered 30 requests/hour account ceiling, so LiveMemory paces requests at
 * about one every two minutes; the script allows for that pacing instead of
 * assuming a 15 s poll.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const liveUrl = process.argv[3] ?? process.env.LIVE_MEMORY_TIKTOK_URL ?? 'https://www.tiktok.com/@aljazeeraenglish/live';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-tiktok-${stamp}`);
mkdirSync(root, {recursive: true});

const results = [];
let childCounter = 0;
let authCookie = null;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
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

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 500} = {}) {
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

function launch({dataDir, port, env = {}}) {
  childCounter += 1;
  const stdoutFile = join(root, `stdout-${childCounter}.log`);
  const stderrFile = join(root, `stderr-${childCounter}.log`);
  const bootstrapFile = join(root, `bootstrap-${childCounter}.url`);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const child = spawn(exe, ['--no-open', '--data-dir', dataDir, '--port', String(port), '--lang', 'en'], {
    cwd: process.cwd(),
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile, ...env},
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
  }, {timeoutMs: 30000});
}

function inspectDatabase(dataDir, sessionId) {
  const file = join(dataDir, 'database', 'livememory.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const events = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN viewer_uid IS NOT NULL AND viewer_uid <> '' THEN 1 ELSE 0 END) AS with_uid,
             SUM(CASE WHEN viewer_id IS NOT NULL AND viewer_id <> '' THEN 1 ELSE 0 END) AS with_viewer_id,
             SUM(CASE WHEN external_id IS NOT NULL AND external_id <> '' THEN 1 ELSE 0 END) AS with_external,
             SUM(CASE WHEN display_name IS NOT NULL AND display_name <> '' THEN 1 ELSE 0 END) AS with_name,
             SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS with_content
        FROM events WHERE session_id = ?
    `).get(sessionId);
    const viewers = db.prepare(`SELECT COUNT(*) AS count FROM viewers WHERE platform = 'tiktok'`).get();
    return {events, viewers: Number(viewers?.count ?? 0)};
  } finally {
    db.close();
  }
}

const shipped = readFileSync(distExe);
const shippedLevel = manifestLevel(shipped);
record('shipped EXE requests administrator rights (requireAdministrator, UAC prompt)', shippedLevel === 'requireAdministrator', [
  `manifest level: ${shippedLevel}`,
  `size: ${statSync(distExe).size} bytes`
]);
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});
record('functional scenarios use a test-only asInvoker copy of the same binary', true, [exe]);

const dataDir = join(root, 'data');
let liveRoom = null;
let sessionId = null;
let firstBuildId = null;
let before = null;

try {
  const app = launch({dataDir, port: 49410});
  try {
    const {info, health} = await waitForServer(dataDir, app.bootstrapFile);
    firstBuildId = health.json?.buildId ?? null;
    record('packaged EXE starts its local server and reports the same build id', Boolean(info.port && firstBuildId), [
      `port ${info.port}`,
      `buildId ${firstBuildId ?? 'missing'}`,
      `commit ${health.json?.commit ?? 'unknown'}`
    ]);

    const status = await httpJson(new URL('/api/tiktok/status', info.url).href);
    record('TikTok status is exposed with an honest capability matrix', status.status === 200
      && status.json?.capabilities?.requiresPaidPlan === false
      && status.json?.capabilities?.roomMetadata === 'verified-public'
      && status.json?.capabilities?.gifts === 'parsed-not-observed'
      && status.json?.capabilities?.transportBrowser === 'experimental-login-required'
      && status.json?.login?.state, [
      `HTTP ${status.status}, mode ${status.json?.mode ?? 'missing'}`,
      `login state ${status.json?.login?.state ?? 'missing'}`,
      `rateLimit hourly ${status.json?.rateLimit?.hourlyLimit ?? 'missing'}`
    ]);

    const loginStatus = await httpJson(new URL('/api/tiktok/login/status', info.url).href);
    record('TikTok browser login status is exposed separately from capture', loginStatus.status === 200
      && typeof loginStatus.json?.login?.state === 'string', [
      `HTTP ${loginStatus.status}, state ${loginStatus.json?.login?.state ?? 'missing'}`
    ]);

    const roomResponse = await httpJson(new URL('/api/tiktok/room', info.url).href, {
      method: 'POST',
      body: {url: liveUrl},
      timeoutMs: 25000
    });
    liveRoom = roomResponse.json?.room ?? null;
    record('a real public TikTok room is parsed (room id, live state, anchor, stable id)', roomResponse.status === 200
      && Boolean(liveRoom?.roomId)
      && liveRoom?.isLive === true
      && Boolean(liveRoom?.anchorName)
      && Boolean(liveRoom?.anchorUid), [
      `HTTP ${roomResponse.status}`,
      `handle ${liveRoom?.uniqueId ?? 'missing'}`,
      `room id ${liveRoom?.roomId ?? 'missing'}`,
      `anchor ${liveRoom?.anchorName ?? 'missing'}, stable id ${liveRoom?.anchorUid ?? 'missing'}`
    ]);

    if (liveRoom?.isLive) {
      const connected = await httpJson(new URL('/api/tiktok/connect', info.url).href, {
        method: 'POST',
        body: {url: liveUrl},
        timeoutMs: 60000
      });
      sessionId = connected.json?.session?.id ?? null;
      record('the packaged EXE connects to TikTok through the free signing transport', connected.status === 201
        && sessionId
        && connected.json?.session?.platform === 'tiktok'
        && ['connected', 'reconnecting', 'rate_limited'].includes(connected.json?.connection?.state), [
        `HTTP ${connected.status}`,
        `session ${sessionId ?? 'missing'}`,
        `connection ${connected.json?.connection?.state ?? 'missing'}`,
        `error ${connected.json?.error?.code ?? 'none'}`
      ]);

      if (sessionId) {
        const recordings = await waitFor(async () => {
          const payload = await httpJson(new URL('/api/live/recordings', info.url).href);
          const found = (payload.json?.recordings ?? []).find((item) => item.sessionId === sessionId);
          return found && found.messageCount > 0 ? found : null;
        }, {timeoutMs: 120000, intervalMs: 2000});
        record('real TikTok chat is ingested while the EXE is running', recordings.messageCount > 0, [
          `messages ${recordings.messageCount}`,
          `unique identifiable viewers ${recordings.uniqueViewerCount}`,
          `connection ${recordings.connection?.state}`
        ]);

        const events = await httpJson(new URL(`/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=100`, info.url).href);
        const rows = events.json?.events ?? [];
        const identified = rows.filter((event) => event.viewerId && String(event.viewerId).startsWith('tiktok:'));
        record('TikTok events carry stable tiktok:<user.id> identity, nickname and original text', identified.length > 0
          && identified.every((event) => event.displayName)
          && identified.every((event) => typeof event.content === 'string' && event.content.length > 0), [
          `events ${rows.length}`,
          `with tiktok:<id> ${identified.length}`,
          `distinct ids ${new Set(identified.map((event) => event.viewerId)).size}`
        ]);

        const stopped = await httpJson(new URL(`/api/live/recordings/${encodeURIComponent(sessionId)}/stop`, info.url).href, {
          method: 'POST'
        });
        record('user stop ends only the TikTok session', stopped.status === 200 && stopped.json?.stopped === true, [
          `HTTP ${stopped.status}, session ${stopped.json?.session?.status ?? 'missing'}`
        ]);
      }

      // Automatic monitoring through the packaged EXE. The anonymous free
      // signer has a 30/hour account ceiling; the shared budget may delay the
      // second capture until the next ~130 s slot, so allow for that.
      await sleep(13000);
      const created = await httpJson(new URL('/api/monitoring', info.url).href, {
        method: 'POST',
        body: {platform: 'tiktok', input: liveUrl}
      });
      const targetId = created.json?.target?.id ?? null;
      record('the packaged EXE persists a TikTok auto-monitor target', created.status === 201 && targetId, [
        `HTTP ${created.status}`,
        `target ${targetId ?? 'missing'}`
      ]);
      if (targetId) {
        const checked = await httpJson(new URL(`/api/monitoring/${encodeURIComponent(targetId)}/check`, info.url).href, {
          method: 'POST',
          timeoutMs: 30000
        });
        const autoSessionId = checked.json?.target?.activeSessionId ?? null;
        record('a TikTok auto-monitor check starts a normal live session inside the EXE', checked.status === 200
          && checked.json?.target?.state === 'recording'
          && autoSessionId, [
          `HTTP ${checked.status}`,
          `state ${checked.json?.target?.state ?? 'missing'}`,
          `session ${autoSessionId ?? 'missing'}`
        ]);
        if (autoSessionId) {
          await waitFor(async () => {
            const payload = await httpJson(new URL('/api/live/recordings', info.url).href);
            const found = (payload.json?.recordings ?? []).find((item) => item.sessionId === autoSessionId);
            return found && found.messageCount > 0 ? found : null;
          }, {timeoutMs: 300000, intervalMs: 3000});
          const autoEvents = await httpJson(new URL(`/api/events?sessionId=${encodeURIComponent(autoSessionId)}&limit=50`, info.url).href);
          record('the auto-monitored TikTok session ingests real chat in the EXE', (autoEvents.json?.events ?? [])
            .some((event) => String(event.viewerId ?? '').startsWith('tiktok:')), [
            `events ${autoEvents.json?.events?.length ?? 0}`
          ]);
          await httpJson(new URL(`/api/live/recordings/${encodeURIComponent(autoSessionId)}/stop`, info.url).href, {method: 'POST'});
        }
        const deleted = await httpJson(new URL(`/api/monitoring/${encodeURIComponent(targetId)}`, info.url).href, {
          method: 'DELETE',
          body: {confirm: true}
        });
        record('the TikTok monitor target can be deleted after capture stops', deleted.status === 200 && deleted.json?.deleted === true, [
          `HTTP ${deleted.status}`
        ]);
      }
    }
  } finally {
    await app.stop();
  }

  if (sessionId) {
    before = inspectDatabase(dataDir, sessionId);
    const events = before?.events ?? {};
    const total = Number(events.total ?? 0);
    record('SQLite contains TikTok events with stable user ids and platform message ids', total > 0
      && Number(events.with_uid) === total
      && Number(events.with_external) === total, [
      `events ${total}`,
      `with user_id ${events.with_uid}`,
      `with external_id ${events.with_external}`,
      `with content ${events.with_content}`,
      `tiktok viewers ${before?.viewers ?? 0}`
    ]);
  }

  const restart = launch({dataDir, port: 49411});
  try {
    const {info, health} = await waitForServer(dataDir, restart.bootstrapFile);
    record('the packaged EXE restarts with the same build id', (health.json?.buildId ?? null) === firstBuildId, [
      `before ${firstBuildId ?? 'missing'}, after ${health.json?.buildId ?? 'missing'}`
    ]);
    const sessions = await httpJson(new URL('/api/sessions', info.url).href);
    const persisted = (sessions.json?.sessions ?? []).find((session) => session.id === sessionId);
    record('the TikTok session and its data persist after restart', Boolean(persisted)
      && persisted.platform === 'tiktok'
      && persisted.messageCount > 0, [
      `session found: ${Boolean(persisted)}`,
      `messages ${persisted?.messageCount ?? 0}, viewers ${persisted?.uniqueViewerCount ?? 0}`
    ]);
    if (sessionId) {
      const report = await httpJson(new URL(`/api/ai/sessions/${encodeURIComponent(sessionId)}/report`, info.url).href);
      record('the AI read model can open the TikTok session report', report.status === 200, [
        `HTTP ${report.status}`,
        report.status === 200 ? 'report available' : report.json?.error?.code ?? 'no report'
      ]);
      const viewers = await httpJson(new URL('/api/viewers?limit=100&platform=tiktok', info.url).href);
      record('TikTok viewers are available to the long-term profile read model', viewers.status === 200
        && (viewers.json?.viewers ?? []).some((viewer) => String(viewer.id).startsWith('tiktok:')), [
        `HTTP ${viewers.status}, viewers ${viewers.json?.viewers?.length ?? 0}`
      ]);
    }
    const bili = await httpJson(new URL('/api/bilibili/status', info.url).href);
    const youtube = await httpJson(new URL('/api/youtube/status', info.url).href);
    const twitch = await httpJson(new URL('/api/twitch/status', info.url).href);
    const douyin = await httpJson(new URL('/api/douyin/status', info.url).href);
    record('Bilibili, YouTube, Twitch and Douyin status endpoints still work (regression)', bili.status === 200
      && youtube.status === 200
      && youtube.json?.mode === 'web'
      && twitch.status === 200
      && twitch.json?.mode === 'anonymous-irc'
      && douyin.status === 200, [
      `Bilibili ${bili.status}, YouTube ${youtube.status}/${youtube.json?.mode ?? '?'}`,
      `Twitch ${twitch.status}/${twitch.json?.mode ?? '?'}, Douyin ${douyin.status}`
    ]);
    const tiktok = await httpJson(new URL('/api/tiktok/status', info.url).href);
    record('TikTok status survives restart with its 30-day policy', tiktok.status === 200
      && tiktok.json?.policy?.days === 30, [
      `HTTP ${tiktok.status}, policy ${JSON.stringify(tiktok.json?.policy ?? null)}`
    ]);
  } finally {
    await restart.stop();
  }
} catch (error) {
  record('unexpected failure during EXE acceptance', false, [String(error?.stack ?? error)]);
} finally {
  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  log('');
  log(`RESULT ${passed}/${results.length} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  log(`artifacts: ${root}`);
}
