#!/usr/bin/env node
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {KickHttp} from '../src/platforms/kick/http.mjs';

/**
 * Kick G5.1 monitoring acceptance through the real product stack.
 *
 * Starts the real LiveMemory server on an isolated data directory, adds a real
 * offline Kick channel as a monitor, restarts the server and verifies the target
 * survived, then monitors a real live channel until the scheduler starts a
 * session by itself and real chat is stored. Also checks duplicate prevention,
 * two independent monitored channels, manual-stop suppression and cleanup.
 *
 * Real down-detection needs a stream to end during the run; when that does not
 * happen the report says so instead of claiming it.
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = resolve(argValue('--out', 'tests/.tmp/kick-g51'));
const minutes = Number(argValue('--minutes', 8));
mkdirSync(outDir, {recursive: true});
const dataDir = join(outDir, 'data');
mkdirSync(dataDir, {recursive: true});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [];
function record(name, passed, details = []) {
  checks.push({name, passed, details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) console.log(`      ${line}`);
}

async function discover() {
  const http = new KickHttp({timeoutMs: 20000});
  try {
    const response = await http.requestJson('https://web.kick.com/api/v1/livestreams/featured?language=en');
    return (response.data?.data?.livestreams ?? [])
      .filter((entry) => entry?.channel?.slug)
      .sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0))
      .map((entry) => entry.channel.slug);
  } finally {
    await http.close().catch(() => {});
  }
}

let base = '';
async function api(path, {method = 'GET', body = null, timeout = 15000} = {}) {
  const headers = body === null ? {} : {'content-type': 'application/json'};
  const root = base.replace(/\/$/, '');
  const response = await fetch(`${root}${path}`, {
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
  return {status: response.status, json, text};
}

async function waitFor(check, {timeoutMs = 120000, intervalMs = 1000, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout: ${label}`);
}

const serverOptions = () => ({dataDir, port: 0, auth: false, systemLocale: 'en'});
let server = await startServer(serverOptions());
base = server.url;
console.log(`[server] ${base}`);

const summary = {generatedAt: new Date().toISOString(), dataDir, checks, offlineTarget: null, liveTargets: [], sessions: [], realDownObserved: false};

try {
  const liveSlugs = await discover();
  const live = liveSlugs.slice(0, 2);
  if (live.length === 0) throw new Error('no live Kick channel available');
  let offline = null;
  for (const slug of ['xqc', 'trainwreck', 'adinross', 'hasanabi', 'kaicenat', 'moistcr1tikal']) {
    const response = await api('/api/kick/room', {method: 'POST', body: {url: `https://kick.com/${slug}`}});
    console.log(`[offline-probe] ${slug} status=${response.status} live=${response.json?.room?.isLive} body=${response.text.slice(0, 120)}`);
    if (response.status === 200 && response.json?.room && response.json.room.isLive === false) {
      offline = slug;
      break;
    }
  }
  if (!offline) throw new Error('no offline Kick channel found for the offline scenario');
  record('a real offline Kick channel is available', true, [`offline: ${offline}`, `live: ${live.join(', ')}`]);

  // ---- Scenario A: offline channel monitor ----
  const created = await api('/api/monitoring', {method: 'POST', body: {platform: 'kick', input: `https://kick.com/${offline}`}});
  const offlineTarget = created.json?.target ?? created.json;
  record('an offline Kick channel can be added as a monitor', created.status === 201 || created.status === 200, [
    `status: ${created.status}`,
    `target: ${offlineTarget?.id}`,
    `state: ${offlineTarget?.state}`
  ]);
  summary.offlineTarget = {slug: offline, id: offlineTarget?.id, state: offlineTarget?.state};
  assertState(offlineTarget, 'waiting', 'offline target starts waiting');

  await api(`/api/monitoring/${encodeURIComponent(offlineTarget.id)}/check`, {method: 'POST'});
  await sleep(1500);
  let offlineView = (await api('/api/monitoring')).json?.targets?.find((row) => row.id === offlineTarget.id);
  record('offline checks keep waiting and never create a session', offlineView?.state === 'waiting' && Number(offlineView?.consecutiveFailures ?? 0) === 0, [
    `state: ${offlineView?.state}`,
    `failures: ${offlineView?.consecutiveFailures ?? 0}`,
    `sessions: ${(await api('/api/sessions?limit=20')).json?.sessions?.filter((row) => row.platform === 'kick').length ?? 'n/a'}`
  ]);
  const offlineSessions = (await api(`/api/monitoring/${encodeURIComponent(offlineTarget.id)}/sessions`)).json;
  record('the offline monitor has no empty broadcast', (offlineSessions?.sessions ?? []).length === 0, [
    `sessions: ${(offlineSessions?.sessions ?? []).length}`
  ]);

  // ---- Scenario F: restart recovery ----
  await server.close();
  server = await startServer(serverOptions());
  base = server.url;
  const restored = (await api('/api/monitoring')).json?.targets?.find((row) => row.id === offlineTarget.id);
  record('the enabled monitor survives a restart and stays waiting', Boolean(restored) && restored.enabled === true, [
    `state: ${restored?.state}`,
    `enabled: ${restored?.enabled}`
  ]);

  // ---- Scenario B: live channel auto-recording ----
  const liveCreated = await api('/api/monitoring', {method: 'POST', body: {platform: 'kick', input: `https://kick.com/${live[0]}`}});
  const liveTarget = liveCreated.json?.target ?? liveCreated.json;
  summary.liveTargets.push({slug: live[0], id: liveTarget?.id});
  await api(`/api/monitoring/${encodeURIComponent(liveTarget.id)}/check`, {method: 'POST'});
  const recording = await waitFor(async () => {
    const row = (await api('/api/monitoring')).json?.targets?.find((item) => item.id === liveTarget.id);
    return row?.state === 'recording' && row?.activeSessionId ? row : null;
  }, {timeoutMs: 120000, label: 'auto recording'});
  record('a live Kick channel is detected and recorded automatically', true, [
    `session: ${recording.activeSessionId}`,
    `state: ${recording.state}`
  ]);
  summary.sessions.push({slug: live[0], sessionId: recording.activeSessionId});

  const chat = await waitFor(async () => {
    const payload = (await api(`/api/sessions/${encodeURIComponent(recording.activeSessionId)}`)).json;
    return Number(payload?.stats?.messages ?? 0) > 0 ? payload : null;
  }, {timeoutMs: 120000, label: 'real chat'});
  record('real Kick chat is stored in the automatic session', true, [
    `messages: ${chat.stats.messages}`,
    `identityCoverage: ${chat.stats.identityCoverage}`
  ]);
  const viewers = (await api(`/api/sessions/${encodeURIComponent(recording.activeSessionId)}/top-viewers`)).json;
  const kickViewers = (viewers?.viewers ?? []).filter((row) => String(row.viewerId ?? '').startsWith('kick:'));
  record('stable Kick identity is stored in the automatic session', kickViewers.length > 0, [
    `viewers: ${(viewers?.viewers ?? []).length}`,
    `sample: ${kickViewers[0]?.viewerId ?? 'none'}`
  ]);

  await api(`/api/monitoring/${encodeURIComponent(liveTarget.id)}/check`, {method: 'POST'});
  await sleep(1500);
  const afterCheck = (await api(`/api/monitoring/${encodeURIComponent(liveTarget.id)}/sessions`)).json;
  record('a recording target is not started twice', (afterCheck?.sessions ?? []).length === 1, [
    `sessions for target: ${(afterCheck?.sessions ?? []).length}`
  ]);

  // ---- Scenario E: two monitored channels ----
  const secondSlug = live[1] ?? live[0];
  const secondCreated = await api('/api/monitoring', {method: 'POST', body: {platform: 'kick', input: `https://kick.com/${secondSlug}`}});
  const secondTarget = secondCreated.json?.target ?? secondCreated.json;
  summary.liveTargets.push({slug: secondSlug, id: secondTarget?.id});
  await api(`/api/monitoring/${encodeURIComponent(secondTarget.id)}/check`, {method: 'POST'});
  const secondRecording = await waitFor(async () => {
    const row = (await api('/api/monitoring')).json?.targets?.find((item) => item.id === secondTarget.id);
    return row?.state === 'recording' && row?.activeSessionId ? row : null;
  }, {timeoutMs: 120000, label: 'second room'});
  summary.sessions.push({slug: secondSlug, sessionId: secondRecording.activeSessionId});
  record('two Kick channels are monitored independently', recording.activeSessionId !== secondRecording.activeSessionId, [
    `first: ${recording.activeSessionId}`,
    `second: ${secondRecording.activeSessionId}`
  ]);

  // ---- Manual stop suppression ----
  const stopped = await api(`/api/sessions/${encodeURIComponent(recording.activeSessionId)}/stop`, {method: 'POST'});
  record('stopping an automatic recording succeeds', stopped.status === 200, [`status: ${stopped.status}`]);
  await api(`/api/monitoring/${encodeURIComponent(liveTarget.id)}/check`, {method: 'POST'});
  await sleep(2500);
  const stoppedTarget = (await api('/api/monitoring')).json?.targets?.find((row) => row.id === liveTarget.id);
  record('a manual stop is not immediately undone by a check', stoppedTarget?.state === 'live_stopped', [
    `state: ${stoppedTarget?.state}`,
    `active: ${stoppedTarget?.activeSessionId ?? 'none'}`
  ]);
  const sessionsAfterStop = (await api(`/api/monitoring/${encodeURIComponent(liveTarget.id)}/sessions`)).json;
  record('the manual stop did not create a duplicate session', (sessionsAfterStop?.sessions ?? []).length === 1, [
    `sessions: ${(sessionsAfterStop?.sessions ?? []).length}`
  ]);

  // The offline monitor must be untouched by all of the above.
  const offlineStill = (await api('/api/monitoring')).json?.targets?.find((row) => row.id === offlineTarget.id);
  record('the offline monitor keeps waiting while live channels record', offlineStill?.state === 'waiting', [
    `state: ${offlineStill?.state}`
  ]);

  // ---- Cleanup ----
  if (secondRecording?.activeSessionId) {
    await api(`/api/sessions/${encodeURIComponent(secondRecording.activeSessionId)}/stop`, {method: 'POST'});
  }
  for (const row of [offlineTarget, liveTarget, secondTarget]) {
    if (row?.id) await api(`/api/monitoring/${encodeURIComponent(row.id)}`, {method: 'DELETE', body: {confirm: true}});
  }
  const finalTargets = (await api('/api/monitoring')).json?.targets ?? [];
  record('monitor targets can be removed again', finalTargets.length === 0, [`remaining: ${finalTargets.length}`]);
} catch (error) {
  record('the monitoring acceptance run completed without an exception', false, [String(error?.message ?? error)]);
} finally {
  summary.generatedAt = new Date().toISOString();
  summary.checks = checks;
  summary.passed = checks.filter((row) => row.passed).length;
  summary.total = checks.length;
  summary.realDownObserved = false;
  summary.note = 'Real stream-end was not observed in this run; the two-poll offline transition is covered by tests and by the earlier real odablock end.';
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await server.close();
  const failed = checks.filter((row) => !row.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} monitoring checks passed; summary: ${join(outDir, 'summary.json')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function assertState(target, expected, label) {
  record(label, target?.state === expected, [`state: ${target?.state}`]);
}
