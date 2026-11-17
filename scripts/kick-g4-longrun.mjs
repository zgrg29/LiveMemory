#!/usr/bin/env node
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {KickHttp} from '../src/platforms/kick/http.mjs';

/**
 * Kick G4 long capture through the real product stack.
 *
 * Starts the actual LiveMemory server (isolated data directory), adds two real
 * live Kick rooms through `/api/kick/connect`, records for the requested
 * minutes, and reports database + adapter evidence: message counts, identity
 * coverage, duplicates, reconnects, token refreshes and stop behaviour.
 *
 * This is not a mock: it uses the same routes, service, adapter, SessionManager
 * and SQLite the EXE uses. No user data directory is touched.
 */

const DEFAULT_MINUTES = 65;

function parseArgs(argv) {
  const args = {minutes: DEFAULT_MINUTES, out: 'tests/.tmp/kick-g4', rooms: []};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--minutes') args.minutes = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = String(argv[++i]);
    else if (argv[i] === '--rooms') args.rooms = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Number.isFinite(args.minutes) || args.minutes <= 0) throw new Error('--minutes must be positive');
  return args;
}

async function discover(limit = 4) {
  const http = new KickHttp({timeoutMs: 20000});
  try {
    const response = await http.requestJson('https://web.kick.com/api/v1/livestreams/featured?language=en');
    const streams = response.data?.data?.livestreams ?? [];
    return streams
      .filter((entry) => entry?.channel?.slug)
      .sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0))
      .slice(0, limit)
      .map((entry) => entry.channel.slug);
  } finally {
    await http.close();
  }
}

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body ?? {})
  });
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  mkdirSync(outDir, {recursive: true});
  const dataDir = join(outDir, 'data');
  mkdirSync(dataDir, {recursive: true});

  const rooms = args.rooms.length > 0 ? args.rooms.slice(0, 2) : (await discover(2));
  if (rooms.length === 0) throw new Error('no live Kick rooms found');
  console.log(`[rooms] ${rooms.join(', ')}`);

  const server = await startServer({dataDir, port: 0, auth: false, systemLocale: 'en'});
  console.log(`[server] ${server.url}`);
  const base = server.url;
  const startedAt = Date.now();
  const connected = [];
  const replacements = [];
  const timeline = [];

  const connect = async (slug) => {
    const response = await post(base, 'api/kick/connect', {url: `https://kick.com/${slug}`});
    const payload = await response.json();
    if (response.status !== 201) {
      console.error(`[connect-failed] ${slug} ${response.status} ${JSON.stringify(payload.error ?? payload)}`);
      return null;
    }
    const row = {slug, sessionId: payload.session.id, connectedAt: nowIso(), room: payload.room};
    connected.push(row);
    console.log(`[connected] ${slug} session=${row.sessionId} channel=${payload.session?.platformRoomId}`);
    return row;
  };

  for (const slug of rooms) await connect(slug);

  const endAt = startedAt + args.minutes * 60000;
  let replacementTried = new Set(rooms);
  while (Date.now() < endAt) {
    await new Promise((r) => setTimeout(r, 30000));
    const status = await (await fetch(`${base}api/kick/status`)).json();
    const rows = (status.recordings ?? []).map((recording) => ({
      slug: recording.meta?.slug ?? recording.platformRoomId,
      sessionId: recording.sessionId,
      state: recording.connection?.state ?? null,
      category: recording.capture?.category ?? null,
      messages: recording.capture?.counters?.chats ?? 0,
      gifts: recording.capture?.counters?.gifts ?? 0,
      memberships: recording.capture?.counters?.memberships ?? 0,
      reconnects: recording.capture?.counters?.reconnects ?? 0,
      tokenRefreshes: recording.capture?.counters?.tokenRefreshes ?? 0,
      lastEventAt: recording.capture?.lastEventAt ?? null
    }));
    timeline.push({at: nowIso(), rows});
    console.log(`[status] ${nowIso()} ${JSON.stringify(rows)}`);

    // If a room ended (stream offline), try one replacement so the run still
    // covers the full window. Every segment is reported separately.
    const activeSlugs = new Set(rows.filter((row) => ['connected', 'reconnecting', 'connecting'].includes(row.state)).map((row) => row.slug));
    if (rows.length < 2 && activeSlugs.size < 2) {
      const candidates = (await discover(6)).filter((slug) => !replacementTried.has(slug));
      if (candidates.length > 0) {
        replacementTried.add(candidates[0]);
        const replacement = await connect(candidates[0]);
        if (replacement) replacements.push(replacement);
      }
    }
  }

  const finalStatus = await (await fetch(`${base}api/kick/status`)).json();
  const db = server.db;
  const sessions = db.prepare("SELECT * FROM sessions WHERE platform = 'kick' ORDER BY started_at").all();
  const perSession = sessions.map((session) => {
    const counts = db.prepare(`SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN event_type = 'chat' THEN 1 ELSE 0 END) AS chats,
        SUM(CASE WHEN event_type = 'gift' THEN 1 ELSE 0 END) AS gifts,
        SUM(CASE WHEN event_type = 'membership' THEN 1 ELSE 0 END) AS memberships,
        SUM(CASE WHEN viewer_uid IS NOT NULL AND event_type = 'chat' THEN 1 ELSE 0 END) AS chats_with_uid,
        SUM(CASE WHEN external_id IS NOT NULL AND event_type = 'chat' THEN 1 ELSE 0 END) AS chats_with_msg_id
      FROM events WHERE session_id = ?`).get(session.id);
    const dupes = db.prepare('SELECT COUNT(*) AS n FROM (SELECT external_id FROM events WHERE session_id = ? AND external_id IS NOT NULL GROUP BY external_id HAVING COUNT(*) > 1)').get(session.id).n;
    const missingOccurred = db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND occurred_at IS NULL').get(session.id).n;
    return {
      sessionId: session.id,
      platformRoomId: session.platform_room_id,
      roomTitle: session.room_title,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      status: session.status,
      messages: Number(session.message_count ?? 0),
      giftEvents: Number(session.gift_event_count ?? 0),
      paymentEvents: Number(session.payment_event_count ?? 0),
      uniqueViewers: Number(session.unique_viewer_count ?? 0),
      unidentifiedMessages: Number(session.unidentified_message_count ?? 0),
      events: Number(counts.events ?? 0),
      chats: Number(counts.chats ?? 0),
      gifts: Number(counts.gifts ?? 0),
      memberships: Number(counts.memberships ?? 0),
      chatsWithUid: Number(counts.chats_with_uid ?? 0),
      chatsWithMessageId: Number(counts.chats_with_msg_id ?? 0),
      duplicateExternalIds: Number(dupes ?? 0),
      eventsMissingOccurredAt: Number(missingOccurred ?? 0)
    };
  });
  const viewerIdentity = db.prepare(`SELECT COUNT(DISTINCT viewer_uid) AS n FROM events WHERE platform = 'kick' AND viewer_uid IS NOT NULL`).get().n;

  // Stop everything through the product API, then confirm no recording remains.
  const stopped = [];
  for (const row of connected) {
    const response = await post(base, 'api/kick/disconnect', {sessionId: row.sessionId});
    const payload = await response.json();
    stopped.push({slug: row.slug, sessionId: row.sessionId, status: response.status, stopped: payload.stopped});
  }
  const afterStop = await (await fetch(`${base}api/kick/status`)).json();
  const sessionsAfterStop = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE platform = 'kick' AND status = 'live'").get().n;

  const result = {
    tool: 'kick-g4-longrun',
    generatedAt: nowIso(),
    startedAt: new Date(startedAt).toISOString(),
    plannedMinutes: args.minutes,
    actualMinutes: Math.round((Date.now() - startedAt) / 60000),
    dataDir,
    roomsRequested: rooms,
    connected,
    replacements,
    perSession,
    totalChats: perSession.reduce((sum, row) => sum + row.chats, 0),
    totalGifts: perSession.reduce((sum, row) => sum + row.gifts, 0),
    totalMemberships: perSession.reduce((sum, row) => sum + row.memberships, 0),
    distinctViewerUids: Number(viewerIdentity ?? 0),
    timeline,
    finalStatus: {
      recordings: finalStatus.recordings?.length ?? 0,
      capture: finalStatus.capture ?? null
    },
    stopped,
    liveSessionsAfterStop: Number(sessionsAfterStop ?? 0),
    afterStopRecordings: afterStop.recordings?.length ?? 0
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log('\n=== G4 summary ===');
  for (const row of perSession) {
    console.log(`${row.platformRoomId}: chats=${row.chats} uid=${row.chatsWithUid}/${row.chats} msgId=${row.chatsWithMessageId}/${row.chats} ` +
      `gifts=${row.gifts} memberships=${row.memberships} dupIds=${row.duplicateExternalIds} viewers=${row.uniqueViewers}`);
  }
  console.log(`totalChats=${result.totalChats} gifts=${result.totalGifts} memberships=${result.totalMemberships}`);
  console.log(`liveSessionsAfterStop=${result.liveSessionsAfterStop} recordingsAfterStop=${result.afterStopRecordings}`);
  console.log(`summary: ${join(outDir, 'summary.json')}`);

  await server.close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('[fatal]', error?.stack ?? error);
  process.exit(1);
});
