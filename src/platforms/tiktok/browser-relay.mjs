import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {decodeWebcastResponse, mapTikTokMessage} from './messages.mjs';

/**
 * Experimental browser relay ("transport B").
 *
 * TikTok's own web player is the only local client that can receive live events
 * without a third-party signer. This module launches the user's installed
 * Chrome/Edge with a dedicated LiveMemory profile, opens the official live page
 * and reads the WebSocket frames that the official page itself receives.
 *
 * It does not forge signatures, solve captchas, disable browser security or
 * inject stealth scripts. If TikTok's own page asks the visitor to log in
 * (`POST /webcast/room/enter/` answers 403 while the page is anonymous), the
 * relay reports `TIKTOK_LOGIN_REQUIRED` instead of pretending to record.
 *
 * Verification status: the browser window, the CDP session and the page's
 * WebSocket are real (see the research notes), but logged-in chat delivery has
 * NOT been verified because no TikTok account was available. Treat transport B
 * as experimental until a logged-in capture is recorded.
 */

const BROWSER_MARKER = '.livememory-owned';
const MAX_SEEN_IDS = 5000;

export function findBrowserExecutable({platform = process.platform, env = process.env, fileExists = existsSync} = {}) {
  const candidates = [];
  const add = (path) => {
    if (path) candidates.push(path);
  };
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'];
    const localAppData = env.LOCALAPPDATA;
    add(programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(programFilesX86 ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null);
    add(programFiles ? join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
    add(programFilesX86 ? join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
    add(localAppData ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null);
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/microsoft-edge');
    add('/usr/bin/chromium');
  }
  for (const candidate of candidates) {
    try {
      if (fileExists(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function buildBrowserArgs({profileDir, liveUrl}) {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-mode',
    '--window-size=1280,900',
    liveUrl
  ];
}

export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const port = Number(lines[0]);
  const wsPath = String(lines[1] ?? '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!wsPath.startsWith('/devtools/browser/')) return null;
  return {port, wsPath};
}

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
export class CdpClient {
  constructor({url, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000} = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = true;
  }

  async open() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    this.closed = false;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#rejectAll(new Error('cdp closed')));
    ws.addEventListener('error', () => this.#rejectAll(new Error('cdp error')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp open timeout')), this.timeoutMs);
      timer.unref?.();
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, {once: true});
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('cdp open failed'));
      }, {once: true});
    });
    return this;
  }

  #rejectAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #onMessage(event) {
    let message;
    try {
      const raw = typeof event?.data === 'string' ? event.data : String(event?.data ?? '');
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error('cdp error'), {code: 'CDP_ERROR', details: message.error}));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message?.method) {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch {
          /* listener errors must not break the protocol */
        }
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, {sessionId = null, timeoutMs = this.timeoutMs} = {}) {
    if (this.closed || !this.ws) return Promise.reject(new Error('cdp closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {resolve, reject, timer});
      const payload = {id, method, params};
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

/** Frame payloads arrive base64-encoded; chat frames are gzip protobuf. */
export function decodeFramePayload(base64) {
  const buffer = Buffer.from(String(base64 ?? ''), 'base64');
  if (buffer.length === 0) return [];
  const attempts = [buffer];
  try {
    attempts.push(gunzipSync(buffer));
  } catch {
    /* not gzip */
  }
  for (const candidate of attempts) {
    try {
      const decoded = decodeWebcastResponse(candidate);
      if (decoded.messages.length > 0) return decoded.messages;
    } catch {
      /* try next */
    }
  }
  return [];
}

/**
 * One browser session per recording. The adapter below owns the lifecycle; this
 * class only manages the browser/CDP handle.
 */
export class BrowserSession {
  constructor({uniqueId, roomId, liveUrl, dataDir, logger = null, now = Date.now, spawnImpl = spawn, WebSocketImpl = globalThis.WebSocket, launchTimeoutMs = 25000, loginWaitMs = 20000} = {}) {
    this.uniqueId = uniqueId;
    this.roomId = roomId;
    this.liveUrl = liveUrl;
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.spawnImpl = spawnImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.launchTimeoutMs = launchTimeoutMs;
    this.loginWaitMs = loginWaitMs;
    this.child = null;
    this.cdp = null;
    this.sessionId = null;
    this.profileDir = null;
    this.roomEnterStatus = null;
    this.frameCount = 0;
    this.decodedCount = 0;
    this.onFrame = () => {};
  }

  async launch() {
    const executable = findBrowserExecutable();
    if (!executable) {
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_UNAVAILABLE, {
        messageKey: 'errors.tiktokBrowserUnavailable',
        httpStatus: 503,
        details: {reason: 'browser_not_found'}
      });
    }
    const base = this.dataDir ?? join(process.env.TEMP ?? '.', 'livememory');
    this.profileDir = join(base, 'browser', 'tiktok', String(this.uniqueId).replace(/[^A-Za-z0-9._-]/g, '_'));
    mkdirSync(this.profileDir, {recursive: true});
    writeFileSync(join(this.profileDir, BROWSER_MARKER), 'LiveMemory dedicated TikTok browser profile\n');
    const args = buildBrowserArgs({profileDir: this.profileDir, liveUrl: this.liveUrl});
    this.child = this.spawnImpl(executable, args, {detached: true, stdio: 'ignore'});
    this.child?.unref?.();

    const portFile = join(this.profileDir, 'DevToolsActivePort');
    const deadline = this.now() + this.launchTimeoutMs;
    let parsed = null;
    while (this.now() < deadline) {
      if (existsSync(portFile)) {
        parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
        if (parsed) break;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        timer.unref?.();
      });
    }
    if (!parsed) {
      await this.close();
      throw new TikTokError(TIKTOK_ERRORS.BROWSER_FAILED, {
        messageKey: 'errors.tiktokBrowserFailed',
        httpStatus: 502,
        details: {reason: 'no_devtools_port'}
      });
    }

    this.cdp = new CdpClient({url: `ws://127.0.0.1:${parsed.port}${parsed.wsPath}`, WebSocketImpl: this.WebSocketImpl});
    await this.cdp.open();
    const {targetId} = await this.cdp.send('Target.createTarget', {url: 'about:blank'});
    const attached = await this.cdp.send('Target.attachToTarget', {targetId, flatten: true});
    this.sessionId = attached.sessionId;
    const session = this.sessionId;
    await this.cdp.send('Page.enable', {}, {sessionId: session});
    await this.cdp.send('Network.enable', {}, {sessionId: session});
    this.cdp.onEvent((message) => this.#onEvent(message, session));
    await this.cdp.send('Page.navigate', {url: this.liveUrl}, {sessionId: session});
    this.logger?.info({event: 'tiktok.browser.navigated', uniqueId: this.uniqueId, roomId: this.roomId});
    return this;
  }

  #onEvent(message, session) {
    const params = message.params;
    if (message.sessionId && message.sessionId !== session) return;
    if (message.method === 'Network.responseReceived') {
      const url = String(params?.response?.url ?? '');
      if (url.includes('/webcast/room/enter/')) {
        this.roomEnterStatus = Number(params.response.status);
        this.logger?.info({
          event: 'tiktok.browser.room_enter',
          status: this.roomEnterStatus,
          uniqueId: this.uniqueId
        });
      }
      return;
    }
    if (message.method !== 'Network.webSocketFrameReceived') return;
    const url = String(params?.response?.url ?? '');
    const payload = params?.response?.payloadData ?? '';
    this.frameCount += 1;
    let messages = [];
    try {
      messages = decodeFramePayload(payload);
    } catch {
      messages = [];
    }
    if (messages.length === 0) return;
    this.decodedCount += messages.length;
    for (const item of messages) {
      try {
        this.onFrame(item, url);
      } catch (error) {
        this.logger?.warn({event: 'tiktok.browser.frame.failed', code: error?.code ?? 'unknown'});
      }
    }
  }

  /** True when the page itself was refused room entry, i.e. login is required. */
  requiresLogin() {
    return this.roomEnterStatus === 403;
  }

  async close() {
    try {
      this.cdp?.close();
    } catch {
      /* ignore */
    }
    this.cdp = null;
    try {
      if (this.child?.pid) process.kill(this.child.pid);
    } catch {
      /* already gone */
    }
    this.child = null;
    if (this.profileDir) {
      try {
        rmSync(this.profileDir, {recursive: true, force: true});
      } catch {
        /* profile may still be locked; the next launch reuses it */
      }
    }
  }
}

/** Adapter over a browser session: same ingest contract as the signer adapter. */
export class TikTokBrowserAdapter extends PlatformAdapter {
  constructor({uniqueId, roomId, liveUrl = null, dataDir = null, logger = null, now = Date.now, sessionFactory = null, ...options} = {}) {
    super({id: 'tiktok-browser', platform: 'tiktok', label: 'TikTok Live (browser)', capabilities: ['chat', 'gift']});
    this.uniqueId = String(uniqueId ?? '').replace(/^@/, '');
    this.roomId = roomId === null || roomId === undefined ? null : String(roomId);
    this.liveUrl = liveUrl ?? `https://www.tiktok.com/@${this.uniqueId}/live`;
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.sessionFactory = sessionFactory ?? ((args) => new BrowserSession(args));
    this.options = options;
    this.session = null;
    this.started = false;
    this.seen = new Set();
    this.counters = {frames: 0, messages: 0, chats: 0, gifts: 0, duplicates: 0, ignored: 0};
    this.loginRequired = false;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? (() => {});
    this.onPlatformStatus = onPlatformStatus ?? (() => {});
    this.started = true;
    this.setState(CONNECTION_STATE.CONNECTING, {uniqueId: this.uniqueId, roomId: this.roomId, transport: 'browser'});
    const session = this.sessionFactory({
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      liveUrl: this.liveUrl,
      dataDir: this.dataDir,
      logger: this.logger,
      now: this.now
    });
    this.session = session;
    session.onFrame = (message) => this.#handleMessage(message);
    try {
      await session.launch();
    } catch (error) {
      this.started = false;
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      this.setState(CONNECTION_STATE.FAILED, {code: error?.code ?? 'unknown'});
      throw error;
    }
    // Give the official page a moment to open its own IM socket. A 403 on room
    // entry is TikTok's login gate, not a technical failure.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(Number(this.options.loginWaitMs ?? 20000), 20000));
      timer.unref?.();
    });
    if (session.requiresLogin()) {
      this.loginRequired = true;
      this.setState(CONNECTION_STATE.AUTH_REQUIRED, {uniqueId: this.uniqueId, reason: 'login_required'});
      await this.stop();
      throw new TikTokError(TIKTOK_ERRORS.LOGIN_REQUIRED, {
        messageKey: 'errors.tiktokLoginRequired',
        httpStatus: 403,
        details: {reason: 'room_enter_403'}
      });
    }
    this.setState(CONNECTION_STATE.CONNECTED, {
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      transport: 'browser',
      decodedFrames: session.decodedCount
    });
  }

  #handleMessage(message) {
    this.counters.frames += 1;
    let mapped;
    try {
      mapped = mapTikTokMessage(message, {now: this.now()});
    } catch {
      this.counters.ignored += 1;
      return;
    }
    if (mapped.kind !== 'event') {
      this.counters.ignored += 1;
      return;
    }
    const event = mapped.event;
    const id = event.external_id ? String(event.external_id) : null;
    if (id) {
      if (this.seen.has(id)) {
        this.counters.duplicates += 1;
        return;
      }
      this.seen.add(id);
      if (this.seen.size > MAX_SEEN_IDS) this.seen.delete(this.seen.values().next().value);
    }
    this.counters.messages += 1;
    if (event.event_type === 'chat') this.counters.chats += 1;
    if (event.event_type === 'gift') this.counters.gifts += 1;
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger?.warn({event: 'tiktok.browser.emit.failed', code: error?.code ?? 'unknown'});
    }
  }

  async stop() {
    this.started = false;
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    this.setState(CONNECTION_STATE.STOPPED, {uniqueId: this.uniqueId, loginRequired: this.loginRequired});
  }

  snapshot() {
    return {...super.snapshot(), uniqueId: this.uniqueId, roomId: this.roomId, counters: {...this.counters}, loginRequired: this.loginRequired};
  }
}

/** Wires browser adapters into TikTokService (transport `browser`). */
export class TikTokBrowserRelay {
  constructor({dataDir = null, logger = null, now = Date.now, sessionFactory = null} = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.now = now;
    this.sessionFactory = sessionFactory;
    this.sessions = new Set();
  }

  createAdapter({uniqueId, roomId, logger = null}) {
    const adapter = new TikTokBrowserAdapter({
      uniqueId,
      roomId,
      dataDir: this.dataDir,
      logger: logger ?? this.logger,
      now: this.now,
      ...(this.sessionFactory ? {sessionFactory: this.sessionFactory} : {})
    });
    this.sessions.add(adapter);
    return adapter;
  }

  async stop() {
    for (const adapter of this.sessions) {
      try {
        await adapter.stop();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}

export const __internal = {BROWSER_MARKER, MAX_SEEN_IDS};
