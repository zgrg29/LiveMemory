#!/usr/bin/env node
/**
 * Independent verification of the anonymous TikTok LIVE WebSocket path.
 *
 * This script is deliberately *not* the product adapter: it opens the same
 * `webcast-ws` socket (see `src/platforms/tiktok/webcast.mjs`) and reports what
 * actually arrived, so the numbers can be checked before wiring anything into
 * LiveMemory.
 *
 * What it measures, per room:
 *   - frames vs. event batches vs. messages (a frame is not a chat)
 *   - chats with nickname, stable user id, message id, verbatim text
 *   - gifts, streak updates, final merged gift, subscriptions
 *   - duplicates by message id, history messages skipped
 *   - silences (possible gaps) and a forced reconnect
 *   - HTTP request count (ttwid + room lookup) and WebSocket connect count
 *
 * Usage:
 *   node scripts/verify-tiktok-local-ws.mjs --handle aljazeeraenglish --minutes 30
 *   node scripts/verify-tiktok-local-ws.mjs --room-id 7706695538414062349 --minutes 5
 *   node scripts/verify-tiktok-local-ws.mjs --handle a --handle b --minutes 30
 *
 * Exit code 0 when the run completed (even with zero gifts: that is reported as
 * NOT_OBSERVED). Exit code 1 when no chat was received at all.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {TIKTOK_WS_HOSTS, TtwidProvider, WebcastSocket, DEFAULT_USER_AGENT} from '../src/platforms/tiktok/webcast.mjs';
import {mapTikTokMessage} from '../src/platforms/tiktok/messages.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** File-backed anonymous ttwid so repeated runs do not re-hit TikTok's page. */
function fileStore(path) {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async write(value) {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }
  };
}

function parseArgs(argv) {
  const options = {
    handles: [],
    roomIds: [],
    minutes: 30,
    reconnectAtMinute: null,
    out: null,
    lang: 'en',
    ttwidFile: resolve(ROOT, 'tests/.tmp/tiktok-ttwid.json'),
    ttwidWaitMinutes: 6
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--handle') options.handles.push(String(argv[++i]));
    else if (arg === '--room-id') options.roomIds.push(String(argv[++i]));
    else if (arg === '--minutes') options.minutes = Number(argv[++i]);
    else if (arg === '--reconnect-at-minute') options.reconnectAtMinute = Number(argv[++i]);
    else if (arg === '--out') options.out = String(argv[++i]);
    else if (arg === '--lang') options.lang = String(argv[++i]);
    else if (arg === '--ttwid-file') options.ttwidFile = resolve(ROOT, String(argv[++i]));
    else if (arg === '--ttwid-wait-minutes') options.ttwidWaitMinutes = Number(argv[++i]);
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else options.handles.push(arg);
  }
  return options;
}

const stats = {
  requests: {ttwid: 0, roomLookup: 0, webcastConnect: 0},
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  rooms: [],
  notes: []
};

async function lookupRoom(handle) {
  stats.requests.roomLookup += 1;
  const params = new URLSearchParams({
    aid: '1988',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    uniqueId: handle,
    sourceType: '54'
  });
  const response = await fetch(`https://www.tiktok.com/api-live/user/room/?${params}`, {
    headers: {
      'user-agent': DEFAULT_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9'
    }
  });
  const text = await response.text();
  if (!text) {
    return {handle, ok: false, status: response.status, reason: response.status === 403 ? 'http_403_throttled' : 'empty_body'};
  }
  const body = JSON.parse(text);
  const user = body?.data?.user;
  const live = body?.data?.liveRoom;
  return {
    handle,
    ok: true,
    uniqueId: user?.uniqueId ?? handle,
    roomId: user?.roomId ?? null,
    isLive: live?.status === 2,
    roomStatus: live?.status ?? null,
    title: live?.title ?? null,
    viewers: live?.liveRoomStats?.userCount ?? null,
    anchorUid: user?.id ?? null,
    anchorName: user?.nickname ?? null
  };
}

function newRoomState({handle, roomId, room}) {
  const now = Date.now();
  return {
    handle,
    roomId,
    room: room ?? null,
    connectedAt: null,
    connectAttempts: 0,
    connections: 0,
    reconnects: 0,
    lastFrameAt: null,
    lastEventAt: null,
    silentSince: now,
    maxSilenceMs: 0,
    silences: [],
    frames: 0,
    batchFrames: 0,
    controlFrames: 0,
    messages: 0,
    chats: 0,
    gifts: 0,
    giftFinals: 0,
    giftStreakUpdates: 0,
    memberships: 0,
    ignored: 0,
    historySkipped: 0,
    duplicateEvents: 0,
    chatWithoutUid: 0,
    chatWithoutMsgId: 0,
    chatWithoutText: 0,
    nonAsciiChat: 0,
    emoteChat: 0,
    msgIds: new Set(),
    duplicateMsgIds: new Set(),
    uids: new Set(),
    nicknames: new Set(),
    giftGroups: new Map(),
    giftCatalogSeen: new Set(),
    chatSamples: [],
    giftSamples: [],
    membershipSamples: [],
    minuteBuckets: new Map(),
    methods: new Map(),
    socketSnapshots: []
  };
}

function noteSilence(room, at) {
  if (room.lastEventAt === null) return;
  const silence = at - room.lastEventAt;
  if (silence > room.maxSilenceMs) room.maxSilenceMs = silence;
}

function bucketOf(room, at) {
  const minute = Math.floor((at - stats.startedAtMs) / 60000);
  if (!room.minuteBuckets.has(minute)) room.minuteBuckets.set(minute, {chats: 0, gifts: 0, frames: 0});
  return room.minuteBuckets.get(minute);
}

function applyMessage(room, message) {
  room.messages += 1;
  if (message.isHistory) {
    room.historySkipped += 1;
    return;
  }
  room.methods.set(message.method, (room.methods.get(message.method) ?? 0) + 1);
  let mapped;
  try {
    mapped = mapTikTokMessage(message);
  } catch {
    room.ignored += 1;
    return;
  }
  if (mapped.kind === 'viewers' || mapped.kind === 'control') {
    room.ignored += 1;
    return;
  }
  if (mapped.kind === 'ignored') {
    room.ignored += 1;
    return;
  }
  if (mapped.kind === 'event') {
    const event = mapped.event;
    const msgId = event.external_id ? String(event.external_id) : null;
    if (msgId) {
      if (room.msgIds.has(msgId)) {
        room.duplicateEvents += 1;
        room.duplicateMsgIds.add(msgId);
        return;
      }
      room.msgIds.add(msgId);
    }
    const at = Date.now();
    bucketOf(room, at).chats += 0;
    if (event.event_type === 'chat') {
      room.chats += 1;
      bucketOf(room, at).chats += 1;
      if (!event.viewer_uid) room.chatWithoutUid += 1;
      else room.uids.add(String(event.viewer_uid));
      if (!msgId) room.chatWithoutMsgId += 1;
      if (!event.content) room.chatWithoutText += 1;
      if (/[^\x00-\x7F]/.test(String(event.content ?? ''))) room.nonAsciiChat += 1;
      if (event.display_name) room.nicknames.add(String(event.display_name));
      if (room.chatSamples.length < 12) {
        room.chatSamples.push({
          at: new Date(at).toISOString(),
          uid: event.viewer_uid,
          nickname: event.display_name,
          msgId,
          content: event.content
        });
      }
    } else if (event.event_type === 'membership') {
      room.memberships += 1;
      if (room.membershipSamples.length < 5) {
        room.membershipSamples.push({at: new Date(at).toISOString(), uid: event.viewer_uid, nickname: event.display_name, detail: event.amount_display});
      }
    }
    if (event.event_type === 'chat' || event.event_type === 'membership') {
      noteSilence(room, at);
      room.lastEventAt = at;
    }
    return;
  }
  if (mapped.kind === 'gift') {
    const at = Date.now();
    room.gifts += 1;
    bucketOf(room, at).gifts += 1;
    const key = mapped.groupKey;
    const previous = room.giftGroups.get(key);
    const group = previous ?? {updates: 0, firstAt: at, quantity: 0, giftName: null, uid: null, nickname: null};
    group.updates += 1;
    group.quantity = mapped.event.gift_quantity;
    group.giftName = mapped.event.gift_name;
    group.uid = mapped.event.viewer_uid;
    group.nickname = mapped.event.display_name;
    group.at = at;
    room.giftGroups.set(key, group);
    if (mapped.final) {
      room.giftFinals += 1;
      if (room.giftSamples.length < 10) {
        room.giftSamples.push({
          at: new Date(at).toISOString(),
          giftName: mapped.event.gift_name,
          giftId: mapped.event.gift_id,
          quantity: mapped.event.gift_quantity,
          display: mapped.event.amount_display,
          uid: mapped.event.viewer_uid,
          nickname: mapped.event.display_name,
          streakUpdates: room.giftGroups.get(key)?.updates ?? 1,
          msgId: mapped.event.external_id
        });
      }
    } else {
      room.giftStreakUpdates += 1;
    }
    noteSilence(room, at);
    room.lastEventAt = at;
  }
}

function attach(room) {
  stats.requests.webcastConnect += 1;
  room.connectAttempts += 1;
  const socket = new WebcastSocket({
    roomId: room.roomId,
    onFrame: ({frame, result}) => {
      const at = Date.now();
      noteSilence(room, at);
      room.lastFrameAt = at;
      room.frames += 1;
      room.silentSince = at;
      bucketOf(room, at).frames += 1;
      if (!result) {
        room.controlFrames += 1;
        return;
      }
      room.batchFrames += 1;
      for (const message of result.messages) applyMessage(room, message);
    },
    onClose: (info) => {
      room.socketSnapshots.push({closedAt: new Date().toISOString(), ...info});
      room.lastClose = info;
    },
    onError: (error) => {
      room.lastSocketError = {at: new Date().toISOString(), reason: error?.details?.reason ?? error?.message ?? null};
    }
  });
  room.sockets = room.sockets ?? [];
  room.sockets.push(socket);
  return socket;
}

async function connectRoom(room, ttwidProvider, {refresh = false} = {}) {
  const socket = attach(room);
  const ttwid = await ttwidProvider.get({refresh});
  await socket.connect({ttwid});
  room.connections += 1;
  if (!room.connectedAt) room.connectedAt = Date.now();
  room.wsHost = socket.host;
  return socket;
}

function summary(room, minutes) {
  const elapsedMs = Date.now() - (room.connectedAt ?? stats.startedAtMs);
  const uniqueGiftGroups = room.giftGroups.size;
  const lastFrameAgeMs = room.lastFrameAt ? Date.now() - room.lastFrameAt : null;
  return {
    handle: room.handle,
    roomId: room.roomId,
    wsHost: room.wsHost ?? null,
    liveTitle: room.room?.title ?? null,
    viewerCount: room.room?.viewers ?? null,
    connectedAt: room.connectedAt ? new Date(room.connectedAt).toISOString() : null,
    elapsedMinutes: Number((elapsedMs / 60000).toFixed(2)),
    connections: room.connections,
    connectAttempts: room.connectAttempts,
    reconnects: Math.max(0, room.connections - 1),
    frames: room.frames,
    batchFrames: room.batchFrames,
    controlFrames: room.controlFrames,
    messages: room.messages,
    historySkipped: room.historySkipped,
    chats: room.chats,
    uniqueViewers: room.uids.size,
    uniqueNicknames: room.nicknames.size,
    chatWithoutUid: room.chatWithoutUid,
    chatWithoutMsgId: room.chatWithoutMsgId,
    chatWithoutText: room.chatWithoutText,
    nonAsciiChat: room.nonAsciiChat,
    duplicateEvents: room.duplicateEvents,
    duplicatesResent: room.duplicateMsgIds.size,
    gifts: room.gifts,
    giftFinals: room.giftFinals,
    giftStreakUpdates: room.giftStreakUpdates,
    giftGroups: uniqueGiftGroups,
    observedGiftStreaks: [...room.giftGroups.values()].filter((g) => g.updates > 1).length,
    memberships: room.memberships,
    ignored: room.ignored,
    maxSilenceMs: room.maxSilenceMs,
    lastFrameAgeMs,
    framesPerMinute: elapsedMs > 0 ? Number((room.frames / (elapsedMs / 60000)).toFixed(1)) : null,
    messagesPerMinute: elapsedMs > 0 ? Number((room.messages / (elapsedMs / 60000)).toFixed(1)) : null,
    chatsPerMinute: elapsedMs > 0 ? Number((room.chats / (elapsedMs / 60000)).toFixed(2)) : null,
    minuteBuckets: [...room.minuteBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([minute, value]) => ({minute, ...value})),
    methods: Object.fromEntries([...room.methods.entries()].sort((a, b) => b[1] - a[1])),
    chatSamples: room.chatSamples,
    giftSamples: room.giftSamples,
    membershipSamples: room.membershipSamples,
    lastClose: room.lastClose ?? null,
    lastSocketError: room.lastSocketError ?? null,
    giftStatus: room.gifts > 0 ? 'OBSERVED' : 'NOT-OBSERVED',
    membershipStatus: room.memberships > 0 ? 'OBSERVED' : 'NOT-OBSERVED',
    requestedMinutes: minutes
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.handles.length && !options.roomIds.length) {
    options.handles.push('aljazeeraenglish');
  }
  const totalMs = Math.max(1, options.minutes) * 60000;
  console.log(`[verify] target ${options.minutes} min; handles=${options.handles.join(',') || '-'} roomIds=${options.roomIds.join(',') || '-'}`);

  const ttwidProvider = new TtwidProvider({store: fileStore(options.ttwidFile)});
  await ttwidProvider.load();
  let ttwid;
  const waitUntil = Date.now() + Math.max(0, options.ttwidWaitMinutes) * 60000;
  for (;;) {
    try {
      ttwid = await ttwidProvider.get();
      break;
    } catch (error) {
      // TikTok throttles bursts of page requests with no cookie at all. Wait
      // instead of turning a temporary throttle into a failed verification.
      const throttled = error?.code === 'TIKTOK_RATE_LIMITED' || error?.code === 'TIKTOK_NETWORK';
      if (!throttled || Date.now() > waitUntil) throw error;
      console.log(`[verify] anonymous cookie not issued yet (${error?.code}); retrying in 45 s`);
      await new Promise((resolve) => setTimeout(resolve, 45000));
    }
  }
  stats.requests.ttwid = ttwidProvider.fetchCount;
  stats.ttwidSource = ttwidProvider.source;
  console.log(`[verify] anonymous ttwid acquired (${ttwid.slice(0, 12)}...); no login used`);

  const rooms = [];
  for (const roomId of options.roomIds) {
    const room = newRoomState({handle: `room:${roomId}`, roomId});
    rooms.push(room);
  }
  for (const handle of options.handles) {
    let lookup = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        lookup = await lookupRoom(handle);
      } catch (error) {
        lookup = {handle, ok: false, reason: error.message};
      }
      if (lookup.ok && lookup.roomId) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
    if (!lookup?.roomId) {
      stats.notes.push({handle, reason: lookup?.reason ?? 'room_lookup_failed', status: lookup?.status ?? null});
      console.log(`[verify] ${handle}: room lookup failed (${lookup?.reason ?? lookup?.status})`);
      continue;
    }
    console.log(`[verify] ${handle}: room ${lookup.roomId}, live=${lookup.isLive}, viewers=${lookup.viewers ?? '?'}, title=${lookup.title ?? '-'}`);
    rooms.push(newRoomState({handle, roomId: lookup.roomId, room: lookup}));
  }
  if (!rooms.length) {
    console.error('[verify] no room could be resolved; nothing to capture');
    process.exit(2);
  }

  const sockets = [];
  for (const room of rooms) {
    try {
      sockets.push(await connectRoom(room, ttwidProvider));
      console.log(`[verify] ${room.handle}: connected to ${room.wsHost}`);
    } catch (error) {
      room.lastSocketError = {at: new Date().toISOString(), reason: error?.code ?? error?.message};
      console.log(`[verify] ${room.handle}: connect failed ${error?.code ?? error?.message}`);
    }
  }

  let reconnectDone = options.reconnectAtMinute === null;
  const reconnectTimer = options.reconnectAtMinute === null
    ? null
    : setTimeout(async () => {
      reconnectDone = true;
      const room = rooms[0];
      const socket = room.sockets?.at(-1);
      console.log(`[verify] ${room.handle}: forcing a disconnect to verify reconnect`);
      stats.notes.push({at: new Date().toISOString(), event: 'forced_disconnect', room: room.handle});
      socket?.close({code: 4001, reason: 'verification_forced'});
      await new Promise((resolve) => setTimeout(resolve, 3000));
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          await connectRoom(room, ttwidProvider, {refresh: attempt > 1});
          room.reconnects += 1;
          console.log(`[verify] ${room.handle}: reconnected to ${room.wsHost} (attempt ${attempt})`);
          break;
        } catch (error) {
          stats.notes.push({
            at: new Date().toISOString(),
            event: 'reconnect_failed',
            room: room.handle,
            attempt,
            reason: error?.code ?? error?.message
          });
          console.log(`[verify] ${room.handle}: reconnect attempt ${attempt} failed ${error?.code ?? error?.message}`);
          if (attempt >= 6) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(60000, 3000 * 2 ** (attempt - 1))));
        }
      }
    }, Math.min(totalMs / 2, Math.max(60000, options.minutes * 60000 * 0.4)));

  const progress = setInterval(() => {
    for (const room of rooms) {
      console.log(`[verify] t+${Math.round((Date.now() - stats.startedAtMs) / 60000)}m ${room.handle}: frames=${room.frames} chats=${room.chats} gifts=${room.gifts} viewers=${room.uids.size} reconnects=${room.connections - 1}`);
    }
  }, 60000);
  progress.unref?.();

  await new Promise((resolve) => setTimeout(resolve, totalMs));
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clearInterval(progress);
  stats.requests.ttwid = ttwidProvider.fetchCount;

  for (const socket of sockets) socket.close({code: 1000, reason: 'verification_done'});
  for (const room of rooms) for (const socket of room.sockets ?? []) socket.close({code: 1000, reason: 'verification_done'});

  stats.finishedAt = new Date().toISOString();
  stats.finishedAtMs = Date.now();
  stats.minutes = options.minutes;
  stats.reconnectVerified = reconnectDone;
  stats.requests.webcastConnectTotal = rooms.reduce((sum, room) => sum + room.connections, 0);
  stats.ttwid = ttwidProvider.snapshot();
  stats.wsHosts = TIKTOK_WS_HOSTS;
  stats.results = rooms.map((room) => summary(room, options.minutes));

  const outDir = options.out
    ? resolve(ROOT, options.out)
    : resolve(ROOT, 'tests/.tmp', `verify-tiktok-local-ws-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outDir, {recursive: true});
  const reportPath = resolve(outDir, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');

  console.log('\n===== RESULT =====');
  for (const result of stats.results) {
    console.log(`\n${result.handle} (room ${result.roomId}, host ${result.wsHost})`);
    console.log(`  duration          ${result.elapsedMinutes} min, connections ${result.connections}, reconnects ${result.reconnects}`);
    console.log(`  frames            ${result.frames} (batches ${result.batchFrames}, control ${result.controlFrames})`);
    console.log(`  messages          ${result.messages} (history skipped ${result.historySkipped})`);
    console.log(`  chats             ${result.chats} | unique viewers ${result.uniqueViewers} | unique nicknames ${result.uniqueNicknames}`);
    console.log(`  missing fields    uid ${result.chatWithoutUid} | msgId ${result.chatWithoutMsgId} | text ${result.chatWithoutText}`);
    console.log(`  duplicates        ${result.duplicateEvents} (distinct msgIds resent ${result.duplicatesResent})`);
    console.log(`  gifts             ${result.gifts} updates -> ${result.giftFinals} final (${result.giftStatus}); streak updates ${result.giftStreakUpdates}`);
    console.log(`  memberships       ${result.memberships} (${result.membershipStatus})`);
    console.log(`  max silence       ${result.maxSilenceMs} ms`);
    console.log(`  rate              ${result.framesPerMinute} frames/min, ${result.messagesPerMinute} messages/min`);
    console.log(`  methods           ${JSON.stringify(result.methods)}`);
  }
  console.log(`\nrequests: ttwid ${stats.requests.ttwid}, room lookups ${stats.requests.roomLookup}, websocket connects ${stats.requests.webcastConnect}`);
  console.log(`report: ${reportPath}`);

  const totalChats = stats.results.reduce((sum, result) => sum + result.chats, 0);
  process.exit(totalChats > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[verify] failed', error);
  process.exit(1);
});
