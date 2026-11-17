#!/usr/bin/env node
// Kuaishou G1.6 research CLI — fresh-room login + WebSocket token probe.
//
// Motivation: the G1.5 login used a liveStreamId that was already several
// minutes old, and `home/list` is a rotating recommendation list, so matching a
// single eid on the next poll can produce a false `offline`. This probe takes a
// *fresh* snapshot immediately before login, then after login tries the token
// endpoint on several ids from a *new* snapshot. A `result:2` on all fresh ids
// is evidence about the endpoint; a `result:2` on a stale id is not.
//
// It does not sign requests, does not fingerprint the device, does not solve
// captchas, and never sends chat/like/gift/follow. Credentials stay in memory.

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseRoomInput} from './lib/link.mjs';
import {QrLoginSession} from './lib/login.mjs';
import {parseHomeList, liveHeaders} from './lib/status.mjs';
import {requestJson, sleep} from './lib/http.mjs';
import {createNormalizer, NAMESPACE} from './lib/normalize.mjs';
import {AuthenticatedWebSocketTransport} from './lib/ws-transport.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.state');
const QR_PATH = join(STATE, 'qr.png');
const STATUS_PATH = join(STATE, 'live-probe-status.json');

function args(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function log(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function writeStatus(patch) {
  await mkdir(STATE, {recursive: true});
  let prev = {};
  try {
    prev = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  } catch {
    prev = {};
  }
  await writeFile(STATUS_PATH, JSON.stringify({...prev, ...patch, updatedAt: new Date().toISOString()}, null, 2), 'utf8');
}

async function snapshotRooms() {
  const res = await requestJson('https://live.kuaishou.com/live_api/home/list', {headers: liveHeaders()});
  return parseHomeList(res.json);
}

function ranked(rooms) {
  return [...rooms].sort((a, b) => (Number(b.watchingCount) || 0) - (Number(a.watchingCount) || 0));
}

async function waitForScan(session, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  const first = await session.startQr();
  await writeStatus({stage: 'waiting_for_scan', qrExpiresAt: first.expireTime});
  log({command: 'login', stage: 'waiting_for_scan', qrPath: QR_PATH, qrExpiresAt: first.expireTime});
  while (Date.now() < deadline) {
    let result;
    try {
      result = await session.scan();
    } catch (err) {
      log({command: 'login', stage: 'scan_error', code: err?.code ?? 'NETWORK'});
      await sleep(1500);
      continue;
    }
    if (result === 1) return true;
    if (result === 707) {
      await session.startQr();
      await writeStatus({stage: 'waiting_for_scan', qrRefreshedAt: new Date().toISOString()});
      log({command: 'login', stage: 'qr_refreshed'});
      continue;
    }
    if (result === 711 || result === 712) {
      log({command: 'login', stage: 'cancelled_on_phone', result});
      return false;
    }
    await sleep(1500);
  }
  return false;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const waitSeconds = Math.max(30, Number(opts.wait ?? 600));
  const listenSeconds = Math.max(0, Number(opts.listen ?? 120));
  const candidateLimit = Math.max(1, Math.min(12, Number(opts.candidates ?? 7)));

  await rm(STATUS_PATH, {force: true});
  const initialRooms = await snapshotRooms();
  if (!initialRooms.length) {
    log({command: 'login', stage: 'no_live_rooms'});
    process.exitCode = 3;
    return;
  }
  const requested = opts.room ? parseRoomInput(String(opts.room)).eid : '';
  const initial = (requested && initialRooms.find((r) => r.eid === requested))
    || ranked(initialRooms)[0];
  await writeStatus({stage: 'selected', eid: initial.eid, liveStreamId: initial.liveStreamId, watching: initial.watchingCount});
  log({
    command: 'login',
    stage: 'selected',
    eid: initial.eid,
    liveStreamId: initial.liveStreamId,
    watching: initial.watchingCount,
    roomsSeen: initialRooms.length
  });

  const session = new QrLoginSession({qrPath: QR_PATH});
  await writeStatus({stage: 'starting_qr', eid: initial.eid});
  if (!(await waitForScan(session, waitSeconds))) {
    await writeStatus({stage: 'blocked_on_human_scan'});
    log({command: 'login', stage: 'blocked_on_human_scan'});
    process.exitCode = 4;
    return;
  }
  log({command: 'login', stage: 'scanned'});
  await writeStatus({stage: 'scanned'});

  let accepted;
  try {
    accepted = await session.accept();
  } catch (err) {
    log({command: 'login', stage: 'accept_failed', code: err?.code ?? 'UPSTREAM'});
    await writeStatus({stage: 'accept_failed', code: err?.code ?? 'UPSTREAM'});
    process.exitCode = 5;
    return;
  }
  const cb = await session.callback(accepted.qrToken);
  log({command: 'login', stage: cb.hasPassToken ? 'logged_in' : 'callback_without_pass_token'});
  if (!cb.hasPassToken) {
    process.exitCode = 5;
    return;
  }
  const ticket = await session.exchangeLiveTicket(cb.passToken);
  log({command: 'login', stage: 'live_ticket', ok: ticket.ok, result: ticket.result, hasAuthToken: ticket.hasAuthToken});
  if (!ticket.hasAuthToken) {
    process.exitCode = 5;
    return;
  }
  const userLogin = await session.liveUserLogin(ticket.authToken);
  log({command: 'login', stage: 'live_user_login', ok: userLogin.ok, result: userLogin.result});
  if (!userLogin.ok) {
    process.exitCode = 5;
    return;
  }

  // A *new* snapshot after login. Prefer the initially selected room if it is
  // still there, then the highest-watching current rooms. The token endpoint is
  // called immediately after the snapshot so every id is as fresh as possible.
  const after = await snapshotRooms();
  const byEid = new Map(after.map((r) => [r.eid, r]));
  const candidates = [];
  const seen = new Set();
  const push = (room) => {
    if (!room?.liveStreamId || seen.has(room.liveStreamId)) return;
    seen.add(room.liveStreamId);
    candidates.push(room);
  };
  push(byEid.get(initial.eid) ?? initial);
  for (const room of ranked(after)) push(room);
  const selected = candidates.slice(0, candidateLimit);
  await writeStatus({stage: 'probing_websocketinfo', candidates: selected.map((r) => ({eid: r.eid, liveStreamId: r.liveStreamId}))});

  const probes = [];
  let winner = null;
  for (const room of selected) {
    let info;
    try {
      info = await session.websocketInfo({liveStreamId: room.liveStreamId, eid: room.eid});
    } catch (err) {
      info = {httpStatus: 0, result: null, hasToken: false, urlCount: 0, error: err?.code ?? 'NETWORK'};
    }
    const view = {
      eid: room.eid,
      liveStreamId: room.liveStreamId,
      watching: room.watchingCount,
      httpStatus: info.httpStatus,
      result: info.result,
      hasToken: info.hasToken,
      urlCount: info.urlCount,
      errorMessage: info.errorMessage ?? info.error ?? null
    };
    probes.push(view);
    log({command: 'probe', name: 'websocketinfo', ...view});
    if (info.hasToken && info.urlCount > 0) {
      winner = {room, info};
      break;
    }
    await sleep(700);
  }
  await writeStatus({stage: 'websocketinfo_done', probes, foundToken: Boolean(winner)});
  if (!winner) {
    const failed = {
      command: 'websocketinfo-probe',
      at: new Date().toISOString(),
      eid: initial.eid,
      initialLiveStreamId: initial.liveStreamId,
      roomsSeen: after.length,
      probes
    };
    await mkdir(STATE, {recursive: true});
    await writeFile(join(STATE, 'ws-token-probe.json'), JSON.stringify(failed, null, 2), 'utf8');
    log({command: 'login', stage: 'ws_token_unavailable', evidencePath: join(STATE, 'ws-token-probe.json'), probes});
    process.exitCode = 6;
    return;
  }

  log({command: 'login', stage: 'ws_token_acquired', eid: winner.room.eid, liveStreamId: winner.room.liveStreamId});
  if (!listenSeconds) return;

  const normalizer = createNormalizer({
    namespace: NAMESPACE.WS,
    sessionId: `g16-ws-${Date.now()}`,
    roomId: winner.room.eid,
    liveStreamId: winner.room.liveStreamId
  });
  const transport = new AuthenticatedWebSocketTransport({
    normalizer,
    urls: winner.info.urls,
    token: winner.info.token,
    liveStreamId: winner.room.liveStreamId
  });
  const events = [];
  const timer = setTimeout(() => transport.stop(), listenSeconds * 1000);
  try {
    await transport.start({onEvents: (batch) => events.push(...batch), onStatus: (s) => log({command: 'listen', status: s})});
  } catch (err) {
    log({command: 'listen', stage: 'failed', code: err?.code ?? 'NETWORK', message: err?.message ?? ''});
  } finally {
    clearTimeout(timer);
  }

  const chats = events.filter((e) => e.event_type === 'chat');
  const gifts = events.filter((e) => e.event_type === 'gift');
  const evidence = {
    command: 'listen',
    at: new Date().toISOString(),
    eid: winner.room.eid,
    liveStreamId: winner.room.liveStreamId,
    seconds: listenSeconds,
    stats: transport.stats,
    canonicalEvents: events.length,
    chat: {
      count: chats.length,
      withNickname: chats.filter((e) => e.display_name).length,
      withViewerUid: chats.filter((e) => e.viewer_uid).length,
      withExternalId: chats.filter((e) => e.external_id).length,
      withTimestamp: chats.filter((e) => e.occurred_at).length,
      distinctViewerUids: new Set(chats.map((e) => e.viewer_uid).filter(Boolean)).size,
      samples: chats.slice(0, 3).map((e) => ({
        hasNickname: Boolean(e.display_name),
        hasViewerUid: Boolean(e.viewer_uid),
        hasExternalId: Boolean(e.external_id),
        contentLength: String(e.content ?? '').length,
        hasCjk: /[\u3400-\u9fff]/.test(String(e.content ?? '')),
        hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(String(e.content ?? ''))
      }))
    },
    gift: {
      count: gifts.length,
      withGiftId: gifts.filter((e) => e.gift_id).length,
      withSenderUid: gifts.filter((e) => e.viewer_uid).length,
      withGiftName: gifts.filter((e) => e.gift_name).length
    },
    probes
  };
  await mkdir(STATE, {recursive: true});
  await writeFile(join(STATE, 'ws-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  log({command: 'listen', stage: 'done', evidencePath: join(STATE, 'ws-evidence.json'), chat: evidence.chat, gift: evidence.gift});
}

main().catch((err) => {
  console.error(JSON.stringify({command: 'fatal', code: err?.code ?? 'UNEXPECTED', message: String(err?.message ?? err)}));
  process.exitCode = 1;
});
