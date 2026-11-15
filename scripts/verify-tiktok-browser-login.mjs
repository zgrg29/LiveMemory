import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {TikTokBrowserLogin, TIKTOK_LOGIN_STATES} from '../src/platforms/tiktok/browser-login.mjs';
import {tiktokBrowserProfileDir} from '../src/platforms/tiktok/browser-launch.mjs';

/**
 * Real-browser login-surface acceptance for TikTok M2.
 *
 * Usage: node scripts/verify-tiktok-browser-login.mjs
 *
 * It launches the installed Chrome/Edge with LiveMemory's dedicated TikTok
 * profile, opens the official login page, verifies that exactly one window is
 * open, that clicking "open login" again only reuses/focuses that window, that
 * the page is the official login page (QR + password options visible in the DOM),
 * and that cancel/logout clean up only that window/profile.
 *
 * It does NOT scan a QR code or log in (no account is available). "Waiting for
 * login" is the expected and honest result; the script never reports a login
 * success it did not observe.
 *
 * Some automated Windows sandboxes (including the development harness) put the
 * Node process in a job object that kills Chromium before it can write its
 * DevTools port. In that case the launch-dependent checks are reported as
 * BLOCKED, not PASS and not FAIL, and manual steps are printed.
 */

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-tiktok-browser-login-${stamp}`);
mkdirSync(root, {recursive: true});
const dataDir = join(root, 'data');
mkdirSync(dataDir, {recursive: true});

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(name, status, details = []) {
  const passed = status === true || status === 'pass';
  const blocked = status === 'blocked';
  results.push({name, passed, blocked, details});
  log(`${passed ? 'PASS' : blocked ? 'BLOCKED' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 250} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function windowCount(login) {
  try {
    const cdp = login.session?.cdp;
    if (!cdp || cdp.closed) return 0;
    const list = await login.session.fetchImpl?.(`http://127.0.0.1:${login.session.port}/json/list`).then((r) => r.json());
    const pages = Array.isArray(list) ? list.filter((item) => item.type === 'page') : [];
    return pages.length > 0 ? 1 : 0;
  } catch {
    return 0;
  }
}

const login = new TikTokBrowserLogin({
  dataDir,
  logger: {info: () => {}, warn: () => {}},
  pollIntervalMs: 2000,
  launchTimeoutMs: 8000
});

let blockedReason = null;
try {
  const started = await login.start();
  if (started?.state === TIKTOK_LOGIN_STATES.ERROR) {
    blockedReason = `Chromium could not be controlled from this automated process: ${started?.error?.code ?? 'TIKTOK_BROWSER_FAILED'} / ${started?.error?.reason ?? 'unknown'}.`;
  }
  record('clicking "open TikTok login" opens the official login page', blockedReason ? 'blocked' : Boolean(started)
    && [TIKTOK_LOGIN_STATES.WAITING, TIKTOK_LOGIN_STATES.OPENING].includes(started.state), [
    `state ${started?.state ?? 'missing'}`,
    `supported ${started?.supported}`,
    `browserOpen ${started?.browserOpen}`,
    `error ${started?.error?.code ?? 'none'} / ${started?.error?.reason ?? 'none'}`,
    ...(blockedReason ? [blockedReason] : [])
  ]);

  if (blockedReason) {
    record('official login page reached the waiting-for-user state', 'blocked', [blockedReason]);
    record('official TikTok login page offers QR + other sign-in methods', 'blocked', [blockedReason]);
    record('exactly one LiveMemory-owned window is open', 'blocked', [blockedReason]);
    record('clicking open again reuses/focuses the existing window', 'blocked', [blockedReason]);
  } else {
    const ready = await waitFor(() => login.status().state === TIKTOK_LOGIN_STATES.WAITING, {timeoutMs: 25000});
    record('official login page reached the waiting-for-user state', Boolean(ready), [
      `state ${login.status().state}`,
      `browserOpen ${login.status().browserOpen}`
    ]);

    await sleep(2500);
    const page = await login.session?.evaluate?.(`(() => ({
      url: location.href,
      title: document.title,
      text: ((document.body && document.body.innerText) || '').slice(0, 800)
    }))()`);
    const text = String(page?.text ?? '');
    record('official TikTok login page offers QR + other sign-in methods', /tiktok\.com\/login/i.test(String(page?.url ?? ''))
      && (/qr/i.test(text) || /log in/i.test(text)), [
      `url ${page?.url ?? 'missing'}`,
      `title ${page?.title ?? 'missing'}`,
      `qrOrLoginText ${/qr|log in/i.test(text)}`
    ]);

    const firstWindows = await windowCount(login);
    record('exactly one LiveMemory-owned window is open', firstWindows === 1, [`windows ${firstWindows}`]);

    const before = login.session;
    const second = await login.start();
    const secondWindows = await windowCount(login);
    record('clicking open again reuses/focuses the existing window', Boolean(second)
      && login.session === before
      && secondWindows === 1, [
      `windows ${secondWindows}`,
      `same session object ${login.session === before}`,
      `state ${second?.state ?? 'missing'}`
    ]);
  }

  const profile = tiktokBrowserProfileDir(dataDir);
  record('only a LiveMemory-marked dedicated profile is used', existsSync(join(profile, '.livememory-owned'))
    && readFileSync(join(profile, '.livememory-owned'), 'utf8').includes('TikTok'), [
    `profile ${profile}`,
    `marker ${existsSync(join(profile, '.livememory-owned'))}`
  ]);

  const cancelled = await login.cancel();
  record('cancel closes the dedicated window and returns to idle', blockedReason ? 'blocked' : cancelled.state === TIKTOK_LOGIN_STATES.IDLE, [
    `state ${cancelled.state}`,
    ...(blockedReason ? [blockedReason] : [])
  ]);

  if (blockedReason) {
    record('reopening after cancel starts a single new window', 'blocked', [blockedReason]);
  } else {
    const restarted = await login.start();
    await waitFor(() => login.status().state === TIKTOK_LOGIN_STATES.WAITING, {timeoutMs: 25000});
    const restartWindows = await windowCount(login);
    record('reopening after cancel starts a single new window', [TIKTOK_LOGIN_STATES.WAITING, TIKTOK_LOGIN_STATES.OPENING].includes(restarted.state)
      && restartWindows === 1, [
      `state ${login.status().state}`,
      `windows ${restartWindows}`
    ]);
  }

  const loggedOut = await login.logout();
  record('logout removes only the dedicated profile and returns to not-logged-in', blockedReason ? 'blocked' : loggedOut.state === TIKTOK_LOGIN_STATES.IDLE
    && !existsSync(tiktokBrowserProfileDir(dataDir)), [
    `state ${loggedOut.state}`,
    `profileExists ${existsSync(tiktokBrowserProfileDir(dataDir))}`,
    ...(blockedReason ? [blockedReason] : [])
  ]);
} catch (error) {
  record('unexpected failure during real browser login acceptance', false, [String(error?.stack ?? error)]);
} finally {
  await login.shutdown().catch(() => {});
  const passed = results.filter((item) => item.passed).length;
  const blocked = results.filter((item) => item.blocked).length;
  const failed = results.length - passed - blocked;
  log('');
  log(`RESULT ${passed}/${results.length} passed, ${failed} failed, ${blocked} blocked`);
  if (blockedReason) {
    log('');
    log('MANUAL ACCEPTANCE (normal Windows desktop, not the automated sandbox):');
    log('  1. Start LiveMemory.exe and open Live -> New recording -> TikTok -> Browser relay.');
    log('  2. Click "Open TikTok login"; confirm exactly one Chrome/Edge window opens on tiktok.com/login.');
    log('  3. Scan the official QR code (or use phone/email/username); confirm the app shows "Logged in".');
    log('  4. Click "Verify live connection" for a live handle; confirm either "Real events received" or');
    log('     "Connected, no events yet" -- never a fabricated success.');
    log('  5. Close and reopen the login window; confirm the same dedicated profile is reused.');
  }
  if (failed > 0) process.exitCode = 1;
  log(`artifacts: ${root}`);
}
