import {spawn} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {dirname, join} from 'node:path';

/**
 * Browser-assisted Douyin QR login.
 *
 * Why a real browser: `sso.douyin.com/get_qrcode` answers a plain desktop HTTP
 * client with an HTML device-fingerprint challenge, and the passport endpoint
 * answers `error_code=4031` ("安全风险"). Those are access-control responses;
 * LiveMemory must not synthesize browser fingerprints or bypass them. A normal
 * Chrome/Edge session runs the official login page and its own JS, so the QR
 * code and the post-scan identity verification stay inside Douyin's official
 * flow.
 *
 * How it works:
 *   1. launch the user's installed Chrome/Edge with a dedicated LiveMemory
 *      profile (never the user's daily browser profile);
 *   2. open the official `www.douyin.com/login_page`;
 *   3. read the QR image that the official page received, and show the same QR
 *      in LiveMemory;
 *   4. wait until the official page has written a `sessionid` cookie;
 *   5. verify that cookie against Douyin, encrypt and save it locally.
 *
 * It does not solve captchas, disable browser security, inject stealth scripts,
 * or alter the login request. If Douyin asks for extra verification, the user
 * completes it in the visible browser window.
 */

export const DOUYIN_LOGIN_PAGE = 'https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com';

export const BROWSER_LOGIN_STATES = Object.freeze({
  IDLE: 'idle',
  OPENING: 'opening',
  WAITING: 'waiting',
  SCANNED: 'scanned',
  VERIFICATION_REQUIRED: 'verification_required',
  VERIFYING: 'verifying',
  SUCCESS: 'success',
  SUCCESS_UNVERIFIED: 'success_unverified',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

export const BROWSER_PROFILE_MARKER = '.livememory-owned';
export const BROWSER_PROFILE_MARKER_TEXT = 'LiveMemory dedicated Douyin browser profile\n';

const ACTIVE_STATES = new Set([
  BROWSER_LOGIN_STATES.OPENING,
  BROWSER_LOGIN_STATES.WAITING,
  BROWSER_LOGIN_STATES.SCANNED,
  BROWSER_LOGIN_STATES.VERIFICATION_REQUIRED,
  BROWSER_LOGIN_STATES.VERIFYING
]);

const STATE_MESSAGE_KEY = Object.freeze({
  [BROWSER_LOGIN_STATES.IDLE]: 'live.source.douyinBrowserIdle',
  [BROWSER_LOGIN_STATES.OPENING]: 'live.source.douyinBrowserOpening',
  [BROWSER_LOGIN_STATES.WAITING]: 'live.source.douyinBrowserWaiting',
  [BROWSER_LOGIN_STATES.SCANNED]: 'live.source.douyinBrowserScanned',
  [BROWSER_LOGIN_STATES.VERIFICATION_REQUIRED]: 'live.source.douyinBrowserVerifyInBrowser',
  [BROWSER_LOGIN_STATES.VERIFYING]: 'live.source.douyinBrowserVerifying',
  [BROWSER_LOGIN_STATES.SUCCESS]: 'live.source.douyinBrowserSuccess',
  [BROWSER_LOGIN_STATES.SUCCESS_UNVERIFIED]: 'live.source.douyinBrowserSavedUnverified',
  [BROWSER_LOGIN_STATES.EXPIRED]: 'live.source.douyinBrowserExpired',
  [BROWSER_LOGIN_STATES.CANCELLED]: 'live.source.douyinBrowserCancelled',
  [BROWSER_LOGIN_STATES.UNAVAILABLE]: 'live.source.douyinBrowserUnavailable',
  [BROWSER_LOGIN_STATES.ERROR]: 'live.source.douyinBrowserFailed'
});

const DEFAULT_OPTIONS = Object.freeze({
  launchTimeoutMs: 25000,
  qrWaitMs: 15000,
  pollIntervalMs: 2000,
  sessionGraceMs: 20000,
  timeoutMs: 5 * 60 * 1000,
  qrTtlMs: 3 * 60 * 1000
});

const QR_HOSTS = Object.freeze(['douyin.com', 'iesdouyin.com', 'amemv.com', 'snssdk.com']);
const MAX_QR_BASE64 = 800 * 1024;

function hostMatches(host, suffix) {
  const value = String(host ?? '').toLowerCase();
  return value === suffix || value.endsWith(`.${suffix}`);
}

export function isOfficialQrUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return QR_HOSTS.some((suffix) => hostMatches(url.hostname, suffix));
}

function looksLikeBase64Image(value) {
  const text = String(value ?? '').trim();
  if (text.length < 32 || text.length > MAX_QR_BASE64) return false;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return false;
  const clean = text.replace(/\s+/g, '');
  return clean.startsWith('iVBOR')
    || clean.startsWith('/9j/')
    || clean.startsWith('UklG')
    || clean.startsWith('R0lG');
}

/**
 * Extract the official QR payload from the `get_qrcode` JSON body.
 * Returns only displayable fields; the token is deliberately not exposed.
 */
export function extractQrPayload(body, {now = Date.now()} = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const data = source.data && typeof source.data === 'object' ? source.data : source;
  const errorCode = data.error_code ?? source.error_code;
  if (errorCode !== undefined && errorCode !== null && ![0, '0', ''].includes(errorCode)) return null;

  let image = null;
  let url = null;
  for (const candidate of [data.qrcode, data.qr_code, data.frontend_show_qrcode]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let text = candidate.trim();
    if (text.startsWith('data:image/')) text = text.slice(text.indexOf(',') + 1);
    if (looksLikeBase64Image(text)) {
      image = text.replace(/\s+/g, '');
      break;
    }
  }
  for (const candidate of [data.qrcode_index_url, data.qrcode_url, data.qr_url, data.url]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    if (isOfficialQrUrl(candidate)) {
      url = candidate.trim();
      break;
    }
  }
  if (!image && !url) return null;

  const rawExpiry = Number(data.expire_time ?? source.expire_time);
  const expiresAt = Number.isFinite(rawExpiry) && rawExpiry > 0
    ? rawExpiry * 1000
    : now + DEFAULT_OPTIONS.qrTtlMs;
  return {
    image,
    url,
    expiresAt,
    frontier: Boolean(data.is_frontier ?? source.is_frontier)
  };
}

/**
 * Turn CDP cookies into a `Cookie:` header, keeping only douyin.com cookies.
 * Expired cookies are dropped; session cookies (`expires < 0`) are kept.
 */
export function douyinCookieHeader(cookies, {now = Date.now()} = {}) {
  if (!Array.isArray(cookies)) return '';
  const sorted = [...cookies].sort((a, b) => String(a?.domain ?? '').length - String(b?.domain ?? '').length);
  const jar = new Map();
  for (const cookie of sorted) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (!cookie.name || !cookie.value) continue;
    if (!/(^|\.)douyin\.com$/i.test(String(cookie.domain ?? ''))) continue;
    const expires = Number(cookie.expires);
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 <= now) continue;
    if (/[\r\n;]/.test(cookie.value)) continue;
    jar.set(cookie.name, cookie.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Parse the two-line `DevToolsActivePort` file Chrome writes for port 0. */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const port = Number(lines[0]);
  const wsPath = String(lines[1] ?? '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!wsPath.startsWith('/devtools/browser/')) return null;
  return {port, wsPath};
}

/** Fixed, security-preserving browser arguments. Exported for tests. */
export function buildBrowserArgs({profileDir, loginPage = DOUYIN_LOGIN_PAGE} = {}) {
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
    '--new-window',
    loginPage
  ];
}

/**
 * Locate an installed Chromium browser. Only known install locations and an
 * explicit, validated environment override are accepted.
 */
export function findBrowserExecutable({
  platform = process.platform,
  env = process.env,
  fileExists = existsSync
} = {}) {
  const candidates = [];
  const add = (path, name) => {
    if (path) candidates.push({path, name});
  };
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'];
    const localAppData = env.LOCALAPPDATA;
    add(programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null, 'Chrome');
    add(programFilesX86 ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : null, 'Chrome');
    add(localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null, 'Chrome');
    add(programFiles ? join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null, 'Edge');
    add(programFilesX86 ? join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null, 'Edge');
    add(localAppData ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null, 'Edge');
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge');
  } else {
    add('/usr/bin/google-chrome', 'Chrome');
    add('/usr/bin/microsoft-edge', 'Edge');
    add('/usr/bin/chromium', 'Chromium');
  }
  const explicit = String(env.LIVE_MEMORY_DOUYIN_BROWSER ?? '').trim();
  if (explicit) {
    const base = explicit.split(/[\\/]/).pop() ?? '';
    const name = /^msedge/i.test(base) ? 'Edge' : /^chromium/i.test(base) ? 'Chromium' : 'Chrome';
    candidates.unshift({path: explicit, name});
  }
  for (const candidate of candidates) {
    if (!/^(chrome|msedge|chromium)(\.exe)?$/i.test(candidate.path.split(/[\\/]/).pop() ?? '')) continue;
    try {
      if (fileExists(candidate.path)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
export class CdpConnection {
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
    this.onClose = null;
  }

  async open() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    this.closed = false;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => this.#onClose());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp open timeout')), this.timeoutMs);
      timer.unref?.();
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, {once: true});
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`cdp open failed: ${event?.message ?? 'error'}`));
      }, {once: true});
    });
    return this;
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
      if (message.error) {
        const error = new Error('cdp error');
        error.code = 'DOUYIN_BROWSER_CDP';
        error.details = {
          method: entry.method,
          code: Number(message.error.code) || 0,
          message: String(message.error.message ?? '').slice(0, 200)
        };
        entry.reject(error);
      } else {
        entry.resolve(message.result ?? {});
      }
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

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('cdp closed'));
    }
    this.pending.clear();
    try {
      this.onClose?.();
    } catch {
      /* ignore */
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
      this.pending.set(id, {resolve, reject, timer, method});
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DouyinBrowserLogin {
  constructor({
    dataDir,
    profileDir = null,
    browser = undefined,
    env = process.env,
    platform = process.platform,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    spawnImpl = spawn,
    launchImpl = null,
    login = null,
    logger = null,
    now = Date.now,
    options = {}
  } = {}) {
    this.dataDir = dataDir ?? null;
    this.profileDir = profileDir ?? (dataDir ? join(dataDir, 'runtime', 'douyin-browser-profile') : null);
    this.env = env;
    this.platform = platform;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.spawnImpl = spawnImpl;
    this.launchImpl = launchImpl;
    this.login = login;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};
    this.browser = browser === undefined ? findBrowserExecutable({platform, env}) : browser;
    this.state = BROWSER_LOGIN_STATES.IDLE;
    this.qr = null;
    this.error = null;
    this.scanState = 'waiting';
    this.startedAt = null;
    this.updatedAt = null;
    this.expiresAt = null;
    this.deadline = null;
    this.cdp = null;
    this.child = null;
    this.browserPid = null;
    this.launchKind = null;
    this.running = null;
    this.cancelled = false;
    this.closed = false;
    this.browserExited = false;
    this.seenResponses = new Set();
    this.verifyStartedAt = null;
    this.sessionSaved = false;
    this.pendingResponseTasks = new Set();
    this.launchDiagnostics = null;
  }

  status() {
    return {
      supported: Boolean(this.browser),
      browser: this.browser?.name ?? null,
      state: this.state,
      messageKey: STATE_MESSAGE_KEY[this.state] ?? 'live.source.douyinBrowserIdle',
      qr: this.qr ? {...this.qr} : null,
      scanState: this.scanState,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      expiresAt: this.expiresAt,
      error: this.error ? {...this.error} : null,
      loginPage: DOUYIN_LOGIN_PAGE,
      active: ACTIVE_STATES.has(this.state)
    };
  }

  #setState(state, {error = null} = {}) {
    if (this.state === state && !error) return;
    const previous = this.state;
    this.state = state;
    this.updatedAt = this.now();
    if (error) this.error = error;
    this.logger?.info({event: 'douyin.login.browser.state', from: previous, to: state});
  }

  #resetState() {
    this.qr = null;
    this.error = null;
    this.scanState = 'waiting';
    this.verifyStartedAt = null;
    this.sessionSaved = false;
    this.seenResponses.clear();
    this.browserExited = false;
    this.startedAt = this.now();
    this.updatedAt = this.startedAt;
    this.expiresAt = null;
  }

  async start() {
    if (ACTIVE_STATES.has(this.state) && this.running) return this.status();
    if (!this.dataDir || !this.profileDir) {
      this.#setState(BROWSER_LOGIN_STATES.UNAVAILABLE, {
        error: {code: 'DOUYIN_BROWSER_UNAVAILABLE', reason: 'no_data_dir'}
      });
      return this.status();
    }
    if (!this.browser) {
      this.#setState(BROWSER_LOGIN_STATES.UNAVAILABLE, {
        error: {code: 'DOUYIN_BROWSER_UNAVAILABLE', reason: 'browser_not_found'}
      });
      return this.status();
    }
    if (!this.login) {
      this.#setState(BROWSER_LOGIN_STATES.ERROR, {
        error: {code: 'DOUYIN_BROWSER_LAUNCH_FAILED', reason: 'login_not_configured'}
      });
      return this.status();
    }

    this.#resetState();
    this.cancelled = false;
    this.closed = false;
    this.logger?.info({
      event: 'douyin.login.browser.selected',
      browser: this.browser.name,
      path: this.browser.path
    });
    this.#setState(BROWSER_LOGIN_STATES.OPENING);
    this.deadline = this.now() + this.options.timeoutMs;
    try {
      await this.#prepareProfile();
      await this.#launchBrowser();
      await this.#connectCdp();
    } catch (error) {
      this.logger?.warn({
        event: 'douyin.login.browser.launch_failed',
        reason: String(error?.reason ?? error?.message ?? 'unknown').slice(0, 80)
      });
      await this.#closeBrowser();
      this.#setState(BROWSER_LOGIN_STATES.ERROR, {
        error: {
          code: 'DOUYIN_BROWSER_LAUNCH_FAILED',
          reason: String(error?.reason ?? 'launch_failed').slice(0, 80)
        }
      });
      return this.status();
    }
    this.#setState(BROWSER_LOGIN_STATES.WAITING);
    this.running = this.#run()
      .catch((error) => {
        this.logger?.warn({event: 'douyin.login.browser.failed', reason: String(error?.message ?? 'run').slice(0, 80)});
        this.#setState(BROWSER_LOGIN_STATES.ERROR, {
          error: {code: 'DOUYIN_BROWSER_LAUNCH_FAILED', reason: 'run_failed'}
        });
      })
      .finally(() => {
        this.running = null;
      });
    await this.#waitFor(() => this.qr !== null || !ACTIVE_STATES.has(this.state), this.options.qrWaitMs);
    return this.status();
  }

  async cancel() {
    if (!ACTIVE_STATES.has(this.state)) return this.status();
    this.cancelled = true;
    this.qr = null;
    this.#setState(BROWSER_LOGIN_STATES.CANCELLED);
    await this.#closeBrowser();
    return this.status();
  }

  async shutdown() {
    this.closed = true;
    if (ACTIVE_STATES.has(this.state)) {
      this.cancelled = true;
      this.qr = null;
      this.#setState(BROWSER_LOGIN_STATES.CANCELLED);
    }
    await this.#closeBrowser();
  }

  /** Return to a clean idle state after an explicit logout. */
  reset() {
    this.qr = null;
    this.error = null;
    this.scanState = 'waiting';
    this.startedAt = null;
    this.updatedAt = null;
    this.expiresAt = null;
    this.cancelled = false;
    this.closed = false;
    this.sessionSaved = false;
    this.#setState(BROWSER_LOGIN_STATES.IDLE);
  }

  /**
   * Remove the dedicated browser profile. Refuses to delete anything that does
   * not carry LiveMemory's ownership marker.
   */
  clearProfile() {
    if (!this.profileDir) return {removed: false, reason: 'no_profile'};
    try {
      if (!existsSync(this.profileDir)) return {removed: false, reason: 'missing'};
      const marker = join(this.profileDir, BROWSER_PROFILE_MARKER);
      if (!existsSync(marker) || readFileSync(marker, 'utf8') !== BROWSER_PROFILE_MARKER_TEXT) {
        return {removed: false, reason: 'not_owned'};
      }
      rmSync(this.profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      return {removed: true, reason: null};
    } catch {
      return {removed: false, reason: 'locked'};
    }
  }

  /* ------------------------------------------------------------ launch */

  async #prepareProfile() {
    mkdirSync(this.profileDir, {recursive: true});
    const marker = join(this.profileDir, BROWSER_PROFILE_MARKER);
    if (existsSync(marker)) {
      if (readFileSync(marker, 'utf8') !== BROWSER_PROFILE_MARKER_TEXT) {
        throw Object.assign(new Error('profile not owned'), {reason: 'profile_not_owned'});
      }
      return;
    }
    const entries = readdirSync(this.profileDir).filter((name) => name !== BROWSER_PROFILE_MARKER);
    if (entries.length > 0) {
      throw Object.assign(new Error('profile not owned'), {reason: 'profile_not_owned'});
    }
    writeFileSync(marker, BROWSER_PROFILE_MARKER_TEXT, {mode: 0o600});
  }

  async #launchBrowser() {
    const args = buildBrowserArgs({profileDir: this.profileDir});
    const portFile = join(this.profileDir, 'DevToolsActivePort');
    try {
      rmSync(portFile, {force: true});
    } catch {
      /* ignore */
    }
    if (this.launchImpl) {
      const result = await this.launchImpl({
        exePath: this.browser.path,
        args,
        profileDir: this.profileDir,
        portFile,
        env: this.env
      });
      this.browserPid = Number(result?.pid) || null;
      this.launchKind = result?.kind ?? 'injected';
      const info = result?.port ? {port: Number(result.port), wsPath: String(result.wsPath ?? '')} : await this.#waitForPort(portFile);
      if (!info?.port) throw Object.assign(new Error('browser did not start'), {reason: 'browser_did_not_start'});
      this.port = info.port;
      this.logger?.info({event: 'douyin.login.browser.launch', browser: this.browser.name, kind: this.launchKind});
      return;
    }

    // Preferred: a normal child process. This is the path real users take.
    let directError = null;
    try {
      this.launchDiagnostics = {direct: 'spawned'};
      this.child = this.spawnImpl(this.browser.path, args, {stdio: 'ignore', windowsHide: false});
      this.browserPid = this.child?.pid ?? null;
      this.child?.on?.('error', (error) => {
        this.launchDiagnostics = {
          ...(this.launchDiagnostics ?? {}),
          direct: String(error?.code ?? error?.message ?? 'error').slice(0, 60)
        };
      });
      this.child?.on?.('exit', (code, signal) => {
        this.browserExited = true;
        this.launchDiagnostics = {
          ...(this.launchDiagnostics ?? {}),
          directExit: `${code ?? 'null'}/${signal ?? 'null'}`
        };
      });
      const info = await this.#waitForPort(portFile, 12000);
      if (info?.port) {
        this.port = info.port;
        this.launchKind = 'spawn';
        this.logger?.info({event: 'douyin.login.browser.launch', browser: this.browser.name, kind: 'spawn'});
        return;
      }
      directError = Object.assign(new Error('browser did not start'), {reason: 'browser_did_not_start'});
    } catch (error) {
      directError = error;
      this.launchDiagnostics = {
        ...(this.launchDiagnostics ?? {}),
        direct: String(error?.code ?? error?.message ?? 'error').slice(0, 60)
      };
    }
    this.logger?.warn({
      event: 'douyin.login.browser.direct_failed',
      diagnostics: this.launchDiagnostics,
      portFile: existsSync(portFile)
    });
    try {
      this.child?.removeAllListeners?.('exit');
      this.child?.kill?.();
    } catch {
      /* ignore */
    }
    this.child = null;
    this.browserExited = false;

    // Restricted Windows environments may deny anonymous pipes to a Chromium
    // child. PowerShell's Start-Process starts the same browser outside that
    // restriction. The command is fixed; every argument is base64 encoded.
    if (this.platform === 'win32') {
      try {
        const result = await this.#launchViaPowerShell(args, portFile);
        const info = await this.#waitForPort(portFile, 30000);
        if (!info?.port) {
          this.logger?.warn({
            event: 'douyin.login.browser.powershell_no_port',
            diagnostics: this.launchDiagnostics,
            pid: result?.pid ?? null
          });
          throw Object.assign(new Error('browser did not start'), {reason: 'browser_did_not_start'});
        }
        this.port = info.port;
        this.browserPid = result?.pid ?? this.browserPid;
        this.launchKind = 'powershell';
        this.logger?.info({event: 'douyin.login.browser.launch', browser: this.browser.name, kind: 'powershell'});
        return;
      } catch (error) {
        this.logger?.warn({
          event: 'douyin.login.browser.powershell_failed',
          diagnostics: this.launchDiagnostics,
          reason: String(error?.reason ?? 'launch_failed').slice(0, 60)
        });
        throw Object.assign(new Error('browser launch failed'), {
          reason: String(error?.reason ?? directError?.reason ?? 'launch_failed').slice(0, 60)
        });
      }
    }
    throw directError ?? Object.assign(new Error('browser launch failed'), {reason: 'launch_failed'});
  }

  async #launchViaPowerShell(args, portFile) {
    const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const encodedPidFile = Buffer.from(join(this.profileDir, 'browser.pid'), 'utf8').toString('base64');
    const encodedErrorFile = Buffer.from(join(this.profileDir, 'browser-launch-error.txt'), 'utf8').toString('base64');
    const exe = Buffer.from(this.browser.path, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference='Stop'",
      "$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + exe + "'))",
      "$args=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedArgs + "')) | ConvertFrom-Json",
      "$pidFile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedPidFile + "'))",
      "$errorFile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedErrorFile + "'))",
      'try {',
      '  $p=Start-Process -FilePath $exe -ArgumentList $args -PassThru',
      '  Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii',
      '} catch {',
      '  try { Set-Content -LiteralPath $errorFile -Value ("ERROR:" + $_.Exception.Message) -Encoding utf8 } catch {}',
      '  exit 1',
      '}'
    ].join('; ');
    const powershell = this.env.SystemRoot
      ? join(this.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const child = this.spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      timer.unref?.();
      child?.on?.('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child?.on?.('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const pidFile = join(this.profileDir, 'browser.pid');
    const errorFile = join(this.profileDir, 'browser-launch-error.txt');
    let pid = null;
    if (existsSync(pidFile)) {
      try {
        pid = Number(readFileSync(pidFile, 'utf8').trim()) || null;
      } catch {
        pid = null;
      }
    }
    if (existsSync(errorFile)) {
      try {
        this.launchDiagnostics = {
          ...(this.launchDiagnostics ?? {}),
          powershell: String(readFileSync(errorFile, 'utf8')).slice(0, 160)
        };
      } catch {
        /* ignore */
      }
    }
    return {pid, portFile};
  }

  async #waitForPort(portFile, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (existsSync(portFile)) {
        try {
          const parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
          if (parsed) return parsed;
        } catch {
          /* retry */
        }
      }
      if (this.browserExited) return null;
      await sleep(200);
    }
    return null;
  }

  /* --------------------------------------------------------------- CDP */

  async #connectCdp() {
    const page = await this.#waitForPageTarget(15000);
    this.cdp = new CdpConnection({
      url: page.webSocketDebuggerUrl,
      WebSocketImpl: this.WebSocketImpl,
      timeoutMs: 15000
    });
    this.cdp.onClose = () => {
      this.browserExited = true;
    };
    await this.cdp.open();
    this.cdp.onEvent((event) => this.#onCdpEvent(event));
    await this.cdp.send('Network.enable');
    await this.cdp.send('Page.enable');
    try {
      await this.cdp.send('Page.navigate', {url: DOUYIN_LOGIN_PAGE});
    } catch {
      /* the page may already be navigating; the network capture still works */
    }
  }

  async #waitForPageTarget(timeoutMs) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/json/list`, {
          headers: {accept: 'application/json'},
          signal: AbortSignal.timeout?.(5000)
        });
        const list = await response.json();
        const pages = Array.isArray(list) ? list.filter((item) => item?.type === 'page') : [];
        const target = pages.find((item) => /douyin\.com/i.test(String(item.url ?? '')))
          ?? pages.find((item) => item?.webSocketDebuggerUrl)
          ?? null;
        if (target?.webSocketDebuggerUrl) return target;
        lastError = new Error('page target not ready');
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    throw Object.assign(new Error('cdp target unavailable'), {
      reason: String(lastError?.message ?? 'target_timeout').slice(0, 60)
    });
  }

  #onCdpEvent(event) {
    if (event?.method === 'Network.responseReceived') {
      const response = event.params?.response;
      const requestId = event.params?.requestId;
      const url = String(response?.url ?? '');
      if (!requestId || !url) return;
      let kind = null;
      try {
        const path = new URL(url).pathname.replace(/\/+$/, '');
        if (/\/get_qrcode$/.test(path)) kind = 'qr';
        else if (/\/check_qrconnect$/.test(path)) kind = 'poll';
      } catch {
        return;
      }
      if (!kind || this.seenResponses.has(requestId)) return;
      this.seenResponses.add(requestId);
      const task = this.#readResponse(requestId, kind).catch(() => {}).finally(() => {
        this.pendingResponseTasks.delete(task);
      });
      this.pendingResponseTasks.add(task);
      return;
    }
    if (event?.method === 'Page.frameNavigated') {
      const url = String(event.params?.frame?.url ?? '');
      if (/captcha|verify|challenge|passport\/web\/verify/i.test(url)) {
        this.scanState = 'verification_required';
        if (ACTIVE_STATES.has(this.state)) {
          this.#setState(BROWSER_LOGIN_STATES.VERIFICATION_REQUIRED);
        }
      }
    }
  }

  async #readResponse(requestId, kind) {
    if (!this.cdp) return;
    const body = await this.cdp.send('Network.getResponseBody', {requestId}, {timeoutMs: 5000});
    let text = String(body?.body ?? '');
    if (body?.base64Encoded) {
      text = Buffer.from(text, 'base64').toString('utf8');
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (kind === 'qr') {
      const qr = extractQrPayload(payload, {now: this.now()});
      if (!qr) return;
      const changed = !this.qr || this.qr.image !== qr.image || this.qr.url !== qr.url || this.qr.expiresAt !== qr.expiresAt;
      this.qr = qr;
      this.expiresAt = qr.expiresAt;
      if (changed) {
        this.logger?.info({
          event: 'douyin.login.browser.qr',
          hasImage: Boolean(qr.image),
          hasUrl: Boolean(qr.url),
          frontier: qr.frontier
        });
      }
      if (ACTIVE_STATES.has(this.state) && this.state !== BROWSER_LOGIN_STATES.VERIFYING) {
        this.#setState(BROWSER_LOGIN_STATES.WAITING);
      }
      return;
    }
    const status = this.#scanStateFromPayload(payload);
    if (!status) return;
    if (status === 'verification_required') {
      this.scanState = status;
      if (ACTIVE_STATES.has(this.state)) this.#setState(BROWSER_LOGIN_STATES.VERIFICATION_REQUIRED);
    } else if (status === 'scanned' || status === 'confirmed') {
      if (this.scanState !== 'verification_required') {
        this.scanState = 'scanned';
        if (ACTIVE_STATES.has(this.state)) this.#setState(BROWSER_LOGIN_STATES.SCANNED);
      }
    } else if (status === 'expired') {
      if (this.scanState === 'waiting') {
        this.#setState(BROWSER_LOGIN_STATES.EXPIRED);
      }
    }
  }

  #scanStateFromPayload(body) {
    const source = body && typeof body === 'object' ? body : {};
    const data = source.data && typeof source.data === 'object' ? source.data : source;
    for (const value of [source, data]) {
      if (!value || typeof value !== 'object') continue;
      if (value.error_code === 2046 || value.error_code === '2046') return 'verification_required';
      if (value.verify_ticket || value.verify_center || value.captcha) return 'verification_required';
    }
    const raw = String(data.status ?? data.qr_status ?? source.status ?? '').toLowerCase();
    if (raw === '2' || raw === 'scanned' || raw === 'scanning') return 'scanned';
    if (raw === '3' || raw === 'confirmed' || raw === 'success' || data.redirect_url) return 'confirmed';
    if (raw === '5' || raw === 'expired' || raw === 'expire') return 'expired';
    return null;
  }

  /* -------------------------------------------------------------- loop */

  async #run() {
    while (!this.cancelled && !this.closed) {
      if (this.now() > this.deadline) {
        this.#setState(BROWSER_LOGIN_STATES.EXPIRED);
        break;
      }
      if (this.browserExited) {
        this.#setState(BROWSER_LOGIN_STATES.CANCELLED);
        break;
      }
      await sleep(this.options.pollIntervalMs);
      if (this.cancelled || this.closed) break;
      if (this.state === BROWSER_LOGIN_STATES.SUCCESS || this.state === BROWSER_LOGIN_STATES.SUCCESS_UNVERIFIED) break;
      try {
        await this.#pollCookies();
      } catch {
        /* retry on the next tick */
      }
      if (this.qr?.expiresAt && this.now() > this.qr.expiresAt
        && this.scanState === 'waiting'
        && this.state === BROWSER_LOGIN_STATES.WAITING) {
        this.#setState(BROWSER_LOGIN_STATES.EXPIRED);
        break;
      }
    }
    if (this.state === BROWSER_LOGIN_STATES.SUCCESS
      || this.state === BROWSER_LOGIN_STATES.SUCCESS_UNVERIFIED
      || this.state === BROWSER_LOGIN_STATES.CANCELLED
      || this.state === BROWSER_LOGIN_STATES.EXPIRED
      || this.state === BROWSER_LOGIN_STATES.ERROR) {
      await this.#closeBrowser();
    }
  }

  async #pageProfile() {
    if (!this.cdp) return null;
    try {
      const result = await this.cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          try {
            const response = await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', {
              credentials: 'include',
              headers: {accept: 'application/json'}
            });
            const text = await response.text();
            return {httpStatus: response.status, text: text.slice(0, 20000)};
          } catch (error) {
            return {error: String(error && error.message ? error.message : error).slice(0, 200)};
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, {timeoutMs: 12000});
      const value = result?.result?.value;
      if (!value || value.error || !value.text) return null;
      let payload;
      try {
        payload = JSON.parse(value.text);
      } catch {
        return null;
      }
      if (Number(payload?.status_code) === 8) return {valid: false};
      if (Number(payload?.status_code) === 0 && payload?.user) {
        const name = String(payload.user.nickname ?? '').trim().slice(0, 64);
        const uid = String(payload.user.uid ?? payload.user.user_id_str ?? '').trim().slice(0, 40);
        if (name || uid) return {valid: true, user: {name: name || null, uid: uid || null}};
      }
      return null;
    } catch {
      return null;
    }
  }

  async #pollCookies() {
    if (this.cancelled || this.closed) return;
    if (!this.cdp || !this.login || this.sessionSaved) return;
    if (this.state === BROWSER_LOGIN_STATES.VERIFYING && this.verifyStartedAt
      && this.now() - this.verifyStartedAt < 4000) {
      return;
    }
    const result = await this.cdp.send('Storage.getCookies', {}, {timeoutMs: 8000});
    if (this.cancelled || this.closed) return;
    const header = douyinCookieHeader(result?.cookies, {now: this.now()});
    if (!/sessionid(_ss)?=[^;]{8,}/.test(header)) return;
    this.#setState(BROWSER_LOGIN_STATES.VERIFYING);
    this.verifyStartedAt = this.now();
    // The official page is already a trusted, signed-in browser context. Ask
    // it for the profile first; this avoids false negatives when a request
    // made outside the page would be refused for a missing web signature.
    const pageUser = await this.#pageProfile();
    let outcome;
    if (pageUser?.valid) {
      outcome = await this.login.saveBrowserCookie(header, {verifiedUser: pageUser.user});
    } else {
      outcome = await this.login.saveBrowserCookie(header);
      if (outcome?.savedUnverified) {
        const retryUser = await this.#pageProfile();
        if (retryUser?.valid) {
          outcome = await this.login.saveBrowserCookie(header, {verifiedUser: retryUser.user});
        }
      }
    }
    if (this.cancelled || this.closed) return;
    if (outcome?.verified === true) {
      this.sessionSaved = true;
      this.qr = null;
      this.#setState(BROWSER_LOGIN_STATES.SUCCESS);
      this.logger?.info({event: 'douyin.login.browser.success', verified: true});
      return;
    }
    if (outcome?.savedUnverified) {
      this.sessionSaved = true;
      this.qr = null;
      this.#setState(BROWSER_LOGIN_STATES.SUCCESS_UNVERIFIED, {
        error: {
          code: 'DOUYIN_LOGIN_VERIFY_UNAVAILABLE',
          reason: String(outcome.reason ?? 'inconclusive').slice(0, 40)
        }
      });
      this.logger?.info({event: 'douyin.login.browser.success', verified: false});
      return;
    }
    // The session id may have been written a moment before the rest of the
    // login cookies. Give the official page a short grace period, then report
    // a definitive failure instead of pretending the login worked.
    if (this.verifyStartedAt && this.now() - this.verifyStartedAt > this.options.sessionGraceMs) {
      this.#setState(BROWSER_LOGIN_STATES.ERROR, {
        error: {
          code: outcome?.reason === 'expired' ? 'DOUYIN_LOGIN_EXPIRED' : 'DOUYIN_LOGIN_INVALID',
          reason: String(outcome?.reason ?? 'invalid').slice(0, 40)
        }
      });
    }
  }

  /* ----------------------------------------------------------- cleanup */

  async #closeBrowser() {
    const cdp = this.cdp;
    if (cdp && !cdp.closed) {
      try {
        await cdp.send('Browser.close', {}, {timeoutMs: 1500});
      } catch {
        /* fall through to process termination */
      }
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
    }
    this.cdp = null;
    await sleep(300);
    const pid = this.browserPid;
    if (pid && this.launchKind !== 'injected') {
      if (this.platform === 'win32') {
        // Kill the whole Chromium process tree. A single Browser.close can leave
        // helper processes holding the dedicated profile for several seconds.
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            const killer = this.spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true
            });
            killer?.on?.('exit', finish);
            killer?.on?.('error', finish);
          } catch {
            finish();
          }
          const timer = setTimeout(finish, 4000);
          timer.unref?.();
        });
      } else {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
      const started = Date.now();
      while (Date.now() - started < 5000 && isProcessAlive(pid)) {
        await sleep(200);
      }
    }
    try {
      this.child?.kill?.();
    } catch {
      /* ignore */
    }
    this.child = null;
    this.browserPid = null;
  }

  async #waitFor(predicate, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await sleep(100);
    }
    return predicate();
  }
}

export const __internal = {
  DEFAULT_OPTIONS,
  STATE_MESSAGE_KEY,
  ACTIVE_STATES,
  looksLikeBase64Image,
  hostMatches
};
