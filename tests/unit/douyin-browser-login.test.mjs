import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BROWSER_LOGIN_STATES,
  BROWSER_PROFILE_MARKER,
  BROWSER_PROFILE_MARKER_TEXT,
  DouyinBrowserLogin,
  buildBrowserArgs,
  douyinCookieHeader,
  extractQrPayload,
  findBrowserExecutable,
  parseDevToolsActivePort
} from '../../src/platforms/douyin/browser-login.mjs';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function response(body, {status = 200, contentType = 'application/json'} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => contentType},
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}

/** A tiny CDP socket that answers the exact commands the login flow sends. */
class FakeCdpSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    this.cookieCalls = 0;
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  #reply(id, result) {
    this.emit('message', {data: JSON.stringify({id, result})});
  }

  send(text) {
    const message = JSON.parse(text);
    const {id, method, params} = message;
    if (method === 'Network.enable' || method === 'Page.enable') {
      this.#reply(id, {});
      return;
    }
    if (method === 'Page.navigate') {
      this.#reply(id, {frameId: 'frame-1'});
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            method: 'Network.responseReceived',
            params: {
              requestId: 'req-qr',
              response: {
                url: 'https://www.douyin.com/passport/web/get_qrcode/?aid=6383',
                status: 200,
                mimeType: 'application/json'
              }
            }
          })
        });
      });
      return;
    }
    if (method === 'Network.getResponseBody') {
      this.#reply(id, {
        body: JSON.stringify({
          data: {
            error_code: 0,
            qrcode: PNG_BASE64,
            is_frontier: true,
            expire_time: Math.floor(Date.now() / 1000) + 180
          }
        }),
        base64Encoded: false
      });
      return;
    }
    if (method === 'Storage.getCookies') {
      this.cookieCalls += 1;
      const cookies = this.cookieCalls >= 2
        ? [{
          name: 'sessionid',
          value: 'abcdefgh12345678',
          domain: '.douyin.com',
          path: '/',
          expires: -1,
          httpOnly: true
        }, {
          name: 'ttwid',
          value: 'tt-1',
          domain: '.douyin.com',
          path: '/',
          expires: -1
        }]
        : [];
      this.#reply(id, {cookies});
      return;
    }
    if (method === 'Browser.close') {
      this.#reply(id, {});
      queueMicrotask(() => this.emit('close', {}));
      return;
    }
    this.#reply(id, {});
  }

  close() {
    this.closed = true;
    this.emit('close', {});
  }
}

function fakeLaunch({port = 45678} = {}) {
  return async () => ({port, wsPath: '/devtools/browser/fake', pid: 4242, kind: 'injected'});
}

function fakeTargetsFetch() {
  return async () => response([{
    type: 'page',
    url: 'https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com',
    webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/page/fake'
  }]);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lm-douyin-browser-'));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test('browser arguments stay conservative and use a dedicated profile', () => {
  const args = buildBrowserArgs({profileDir: 'D:/data/runtime/douyin-browser-profile'});
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.ok(args.includes('https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com'));
  assert.equal(args.includes('--headless'), false);
  assert.equal(args.includes('--no-sandbox'), false);
  assert.equal(args.includes('--disable-web-security'), false);
  assert.equal(args.some((arg) => /AutomationControlled|stealth/i.test(arg)), false);
});

test('browser discovery only accepts known Chrome/Edge names', () => {
  const env = {
    ProgramFiles: 'C:/Program Files',
    'ProgramFiles(x86)': 'C:/Program Files (x86)',
    LOCALAPPDATA: 'C:/Users/u/AppData/Local'
  };
  const found = findBrowserExecutable({
    platform: 'win32',
    env,
    fileExists: (path) => path.endsWith('msedge.exe')
  });
  assert.equal(found.name, 'Edge');
  assert.match(found.path, /msedge\.exe$/);
  const missing = findBrowserExecutable({platform: 'win32', env, fileExists: () => false});
  assert.equal(missing, null);
});

test('DevToolsActivePort parsing rejects malformed files', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc\n'), {
    port: 9222,
    wsPath: '/devtools/browser/abc'
  });
  assert.equal(parseDevToolsActivePort('0\n/devtools/browser/abc'), null);
  assert.equal(parseDevToolsActivePort('9222\nnot-a-path'), null);
  assert.equal(parseDevToolsActivePort('nope'), null);
});

test('the cookie header keeps only douyin.com cookies and drops expired ones', () => {
  const now = 1_800_000_000_000;
  const header = douyinCookieHeader([
    {name: 'sessionid', value: 'abc', domain: '.douyin.com', expires: -1},
    {name: 'ttwid', value: 'tt', domain: 'www.douyin.com', expires: -1},
    {name: 'old', value: 'x', domain: '.douyin.com', expires: now / 1000 - 10},
    {name: 'other', value: 'no', domain: '.example.com', expires: -1}
  ], {now});
  assert.match(header, /sessionid=abc/);
  assert.match(header, /ttwid=tt/);
  assert.equal(header.includes('old='), false);
  assert.equal(header.includes('other='), false);
});

test('the official QR payload keeps the image and expiry but rejects foreign URLs', () => {
  const now = 1_800_000_000_000;
  const payload = extractQrPayload({
    data: {
      error_code: 0,
      qrcode: PNG_BASE64,
      is_frontier: true,
      expire_time: 1_800_000_180
    }
  }, {now});
  assert.equal(payload.image, PNG_BASE64);
  assert.equal(payload.frontier, true);
  assert.equal(payload.expiresAt, 1_800_000_180_000);
  const urlPayload = extractQrPayload({data: {qrcode_index_url: 'https://www.douyin.com/login?token=x'}}, {now});
  assert.equal(urlPayload.url, 'https://www.douyin.com/login?token=x');
  const foreign = extractQrPayload({data: {qrcode_index_url: 'https://evil.example/qr'}}, {now});
  assert.equal(foreign, null);
  const error = extractQrPayload({data: {error_code: 4031, qrcode: PNG_BASE64}}, {now});
  assert.equal(error, null);
});

test('the browser flow captures the official QR and verifies the session', async () => {
  const dir = tempDir();
  const calls = [];
  const login = new DouyinBrowserLogin({
    dataDir: dir,
    browser: {path: 'C:/fake/msedge.exe', name: 'Edge'},
    platform: 'win32',
    launchImpl: fakeLaunch(),
    WebSocketImpl: FakeCdpSocket,
    fetchImpl: fakeTargetsFetch(),
    login: {
      saveBrowserCookie: async (header) => {
        calls.push(header);
        assert.match(header, /sessionid=abcdefgh12345678/);
        return {ok: true, verified: true, savedUnverified: false, reason: 'ok'};
      }
    },
    options: {pollIntervalMs: 20, qrWaitMs: 1000, sessionGraceMs: 500, timeoutMs: 5000}
  });
  const started = await login.start();
  assert.equal(started.state, BROWSER_LOGIN_STATES.WAITING);
  assert.ok(started.qr?.image, 'the QR must be captured for display in the app');
  assert.equal(started.qr.frontier, true);
  assert.equal(JSON.stringify(started).includes('sessionid'), false);
  assert.equal(await waitFor(() => login.status().state === BROWSER_LOGIN_STATES.SUCCESS), true);
  assert.equal(calls.length >= 1, true);
  assert.equal(login.status().state, BROWSER_LOGIN_STATES.SUCCESS);
  rmSync(dir, {recursive: true, force: true});
});

test('a browser refusal is reported as unavailable, with no fake QR', async () => {
  const dir = tempDir();
  const login = new DouyinBrowserLogin({
    dataDir: dir,
    browser: null,
    platform: 'win32',
    options: {pollIntervalMs: 20}
  });
  const status = await login.start();
  assert.equal(status.state, BROWSER_LOGIN_STATES.UNAVAILABLE);
  assert.equal(status.qr, null);
  assert.equal(status.supported, false);
  rmSync(dir, {recursive: true, force: true});
});

test('an unowned profile directory is never reused or deleted', async () => {
  const dir = tempDir();
  const profile = join(dir, 'runtime', 'douyin-browser-profile');
  mkdirSync(profile, {recursive: true});
  writeFileSync(join(profile, 'Default'), 'not ours');
  const login = new DouyinBrowserLogin({
    dataDir: dir,
    profileDir: profile,
    browser: {path: 'C:/fake/chrome.exe', name: 'Chrome'},
    platform: 'win32',
    launchImpl: fakeLaunch(),
    WebSocketImpl: FakeCdpSocket,
    fetchImpl: fakeTargetsFetch(),
    login: {saveBrowserCookie: async () => ({ok: true, verified: true})}
  });
  const status = await login.start();
  assert.equal(status.state, BROWSER_LOGIN_STATES.ERROR);
  assert.equal(status.error?.reason, 'profile_not_owned');
  assert.equal(existsSync(join(profile, 'Default')), true);
  rmSync(dir, {recursive: true, force: true});
});

test('cancel closes an active browser login without claiming success', async () => {
  const dir = tempDir();
  const login = new DouyinBrowserLogin({
    dataDir: dir,
    browser: {path: 'C:/fake/chrome.exe', name: 'Chrome'},
    platform: 'win32',
    launchImpl: fakeLaunch(),
    WebSocketImpl: FakeCdpSocket,
    fetchImpl: fakeTargetsFetch(),
    login: {saveBrowserCookie: async () => ({ok: true, verified: true})},
    options: {pollIntervalMs: 500, qrWaitMs: 1000, timeoutMs: 10000}
  });
  await login.start();
  const status = await login.cancel();
  assert.equal(status.state, BROWSER_LOGIN_STATES.CANCELLED);
  assert.equal(login.status().qr, null);
  rmSync(dir, {recursive: true, force: true});
});

test('a profile is deleted only when it carries the ownership marker', async () => {
  const dir = tempDir();
  const login = new DouyinBrowserLogin({
    dataDir: dir,
    browser: {path: 'C:/fake/chrome.exe', name: 'Chrome'},
    platform: 'win32'
  });
  const missing = login.clearProfile();
  assert.equal(missing.removed, false);
  const profile = join(dir, 'runtime', 'douyin-browser-profile');
  mkdirSync(profile, {recursive: true});
  writeFileSync(join(profile, BROWSER_PROFILE_MARKER), BROWSER_PROFILE_MARKER_TEXT);
  const removed = login.clearProfile();
  assert.equal(removed.removed, true);
  assert.equal(existsSync(profile), false);
  rmSync(dir, {recursive: true, force: true});
});
