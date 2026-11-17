#!/usr/bin/env node
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * Kick G3 console verification over the real DevTools protocol.
 *
 * Requires a running LiveMemory server with at least one live Kick recording and
 * a headless Edge/Chrome started with --remote-debugging-port:
 *
 *   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=...
 *   node scripts/verify-kick-ui.mjs --port 9333 --base http://127.0.0.1:59147
 *
 * It switches the interface language through the product's own settings API,
 * opens the Kick tab, checks the rendered language (no raw keys), verifies the
 * active Kick list is visible and measures layout overflow at 1440/1024/820/390
 * in light and dark themes. Screenshots are written to the output directory.
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const debugPort = Number(argValue('--port', 9333));
const base = String(argValue('--base', 'http://127.0.0.1:48350')).replace(/\/$/, '');
const outDir = resolve(argValue('--out', 'tests/.tmp/kick-ui'));
mkdirSync(outDir, {recursive: true});

const LOCALES = (argValue('--locales', 'zh-CN,en,ja,ko,es,pt-BR,zh-TW,fr,de,id')).split(',').map((s) => s.trim()).filter(Boolean);
const WIDTHS = {1440: 900, 1024: 768, 820: 1000, 390: 844};

const dictionary = (locale) => JSON.parse(readFileSync(join('src/web/i18n', `${locale}.json`), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
  return result.result?.value;
}

async function waitFor(expression, {timeout = 10000, interval = 150} = {}) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(expression)) return true;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${expression}`);
    await sleep(interval);
  }
}

async function setLocale(locale) {
  const result = await evaluate(`fetch('/api/settings', {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({locale: ${JSON.stringify(locale)}})
  }).then(async (response) => ({status: response.status, body: await response.text()}))`);
  if (result.status !== 200) throw new Error(`PATCH locale ${locale} failed: ${JSON.stringify(result)}`);
}

async function openKickTab(locale) {
  // The source selector lives in the "new recording" view, which is a tab.
  const newTab = await evaluate(`(() => {
    const button = document.querySelector('.recording-tab--new')
      ?? [...document.querySelectorAll('button')].find((entry) => (entry.textContent || '').includes('+'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!newTab) throw new Error(`new-recording tab not found for ${locale}`);
  await waitFor("document.querySelectorAll('.source-tabs button').length >= 5");
  const tabText = dictionary(locale).live.source.kickTab;
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.source-tabs button')]
      .find((entry) => entry.textContent.trim() === ${JSON.stringify(tabText)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Kick tab ${tabText} not found for ${locale}`);
  await waitFor("document.body.innerText.includes(" + JSON.stringify(dictionary(locale).live.source.kickIntro) + ")");
}

async function visit({locale, width, height, dark, screenshot = false}) {
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width <= 820});
  await send('Page.navigate', {url: `${base}/?ui=${Date.now()}#/live`});
  await waitFor("Boolean(document.querySelector('.live-tabs'))", {timeout: 15000});
  // Wait until the requested dictionary is actually applied, not just the shell.
  await waitFor("document.body.innerText.includes(" + JSON.stringify(dictionary(locale).live.tabs.new) + ")", {timeout: 15000});
  await sleep(200);
  await openKickTab(locale);
  if (dark) {
    await evaluate("document.documentElement.dataset.theme='dark'");
    await sleep(200);
  }
  const metrics = await evaluate(`(() => {
    const introFound = document.body.innerText.includes(${JSON.stringify(dictionary(locale).live.source.kickIntro)});
    const rawKey = /(?:live\\.source\\.kick|errors\\.kick)/.test(document.body.innerText);
    const rows = document.querySelectorAll('.tiktok-active-recordings .live-recording-row').length;
    const input = document.querySelector('.source-panel input.input');
    const button = [...document.querySelectorAll('.source-panel button')]
      .find((entry) => entry.textContent.trim().length > 0);
    const rect = (node) => node ? node.getBoundingClientRect() : null;
    const inputRect = rect(input);
    const buttonRect = rect(button);
    return {
      introFound,
      rawKey,
      recordings: rows,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      inputRight: inputRect ? Math.round(inputRect.right) : null,
      buttonRight: buttonRect ? Math.round(buttonRect.right) : null,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
        || (inputRect !== null && inputRect.right > window.innerWidth + 1)
        || (buttonRect !== null && buttonRect.right > window.innerWidth + 1)
    };
  })()`);
  const record = {locale, width, height, dark, screenshot, metrics};
  record.ok = metrics.introFound && !metrics.rawKey && !metrics.overflow && metrics.recordings >= 1;
  if (screenshot) {
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    const file = join(outDir, `kick-${locale}-${width}${dark ? '-dark' : ''}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    record.screenshotFile = file;
  }
  return record;
}

await send('Page.enable');
await send('Runtime.enable');
// The first visit gives the page an origin so relative /api/settings calls work.
await send('Page.navigate', {url: `${base}/#/live`});
await waitFor("Boolean(document.querySelector('.live-tabs'))", {timeout: 15000});
const results = [];
for (const locale of LOCALES) {
  await setLocale(locale);
  const widths = locale === 'zh-CN' || locale === 'en' ? Object.keys(WIDTHS) : ['1440'];
  for (const width of widths) {
    for (const dark of locale === 'zh-CN' ? [false, true] : [false]) {
      const record = await visit({locale, width: Number(width), height: WIDTHS[width], dark, screenshot: Number(width) === 1440 || Number(width) === 390});
      results.push(record);
      console.log(`${record.ok ? 'PASS' : 'FAIL'} ${locale} ${width}${dark ? ' dark' : ''} ` +
        `intro=${record.metrics.introFound} raw=${record.metrics.rawKey} recordings=${record.metrics.recordings} ` +
        `overflow=${record.metrics.overflow} scroll=${record.metrics.docScrollWidth}/${record.metrics.innerWidth}`);
    }
  }
}

const failed = results.filter((record) => !record.ok);
const report = {
  generatedAt: new Date().toISOString(),
  base,
  locales: LOCALES,
  total: results.length,
  failed: failed.length,
  results
};
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} Kick UI checks passed; screenshots: ${outDir}`);
process.exit(failed.length === 0 ? 0 : 1);
