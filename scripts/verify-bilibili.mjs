import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';

/**
 * End-to-end check of the Bilibili path through the real HTTP API:
 * check room -> connect -> live events -> SQLite -> console read models -> stop.
 *
 *   node scripts/verify-bilibili.mjs [roomId] [seconds]
 *
 * It uses a private data folder under tests/.tmp and never prints message bodies
 * or credentials. Requires internet access to Bilibili.
 */

const roomInput = String(process.argv[2] ?? '5050');
const seconds = Number(process.argv[3] ?? 20);
const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));

function jsonRequest(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function main() {
  const dataDir = join(root, `bili-verify-${Date.now()}`);
  mkdirSync(dataDir, {recursive: true});
  const server = await startServer({dataDir, port: 0, systemLocale: 'en'});
  const base = server.url;
  const results = [];
  let session = null;
  try {
    const statusBefore = await (await fetch(`${base}api/bilibili/status`)).json();
    results.push(['status before', `loggedIn=${statusBefore.login.loggedIn} state=${statusBefore.connection.state}`]);

    const roomResponse = await jsonRequest(`${base}api/bilibili/room`, {method: 'POST', body: {roomId: roomInput}});
    const roomPayload = await roomResponse.json();
    if (roomResponse.status !== 200) throw new Error(`room check failed: ${roomResponse.status} ${JSON.stringify(roomPayload)}`);
    results.push(['room check', `${roomPayload.room.inputRoomId} -> ${roomPayload.room.roomId} live=${roomPayload.room.liveStatus}`]);

    const connectResponse = await jsonRequest(`${base}api/bilibili/connect`, {method: 'POST', body: {roomId: roomInput}});
    const connectPayload = await connectResponse.json();
    if (connectResponse.status !== 201) throw new Error(`connect failed: ${connectResponse.status} ${JSON.stringify(connectPayload)}`);
    session = connectPayload.session;
    results.push(['connected', `session=${session.id} platform=${session.platform} room=${session.platformRoomId}`]);

    let current = null;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 2000));
      const payload = await (await fetch(`${base}api/sessions/current`)).json();
      current = payload.session;
      if (current && current.stats.messages >= 3) break;
    }
    results.push(['live stats', current ? `messages=${current.stats.messages} viewers=${current.stats.activeViewers} payments=${current.stats.paymentEvents}` : 'no current session']);

    const eventsPayload = await (await fetch(`${base}api/events?sessionId=${encodeURIComponent(session.id)}&limit=50`)).json();
    const events = eventsPayload.events ?? [];
    const withIdentity = events.filter((event) => event.viewerId).length;
    const types = [...new Set(events.map((event) => event.type))];
    results.push(['events in db', `${events.length} rows, ${withIdentity} with a viewer id, types=${types.join(',') || 'none'}`]);
    const sample = events.find((event) => event.type === 'chat');
    if (sample) {
      results.push(['sample chat', `uid=${sample.viewerId} name=${sample.displayName} occurredAt=${sample.occurredAt} quality=${sample.sourceQuality}`]);
    }

    const viewersPayload = await (await fetch(`${base}api/viewers?limit=20`)).json();
    const viewers = viewersPayload.viewers ?? [];
    results.push(['viewer profiles', `${viewers.length} rows`]);
    const withUid = viewers.filter((viewer) => viewer.platformUid).length;
    results.push(['viewer identity', `${withUid}/${viewers.length} have a platform uid`]);

    const stopResponse = await jsonRequest(`${base}api/bilibili/disconnect`, {method: 'POST'});
    const stopPayload = await stopResponse.json();
    results.push(['disconnect', `status=${stopResponse.status} stopped=${stopPayload.stopped} sessionStatus=${stopPayload.session?.status}`]);

    const after = await (await fetch(`${base}api/sessions/${encodeURIComponent(session.id)}`)).json();
    results.push(['session summary', `status=${after.session?.status ?? after.session?.session?.status} messages=${after.stats?.messages ?? after.session?.stats?.messages} viewers=${after.stats?.activeViewers ?? after.session?.stats?.activeViewers}`]);
  } finally {
    await server.close();
    const line = results.map(([name, value]) => `  ${name.padEnd(16)} ${value}`).join('\n');
    console.log(`Bilibili end-to-end (room ${roomInput}, ${seconds}s, data ${dataDir})\n${line}`);
    if (process.env.KEEP_BILI_TEST_DATA !== '1') rmSync(dataDir, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error('verification failed:', error?.stack ?? error);
  process.exitCode = 1;
});
