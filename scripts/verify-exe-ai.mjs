/**
 * Real packaged-EXE verification for the M6 AI file round trip.
 *
 *   1. creates a real schema-v7 data folder with a seeded broadcast, so the
 *      packaged EXE must perform the v7 → v8 upgrade;
 *   2. copies dist/LiveMemory.exe to a temporary asInvoker build (this session is
 *      not elevated; the shipped EXE manifest is requireAdministrator);
 *   3. launches the EXE and drives the real console through headless Chrome:
 *      create a 3-batch task, import each batch JSON via paste, create the
 *      aggregate package, import the final JSON and read the report;
 *   4. restarts the EXE and checks that the task, result versions, report and
 *      schema survive.
 *
 *   node scripts/verify-exe-ai.mjs [--port 49330] [--debug-port 9224]
 *
 * The seeded broadcast and the AI answers are synthetic fixtures. This verifies
 * the packaged binary and validation/UI behaviour, not a real AI service.
 */

import {spawn} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {currentSchemaVersion, MIGRATIONS} from '../src/storage/database/migrations/index.mjs';
import {createSession, endSession} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {readZipEntry} from '../src/shared/zip.mjs';
import {setManifestLevel} from './pe-manifest.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const requestedPort = Number(argValue('--port', 0));
const debugPort = Number(argValue('--debug-port', 9224));
const root = resolve('tests', '.tmp', `exe-ai-${Date.now()}`);
const dataDir = join(root, 'data');
const shotsDir = resolve('docs', 'screenshots');
const reportPath = join(resolve('tests', '.tmp'), 'exe-ai-report.json');
mkdirSync(dataDir, {recursive: true});
mkdirSync(shotsDir, {recursive: true});

const port = requestedPort > 0 ? requestedPort : await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolvePort(assigned));
  });
});
const base = `http://127.0.0.1:${port}`;
const report = {checks: []};
function record(name, passed, details = {}) {
  report.checks.push({name, passed, ...details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

const T0 = Date.parse('2026-11-08T02:00:00.000Z');

/* ------------------------------------------------------- schema-v7 fixture */

function migrateToV7(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 7).sort((a, b) => a.version - b.version)) {
    db.exec('BEGIN IMMEDIATE');
    migration.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, T0);
    db.exec('COMMIT');
  }
}

const dbFile = join(dataDir, 'database', 'livememory.db');
const db = openDatabase({file: dbFile});
migrateToV7(db);
if (currentSchemaVersion(db) !== 7) throw new Error('fixture did not stop at schema v7');
const broadcasterId = 'youtube:UC_EXE_AI';
upsertBroadcaster(db, {
  id: broadcasterId,
  platform: 'youtube',
  platformUid: 'UC_EXE_AI',
  displayName: 'EXE AI 主播',
  identity: 'verified',
  seenAt: T0,
  now: T0
});
const session = createSession(db, {
  platform: 'youtube',
  platformRoomId: 'exe-ai-room',
  roomTitle: 'EXE AI Round Trip 演示场次',
  broadcasterName: 'EXE AI 主播',
  broadcasterId,
  broadcasterIdentity: 'verified',
  storageMode: 'full',
  sourceQuality: 'mock',
  simulated: true,
  startedAt: T0
});
const ingest = new EventIngest({db});
for (let index = 0; index < 250; index += 1) {
  ingest.record({
    session_id: session.id,
    platform: 'youtube',
    event_type: 'chat',
    viewer_uid: `UC_EXE_AI_${index % 3}`,
    display_name: `EXE Viewer ${index % 3}`,
    occurred_at: T0 + 1000 + index * 1000,
    content: `EXE AI round trip message ${index}${index === 0 ? ' 😂' : ''}`,
    external_id: `exe-ai-${index}`,
    source_quality: 'mock'
  });
}
endSession(db, session.id, {status: 'ended', endedAt: T0 + 300_000, reason: 'adapter_end'});
closeDatabase(db);
record('fixture is a real schema-v7 database with a recorded broadcast', existsSync(dbFile));

/* --------------------------------------------------------------- EXE copy */

const distExe = resolve('dist', 'LiveMemory.exe');
if (!existsSync(distExe)) throw new Error('dist/LiveMemory.exe is missing; run scripts/build-windows.mjs first');
const exe = join(root, 'LiveMemory.asInvoker.exe');
copyFileSync(distExe, exe);
const exeBytes = readFileSync(exe);
setManifestLevel(exeBytes, 'asInvoker');
writeFileSync(exe, exeBytes);

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
    env: {...process.env, LIVE_MEMORY_SKIP_ADMIN_CHECK: '1'},
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
  let exitInfo = null;
  instance.on('exit', (code, signal) => { exitInfo = {code, signal}; });
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
  return instance;
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
async function waitFor(expression, {timeout = 15000, interval = 120} = {}) {
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
async function clickButton(text) {
  return evaluate(`(() => {
    const node = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)});
    if (!node) throw new Error('button not found: ' + ${JSON.stringify(text)});
    node.click();
    return true;
  })()`);
}
async function pasteJson(text) {
  await evaluate(`(() => {
    const textarea = document.querySelector('.import-textarea');
    textarea.value = ${JSON.stringify(text)};
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  await sleep(200);
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  writeFileSync(join(shotsDir, name), Buffer.from(result.data, 'base64'));
}

/* ------------------------------------------------------------ answer data */

function readPackage(pkg) {
  return readFileSync(join(dataDir, 'exports', pkg.fileName));
}
function makeBatchAnswer(manifest, messages, viewers, label) {
  const start = messages[0].at;
  const end = messages[messages.length - 1].at;
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: 'en',
    session_topics: {
      summary: `EXE batch ${label} analysis.`,
      topics: [{
        title: `EXE topic ${label}`,
        started_at: start,
        ended_at: end,
        summary: 'The packaged EXE validated and imported this batch.',
        key_points: ['Imported from a real packaged EXE', 'Evidence resolves to a real message'],
        confidence: 0.8,
        evidence: 'observed',
        message_refs: [1, 2]
      }],
      sentiment: [{at: start, tone: 'neutral', note: 'Synthetic verification answer.', confidence: 0.6}],
      disputes: [],
      highlights: [{
        started_at: start,
        ended_at: end,
        title: 'EXE highlight',
        reason: 'Synthetic batch highlight.',
        clip_suggestion: 'Candidate range only.',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [1]
      }]
    },
    viewer_profiles: viewers.length > 0 ? [{
      viewer_id: viewers[0].viewer_id,
      interests: [{topic: 'EXE verification', strength: 'emerging', evidence: 'observed', note: 'Synthetic.'}],
      dislikes: [],
      summary: 'Synthetic viewer profile.',
      confidence: 0.5
    }] : []
  };
}

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
  record('packaged EXE upgrades the real v7 database to schema 9', status.database.schemaVersion === 9
    && status.server.version === '0.8.1', {schema: status.database.schemaVersion, version: status.server.version});
  record('the packaged EXE reports AI import as available', status.ai.import === true);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});
  await navigate('/ai');
  let view = await evaluate(`(() => ({
    sessions: [...document.querySelectorAll('select option')].map((option) => option.textContent),
    hasFileInput: Boolean(document.querySelector('input[type="file"]')),
    hasTextarea: Boolean(document.querySelector('.import-textarea')),
    lastError: window.__lmLastError ?? null
  }))()`);
  record('the packaged EXE AI centre loads the recorded broadcast and both import modes', view.sessions.some((text) => text.includes('EXE AI Round Trip'))
    && view.hasFileInput && view.hasTextarea && !view.lastError, {lastError: view.lastError});

  await evaluate(`(() => {
    const input = document.querySelector('.advanced input[type="number"]');
    input.value = '100';
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  await clickButton('Create task and export packages');
  await waitFor("document.querySelectorAll('.job-row').length === 1", {timeout: 20000});
  view = await evaluate(`(() => ({
    status: [...document.querySelectorAll('.job-row .chip')].map((node) => node.textContent),
    packageRows: document.querySelectorAll('.job-packages .package-row').length,
    lastError: window.__lmLastError ?? null
  }))()`);
  record('the packaged EXE creates a 3-batch task and exports every package', view.packageRows === 3
    && view.status.includes('Waiting for import') && !view.lastError, {
    packageRows: view.packageRows,
    status: view.status,
    lastError: view.lastError
  });

  const jobsPayload = await (await fetch(`${base}/api/ai/jobs?sessionId=${encodeURIComponent(session.id)}`)).json();
  const job = jobsPayload.jobs?.[0];
  if (!job) throw new Error('job was not created in the packaged EXE');
  const sortedPackages = job.packages.slice().sort((a, b) => a.batchIndex - b.batchIndex);
  record('all exported package files exist on disk', sortedPackages.every((pkg) => existsSync(join(dataDir, 'exports', pkg.fileName))));

  const batchAnswers = [];
  for (const pkg of sortedPackages) {
    const archive = readPackage(pkg);
    const manifest = JSON.parse(readZipEntry(archive, 'manifest.json').toString('utf8'));
    const messages = readZipEntry(archive, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const viewers = JSON.parse(readZipEntry(archive, 'viewer_context.json').toString('utf8'));
    batchAnswers.push({pkg, manifest, messages, viewers, answer: makeBatchAnswer(manifest, messages, viewers, pkg.batchIndex)});
  }

  for (const [index, entry] of batchAnswers.entries()) {
    await pasteJson(JSON.stringify(entry.answer));
    await clickButton('Validate answer');
    await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 10000});
    await clickButton('Import result');
    const expected = index < batchAnswers.length - 1 ? 'Partially imported' : 'Waiting for aggregate';
    await waitFor(`[...document.querySelectorAll('.job-row .chip')].some((node) => node.textContent === ${JSON.stringify(expected)})`, {timeout: 15000});
    await sleep(700);
  }
  view = await evaluate(`(() => ({
    status: [...document.querySelectorAll('.job-row .chip')].map((node) => node.textContent),
    versions: [...document.querySelectorAll('.job-meta')].map((node) => node.textContent).join(' | '),
    aggregateButton: [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Create aggregate package'),
    lastError: window.__lmLastError ?? null
  }))()`);
  record('the packaged EXE imports three batch answers out of the browser and tracks versions',
    view.status.includes('Waiting for aggregate')
      && view.aggregateButton
      && ['B1 v1', 'B2 v1', 'B3 v1'].every((text) => view.versions.includes(text)), {
    status: view.status,
    versions: view.versions,
    lastError: view.lastError
  });

  await clickButton('Create aggregate package');
  await waitFor("document.querySelectorAll('.job-packages .package-row').length === 4", {timeout: 20000});
  const jobAfterAggregate = await (await fetch(`${base}/api/ai/jobs/${encodeURIComponent(job.id)}`)).json();
  const aggregatePackage = jobAfterAggregate.packages.find((pkg) => pkg.stage === 'aggregate');
  record('the packaged EXE builds the stage-2 aggregate package', Boolean(aggregatePackage)
    && existsSync(join(dataDir, 'exports', aggregatePackage.fileName)), {
    aggregate: aggregatePackage?.fileName
  });

  const aggregateArchive = readFileSync(join(dataDir, 'exports', aggregatePackage.fileName));
  const aggregateManifest = JSON.parse(readZipEntry(aggregateArchive, 'manifest.json').toString('utf8'));
  const aggregateBatches = JSON.parse(readZipEntry(aggregateArchive, 'batch_results.json').toString('utf8'));
  const finalAnswer = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: aggregateManifest.job_id,
    broadcaster_id: aggregateManifest.broadcaster_id,
    task_id: aggregateManifest.tasks[0].task_id,
    session_id: aggregateManifest.session_id,
    locale: 'en',
    session_topics: {
      summary: 'EXE aggregate verification complete: all three imported batches were merged into one report.',
      topics: [{
        title: 'EXE merged topic',
        started_at: aggregateBatches[0].result.session_topics.topics[0].started_at,
        ended_at: aggregateBatches[aggregateBatches.length - 1].result.session_topics.topics[0].ended_at,
        summary: 'This final report comes from the packaged EXE aggregate import.',
        key_points: ['Three batches merged', 'Evidence spans batches 1 and 3'],
        confidence: 0.75,
        evidence: 'inferred',
        message_refs: [{batch: 1, seq: 1}, {batch: 3, seq: 1}]
      }],
      sentiment: [{
        at: aggregateBatches[0].result.session_topics.topics[0].started_at,
        tone: 'mixed',
        note: 'Synthetic aggregate sentiment.',
        confidence: 0.5
      }],
      disputes: [],
      highlights: [{
        started_at: aggregateBatches[0].result.session_topics.topics[0].started_at,
        ended_at: aggregateBatches[aggregateBatches.length - 1].result.session_topics.topics[0].ended_at,
        title: 'EXE aggregate highlight',
        reason: 'Synthetic aggregate reason.',
        clip_suggestion: 'Candidate time range only.',
        confidence: 0.6,
        evidence: 'inferred',
        message_refs: [{batch: 2, seq: 1}]
      }]
    },
    viewer_profiles: []
  };
  await pasteJson(JSON.stringify(finalAnswer));
  await clickButton('Validate answer');
  await waitFor("Boolean(document.querySelector('.import-preview-body'))", {timeout: 10000});
  await clickButton('Import result');
  await waitFor("Boolean(document.querySelector('.report-summary'))", {timeout: 20000});
  await sleep(900);
  view = await evaluate(`(() => ({
    status: [...document.querySelectorAll('.job-row .chip')].map((node) => node.textContent),
    summary: document.querySelector('.report-summary')?.textContent ?? '',
    topics: document.querySelectorAll('.report-topic').length,
    provenance: document.querySelector('.report-provenance')?.textContent ?? '',
    evidenceButton: Boolean(document.querySelector('.report-evidence-toggle')),
    lastError: window.__lmLastError ?? null
  }))()`);
  record('importing the final aggregate answer shows the complete packaged-EXE report',
    view.summary.includes('EXE aggregate verification complete')
      && view.topics >= 1
      && view.status.includes('Complete')
      && view.evidenceButton
      && !view.lastError, {
    summary: view.summary.slice(0, 80),
    status: view.status,
    lastError: view.lastError
  });

  const evidence = await evaluate(`(() => {
    const button = document.querySelector('.report-evidence-toggle');
    button?.click();
    const rows = document.querySelectorAll('.report-evidence-row');
    return {
      rows: rows.length,
      text: [...rows].map((row) => row.textContent).join(' | ')
    };
  })()`);
  record('the packaged-EXE report resolves evidence to real messages from the EXE database',
    evidence.rows >= 1 && evidence.text.includes('EXE AI round trip message'), {
    rows: evidence.rows,
    sample: evidence.text.slice(0, 120)
  });
  await screenshot('ai-exe-report-v080.png');

  const reportPayload = await (await fetch(`${base}/api/ai/sessions/${encodeURIComponent(session.id)}/report`)).json();
  record('the report API marks the packaged-EXE task complete with one final result',
    reportPayload.complete === true
      && reportPayload.mode === 'final'
      && reportPayload.primaryJob.batchesImported === 3, {
    mode: reportPayload.mode,
    complete: reportPayload.complete,
    batches: reportPayload.primaryJob.batchesImported
  });

  await stopExe();
  instance = await launchExe();
  await useEnglishUi();
  const restartedStatus = await (await fetch(`${base}/api/status`)).json();
  const restartedReport = await (await fetch(`${base}/api/ai/sessions/${encodeURIComponent(session.id)}/report`)).json();
  record('the packaged EXE keeps schema 9, the task, result versions and the report after a restart',
    restartedStatus.database.schemaVersion === 9
      && restartedReport.complete === true
      && restartedReport.result.resultVersion === 1
      && restartedReport.report.summary.includes('EXE aggregate verification complete'), {
    schema: restartedStatus.database.schemaVersion,
    mode: restartedReport.mode
  });

  await navigate(`/ai?session=${encodeURIComponent(session.id)}&report=1`);
  view = await evaluate(`(() => ({
    reportTitle: document.querySelector('.report-title')?.textContent ?? null,
    summary: document.querySelector('.report-summary')?.textContent ?? '',
    lastError: window.__lmLastError ?? null
  }))()`);
  record('the packaged EXE still renders the imported report in the real UI after a restart',
    view.reportTitle === 'Live analysis report'
      && view.summary.includes('EXE aggregate verification complete')
      && !view.lastError, {reportTitle: view.reportTitle, lastError: view.lastError});

  const exportFiles = readdirSync(join(dataDir, 'exports')).filter((name) => name.endsWith('.zip'));
  record('all four packages remain in the EXE data folder after restart', exportFiles.length === 4, {
    files: exportFiles.length
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
