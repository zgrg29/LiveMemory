import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, openSync, readFileSync, existsSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {APP_VERSION} from '../src/shared/app-info.mjs';
import {manifestLevel} from './pe-manifest.mjs';
import {prepareTestExe} from './test-exe-copy.mjs';

/**
 * Packaged usage-guide verification.
 *
 * Usage: node scripts/verify-help-exe.mjs [path\to\LiveMemory.exe]
 *
 * RC0-USAGE-GUIDE: proves the guide is present in the real Windows build, is
 * reachable from the packaged navigation/router, is translated in all three
 * languages and does not weaken the existing local API authentication.
 *
 * RC0-ADMIN-MANIFEST: the shipped EXE is requireAdministrator. Automated
 * sessions cannot accept the interactive UAC prompt, so functional checks launch
 * a test-only asInvoker copy of the same binary; the shipped manifest is checked
 * separately and real UAC acceptance remains a manual user step.
 *
 * A real browser cannot start inside this sandbox (Chromium's mojo channel is
 * denied), so this script checks the exact files the browser receives. The DOM
 * rendering itself is covered by tests/unit/help-ui.test.mjs with a read-only DOM
 * shim over the same dictionaries.
 */

const distExe = resolve(process.argv[2] ?? 'dist/LiveMemory.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-help-${stamp}`);
mkdirSync(root, {recursive: true});
const exe = prepareTestExe({source: distExe, target: join(root, 'LiveMemory-asInvoker.exe')});

const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let authCookie = null;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function record(name, passed, details = []) {
  results.push({name, passed, details});
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of details) log(`      ${line}`);
}

async function httpGet(url, {raw = false} = {}) {
  const headers = authCookie ? {cookie: authCookie} : {};
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(8000)});
  const text = await response.text();
  if (raw) return {status: response.status, text};
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {status: response.status, json, text};
}

async function waitFor(predicate, {timeoutMs = 30000, intervalMs = 250} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`);
}

function launch(args) {
  const stdoutFile = join(root, 'stdout.log');
  const stderrFile = join(root, 'stderr.log');
  const bootstrapFile = join(root, 'bootstrap.url');
  const child = spawn(exe, args, {
    env: {...process.env, LIVE_MEMORY_TEST_BOOTSTRAP_FILE: bootstrapFile},
    stdio: ['ignore', openSync(stdoutFile, 'w'), openSync(stderrFile, 'w')],
    windowsHide: true
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = {code, signal};
  });
  return {
    child,
    bootstrapFile,
    async stop() {
      if (exitInfo) return;
      child.kill('SIGKILL');
      const deadline = Date.now() + 8000;
      while (!exitInfo && Date.now() < deadline) await sleep(100);
    }
  };
}

function runtimeInfo(dataDir) {
  const file = join(dataDir, 'runtime', 'runtime.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function authenticate(baseUrl, bootstrapFile) {
  const browserUrl = await waitFor(() => {
    if (!bootstrapFile || !existsSync(bootstrapFile)) return null;
    const text = readFileSync(bootstrapFile, 'utf8').trim();
    return text || null;
  }, {timeoutMs: 15000});
  const token = new URL(browserUrl).hash.replace(/^#lm_bootstrap=/, '');
  const response = await fetch(new URL('/api/auth/session', baseUrl), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: decodeURIComponent(token)}),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 200) throw new Error(`auth exchange failed: HTTP ${response.status}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie.startsWith('lm_session=')) throw new Error('auth exchange returned no session cookie');
  authCookie = cookie;
}

async function waitForServer(dataDir) {
  return waitFor(async () => {
    const info = runtimeInfo(dataDir);
    if (!info?.url) return null;
    const health = await httpGet(new URL('/api/health', info.url).href);
    if (health.status !== 200 || health.json?.name !== 'LiveMemory') return null;
    return {info, health};
  });
}

const SECTION_IDS = ['start', 'connect', 'records', 'providers', 'analysis', 'memory', 'progress', 'backup', 'faq'];

async function main() {
  log('LiveMemory packaged usage-guide verification');
  log(`  shipped exe: ${distExe}`);
  log(`  shipped sha256: ${createHash('sha256').update(readFileSync(distExe)).digest('hex')}`);
  log(`  test copy: ${exe} (asInvoker; automated sessions cannot accept UAC)`);
  log(`  work:   ${root}`);
  log('');

  const manifest = manifestLevel(readFileSync(distExe));
  record('shipped EXE requests administrator rights (requireAdministrator, UAC prompt)', manifest === 'requireAdministrator', [
    `manifest: ${manifest}`,
    `functional checks use a test-only asInvoker copy: ${exe}`
  ]);

  const dataDir = join(root, 'data');
  const app = launch(['--no-open', '--data-dir', dataDir, '--port', '49260', '--lang', 'en']);
  try {
    const {info, health} = await waitForServer(dataDir);
    const base = info.url;
    record('packaged EXE starts and reports its build over HTTP', health.status === 200 && Boolean(health.json?.buildId), [
      `url: ${base}`,
      `version: ${health.json?.version}`,
      `buildId: ${health.json?.buildId}`
    ]);

    const unauthBootstrap = await httpGet(new URL('/api/bootstrap', base).href);
    const unauthStatus = await httpGet(new URL('/api/auth/status', base).href);
    record('the guide did not weaken local API authentication', unauthBootstrap.status === 401 && unauthStatus.status === 200, [
      `unauthenticated /api/bootstrap -> ${unauthBootstrap.status}`,
      `public /api/auth/status -> ${unauthStatus.status}`
    ]);

    await authenticate(base, app.bootstrapFile);

    const bootstrap = await httpGet(new URL('/api/bootstrap', base).href);
    record('authenticated bootstrap keeps schema 16 and the build identity', bootstrap.status === 200
      && bootstrap.json?.status?.database?.schemaVersion === 16
      && bootstrap.json?.app?.version === APP_VERSION
      && Boolean(bootstrap.json?.app?.build?.buildId), [
      `schema: ${bootstrap.json?.status?.database?.schemaVersion}`,
      `app version: ${bootstrap.json?.app?.version}`,
      `buildId: ${bootstrap.json?.app?.build?.buildId}`
    ]);

    const index = await httpGet(new URL('/index.html', base).href, {raw: true});
    record('the console ships a navigation entry for the usage guide', index.status === 200
      && index.text.includes('href="#/help" data-nav="help"'), [
      `nav entry present: ${index.text.includes('data-nav="help"')}`
    ]);

    const appJs = await httpGet(new URL('/js/app.js', base).href, {raw: true});
    record('the packaged router resolves #/help to the guide page', appJs.status === 200
      && appJs.text.includes("import {helpPage} from './pages/help.js'")
      && /page: helpPage, nav: 'help'/.test(appJs.text));

    const helpJs = await httpGet(new URL('/js/pages/help.js', base).href, {raw: true});
    const missingSections = SECTION_IDS.filter((id) => !helpJs.text.includes(`id: '${id}'`));
    record('the packaged guide module is served and declares all nine sections', helpJs.status === 200
      && missingSections.length === 0
      && !/innerHTML|outerHTML|insertAdjacentHTML/.test(helpJs.text)
      && !/\/api\//.test(helpJs.text), [
      `missing: ${missingSections.join(', ') || 'none'}`,
      'no innerHTML: ' + String(!/innerHTML|outerHTML|insertAdjacentHTML/.test(helpJs.text)),
      'no API calls: ' + String(!/\/api\//.test(helpJs.text))
    ]);

    const baseCss = await httpGet(new URL('/styles/base.css', base).href, {raw: true});
    record('the navigation icon for the guide is packaged', baseCss.status === 200
      && baseCss.text.includes('.nav-item[data-nav="help"] .nav-icon'));

    const pagesCss = await httpGet(new URL('/styles/pages.css', base).href, {raw: true});
    record('the guide layout and its narrow-screen rules are packaged', pagesCss.status === 200
      && pagesCss.text.includes('.help-layout')
      && /@media \(max-width: 1000px\)[\s\S]*?\.help-layout \{\s*grid-template-columns: 1fr;/.test(pagesCss.text)
      && /@media \(max-width: 700px\)[\s\S]*?\.help-terms \{\s*grid-template-columns: 1fr;/.test(pagesCss.text));

    const dictionaries = {};
    for (const locale of ['zh-CN', 'ja', 'en']) {
      const response = await httpGet(new URL(`/i18n/${locale}.json`, base).href);
      dictionaries[locale] = response.status === 200 ? response.json : null;
    }
    const reference = dictionaries.en?.help;
    const parityOk = Object.values(dictionaries).every((dictionary) => dictionary?.help
      && JSON.stringify(collectKeys(dictionary.help)) === JSON.stringify(collectKeys(reference)));
    record('all three packaged dictionaries expose the same guide keys', pathsOk(dictionaries) && parityOk, [
      `keys: ${collectKeys(reference).length}`
    ]);

    const contentProblems = [];
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const id of SECTION_IDS) {
        const section = dictionary?.help?.sections?.[id];
        if (!section) {
          contentProblems.push(`${locale}:${id} missing`);
          continue;
        }
        if (typeof section.title !== 'string' || !section.title.trim()) contentProblems.push(`${locale}:${id}.title`);
        if (typeof section.lead !== 'string' || !section.lead.trim()) contentProblems.push(`${locale}:${id}.lead`);
        const expectedSteps = id === 'memory' ? 4 : (id === 'faq' ? 0 : 6);
        for (let index = 1; index <= expectedSteps; index += 1) {
          if (typeof section[`step${index}`] !== 'string' || !section[`step${index}`].trim()) {
            contentProblems.push(`${locale}:${id}.step${index}`);
          }
        }
        if (id === 'faq') {
          for (let index = 1; index <= 8; index += 1) {
            if (!section[`q${index}`] || !section[`a${index}`]) contentProblems.push(`${locale}:${id}.q${index}`);
          }
        }
        if (id === 'memory') {
          for (const term of ['fact', 'stated', 'inferred', 'uncertain', 'status', 'evidence']) {
            if (!section.term?.[term]?.label || !section.term?.[term]?.desc) contentProblems.push(`${locale}:${id}.term.${term}`);
          }
        }
        const notes = id === 'connect' ? ['noteBilibili', 'noteYoutube'] : ['note'];
        for (const note of notes) {
          if (typeof section[note] !== 'string' || !section[note].trim()) contentProblems.push(`${locale}:${id}.${note}`);
        }
      }
    }
    record('the packaged guide covers all nine requested topics in every language', contentProblems.length === 0, [
      `problems: ${contentProblems.slice(0, 6).join(', ') || 'none'}`
    ]);

    const zh = dictionaries['zh-CN']?.help?.sections ?? {};
    const en = dictionaries.en?.help?.sections ?? {};
    const coverageOk = String(zh.connect?.step2 ?? '').includes('live.bilibili.com')
      && String(zh.connect?.step3 ?? '').includes('youtube.com')
      && String(zh.providers?.step3 ?? '').includes('API Key')
      && String(zh.analysis?.step5 ?? '').includes('开始 AI 分析')
      && String(zh.memory?.term?.stated?.label ?? '').includes('明确')
      && String(zh.progress?.step3 ?? '').includes('继续')
      && String(zh.backup?.step3 ?? '').includes('RESTORE')
      && /No Google login/.test(String(en.connect?.step3 ?? ''))
      && /not that the meaning is correct/.test(String(en.memory?.note ?? ''));
    record('the copy names the real platforms, AI setup, recovery and restore paths', coverageOk);

    const noLimitsOk = /不限制观众数量、消息数量、直播时长、分析次数、Token、费用或批次数量/.test(String(zh.analysis?.note ?? ''))
      && /不会要求你审核 AI 画像/.test(String(zh.analysis?.note ?? ''))
      && /no limits on viewer count, message count, stream length/.test(String(en.analysis?.note ?? ''));
    record('the guide states that no usage limits or forced AI review were added', noLimitsOk);

    const localePatch = await fetch(new URL('/api/settings', base), {
      method: 'PATCH',
      headers: {'content-type': 'application/json', cookie: authCookie},
      body: JSON.stringify({locale: 'ja'}),
      signal: AbortSignal.timeout(5000)
    });
    const patched = await localePatch.json();
    const bootstrapJa = await httpGet(new URL('/api/bootstrap', base).href);
    record('switching to Japanese still applies to the whole console', localePatch.status === 200
      && patched?.effective?.locale === 'ja'
      && bootstrapJa.json?.effective?.locale === 'ja', [
      `effective locale: ${patched?.effective?.locale ?? 'n/a'}`
    ]);
  } catch (error) {
    record('verification aborted', false, [`${error?.stack ?? error}`]);
  } finally {
    await app.stop();
  }

  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  log('');
  log(`Summary: ${passed} passed, ${failed} failed, ${results.length} checks`);
  writeFileSync(join(root, 'report.json'), JSON.stringify({exe, results}, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

function collectKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) collectKeys(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push(prefix);
  }
  return out;
}

function pathsOk(dictionaries) {
  return Object.values(dictionaries).every((dictionary) => dictionary?.nav?.help && dictionary?.help);
}

main();
