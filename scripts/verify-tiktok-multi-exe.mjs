import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, openSync, readFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Real packaged-EXE acceptance for two TikTok LIVE rooms at the same time.
 *
 * Usage:
 *   node scripts/verify-tiktok-multi-exe.mjs [exe] [live-url-a] [live-url-b] [collect-seconds]
 *
 * The shipped EXE is requireAdministrator, so this script asserts the manifest
 * and runs the same packaged binary as an asInvoker test copy. It then:
 *   1. resolves two real, different TikTok LIVE rooms through the public API;
 *   2. starts both through `/api/tiktok/connect` and keeps both sockets open;
 *   3. waits for real chat events in both separate sessions;
 *   4. refuses a duplicate start of room A without creating a second A;
 *   5. stops A via the shared stop route and proves B keeps receiving events;
 *   6. stops B and inspects both sessions in SQLite after shutdown.
 *
 * It never prints chat bodies or credentials. A room that produces no chat is
 * reported as NOT-OBSERVED; it is never counted as a pass.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const liveUrlA = process.argv[3] ?? process.env.LIVE_MEMORY_TIKTOK_URL_A ?? 'https://www.tiktok.com/@aljazeeraenglish/live';
const liveUrlB = process.argv[4] ?? process.env.LIVE_MEMORY_TIKTOK_URL_B ?? 'https://www.tiktok.com/@aljazeera/live';
const collectSeconds = Math.max(20, Math.min(300, Number(process.argv[5] ?? 90)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-tiktok-multi-${stamp}`);
mkdirSync(root, {recursive: true});

const results = [];
let authCookie = null;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => process.stdout.write(`${message}\n`);

function record(name, passed, details = [], {notObserved = false} = {}) {
  const status = notObserved ? 'NOT-OBSERVED' : (passed ? 'PASS' : 'FAIL');
  results.push({name, passed, details, status});
  log(`${status}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

function httpJson(url, {method = 'GET', body = null, timeoutMs = 15000} = {}) {
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

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 1000} = {}) {
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
  const stdoutFile = join(root, 'stdout.log');
  const stderrFile = join(root, 'stderr.log');
  const bootstrapFile = join(root, 'bootstrap.url');
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
  }, {timeoutMs: 20000});
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await fetch(new URL('/api/auth/session', baseUrl), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)}),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  authCookie = setCookie.split(';')[0];
  if (!authCookie.startsWith('lm_session=')) throw new Error('auth exchange returned no session cookie');
}

async function waitForServer(dataDir, bootstrapFile) {
  return waitFor(async () => {
    const info = runtimeInfo(dataDir);
    if (!info?.url) return null;
    const health = await httpJson(new URL('/api/health', info.url).href);
    if (health.status !== 200 || health.json?.name !== 'LiveMemory') return null;
    await authenticate(info.url, bootstrapFile);
    return {info, health};
  }, {timeoutMs: 40000});
}

async function checkRoom(base, url) {
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    last = await httpJson(new URL('/api/tiktok/room', base).href, {
      method: 'POST',
      body: {url},
      timeoutMs: 25000
    });
    if (last.status === 200 && last.json?.room?.isLive) return last.json.room;
    log(`      room check attempt ${attempt} -> HTTP ${last.status} (${last.json?.error?.code ?? 'unknown'})`);
    await sleep(8000);
  }
  return last?.json?.room ?? null;
}

async function connect(base, url) {
  return httpJson(new URL('/api/tiktok/connect', base).href, {
    method: 'POST',
    body: {url},
    timeoutMs: 80000
  });
}

async function recordings(base) {
  return (await httpJson(new URL('/api/live/recordings', base).href)).json;
}

async function summary(base, sessionId) {
  return (await httpJson(new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, base).href)).json;
}

function inspectDatabase(dataDir, sessionIds) {
  const file = join(dataDir, 'database', 'livememory.db');
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return sessionIds.map((sessionId) => {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      const events = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN viewer_uid IS NOT NULL AND viewer_uid <> '' THEN 1 ELSE 0 END) AS with_uid,
               SUM(CASE WHEN viewer_id IS NOT NULL AND viewer_id <> '' THEN 1 ELSE 0 END) AS with_viewer_id,
               SUM(CASE WHEN external_id IS NOT NULL AND external_id <> '' THEN 1 ELSE 0 END) AS with_external,
               SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS with_content,
               COUNT(DISTINCT external_id) AS distinct_external,
               COUNT(DISTINCT viewer_id) AS distinct_viewers
          FROM events WHERE session_id = ?
      `).get(sessionId);
      return {session, events};
    });
  } finally {
    db.close();
  }
}

const shipped = readFileSync(distExe);
const shippedLevel = manifestLevel(shipped);
record('shipped EXE requests administrator rights (requireAdministrator, UAC prompt)', shippedLevel === 'requireAdministrator', [
  `manifest level: ${shippedLevel}`
]);
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});
record('functional scenarios use a test-only asInvoker copy of the same binary', true, [exe]);

const dataDir = join(root, 'data');
let app = null;
try {
  app = launch({dataDir, port: 49510});
  const {info} = await waitForServer(dataDir, app.bootstrapFile);
  const base = info.url;
  record('the packaged EXE starts and exposes the same build', true, [
    `port ${info.port}`,
    `buildId ${(await httpJson(new URL('/api/health', base).href)).json?.buildId ?? 'missing'}`
  ]);

  const roomA = await checkRoom(base, liveUrlA);
  const roomB = await checkRoom(base, liveUrlB);
  record('two different real TikTok rooms are resolved as live', Boolean(
    roomA?.isLive && roomA?.roomId && roomA?.anchorUid
    && roomB?.isLive && roomB?.roomId && roomB?.anchorUid
    && String(roomA.roomId) !== String(roomB.roomId)
  ), [
    `A ${roomA?.uniqueId ?? 'missing'} / ${roomA?.roomId ?? 'missing'} / ${roomA?.anchorName ?? 'missing'}`,
    `B ${roomB?.uniqueId ?? 'missing'} / ${roomB?.roomId ?? 'missing'} / ${roomB?.anchorName ?? 'missing'}`
  ]);
  if (!roomA?.isLive || !roomB?.isLive) throw new Error('both rooms must be live to run this acceptance');

  const connectedA = await connect(base, liveUrlA);
  const connectedB = await connect(base, liveUrlB);
  const sessionA = connectedA.json?.session?.id ?? null;
  const sessionB = connectedB.json?.session?.id ?? null;
  record('room A starts through the anonymous local WebSocket in the packaged EXE', connectedA.status === 201 && Boolean(sessionA), [
    `HTTP ${connectedA.status}, session ${sessionA ?? 'missing'}`
  ]);
  record('room B starts while room A keeps recording', connectedB.status === 201 && Boolean(sessionB) && sessionA !== sessionB, [
    `HTTP ${connectedB.status}, session ${sessionB ?? 'missing'}`
  ]);
  if (!sessionA || !sessionB || sessionA === sessionB) throw new Error('two independent sessions were not created');

  const liveList = await waitFor(async () => {
    const value = await recordings(base);
    const states = value.recordings.map((row) => row.connection.state);
    return value.count === 2 && states.every((state) => state === 'connected') ? value : null;
  }, {timeoutMs: 45000});
  record('the recordings API lists both rooms with independent room ids and connections', (
    liveList.recordings.length === 2
    && new Set(liveList.recordings.map((row) => row.platformRoomId)).size === 2
    && liveList.recordings.every((row) => row.platform === 'tiktok')
  ), liveList.recordings.map((row) => `${row.broadcasterName ?? row.roomTitle ?? 'unknown'} / ${row.platformRoomId} / ${row.connection.state}`));

  const duplicate = await httpJson(new URL('/api/tiktok/connect', base).href, {
    method: 'POST',
    body: {url: liveUrlA},
    timeoutMs: 30000
  });
  const duplicateList = await recordings(base);
  record('starting the same room twice is refused and creates no second A', (
    duplicate.status === 409
    && duplicate.json?.error?.code === 'SESSION_DUPLICATE_ROOM'
    && duplicate.json?.error?.details?.sessionId === sessionA
    && duplicateList.count === 2
  ), [
    `HTTP ${duplicate.status}, code ${duplicate.json?.error?.code ?? 'missing'}`,
    `recordings ${duplicateList.count}`
  ]);

  log(`      collecting real chat for up to ${collectSeconds}s ...`);
  const counts = await waitFor(async () => {
    const [a, b] = await Promise.all([summary(base, sessionA), summary(base, sessionB)]);
    const messagesA = a?.stats?.messages ?? 0;
    const messagesB = b?.stats?.messages ?? 0;
    return messagesA > 0 && messagesB > 0 ? {messagesA, messagesB} : null;
  }, {timeoutMs: collectSeconds * 1000, intervalMs: 3000});
  record('real chat is received by both rooms at the same time', counts.messagesA > 0 && counts.messagesB > 0, [
    `A messages ${counts.messagesA}`,
    `B messages ${counts.messagesB}`
  ]);

  const beforeStop = await summary(base, sessionB);
  const stopped = await httpJson(new URL(`/api/live/recordings/${encodeURIComponent(sessionA)}/stop`, base).href, {
    method: 'POST',
    body: {}
  });
  const afterStop = await waitFor(async () => {
    const value = await recordings(base);
    return value.count === 1 && value.recordings[0]?.sessionId === sessionB ? value : null;
  }, {timeoutMs: 30000});
  record('stopping room A leaves room B connected', stopped.status === 200
    && stopped.json?.stopped === true
    && afterStop.recordings[0]?.connection?.state === 'connected', [
    `HTTP ${stopped.status}`,
    `remaining ${afterStop.recordings[0]?.broadcasterName ?? 'missing'} / ${afterStop.recordings[0]?.connection?.state ?? 'missing'}`
  ]);

  const continued = await waitFor(async () => {
    const value = await summary(base, sessionB);
    return (value?.stats?.messages ?? 0) > (beforeStop?.stats?.messages ?? 0) ? value : null;
  }, {timeoutMs: 60000, intervalMs: 3000});
  record('room B keeps ingesting after room A is stopped', continued.stats.messages > beforeStop.stats.messages, [
    `B messages ${beforeStop?.stats?.messages ?? 0} -> ${continued.stats.messages}`
  ]);

  const reportA = await httpJson(new URL(`/api/ai/sessions/${encodeURIComponent(sessionA)}/report`, base).href);
  const reportB = await httpJson(new URL(`/api/ai/sessions/${encodeURIComponent(sessionB)}/report`, base).href);
  record('the AI report endpoint returns each room separately', reportA.status === 200
    && reportB.status === 200
    && reportA.json?.session?.id === sessionA
    && reportB.json?.session?.id === sessionB, [
    `A HTTP ${reportA.status}, B HTTP ${reportB.status}`
  ]);

  const stopB = await httpJson(new URL(`/api/live/recordings/${encodeURIComponent(sessionB)}/stop`, base).href, {
    method: 'POST',
    body: {}
  });
  record('room B can be stopped independently', stopB.status === 200 && stopB.json?.stopped === true, [
    `HTTP ${stopB.status}`
  ]);

  const cleanStop = await app.stop();
  record('the EXE shuts down cleanly after both captures', cleanStop, []);
  const rows = inspectDatabase(dataDir, [sessionA, sessionB]);
  for (const [index, label] of [[0, 'A'], [1, 'B']]) {
    const {session, events} = rows[index];
    record(`SQLite keeps ${label} in its own session with stable ids and message ids`, Boolean(
      session
      && session.status === 'ended'
      && String(session.platform_room_id) === String(index === 0 ? roomA.roomId : roomB.roomId)
      && Number(events.total) > 0
      && Number(events.with_uid) === Number(events.total)
      && Number(events.with_external) === Number(events.total)
      && Number(events.with_content) === Number(events.total)
      && Number(events.distinct_external) === Number(events.total)
    ), [
      `session ${session?.id ?? 'missing'}`,
      `room ${session?.platform_room_id ?? 'missing'}`,
      `events ${events.total}, with uid ${events.with_uid}, with msg id ${events.with_external}, distinct msg ids ${events.distinct_external}`,
      `distinct stable viewers ${events.distinct_viewers}`
    ]);
  }
  record('the two sessions never share a room or a session id', rows[0].session?.id !== rows[1].session?.id
    && String(rows[0].session?.platform_room_id) !== String(rows[1].session?.platform_room_id), [
    `${rows[0].session?.platform_room_id} vs ${rows[1].session?.platform_room_id}`
  ]);
} catch (error) {
  record('unexpected failure during the two-room EXE acceptance', false, [String(error?.stack ?? error)]);
} finally {
  if (app && !app.child.killed) {
    try {
      await app.stop();
    } catch {
      /* ignore */
    }
  }
}

const passed = results.filter((entry) => entry.status === 'PASS').length;
const notObserved = results.filter((entry) => entry.status === 'NOT-OBSERVED').length;
const failed = results.filter((entry) => entry.status === 'FAIL').length;
log('');
log(`RESULT ${passed}/${results.length} passed, ${notObserved} NOT-OBSERVED, ${failed} failed`);
log(`artifacts: ${root}`);
process.exit(failed === 0 ? 0 : 1);
