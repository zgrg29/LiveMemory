#!/usr/bin/env node
// Kuaishou G1.5 research CLI.
//
//   node research/kuaishou-g1_5/probe.mjs policy
//   node research/kuaishou-g1_5/probe.mjs status --room <eid>
//   node research/kuaishou-g1_5/probe.mjs h5 --room <eid> --live-stream-id <id> --acknowledge-blocked
//   node research/kuaishou-g1_5/probe.mjs login --room <eid> --wait 600 [--live-stream-id <id>] [--listen 180]
//   node research/kuaishou-g1_5/probe.mjs selftest
//   node research/kuaishou-g1_5/probe.mjs cleanup
//
// Not imported by src/. It never prints a cookie, passToken, authToken or chat
// text; the QR PNG and an aggregate evidence JSON are the only files written.

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseRoomInput} from './lib/link.mjs';
import {detectLiveStatus, assertLive} from './lib/status.mjs';
import {AnonymousH5Transport, H5_POLICY} from './lib/h5-transport.mjs';
import {AuthenticatedWebSocketTransport} from './lib/ws-transport.mjs';
import {QrLoginSession} from './lib/login.mjs';
import {createNormalizer, NAMESPACE} from './lib/normalize.mjs';
import {IdentityRegistry} from './lib/identity.mjs';
import {sleep} from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.state');
const QR_PATH = join(STATE, 'qr.png');
const STATUS_PATH = join(STATE, 'login-status.json');

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

async function writeStatus(patch) {
  await mkdir(STATE, {recursive: true});
  let prev = {};
  try {
    prev = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  } catch {
    prev = {};
  }
  const next = {...prev, ...patch, updatedAt: new Date().toISOString()};
  await writeFile(STATUS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function log(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function roomFrom(opts) {
  const input = String(opts.room ?? '');
  if (!input) throw new Error('缺少 --room <直播间链接或主播 ID>');
  return parseRoomInput(input);
}

async function cmdPolicy() {
  log({
    command: 'policy',
    route: 'anonymous-h5',
    verdict: 'POLICY-BLOCKED',
    robots: 'https://livev.m.chenzhongtech.com/robots.txt -> User-agent: * Disallow: /',
    terms: '快手软件许可及服务协议 八、数据使用规范 1./1.1/1.4；十、知识产权 1（机器人、蜘蛛等程序或设备监视、复制）',
    productDecision: '不得作为正式默认采集器；仅在获得快手书面许可后重新评估',
    retained: 'G1 真实样本保留为研究证据，不再发起新的受限请求',
    loginRoute: '需用户主动扫码；登录≠平台采集授权'
  });
}

async function cmdStatus(opts) {
  const {eid} = roomFrom(opts);
  const status = await detectLiveStatus(eid);
  log({command: 'status', eid, ...status});
}

async function cmdRooms(opts) {
  const limit = Math.max(1, Math.min(20, Number(opts.limit ?? 8)));
  const {requestJson} = await import('./lib/http.mjs');
  const {liveHeaders, parseHomeList} = await import('./lib/status.mjs');
  const res = await requestJson('https://live.kuaishou.com/live_api/home/list', {headers: liveHeaders()});
  const rooms = parseHomeList(res.json);
  log({
    command: 'rooms',
    result: res.json?.data?.result ?? null,
    count: rooms.length,
    rooms: rooms.slice(0, limit).map((r) => ({eid: r.eid, liveStreamId: r.liveStreamId, watching: r.watchingCount, captionLength: r.caption.length}))
  });
}

async function cmdH5(opts) {
  if (!opts['acknowledge-blocked']) {
    log({command: 'h5', refused: true, ...H5_POLICY});
    process.exitCode = 2;
    return;
  }
  const {eid} = roomFrom(opts);
  const liveStreamId = String(opts['live-stream-id'] ?? '');
  if (!liveStreamId) {
    log({command: 'h5', refused: true, reason: '需要 --live-stream-id（G1 证明 SSR 页面会被限流）'});
    process.exitCode = 2;
    return;
  }
  const seconds = Math.max(10, Number(opts.seconds ?? 60));
  const transport = new AnonymousH5Transport({eid, liveStreamId, acknowledgePolicy: true});
  const normalizer = createNormalizer({
    namespace: NAMESPACE.H5,
    sessionId: `g15-h5-${Date.now()}`,
    roomId: eid,
    liveStreamId
  });
  const events = [];
  const timer = setTimeout(() => transport.stop(), seconds * 1000);
  await transport.start({
    onEvents: (batch) => {
      for (const item of batch) {
        events.push(normalizer.chat(item));
      }
    },
    onStatus: (s) => log({command: 'h5', status: s})
  });
  clearTimeout(timer);
  log({
    command: 'h5',
    done: true,
    stats: transport.stats,
    canonicalEvents: events.length,
    canonical: events.slice(0, 2).map((e) => ({
      event_type: e.event_type,
      viewer_uid: e.viewer_uid,
      viewer_id: e.viewer_id,
      has_content: Boolean(e.content),
      occurred_at: e.occurred_at,
      external_id: e.external_id
    }))
  });
}

function summarizeIdentity(events) {
  const registry = new IdentityRegistry();
  for (const e of events) {
    if (e.event_type !== 'chat') continue;
    if (!e.viewer_uid) continue;
    const [ns, ...rest] = String(e.viewer_uid).split(':');
    registry.observe({namespace: ns, rawUid: rest.join(':'), room: e.room ?? null, at: e.occurred_at});
  }
  return registry.stats();
}

async function cmdLogin(opts) {
  const {eid} = roomFrom(opts);
  const waitSeconds = Math.max(30, Number(opts.wait ?? 600));
  const listenSeconds = Math.max(0, Number(opts.listen ?? 0));
  const session = new QrLoginSession({qrPath: QR_PATH});
  const deadline = Date.now() + waitSeconds * 1000;

  // Start from a clean status document: a previous run's stage must never be
  // mistaken for this run's result.
  await rm(STATUS_PATH, {force: true});
  await writeStatus({stage: 'starting', eid, listenSeconds, startedAt: new Date().toISOString()});
  const first = await session.startQr();
  await writeStatus({stage: 'waiting_for_scan', qrPath: QR_PATH, qrExpiresAt: first.expireTime ? new Date(first.expireTime).toISOString() : null});
  log({command: 'login', stage: 'waiting_for_scan', qrPath: QR_PATH, qrExpiresAt: first.expireTime, note: '用快手 App 扫码并确认；不保存任何凭据'});

  let scanned = false;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await session.scan();
    } catch (err) {
      log({command: 'login', stage: 'scan_error', code: err?.code ?? 'NETWORK'});
      await sleep(1500);
      continue;
    }
    if (result === 1) {
      scanned = true;
      break;
    }
    if (result === 707) {
      await session.startQr();
      await writeStatus({stage: 'waiting_for_scan', qrRefreshedAt: new Date().toISOString()});
      log({command: 'login', stage: 'qr_refreshed', qrPath: QR_PATH});
      continue;
    }
    if (result === 711 || result === 712) {
      await writeStatus({stage: 'cancelled_on_phone', result});
      log({command: 'login', stage: 'cancelled_on_phone', result});
      return;
    }
    await sleep(1500);
  }

  if (!scanned) {
    await writeStatus({stage: 'blocked_on_human_scan'});
    log({command: 'login', stage: 'blocked_on_human_scan', note: '等待窗口内没有扫码；这不是平台拒绝'});
    return;
  }

  await writeStatus({stage: 'scanned'});
  log({command: 'login', stage: 'scanned'});

  let accepted;
  try {
    accepted = await session.accept();
  } catch (err) {
    await writeStatus({stage: 'accept_failed', code: err?.code ?? 'UPSTREAM', message: err?.message ?? ''});
    log({command: 'login', stage: 'accept_failed', code: err?.code ?? 'UPSTREAM', message: err?.message ?? ''});
    return;
  }
  await writeStatus({stage: 'accepted'});
  log({command: 'login', stage: 'accepted'});

  const cb = await session.callback(accepted.qrToken);
  log({command: 'login', stage: cb.hasPassToken ? 'logged_in' : 'callback_without_pass_token', hasPassToken: cb.hasPassToken});
  await writeStatus({stage: cb.hasPassToken ? 'logged_in' : 'callback_without_pass_token', hasPassToken: cb.hasPassToken});
  if (!cb.hasPassToken) return;

  const ticket = await session.exchangeLiveTicket(cb.passToken);
  const ticketView = {
    ok: ticket.ok,
    result: ticket.result,
    hasAuthToken: ticket.hasAuthToken,
    preflight: ticket.preflight,
    cookieNames: ticket.cookieNames
  };
  log({command: 'login', stage: 'live_ticket', ...ticketView});
  await writeStatus({stage: 'live_ticket', ...ticketView});

  let userLogin = {ok: false, reason: 'no_auth_token'};
  if (ticket.hasAuthToken) {
    userLogin = await session.liveUserLogin(ticket.authToken);
    log({command: 'login', stage: 'live_user_login', ...userLogin});
    await writeStatus({stage: 'live_user_login', ...userLogin});
  }

  const status = await detectLiveStatus(eid);
  const optionLiveId = String(opts['live-stream-id'] ?? '');
  const liveStreamId = status.state === 'live' ? status.liveStreamId : '';
  const staleOption = !liveStreamId && optionLiveId;

  log({
    command: 'login',
    stage: 'room_status',
    state: status.state,
    reason: status.reason ?? null,
    liveStreamIdConfirmed: Boolean(liveStreamId),
    staleOption
  });
  await writeStatus({stage: 'room_status', roomState: status.state, roomReason: status.reason ?? null, hasLiveStreamId: Boolean(liveStreamId)});

  if (!liveStreamId) {
    // A liveStreamId from an earlier discovery can belong to a stream that has
    // already ended. Reusing it would turn "target is offline" into a false
    // "token endpoint rejected us", so it is refused by default.
    if (staleOption && opts['allow-stale-live-id']) {
      log({command: 'login', stage: 'stale_live_id_accepted', note: '仅用于显式对照实验；结果不能证明 token 接口行为'});
    } else {
      log({
        command: 'login',
        stage: 'live_id_not_confirmed',
        note: staleOption
          ? '检测到旧 liveStreamId，但当前无法确认仍在直播；已停止，避免把下播误判为 token 接口拒绝'
          : '当前无法确认直播间在播；已停止'
      });
      await writeStatus({stage: 'live_id_not_confirmed', staleOption: Boolean(staleOption)});
      return;
    }
  }

  const effectiveLiveId = liveStreamId || optionLiveId;

  // Controlled re-probe: distinguishes "endpoint needs a signature" from
  // "the whole live API is rate limiting this IP". Uses the same session.
  if (opts.probe) {
    const probes = [
      ['livedetail', `/live_api/liveroom/livedetail?principalId=${encodeURIComponent(eid)}`],
      ['home_list', '/live_api/home/list'],
      ['gift_list', `/live_api/emoji/gift-list?liveStreamId=${encodeURIComponent(effectiveLiveId)}`]
    ];
    for (const [name, path] of probes) {
      try {
        const r = await session.authedJson(path, {referer: `https://live.kuaishou.com/u/${eid}`});
        log({command: 'probe', name, ...r});
      } catch (err) {
        log({command: 'probe', name, error: err?.code ?? 'NETWORK'});
      }
    }
    await sleep(20000);
    try {
      const r = await session.authedJson(`/live_api/liveroom/websocketinfo?liveStreamId=${encodeURIComponent(effectiveLiveId)}`, {
        referer: `https://live.kuaishou.com/u/${eid}`
      });
      log({command: 'probe', name: 'websocketinfo_after_20s', ...r});
      await writeStatus({stage: 'probe_done', after20s: r});
    } catch (err) {
      log({command: 'probe', name: 'websocketinfo_after_20s', error: err?.code ?? 'NETWORK'});
    }
  }

  const info = await session.websocketInfo({liveStreamId: effectiveLiveId, eid});
  const infoView = {
    httpStatus: info.httpStatus,
    result: info.result,
    hasToken: info.hasToken,
    urlCount: info.urlCount,
    errorMessage: info.errorMessage
  };
  log({command: 'login', stage: 'websocket_info', ...infoView});
  await writeStatus({stage: 'websocket_info', ...infoView});

  if (!info.hasToken || info.urlCount === 0) {
    log({command: 'login', stage: 'ws_token_unavailable', result: info.result});
    await writeStatus({stage: 'ws_token_unavailable'});
    return;
  }

  if (!listenSeconds) {
    log({command: 'login', stage: 'ws_token_acquired', note: '加 --listen <秒> 继续真实监听'});
    await writeStatus({stage: 'ws_token_acquired'});
    return;
  }

  const normalizer = createNormalizer({
    namespace: NAMESPACE.WS,
    sessionId: `g15-ws-${Date.now()}`,
    roomId: eid,
    liveStreamId: effectiveLiveId
  });
  const transport = new AuthenticatedWebSocketTransport({
    normalizer,
    urls: info.urls,
    token: info.token,
    liveStreamId: effectiveLiveId
  });
  const events = [];
  const startedAt = Date.now();
  const timer = setTimeout(() => transport.stop(), listenSeconds * 1000);
  try {
    await transport.start({
      onEvents: (batch) => events.push(...batch),
      onStatus: (s) => log({command: 'listen', status: s})
    });
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
    eid,
    liveStreamId: effectiveLiveId,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    stats: transport.stats,
    canonicalEvents: events.length,
    chat: {
      count: chats.length,
      withNickname: chats.filter((e) => e.display_name).length,
      withViewerUid: chats.filter((e) => e.viewer_uid).length,
      withExternalId: chats.filter((e) => e.external_id).length,
      withTimestamp: chats.filter((e) => e.occurred_at).length,
      distinctViewerUids: new Set(chats.map((e) => e.viewer_uid).filter(Boolean)).size
    },
    gift: {
      count: gifts.length,
      withGiftId: gifts.filter((e) => e.gift_id).length,
      withSenderUid: gifts.filter((e) => e.viewer_uid).length,
      withGiftName: gifts.filter((e) => e.gift_name).length,
      samples: gifts.slice(0, 5).map((g) => ({gift_id: g.gift_id, gift_name: g.gift_name, quantity: g.gift_quantity, has_sender: Boolean(g.viewer_uid)}))
    },
    identity: summarizeIdentity(events)
  };
  await mkdir(STATE, {recursive: true});
  await writeFile(join(STATE, 'ws-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  log({command: 'listen', stage: 'done', evidencePath: join(STATE, 'ws-evidence.json'), chat: evidence.chat, gift: evidence.gift, identity: evidence.identity});
  await writeStatus({stage: 'listen_done', evidencePath: join(STATE, 'ws-evidence.json')});
}

async function cmdSelftest() {
  const {encodeEnvelope, decodeEnvelope} = await import('./lib/ws-protocol.mjs');
  const frame = encodeEnvelope(310, Buffer.from([0x2a, 0x00]));
  const decoded = decodeEnvelope(frame);
  log({command: 'selftest', envelopeType: decoded.type, payloadBytes: decoded.payload.length, ok: decoded.type === 'SC_FEED_PUSH'});
}

async function cmdCleanup() {
  await rm(STATE, {recursive: true, force: true});
  log({command: 'cleanup', removed: STATE});
}

async function main() {
  const opts = args(process.argv.slice(2));
  const cmd = opts._[0] ?? 'policy';
  if (cmd === 'policy') return cmdPolicy();
  if (cmd === 'status') return cmdStatus(opts);
  if (cmd === 'rooms') return cmdRooms(opts);
  if (cmd === 'h5') return cmdH5(opts);
  if (cmd === 'login') return cmdLogin(opts);
  if (cmd === 'selftest') return cmdSelftest();
  if (cmd === 'cleanup') return cmdCleanup();
  throw new Error(`未知命令：${cmd}`);
}

main().catch((err) => {
  log({command: 'error', code: err?.code ?? 'ERROR', message: String(err?.message ?? err)});
  process.exitCode = 1;
});
