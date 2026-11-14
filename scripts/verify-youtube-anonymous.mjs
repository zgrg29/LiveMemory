import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';

/**
 * Real-network E2E check for the YouTube public-web live chat.
 *
 *   node scripts/verify-youtube-anonymous.mjs <live-url> [seconds]
 *
 * It starts the real local server, checks the link, records for the requested
 * duration, then reads the session
 * back through the HTTP read models. It prints aggregates only (no chat bodies,
 * names or channel ids) and uses a private tests/.tmp data folder.
 *
 * This path is unofficial. The script does not claim that it is endorsed by
 * YouTube; it exists to measure whether the current public page still works.
 */

const url = String(process.argv[2] ?? '');
const seconds = Math.max(5, Number(process.argv[3] ?? 60));
const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));

function jsonRequest(target, {method = 'GET', body} = {}) {
  return fetch(target, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function main() {
  if (!url) throw new Error('usage: node scripts/verify-youtube-anonymous.mjs <live-url> [seconds]');
  const dataDir = join(root, `yt-anon-verify-${Date.now()}`);
  mkdirSync(dataDir, {recursive: true});
  const server = await startServer({auth: false, dataDir, port: 0, systemLocale: 'en'});
  const base = server.url;
  const result = {
    input: url,
    requestedSeconds: seconds,
    startedAt: new Date().toISOString(),
    dataDir,
    mode: 'web'
  };
  let session = null;
  try {
    const statusBefore = await (await fetch(`${base}api/youtube/status`)).json();
    result.status = {
      mode: statusBefore.mode,
      requiresApiKey: statusBefore.capabilities?.requiresApiKey === true,
      requiresLogin: statusBefore.capabilities?.requiresLogin === true
    };

    const checkResponse = await jsonRequest(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url}
    });
    const checkPayload = await checkResponse.json();
    if (checkResponse.status !== 200) throw new Error(`check failed: ${checkResponse.status} ${JSON.stringify(checkPayload)}`);
    result.video = {
      videoId: checkPayload.video.videoId,
      state: checkPayload.video.state,
      recordable: checkPayload.video.recordable,
      reason: checkPayload.video.reason,
      titlePresent: Boolean(checkPayload.video.title),
      channelPresent: Boolean(checkPayload.video.channelTitle),
      concurrentViewers: checkPayload.video.concurrentViewers
    };
    if (!checkPayload.video.recordable) {
      result.ok = false;
      result.error = checkPayload.video.reason ?? 'not-recordable';
      return;
    }

    const connectResponse = await jsonRequest(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url}
    });
    const connectPayload = await connectResponse.json();
    if (connectResponse.status !== 201) throw new Error(`connect failed: ${connectResponse.status} ${JSON.stringify(connectPayload)}`);
    session = connectPayload.session;
    result.sessionId = session.id;
    result.connectedAt = new Date().toISOString();

    const deadline = Date.now() + seconds * 1000;
    let lastDetail = null;
    let lastState = null;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 2000));
      const status = await (await fetch(`${base}api/youtube/status`)).json();
      lastDetail = status.connection?.detail ?? lastDetail;
      lastState = status.connection?.state ?? lastState;
      const current = await (await fetch(`${base}api/sessions/current`)).json();
      if (!current.session) break;
    }

    const finalStatus = await (await fetch(`${base}api/youtube/status`)).json();
    const detail = finalStatus.connection?.detail ?? lastDetail ?? {};
    const eventsPayload = await (await fetch(`${base}api/events?sessionId=${encodeURIComponent(session.id)}&limit=500`)).json();
    const events = eventsPayload.events ?? [];
    const messages = events.filter((event) => event.type === 'chat' || event.type === 'super_chat');
    const chat = events.filter((event) => event.type === 'chat');
    const identity = messages.filter((event) => event.viewerId).length;
    const chatIdentity = chat.filter((event) => event.viewerId).length;
    const badges = events.filter((event) => Array.isArray(event.badges) && event.badges.length > 0).length;
    const paid = events.filter((event) => event.isPaid);
    const withAmount = paid.filter((event) => Number.isFinite(event.amountMinor) && event.amountMinor !== null);
    const currencies = {};
    for (const event of withAmount) {
      const key = `${event.currency}:${event.amountMinor}`;
      currencies[key] = (currencies[key] ?? 0) + 1;
    }
    const byType = {};
    for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;

    result.connection = {
      finalState: finalStatus.connection?.state ?? lastState,
      actionsSeen: detail.actionsSeen ?? null,
      drafts: detail.messagesSeen ?? null,
      identityCompleteDrafts: detail.identityComplete ?? null,
      failures: detail.failures ?? null,
      pollCount: detail.pollCount ?? null,
      lastErrorCode: detail.errorCode ?? null,
      endReason: detail.endReason ?? null
    };
    result.storage = {
      events: events.length,
      byType,
      messages: messages.length,
      chat: chat.length,
      withChannelId: identity,
      identityRatio: messages.length > 0 ? Number((identity / messages.length).toFixed(4)) : null,
      chatWithChannelId: chatIdentity,
      chatIdentityRatio: chat.length > 0 ? Number((chatIdentity / chat.length).toFixed(4)) : null,
      withBadges: badges,
      paidEvents: paid.length,
      paidWithParsedAmount: withAmount.length,
      amounts: currencies,
      duplicatesSkipped: detail.messagesSeen !== null ? Math.max(0, detail.messagesSeen - events.length) : null
    };

    if (finalStatus.recording !== 'idle' || (await (await fetch(`${base}api/sessions/current`)).json()).session) {
      const stopResponse = await jsonRequest(`${base}api/youtube/disconnect`, {method: 'POST'});
      result.stopStatus = stopResponse.status;
    }
    const summary = await (await fetch(`${base}api/sessions/${encodeURIComponent(session.id)}`)).json();
    result.session = {
      status: summary.session?.status ?? null,
      messages: summary.stats?.messages ?? null,
      activeViewers: summary.stats?.activeViewers ?? null,
      paymentEvents: summary.stats?.paymentEvents ?? null,
      support: summary.support ?? []
    };
    result.ok = true;
    result.finishedAt = new Date().toISOString();
  } finally {
    await server.close();
    console.log(JSON.stringify(result, null, 2));
    if (process.env.KEEP_YT_TEST_DATA !== '1') rmSync(dataDir, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ok: false, error: error?.stack ?? String(error)}, null, 2));
  process.exitCode = 1;
});
