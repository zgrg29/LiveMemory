/**
 * Development-only UI capture helper.
 *
 * Headless Chromium's `--screenshot` flag waits for network idle, which never
 * happens on the console because the live event stream (SSE) stays open. This
 * script drives the DevTools protocol directly: navigate, wait a moment, capture.
 *
 * Usage (browser must already run with --remote-debugging-port):
 *   node scripts/capture-ui.mjs --port 9223 --base http://127.0.0.1:48300 --out tests/.tmp/shots
 */
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));

const debugPort = Number(args.port ?? 9223);
const base = String(args.base ?? 'http://127.0.0.1:48300').replace(/\/$/, '');
const outDir = String(args.out ?? 'tests/.tmp/shots');
mkdirSync(outDir, {recursive: true});

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page target');

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

async function capture(name, {width = 1440, height = 1040, path = '/live', wait = 1800, mobile = false, script = null, preScript = null, reload = false} = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
  const loaded = waitForEvent('Page.loadEventFired').catch(() => null);
  const url = `${base}/?shot=${encodeURIComponent(name)}#${path}`;
  await send('Page.navigate', {url});
  await loaded;
  await sleep(wait);
  if (preScript) {
    await send('Runtime.evaluate', {expression: preScript, awaitPromise: true});
    const reloaded = waitForEvent('Page.loadEventFired').catch(() => null);
    await send('Page.reload', {ignoreCache: true});
    await reloaded;
    await sleep(wait);
  }
  if (script) {
    await send('Runtime.evaluate', {expression: script, awaitPromise: true});
    await sleep(900);
  }
  if (reload) {
    const reloaded = waitForEvent('Page.loadEventFired').catch(() => null);
    await send('Page.reload', {ignoreCache: true});
    await reloaded;
    await sleep(wait);
  }
  const {data} = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`captured ${name} -> ${file}`);
}

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', {cacheDisabled: true});
const plan = args['plan-file']
  ? JSON.parse(readFileSync(String(args['plan-file']), 'utf8').replace(/^\uFEFF/, ''))
  : (args.plan ? JSON.parse(args.plan) : null);
if (plan) {
  for (const entry of plan) await capture(entry.name, entry);
} else {
  await capture('01-live-light-zh', {path: '/live'});
}
socket.close();
