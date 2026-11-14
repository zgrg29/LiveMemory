import {createServer} from 'node:http';
import {readFileSync, mkdirSync, rmSync, openSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/**
 * RC0 P0-4 packaged replay (asInvoker EXE, local fake YouTube).
 *
 * This is NOT a real YouTube test and NOT a UAC double-click test. It verifies
 * that the shipped binary keeps one live session through a three-minute
 * transport outage, resumes the same session, dedupes replayed messages, and
 * ends only after an explicit ended watch page.
 *
 * RC0 P0-5: the EXE is asInvoker; the script exchanges the launcher's one-time
 * fragment token for a session cookie, then uses the same authenticated API as
 * the browser.
 *
 * Usage: node scripts/verify-youtube-lifecycle-exe.mjs
 */

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const distExe = join(root, 'dist', 'LiveMemory.exe');
const workRoot = join(root, 'tests', '.tmp', `p04-exe-${Date.now()}`);
mkdirSync(workRoot, {recursive: true});
const dataDir = join(workRoot, 'data');
const bootstrapFile = join(workRoot, 'bootstrap.url');
const exe = distExe;
const videoId = 'anonP04EXE1';
let cookie = null;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  return fetch(input, {...init, headers});
}

function log(line) {
  process.stdout.write(`[p04-exe] ${line}\n`);
}

async function waitFor(check, {timeout = 30000, interval = 500, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

const CONFIG = {
  INNERTUBE_API_KEY: 'AIzaFAKE_WEB_KEY',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20990101.00.00',
      gl: 'US',
      hl: 'en',
      visitorData: 'VISITOR_P04_EXE'
    }
  }
};

function textRenderer(id, text, channelId) {
  return {
    liveChatTextMessageRenderer: {
      id,
      timestampUsec: String((Date.now() + Number(id.replace(/\D/g, '') || 0)) * 1000),
      authorName: {simpleText: channelId},
      authorExternalChannelId: channelId,
      authorBadges: [],
      message: {runs: [{text}]}
    }
  };
}

function watchHtml(state) {
  const ended = state.watchState === 'ended';
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId,
      title: 'P0-4 packaged lifecycle replay',
      author: 'P0-4 Channel',
      channelId: 'UC_P04_CHANNEL',
      isLive: !ended,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: !ended,
          startTimestamp: '2026-11-14T01:00:00.000Z',
          ...(ended ? {endTimestamp: '2026-11-14T02:00:00.000Z'} : {})
        }
      }
    }
  };
  return `<html><script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script></html>`;
}

function chatHtml(state) {
  const replay = state.openCount > 1 ? [textRenderer('msg-1', 'replayed message', 'UC_P04_A')] : [];
  const initial = {
    contents: {
      liveChatRenderer: {
        continuations: [{invalidationContinuationData: {continuation: 'CONT-0', timeoutMs: 1000}}],
        actions: replay
      }
    }
  };
  return `<html><script>ytcfg.set(${JSON.stringify(CONFIG)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></html>`;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)});
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(body);
}

function createFakeWeb() {
  const state = {
    watchState: 'live',
    pollMode: 'normal',
    pollCount: 0,
    openCount: 0,
    producedIds: new Set()
  };
  let server = null;
  let port = null;

  function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/watch') {
      return html(res, watchHtml(state));
    }
    if (req.method === 'GET' && url.pathname === '/live_chat') {
      state.openCount += 1;
      return html(res, chatHtml(state));
    }
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      state.pollCount += 1;
      if (state.pollMode === 'invalid') return json(res, 200, {});
      if (state.pollMode === 'stale') {
        state.pollMode = 'normal';
        return json(res, 400, {error: {code: 400}});
      }
      const id = `msg-${state.pollCount}`;
      state.producedIds.add(id);
      return json(res, 200, {
        continuationContents: {
          liveChatContinuation: {
            continuations: [{invalidationContinuationData: {continuation: `CONT-${state.pollCount}`, timeoutMs: 1000}}],
            actions: [{
              addChatItemAction: {
                item: textRenderer(id, `message ${state.pollCount}`, state.pollCount % 2 ? 'UC_P04_A' : 'UC_P04_B')
              }
            }]
          }
        }
      });
    }
    return json(res, 404, {error: {code: 404}});
  }

  return {
    state,
    get port() { return port; },
    async start(fixedPort = null) {
      server = createServer(handler);
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(fixedPort ?? 0, '127.0.0.1', resolvePromise);
      });
      port = server.address().port;
      return port;
    },
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(resolvePromise));
      server = null;
    }
  };
}

function readBuildInfo() {
  return JSON.parse(readFileSync(join(root, 'build', 'build-info.json'), 'utf8'));
}

async function main() {
  const buildInfo = readBuildInfo();
  const fake = createFakeWeb();
  const fakePort = await fake.start();
  log(`fake YouTube on 127.0.0.1:${fakePort}`);

  const port = 48471;
  const base = `http://127.0.0.1:${port}`;
  const stdoutFile = join(workRoot, 'stdout.log');
  const stderrFile = join(workRoot, 'stderr.log');
  const child = spawn(exe, ['--no-open', '--port', String(port), '--data-dir', dataDir], {
    cwd: workRoot,
    env: {
      ...process.env,
      LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile,
      LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE: `http://127.0.0.1:${fakePort}`
    },
    stdio: ['ignore', openSync(stdoutFile, 'w'), openSync(stderrFile, 'w')],
    windowsHide: true
  });
  let exit = null;
  child.on('exit', (code, signal) => { exit = {code, signal}; });

  const cleanup = async () => {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(500);
    await fake.stop().catch(() => {});
  };

  try {
    const health = await waitFor(async () => {
      if (exit) throw new Error(`EXE exited early: ${JSON.stringify(exit)} ${readFileSync(stderrFile, 'utf8')}`);
      try {
        const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(1500)});
        return response.ok ? response.json() : null;
      } catch {
        return null;
      }
    }, {timeout: 45000, label: 'EXE health'});
    if (health.buildId !== buildInfo.buildId) {
      throw new Error(`buildId mismatch: EXE ${health.buildId} vs build-info ${buildInfo.buildId}`);
    }
    log(`EXE healthy buildId=${health.buildId} commit=${health.commit}`);

    const browserUrl = await waitFor(() => {
      if (!existsSync(bootstrapFile)) return null;
      const text = readFileSync(bootstrapFile, 'utf8').trim();
      return text || null;
    }, {timeout: 15000, label: 'bootstrap URL'});
    const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
    const exchange = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token: decodeURIComponent(token)})
    });
    if (exchange.status !== 200) throw new Error(`auth exchange failed: ${exchange.status} ${await exchange.text()}`);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0];
    if (!cookie.startsWith('lm_session=')) throw new Error('auth exchange returned no session cookie');
    log('authenticated browser session established');

    const connected = await apiFetch(`${base}/api/youtube/connect`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: `https://youtu.be/${videoId}`})
    });
    if (connected.status !== 201) throw new Error(`connect failed: ${connected.status} ${await connected.text()}`);
    const connectedBody = await connected.json();
    const sessionId = connectedBody.session.id;
    log(`session ${sessionId}`);

    const summary = async () => (await (await apiFetch(`${base}/api/sessions/${sessionId}`)).json());
    const events = async () => (await (await apiFetch(`${base}/api/events?sessionId=${sessionId}&limit=500`)).json()).events ?? [];

    await waitFor(async () => (await summary()).stats.messages >= 3, {timeout: 20000, label: 'initial messages'});
    const beforeOutage = await summary();
    log(`before outage: messages=${beforeOutage.stats.messages} viewers=${beforeOutage.stats.activeViewers}`);

    // Real transport outage: the fake YouTube server stops listening for 180 s.
    await fake.stop();
    log('fake YouTube stopped; waiting 180 s (simulated network outage)');
    const outageStart = Date.now();
    while (Date.now() - outageStart < 180000) {
      const current = await summary();
      if (current.session.status !== 'live') {
        throw new Error(`session ended during outage: ${current.session.status}/${current.session.endReason}`);
      }
      await sleep(5000);
    }
    const outageElapsed = Date.now() - outageStart;
    const duringOutage = await summary();
    if (duringOutage.stats.messages !== beforeOutage.stats.messages) {
      throw new Error(`messages changed during outage: ${beforeOutage.stats.messages} -> ${duringOutage.stats.messages}`);
    }
    log(`outage lasted ${outageElapsed} ms; session still live, messages=${duringOutage.stats.messages}`);

    await fake.start(fakePort);
    log('fake YouTube restarted; waiting for reconnect');
    await waitFor(async () => {
      const response = await apiFetch(`${base}/api/youtube/status`);
      const status = await response.json();
      return status.connection.state === 'connected' ? status : null;
    }, {timeout: 150000, interval: 1000, label: 'reconnect'});
    await waitFor(async () => (await summary()).stats.messages > beforeOutage.stats.messages, {
      timeout: 30000,
      label: 'new messages after reconnect'
    });
    const recovered = await summary();
    if (recovered.session.id !== sessionId) throw new Error('session changed after reconnect');
    log(`recovered: messages=${recovered.stats.messages} viewers=${recovered.stats.activeViewers}`);

    // Force a stale continuation; the chat page replays msg-1. Dedupe must hold.
    fake.state.pollMode = 'stale';
    await waitFor(async () => (await summary()).stats.messages > recovered.stats.messages, {
      timeout: 30000,
      label: 'message after stale reopen'
    });
    const afterReplay = await summary();
    const rows = await events();
    const unique = new Set(rows.map((row) => `${row.type}:${row.content}:${row.occurredAt}`));
    if (rows.length !== afterReplay.stats.eventCount) {
      throw new Error(`event count mismatch: rows=${rows.length} session=${afterReplay.stats.eventCount}`);
    }
    if (unique.size !== rows.length) {
      throw new Error('replayed message inserted twice');
    }
    log(`after stale replay: rows=${rows.length}, unique=${unique.size}, session=${afterReplay.session.id}`);

    // Explicit platform end: invalid chat response + ended watch page.
    const beforeEnd = await summary();
    fake.state.pollMode = 'invalid';
    fake.state.watchState = 'ended';
    const ended = await waitFor(async () => {
      const current = await summary();
      return current.session.status === 'ended' ? current : null;
    }, {timeout: 30000, interval: 500, label: 'confirmed platform end'});
    if (ended.session.endReason !== 'platform_ended') {
      throw new Error(`unexpected end reason: ${ended.session.endReason}`);
    }
    if (ended.session.platformStatus !== 'ended') {
      throw new Error(`unexpected platform status: ${ended.session.platformStatus}`);
    }
    if (ended.stats.eventCount !== beforeEnd.stats.eventCount) {
      throw new Error('events changed while ending');
    }
    const sessions = await (await apiFetch(`${base}/api/sessions?limit=20`)).json();
    const sameRoom = sessions.sessions.filter((row) => row.platformRoomId === videoId);
    if (sameRoom.length !== 1) throw new Error(`expected one session row, saw ${sameRoom.length}`);
    log(`ended: reason=${ended.session.endReason} platform=${ended.session.platformStatus} messages=${ended.stats.messages}`);
    log(`buildId=${health.buildId} commit=${health.commit} PASS`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
