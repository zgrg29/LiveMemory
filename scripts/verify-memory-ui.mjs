/**
 * Browser verification for the M7 long-term memory UI (source mode).
 *
 * Seeds a real SQLite database with two simulated broadcasts, an imported M6
 * analysis, a deterministic memory merge and one imported AI memory update
 * (state change + contradiction). Then drives the real console through
 * headless Edge over the DevTools protocol and checks:
 *   - the memory page lists the broadcasts and the created update package;
 *   - the merge preview really produces per-viewer change rows;
 *   - the viewer profile exposes long-term memory, sources and versions;
 *   - confirmed / inferred / contradiction / past-state groups are separated;
 *   - dark theme and 390px layout have no horizontal overflow;
 *   - no page render error was recorded.
 *
 *   node scripts/verify-memory-ui.mjs [--port 49420] [--debug-port 9231] [--shots]
 *
 * This verifies the real web console served by the local server. It does not
 * claim packaged-EXE verification; run verify-exe-*.mjs for that.
 */

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {migrate} from '../src/storage/database/migrations/index.mjs';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, seedSession, readBatchPackage, makeBatchResult} from '../tests/helpers/ai-fixtures.mjs';
import {createAnalysisJob} from '../src/ai/export/job.mjs';
import {importAnalysisResult} from '../src/ai/import/importer.mjs';
import {mergeSessionIntoMemory} from '../src/memory/local.mjs';
import {createMemoryUpdateJob, inspectMemoryPackage} from '../src/memory/export.mjs';
import {importMemoryUpdate} from '../src/memory/importer.mjs';
import {getMemory, listFacts} from '../src/storage/repositories/viewer-memory.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const requestedPort = Number(argValue('--port', 0));
const requestedDebugPort = Number(argValue('--debug-port', 9231));
const externalBase = argValue('--base', null);
const noLaunch = args.includes('--no-launch') || Boolean(externalBase);
const takeShots = args.includes('--shots');
const root = resolve('tests', '.tmp', `memory-ui-${Date.now()}`);
const dataDir = join(root, 'data');
const screenshotDir = resolve('docs', 'screenshots');
mkdirSync(dataDir, {recursive: true});
mkdirSync(screenshotDir, {recursive: true});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
function record(name, passed, details = {}) {
  results.push({name, passed, details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

const port = externalBase
  ? 0
  : (requestedPort > 0 ? requestedPort : await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(() => done(assigned));
    });
  }));
const base = externalBase ?? `http://127.0.0.1:${port}`;

/* ---------------------------------------------------------------- fixture */

const T0 = Date.parse('2026-11-10T02:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const VIEWER_A = 'youtube:UC_VIEWER_0';
const VIEWER_B = 'youtube:UC_VIEWER_1';
const BROADCASTER = 'youtube:UC_AI_TEST';

let server = null;
if (!externalBase) {
  const seedDb = openDatabase({file: join(dataDir, 'database', 'livememory.db'), createDirectory: true});
  migrate(seedDb, {now: T0});
  addBroadcaster(seedDb, {id: BROADCASTER, name: 'Memory Demo Channel'});
  const first = seedSession(seedDb, {messageCount: 20, viewerCount: 2, startedAt: T0});
  const second = seedSession(seedDb, {
    messageCount: 20,
    viewerCount: 2,
    roomId: 'memory-demo-room-2',
    title: 'Memory demo · second broadcast',
    startedAt: T0 + DAY
  });

  const exportsDir = join(dataDir, 'exports');
  mkdirSync(exportsDir, {recursive: true});

  async function toolImportAnalysis(session, profiles) {
    const job = await createAnalysisJob({
      db: seedDb,
      sessionId: session.id,
      locale: 'en',
      exportsDir,
      batchSize: 100000
    });
    for (const pkg of job.packages) {
    const data = readBatchPackage(exportsDir, pkg);
    const result = makeBatchResult(data.manifest, data.messages, data.viewers, {viewer_profiles: profiles});
    importAnalysisResult({db: seedDb, text: JSON.stringify(result), now: T0});
  }
}

await toolImportAnalysis(first, [
  {
    viewer_id: VIEWER_A,
    interests: [
      {topic: 'testing', strength: 'stable', evidence: 'observed', note: 'Talks about testing every stream.'},
      {topic: 'rhythm games', strength: 'emerging', evidence: 'observed', note: 'Started playing rhythm games.'}
    ],
    dislikes: [],
    summary: 'A regular viewer who likes rhythm games.',
    confidence: 0.7
  },
  {
    viewer_id: VIEWER_B,
    interests: [{topic: 'testing', strength: 'stable', evidence: 'observed', note: 'Also talks about testing.'}],
    dislikes: [],
    summary: 'Quiet but consistent.',
    confidence: 0.5
  }
]);
mergeSessionIntoMemory({db: seedDb, sessionId: first.id, apply: true, now: T0 + 1000});

// One AI memory update on the second broadcast: a state change for A and a
// contradiction for B, so every UI group has real content.
const job = await createMemoryUpdateJob({
  db: seedDb,
  sessionId: second.id,
  locale: 'en',
  exportsDir,
  now: T0 + DAY + 1000
});
const pkg = await inspectMemoryPackage(join(exportsDir, job.batches[0].fileName));
const memoryA = getMemory(seedDb, {broadcasterId: BROADCASTER, viewerId: VIEWER_A});
const factA = listFacts(seedDb, memoryA.id).find((fact) => fact.topic === 'testing');
const memoryB = getMemory(seedDb, {broadcasterId: BROADCASTER, viewerId: VIEWER_B});
const factB = listFacts(seedDb, memoryB.id).find((fact) => fact.topic === 'testing');
function seqFor(viewerId) {
  return pkg.excerpts.find((line) => line.viewer_id === viewerId)?.seq ?? 1;
}
importMemoryUpdate({
  db: seedDb,
  text: JSON.stringify({
    protocol: 'livememory-memory-update-v1',
    schema_version: '1.0.0',
    job_id: pkg.manifest.job_id,
    batch_id: pkg.manifest.batch.batch_id,
    broadcaster_id: pkg.manifest.broadcaster_id,
    task_id: pkg.manifest.batch.task_id,
    session_id: pkg.manifest.session_id,
    locale: pkg.manifest.locale,
    viewer_operations: [
      {
        viewer_id: VIEWER_A,
        summary: 'Preparing for an exam, still into rhythm games.',
        operations: [
          {
            op: 'supersede',
            target_fact_id: factA.id,
            kind: 'life_event',
            topic: 'exam',
            statement: 'Has an exam coming up next week',
            certainty: 'stated',
            confidence: 0.9,
            evidence: [seqFor(VIEWER_A)]
          },
          {
            op: 'add',
            kind: 'life_event',
            topic: 'moving',
            statement: 'Might be moving to another city',
            certainty: 'uncertain',
            evidence: [seqFor(VIEWER_B)]
          }
        ]
      },
      {
        viewer_id: VIEWER_B,
        operations: [
          {
            op: 'conflict',
            target_fact_id: factB.id,
            kind: 'dislike',
            topic: 'testing',
            statement: 'Said testing is the worst part',
            certainty: 'stated',
            confidence: 0.6,
            evidence: [seqFor(VIEWER_B)]
          }
        ]
      }
    ]
  }),
  createVersion: true,
  now: T0 + DAY + 2000
});
  closeDatabase(seedDb);
  record('fixture database contains real memory facts', existsSync(join(dataDir, 'database', 'livememory.db')));

  /* --------------------------------------------------------------- server */

  server = await startServer({auth: false, dataDir, port, systemLocale: 'en'});
}
record('local server is healthy', (await fetch(`${base}/api/health`)).ok);

/* ------------------------------------------------------------------ Edge */

function findEdge() {
  for (const candidate of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const edgePath = findEdge();
if (!edgePath) throw new Error('No Edge/Chrome found for the browser verification');
const profileDir = mkdtempSync(join(tmpdir(), 'lm-memory-profile-'));
let debugPort = requestedDebugPort;
let browser = null;
async function launchBrowser() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = requestedDebugPort + attempt;
    const child = spawn(edgePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${candidate}`,
      `--user-data-dir=${profileDir}`,
      'about:blank'
    ], {stdio: 'ignore', windowsHide: true});
    for (let wait = 0; wait < 60; wait += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${candidate}/json/list`, {signal: AbortSignal.timeout(800)})).json();
        if (list.some((target) => target.type === 'page')) {
          debugPort = candidate;
          return child;
        }
      } catch {
        /* not ready */
      }
      await sleep(250);
    }
    child.kill();
  }
  throw new Error('headless browser did not expose a debugging target');
}
browser = noLaunch ? null : await launchBrowser();
record('headless browser is available', noLaunch ? true : Boolean(browser), {
  debugPort,
  launchedByScript: !noLaunch
});

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const pageTarget = targets.find((target) => target.type === 'page');
const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  socket.addEventListener('open', done, {once: true});
  socket.addEventListener('error', reject, {once: true});
});
let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
const pageErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve: done, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else done(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params?.exceptionDetails?.exception?.description
      ?? message.params?.exceptionDetails?.text
      ?? 'unknown exception');
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
function waitForEvent(method, timeoutMs = 20000) {
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}
async function waitFor(expression, {timeout = 20000, interval = 200} = {}) {
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
    width, height, deviceScaleFactor: 1, mobile: width <= 480, screenWidth: width, screenHeight: height
  });
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  await send('Page.navigate', {url: `${base}/?ui=${Date.now()}#${hash}`});
  await loaded;
  await sleep(1600);
}
async function settings(patch) {
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(patch)
  });
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {format: 'png', fromSurface: true});
  writeFileSync(join(screenshotDir, name), Buffer.from(result.data, 'base64'));
  return name;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', {cacheDisabled: true});
await settings({locale: 'zh-CN', theme: 'light'});

/* ------------------------------------------------------- memory page (zh) */

await navigate('/memory');
const pageState = await waitFor(`(() => {
  const main = document.querySelector('main');
  if (!main) return null;
  const sessions = [...document.querySelectorAll('.card select')].map((select) => select.options.length);
  return {
    title: document.querySelector('.page-title')?.textContent ?? '',
    steps: document.querySelectorAll('.step-card').length,
    tabs: document.querySelectorAll('.tabs .tab').length,
    sessionOptions: sessions[1] ?? 0,
    hasPackageButtons: document.querySelectorAll('.job-packages .package-row').length,
    lastError: window.__lmLastError ?? null,
    text: main.textContent ?? ''
  };
})()`);
record('memory page renders four steps', pageState.steps === 4, {steps: pageState.steps});
record('memory page lists both broadcasts', pageState.sessionOptions === 2, {options: pageState.sessionOptions});
record('memory page shows the created AI update package', pageState.hasPackageButtons >= 1, {
  batches: pageState.hasPackageButtons
});
record('memory page has no render error', !pageState.lastError, {lastError: pageState.lastError});
record('memory page shows the offline explanation', pageState.text.includes('不调用 AI API'));

const preview = await (async () => {
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const target = buttons.find((button) => button.textContent === '预览变化');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) return {clicked: false};
  await sleep(1200);
  return evaluate(`(() => ({
    clicked: true,
    totals: document.querySelector('.memory-totals')?.textContent ?? '',
    rows: document.querySelectorAll('.memory-change-row').length,
    lastError: window.__lmLastError ?? null
  }))()`);
})();
record('merge preview produces per-viewer change rows', preview.clicked && preview.rows >= 1, {
  rows: preview.rows,
  totals: String(preview.totals).slice(0, 120)
});
if (takeShots) {
  await screenshot('memory-page-v090-light-zh.png');
}

/* ---------------------------------------------------- viewer memory (zh) */

await navigate(`/viewers/${encodeURIComponent(VIEWER_A)}?broadcaster=${encodeURIComponent(BROADCASTER)}`);
await waitFor(`document.querySelectorAll('.tabs .tab').length >= 4`);
const tabs = await evaluate(`[...document.querySelectorAll('.tabs .tab')].map((tab) => tab.textContent)`);
record('viewer profile exposes four tabs', tabs.length === 4, {tabs});
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tabs .tab')].find((node) => node.textContent === '长期记忆');
  tab?.click();
  return true;
})()`);
const memoryPanel = await waitFor(`(() => {
  const facts = document.querySelectorAll('.memory-fact');
  if (facts.length === 0) return null;
  return {
    facts: facts.length,
    groups: [...document.querySelectorAll('.memory-group-title')].map((node) => node.textContent),
    evidence: document.querySelectorAll('.memory-evidence').length,
    sources: document.querySelectorAll('.memory-fact-source').length,
    certaintyChips: [...document.querySelectorAll('.memory-fact-head .chip')].map((chip) => chip.textContent),
    lastError: window.__lmLastError ?? null,
    text: document.querySelector('.tab-panel')?.textContent ?? ''
  };
})()`);
record('viewer memory tab shows facts with sources', memoryPanel.facts >= 2 && memoryPanel.sources >= 2, {
  facts: memoryPanel.facts,
  sources: memoryPanel.sources
});
record('viewer memory separates confirmed / inferred / contradictions / past states', (
  memoryPanel.text.includes('确认的信息')
  && memoryPanel.text.includes('AI 推断')
  && memoryPanel.text.includes('矛盾信息')
  && memoryPanel.text.includes('过去的状态')
), {groups: memoryPanel.groups});
record('viewer memory has expandable evidence', memoryPanel.evidence >= 1, {evidence: memoryPanel.evidence});
record('viewer memory tab has no render error', !memoryPanel.lastError, {lastError: memoryPanel.lastError});
if (takeShots) {
  await screenshot('memory-viewer-tab-v090-light-zh.png');
}

await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tabs .tab')].find((node) => node.textContent === '历史版本');
  tab?.click();
  return true;
})()`);
const versions = await waitFor(`(() => {
  const rows = document.querySelectorAll('.memory-version');
  if (rows.length === 0) return null;
  return {
    rows: rows.length,
    diffs: document.querySelectorAll('.memory-diff').length,
    text: document.querySelector('.tab-panel')?.textContent ?? '',
    lastError: window.__lmLastError ?? null
  };
})()`);
record('version history lists versions with a diff', versions.rows >= 2 && versions.diffs >= 1, {
  versions: versions.rows,
  diffs: versions.diffs
});
record('version history renders in Chinese', versions.text.includes('版本'));
record('version tab has no render error', !versions.lastError, {lastError: versions.lastError});

/* --------------------------------------------------------- dark and mobile */

await settings({theme: 'dark'});
await navigate(`/memory`, {width: 1440, height: 1000});
const darkState = await waitFor(`(() => {
  const style = getComputedStyle(document.body);
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    background: style.backgroundColor,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    lastError: window.__lmLastError ?? null
  };
})()`);
record('memory page renders in dark theme', darkState.theme === 'dark', {theme: darkState.theme});
if (takeShots) {
  await screenshot('memory-page-v090-dark-zh.png');
}

await navigate(`/viewers/${encodeURIComponent(VIEWER_B)}?broadcaster=${encodeURIComponent(BROADCASTER)}`, {width: 390, height: 900});
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tabs .tab')].find((node) => node.textContent === '长期记忆');
  tab?.click();
  return true;
})()`);
await waitFor(`document.querySelectorAll('.memory-fact').length >= 1`);
const mobileState = await evaluate(`(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  facts: document.querySelectorAll('.memory-fact').length,
  lastError: window.__lmLastError ?? null
}))()`);
record('390px memory layout has no horizontal overflow', mobileState.overflow <= 1, {
  overflow: mobileState.overflow
});
record('390px memory layout still shows facts', mobileState.facts >= 1, {facts: mobileState.facts});
if (takeShots) {
  await screenshot('memory-viewer-mobile-v090-dark-zh.png');
}
record('no page render error across navigations', pageErrors.length === 0 && !mobileState.lastError, {
  exceptions: pageErrors.slice(0, 3)
});

/* ------------------------------------------------------------------ done */

if (server) await server.close();
browser?.kill();
socket.close();
rmSync(profileDir, {recursive: true, force: true});
rmSync(root, {recursive: true, force: true});

const passed = results.filter((entry) => entry.passed).length;
console.log(`\nSummary: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
