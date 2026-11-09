/**
 * Development-only UI verification for history management and search.
 *
 * Requires:
 *   1. scripts/demo-history.mjs running (seeded, simulated history)
 *   2. headless Chrome/Edge with --remote-debugging-port
 *
 *   node scripts/verify-history-ui.mjs --port 9224 --base http://127.0.0.1:48360
 *
 * It drives the real console through the DevTools protocol: title / broadcaster
 * / viewer search, combined filters, archive and unarchive, stopping a live
 * recording from the history list, permanent deletion with confirmation, the
 * detail-page menu, keyboard handling, narrow layout and theme/language.
 * The fixture is simulated, so this verifies the UI, not a real platform capture.
 */

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const debugPort = Number(argValue('--port', 9224));
const base = String(argValue('--base', 'http://127.0.0.1:48360')).replace(/\/$/, '');
const shotsDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const reportDir = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
mkdirSync(shotsDir, {recursive: true});
mkdirSync(reportDir, {recursive: true});

const report = {base, checks: []};
function record(name, passed, details = {}) {
  report.checks.push({name, passed, ...details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

// Deterministic English / light UI for the assertion text.
await fetch(`${base}/api/settings`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({locale: 'en', theme: 'light'})
});

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page target in the debugging browser');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
});

let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
    return;
  }
  if (message.method) {
    const waiters = eventWaiters.get(message.method) ?? [];
    eventWaiters.set(message.method, []);
    for (const resolve of waiters) resolve(message.params);
  }
});

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}

function waitForEvent(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const list = eventWaiters.get(method) ?? [];
    list.push((params) => {
      clearTimeout(timer);
      resolve(params);
    });
    eventWaiters.set(method, list);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, {timeout = 8000, interval = 120} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${expression}`);
    await sleep(interval);
  }
}

async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
}

async function navigate(hash, {width = 1440, height = 1100, mobile = false, wait = 1800} = {}) {
  await viewport(width, height, mobile);
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  // A unique query forces a real reload even when only the hash is reused.
  await send('Page.navigate', {url: `${base}/?verify=${Date.now()}#${hash}`});
  await loaded;
  await sleep(wait);
}

async function screenshot(name, height = 1100) {
  const result = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  const path = join(shotsDir, name);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  return path;
}

const LIST_SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll('.history-row')].map((row) => ({
    id: row.dataset.sessionId,
    title: row.querySelector('.history-title')?.textContent ?? '',
    chips: [...row.querySelectorAll('.history-sub .chip')].map((chip) => chip.textContent),
    reasons: [...row.querySelectorAll('.history-reasons .chip')].map((chip) => chip.textContent),
    viewers: [...row.querySelectorAll('.history-viewer-match')].map((node) => node.textContent),
    broadcaster: row.querySelector('.history-broadcaster')?.textContent ?? null
  }));
  return {
    hash: location.hash,
    title: document.querySelector('.page-title')?.textContent ?? null,
    rows,
    summary: document.querySelector('.history-summary')?.textContent ?? null,
    empty: document.querySelector('.history-results .empty-title')?.textContent ?? null,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    menuOpen: Boolean(document.querySelector('.action-menu')),
    lastError: window.__lmLastError ?? null
  };
})()`;

async function setSearch(value) {
  await evaluate(`(() => {
    const input = document.querySelector('.history-search-input');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  await sleep(650);
}

async function select(selector, value) {
  await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  await sleep(600);
}

async function clickMenuAction(label) {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.action-menu-item')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!item) throw new Error('menu item not found: ' + ${JSON.stringify(label)});
    item.click();
    return true;
  })()`);
  await sleep(450);
}

async function openRowMenu(index = 0) {
  await evaluate(`(() => {
    const button = document.querySelectorAll('.history-row .history-actions')[${index}];
    if (!button) throw new Error('action button not found');
    button.click();
    return true;
  })()`);
  await sleep(300);
}

async function confirmDelete() {
  await waitFor("Boolean(document.querySelector('.modal'))");
  await evaluate(`(() => {
    const input = document.querySelector('.modal input[type="checkbox"]');
    input.checked = true;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  await sleep(150);
  await evaluate(`(() => {
    const button = document.querySelector('.modal .button--danger');
    if (!button || button.disabled) throw new Error('delete button is not enabled');
    button.click();
    return true;
  })()`);
}

/* --------------------------------------------------------------- open list */

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', {cacheDisabled: true});

await navigate('/history');
let view = await evaluate(LIST_SNAPSHOT);
record('history list opens with sessions and no runtime error', view.rows.length === 6 && !view.lastError, {
  rows: view.rows.length,
  summary: view.summary,
  lastError: view.lastError
});
record('archived sessions are hidden by default', !view.rows.some((row) => row.title.includes('Archive Me')));
await screenshot('history-list-v070-light-en.png');

/* ------------------------------------------------------------------ search */

await setSearch('Minecraft');
view = await evaluate(LIST_SNAPSHOT);
record('title search finds the Chinese/English mixed title', view.rows.length === 1 && view.rows[0].reasons.includes('Title match'), {
  rows: view.rows.length,
  reasons: view.rows[0]?.reasons
});

await setSearch('小王');
view = await evaluate(LIST_SNAPSHOT);
record('viewer nickname search returns both identities on different platforms', view.rows.length === 2 && view.rows.every((row) => row.reasons.includes('Viewer participation')), {
  rows: view.rows.length,
  reasons: view.rows.map((row) => row.reasons),
  viewers: view.rows.map((row) => row.viewers)
});
record('matched viewer rows show distinct platform ids', view.rows.every((row) => row.viewers.length === 1)
  && new Set(view.rows.map((row) => row.viewers[0])).size === 2);
await screenshot('history-search-viewer-v070-light-en.png');

const viewerNavigation = await evaluate(`(async () => {
  document.querySelector('.history-viewer-match').click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    hash: location.hash,
    card: Boolean(document.querySelector('.history-viewer-card')),
    messages: document.querySelectorAll('.history-viewer-message').length,
    uid: document.querySelector('.history-viewer-card .mono')?.textContent ?? null
  };
})()`);
record('clicking a matched viewer opens the session detail at that viewer', viewerNavigation.card
  && viewerNavigation.hash.includes('viewer=')
  && viewerNavigation.messages >= 1
  && /youtube:|bilibili:/.test(viewerNavigation.uid ?? ''), viewerNavigation);
await sleep(500);
await screenshot('history-detail-viewer-v070-light-en.png', 1250);

await navigate('/history');
await setSearch('主播甲');
view = await evaluate(LIST_SNAPSHOT);
record('broadcaster name search finds that broadcaster history', view.rows.length >= 2
  && view.rows.every((row) => row.reasons.includes('Broadcaster match'))
  && view.rows.every((row) => row.broadcaster === '主播甲'), {
  rows: view.rows.length,
  broadcasters: view.rows.map((row) => row.broadcaster)
});

await setSearch('小王');
await select('.history-filters select', 'youtube');
view = await evaluate(LIST_SNAPSHOT);
record('viewer search combines with the platform filter', view.rows.length === 1 && view.rows[0].title.includes('Minecraft'), {
  rows: view.rows.map((row) => row.title)
});

await evaluate(`(() => {
  const input = document.querySelector('.history-search-input');
  input.value = '';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  const platform = document.querySelectorAll('.history-filters select')[0];
  platform.value = 'all';
  platform.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);
await sleep(700);

/* ---------------------------------------------------------------- archive */

await evaluate(`(() => {
  const checkbox = document.querySelector('.filter-check input');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()`);
await sleep(700);
await setSearch('Archive Me');
view = await evaluate(LIST_SNAPSHOT);
record('include-archived reveals the archived session with a chip', view.rows.length === 1 && view.rows[0].chips.includes('Archived'), {
  rows: view.rows.length,
  chips: view.rows[0]?.chips
});

await openRowMenu(0);
let menu = await evaluate(`(() => [...document.querySelectorAll('.action-menu-item')].map((node) => node.textContent.trim()))()`);
record('archived row offers unarchive and permanent delete', menu.includes('Unarchive') && menu.includes('Delete permanently') && !menu.includes('Archive'), {menu});
await clickMenuAction('Unarchive');
await sleep(900);
view = await evaluate(LIST_SNAPSHOT);
record('unarchive restores the row to normal history', view.rows.length === 1 && !view.rows[0].chips.includes('Archived'), {
  chips: view.rows[0]?.chips
});
await openRowMenu(0);
menu = await evaluate(`(() => [...document.querySelectorAll('.action-menu-item')].map((node) => node.textContent.trim()))()`);
record('unarchived row offers archive and permanent delete', menu.includes('Archive') && menu.includes('Delete permanently'), {menu});
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await sleep(250);

/* ------------------------------------------------------------------- stop */

await evaluate(`(() => {
  const input = document.querySelector('.history-search-input');
  input.value = '';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  return true;
})()`);
await sleep(400);
await setSearch('Stop Me');
view = await evaluate(LIST_SNAPSHOT);
record('the running simulated recording appears in history as live', view.rows.length === 1 && view.rows[0].chips.includes('Live'), {
  chips: view.rows[0]?.chips
});
await openRowMenu(0);
menu = await evaluate(`(() => [...document.querySelectorAll('.action-menu-item')].map((node) => node.textContent.trim()))()`);
record('a live session only offers stop (no archive/delete)', menu.length === 1 && menu[0] === 'Stop recording', {menu});
await clickMenuAction('Stop recording');
const stopDialog = await waitFor(`(() => {
  const modal = document.querySelector('.modal');
  return modal ? {
    title: modal.querySelector('.modal-title')?.textContent,
    note: modal.querySelector('.callout')?.textContent ?? ''
  } : null;
})()`);
record('stop confirmation explains that the platform broadcast may continue', /still be live|may/i.test(stopDialog.note), stopDialog);
await evaluate(`(() => {
  document.querySelector('.modal .button--primary')?.click();
  return true;
})()`);
await sleep(1400);
view = await evaluate(LIST_SNAPSHOT);
record('stopping from the history list updates the status immediately', view.rows.length === 1 && view.rows[0].chips.includes('Recording stopped'), {
  chips: view.rows[0]?.chips
});
await openRowMenu(0);
menu = await evaluate(`(() => [...document.querySelectorAll('.action-menu-item')].map((node) => node.textContent.trim()))()`);
record('a stopped session can now be archived or deleted', menu.includes('Archive') && menu.includes('Delete permanently'), {menu});
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await sleep(200);

/* ----------------------------------------------------------------- delete */

await setSearch('Delete Me');
view = await evaluate(LIST_SNAPSHOT);
record('delete target is found before deletion', view.rows.length === 1);
await openRowMenu(0);
await clickMenuAction('Delete permanently');
await waitFor("Boolean(document.querySelector('.modal'))");
const deleteDialog = await evaluate(`(() => {
  const modal = document.querySelector('.modal');
  return {
    title: modal.querySelector('.modal-title')?.textContent,
    body: modal.textContent,
    disabled: modal.querySelector('.button--danger')?.disabled
  };
})()`);
record('delete confirmation shows broadcaster, title and date and is disabled first', deleteDialog.disabled === true
  && deleteDialog.body.includes('主播甲')
  && deleteDialog.body.includes('Delete Me 永久删除测试')
  && /20\d\d/.test(deleteDialog.body), {title: deleteDialog.title, disabled: deleteDialog.disabled});
await screenshot('history-delete-confirm-v070-light-en.png', 1100);
await confirmDelete();
await waitFor("Boolean(document.querySelector('.history-search-input')) && location.hash === '#/history'", {timeout: 10000});
await sleep(900);
await setSearch('Delete Me');
view = await evaluate(LIST_SNAPSHOT);
record('permanently deleted session disappears from history and search', view.rows.length === 0 && Boolean(view.empty), {
  rows: view.rows.length,
  empty: view.empty
});

/* ------------------------------------------------------------ detail menu */

await setSearch('English Talk Show');
view = await evaluate(LIST_SNAPSHOT);
await evaluate(`(() => { document.querySelector('.history-row').click(); return true; })()`);
await sleep(1400);
let detail = await evaluate(`(() => ({
  hash: location.hash,
  title: document.querySelector('.detail-title')?.textContent,
  menu: Boolean(document.querySelector('.history-actions-trigger')),
  chips: [...document.querySelectorAll('.detail-meta .chip')].map((chip) => chip.textContent)
}))()`);
record('detail page shows the management menu in the title area', detail.menu === true && detail.title.includes('English Talk Show'), detail);
await evaluate(`(() => { document.querySelector('.history-actions-trigger').click(); return true; })()`);
await sleep(300);
await clickMenuAction('Archive');
await sleep(1200);
detail = await evaluate(`(() => ({
  hash: location.hash,
  chips: [...document.querySelectorAll('.detail-meta .chip')].map((chip) => chip.textContent),
  notice: document.body.textContent.includes('This session is archived')
}))()`);
record('archiving from detail updates the page and keeps the detail open', detail.notice === true && detail.hash.includes('/history/'), detail);
await screenshot('history-detail-archived-v070-light-en.png', 1250);

await evaluate(`(() => { document.querySelector('.history-actions-trigger').click(); return true; })()`);
await sleep(300);
await clickMenuAction('Delete permanently');
await confirmDelete();
await waitFor("location.hash === '#/history'", {timeout: 10000});
await sleep(900);
await setSearch('English Talk Show');
view = await evaluate(LIST_SNAPSHOT);
record('deleting from detail returns to the list with the row gone', view.rows.length === 0, {rows: view.rows.length});

/* --------------------------------------------------------------- keyboard */

await setSearch('');
view = await evaluate(LIST_SNAPSHOT);
const keyboard = await evaluate(`(async () => {
  const button = document.querySelector('.history-row .history-actions');
  button.focus();
  return {focused: document.activeElement === button};
})()`);
await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
await send('Input.dispatchKeyEvent', {type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
await sleep(350);
let keyboardState = await evaluate(`(() => ({
  open: Boolean(document.querySelector('.action-menu')),
  activeRole: document.activeElement?.getAttribute('role')
}))()`);
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40});
await sleep(150);
const afterArrow = await evaluate("document.activeElement?.textContent ?? null");
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await sleep(250);
const afterEscape = await evaluate(`(() => ({
  open: Boolean(document.querySelector('.action-menu')),
  focusIsTrigger: document.activeElement?.classList.contains('history-actions') ?? false
}))()`);
record('keyboard opens the action menu, moves focus and Escape closes it', keyboard.focused
  && keyboardState.open && keyboardState.activeRole === 'menuitem'
  && Boolean(afterArrow) && !afterEscape.open && afterEscape.focusIsTrigger, {
  keyboard,
  keyboardState,
  afterArrow,
  afterEscape
});

/* ---------------------------------------------------------------- responsive */

await navigate('/history', {width: 390, height: 900, mobile: true});
view = await evaluate(LIST_SNAPSHOT);
record('narrow layout has no horizontal overflow and keeps the search toolbar', !view.horizontalOverflow
  && Boolean(await evaluate("document.querySelector('.history-toolbar')")) && view.rows.length >= 3, {
  rows: view.rows.length,
  horizontalOverflow: view.horizontalOverflow
});
await openRowMenu(0);
const menuBox = await evaluate(`(() => {
  const rect = document.querySelector('.action-menu')?.getBoundingClientRect();
  return rect ? {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight} : null;
})()`);
record('the action menu stays inside a narrow viewport', Boolean(menuBox)
  && menuBox.left >= 0 && menuBox.right <= menuBox.width + 1
  && menuBox.top >= 0 && menuBox.bottom <= menuBox.height + 1, menuBox);
await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
await sleep(200);
await evaluate("document.activeElement?.blur(); 'blurred'");
await sleep(150);
await screenshot('history-list-v070-mobile-en.png', 900);

/* ------------------------------------------------------------ theme/language */

await navigate('/history', {width: 1440, height: 1100});
await evaluate("document.querySelector('#theme-toggle').click(); 'clicked'");
await sleep(500);
await evaluate("[...document.querySelectorAll('#language-segmented button')].find((node) => node.dataset.locale === 'zh-CN').click(); 'clicked'");
await sleep(1400);
const themed = await evaluate(`(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  lang: document.documentElement.lang,
  title: document.querySelector('.page-title')?.textContent,
  rows: document.querySelectorAll('.history-row').length,
  searchPlaceholder: document.querySelector('.history-search-input')?.placeholder ?? null,
  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
}))()`);
record('dark theme and Chinese copy render without losing the list', themed.theme === 'dark'
  && themed.lang === 'zh-CN'
  && themed.title === '直播历史'
  && themed.rows >= 3
  && /主播|标题|观众/.test(themed.searchPlaceholder ?? ''), themed);
await screenshot('history-list-v070-dark-zh.png', 1150);

// Leave the fixture in English / light for any later manual inspection.
await fetch(`${base}/api/settings`, {
  method: 'PATCH',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({locale: 'en', theme: 'light'})
});

const failed = report.checks.filter((check) => !check.passed);
console.log(`\nSummary: ${report.checks.length - failed.length} passed, ${failed.length} failed`);
writeFileSync(join(reportDir, 'history-ui-v070-report.json'), `${JSON.stringify(report, null, 2)}\n`);
socket.close();
process.exit(failed.length === 0 ? 0 : 1);
