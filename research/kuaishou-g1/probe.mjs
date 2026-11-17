// LiveMemory Kuaishou G1 — zero-dependency research probe (NOT a platform adapter).
//
// This file is an independent PoC for the G1 investigation. It is deliberately
// kept outside src/ and does not import any production module. It never logs in,
// never sends chat/gifts/likes, and never persists chat text, nicknames, avatars
// or credentials.
//
// Commands:
//   node research/kuaishou-g1/probe.mjs discover [--limit 5]
//   node research/kuaishou-g1/probe.mjs status --room <url|eid>
//   node research/kuaishou-g1/probe.mjs watch --room <url|eid> [--room ...] --seconds 120
//   node research/kuaishou-g1/probe.mjs ws-anon --room <url|eid>
//   node research/kuaishou-g1/probe.mjs qr-probe
//   node research/kuaishou-g1/probe.mjs auth
//   node research/kuaishou-g1/probe.mjs cleanup
//
// Safety:
//   - anonymous only: no Cookie, no passToken, no signature, no captcha solving;
//   - default feed cadence 3.2s per room; concurrent rooms are staggered;
//   - a rejected request is recorded and not retried with evasion;
//   - output is aggregates only (no content, no nickname, no raw user id list).
//
// The login-state WebSocket route is intentionally NOT implemented here. Its
// official gateway (`websocketinfo`) requires a live-site session AND the
// non-public `__NS_hxfalcon` signature; reimplementing that is outside the
// permitted boundary of this PoC. See docs/KUAISHOU_G1_POC.md.

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flag = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flags = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};
const has = (name) => argv.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const pct = (v, total) => (total ? Math.round((v / total) * 1000) / 10 : 0);
const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

async function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
    // The H5 feed endpoint has historically double-encoded its JSON.
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    body = null;
  }
  return { status: res.status, bytes: text.length, body };
}

/** Accept a live URL, `<eid>`, or an H5 share URL and return the broadcaster eid. */
export function parseRoomInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return /^[A-Za-z0-9_.-]{2,64}$/.test(raw) ? raw : null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'live.kuaishou.com' || host === 'livev.m.chenzhongtech.com') {
    const m = url.pathname.match(/\/(?:u|fw\/live|profile)\/([A-Za-z0-9_.-]{2,64})/);
    if (m) return m[1];
  }
  if (host.endsWith('kuaishou.com')) {
    const m = url.pathname.match(/\/profile\/([A-Za-z0-9_.-]{2,64})/);
    if (m) return m[1];
  }
  return null;
}

/** Public room page SSR: `<eid>` page contains liveStream.id only while live. */
export async function roomStatus(eid) {
  const res = await fetch(`https://live.kuaishou.com/u/${encodeURIComponent(eid)}`, {
    headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const live = html.match(/"playList":\[\{"liveStream":\{"id":"([^"]+)"/);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/);
  const tooFast = html.includes('请求过快') || html.includes('"errorType":{"type":2');
  return {
    eid,
    httpStatus: res.status,
    bytes: html.length,
    live: Boolean(live?.[1]),
    liveStreamId: live?.[1] ?? null,
    genericTitle: String(title?.[1] ?? '').trim() === '快手直播',
    pageTitlePresent: Boolean(title?.[1]),
    rateLimited: tooFast,
  };
}

async function pullFeed(liveStreamId, cursor) {
  const url =
    `https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=${encodeURIComponent(liveStreamId)}` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  return jsonFetch(url, {
    headers: {
      'user-agent': MOBILE_UA,
      accept: 'application/json, text/plain, */*',
      referer: 'https://livev.m.chenzhongtech.com/',
    },
  });
}

async function discoverRooms(limit = 8) {
  const res = await jsonFetch('https://live.kuaishou.com/live_api/home/list', {
    headers: {
      'user-agent': MOBILE_UA,
      accept: 'application/json, text/plain, */*',
      referer: 'https://live.kuaishou.com/',
    },
  });
  const rooms = [];
  for (const section of res.body?.data?.list ?? []) {
    for (const group of section?.gameLiveInfo ?? []) {
      for (const item of group?.liveInfo ?? []) {
        if (item?.id && item?.author?.id) {
          rooms.push({
            eid: String(item.author.id),
            liveStreamId: String(item.id),
            watching: Number(item.watchingCount ?? 0) || 0,
          });
        }
      }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const room of rooms.sort((a, b) => b.watching - a.watching)) {
    if (seen.has(room.liveStreamId)) continue;
    seen.add(room.liveStreamId);
    unique.push(room);
  }
  return { httpStatus: res.status, total: unique.length, rooms: unique.slice(0, limit) };
}

function newRoomStats(eid) {
  return {
    eid,
    liveStreamId: null,
    polls: 0,
    pollErrors: 0,
    consecutiveErrors: 0,
    maxConsecutiveErrors: 0,
    reconnects: 0,
    resultCodes: {},
    messages: 0,
    types: {},
    coverage: { userName: 0, userId: 0, time: 0, headurl: 0, messageId: 0 },
    uniqueUsers: new Set(),
    userNicknames: new Map(),
    userCounts: new Map(),
    duplicates: 0,
    pollCounts: [],
    latencies: [],
    watching: [],
    firstAt: null,
    lastAt: null,
    cursorSeen: false,
    __seen: new Set(),
  };
}

function feedEventStats(room, feeds, receivedAt) {
  for (const f of feeds) {
    room.messages++;
    const type = String(f.type ?? '(none)');
    room.types[type] = (room.types[type] ?? 0) + 1;
    const author = f.author ?? {};
    if (author.userName) room.coverage.userName++;
    if (author.userId != null && String(author.userId) !== '') room.coverage.userId++;
    if (f.time != null) room.coverage.time++;
    if (author.headurl) room.coverage.headurl++;
    if (f.id != null || f.feedId != null) room.coverage.messageId++;
    if (f.time != null) {
      room.latencies.push(receivedAt - Number(f.time));
      if (room.firstAt == null) room.firstAt = Number(f.time);
      room.lastAt = Number(f.time);
    }
    if (author.userId != null) {
      const uid = String(author.userId);
      room.uniqueUsers.add(uid);
      room.userCounts.set(uid, (room.userCounts.get(uid) ?? 0) + 1);
      const names = room.userNicknames.get(uid) ?? new Set();
      names.add(String(author.userName ?? ''));
      room.userNicknames.set(uid, names);
    }
    const key = `${author.userId ?? ''}|${f.time ?? ''}|${sha(f.content ?? '').slice(0, 16)}`;
    if (room.__seen.has(key)) room.duplicates++;
    room.__seen.add(key);
  }
}

function summarizeRoom(room, includeInternal = false) {
  const lat = room.latencies.slice().sort((a, b) => a - b);
  const out = {
    eid: room.eid,
    liveStreamId: room.liveStreamId,
    polls: room.polls,
    pollErrors: room.pollErrors,
    maxConsecutiveErrors: room.maxConsecutiveErrors,
    reconnects: room.reconnects,
    resultCodes: room.resultCodes,
    messages: room.messages,
    types: room.types,
    uniqueUsers: room.uniqueUsers.size,
    repeatUsers: [...room.userCounts.values()].filter((n) => n > 1).length,
    usersWithMoreThanOneNickname: [...room.userNicknames.values()].filter((s) => s.size > 1).length,
    duplicates: room.duplicates,
    coverage: room.coverage,
    coveragePct: Object.fromEntries(
      Object.entries(room.coverage).map(([k, v]) => [k, pct(v, room.messages)]),
    ),
    maxMessagesPerPoll: room.pollCounts.length ? Math.max(...room.pollCounts) : 0,
    pollsWithZeroMessages: room.pollCounts.filter((n) => n === 0).length,
    watching: room.watching.length
      ? { min: Math.min(...room.watching), max: Math.max(...room.watching), last: room.watching.at(-1) }
      : null,
    latencyMs: lat.length ? { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.at(-1) } : null,
    cursorSeen: room.cursorSeen,
    messageTime: room.firstAt ? { first: room.firstAt, last: room.lastAt } : null,
    endedEarly: Boolean(room.endedEarly),
    endedAt: room.endedAt ?? null,
    endReason: room.endReason ?? null,
    rateLimitedAtStart: Boolean(room.rateLimitedAtStart),
    networkPause: room.networkPause ?? null,
    resumed: Boolean(room.resumed),
    resumeAtMs: room.resumeAtMs ?? null,
  };
  if (includeInternal) out.__seen = room.__seen;
  return out;
}

async function cmdDiscover() {
  const limit = Number(flag('--limit', '8')) || 8;
  const result = await discoverRooms(limit);
  console.log(JSON.stringify({ command: 'discover', at: new Date().toISOString(), ...result }, null, 2));
}

async function cmdStatus() {
  const input = flag('--room');
  const eid = parseRoomInput(input);
  if (!eid) {
    console.error('usage: status --room <https://live.kuaishou.com/u/<eid> | <eid>>');
    process.exit(2);
  }
  const status = await roomStatus(eid);
  console.log(JSON.stringify({ command: 'status', at: new Date().toISOString(), room: status }, null, 2));
}

async function cmdWatch() {
  const inputs = flags('--room');
  const targets = flags('--target');
  const forced = new Map();
  for (const t of targets) {
    const i = t.lastIndexOf(':');
    if (i > 0) forced.set(t.slice(0, i), t.slice(i + 1));
  }
  const seconds = Math.max(10, Number(flag('--seconds', '120')) || 120);
  const intervalMs = Math.max(3000, Number(flag('--interval', '3200')) || 3200);
  const dropAt = Number(flag('--drop-at', '0')) || 0;
  const dropMs = Number(flag('--drop-ms', '0')) || 0;
  const outPath = flag('--out', '');
  if (!inputs.length && !forced.size) {
    console.error('usage: watch --room <eid|url> [--room ...] | --target <eid>:<liveStreamId> --seconds 120 [--interval 3200] [--out file.json]');
    process.exit(2);
  }

  const rooms = [];
  for (const [eid, streamId] of forced) {
    rooms.push({ ...newRoomStats(eid), liveStreamId: streamId, status: { source: 'discover' } });
  }
  for (const input of inputs) {
    const eid = parseRoomInput(input);
    if (!eid || forced.has(eid)) continue;
    try {
      const status = await roomStatus(eid);
      if (!status.liveStreamId) {
        rooms.push({ ...newRoomStats(eid), offlineAtStart: !status.rateLimited, rateLimitedAtStart: status.rateLimited, status });
        continue;
      }
      rooms.push({ ...newRoomStats(eid), liveStreamId: status.liveStreamId, status });
    } catch (err) {
      rooms.push({ ...newRoomStats(eid), resolveError: String(err?.message ?? err) });
    }
  }
  const liveRooms = rooms.filter((r) => r.liveStreamId);
  if (!liveRooms.length) {
    console.log(JSON.stringify({ command: 'watch', error: 'no live room', rooms: rooms.map((r) => summarizeRoom(r)) }, null, 2));
    process.exit(4);
  }

  const deadline = now() + seconds * 1000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const startedAt = new Date().toISOString();
  const startedMs = now();

  async function loop(room, index) {
    // Stagger rooms so they do not hit the endpoint at the same instant.
    await sleep(index * 350);
    let cursor = '';
    let nextDelay = intervalMs;
    let pauseUntil = 0;
    let pausedOnce = false;
    while (!stopped && now() < deadline) {
      if (dropAt && !pausedOnce && now() - startedMs >= dropAt * 1000) {
        pauseUntil = now() + dropMs;
        pausedOnce = true;
        room.networkPause = { atMs: now() - startedMs, durationMs: dropMs };
      }
      if (now() < pauseUntil) {
        await sleep(Math.min(1000, pauseUntil - now()));
        continue;
      }
      if (pausedOnce && !room.resumed) {
        room.resumed = true;
        room.resumeAtMs = now() - startedMs;
      }
      const t0 = now();
      let result;
      try {
        result = await pullFeed(room.liveStreamId, cursor);
      } catch (err) {
        room.polls++;
        room.pollErrors++;
        room.consecutiveErrors++;
        room.maxConsecutiveErrors = Math.max(room.maxConsecutiveErrors, room.consecutiveErrors);
        room.errorKinds = room.errorKinds ?? {};
        const kind = String(err?.name ?? 'Error');
        room.errorKinds[kind] = (room.errorKinds[kind] ?? 0) + 1;
        await sleep(nextDelay);
        continue;
      }
      room.polls++;
      if (room.consecutiveErrors > 0) room.reconnects++;
      room.consecutiveErrors = 0;
      if (result.status !== 200 || !result.body) {
        room.pollErrors++;
        room.httpErrors = room.httpErrors ?? {};
        room.httpErrors[String(result.status)] = (room.httpErrors[String(result.status)] ?? 0) + 1;
        // A stream that ended returns 404. Confirm with the public page instead
        // of guessing, and stop this room after a short grace period.
        if (room.pollErrors >= 3 && now() - (room.lastSuccessAt ?? 0) > 45000) {
          const current = await roomStatus(room.eid).catch(() => null);
          if (current && !current.live && !current.rateLimited) {
            room.endedEarly = true;
            room.endedAt = new Date().toISOString();
            break;
          }
        }
      } else {
        room.lastSuccessAt = now();
        const code = String(result.body.result);
        room.resultCodes[code] = (room.resultCodes[code] ?? 0) + 1;
        // 601 = "直播已停止" (verified 2026-11-17). It is an explicit end
        // signal, not a transient empty poll; stop this room instead of
        // polling a dead stream for the rest of the run.
        if (Number(result.body.result) === 601) {
          room.endedEarly = true;
          room.endReason = '601 直播已停止';
          room.endedAt = new Date().toISOString();
          break;
        }
        if (result.body.pullCycleSeconds) {
          nextDelay = Math.max(3000, Number(result.body.pullCycleSeconds) * 1000);
        }
        if (result.body.currentWatchingCount != null && room.watching.length < 4000) {
          room.watching.push(Number(result.body.currentWatchingCount));
        }
        const feeds = Array.isArray(result.body.liveStreamFeeds) ? result.body.liveStreamFeeds : [];
        room.pollCounts.push(feeds.length);
        feedEventStats(room, feeds, t0);
        if (result.body.cursor) {
          cursor = result.body.cursor;
          room.cursorSeen = true;
        }
      }
      const elapsed = now() - t0;
      await sleep(Math.max(0, nextDelay - elapsed) + 150 + Math.floor(Math.random() * 200));
    }
    room.__done = true;
  }

  await Promise.all(liveRooms.map((room, i) => loop(room, i)));
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);

  // Cross-room identity overlap: only counts, never the IDs themselves.
  const roomSets = liveRooms.map((r) => r.uniqueUsers);
  const overlap = new Set();
  for (const uid of roomSets[0] ?? []) {
    if (roomSets.slice(1).some((s) => s.has(uid))) overlap.add(uid);
  }
  const allUsers = new Set();
  for (const set of roomSets) for (const uid of set) allUsers.add(uid);
  const totalMessages = liveRooms.reduce((s, r) => s + r.messages, 0);
  const totalUserMessages = liveRooms.reduce((s, r) => s + r.uniqueUsers.size, 0);

  const summary = {
    command: 'watch',
    startedAt,
    endedAt: new Date().toISOString(),
    requestedSeconds: seconds,
    actualSeconds: Math.round((now() - startedMs) / 1000),
    intervalMs,
    roomsConcurrent: liveRooms.length,
    totals: {
      messages: totalMessages,
      uniqueUsersAcrossRooms: allUsers.size,
      uniqueUserRoomPairs: totalUserMessages,
      overlapsAcrossRooms: overlap.size,
      usersInMoreThanOneRoom: overlap.size,
      duplicateFingerprints: liveRooms.reduce((s, r) => s + r.duplicates, 0),
    },
    rooms: rooms.map((r) => {
      const s = summarizeRoom(r);
      if (r.errorKinds) s.errorKinds = r.errorKinds;
      if (r.httpErrors) s.httpErrors = r.httpErrors;
      if (r.offlineAtStart) s.offlineAtStart = true;
      return s;
    }),
  };

  if (outPath) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(outPath, JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdWsAnon() {
  const input = flag('--room');
  const eid = parseRoomInput(input);
  if (!eid) {
    console.error('usage: ws-anon --room <eid|url>');
    process.exit(2);
  }
  const status = await roomStatus(eid);
  if (!status.liveStreamId) {
    console.log(JSON.stringify({ command: 'ws-anon', room: status, error: 'room offline or not found' }, null, 2));
    return;
  }
  // Exactly one anonymous request: no Cookie, no passToken, no __NS_hxfalcon.
  const res = await jsonFetch(
    `https://live.kuaishou.com/live_api/liveroom/websocketinfo?liveStreamId=${encodeURIComponent(status.liveStreamId)}`,
    {
      headers: {
        'user-agent': DESKTOP_UA,
        accept: 'application/json, text/plain, */*',
        referer: `https://live.kuaishou.com/u/${encodeURIComponent(eid)}`,
      },
    },
  );
  const data = res.body?.data ?? {};
  console.log(
    JSON.stringify(
      {
        command: 'ws-anon',
        at: new Date().toISOString(),
        room: { eid, liveStreamId: status.liveStreamId },
        httpStatus: res.status,
        result: data.result ?? res.body?.result ?? null,
        hasToken: Boolean(data.token),
        hasWebsocketUrls: Array.isArray(data.websocketUrls) && data.websocketUrls.length > 0,
        errorMessagePresent: Boolean(data.error_msg ?? res.body?.error_msg),
        note: 'anonymous request without Cookie/signature; rejection is recorded, not retried',
      },
      null,
      2,
    ),
  );
}

async function cmdQrProbe() {
  // One unsigned QR-start request. This records whether the official login
  // gateway accepts a browser-free QR request; it does not attempt a signature.
  const body = new URLSearchParams({
    sid: 'kuaishou.server.webday7',
    channelType: 'UNKNOWN',
    isWebSig4: 'true',
  });
  const res = await jsonFetch('https://id.kuaishou.com/rest/c/infra/ks/qr/start', {
    method: 'POST',
    headers: {
      'user-agent': DESKTOP_UA,
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://www.kuaishou.com/',
      origin: 'https://www.kuaishou.com',
      accept: 'application/json, text/plain, */*',
    },
    body,
  });
  const data = res.body ?? {};
  const out = {
    command: 'qr-probe',
    at: new Date().toISOString(),
    httpStatus: res.status,
    result: data.result ?? null,
    errorMessagePresent: Boolean(data.error_msg ?? data.message),
    hasQrUrl: Boolean(data.qrUrl),
    hasQrLoginToken: Boolean(data.qrLoginToken),
    note: 'single unsigned request; no retry, no signature, no captcha solving',
  };
  if (has('--flow') && data.qrLoginToken) {
    const form = (fields) =>
      new URLSearchParams({
        ...fields,
        qrLoginToken: String(data.qrLoginToken),
        qrLoginSignature: String(data.qrLoginSignature ?? ''),
        isWebSig4: 'true',
      });
    const call = async (path, fields, timeoutMs = 75000) => {
      try {
        const r = await jsonFetch(
          `https://id.kuaishou.com${path}`,
          {
            method: 'POST',
            headers: {
              'user-agent': DESKTOP_UA,
              'content-type': 'application/x-www-form-urlencoded',
              referer: 'https://www.kuaishou.com/',
              origin: 'https://www.kuaishou.com',
              accept: 'application/json, text/plain, */*',
            },
            body: form(fields),
          },
          timeoutMs,
        );
        return { httpStatus: r.status, result: r.body?.result ?? null, errorMessagePresent: Boolean(r.body?.error_msg ?? r.body?.message) };
      } catch (err) {
        return { error: String(err?.name ?? err), timedOut: String(err?.name) === 'TimeoutError' };
      }
    };
    out.scanResult = await call('/rest/c/infra/ks/qr/scanResult', { channelType: 'UNKNOWN' });
    out.acceptResult = await call('/rest/c/infra/ks/qr/acceptResult', {
      sid: 'kuaishou.server.webday7',
      channelType: 'UNKNOWN',
    });
    out.flowNote = 'one poll each, no QR displayed/scanned, no login completed; token discarded';
  }
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------- optional QR login (experimental)
//
// The QR start/scan/accept/callback endpoints have been observed to answer
// WITHOUT __NS_hxfalcon (probe `qr-probe --flow`), but a real scan is required
// to prove the flow. This command keeps the whole session in memory, prints no
// cookie/token, and never writes a credential. It is here so an authorised
// operator with a phone can finish the verification; without a scan it stops
// at "waiting for scan" and discards everything.

const ID_HOST = 'https://id.kuaishou.com';
const LIVE_HOST = 'https://live.kuaishou.com';
const LIVE_SID = 'kuaishou.live.web';

function cookieLine(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(jar, res) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(';')[0] ?? '';
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function loginPost(jar, url, fields, referer, timeoutMs = 75000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': DESKTOP_UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/plain, */*',
      referer,
      origin: new URL(referer).origin,
      ...(jar.size ? { cookie: cookieLine(jar) } : {}),
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(timeoutMs),
  });
  absorbCookies(jar, res);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function saveQr(imageData) {
  if (!imageData) return null;
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = join(STATE_DIR, 'qr.png');
  await writeFile(path, Buffer.from(String(imageData), 'base64'), { mode: 0o600 });
  return path;
}

async function cmdLogin() {
  const waitSeconds = Math.max(30, Number(flag('--wait', '180')) || 180);
  const jar = new Map();
  const deadline = now() + waitSeconds * 1000;
  const out = {
    command: 'login',
    at: new Date().toISOString(),
    persisted: false,
    note: 'QR session is kept in memory only; no cookie, token or profile is written',
  };
  const start = () =>
    loginPost(
      jar,
      `${ID_HOST}/rest/c/infra/ks/qr/start`,
      { sid: 'kuaishou.server.webday7', channelType: 'UNKNOWN', isWebSig4: 'true' },
      'https://www.kuaishou.com/',
      20000,
    );

  let s = await start();
  if (s.body.result !== 1) {
    out.error = `qr/start result=${s.body.result ?? '?'}`;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  let token = String(s.body.qrLoginToken ?? '');
  let signature = String(s.body.qrLoginSignature ?? '');
  out.qrPng = await saveQr(s.body.imageData);
  out.expiresAt = s.body.expireTime ? new Date(Number(s.body.expireTime)).toISOString() : null;
  out.instructions = '打开 qrPng，用快手 App 扫码并确认；本命令不保存任何凭据';
  console.log(JSON.stringify({ ...out, stage: 'waiting_for_scan' }, null, 2));

  const scan = async () =>
    loginPost(
      jar,
      `${ID_HOST}/rest/c/infra/ks/qr/scanResult`,
      { qrLoginToken: token, qrLoginSignature: signature, channelType: 'UNKNOWN', isWebSig4: 'true' },
      'https://www.kuaishou.com/',
      70000,
    );

  let scanned = null;
  while (now() < deadline) {
    let r;
    try {
      r = await scan();
    } catch (err) {
      out.scanError = String(err?.name ?? err);
      await sleep(1000);
      continue;
    }
    if (r.body.result === 1) {
      scanned = r;
      break;
    }
    if (r.body.result === 707) {
      // QR expired before scan: get a new one (never after a scan).
      s = await start();
      if (s.body.result !== 1) break;
      token = String(s.body.qrLoginToken ?? '');
      signature = String(s.body.qrLoginSignature ?? '');
      out.qrPng = await saveQr(s.body.imageData);
      out.expiresAt = s.body.expireTime ? new Date(Number(s.body.expireTime)).toISOString() : null;
      out.qrRefreshed = (out.qrRefreshed ?? 0) + 1;
      console.log(JSON.stringify({ ...out, stage: 'waiting_for_scan' }, null, 2));
      continue;
    }
    if (r.body.result === 711 || r.body.result === 712) {
      out.error = `cancelled_on_phone result=${r.body.result}`;
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    await sleep(1000);
  }
  if (!scanned) {
    out.error = 'no scan within the wait window (not a platform failure)';
    out.stage = 'blocked_on_human_scan';
    jar.clear();
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  out.stage = 'scanned';

  const accept = await loginPost(
    jar,
    `${ID_HOST}/rest/c/infra/ks/qr/acceptResult`,
    { qrLoginToken: token, qrLoginSignature: signature, sid: 'kuaishou.server.webday7', channelType: 'UNKNOWN', isWebSig4: 'true' },
    'https://www.kuaishou.com/',
    70000,
  );
  if (accept.body.result !== 1) {
    out.error = `acceptResult result=${accept.body.result ?? '?'}`;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const qrToken = accept.body.qrToken ?? accept.body.qr_token;
  if (!qrToken) {
    out.error = 'acceptResult returned no qrToken';
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const cb = await loginPost(
    jar,
    `${ID_HOST}/pass/kuaishou/login/qr/callback`,
    { qrToken: String(qrToken), sid: 'kuaishou.server.webday7', channelType: 'UNKNOWN', isWebSig4: 'true' },
    'https://www.kuaishou.com/',
    30000,
  );
  const passToken = String(cb.body.passToken ?? jar.get('passToken') ?? '');
  out.callback = { httpStatus: cb.status, result: cb.body.result ?? null, hasPassToken: Boolean(passToken) };
  if (!passToken) {
    out.stage = 'callback_without_passToken';
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  out.stage = 'logged_in';

  // Live-site ticket exchange, still WITHOUT __NS_hxfalcon. This is the decisive
  // question: does the live gateway accept an unsigned, session-backed request?
  const pt = await loginPost(
    jar,
    `${ID_HOST}/pass/kuaishou/login/passToken`,
    { sid: LIVE_SID, channelType: 'UNKNOWN', encryptHeaders: '' },
    'https://live.kuaishou.com/',
    30000,
  );
  const authToken = String(pt.body?.[`${LIVE_SID}.at`] ?? jar.get(`${LIVE_SID}.at`) ?? '');
  out.passTokenLogin = {
    httpStatus: pt.status,
    result: pt.body?.result ?? null,
    hasAuthToken: Boolean(authToken),
  };
  if (authToken) {
    const res = await fetch(`${LIVE_HOST}/live_api/baseuser/userLogin`, {
      method: 'POST',
      headers: {
        'user-agent': DESKTOP_UA,
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        referer: 'https://live.kuaishou.com/',
        origin: LIVE_HOST,
        cookie: cookieLine(jar),
      },
      body: JSON.stringify({ userLoginInfo: { authToken, sid: LIVE_SID } }),
      signal: AbortSignal.timeout(20000),
    });
    absorbCookies(jar, res);
    const ulBody = await res.json().catch(() => ({}));
    out.userLogin = {
      httpStatus: res.status,
      result: ulBody?.data?.result ?? null,
      hasLiveSt: jar.has('kuaishou.live.web_st'),
      hasLivePh: jar.has('kuaishou.live.web_ph'),
    };
    const roomInput = flag('--room');
    const eid = parseRoomInput(roomInput);
    if (eid) {
      const status = await roomStatus(eid).catch(() => null);
      if (status?.liveStreamId) {
        const ws = await fetch(
          `${LIVE_HOST}/live_api/liveroom/websocketinfo?liveStreamId=${encodeURIComponent(status.liveStreamId)}`,
          {
            headers: {
              'user-agent': DESKTOP_UA,
              accept: 'application/json, text/plain, */*',
              referer: `https://live.kuaishou.com/u/${encodeURIComponent(eid)}`,
              cookie: cookieLine(jar),
            },
            signal: AbortSignal.timeout(20000),
          },
        );
        const wsBody = await ws.json().catch(() => ({}));
        const data = wsBody?.data ?? {};
        out.websocketInfo = {
          httpStatus: ws.status,
          result: data.result ?? null,
          hasToken: Boolean(data.token),
          hasWebsocketUrls: Array.isArray(data.websocketUrls) && data.websocketUrls.length > 0,
        };
      }
    }
  }

  // Best-effort passport logout, then wipe memory. Not persisted either way.
  try {
    await fetch(`${ID_HOST}/pass/kuaishou/login/logout`, {
      method: 'POST',
      headers: {
        'user-agent': DESKTOP_UA,
        'content-type': 'application/json',
        referer: 'https://live.kuaishou.com/',
        origin: LIVE_HOST,
        cookie: cookieLine(jar),
      },
      body: 'sid=kuaishou.live.web&channelType=UNKNOWN&encryptHeaders=',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    out.logout = 'not_confirmed';
  }
  jar.clear();
  console.log(JSON.stringify({ ...out, sessionWiped: true }, null, 2));
}

async function cmdAuth() {  let entries = [];
  try {
    entries = await readdir(STATE_DIR);
  } catch {
    entries = [];
  }
  console.log(
    JSON.stringify(
      {
        command: 'auth',
        at: new Date().toISOString(),
        loggedIn: false,
        sessionFound: entries.includes('session.json'),
        stateDir: 'research/kuaishou-g1/.state (gitignored; no credentials are written by this PoC)',
        mechanism: 'none',
        reason:
          'The login-state WebSocket needs a live-site session and the non-public __NS_hxfalcon signature. ' +
          'This PoC does not reimplement signatures, device fingerprints or captcha solving, and does not accept manually copied cookies.',
        options: ['anonymous H5 watch (implemented)', 'official QR login through a real browser (not implemented; needs separate approval)'],
      },
      null,
      2,
    ),
  );
}

async function cmdCleanup() {
  let removed = false;
  try {
    await rm(STATE_DIR, { recursive: true, force: true });
    removed = true;
  } catch {
    removed = false;
  }
  console.log(JSON.stringify({ command: 'cleanup', at: new Date().toISOString(), stateDir: STATE_DIR, removed }, null, 2));
}

async function cmdHelp() {
  console.log(`LiveMemory Kuaishou G1 research probe (anonymous only)

  discover [--limit 8]                 list live rooms from the public home list
  status --room <eid|url>              live/offline via public room page SSR
  watch --room <eid|url> ...           collect anonymous H5 chat aggregates
        [--seconds 120] [--interval 3200] [--out file.json]
  ws-anon --room <eid|url>             one unsigned websocketinfo request (records rejection)
  qr-probe [--flow]                    one unsigned QR-start request; --flow adds one scan/accept poll
  login [--room <eid|url>] [--wait 180] QR login + in-memory live-session probe (needs a phone scan)
  auth                                 show that no login session is configured
  cleanup                              delete the local .state directory

No login, no cookies, no signature, no captcha solving, no chat persistence.
`);
}

const commands = {
  discover: cmdDiscover,
  status: cmdStatus,
  watch: cmdWatch,
  'ws-anon': cmdWsAnon,
  'qr-probe': cmdQrProbe,
  login: cmdLogin,
  auth: cmdAuth,
  cleanup: cmdCleanup,
  help: cmdHelp,
};

const run = commands[command];
if (!run) {
  console.error(`unknown command: ${command}`);
  await cmdHelp();
  process.exit(2);
}
try {
  await run();
} catch (err) {
  console.error(JSON.stringify({ command, error: String(err?.message ?? err) }));
  process.exit(1);
}
