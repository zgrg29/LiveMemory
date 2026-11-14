/**
 * Packaged-EXE UI verification for the v0.8.1 live-lifecycle fix.
 *
 * Seeds a real SQLite database with three already-finished Bilibili captures:
 *   - a long capture whose platform end time is unknown (shutdown);
 *   - a capture ended automatically by the platform (`platform_ended`);
 *   - a user stop while the platform was last confirmed live.
 *
 * Then launches dist/LiveMemory.exe directly (asInvoker since RC0 P0-5) with a
 * test-only bootstrap URL and checks the real console through headless Chrome:
 *   - no green "Live" chip for a finished platform broadcast;
 *   - platform state and capture state are visibly separate;
 *   - the unknown platform end time is labelled unknown, never the last chat;
 *   - duration is fixed after the session ended;
 *   - Chinese strings render after a locale switch.
 *
 *   node scripts/verify-live-status-ui.mjs [--port 49340] [--debug-port 9224]
 *
 * Requires a headless Chrome/Edge started with --remote-debugging-port.
 */

import {spawn} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {migrate} from '../src/storage/database/migrations/index.mjs';
import {createSession} from '../src/storage/repositories/sessions.mjs';


const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const requestedPort = Number(argValue('--port', 0));
const debugPort = Number(argValue('--debug-port', 9224));
const root = resolve('tests', '.tmp', `live-status-ui-${Date.now()}`);
const dataDir = join(root, 'data');
const screenshots = resolve('docs', 'screenshots');
mkdirSync(dataDir, {recursive: true});
mkdirSync(screenshots, {recursive: true});

const port = requestedPort > 0 ? requestedPort : await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolvePort(assigned));
  });
});
const base = `http://127.0.0.1:${port}`;
const bootstrapFile = join(root, 'bootstrap.url');
let authCookie = null;
const nativeFetch = globalThis.fetch.bind(globalThis);
async function fetchWithSession(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url;
  if (!authCookie || !url?.startsWith(base)) return nativeFetch(input, init);
  const headers = new Headers(init.headers ?? {});
  headers.set('cookie', authCookie);
  return nativeFetch(input, {...init, headers});
}
globalThis.fetch = fetchWithSession;

const results = [];
function record(name, passed, details = {}) {
  results.push({name, passed, details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* --------------------------------------------------------------- fixture */

const dbFile = join(dataDir, 'database', 'livememory.db');
mkdirSync(join(dataDir, 'database'), {recursive: true});
const db = openDatabase({file: dbFile, createDirectory: false});
migrate(db, {now: T0});

function seed({id, room, title, startedAt, endedAt, endReason, platformStatus, platformStatusAt, lastLiveSeenAt, platformEndedAt, quality}) {
  createSession(db, {
    id,
    platform: 'bilibili',
    platformRoomId: room,
    roomTitle: title,
    broadcasterName: `Anchor ${room}`,
    broadcasterUid: room,
    broadcasterIdentity: 'verified',
    sourceQuality: 'estimated',
    startedAt,
    now: startedAt
  });
  db.prepare(`
    UPDATE sessions
       SET status = 'ended', ended_at = ?, end_reason = ?,
           platform_status = ?, platform_status_at = ?, last_live_seen_at = ?,
           platform_ended_at = ?, platform_end_quality = ?,
           message_count = 12, last_event_at = ?, updated_at = ?
     WHERE id = ?
  `).run(
    endedAt, endReason,
    platformStatus, platformStatusAt, lastLiveSeenAt,
    platformEndedAt, quality,
    startedAt + HOUR, endedAt, id
  );
}

seed({
  id: 'ses_unknown_end',
  room: '880101',
  title: 'Long Capture 九小时',
  startedAt: T0 - 9 * HOUR - 45 * 60 * 1000,
  endedAt: T0,
  endReason: 'shutdown',
  platformStatus: 'ended',
  platformStatusAt: T0 + 1000,
  lastLiveSeenAt: T0 - 9 * HOUR,
  platformEndedAt: null,
  quality: 'unknown'
});
seed({
  id: 'ses_auto_end',
  room: '880102',
  title: 'Auto Ended 自动下播',
  startedAt: T0 - 2 * HOUR,
  endedAt: T0,
  endReason: 'platform_ended',
  platformStatus: 'ended',
  platformStatusAt: T0,
  lastLiveSeenAt: T0 - 5 * 60 * 1000,
  platformEndedAt: T0 - 60 * 1000,
  quality: 'event'
});
seed({
  id: 'ses_manual_stop',
  room: '880103',
  title: 'Manual Stop 手动停止',
  startedAt: T0 - 1 * HOUR,
  endedAt: T0 - 30 * 60 * 1000,
  endReason: 'user',
  platformStatus: 'live',
  platformStatusAt: T0 - 31 * 60 * 1000,
  lastLiveSeenAt: T0 - 31 * 60 * 1000,
  platformEndedAt: null,
  quality: null
});
closeDatabase(db);
record('fixture is a real schema-9 database', existsSync(dbFile));

/* ------------------------------------------------------------------ EXE */

const distExe = resolve('dist', 'LiveMemory.exe');
if (!existsSync(distExe)) throw new Error('dist/LiveMemory.exe is missing; run scripts/build-windows.mjs first');
const exe = distExe;

async function authenticate() {
  const deadline = Date.now() + 15000;
  let browserUrl = '';
  while (Date.now() < deadline) {
    if (existsSync(bootstrapFile)) {
      browserUrl = readFileSync(bootstrapFile, 'utf8').trim();
      if (browserUrl) break;
    }
    await sleep(100);
  }
  if (!browserUrl) throw new Error('bootstrap URL was not written by the EXE');
  authCookie = null;
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await nativeFetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)})
  });
  if (!response.ok) throw new Error(`auth exchange failed: ${response.status}`);
  authCookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!authCookie.startsWith('lm_session=')) throw new Error('auth exchange returned no session cookie');
}

let child = null;
async function launchExe() {
  const stdoutFile = join(root, 'stdout.log');
  const stderrFile = join(root, 'stderr.log');
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const instance = spawn(exe, ['--no-open', '--port', String(port), '--data-dir', dataDir], {
    cwd: root,
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile},
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  instance.on('exit', (code, signal) => { exitInfo = {code, signal}; });
  child = instance;
  const started = Date.now();
  for (;;) {
    if (exitInfo) {
      let stderr = '';
      try { stderr = readFileSync(stderrFile, 'utf8'); } catch { /* ignore */ }
      throw new Error(`EXE exited early (${JSON.stringify(exitInfo)}): ${stderr}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(1500)});
      if (response.ok) break;
    } catch {
      /* not ready yet */
    }
    if (Date.now() - started > 45000) throw new Error('EXE did not become healthy within 45s');
    await sleep(250);
  }
  await authenticate();
  return instance;
}

async function stopExe() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  for (let index = 0; index < 50; index += 1) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
}

/* --------------------------------------------------------------- Chrome */

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const pageTarget = targets.find((target) => target.type === 'page');
if (!pageTarget) throw new Error('no page target in the debugging browser');
const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, {once: true});
  socket.addEventListener('error', reject, {once: true});
});
let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve: done, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else done(message.result);
    return;
  }
  if (message.method) {
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.set(message.method, []);
    for (const done of waiters) done(message.params);
  }
});
function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((done, reject) => {
    pending.set(id, {resolve: done, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
function waitForEvent(method, timeoutMs = 15000) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const list = eventWaiters.get(method) ?? [];
    list.push((params) => {
      clearTimeout(timer);
      done(params);
    });
    eventWaiters.set(method, list);
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, {timeout = 15000, interval = 150} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${expression}`);
    await sleep(interval);
  }
}
async function navigate(hash, {width = 1440, height = 1000} = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
  });
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  await send('Page.navigate', {url: `${base}/?ui=${Date.now()}#${hash}`});
  await loaded;
  await sleep(1800);
}
async function settings(patch) {
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(patch)
  });
}
async function screenshot(file) {
  const result = await send('Page.captureScreenshot', {format: 'png', fromSurface: true});
  writeFileSync(file, Buffer.from(result.data, 'base64'));
}

const ROWS = `(() => ({
  rows: [...document.querySelectorAll('.history-row')].map((row) => ({
    id: row.dataset.sessionId,
    title: row.querySelector('.history-title')?.textContent ?? '',
    chips: [...row.querySelectorAll('.history-sub .chip')].map((chip) => chip.textContent)
  })),
  lastError: window.__lmLastError ?? null
}))()`;

const DETAIL = `(() => ({
  text: document.querySelector('main')?.textContent ?? '',
  meta: document.querySelector('.detail-meta')?.textContent ?? '',
  lifeRows: [...document.querySelectorAll('.card')].find((card) => card.textContent.includes('Broadcast lifecycle')
    || card.textContent.includes('直播生命周期'))?.textContent ?? '',
  lastError: window.__lmLastError ?? null
}))()`;

await launchExe();
try {
  await settings({locale: 'en', theme: 'light'});
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});

  await navigate('/history');
  let view = await waitFor(`(() => {
    const rows = [...document.querySelectorAll('.history-row')];
    return rows.length >= 3 ? (${ROWS}) : null;
  })()`);
  assert(view && view.rows.length === 3, 'history list shows the three seeded captures');
  assert(!view.lastError, 'history list has no page error');

  const auto = view.rows.find((row) => row.id === 'ses_auto_end');
  const unknown = view.rows.find((row) => row.id === 'ses_unknown_end');
  const manual = view.rows.find((row) => row.id === 'ses_manual_stop');
  assert(!!auto && !!unknown && !!manual, 'all seeded rows are present');
  assert(auto.chips.includes('Stream ended'), 'auto-ended platform capture says "Stream ended"');
  assert(!auto.chips.includes('Live'), 'auto-ended platform capture is not green Live');
  assert(unknown.chips.includes('Stream ended'), 'long finished capture says "Stream ended"');
  assert(!unknown.chips.includes('Live'), 'long finished capture is not green Live');
  assert(manual.chips.includes('Stopped by user'), 'manual stop keeps its own label');
  assert(manual.chips.some((chip) => chip.includes('Live')), 'manual stop can still show the platform was live');

  await navigate('/history/ses_unknown_end');
  let detail = await waitFor(`(() => {
    const main = document.querySelector('main');
    return main && main.textContent.includes('Broadcast lifecycle') ? (${DETAIL}) : null;
  })()`);
  assert(detail && detail.text.includes('Broadcast lifecycle'), 'detail has a lifecycle card');
  assert(detail.text.includes('Unknown'), 'unknown platform end time is labelled unknown');
  assert(detail.text.includes('The platform end time is unknown'), 'explicit note explains the unknown end time');

  const durationBefore = detail.meta;
  await sleep(2200);
  await navigate('/history/ses_unknown_end');
  detail = await waitFor(`(() => {
    const main = document.querySelector('main');
    return main && main.textContent.includes('Broadcast lifecycle') ? (${DETAIL}) : null;
  })()`);
  assert(detail.meta === durationBefore, 'ended-capture duration does not keep growing');

  await navigate('/history/ses_auto_end');
  detail = await waitFor(`(() => {
    const main = document.querySelector('main');
    return main && main.textContent.includes('Broadcast lifecycle') ? (${DETAIL}) : null;
  })()`);
  assert(detail.text.includes('The stream ended'), 'auto-ended detail explains the automatic stop');
  assert(!detail.text.includes('The platform end time is unknown'), 'confirmed end time is not marked unknown');
  assert(detail.lastError === null, 'detail has no page error');

  // Chinese rendering + screenshot.
  await settings({locale: 'zh-CN', theme: 'light'});
  await navigate('/history/ses_unknown_end');
  detail = await waitFor(`(() => {
    const main = document.querySelector('main');
    return main && main.textContent.includes('直播生命周期') ? (${DETAIL}) : null;
  })()`);
  assert(detail.text.includes('平台结束时间'), 'Chinese lifecycle labels render');
  assert(detail.text.includes('已下播'), 'Chinese platform-ended label renders');
  assert(detail.text.includes('平台实际结束时间未知'), 'Chinese unknown-end note renders');
  await screenshot(join(screenshots, 'live-status-history-v081-zh.png'));

  // Dark + mobile history list, no horizontal overflow.
  await settings({theme: 'dark'});
  await navigate('/history', {width: 390, height: 844});
  const overflow = await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`);
  assert(overflow === false, '390px dark history list has no horizontal overflow');
  await screenshot(join(screenshots, 'live-status-history-v081-dark-390.png'));
} finally {
  await stopExe();
}

function assert(condition, name) {
  record(name, Boolean(condition));
  if (!condition) throw new Error(`assertion failed: ${name}`);
}

const passed = results.filter((entry) => entry.passed).length;
console.log(`\nSummary: ${passed}/${results.length} passed`);
try {
  socket.close();
} catch {
  /* already closed */
}
process.exit(passed === results.length ? 0 : 1);
