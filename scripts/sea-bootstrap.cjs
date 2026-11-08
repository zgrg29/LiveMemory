/*
 * Windows SEA bootstrap.
 *
 * The single executable embeds the application sources as assets. On first run
 * (and after each version change) they are extracted into the user data folder,
 * because ES modules and the web console are loaded from disk. The database,
 * settings, logs and exports live beside that extraction folder — never next to
 * the executable, which may be read-only.
 *
 * This file is deliberately self-contained (it cannot `require` project files
 * before extraction) and it runs before any application code. That is why it
 * owns the earliest diagnostics: if extraction, asset reading or module loading
 * fails, the user still gets a localised message, a log file, and a window that
 * does not vanish before it can be read.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');

const MARKER_NAME = '.livememory-app.json';
const LOG_FILE_PREFIX = 'bootstrap';
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const MESSAGES = {
  'zh-CN': {
    title: 'LiveMemory 无法启动',
    detail: '详细信息：{message}',
    step: '失败步骤：{step}',
    code: '错误代码：{code}',
    logAt: '启动日志：{path}',
    noLog: '启动日志：无法写入任何日志目录',
    pressKey: '按任意键关闭此窗口。',
    appDir: '应用文件目录：{path}',
    dataDir: '数据目录：{path}'
  },
  ja: {
    title: 'LiveMemory を起動できません',
    detail: '詳細: {message}',
    step: '失敗した手順: {step}',
    code: 'エラーコード: {code}',
    logAt: '起動ログ: {path}',
    noLog: '起動ログ: 書き込み可能なフォルダーがありません',
    pressKey: '任意のキーを押すとこのウィンドウを閉じます。',
    appDir: 'アプリのフォルダー: {path}',
    dataDir: 'データフォルダー: {path}'
  },
  en: {
    title: 'LiveMemory could not start',
    detail: 'Details: {message}',
    step: 'Failed step: {step}',
    code: 'Error code: {code}',
    logAt: 'Startup log: {path}',
    noLog: 'Startup log: no writable log folder was found',
    pressKey: 'Press any key to close this window.',
    appDir: 'Application folder: {path}',
    dataDir: 'Data folder: {path}'
  }
};

function format(template, params = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function normalizeLocale(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.startsWith('ja')) return 'ja';
  if (text.startsWith('zh')) return 'zh-CN';
  if (text.startsWith('en')) return 'en';
  return null;
}

function pickLocale({env = process.env, settingsText = null, intlLocale = null} = {}) {
  const fromEnv = normalizeLocale(env.LIVE_MEMORY_LANG);
  if (fromEnv) return fromEnv;
  if (settingsText) {
    try {
      const fromSettings = normalizeLocale(JSON.parse(settingsText).locale);
      if (fromSettings) return fromSettings;
    } catch {
      /* a broken settings file must not block the failure message */
    }
  }
  return normalizeLocale(intlLocale) ?? 'en';
}

function messagesFor(locale) {
  return MESSAGES[locale] ?? MESSAGES.en;
}

function resolveHome({env = process.env, home = os.homedir()} = {}) {
  if (env.LIVE_MEMORY_DATA_DIR) return path.resolve(env.LIVE_MEMORY_DATA_DIR);
  return path.join(env.LOCALAPPDATA || home, 'LiveMemory');
}

/** Extraction targets, most desirable first. Both are under per-user folders. */
function appRootCandidates({home, hash, temp = os.tmpdir(), env = process.env} = {}) {
  const candidates = [path.join(home, 'app', hash)];
  const localTemp = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Temp') : null;
  if (localTemp) candidates.push(path.join(localTemp, 'LiveMemory-app', hash));
  candidates.push(path.join(temp, 'LiveMemory-app', hash));
  return [...new Set(candidates)];
}

/** Log folders, most useful first. */
function earlyLogCandidates({home, temp = os.tmpdir(), env = process.env} = {}) {
  const candidates = [];
  if (env.LIVE_MEMORY_LOG_DIR) candidates.push(env.LIVE_MEMORY_LOG_DIR);
  candidates.push(path.join(home, 'logs'));
  candidates.push(path.join(temp, 'LiveMemory-logs'));
  candidates.push(path.join(os.homedir(), '.livememory-logs'));
  return [...new Set(candidates)];
}

function dateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Marker written into a completed extraction; used to skip re-extraction. */
function readMarker(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, MARKER_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function markerMatches(marker, manifest, {exists = fs.existsSync, root = null} = {}) {
  if (!marker || !manifest) return false;
  if (marker.hash !== manifest.hash) return false;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return false;
  if (Number(marker.files) !== manifest.files.length) return false;
  if (!root) return true;
  return manifest.files.every((file) => {
    try {
      return exists(path.join(root, file));
    } catch {
      return false;
    }
  });
}

function createEarlyLog({env = process.env, home, now = () => new Date()} = {}) {
  const records = [];
  let dir = null;
  let file = null;
  let usedFallback = false;

  function resolve() {
    if (file) return file;
    const candidates = earlyLogCandidates({home, env});
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        fs.mkdirSync(candidate, {recursive: true});
        const target = path.join(candidate, `${LOG_FILE_PREFIX}-${dateStamp(now())}.log`);
        try {
          if (fs.statSync(target).size > MAX_LOG_BYTES) fs.renameSync(target, `${target}.1`);
        } catch {
          /* no existing log */
        }
        fs.appendFileSync(target, '', 'utf8');
        dir = candidate;
        file = target;
        usedFallback = index > 0;
        return file;
      } catch {
        /* try the next location */
      }
    }
    return null;
  }

  function record(step, detail = {}) {
    const entry = {
      at: now().toISOString(),
      level: detail.ok === false ? 'error' : 'info',
      step,
      pid: process.pid,
      ...detail
    };
    records.push(entry);
    const target = resolve();
    if (!target) return entry;
    try {
      fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* logging must never crash the bootstrap */
    }
    return entry;
  }

  return {
    record,
    file: () => resolve(),
    dir: () => {
      resolve();
      return dir;
    },
    fallback: () => {
      resolve();
      return usedFallback;
    },
    records: () => records.slice(),
    writeReport(report) {
      const target = resolve();
      if (!target) return null;
      const reportFile = path.join(dir, 'startup-error.json');
      try {
        fs.writeFileSync(reportFile, `${JSON.stringify({...report, steps: records.slice(-40)}, null, 2)}\n`, 'utf8');
        return reportFile;
      } catch {
        return null;
      }
    }
  };
}

function hasFlag(argv, flag) {
  return argv.some((item) => String(item) === flag);
}

function pauseForUser({stdin = process.stdin, stdout = process.stdout, enabled = true}) {
  return new Promise((resolve) => {
    if (!enabled || !stdin.isTTY) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        stdin.pause();
        stdin.removeListener('data', done);
      } catch {
        /* ignore */
      }
      resolve(true);
    };
    try {
      stdin.resume();
      stdin.once('data', done);
      stdin.once('error', done);
    } catch {
      done();
    }
  });
}

function showErrorDialog(text, {title = 'LiveMemory'} = {}) {
  const {spawn} = require('node:child_process');
  const encodedText = Buffer.from(String(text).slice(0, 3000), 'utf8').toString('base64');
  const encodedTitle = Buffer.from(String(title), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))`,
    `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))`,
    "[void][System.Windows.Forms.MessageBox]::Show($text,$title,[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error)"
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', () => resolve(true));
  });
}

async function extractAtomically({target, manifest, getAsset, now = Date.now}) {
  const staging = `${target}.staging-${process.pid}-${now()}`;
  try {
    await fs.promises.rm(staging, {recursive: true, force: true});
  } catch {
    /* ignore */
  }
  try {
    await fs.promises.mkdir(staging, {recursive: true});
    for (const file of manifest.files) {
      const relative = String(file).replace(/^[\\/]+/, '');
      if (relative.split(/[\\/]/).includes('..')) throw new Error(`unsafe asset path: ${file}`);
      const destination = path.join(staging, relative);
      await fs.promises.mkdir(path.dirname(destination), {recursive: true});
      await fs.promises.writeFile(destination, Buffer.from(getAsset(file)));
    }
    await fs.promises.writeFile(path.join(staging, MARKER_NAME), `${JSON.stringify({
      hash: manifest.hash,
      version: manifest.version ?? null,
      files: manifest.files.length,
      extractedAt: new Date(now()).toISOString()
    }, null, 2)}\n`, 'utf8');
    try {
      await fs.promises.rm(target, {recursive: true, force: true});
    } catch {
      /* the target may not exist */
    }
    await fs.promises.rename(staging, target);
    return {ok: true, target};
  } catch (error) {
    try {
      await fs.promises.rm(staging, {recursive: true, force: true});
    } catch {
      /* ignore */
    }
    error.target = target;
    throw error;
  }
}

async function ensureAppRoot({candidates, manifest, getAsset, log, now = Date.now}) {
  const failures = [];
  for (const candidate of candidates) {
    const marker = readMarker(candidate);
    if (markerMatches(marker, manifest, {root: candidate})) {
      log.record('app-root.reuse', {ok: true, path: candidate, hash: manifest.hash});
      return {appRoot: candidate, reused: true, failures};
    }
    try {
      await extractAtomically({target: candidate, manifest, getAsset, now});
      log.record('app-root.extract', {ok: true, path: candidate, files: manifest.files.length, hash: manifest.hash});
      return {appRoot: candidate, reused: false, failures};
    } catch (error) {
      failures.push({path: candidate, code: error?.code ?? 'UNKNOWN', step: 'extract'});
      log.record('app-root.extract', {
        ok: false,
        path: candidate,
        code: error?.code ?? 'UNKNOWN',
        message: String(error?.message ?? error)
      });
    }
  }
  const error = new Error('no writable application folder');
  error.code = 'ENOENT';
  error.failures = failures;
  throw error;
}

function buildFatalText({locale, error, logFile, step, dataDir, appRoot}) {
  const messages = messagesFor(locale);
  const lines = [messages.title];
  const code = error?.code ?? 'STARTUP_FAILED';
  lines.push(format(messages.detail, {message: String(error?.message ?? error)}));
  if (step) lines.push(format(messages.step, {step}));
  lines.push(format(messages.code, {code}));
  if (dataDir) lines.push(format(messages.dataDir, {path: dataDir}));
  if (appRoot) lines.push(format(messages.appDir, {path: appRoot}));
  lines.push(logFile ? format(messages.logAt, {path: logFile}) : messages.noLog);
  for (const failure of error?.failures ?? []) {
    lines.push(`  ${failure.path} (${failure.code})`);
  }
  return lines.join('\n');
}

async function main() {
  const startTime = Date.now();
  const argv = process.argv.slice(1);
  const env = process.env;
  const home = resolveHome({env});
  const log = createEarlyLog({env, home});
  let settingsText = null;
  try {
    settingsText = fs.readFileSync(path.join(home, 'config', 'settings.json'), 'utf8');
  } catch {
    /* first run, or the folder is not readable yet */
  }
  let intlLocale = null;
  try {
    intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    /* ignore */
  }
  const locale = pickLocale({env, settingsText, intlLocale});
  const messages = messagesFor(locale);
  const sea = require('node:sea');
  let appRoot = null;

  log.record('bootstrap.begin', {
    version: null,
    hash: null,
    exePath: process.execPath,
    cwd: process.cwd(),
    argv: argv.map((item) => String(item)),
    home,
    locale,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  });

  const fail = async (error, step) => {
    log.record(step, {ok: false, code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error)});
    log.writeReport({
      at: new Date().toISOString(),
      code: error?.code ?? 'UNKNOWN',
      step,
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, 4000),
      home,
      appRoot
    });
    const text = buildFatalText({locale, error, logFile: log.file(), step, dataDir: home, appRoot});
    process.stderr.write(`\n${text}\n\n`);
    const interactive = Boolean(process.stdin.isTTY);
    if (interactive && !hasFlag(argv, '--no-wait')) {
      process.stdout.write(`  ${messages.pressKey}\n`);
      await pauseForUser({enabled: true});
    } else if (hasFlag(argv, '--error-dialog')) {
      await showErrorDialog(text, {title: 'LiveMemory'});
    }
    process.exitCode = 1;
  };

  // Any error that escapes the launcher (async, late, unhandled) must also be
  // explained instead of showing a raw stack and closing the window.
  let fatalHandled = false;
  const onUncaught = (error) => {
    if (fatalHandled) return;
    fatalHandled = true;
    // `fail` waits for the "press any key" prompt, so the window stays readable.
    fail(error, 'uncaughtException').finally(() => process.exit(1));
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  try {
    const manifest = JSON.parse(sea.getAsset('manifest', 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !manifest.hash || !Array.isArray(manifest.files)) {
      const error = new Error('embedded manifest is invalid');
      error.code = 'ASSET_INVALID';
      throw error;
    }
    log.record('manifest.loaded', {ok: true, hash: manifest.hash, version: manifest.version ?? null, files: manifest.files.length});

    const {appRoot: extracted, reused, failures} = await ensureAppRoot({
      candidates: appRootCandidates({home, hash: manifest.hash, env}),
      manifest,
      getAsset: (name) => sea.getAsset(name),
      log,
      now: Date.now
    });
    appRoot = extracted;
    if (failures.length > 0) {
      log.record('app-root.fallback', {ok: true, target: appRoot, failures});
    }
    log.record('app-root.ready', {ok: true, path: appRoot, reused});

    process.env.LIVE_MEMORY_APP_ROOT = appRoot;
    // The intended default is a *preference*: if this folder turns out to be
    // read-only the launcher falls back to another writable location and says so.
    process.env.LIVE_MEMORY_DEFAULT_DATA_DIR = home;
    process.env.LIVE_MEMORY_BOOTSTRAP_LOG = log.file() ?? '';

    const launcher = await import(pathToFileURL(path.join(appRoot, 'src/launcher/launcher.mjs')).href);
    log.record('launcher.imported', {ok: true});
    const code = await launcher.runLauncher({argv, env, registerProcessHandlers: false});
    log.record('launcher.exit', {ok: code === 0, code, elapsedMs: Date.now() - startTime});
    process.exitCode = code;
  } catch (error) {
    await fail(error, 'bootstrap');
  }
}

let isSea = false;
try {
  isSea = Boolean(require('node:sea').isSea?.());
} catch {
  isSea = false;
}

if (isSea) {
  main();
}

module.exports = {
  MESSAGES,
  MARKER_NAME,
  appRootCandidates,
  buildFatalText,
  createEarlyLog,
  dateStamp,
  earlyLogCandidates,
  ensureAppRoot,
  extractAtomically,
  markerMatches,
  messagesFor,
  normalizeLocale,
  pickLocale,
  readMarker,
  resolveHome
};
