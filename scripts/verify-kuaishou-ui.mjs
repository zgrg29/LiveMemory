#!/usr/bin/env node
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * Kuaishou preview UI verification over the real DevTools protocol.
 *
 * Requires a running LiveMemory server and a headless Edge/Chrome with
 * --remote-debugging-port:
 *
 *   node scripts/verify-kuaishou-ui.mjs --port 9445 --base http://127.0.0.1:49300
 *
 * It switches the interface language/theme through the product settings API,
 * opens the Kuaishou tab, checks the mandatory disclosure, exercises link
 * parsing while collection is disabled, verifies the disabled start button and
 * measures horizontal overflow at 1440/1024/820/390 in light and dark themes.
 * Screenshots are written to the output directory (tests/.tmp by default).
 */

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const debugPort = Number(argValue('--port', 9445));
const base = String(argValue('--base', 'http://127.0.0.1:49300')).replace(/\/$/, '');
const outDir = resolve(argValue('--out', 'tests/.tmp/kuaishou-ui'));
mkdirSync(outDir, {recursive: true});

const LOCALES = (argValue('--locales', 'zh-CN,ja,en,ko,es,pt-BR,zh-TW,fr,de,id')).split(',').map((s) => s.trim()).filter(Boolean);
const WIDTHS = {1440: 900, 1024: 768, 820: 1000, 390: 844};
const dictionary = (locale) => JSON.parse(readFileSync(join('src/web/i18n', `${locale}.json`), 'utf8'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no page target in the debugging browser');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener('open', done, {once: true});
  socket.addEventListener('error', fail, {once: true});
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const {resolve: done, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else done(message.result);
  }
});

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((done, reject) => {
    pending.set(id, {resolve: done, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
  return result.result?.value;
}

async function waitFor(expression, {timeout = 12000, interval = 150} = {}) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(expression)) return true;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${expression}`);
    await sleep(interval);
  }
}

async function setPreferences(locale, theme) {
  const result = await evaluate(`fetch('/api/settings', {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({locale: ${JSON.stringify(locale)}, theme: ${JSON.stringify(theme)}})
  }).then(async (response) => ({status: response.status, body: await response.text()}))`);
  if (result.status !== 200) throw new Error(`PATCH preferences failed: ${JSON.stringify(result)}`);
}

async function openKuaishou(locale) {
  const newText = dictionary(locale).live.tabs.new;
  await waitFor("Boolean(document.querySelector('.live-tabs'))", {timeout: 15000});
  await waitFor("document.body.innerText.includes(" + JSON.stringify(newText) + ")", {timeout: 15000});
  const tabText = dictionary(locale).live.source.kuaishouTab;
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.source-tabs button')]
      .find((entry) => entry.textContent.trim() === ${JSON.stringify(tabText)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Kuaishou tab not found for ${locale}`);
  await waitFor("document.body.innerText.includes(" + JSON.stringify(dictionary(locale).live.source.kuaishouIntro) + ")");
}

async function parseLink(locale) {
  const checkText = dictionary(locale).live.source.kuaishouCheck;
  const startText = dictionary(locale).live.source.kuaishouStartDisabled;
  const result = await evaluate(`(() => {
    const input = document.querySelector('.source-panel input.input');
    const button = [...document.querySelectorAll('.source-panel button')]
      .find((entry) => entry.textContent.trim() === ${JSON.stringify(checkText)});
    if (!input || !button) return {ok: false, reason: 'input_or_button_missing'};
    input.value = 'https://live.kuaishou.com/u/abc12345';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    button.click();
    return {ok: true};
  })()`);
  if (!result.ok) throw new Error(`parse link failed for ${locale}: ${result.reason}`);
  await waitFor("document.body.innerText.includes('abc12345')");
  await waitFor(`[...document.querySelectorAll('button')].some((entry) => entry.textContent.trim() === ${JSON.stringify(startText)} && entry.disabled)`);
}

const results = [];
function record(name, passed, details = []) {
  results.push({name, passed, details});
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}\n`);
  for (const line of details) process.stdout.write(`      ${line}\n`);
}

let failures = 0;
for (const locale of LOCALES) {
  const dict = dictionary(locale);
  for (const [widthText, height] of Object.entries(WIDTHS)) {
    const width = Number(widthText);
    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light';
      try {
        await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width <= 820});
        await send('Page.navigate', {url: `${base}/?ui=${Date.now()}#/live`});
        // The settings API must be called from the app origin, not about:blank.
        await waitFor("Boolean(document.querySelector('.live-tabs'))", {timeout: 15000});
        await setPreferences(locale, theme);
        await send('Page.reload', {ignoreCache: true});
        await sleep(250);
        await openKuaishou(locale);
        const check = await evaluate(`(() => {
          const text = document.body.innerText;
          const panel = document.querySelector('.source-panel');
          const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
          const rect = panel ? panel.getBoundingClientRect() : null;
          const clipped = rect ? (rect.left < -1 || rect.right > window.innerWidth + 1) : false;
          const rawKey = text.includes('live.source.kuaishou');
          return {
            notice: text.includes(${JSON.stringify(dict.live.source.kuaishouNotice)}),
            intro: text.includes(${JSON.stringify(dict.live.source.kuaishouIntro)}),
            access: text.includes(${JSON.stringify(dict.live.source.kuaishouAccessTitle)}),
            identity: text.includes(${JSON.stringify(dict.live.source.kuaishouIdentityNote)}),
            gift: text.includes(${JSON.stringify(dict.live.source.kuaishouGiftNote)}),
            overflow, clipped, rawKey,
            theme: document.documentElement.dataset.theme ?? null,
            panelWidth: rect ? Math.round(rect.width) : null
          };
        })()`);
        const passed = check.notice && check.intro && check.access && check.identity && check.gift
          && !check.overflow && !check.clipped && !check.rawKey && check.theme === theme;
        record(`${locale} ${width} ${theme}`, passed, [
          `notice=${check.notice} access=${check.access} identity=${check.identity} gift=${check.gift}`,
          `overflow=${check.overflow} clipped=${check.clipped} rawKey=${check.rawKey} theme=${check.theme}`,
          `panelWidth=${check.panelWidth}`
        ]);
        if (width === 1440 || width === 390) {
          const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
          writeFileSync(join(outDir, `kuaishou-${locale}-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
        }
        if (width === 1440 && !dark) await parseLink(locale);
      } catch (error) {
        failures += 1;
        record(`${locale} ${width} ${theme}`, false, [`${error?.message ?? error}`]);
      }
    }
  }
}

const passed = results.filter((entry) => entry.passed).length;
const failed = results.length - passed;
writeFileSync(join(outDir, 'report.json'), JSON.stringify({base, results}, null, 2));
process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed, ${results.length} checks\n`);
process.stdout.write(`Screenshots: ${outDir}\n`);
socket.close();
process.exit(failed > 0 ? 1 : 0);
