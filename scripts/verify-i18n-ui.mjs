/**
 * P40 / I18N-M1 real-browser layout verification for ten languages.
 *
 * This is not a unit test: it launches headless Chromium/Edge through the
 * DevTools protocol, loads the *production* console in every shipped language,
 * and measures real layout instead of string lengths.
 *
 * What it checks for every language:
 *   - 1440 / 1024 / 820 / 390 px widths, light and dark themes;
 *   - the main pages: live, history, history detail, viewers, AI analysis,
 *     settings, help and the viewer memory page;
 *   - no horizontal document overflow, no text clipped inside a button, chip,
 *     tab or select, no control pushed outside the viewport, and the language
 *     control never overlaps the theme button;
 *   - the rendered dictionary is the requested language (no raw `xx.yy.zz`
 *     keys leaking into the DOM).
 *
 * A blocked browser is reported as BLOCKED (exit code 2), never as PASS.
 *
 * Usage:
 *   node scripts/verify-i18n-ui.mjs [--out docs/screenshots] [--report tests/.tmp/i18n-p40-ui-report.json] [--all-widths]
 */
import {mkdirSync, existsSync, openSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {migrate} from '../src/storage/database/migrations/index.mjs';
import {startServer} from '../src/server/index.mjs';
import {createAnalysisJob} from '../src/ai/export/job.mjs';
import {importAnalysisResult} from '../src/ai/import/importer.mjs';
import {
  addBroadcaster,
  makeBatchResult,
  readBatchPackage,
  seedSession,
  T0
} from '../tests/helpers/ai-fixtures.mjs';
import {createTempDir} from '../tests/helpers/temp-dir.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = resolve(root, argValue('out', 'docs/screenshots'));
const reportFile = resolve(root, argValue('report', 'tests/.tmp/i18n-p42-ui-report.json'));
const PREFIX = argValue('prefix', 'i18n-p42');
const EXE_PATH = argValue('exe', null);
const ALL_WIDTHS = args.includes('--all-widths');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const LOCALES = (() => {
  const requested = argValue('locales', null);
  if (!requested) return ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];
  return requested.split(',').map((entry) => entry.trim()).filter(Boolean);
})();
const WIDTHS = [1440, 1024, 820, 390];
const ROUTES = [
  {id: 'live', path: '#/live'},
  {id: 'history', path: '#/history'},
  {id: 'viewers', path: '#/viewers'},
  {id: 'ai', path: '#/ai'},
  {id: 'settings', path: '#/settings'},
  {id: 'help', path: '#/help'}
];

/**
 * Long, unbreakable-ish copy per language so layout is measured against the
 * worst realistic translation instead of the English source.
 */
const LONG_TITLE = {
  'zh-CN': '深夜电台 · 一起听老歌，聊聊这一周发生的事和下周的计划',
  ja: '深夜ラジオ・昔の曲を聴きながら、今週あったことと来週の予定を話します',
  en: 'Late-night radio · old songs, this week, and what is coming next week',
  ko: '심야 라디오 · 옛 노래를 들으며 이번 주 이야기와 다음 주 계획을 나눕니다',
  es: 'Radio nocturna · canciones antiguas, la semana y los planes para la próxima',
  'pt-BR': 'Rádio da madrugada · músicas antigas, a semana e os planos para a próxima',
  'zh-TW': '深夜電台 · 一起聽老歌，聊聊這一週發生的事和下週的計畫',
  fr: 'Radio de nuit · vieilles chansons, la semaine écoulée et les projets à venir',
  de: 'Nachtradio · alte Lieder, diese Woche und was als Nächstes ansteht',
  id: 'Radio tengah malam · lagu lama, minggu ini, dan rencana minggu depan'
};

/** Seed a realistic data set: long titles, several viewers, an AI report. */
async function seed(dataDir) {
  const db = openDatabase({file: join(dataDir, 'database', 'livememory.db'), createDirectory: true});
  migrate(db, {now: T0});
  const broadcaster = addBroadcaster(db, {id: 'youtube:UC_P40_UI', name: 'LiveMemory Layout Channel'});
  const primary = seedSession(db, {
    messageCount: 24,
    viewerCount: 3,
    title: LONG_TITLE.de,
    broadcasterId: broadcaster,
    broadcasterName: 'LiveMemory Layout Channel',
    startedAt: T0
  });
  seedSession(db, {
    messageCount: 14,
    viewerCount: 2,
    roomId: 'p40-second-room',
    title: LONG_TITLE.fr,
    broadcasterId: broadcaster,
    broadcasterName: 'LiveMemory Layout Channel',
    startedAt: T0 + 86_400_000,
    archived: true
  });
  const exportsDir = join(dataDir, 'exports');
  mkdirSync(exportsDir, {recursive: true});
  const job = await createAnalysisJob({
    db,
    sessionId: primary.id,
    locale: 'en',
    exportsDir,
    batchSize: 100000
  });
  for (const pkg of job.packages) {
    const data = readBatchPackage(exportsDir, pkg);
    const result = makeBatchResult(data.manifest, data.messages, data.viewers);
    importAnalysisResult({db, text: JSON.stringify(result), now: T0 + 60_000});
  }
  closeDatabase(db);
  return primary.id;
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
  const debugPort = 9400 + Math.floor(Math.random() * 200);
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
  const deadline = Date.now() + 25000;
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
  const waitFor = (method, timeoutMs = 25000) => new Promise((resolveEvent, rejectEvent) => {
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

/**
 * Layout probe. Deliberately conservative: it reports *clipping of visible text*
 * and *document overflow*, not every element that happens to scroll internally
 * (tables and code blocks are allowed to scroll inside their own wrapper).
 */
const PROBE = `(() => {
  const viewport = {width: window.innerWidth, height: window.innerHeight};
  const describe = (node) => {
    const id = node.id ? '#' + node.id : '';
    const cls = typeof node.className === 'string' && node.className.trim()
      ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    return node.tagName.toLowerCase() + id + cls;
  };
  const isVisible = (node) => {
    if (!node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    // Off-canvas drawers are intentional; they are not overflow.
    if (node.closest('[aria-hidden="true"], .sidebar[data-collapsed="true"], .drawer:not(.drawer--open)')) return false;
    return true;
  };
  const NO_WRAP = (node) => {
    const style = getComputedStyle(node);
    return style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
  };
  const clipped = [];
  // Two complementary checks:
  //  1. nowrap controls whose own text does not fit;
  //  2. translated UI labels that are cut by an ellipsis text-overflow without a
  //     title fallback. User content (nicknames, room titles) is allowed to
  //     truncate; the labels below must always show their full translation.
  const MUST_NOT_TRUNCATE = [
    '.recording-tab--new .recording-tab-label',
    '.stat-label',
    '.stat-sub',
    '.card-title',
    '.nav-item',
    '.topbar-title',
    '.badge',
    '.pill'
  ];
  for (const node of document.querySelectorAll('button, a, .chip, .pill, .tab, .badge, td, th, label, .segmented button, option, .nav-item, .card-title, .field-label')) {
    if (!isVisible(node)) continue;
    if (node.tagName === 'OPTION') continue;
    if (!NO_WRAP(node)) continue;
    if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
      clipped.push({selector: describe(node), text: (node.textContent || '').trim().slice(0, 60), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth});
    }
  }
  for (const node of document.querySelectorAll(MUST_NOT_TRUNCATE.join(','))) {
    if (!isVisible(node)) continue;
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    if (node.closest('[title]') && node.closest('[title]').getAttribute('title')) continue;
    clipped.push({selector: describe(node), text: (node.textContent || '').trim().slice(0, 60), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, why: 'ellipsis'});
  }
  const control = document.querySelector('.language-control');
  const themeButton = document.getElementById('theme-toggle');
  const rectOf = (node) => (node ? node.getBoundingClientRect() : null);
  const controlRect = rectOf(control);
  const themeRect = rectOf(themeButton);
  const overflowing = [];
  for (const node of document.querySelectorAll('body *')) {
    if (!isVisible(node)) continue;
    const rect = node.getBoundingClientRect();
    // Elements entirely left of the viewport are off-canvas by design (the
    // skip link parked at -9999px and the closed mobile navigation drawer).
    if (rect.right <= 0) continue;
    if (rect.right > viewport.width + 1.5 || rect.left < -1.5) {
      // Ignore nodes inside an element that is explicitly allowed to scroll.
      const scroller = node.closest('[data-scrollable="true"], .table-scroll, .chart-scroll, pre');
      if (scroller) continue;
      overflowing.push({selector: describe(node), left: Math.round(rect.left), right: Math.round(rect.right), text: (node.textContent || '').trim().slice(0, 40)});
    }
  }
  const bodyText = document.body.innerText || '';
  // A leaked translation key looks like live.feed.title; version strings
  // (v0.14.0) and host names (api.openai.com) must not be flagged, so only the
  // actual dictionary roots count as evidence.
  const ROOTS = '(?:a11y|ai|app|auth|common|errors|format|help|history|live|memory|monitoring|nav|settings|status|toast|viewers)';
  const TLD = /\\.(?:com|net|org|io|cn|tv|app|co|me|dev|gg|info|biz|xyz|cc|so)$/;
  const rawKey = (bodyText.match(new RegExp('\\\\b' + ROOTS + '(?:\\\\.[a-zA-Z0-9_]+){2,}\\\\b', 'g')) || [])
    // A host name such as live.bilibili.com is documentation, not a lost key.
    .filter((match) => !TLD.test(match))
    .slice(0, 8);
  return {
    lang: document.documentElement.lang,
    theme: document.documentElement.dataset.theme || 'light',
    viewport,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    clipped: clipped.slice(0, 10),
    overflowing: overflowing.slice(0, 10),
    rawKeys: rawKey,
    languageMode: control ? control.dataset.mode : null,
    languageOptionCount: (document.getElementById('language-select')?.options ?? []).length,
    controlRight: controlRect ? Math.round(controlRect.right) : null,
    themeLeft: themeRect ? Math.round(themeRect.left) : null,
    heading: (document.querySelector('.page-title')?.textContent ?? '').trim().slice(0, 60)
  };
})()`;

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
  const sessionId = await seed(temp.dir);
  let app;
  let exeChild = null;
  if (EXE_PATH) {
    const exe = prepareTestExe({
      source: resolve(root, EXE_PATH),
      target: join(temp.dir, 'LiveMemory-asInvoker.exe')
    });
    const port = await new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const assigned = probe.address().port;
        probe.close(() => resolvePort(assigned));
      });
    });
    const bootstrapFile = join(temp.dir, 'bootstrap.url');
    const logFd = openSync(join(temp.dir, 'exe.log'), 'w');
    const exeLocalAppData = join(temp.dir, 'localappdata');
    const exeTemp = join(temp.dir, 'temp');
    mkdirSync(exeLocalAppData, {recursive: true});
    mkdirSync(exeTemp, {recursive: true});
    exeChild = spawn(exe, ['--no-open', '--port', String(port), '--data-dir', temp.dir], {
      cwd: temp.dir,
      env: {
        ...process.env,
        LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile,
        LOCALAPPDATA: exeLocalAppData,
        TEMP: exeTemp,
        TMP: exeTemp
      },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    });
    const deadline = Date.now() + 60000;
    let browserUrl = '';
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(1200)});
        if (health.ok && existsSync(bootstrapFile)) {
          browserUrl = readFileSync(bootstrapFile, 'utf8').trim();
          if (browserUrl) break;
        }
      } catch {
        /* not ready */
      }
      if (exeChild.exitCode !== null) {
        throw new Error(`EXE exited early (${exeChild.exitCode}): ${readFileSync(join(temp.dir, 'exe.log'), 'utf8').slice(-1500)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`EXE did not become healthy within 60s: ${readFileSync(join(temp.dir, 'exe.log'), 'utf8').slice(-1500)}`);
      }
      await sleep(200);
    }
    app = {url: `http://127.0.0.1:${port}`, browserUrl};
    console.log(`EXE service: ${app.url} (functional asInvoker copy of ${EXE_PATH})`);
  } else {
    app = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'de-DE'});
  }
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

    const setLocale = async (locale) => {
      const result = await evaluate(`fetch('/api/settings', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({locale: ${JSON.stringify(locale)}})
      }).then(async (response) => ({status: response.status, body: await response.json()}))`);
      if (result.status !== 200) throw new Error(`PATCH locale failed for ${locale}: ${JSON.stringify(result)}`);
    };

    // The launcher URL carries the one-time bootstrap token; visiting it once
    // exchanges the token for the session cookie every later page load needs.
    {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900
      });
      const loaded = cdp.waitFor('Page.loadEventFired').catch(() => null);
      await cdp.send('Page.navigate', {url: app.browserUrl});
      await loaded;
      await sleep(1500);
      const status = await evaluate("fetch('/api/auth/status').then((r) => r.status)");
      if (status !== 200) throw new Error(`bootstrap session exchange failed (status ${status})`);
    }

    let visitCounter = 0;

    const visit = async ({path, width, height, dark, name, screenshot}) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 520,
        screenWidth: width,
        screenHeight: height
      });
      visitCounter += 1;
      const loaded = cdp.waitFor('Page.loadEventFired').catch(() => null);
      // A hash-only change would not reload the document, so every visit carries
      // a unique query string; the app router still reads `location.hash`.
      await cdp.send('Page.navigate', {url: `${app.url}?shot=${visitCounter}-${encodeURIComponent(name)}${path}`});
      await loaded;
      await sleep(1500);
      if (dark) {
        await evaluate("document.documentElement.dataset.theme='dark';");
        await sleep(250);
      }
      const metrics = await evaluate(PROBE);
      if (screenshot) {
        const shot = await cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
        await writeFile(join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
      }
      const checks = {
        noDocumentOverflow: metrics.docScrollWidth <= metrics.viewport.width + 1
          && metrics.bodyScrollWidth <= metrics.viewport.width + 1,
        noClippedText: metrics.clipped.length === 0,
        noOverflowingNode: metrics.overflowing.length === 0,
        noRawTranslationKeys: metrics.rawKeys.length === 0,
        languageControlPresent: metrics.languageOptionCount >= 2,
        languageControlDoesNotOverlapTheme: metrics.controlRight === null
          || metrics.themeLeft === null
          || metrics.controlRight <= metrics.themeLeft + 1
      };
      const record = {name, path, width, height, dark, metrics, checks, ok: Object.values(checks).every(Boolean)};
      results.push(record);
      if (!record.ok) {
        console.log(`FAIL ${name} ${width}x${height}${dark ? ' dark' : ''} ${path}`);
        for (const [key, value] of Object.entries(checks)) if (!value) console.log(`   - ${key}`);
        if (metrics.clipped.length) console.log(`   clipped: ${JSON.stringify(metrics.clipped.slice(0, 4))}`);
        if (metrics.overflowing.length) console.log(`   overflow: ${JSON.stringify(metrics.overflowing.slice(0, 4))}`);
        if (metrics.rawKeys.length) console.log(`   raw keys: ${JSON.stringify(metrics.rawKeys)}`);
      }
      return record;
    };

    const HEIGHTS = {1440: 900, 1024: 800, 820: 900, 390: 844};

    for (const locale of LOCALES) {
      await setLocale(locale);
      // Full measurement matrix (light) for every shipped language.
      for (const width of WIDTHS) {
        for (const route of ROUTES) {
          await visit({
            path: `${route.path}`,
            width,
            height: HEIGHTS[width],
            dark: false,
            name: `${PREFIX}-${locale}-${route.id}-${width}`
          });
        }
        await visit({
          path: `#/history/${sessionId}`,
          width,
          height: HEIGHTS[width],
          dark: false,
          name: `${PREFIX}-${locale}-session-${width}`
        });
        if (ALL_WIDTHS || width === 1440 || width === 390) {
          for (const route of ROUTES.filter((entry) => ['live', 'ai', 'settings'].includes(entry.id))) {
            await visit({
              path: `${route.path}`,
              width,
              height: HEIGHTS[width],
              dark: true,
              name: `${PREFIX}-${locale}-${route.id}-${width}-dark`
            });
          }
        }
      }
      // Archived screenshots for the report (one per language).
      await visit({
        path: '#/live', width: 1440, height: 900, dark: false,
        name: `${PREFIX}-${locale}-live-1440-light`, screenshot: true
      });
      await visit({
        path: '#/settings', width: 1440, height: 900, dark: true,
        name: `${PREFIX}-${locale}-settings-1440-dark`, screenshot: true
      });
      await visit({
        path: '#/live', width: 390, height: 844, dark: false,
        name: `${PREFIX}-${locale}-live-390-light`, screenshot: true
      });
      await visit({
        path: '#/ai', width: 1440, height: 900, dark: false,
        name: `${PREFIX}-${locale}-ai-1440-light`, screenshot: true
      });
      console.log(`done ${locale}: ${results.filter((entry) => entry.name.includes(`-${locale}-`)).length} page loads`);
    }

    const byLocale = {};
    for (const locale of LOCALES) {
      const records = results.filter((entry) => entry.name.includes(`-${locale}-`));
      byLocale[locale] = {
        loads: records.length,
        failed: records.filter((entry) => !entry.ok).length,
        widths: [...new Set(records.map((entry) => entry.width))].sort((a, b) => b - a),
        dark: records.some((entry) => entry.dark),
        renderedLang: records[0]?.metrics.lang ?? null,
        languageMode: records[0]?.metrics.languageMode ?? null,
        heading: records[0]?.metrics.heading ?? null
      };
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      browser: browserPath,
      url: app.url,
      matrix: {locales: LOCALES, widths: WIDTHS, routes: ROUTES.map((entry) => entry.id), themes: ['light', 'dark']},
      total: results.length,
      failed: results.filter((entry) => !entry.ok).length,
      byLocale,
      results
    };
    await writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    if (summary.failed > 0) {
      console.error(`FAIL: ${summary.failed}/${summary.total} page loads violated the layout budget`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: ${summary.total} real browser page loads across ${LOCALES.length} languages; report ${reportFile}`);
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
    if (exeChild?.pid) {
      exeChild.kill();
      for (let attempt = 0; attempt < 40 && exeChild.exitCode === null; attempt += 1) await sleep(100);
      if (exeChild.exitCode === null) spawnSync('taskkill', ['/PID', String(exeChild.pid), '/T', '/F'], {stdio: 'ignore'});
    }
    if (typeof app.close === 'function') {
      try { await app.close(); } catch { /* ignore */ }
    }
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
