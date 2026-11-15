import {existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {DouyinBrowserLogin, BROWSER_LOGIN_STATES} from '../src/platforms/douyin/browser-login.mjs';

/**
 * Real browser-assisted QR login plumbing check.
 *
 * It launches the installed Chrome/Edge with a dedicated LiveMemory profile,
 * opens the official Douyin login page, captures the QR that the official page
 * received, and cancels. It NEVER asks for or uses a Douyin account, and it
 * deliberately does not scan the QR: a human with the Douyin app must do that.
 *
 * Run:
 *   node scripts/verify-douyin-browser-login.mjs
 */

const root = join(process.cwd(), 'tests', '.tmp', `douyin-browser-verify-${process.pid}`);
const results = [];
const log = (line = '') => console.log(line);

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
    if (record?.event?.startsWith('douyin.login.browser')) log(`        log: ${record.event} ${JSON.stringify({...record, event: undefined})}`);
  },
  warn: (record) => log(`        warn: ${JSON.stringify(record)}`)
};

let flow = null;
try {
  rmSync(root, {recursive: true, force: true});
  flow = new DouyinBrowserLogin({
    dataDir: root,
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

  const cancelled = await flow.cancel();
  record('cancel closes the login and removes the QR', cancelled.state === BROWSER_LOGIN_STATES.CANCELLED
    && cancelled.qr === null, [`state ${cancelled.state}`]);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const cleared = flow.clearProfile();
  record('the dedicated browser profile can be deleted after cancel', cleared.removed === true, [
    `removed ${cleared.removed}, reason ${cleared.reason ?? 'none'}`,
    `profile exists ${existsSync(join(root, 'runtime', 'douyin-browser-profile'))}`
  ]);

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
  try {
    await flow?.shutdown();
  } catch {
    /* best effort */
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
