import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';

/**
 * Real-network concurrent recording check.
 *
 *   node scripts/verify-live-multi.mjs --youtube <live-url-or-id> --youtube <id> --seconds 40
 *   node scripts/verify-live-multi.mjs --youtube <id> --bilibili <roomId> --seconds 40
 *
 * It starts the real local server, connects every input as an independent
 * recording, verifies that events stay in their own session, tries a duplicate
 * start, stops the first recording and confirms the others keep running. Only
 * aggregates are printed (no chat text, nicknames, titles or channel ids).
 *
 * This script contacts the platforms. A failure is reported as a real result,
 * never replaced by synthetic data. Data uses a private tests/.tmp folder and is
 * removed unless KEEP_LIVE_TEST_DATA=1.
 */

const args = process.argv.slice(2);
const youtubeInputs = [];
const bilibiliInputs = [];
let seconds = 40;
let attachBase = null;
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--youtube') youtubeInputs.push(args[index + 1]);
  else if (value === '--bilibili') bilibiliInputs.push(args[index + 1]);
  else if (value === '--seconds') seconds = Math.max(10, Number(args[index + 1]) || 40);
  else if (value === '--base') attachBase = `${String(args[index + 1] ?? '').replace(/\/+$/, '')}/`;
}
if (youtubeInputs.length + bilibiliInputs.length < 2) {
  throw new Error('usage: node scripts/verify-live-multi.mjs --youtube <url> --youtube <url> | --bilibili <roomId> [--seconds 40] [--base http://127.0.0.1:PORT]');
}
if (attachBase && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(attachBase)) {
  throw new Error('--base must be a local http://127.0.0.1:<port> URL');
}

const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
let dataDir = null;
let server = null;
if (!attachBase) {
  dataDir = join(root, `multi-live-verify-${Date.now()}`);
  mkdirSync(dataDir, {recursive: true});
}

function request(target, {method = 'GET', body} = {}) {
  return fetch(target, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 20000, interval = 300} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(interval);
  }
}

async function eventStats(base, sessionId) {
  const payload = await (await fetch(`${base}api/events?sessionId=${encodeURIComponent(sessionId)}&limit=1000`)).json();
  const events = payload.events ?? [];
  const byType = {};
  for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;
  const messages = events.filter((event) => event.type === 'chat' || event.type === 'super_chat');
  return {
    events: events.length,
    byType,
    messages: messages.length,
    withStableIdentity: messages.filter((event) => Boolean(event.viewerId)).length,
    wrongSession: events.filter((event) => event.sessionId !== sessionId).length
  };
}

if (!attachBase) server = await startServer({auth: false, dataDir, port: 0, systemLocale: 'en'});
const base = attachBase ?? server.url;
const report = {
  startedAt: new Date().toISOString(),
  requestedSeconds: seconds,
  mode: attachBase ? 'attached' : 'embedded',
  dataDir,
  inputs: {youtube: youtubeInputs.length, bilibili: bilibiliInputs.length},
  recordings: [],
  errors: []
};

async function startOne(input) {
  if (input.kind === 'youtube') {
    const checked = await request(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url: input.value}
    });
    const checkPayload = await checked.json();
    if (checked.status !== 200) {
      return {ok: false, stage: 'check', status: checked.status, code: checkPayload?.error?.code ?? null};
    }
    if (!checkPayload.video.recordable) {
      return {ok: false, stage: 'not-recordable', reason: checkPayload.video.reason ?? null};
    }
    const connected = await request(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url: input.value}
    });
    const payload = await connected.json();
    if (connected.status !== 201) {
      return {ok: false, stage: 'connect', status: connected.status, code: payload?.error?.code ?? null};
    }
    return {ok: true, sessionId: payload.session.id, platform: 'youtube', input: 'youtube', duplicateProbe: input.value};
  }
  const connected = await request(`${base}api/bilibili/connect`, {
    method: 'POST',
    body: {roomId: input.value}
  });
  const payload = await connected.json();
  if (connected.status !== 201) {
    return {ok: false, stage: 'connect', status: connected.status, code: payload?.error?.code ?? null};
  }
  return {ok: true, sessionId: payload.session.id, platform: 'bilibili', input: 'bilibili', duplicateProbe: input.value};
}

try {
  const definitions = [
    ...youtubeInputs.map((value) => ({kind: 'youtube', value})),
    ...bilibiliInputs.map((value) => ({kind: 'bilibili', value}))
  ];
  const probes = new Map();
  for (const definition of definitions) {
    const result = await startOne(definition);
    if (!result.ok) {
      report.errors.push({input: definition.kind, ...result});
      continue;
    }
    probes.set(result.sessionId, result.duplicateProbe);
    report.recordings.push({
      sessionId: result.sessionId,
      platform: result.platform,
      input: result.input,
      index: report.recordings.length
    });
  }

  if (report.recordings.length < 2) {
    throw new Error(`only ${report.recordings.length} recording(s) started; concurrent verification requires at least two`);
  }

  const active = await waitFor(async () => {
    const payload = await (await fetch(`${base}api/live/recordings`)).json();
    const connected = payload.recordings.filter((recording) => recording.connection.state === 'connected');
    return connected.length >= 2 ? payload : null;
  }, {timeout: 30000});
  report.liveAfterStart = active
    ? {count: active.count, states: active.recordings.map((recording) => recording.connection.state)}
    : {count: null, states: []};

  const first = report.recordings[0];
  const duplicate = await request(
    first.platform === 'youtube' ? `${base}api/youtube/connect` : `${base}api/bilibili/connect`,
    {
      method: 'POST',
      body: first.platform === 'youtube' ? {url: probes.get(first.sessionId)} : {roomId: probes.get(first.sessionId)}
    }
  );
  const duplicatePayload = await duplicate.json();
  report.duplicate = {status: duplicate.status, code: duplicatePayload?.error?.code ?? null, expectedSessionId: first.sessionId};

  const before = new Map();
  for (const recording of report.recordings) {
    before.set(recording.sessionId, await eventStats(base, recording.sessionId));
  }

  const deadline = Date.now() + seconds * 1000;
  let lastStates = [];
  while (Date.now() < deadline) {
    await sleep(2500);
    const payload = await (await fetch(`${base}api/live/recordings`)).json();
    lastStates = payload.recordings.map((recording) => recording.connection.state);
    if (payload.recordings.length < report.recordings.length) break;
  }
  report.statesDuringCapture = lastStates;

  for (const recording of report.recordings) {
    const after = await eventStats(base, recording.sessionId);
    const summary = await (await fetch(`${base}api/sessions/${encodeURIComponent(recording.sessionId)}`)).json();
    report.recordings[recording.index] = {
      platform: recording.platform,
      sessionId: recording.sessionId,
      status: summary.session?.status ?? null,
      messages: summary.stats?.messages ?? null,
      activeViewers: summary.stats?.activeViewers ?? null,
      paymentEvents: summary.stats?.paymentEvents ?? null,
      eventStats: after,
      deltaEvents: after.events - (before.get(recording.sessionId)?.events ?? 0)
    };
  }

  const secondBefore = report.recordings[1]?.eventStats.events ?? 0;
  const stopResponse = await request(`${base}api/live/recordings/${encodeURIComponent(first.sessionId)}/stop`, {
    method: 'POST',
    body: {}
  });
  const stopPayload = await stopResponse.json();
  report.stopFirst = {
    status: stopResponse.status,
    sessionStatus: stopPayload?.session?.status ?? null,
    stopped: Boolean(stopPayload?.stopped)
  };
  const afterStop = await waitFor(async () => {
    const payload = await (await fetch(`${base}api/live/recordings`)).json();
    return payload.recordings.some((recording) => recording.sessionId === report.recordings[1]?.sessionId) ? payload : null;
  }, {timeout: 15000});
  report.afterStop = afterStop
    ? {count: afterStop.count, remaining: afterStop.recordings.map((recording) => ({platform: recording.platform, state: recording.connection.state}))}
    : {count: null, remaining: []};

  await sleep(4000);
  const waitStarted = Date.now();
  let secondAfter = await eventStats(base, report.recordings[1]?.sessionId ?? '');
  while (secondAfter.events <= secondBefore && Date.now() - waitStarted < 20000) {
    await sleep(2000);
    secondAfter = await eventStats(base, report.recordings[1]?.sessionId ?? '');
  }
  const afterStopDetail = await (await fetch(`${base}api/live/recordings`)).json();
  const secondStillListed = (afterStopDetail.recordings ?? []).some(
    (recording) => recording.sessionId === report.recordings[1]?.sessionId
  );
  report.secondAfterFirstStop = {
    eventsBefore: secondBefore,
    eventsAfter: secondAfter.events,
    newEventsAfterStop: secondAfter.events - secondBefore,
    waitedMs: Date.now() - waitStarted,
    stillListedAsLive: secondStillListed,
    wrongSession: secondAfter.wrongSession
  };

  report.summary = {
    started: report.recordings.length,
    uniqueSessions: new Set(report.recordings.map((recording) => recording.sessionId)).size,
    duplicateRefused: report.duplicate.status === 409,
    isolationIntact: report.recordings.every((recording) => recording.eventStats.wrongSession === 0),
    secondStayedLive: Boolean(afterStop),
    secondReceivedNewEventAfterStop: secondAfter.events > secondBefore,
    ok: report.recordings.length >= 2
      && new Set(report.recordings.map((recording) => recording.sessionId)).size === report.recordings.length
      && report.duplicate.status === 409
      && report.recordings.every((recording) => recording.eventStats.wrongSession === 0)
      && Boolean(afterStop)
  };
} catch (error) {
  report.errors.push({fatal: String(error?.stack ?? error)});
  report.summary = {ok: false};
} finally {
  try {
    const payload = await (await fetch(`${base}api/live/recordings`)).json();
    for (const recording of payload.recordings ?? []) {
      await request(`${base}api/live/recordings/${encodeURIComponent(recording.sessionId)}/stop`, {method: 'POST', body: {}})
        .catch(() => {});
    }
  } catch {
    /* server may already be gone */
  }
  if (server) await server.close();
  console.log(JSON.stringify(report, null, 2));
  if (dataDir && process.env.KEEP_LIVE_TEST_DATA !== '1') rmSync(dataDir, {recursive: true, force: true});
  process.exit(report.summary?.ok ? 0 : 1);
}
