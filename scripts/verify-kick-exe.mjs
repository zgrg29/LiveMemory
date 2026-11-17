#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';
import {KickHttp} from '../src/platforms/kick/http.mjs';

/**
 * Real Windows EXE acceptance for the Kick candidate.
 *
 * The shipped EXE requests administrator rights, so automation launches a
 * test-only asInvoker copy of the same build (never the shipped file). The copy
 * starts the real packaged server, then this script drives the real public API:
 * register/parse/connect/record/history/multi-room/stop, plus ten-language
 * resource and packaging checks. A real Kick room is used, so the run needs
 * network access and at least one live Kick channel.
 *
 * Usage:
 *   node scripts/verify-kick-exe.mjs [--exe dist/LiveMemory.exe] [--asinvoker PATH]
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const distExe = resolve(argValue('--exe', 'dist/LiveMemory.exe'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-kick-${stamp}`);
mkdirSync(root, {recursive: true});
const override = argValue('--asinvoker', process.env.LIVE_MEMORY_TEST_ASINVOKER_EXE ?? null);
const testExe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});

const results = [];
const record = (name, passed, details = []) => {
  results.push({name, passed, details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) console.log(`      ${line}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const shippedManifest = manifestLevel(readFileSync(distExe));
const testManifest = manifestLevel(readFileSync(testExe));
record('shipped EXE remains requireAdministrator; the test copy is asInvoker', shippedManifest === 'requireAdministrator' && testManifest === 'asInvoker', [
  `shipped: ${shippedManifest}`,
  `test copy: ${testManifest}`,
  `asInvoker source: ${override ?? 'patched copy of the shipped binary'}`
]);

const exeSha = createHash('sha256').update(readFileSync(distExe)).digest('hex');
const exeBuild = (() => {
  try {
    return JSON.parse(readFileSync('build/build-info.json', 'utf8'));
  } catch {
    return null;
  }
})();

async function discoverRooms() {
  const http = new KickHttp({timeoutMs: 20000});
  try {
    const response = await http.requestJson('https://web.kick.com/api/v1/livestreams/featured?language=en');
    const streams = response.data?.data?.livestreams ?? [];
    return streams
      .filter((entry) => entry?.channel?.slug)
      .sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0))
      .map((entry) => entry.channel.slug);
  } finally {
    await http.close().catch(() => {});
  }
}

let cookie = '';
async function api(path, {method = 'GET', body = null, timeout = 8000} = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== null) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {status: response.status, json, text, headers: response.headers};
}

async function waitFor(check, {timeoutMs = 60000, intervalMs = 500, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

const env = {
  ...process.env,
  LOCALAPPDATA: join(root, 'localappdata'),
  TEMP: join(root, 'temp'),
  TMP: join(root, 'temp'),
  LIVE_MEMORY_TEST_BOOTSTRAP_FILE: join(root, 'bootstrap.txt')
};
mkdirSync(env.LOCALAPPDATA, {recursive: true});
mkdirSync(env.TEMP, {recursive: true});

const child = spawn(testExe, ['--no-open', '--port', '48400', '--data-dir', join(root, 'data')], {
  env,
  cwd: root,
  stdio: 'ignore',
  windowsHide: true
});

let base = null;
try {
  const bootstrapFile = env.LIVE_MEMORY_TEST_BOOTSTRAP_FILE;
  await waitFor(() => existsSync(bootstrapFile) && readFileSync(bootstrapFile, 'utf8').trim().length > 0, {
    timeoutMs: 60000,
    label: 'packaged server bootstrap file'
  });
  const browserUrl = readFileSync(bootstrapFile, 'utf8').trim().split(/\r?\n/)[0];
  const parsed = new URL(browserUrl);
  base = `${parsed.protocol}//${parsed.host}`;
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const token = hashParams.get('lm_bootstrap') ?? hashParams.get('token');
  const exchange = await api('/api/auth/session', {method: 'POST', body: {token}});
  const setCookie = exchange.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  record('the packaged EXE starts, serves the console and authenticates a session', exchange.status === 200 && Boolean(cookie), [
    `server: ${base}`,
    `session cookie: ${cookie ? 'present' : 'missing'}`
  ]);

  const bootstrap = (await api('/api/bootstrap')).json;
  const platforms = bootstrap.capabilities?.platforms ?? [];
  const ids = platforms.map((entry) => entry.id);
  const kick = platforms.find((entry) => entry.id === 'kick');
  record('Kick is registered next to the five existing platforms', Boolean(kick) && ['bilibili', 'youtube', 'twitch', 'douyin', 'tiktok'].every((id) => ids.includes(id)), [
    `platforms: ${ids.join(', ')}`,
    `kick: mode=${kick?.mode} unofficial=${kick?.unofficial} requiresLogin=${kick?.requiresLogin}`
  ]);
  record('the EXE build is the Kick candidate build', bootstrap.app?.build?.buildId === exeBuild?.buildId && bootstrap.app?.version === '0.15.0', [
    `version: ${bootstrap.app?.version}`,
    `buildId: ${bootstrap.app?.build?.buildId}`,
    `sha256: ${exeSha}`
  ]);

  const locales = (bootstrap.locales?.available ?? bootstrap.locales ?? []).map?.((entry) => entry.code ?? entry) ?? [];
  const i18n = [];
  for (const locale of ['zh-CN', 'en', 'ja', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id']) {
    const response = await fetch(`${base}/i18n/${locale}.json`);
    const dict = await response.json();
    i18n.push({locale, ok: response.status === 200 && Boolean(dict.live?.source?.kickIntro) && Boolean(dict.errors?.kickLinkInvalid)});
  }
  record('all ten language resources in the EXE contain the Kick keys', i18n.every((entry) => entry.ok), i18n.map((entry) => `${entry.locale}:${entry.ok ? 'ok' : 'missing'}`));

  const candidates = await discoverRooms();
  const liveSlugs = [];
  for (const slug of candidates.slice(0, 8)) {
    const response = await api('/api/kick/room', {method: 'POST', body: {url: `https://kick.com/${slug}`}});
    if (response.status === 200 && response.json?.room?.isLive) liveSlugs.push(slug);
    if (liveSlugs.length >= 2) break;
  }
  if (liveSlugs.length === 0) throw new Error('no live Kick room available for the EXE acceptance');
  record('a real Kick URL resolves inside the EXE without login', liveSlugs.length >= 1, [`live rooms: ${liveSlugs.join(', ')}`]);

  const invalid = await api('/api/kick/room', {method: 'POST', body: {url: 'https://kick.com/video/not-live'}});
  record('the EXE rejects a Kick VOD URL as a non-live page', invalid.status === 400 && invalid.json?.error?.messageKey === 'errors.kickLinkInvalid', [
    `status: ${invalid.status}`,
    `messageKey: ${invalid.json?.error?.messageKey}`
  ]);

  const sessions = [];
  for (const slug of liveSlugs.slice(0, 2)) {
    const connected = await api('/api/kick/connect', {method: 'POST', body: {url: `https://kick.com/${slug}`}});
    if (connected.status === 201) sessions.push({slug, id: connected.json.session.id});
    record(`the EXE starts a real Kick capture (${slug})`, connected.status === 201, [
      `status: ${connected.status}`,
      `session: ${connected.json?.session?.id ?? connected.text.slice(0, 120)}`
    ]);
  }
  if (sessions.length === 0) throw new Error('no Kick capture could be started');

  const startedAt = Date.now();
  const progress = await waitFor(async () => {
    const rows = [];
    for (const session of sessions) {
      const summary = await api(`/api/sessions/${encodeURIComponent(session.id)}`);
      rows.push({...session, stats: summary.json?.stats ?? null});
    }
    const ready = rows.filter((row) => Number(row.stats?.messages ?? 0) > 0);
    return ready.length === sessions.length && sessions.length >= 2 ? {rows, elapsed: Date.now() - startedAt} : null;
  }, {timeoutMs: 120000, intervalMs: 2000, label: 'real Kick chat in two rooms'}).catch(() => null);

  const finalRows = [];
  for (const session of sessions) {
    const summary = (await api(`/api/sessions/${encodeURIComponent(session.id)}`)).json;
    const top = (await api(`/api/sessions/${encodeURIComponent(session.id)}/top-viewers`)).json;
    finalRows.push({...session, summary, top});
  }
  for (const row of finalRows) {
    record(`real chat is stored for ${row.slug}`, Number(row.summary?.stats?.messages ?? 0) > 0, [
      `messages: ${row.summary?.stats?.messages}`,
      `giftEvents: ${row.summary?.stats?.giftEvents}`,
      `identityCoverage: ${row.summary?.stats?.identityCoverage}`
    ]);
    const viewers = row.top?.viewers ?? [];
    const kickViewers = viewers.filter((viewer) => viewer.platform === 'kick' && viewer.platformUid
      && String(viewer.viewerId ?? '').startsWith('kick:'));
    record(`stable Kick viewer identity is stored for ${row.slug}`, kickViewers.length > 0, [
      `viewers: ${viewers.length}`,
      `sample: ${kickViewers[0]?.viewerId ?? 'none'}`
    ]);
  }
  record('two real Kick rooms record at the same time', sessions.length >= 2 && finalRows.every((row) => Number(row.summary?.stats?.messages ?? 0) > 0), [
    `rooms: ${finalRows.map((row) => `${row.slug}:${row.summary?.stats?.messages ?? 0}`).join(', ')}`,
    `waited: ${progress?.elapsed ?? 'timeout'} ms`
  ]);

  const recordings = (await api('/api/live/recordings')).json;
  const kickRecordings = (recordings.recordings ?? []).filter((row) => row.platform === 'kick');
  record('the live API lists both Kick recordings', kickRecordings.length === sessions.length, [
    `recordings: ${kickRecordings.length}`,
    `states: ${kickRecordings.map((row) => row.connection.state).join(', ')}`
  ]);

  const history = (await api('/api/sessions?limit=10')).json;
  const historyRows = history.sessions ?? history.rows ?? [];
  record('the Kick sessions appear in history', sessions.every((session) => historyRows.some((row) => row.id === session.id)), [
    `history rows: ${historyRows.length}`
  ]);

  const ai = bootstrap.capabilities?.ai ?? null;
  record('the AI analysis entry remains available for recorded Kick data', ai?.automated === true && bootstrap.capabilities?.memory?.enabled === true, [
    `ai.automated: ${ai?.automated}`,
    `memory.enabled: ${bootstrap.capabilities?.memory?.enabled}`
  ]);

  const stopped = [];
  for (const session of sessions) {
    const response = await api('/api/kick/disconnect', {method: 'POST', body: {sessionId: session.id}});
    stopped.push({session, status: response.status, stopped: response.json?.stopped});
  }
  const afterStop = (await api('/api/live/recordings')).json;
  const kickAfter = (afterStop.recordings ?? []).filter((row) => row.platform === 'kick');
  record('stopping the captures releases the Kick recordings', stopped.every((row) => row.stopped) && kickAfter.length === 0, [
    `stopped: ${stopped.map((row) => `${row.session.slug}:${row.stopped}`).join(', ')}`,
    `remaining Kick recordings: ${kickAfter.length}`
  ]);

  const finalStatus = (await api('/api/kick/status')).json;
  record('the Kick status card reports a clean stopped state', finalStatus.capture?.category === 'stopped' || finalStatus.recordings?.length === 0, [
    `category: ${finalStatus.capture?.category}`,
    `recordings: ${finalStatus.recordings?.length ?? 0}`
  ]);

  const gifts = finalRows.reduce((sum, row) => sum + Number(row.summary?.stats?.giftEvents ?? 0), 0);
  const memberships = finalRows.reduce((sum, row) => sum + Number(row.summary?.stats?.membershipEvents ?? 0), 0);
  console.log(`\n[observed] gifts=${gifts} (memberships are included in the Kick counters; the summary reports giftEvents only)`);
} catch (error) {
  record('the EXE acceptance run completed without an exception', false, [String(error?.message ?? error)]);
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  const report = {
    generatedAt: new Date().toISOString(),
    exe: distExe,
    testExe,
    sha256: exeSha,
    size: statSync(distExe).size,
    build: exeBuild,
    manifest: {shipped: shippedManifest, test: testManifest},
    base,
    results,
    passed: results.filter((row) => row.passed).length,
    total: results.length
  };
  writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const failed = results.filter((row) => !row.passed);
  console.log(`\n${results.length - failed.length}/${results.length} EXE checks passed; report: ${join(root, 'report.json')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
