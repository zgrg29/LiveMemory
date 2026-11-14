/**
 * Real packaged-EXE UI verification for history management and search.
 *
 * What it does:
 *   1. creates a schema-v6 data folder with seeded history (so the packaged EXE
 *      must perform the real v6 → v7 upgrade);
 *   2. launches dist/LiveMemory.exe directly (RC0 P0-5 ships an asInvoker
 *      manifest) with a test-only bootstrap URL and exchanges it for a session;
 *   3. launches that EXE, then drives its console through headless Chrome:
 *      search, archive, stop a simulated recording and permanent delete;
 *   4. restarts the EXE and checks that archive state and remaining history
 *      survive, while deleted sessions stay gone.
 *
 *   node scripts/verify-exe-history.mjs [--port 49320] [--debug-port 9224]
 *
 * Requires a headless Chrome/Edge started with --remote-debugging-port.
 * This verifies the packaged binary and the real console; the seeded broadcasts
 * are simulated, so it is not a real-platform capture test.
 */

import {spawn} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {currentSchemaVersion, MIGRATIONS} from '../src/storage/database/migrations/index.mjs';
import {createSession} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';


const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const requestedPort = Number(argValue('--port', 0));
const debugPort = Number(argValue('--debug-port', 9224));
const root = resolve('tests', '.tmp', `exe-history-${Date.now()}`);
const dataDir = join(root, 'data');
const reportPath = join(resolve('tests', '.tmp'), 'exe-history-report.json');
mkdirSync(dataDir, {recursive: true});

// Ask Windows for a free local port so the test never races another server.
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

const report = {checks: []};
function record(name, passed, details = {}) {
  report.checks.push({name, passed, ...details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

const T0 = Date.parse('2026-11-08T02:00:00.000Z');
const HOUR = 3600 * 1000;

/* ------------------------------------------------------- schema-v6 fixture */

function migrateToV6(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 6).sort((a, b) => a.version - b.version)) {
    db.exec('BEGIN IMMEDIATE');
    migration.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, T0);
    db.exec('COMMIT');
  }
}

function addBroadcaster(db, platform, uid, name) {
  const id = `${platform}:${uid}`;
  upsertBroadcaster(db, {id, platform, platformUid: uid, displayName: name, identity: 'verified', seenAt: T0, now: T0});
  return id;
}

function addSession(db, {platform, roomId, title, broadcasterName, broadcasterId, startedAt}) {
  return createSession(db, {
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: 'verified',
    sourceQuality: 'mock',
    simulated: true,
    startedAt,
    now: startedAt
  });
}

function speak(db, session, {uid, name, content, at, amount = null, externalId}) {
  new EventIngest({db, now: () => at}).record({
    session_id: session.id,
    platform: session.platform,
    event_type: amount ? 'super_chat' : 'chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content,
    ...(amount ? {amount_minor: amount, currency: 'CNY', value_kind: 'actual', is_paid: true} : {}),
    external_id: externalId,
    source_quality: 'mock'
  });
}

const dbFile = join(dataDir, 'database', 'livememory.db');
let db = openDatabase({file: dbFile});
migrateToV6(db);
if (currentSchemaVersion(db) !== 6) throw new Error('fixture did not stop at schema v6');
const alpha = addBroadcaster(db, 'youtube', 'UC_EXE_ALPHA', 'EXE Alpha 主播');
const anchor = addBroadcaster(db, 'bilibili', '930001', 'EXE 主播乙');
const shared = addSession(db, {
  platform: 'youtube', roomId: 'exe-shared', title: 'EXE Shared Session 共享场次',
  broadcasterName: 'EXE Alpha 主播', broadcasterId: alpha, startedAt: T0
});
const other = addSession(db, {
  platform: 'youtube', roomId: 'exe-other', title: 'EXE Other Session 另一场',
  broadcasterName: 'EXE Alpha 主播', broadcasterId: alpha, startedAt: T0 + HOUR
});
const archive = addSession(db, {
  platform: 'youtube', roomId: 'exe-archive', title: 'EXE Archive Target 归档目标',
  broadcasterName: 'EXE Alpha 主播', broadcasterId: alpha, startedAt: T0 + 2 * HOUR
});
const deletable = addSession(db, {
  platform: 'bilibili', roomId: '930001', title: 'EXE Delete Target 删除目标',
  broadcasterName: 'EXE 主播乙', broadcasterId: anchor, startedAt: T0 + 3 * HOUR
});
speak(db, shared, {uid: 'UC_EXE_SHARED', name: 'Shared EXE Viewer', content: '同一个观众', at: T0 + 1000, externalId: 'exe-s1'});
speak(db, shared, {uid: 'UC_EXE_SHARED', name: 'Shared EXE Viewer', content: '付费支持', at: T0 + 2000, amount: 500, externalId: 'exe-s2'});
speak(db, other, {uid: 'UC_EXE_SHARED', name: 'Shared EXE Viewer', content: '另一场也来了', at: T0 + HOUR + 1000, externalId: 'exe-o1'});
speak(db, archive, {uid: 'UC_EXE_ARCHIVE', name: 'Archive Viewer', content: 'archive', at: T0 + 2 * HOUR + 1000, externalId: 'exe-a1'});
speak(db, deletable, {uid: '930099', name: 'Delete Viewer', content: 'delete', at: T0 + 3 * HOUR + 1000, externalId: 'exe-d1'});
for (const session of [shared, other, archive, deletable]) {
  db.prepare('UPDATE sessions SET status = \'ended\', ended_at = ?, updated_at = ? WHERE id = ?')
    .run(session.started_at + 60_000, session.started_at + 60_000, session.id);
}
closeDatabase(db);
record('fixture is a real schema-v6 database', existsSync(dbFile));

/* --------------------------------------------------------------- EXE copy */

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
let childCounter = 0;
async function launchExe() {
  childCounter += 1;
  const stdoutFile = join(root, `stdout-${childCounter}.log`);
  const stderrFile = join(root, `stderr-${childCounter}.log`);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const instance = spawn(exe, ['--no-open', '--port', String(port), '--data-dir', dataDir], {
    cwd: root,
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile},
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  instance.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  child = instance;
  const started = Date.now();
  for (;;) {
    if (exitInfo) {
      throw new Error(`EXE exited early (${JSON.stringify(exitInfo)}): ${readFileSafe(stderrFile)}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(1200)});
      if (response.ok) break;
    } catch {
      /* not ready yet */
    }
    if (Date.now() - started > 30000) throw new Error('EXE did not become healthy within 30s');
    await sleep(200);
  }
  await authenticate();
  return {instance, stdoutFile, stderrFile, exitInfo: () => exitInfo};
}

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function stopExe() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  for (let index = 0; index < 50; index += 1) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ----------------------------------------------------------------- Chrome */

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
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
    return;
  }
  if (message.method) {
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.set(message.method, []);
    for (const resolve of waiters) resolve(message.params);
  }
});
function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
function waitForEvent(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const list = eventWaiters.get(method) ?? [];
    list.push((params) => {
      clearTimeout(timer);
      resolve(params);
    });
    eventWaiters.set(method, list);
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, {timeout = 10000, interval = 120} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${expression}`);
    await sleep(interval);
  }
}
async function navigate(hash, {width = 1440, height = 1100} = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
  });
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  await send('Page.navigate', {url: `${base}/?exe=${Date.now()}#${hash}`});
  await loaded;
  await sleep(1600);
}
async function setSearch(value) {
  await evaluate(`(() => {
    const input = document.querySelector('.history-search-input');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  await sleep(700);
}
async function clickMenu(label) {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.action-menu-item')].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!item) throw new Error('menu item missing: ' + ${JSON.stringify(label)});
    item.click();
    return true;
  })()`);
  await sleep(450);
}
async function openMenu(index = 0) {
  await evaluate(`(() => {
    document.querySelectorAll('.history-row .history-actions')[${index}].click();
    return true;
  })()`);
  await sleep(300);
}
const ROWS = `(() => ({
  rows: [...document.querySelectorAll('.history-row')].map((row) => ({
    id: row.dataset.sessionId,
    title: row.querySelector('.history-title')?.textContent ?? '',
    chips: [...row.querySelectorAll('.history-sub .chip')].map((chip) => chip.textContent)
  })),
  empty: document.querySelector('.history-results .empty-title')?.textContent ?? null,
  lastError: window.__lmLastError ?? null
}))()`;

/* ------------------------------------------------------------------- run */

async function useEnglishUi() {
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({locale: 'en', theme: 'light'})
  });
}

let instance = await launchExe();
try {
  await useEnglishUi();
  const status = await (await fetch(`${base}/api/status`)).json();
  record('packaged EXE upgrades the v6 database to schema 12', status.database.schemaVersion === 12, {
    schema: status.database.schemaVersion,
    version: status.server.version
  });
  const upgraded = await (await fetch(`${base}/api/history/search?includeArchived=1`)).json();
  record('existing history survives the schema upgrade', upgraded.total === 4, {total: upgraded.total});

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});
  await navigate('/history');
  let view = await evaluate(ROWS);
  record('packaged EXE history page renders the seeded sessions', view.rows.length === 4 && !view.lastError, {
    rows: view.rows.length,
    lastError: view.lastError
  });

  await setSearch('Shared EXE Viewer');
  view = await evaluate(ROWS);
  record('viewer search works against the packaged EXE database', view.rows.length === 2, {
    titles: view.rows.map((row) => row.title)
  });

  await setSearch('EXE Archive Target');
  view = await evaluate(ROWS);
  await openMenu(0);
  await clickMenu('Archive');
  await sleep(900);
  view = await evaluate(ROWS);
  record('archiving from the EXE UI hides the session by default', view.rows.length === 0, {rows: view.rows.length});
  await evaluate(`(() => {
    const checkbox = document.querySelector('.filter-check input');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  await sleep(800);
  view = await evaluate(ROWS);
  record('include-archived shows the archived session in the EXE UI', view.rows.length === 1 && view.rows[0].chips.includes('Archived'), {
    chips: view.rows[0]?.chips
  });

  const start = await fetch(`${base}/api/simulate/start`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({title: 'EXE Live Stop 停止测试', speed: 'calm'})
  });
  const started = await start.json();
  record('a simulated recording starts inside the packaged EXE', start.status === 201, {session: started.session?.id});
  await navigate('/history');
  await setSearch('EXE Live Stop');
  view = await evaluate(ROWS);
  record('the running recording is shown as live in the EXE history list', view.rows.length === 1 && view.rows[0].chips.includes('Live'));
  await openMenu(0);
  await clickMenu('Stop recording');
  await waitFor("Boolean(document.querySelector('.modal'))");
  await evaluate("document.querySelector('.modal .button--primary')?.click(); 'clicked'");
  await sleep(1400);
  view = await evaluate(ROWS);
  record('stopping from the EXE history list updates the status', view.rows.length === 1 && view.rows[0].chips.includes('Stopped by user'), {
    chips: view.rows[0]?.chips
  });
  const recordingsAfterStop = await (await fetch(`${base}/api/live/recordings`)).json();
  record('the EXE capture task is fully stopped after the UI action', recordingsAfterStop.count === 0);

  await evaluate(`(() => {
    const input = document.querySelector('.history-search-input');
    input.value = '';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  await sleep(400);
  await setSearch('EXE Delete Target');
  view = await evaluate(ROWS);
  const deleteId = view.rows[0]?.id;
  await openMenu(0);
  await clickMenu('Delete permanently');
  await waitFor("Boolean(document.querySelector('.modal'))");
  const dialog = await evaluate(`(() => ({
    body: document.querySelector('.modal')?.textContent ?? '',
    disabled: document.querySelector('.modal .button--danger')?.disabled
  }))()`);
  record('the EXE delete dialog shows the broadcast facts and starts disabled', dialog.disabled === true
    && dialog.body.includes('EXE 主播乙')
    && dialog.body.includes('EXE Delete Target 删除目标'), {disabled: dialog.disabled});
  await evaluate(`(() => {
    const input = document.querySelector('.modal input[type="checkbox"]');
    input.checked = true;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('.modal .button--danger').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.history-row').length === 0`, {timeout: 10000});
  await sleep(700);
  const deletedSession = await fetch(`${base}/api/sessions/${deleteId}`);
  record('permanent delete removes the session from the packaged EXE', deletedSession.status === 404, {
    session: deleteId,
    status: deletedSession.status
  });
  const deletedViewer = await fetch(`${base}/api/viewers/bilibili:930099`);
  record('a viewer that only existed in the deleted session is cleaned up', deletedViewer.status === 404);

  // Delete a second session that shares its viewer with the first session, so
  // the shared viewer must survive with recomputed aggregates.
  await setSearch('EXE Other Session');
  view = await evaluate(ROWS);
  await openMenu(0);
  await clickMenu('Delete permanently');
  await waitFor("Boolean(document.querySelector('.modal'))");
  await evaluate(`(() => {
    const input = document.querySelector('.modal input[type="checkbox"]');
    input.checked = true;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('.modal .button--danger').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.history-row').length === 0`, {timeout: 10000});
  await sleep(700);
  const sharedViewer = await (await fetch(`${base}/api/viewers/youtube:UC_EXE_SHARED`)).json();
  const sharedSessions = (sharedViewer.sessions ?? []).map((row) => row.sessionId);
  record('the shared viewer keeps only the remaining session and its aggregates', sharedViewer.viewer?.sessionCount === 1
    && sharedSessions.length === 1
    && sharedViewer.viewer?.messageCount === 2
    && sharedViewer.viewer?.paymentEventCount === 1, {
    sessionCount: sharedViewer.viewer?.sessionCount,
    messageCount: sharedViewer.viewer?.messageCount,
    paymentEventCount: sharedViewer.viewer?.paymentEventCount,
    sessions: sharedSessions
  });

  await stopExe();

  instance = await launchExe();
  await useEnglishUi();
  const restartedStatus = await (await fetch(`${base}/api/status`)).json();
  record('restarting the EXE keeps schema 12 and no running capture', restartedStatus.database.schemaVersion === 12
    && (restartedStatus.platform.activeCount ?? 0) === 0, {
    schema: restartedStatus.database.schemaVersion,
    activeCount: restartedStatus.platform.activeCount
  });
  const archivedSearch = await (await fetch(`${base}/api/history/search?q=EXE%20Archive%20Target&includeArchived=1`)).json();
  record('archive state survives an EXE restart', archivedSearch.total === 1 && archivedSearch.sessions[0].archived === true, {
    total: archivedSearch.total,
    archived: archivedSearch.sessions[0]?.archived
  });
  const deletedSearch = await (await fetch(`${base}/api/history/search?q=EXE%20Delete%20Target&includeArchived=1`)).json();
  record('deleted history does not come back after an EXE restart', deletedSearch.total === 0, {total: deletedSearch.total});

  await navigate('/history');
  await setSearch('Shared EXE Viewer');
  view = await evaluate(ROWS);
  record('viewer search still works after the EXE restart', view.rows.length === 1, {
    titles: view.rows.map((row) => row.title)
  });
} finally {
  await stopExe();
}

const failed = report.checks.filter((check) => !check.passed);
console.log(`\nSummary: ${report.checks.length - failed.length} passed, ${failed.length} failed`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
socket.close();
rmSync(root, {recursive: true, force: true});
process.exit(failed.length === 0 ? 0 : 1);
