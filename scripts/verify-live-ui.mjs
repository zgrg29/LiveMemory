/**
 * Development-only UI verification for the tabbed live page.
 *
 * Requires:
 *   1. a running server with multiple live recordings (scripts/demo-multi-recording.mjs)
 *   2. headless Edge/Chrome with --remote-debugging-port
 *
 *   node scripts/verify-live-ui.mjs --port 9223 --base http://127.0.0.1:48350
 *
 * It drives the real page over the DevTools protocol: tab switching, leaderboard
 * search and scroll, viewer-profile navigation, page re-entry and the narrow
 * layout. The demo recordings are simulated, so this verifies the console, not a
 * real platform capture.
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const debugPort = Number(argValue('--port', 9223));
const base = String(argValue('--base', 'http://127.0.0.1:48350')).replace(/\/$/, '');
const report = {base, checks: []};

function record(name, passed, details = {}) {
  report.checks.push({name, passed, ...details});
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}

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

async function navigate(hash, {width = 1440, height = 1040, mobile = false, wait = 2600} = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  await send('Page.navigate', {url: `${base}/#${hash}`});
  await loaded;
  await sleep(wait);
}

function snapshotExpression() {
  return `(() => {
    const rows = [...document.querySelectorAll('.leaderboard-scroll .top-item--interactive')];
    const scroll = document.querySelector('.leaderboard-scroll');
    const newTab = document.querySelector('.recording-tab--new');
    const selected = document.querySelector('.recording-tab-group[data-selected="true"] .recording-tab');
    const rect = newTab?.getBoundingClientRect() ?? null;
    return {
      hash: location.hash,
      title: document.querySelector('.hero-title')?.textContent ?? null,
      selectedTab: selected?.querySelector('.recording-tab-label')?.textContent ?? null,
      tabs: [...document.querySelectorAll('.recording-tab-group .recording-tab-label')].map((n) => n.textContent),
      newTabVisible: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth),
      rows: rows.length,
      firstRow: rows[0]?.textContent ?? null,
      countText: document.querySelector('.leaderboard-count')?.textContent ?? null,
      scrollable: Boolean(scroll && scroll.scrollHeight > scroll.clientHeight + 1),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      lastError: window.__lmLastError ?? null
    };
  })()`;
}

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', {cacheDisabled: true});

await navigate('/live');
let view = await evaluate(snapshotExpression());
record('live page opens with three recording tabs', view.tabs.length === 3, {
  tabs: view.tabs,
  selected: view.selectedTab,
  title: view.title,
  lastError: view.lastError
});
record('the new-recording tab stays visible', view.newTabVisible === true);

view = await evaluate(snapshotExpression());
record('the Top 100 leaderboard is populated and scrollable', view.rows === 100 && view.scrollable, {
  rows: view.rows,
  count: view.countText,
  scrollable: view.scrollable
});

const scrollPreserved = await evaluate(`(async () => {
  const host = document.querySelector('.leaderboard-scroll');
  host.scrollTop = 180;
  const before = host.scrollTop;
  await new Promise((resolve) => setTimeout(resolve, 6000));
  return {before, after: host.scrollTop, rows: host.querySelectorAll('.top-item--interactive').length};
})()`);
record('live leaderboard updates keep the scroll position', scrollPreserved.rows === 100 && Math.abs(scrollPreserved.after - scrollPreserved.before) <= 8, scrollPreserved);

const before = view.title;
await evaluate("document.querySelectorAll('.recording-tab-group .recording-tab')[0]?.click(); 'clicked'");
await sleep(1600);
const alpha = await evaluate(snapshotExpression());
await evaluate("document.querySelectorAll('.recording-tab-group .recording-tab')[1]?.click(); 'clicked'");
await sleep(1600);
const bravo = await evaluate(snapshotExpression());
record('switching tabs changes the displayed broadcast', alpha.title !== bravo.title && alpha.title !== before, {
  before,
  alpha: alpha.title,
  bravo: bravo.title,
  alphaTab: alpha.selectedTab,
  bravoTab: bravo.selectedTab
});
record('each tab keeps its own leaderboard count', alpha.countText !== null && bravo.countText !== null, {
  alpha: alpha.countText,
  bravo: bravo.countText
});

await evaluate("document.querySelectorAll('.recording-tab-group .recording-tab')[0]?.click(); 'clicked'");
await sleep(1200);
const searchResult = await evaluate(`(async () => {
  const input = document.querySelector('.leaderboard-search');
  input.value = 'Top Viewer';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const rows = [...document.querySelectorAll('.leaderboard-scroll .top-item--interactive')];
  return {
    rows: rows.length,
    first: rows[0]?.textContent ?? null,
    count: document.querySelector('.leaderboard-count')?.textContent ?? null
  };
})()`);
record('leaderboard search filters the current session without losing ranks', searchResult.rows === 1 && /^#\d+/.test(searchResult.first ?? ''), searchResult);

const profile = await evaluate(`(async () => {
  const input = document.querySelector('.leaderboard-search');
  input.value = '';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  await new Promise((resolve) => setTimeout(resolve, 400));
  document.querySelector('.leaderboard-scroll .top-item--interactive')?.click();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {hash: location.hash, title: document.querySelector('.viewer-name')?.textContent ?? null};
})()`);
record('clicking a viewer opens the profile with broadcaster context', /^#\/viewers\//.test(profile.hash) && profile.hash.includes('broadcaster=') && Boolean(profile.title), profile);

await navigate('/live');
view = await evaluate(snapshotExpression());
record('returning to the live page still shows every running recording', view.tabs.length === 3 && view.rows === 100, {
  tabs: view.tabs,
  rows: view.rows
});

await navigate('/live', {width: 390, height: 900, mobile: true});
const mobile = await evaluate(snapshotExpression());
record('narrow layout keeps "New recording" reachable without horizontal overflow', mobile.newTabVisible && !mobile.horizontalOverflow && mobile.tabs.length === 3, {
  newTabVisible: mobile.newTabVisible,
  horizontalOverflow: mobile.horizontalOverflow,
  tabs: mobile.tabs
});
record('narrow layout keeps the scrollable top-100 panel', mobile.rows === 100 && mobile.scrollable, {
  rows: mobile.rows,
  scrollable: mobile.scrollable
});

const failed = report.checks.filter((check) => !check.passed);
console.log(`\nSummary: ${report.checks.length - failed.length} passed, ${failed.length} failed`);
socket.close();
process.exit(failed.length === 0 ? 0 : 1);
