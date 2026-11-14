import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {manifestLevel} from './pe-manifest.mjs';
import {startServer} from '../src/server/index.mjs';
import {inspectBackup} from '../src/server/backup/inspect.mjs';
import {importSessionAnalysis} from '../tests/helpers/memory-fixtures.mjs';
import {mergeSessionIntoMemory} from '../src/memory/local.mjs';

/**
 * RC0 P0-2 formal EXE verification.
 *
 * Proves, against the packaged binary and isolated data directories:
 * - the manifest is asInvoker and the EXE serves the console without UAC;
 * - backup creation, verification and the pre-restore safety snapshot;
 * - restore into a brand-new absolute data directory;
 * - restart of the restored installation;
 * - a second backup after the restore verifies and matches the data;
 * - API key / Bilibili credentials are absent from both archive and restored
 *   secrets folder.
 *
 * The seed data (including an AI report and long-term facts) is produced by the
 * same source tree before the EXE is launched; every backup/restore operation is
 * performed by the packaged binary over authenticated HTTP.
 *
 * This is NOT a real Windows file-dialog click and NOT a real browser click.
 *
 * Usage: node scripts/verify-p0-2-exe.mjs [path/to/LiveMemory.exe]
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `p02-exe-${stamp}`);
const seedDir = join(root, 'seed-data');
const workDir = join(root, 'working-data');
const restoredDir = join(root, 'restored-data');
const backupDir = join(root, 'backups');
const firstBackup = join(backupDir, 'before.livememory');
const secondBackup = join(backupDir, 'after.livememory');
const bootstrapFile = join(root, 'bootstrap.url');
mkdirSync(backupDir, {recursive: true});

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let child = null;
let exitInfo = null;
let port = 0;
let cookie = null;

function log(line) {
  process.stdout.write(`[p0-2-exe] ${line}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port;
      probe.close(() => resolvePort(value));
    });
  });
}

async function waitFor(check, {timeout = 45000, interval = 200, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

async function api(path, {method = 'GET', body = undefined} = {}) {
  const headers = cookie ? {cookie} : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {status: response.status, payload, text};
}

async function waitJob(id) {
  return waitFor(async () => {
    const response = await api(`/api/backup/jobs/${encodeURIComponent(id)}`);
    const job = response.payload?.job;
    return job && job.status !== 'running' ? job : null;
  }, {timeout: 120000, label: `backup job ${id}`});
}

async function exchangeSession() {
  const browserUrl = await waitFor(() => {
    if (!existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeout: 20000, label: 'bootstrap URL'});
  const token = decodeURIComponent(new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, ''));
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token})
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function launchExe(dataDir, tag) {
  port = await freePort();
  cookie = null;
  try {
    rmSync(bootstrapFile, {force: true});
  } catch {
    /* ignore */
  }
  const stdoutFile = join(root, `${tag}-stdout.log`);
  const stderrFile = join(root, `${tag}-stderr.log`);
  child = spawn(distExe, ['--no-open', '--port', String(port), '--data-dir', dataDir, '--lang', 'en'], {
    cwd: root,
    env: {
      ...process.env,
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile
    },
    stdio: ['ignore', openSync(stdoutFile, 'a'), openSync(stderrFile, 'a')],
    windowsHide: true
  });
  exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  await waitFor(async () => {
    if (exitInfo) {
      throw new Error(`EXE exited early: ${JSON.stringify(exitInfo)} ${readFileSync(stderrFile, 'utf8')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1000)});
      return response.ok;
    } catch {
      return false;
    }
  }, {timeout: 60000, label: `health ${tag}`});
  await exchangeSession();
  return {stdoutFile, stderrFile};
}

async function stopExe() {
  if (!child || child.exitCode !== null) return {code: child?.exitCode ?? null};
  child.kill('SIGTERM');
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (exitInfo) return exitInfo;
    await sleep(100);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  return {code: null, signal: 'forced'};
}

function dbCounts(file) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const tables = ['sessions', 'events', 'viewers', 'broadcasters', 'ai_jobs', 'ai_results', 'viewer_memories', 'memory_facts'];
    return Object.fromEntries(tables.map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    ]));
  } finally {
    db.close();
  }
}

function countsMatch(expected, actual) {
  return Boolean(actual) && Object.keys(expected).every((key) => Number(expected[key]) === Number(actual[key]));
}

function dbFacts(file) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all().map((row) => row.statement);
  } finally {
    db.close();
  }
}

function integrityOk(file) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.length === 1 && String(rows[0].integrity_check) === 'ok';
  } finally {
    db.close();
  }
}

async function seedFixture() {
  const env = {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(root, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(root, 'external-backups')
  };
  const server = await startServer({auth: false, dataDir: seedDir, port: 0, systemLocale: 'en', env});
  try {
    const base = server.url;
    const request = async (path, {method = 'GET', body} = {}) => {
      const response = await fetch(`${base}api${path}`, {
        method,
        headers: body === undefined ? undefined : {'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return {status: response.status, payload: await response.json().catch(() => null)};
    };
    const session = await request('/simulate/start', {method: 'POST', body: {title: 'P0-2 EXE broadcast', speed: 'busy'}});
    if (session.status !== 201) throw new Error(`seed simulate failed: ${session.status}`);
    const sessionId = session.payload.session.id;
    await sleep(1500);
    await request('/simulate/stop', {method: 'POST', body: {}});
    await importSessionAnalysis({db: server.db, sessionId, exportsDir: server.paths.exports});
    const merged = mergeSessionIntoMemory({db: server.db, sessionId, apply: true});
    if (!merged.ok) throw new Error('seed memory merge failed');
    await request('/settings', {method: 'PATCH', body: {locale: 'ja', theme: 'dark'}});
    writeFileSync(join(server.paths.secrets, 'bilibili-login.json'), '{"fake":"credential"}', 'utf8');
    writeFileSync(join(server.paths.secrets, 'ai-keys.json'), '{"fake":"credential"}', 'utf8');
    return {sessionId};
  } finally {
    await server.close();
  }
}

try {
  log(`exe ${distExe}`);
  log(`root ${root}`);

  const exeBytes = readFileSync(distExe);
  const sha256 = createHash('sha256').update(exeBytes).digest('hex');
  const buildInfo = JSON.parse(readFileSync(join(resolve('build'), 'build-info.json'), 'utf8'));
  const manifest = manifestLevel(exeBytes);
  record('packaged EXE is asInvoker and matches build-info', (
    manifest === 'asInvoker'
    && exeBytes.includes(Buffer.from(buildInfo.buildId, 'utf8'))
    && exeBytes.includes(Buffer.from('src/server/backup/restore.mjs', 'utf8'))
  ), [
    `manifest ${manifest}`,
    `buildId ${buildInfo.buildId}`,
    `commit ${buildInfo.commit}`,
    `sha256 ${sha256}`,
    `size ${statSync(distExe).size} bytes`
  ]);

  // Seed data with the same source tree, then copy it so the EXE works on a
  // disposable folder. This is not a user operation and never touches production.
  await seedFixture();
  cpSync(seedDir, workDir, {recursive: true});
  const seedCounts = dbCounts(join(workDir, 'database', 'livememory.db'));
  const seedFacts = dbFacts(join(workDir, 'database', 'livememory.db'));
  record('seed fixture contains sessions, AI reports and long-term memory', (
    seedCounts.sessions > 0
    && seedCounts.ai_results > 0
    && seedCounts.memory_facts > 0
    && seedFacts.length === seedCounts.memory_facts
  ), [`counts ${JSON.stringify(seedCounts)}`, `facts ${seedFacts.length}`]);

  // 1. Create a backup from the packaged EXE while it serves the working data.
  await launchExe(workDir, 'working-1');
  const status = await api('/api/backup/status');
  record('EXE serves the authenticated backup status endpoint', (
    status.status === 200
    && status.payload?.extension === '.livememory'
    && status.payload?.counts?.sessions === seedCounts.sessions
  ), [`status ${status.status}`, `counts ${JSON.stringify(status.payload?.counts)}`]);

  const created = await api('/api/backup/create', {method: 'POST', body: {path: firstBackup}});
  const createJob = created.status === 202 ? await waitJob(created.payload.job.id) : null;
  record('EXE creates a complete backup', (
    created.status === 202
    && createJob?.status === 'completed'
    && existsSync(firstBackup)
    && createJob.result?.counts?.sessions === seedCounts.sessions
  ), [
    `create ${created.status}`,
    `job ${createJob?.status} ${JSON.stringify(createJob?.error ?? null)}`,
    `file ${firstBackup}`,
    `bytes ${existsSync(firstBackup) ? statSync(firstBackup).size : 0}`
  ]);

  const inspected = await api('/api/backup/inspect', {method: 'POST', body: {path: firstBackup}});
  record('EXE verifies the backup and reports its contents', (
    inspected.status === 200
    && inspected.payload?.backup?.verified === true
    && inspected.payload?.backup?.counts?.sessions === seedCounts.sessions
    && inspected.payload?.backup?.containsCredentials === false
    && inspected.payload?.backup?.hasLongTermMemory === true
    && inspected.payload?.backup?.hasAiReports === true
  ), [
    `inspect ${inspected.status}`,
    `counts ${JSON.stringify(inspected.payload?.backup?.counts)}`,
    `credentials ${inspected.payload?.backup?.containsCredentials}`
  ]);

  const closed = await stopExe();
  record('EXE stops cleanly after creating the backup', closed.code === 0 || closed.signal === 'SIGTERM', [
    `exit ${JSON.stringify(closed)}`
  ]);

  // 2. Restore into a brand-new absolute directory.
  await launchExe(restoredDir, 'restored-1');
  const restoreStart = await api('/api/backup/restore', {
    method: 'POST',
    body: {path: firstBackup, confirmText: 'RESTORE'}
  });
  const restoreJob = restoreStart.status === 202 ? await waitJob(restoreStart.payload.job.id) : null;
  const restoredDb = join(restoredDir, 'database', 'livememory.db');
  const restoredCounts = existsSync(restoredDb) ? dbCounts(restoredDb) : null;
  record('EXE restores into a fresh absolute data directory', (
    restoreStart.status === 202
    && restoreJob?.status === 'completed'
    && JSON.stringify(restoredCounts) === JSON.stringify(seedCounts)
    && existsSync(restoreJob?.result?.safetySnapshot?.file ?? '')
  ), [
    `restore ${restoreStart.status}`,
    `job ${restoreJob?.status} ${JSON.stringify(restoreJob?.error ?? null)}`,
    `counts ${JSON.stringify(restoredCounts)}`,
    `safety snapshot ${restoreJob?.result?.safetySnapshot?.file ?? 'none'}`
  ]);

  const secretFiles = existsSync(join(restoredDir, 'secrets')) ? readdirSync(join(restoredDir, 'secrets')) : [];
  record('restored installation contains no credentials', secretFiles.length === 0, [
    `secrets entries ${secretFiles.length}`
  ]);

  const sessions = await api('/api/sessions');
  const settings = await api('/api/settings');
  record('restored data is served after the in-place runtime switch', (
    sessions.status === 200
    && settings.status === 200
    && settings.payload?.settings?.locale === 'ja'
    && settings.payload?.settings?.theme === 'dark'
    && sessions.payload?.sessions?.length === seedCounts.sessions
  ), [
    `sessions ${sessions.status}: ${sessions.payload?.sessions?.length ?? 0}`,
    `settings ${settings.status}: ${settings.payload?.settings?.locale}/${settings.payload?.settings?.theme}`
  ]);

  await stopExe();

  // 3. Restart the restored installation and confirm persistence.
  await launchExe(restoredDir, 'restored-2');
  const afterRestartCounts = dbCounts(restoredDb);
  const afterRestartFacts = dbFacts(restoredDb);
  record('the restored installation restarts with identical data', (
    JSON.stringify(afterRestartCounts) === JSON.stringify(seedCounts)
    && JSON.stringify(afterRestartFacts) === JSON.stringify(seedFacts)
    && integrityOk(restoredDb)
  ), [`counts ${JSON.stringify(afterRestartCounts)}`, `facts ${afterRestartFacts.length}`]);

  // 4. Backup again from the restored installation and verify the round trip.
  const second = await api('/api/backup/create', {method: 'POST', body: {path: secondBackup}});
  const secondJob = second.status === 202 ? await waitJob(second.payload.job.id) : null;
  const secondInspect = await api('/api/backup/inspect', {method: 'POST', body: {path: secondBackup}});
  record('backup -> restore -> backup round trip matches', (
    second.status === 202
    && secondJob?.status === 'completed'
    && secondInspect.status === 200
    && countsMatch(seedCounts, secondInspect.payload?.backup?.counts)
  ), [
    `second create ${second.status} / ${secondJob?.status}`,
    `second inspect ${secondInspect.status}`,
    `counts ${JSON.stringify(secondInspect.payload?.backup?.counts)}`
  ]);

  const archive = await inspectBackup({file: secondBackup});
  record('the second archive passes an independent full verification', (
    archive.verified === true
    && archive.counts.sessions === seedCounts.sessions
    && archive.counts.events === seedCounts.events
    && archive.counts.memory_facts === seedCounts.memory_facts
    && archive.containsCredentials === false
  ), [`counts ${JSON.stringify(archive.counts)}`]);

  const finalClosed = await stopExe();
  record('EXE stops cleanly after the round trip', finalClosed.code === 0 || finalClosed.signal === 'SIGTERM', [
    `exit ${JSON.stringify(finalClosed)}`
  ]);

  log('');
  log(`summary: ${results.filter((item) => item.passed).length}/${results.length} passed`);
  log(`buildId: ${buildInfo.buildId}`);
  log(`commit: ${buildInfo.commit}`);
  log(`sha256: ${sha256}`);
  log(`size: ${statSync(distExe).size} bytes`);
  log(`manifest: ${manifest}`);
  console.log(JSON.stringify({
    distExe,
    buildInfo,
    sha256,
    size: statSync(distExe).size,
    manifest,
    results
  }, null, 2));
  process.exitCode = results.some((item) => !item.passed) ? 1 : 0;
} catch (error) {
  record('verification aborted', false, [`${error?.stack ?? error}`]);
  await stopExe();
  process.exitCode = 1;
}
