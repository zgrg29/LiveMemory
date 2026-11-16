/**
 * P39 / I18N-M0 real UI verification.
 *
 * Renders the actual header CSS and the actual language-control module in a
 * headless Chromium:
 *   1. the production console with the three shipped languages (zh-CN/ja/en);
 *   2. a test-only fixture with the ten planned languages.
 *
 * It records screenshots plus measured overflow/metrics. This script is not part
 * of `node --test` because it needs a browser; the environment may block
 * Chromium. A blocked launch is reported as BLOCKED, never as passed.
 *
 * Usage:
 *   node scripts/verify-i18n-ui.mjs [--out docs/screenshots] [--report tests/.tmp/i18n-ui-report.json]
 */
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';
import {createTempDir} from '../tests/helpers/temp-dir.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = resolve(root, argValue('out', 'docs/screenshots'));
const reportFile = resolve(root, argValue('report', 'tests/.tmp/i18n-ui-report.json'));
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}));

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function resolveStatic(roots, pathname) {
  const decoded = decodeURIComponent(pathname);
  for (const [prefix, rootDir] of roots) {
    if (!decoded.startsWith(prefix)) continue;
    const relative = decoded.slice(prefix.length);
    const base = resolve(rootDir);
    const candidate = normalize(join(base, relative));
    if (candidate !== base && !candidate.startsWith(base + sep)) return null;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
    return candidate;
  }
  return null;
}

async function startFixtureServer() {
  const roots = [
    ['/fixtures/', join(root, 'tests/fixtures')],
    ['/js/', join(root, 'src/web/js')],
    ['/styles/', join(root, 'src/web/styles')],
    ['/shared/', join(root, 'src/shared')],
    ['/i18n/', join(root, 'src/web/i18n')]
  ];
  const fixture = await readFile(join(root, 'tests/fixtures/i18n-header-10.html'));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {'Content-Type': MIME.get('.html'), 'Cache-Control': 'no-store'});
      res.end(fixture);
      return;
    }
    const file = resolveStatic(roots, url.pathname);
    if (!file) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('not found');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port: 0}, resolvePromise);
  });
  const address = server.address();
  return {server, base: `http://127.0.0.1:${address.port}`};
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function launchBrowser(browserPath, userDataDir) {
  const debugPort = 9300 + Math.floor(Math.random() * 200);
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank'
  ], {stdio: 'ignore', windowsHide: true, detached: false});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return {child, debugPort};
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error('headless Chromium did not expose the DevTools endpoint');
}

async function connect(debugPort) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let nextId = 0;
  const pending = new Map();
  const waiters = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const {resolve: resolveCall, reject: rejectCall} = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectCall(new Error(`${message.error.message} (${message.error.code})`));
      else resolveCall(message.result);
      return;
    }
    if (message.method) {
      const list = waiters.get(message.method) ?? [];
      waiters.set(message.method, []);
      for (const resolveEvent of list) resolveEvent(message.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    nextId += 1;
    const id = nextId;
    pending.set(id, {resolve: resolveCall, reject: rejectCall});
    socket.send(JSON.stringify({id, method, params}));
  });
  const waitFor = (method, timeoutMs = 20000) => new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => rejectEvent(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const list = waiters.get(method) ?? [];
    list.push((params) => {
      clearTimeout(timer);
      resolveEvent(params);
    });
    waiters.set(method, list);
  });
  return {socket, send, waitFor};
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('BLOCKED: no Chrome/Edge executable found');
    process.exitCode = 2;
    return;
  }
  await mkdir(outDir, {recursive: true});
  await mkdir(resolve(reportFile, '..'), {recursive: true});
  const temp = createTempDir();
  const app = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'zh-CN'});
  const fixture = await startFixtureServer();
  let browser = null;
  const results = [];
  try {
    browser = await launchBrowser(browserPath, join(temp.dir, 'chromium-profile'));
    const cdp = await connect(browser.debugPort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
      return result.result?.value;
    };

    const metricsExpression = `(() => {
      const viewport = {width: window.innerWidth, height: window.innerHeight};
      const control = document.querySelector('.language-control');
      const select = document.getElementById('language-select');
      const segmented = document.getElementById('language-segmented');
      const theme = document.getElementById('theme-toggle');
      const title = document.getElementById('page-title');
      const controlRect = control.getBoundingClientRect();
      const selectRect = select.getBoundingClientRect();
      const themeRect = theme.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const style = getComputedStyle(select);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const selected = select.options[select.selectedIndex];
      const label = selected ? selected.textContent : '';
      const textWidth = context.measureText(label).width
        + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const segmentedItems = [...segmented.querySelectorAll('button')].map((button) => ({
        text: button.textContent,
        clientWidth: button.clientWidth,
        scrollWidth: button.scrollWidth
      }));
      return {
        lang: document.documentElement.lang,
        mode: control.dataset.mode,
        optionCount: select.options.length,
        selectedLabel: label,
        segmentedButtons: segmented.querySelectorAll('button').length,
        segmentedItems,
        segmentedVisible: getComputedStyle(segmented).display !== 'none',
        selectVisible: getComputedStyle(select).display !== 'none' && selectRect.width > 0,
        control: {left: controlRect.left, right: controlRect.right, width: controlRect.width},
        select: {left: selectRect.left, right: selectRect.right, width: selectRect.width, clientWidth: select.clientWidth, scrollWidth: select.scrollWidth, textWidth},
        theme: {left: themeRect.left, right: themeRect.right},
        title: {left: titleRect.left, right: titleRect.right},
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        viewport
      };
    })()`;

    const capture = async (name, {url, width, height, fullPage = false, dark = false, wait = 1600}) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 520,
        screenWidth: width,
        screenHeight: height
      });
      const loaded = cdp.waitFor('Page.loadEventFired').catch(() => null);
      const navigationUrl = new URL(url);
      navigationUrl.searchParams.set('shot', name);
      await cdp.send('Page.navigate', {url: navigationUrl.href});
      await loaded;
      await sleep(wait);
      if (dark) {
        await evaluate("document.documentElement.dataset.theme='dark';");
        await sleep(200);
      }
      const metrics = await evaluate(metricsExpression);
      const screenshot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: fullPage ? undefined : {x: 0, y: 0, width, height: 190, scale: 1}
      });
      const file = join(outDir, `${name}.png`);
      await writeFile(file, Buffer.from(screenshot.data, 'base64'));
      const checks = {
        noHorizontalOverflow: metrics.docScrollWidth <= metrics.viewport.width + 1
          && metrics.bodyScrollWidth <= metrics.viewport.width + 1,
        controlInsideViewport: metrics.control.right <= metrics.viewport.width + 1
          && metrics.control.left >= -1,
        controlDoesNotOverlapTheme: metrics.control.right <= metrics.theme.left + 1,
        selectTextNotClipped: !metrics.selectVisible
          || metrics.select.width + 1 >= metrics.select.textWidth,
        segmentedTextNotClipped: !metrics.segmentedVisible
          || metrics.segmentedItems.every((item) => item.scrollWidth <= item.clientWidth + 1),
        selectHasOptions: metrics.optionCount >= 2
      };
      const record = {name, file, width, height, dark, metrics, checks, ok: Object.values(checks).every(Boolean)};
      results.push(record);
      console.log(`${record.ok ? 'PASS' : 'FAIL'} ${name} ${width}x${height} mode=${metrics.mode} options=${metrics.optionCount} label=${JSON.stringify(metrics.selectedLabel)} overflow=${metrics.docScrollWidth - metrics.viewport.width}px`);
      return record;
    };

    // --- Production console: the three real languages -----------------------
    const bootstrapUrl = app.browserUrl;
    await capture('i18n-p39-header-3lang-zh-CN-1440', {url: bootstrapUrl, width: 1440, height: 900});

    const setLocale = async (locale) => {
      const result = await evaluate(`fetch('/api/settings', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({locale: ${JSON.stringify(locale)}})
      }).then(async (response) => ({status: response.status, body: await response.json()}))`);
      if (result.status !== 200) throw new Error(`PATCH locale failed: ${JSON.stringify(result)}`);
      return result;
    };
    await setLocale('ja');
    await capture('i18n-p39-header-3lang-ja-1440', {url: `${app.url}#/live`, width: 1440, height: 900});
    await setLocale('en');
    await capture('i18n-p39-header-3lang-en-1440', {url: `${app.url}#/live`, width: 1440, height: 900});
    await setLocale('zh-CN');
    await capture('i18n-p39-header-3lang-zh-CN-390', {url: `${app.url}#/live`, width: 390, height: 844, fullPage: false});

    // --- Ten-language layout fixture ---------------------------------------
    for (const width of [1440, 1024, 820, 390]) {
      await capture(`i18n-p39-header-10lang-light-${width}`, {url: fixture.base, width, height: width <= 520 ? 844 : 900});
    }
    await capture('i18n-p39-header-10lang-dark-1440', {url: fixture.base, width: 1440, height: 900, dark: true});

    const appRecords = results.filter((entry) => entry.name.includes('3lang'));
    const fixtureRecords = results.filter((entry) => entry.name.includes('10lang'));
    const summary = {
      generatedAt: new Date().toISOString(),
      browser: browserPath,
      production: {
        localeOrder: appRecords.map((entry) => entry.metrics.lang),
        optionCounts: appRecords.map((entry) => entry.metrics.optionCount),
        segmentedButtons: appRecords[0]?.metrics.segmentedButtons,
        narrowUsesSelect: appRecords.find((entry) => entry.width === 390)?.metrics.selectVisible,
        allOk: appRecords.every((entry) => entry.ok)
      },
      fixture: {
        modes: fixtureRecords.map((entry) => entry.metrics.mode),
        optionCounts: fixtureRecords.map((entry) => entry.metrics.optionCount),
        widths: fixtureRecords.map((entry) => entry.width),
        allOk: fixtureRecords.every((entry) => entry.ok)
      },
      results
    };
    await writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    if (!summary.production.allOk || !summary.fixture.allOk) {
      console.error('FAIL: at least one layout check failed');
      process.exitCode = 1;
    } else {
      console.log(`PASS: ${results.length} real browser screenshots; report ${reportFile}`);
    }
    cdp.socket.close();
  } catch (error) {
    console.error(`BLOCKED/FAIL: ${error.message}`);
    process.exitCode = 2;
  } finally {
    if (browser?.child?.pid) {
      spawnSync('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], {stdio: 'ignore'});
      await sleep(400);
    }
    try { await app.close(); } catch { /* ignore */ }
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        temp.cleanup();
        break;
      } catch {
        await sleep(400);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
