import {existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {DouyinBrowserLogin, BROWSER_LOGIN_STATES} from '../src/platforms/douyin/browser-login.mjs';

/**
 * Real browser-assisted QR login plumbing and window-count check.
 *
 * It launches the installed Chrome/Edge with a dedicated LiveMemory profile,
 * opens the official Douyin login page, captures the QR that the official page
 * received, and cancels. It NEVER asks for or uses a Douyin account, and it
 * deliberately does not scan the QR: a human with the Douyin app must do that.
 *
 * Window counts are measured with real Chrome + CDP `Browser.getWindowForTarget`;
 * this is not a DOM/mock simulation.
 *
 * Run:
 *   node scripts/verify-douyin-browser-login.mjs
 */

const root = join(process.cwd(), 'tests', '.tmp', `douyin-browser-verify-${process.pid}`);
const results = [];
const log = (line = '') => console.log(line);
let launchEvents = 0;

function record(name, passed, details = []) {
  results.push({name, passed});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const detail of details) log(`        ${detail}`);
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

const logger = {
  info: (record) => {
    if (record?.event === 'douyin.login.browser.launch') launchEvents += 1;
    if (record?.event?.startsWith('douyin.login.browser')) {
      log(`        log: ${record.event} ${JSON.stringify({...record, event: undefined})}`);
    }
  },
  warn: (record) => log(`        warn: ${JSON.stringify(record)}`)
};

function flowFor(dataDir) {
  return new DouyinBrowserLogin({
    dataDir,
    login: {
      async saveBrowserCookie() {
        throw new Error('a QR scan must never happen in this automated check');
      }
    },
    logger,
    options: {
      launchTimeoutMs: 45000,
      qrWaitMs: 45000,
      pollIntervalMs: 1000,
      timeoutMs: 120000,
      sessionGraceMs: 5000
    }
  });
}

/** Count real browser windows for the page targets via CDP window IDs. */
async function windowReport(flow) {
  if (!flow?.port) return {pages: 0, windows: 0, urls: []};
  const portFile = join(root, 'runtime', 'douyin-browser-profile', 'DevToolsActivePort');
  if (!existsSync(portFile)) return {pages: 0, windows: 0, urls: []};
  const list = await (await fetch(`http://127.0.0.1:${flow.port}/json/list`)).json();
  const pages = Array.isArray(list) ? list.filter((item) => item.type === 'page') : [];
  const wsPath = readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${flow.port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, {resolve, reject});
    ws.send(JSON.stringify({id: myId, method, params}));
  });
  const windows = new Map();
  for (const page of pages) {
    try {
      const {windowId} = await send('Browser.getWindowForTarget', {targetId: page.id});
      windows.set(windowId, page.url);
    } catch {
      /* a non-window page target is ignored */
    }
  }
  ws.close();
  return {
    pages: pages.length,
    windows: windows.size,
    urls: pages.map((page) => page.url)
  };
}

let flow = null;
let rapid = null;
let reuse = null;
try {
  rmSync(root, {recursive: true, force: true});
  flow = flowFor(root);

  const initial = flow.status();
  record('an installed Chromium browser is detected for QR login', initial.supported === true, [
    `browser ${initial.browser ?? 'missing'}`,
    `state ${initial.state}`
  ]);
  if (!initial.supported) {
    throw new Error('no Chrome/Edge detected');
  }

  const started = await flow.start();
  record('the browser login flow opens without claiming a login', [
    BROWSER_LOGIN_STATES.WAITING,
    BROWSER_LOGIN_STATES.OPENING,
    BROWSER_LOGIN_STATES.ERROR
  ].includes(started.state), [
    `state ${started.state}`,
    `error ${started.error?.code ?? 'none'}:${started.error?.reason ?? 'none'}`
  ]);
  const singleWindow = await windowReport(flow);
  record('one click opens exactly one browser window', singleWindow.windows === 1 && singleWindow.pages === 1, [
    `pages ${singleWindow.pages}, unique windows ${singleWindow.windows}`,
    `urls ${singleWindow.urls.join(', ')}`
  ]);
  record('the official login page is captured as a QR image for the app', Boolean(started.qr?.image), [
    `qr image bytes ${started.qr?.image?.length ?? 0}`,
    `frontier ${started.qr?.frontier ?? false}`,
    `expires in ${started.qr?.expiresAt ? Math.round((started.qr.expiresAt - Date.now()) / 1000) : 0}s`
  ]);
  record('the status payload never exposes a cookie or a QR token', !JSON.stringify(started).includes('sessionid')
    && !JSON.stringify(started).includes('"token"'), [
    `state ${started.state}`
  ]);
  const qrOk = started.qr?.image?.startsWith('iVBOR')
    || started.qr?.image?.startsWith('/9j/')
    || started.qr?.image?.startsWith('UklG');
  record('the captured QR is a real image, not an error page', Boolean(qrOk), [
    `prefix ${String(started.qr?.image ?? '').slice(0, 12)}`
  ]);

  const beforeRepeat = launchEvents;
  const again = await flow.start();
  const repeatedWindow = await windowReport(flow);
  record('clicking again while the window is open focuses it instead of opening another', launchEvents === beforeRepeat
    && flow.focusCount === 1
    && repeatedWindow.windows === 1
    && repeatedWindow.pages === 1, [
    `launch events ${launchEvents - beforeRepeat}`,
    `focus requests ${flow.focusCount}`,
    `pages ${repeatedWindow.pages}, unique windows ${repeatedWindow.windows}`,
    `state ${again.state}`
  ]);

  const cancelled = await flow.cancel();
  record('cancel closes the login and removes the QR', cancelled.state === BROWSER_LOGIN_STATES.CANCELLED
    && cancelled.qr === null, [`state ${cancelled.state}`]);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const cleared = flow.clearProfile();
  record('the dedicated browser profile can be deleted after cancel', cleared.removed === true, [
    `removed ${cleared.removed}, reason ${cleared.reason ?? 'none'}`,
    `profile exists ${existsSync(join(root, 'runtime', 'douyin-browser-profile'))}`
  ]);

  // Rapid double click: the second start() must not launch another browser.
  rapid = flowFor(root);
  const beforeRapid = launchEvents;
  const [rapidFirst, rapidSecond] = await Promise.all([rapid.start(), rapid.start()]);
  const rapidWindow = await windowReport(rapid);
  record('a rapid double click still opens exactly one browser window', launchEvents - beforeRapid === 1
    && rapidWindow.windows === 1
    && rapidWindow.pages === 1, [
    `launch events ${launchEvents - beforeRapid}`,
    `focus requests ${rapid.focusCount}`,
    `states ${rapidFirst.state}/${rapidSecond.state}`,
    `pages ${rapidWindow.pages}, unique windows ${rapidWindow.windows}`
  ]);

  // A second LiveMemory-side flow (e.g. after an app restart) must attach to the
  // existing dedicated window instead of opening a second one.
  reuse = flowFor(root);
  const beforeReuse = launchEvents;
  const reused = await reuse.start();
  const reuseWindow = await windowReport(reuse);
  record('an existing dedicated login window is reused, not duplicated', reuse.launchKind === 'reuse'
    && launchEvents === beforeReuse
    && reuse.port === rapid.port
    && reuseWindow.windows === 1
    && reuseWindow.pages === 1, [
    `kind ${reuse.launchKind}`,
    `port ${reuse.port} (first ${rapid.port})`,
    `launch events ${launchEvents - beforeReuse}`,
    `pages ${reuseWindow.pages}, unique windows ${reuseWindow.windows}`,
    `state ${reused.state}`
  ]);

  await reuse.cancel();
  await rapid.shutdown();
  reuse = null;
  rapid = null;
  await flow.shutdown();

  const unavailable = new DouyinBrowserLogin({
    dataDir: root,
    browser: null,
    login: {saveBrowserCookie: async () => ({ok: true})}
  });
  const missing = await unavailable.start();
  record('a missing browser is reported as unavailable, not as a fake QR', missing.state === BROWSER_LOGIN_STATES.UNAVAILABLE
    && missing.qr === null, [`state ${missing.state}, reason ${missing.error?.reason ?? 'none'}`]);
} catch (error) {
  record('browser login verification completed without an unexpected error', false, [
    String(error?.stack ?? error)
  ]);
} finally {
  for (const item of [reuse, rapid, flow]) {
    try {
      await item?.shutdown();
    } catch {
      /* best effort */
    }
  }
  try {
    rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  } catch {
    /* leave the temp profile behind rather than failing the check */
  }
  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  log('');
  log(`RESULT ${passed}/${results.length} checks passed, ${failed} failed`);
  log('NOTE: the QR was NOT scanned; a human with the Douyin app must complete that step.');
  if (failed > 0) process.exitCode = 1;
}
