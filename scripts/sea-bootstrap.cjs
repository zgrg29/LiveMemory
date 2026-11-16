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
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');

const MARKER_NAME = '.livememory-app.json';
const LOG_FILE_PREFIX = 'bootstrap';
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/*
 * Startup-failure messages for the ten interface languages. This table is
 * intentionally self-contained: the bootstrap runs before extraction, so it
 * cannot import src/shared/locales.mjs. The language codes are still the exact
 * registry codes (docs/I18N.md), and an unknown system language falls back to
 * English rather than guessing.
 */
const MESSAGES = {
  "zh-CN": {
    "title": "LiveMemory 无法启动",
    "detail": "详细信息：{message}",
    "step": "失败步骤：{step}",
    "code": "错误代码：{code}",
    "logAt": "启动日志：{path}",
    "noLog": "启动日志：无法写入任何日志目录",
    "pressKey": "按任意键关闭此窗口。",
    "appDir": "应用文件目录：{path}",
    "dataDir": "数据目录：{path}"
  },
  "ja": {
    "title": "LiveMemory を起動できません",
    "detail": "詳細: {message}",
    "step": "失敗した手順: {step}",
    "code": "エラーコード: {code}",
    "logAt": "起動ログ: {path}",
    "noLog": "起動ログ: 書き込み可能なフォルダーがありません",
    "pressKey": "任意のキーを押すとこのウィンドウを閉じます。",
    "appDir": "アプリのフォルダー: {path}",
    "dataDir": "データフォルダー: {path}"
  },
  "en": {
    "title": "LiveMemory could not start",
    "detail": "Details: {message}",
    "step": "Failed step: {step}",
    "code": "Error code: {code}",
    "logAt": "Startup log: {path}",
    "noLog": "Startup log: no writable log folder was found",
    "pressKey": "Press any key to close this window.",
    "appDir": "Application folder: {path}",
    "dataDir": "Data folder: {path}"
  },
  "ko": {
    "title": "LiveMemory를 시작할 수 없습니다",
    "detail": "상세 정보: {message}",
    "step": "실패한 단계: {step}",
    "code": "오류 코드: {code}",
    "logAt": "시작 로그: {path}",
    "noLog": "시작 로그: 기록할 수 있는 로그 폴더가 없습니다",
    "pressKey": "아무 키나 누르면 이 창이 닫힙니다.",
    "appDir": "앱 파일 폴더: {path}",
    "dataDir": "데이터 폴더: {path}"
  },
  "es": {
    "title": "LiveMemory no pudo iniciarse",
    "detail": "Detalles: {message}",
    "step": "Paso fallido: {step}",
    "code": "Código de error: {code}",
    "logAt": "Registro de inicio: {path}",
    "noLog": "Registro de inicio: no se encontró ninguna carpeta de registro escribible",
    "pressKey": "Pulse cualquier tecla para cerrar esta ventana.",
    "appDir": "Carpeta de la aplicación: {path}",
    "dataDir": "Carpeta de datos: {path}"
  },
  "pt-BR": {
    "title": "Não foi possível iniciar o LiveMemory",
    "detail": "Detalhes: {message}",
    "step": "Etapa com falha: {step}",
    "code": "Código do erro: {code}",
    "logAt": "Registro de inicialização: {path}",
    "noLog": "Registro de inicialização: nenhuma pasta de registro gravável foi encontrada",
    "pressKey": "Pressione qualquer tecla para fechar esta janela.",
    "appDir": "Pasta do aplicativo: {path}",
    "dataDir": "Pasta de dados: {path}"
  },
  "zh-TW": {
    "title": "LiveMemory 無法啟動",
    "detail": "詳細資訊：{message}",
    "step": "失敗步驟：{step}",
    "code": "錯誤代碼：{code}",
    "logAt": "啟動記錄檔：{path}",
    "noLog": "啟動記錄檔：找不到可寫入的記錄資料夾",
    "pressKey": "按任意鍵關閉此視窗。",
    "appDir": "應用程式資料夾：{path}",
    "dataDir": "資料夾：{path}"
  },
  "fr": {
    "title": "LiveMemory n’a pas pu démarrer",
    "detail": "Détails : {message}",
    "step": "Étape en échec : {step}",
    "code": "Code d’erreur : {code}",
    "logAt": "Journal de démarrage : {path}",
    "noLog": "Journal de démarrage : aucun dossier de journal accessible en écriture",
    "pressKey": "Appuyez sur une touche pour fermer cette fenêtre.",
    "appDir": "Dossier de l’application : {path}",
    "dataDir": "Dossier de données : {path}"
  },
  "de": {
    "title": "LiveMemory konnte nicht gestartet werden",
    "detail": "Details: {message}",
    "step": "Fehlgeschlagener Schritt: {step}",
    "code": "Fehlercode: {code}",
    "logAt": "Startprotokoll: {path}",
    "noLog": "Startprotokoll: kein beschreibbarer Protokollordner gefunden",
    "pressKey": "Beliebige Taste drücken, um dieses Fenster zu schließen.",
    "appDir": "Anwendungsordner: {path}",
    "dataDir": "Datenordner: {path}"
  },
  "id": {
    "title": "LiveMemory tidak dapat dimulai",
    "detail": "Detail: {message}",
    "step": "Langkah yang gagal: {step}",
    "code": "Kode kesalahan: {code}",
    "logAt": "Log mulai: {path}",
    "noLog": "Log mulai: tidak ada folder log yang dapat ditulis",
    "pressKey": "Tekan tombol apa pun untuk menutup jendela ini.",
    "appDir": "Folder aplikasi: {path}",
    "dataDir": "Folder data: {path}"
  }
};

/* An ASCII-only console gets the English set, folded, instead of mojibake. */
let asciiOnly = false;

function foldAscii(value) {
  return String(value ?? '').replace(/[^\x20-\x7E\n\t]/g, '?');
}

function format(template, params = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function normalizeLocale(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/_/g, '-').split('@')[0].split('.')[0];
  if (!text) return null;
  // Traditional Chinese variants (and the Hant script tag) prefer zh-TW.
  if (text === 'zh' || text.startsWith('zh-')) {
    if (/hant|tw|hk|mo/.test(text.replace(/^zh-?/, ''))) return 'zh-TW';
    return 'zh-CN';
  }
  if (text === 'pt' || text.startsWith('pt-')) return 'pt-BR';
  if (text === 'in' || text.startsWith('in-')) return 'id';
  for (const code of ['ja', 'en', 'ko', 'es', 'fr', 'de', 'id']) {
    if (text === code || text.startsWith(`${code}-`)) return code;
  }
  return null;
}

/** Try to switch a Windows console to UTF-8; false means "render ASCII only". */
function prepareConsole({platform = process.platform, stdout = process.stdout} = {}) {
  if (platform !== 'win32') return true;
  // Redirected or piped output carries UTF-8 bytes correctly, so the selected
  // language is kept; only a real console that refused UTF-8 falls back.
  if (!stdout.isTTY) return true;
  try {
    const result = require('node:child_process').spawnSync('cmd', ['/c', 'chcp 65001'], {stdio: 'ignore', windowsHide: true});
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
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
  if (asciiOnly) return MESSAGES.en;
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

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Verify the extracted tree against the hashes embedded in the manifest.
 *
 * A marker with the right hash is not enough: an older extraction directory can
 * be partially overwritten, and a reused directory was exactly how a previous
 * build kept loading stale modules. Any mismatch forces a clean re-extraction.
 */
function verifyTree(root, manifest) {
  if (!root || !manifest) return {ok: false, checked: 0, mismatches: ['missing-manifest']};
  if (!manifest.fileHashes || typeof manifest.fileHashes !== 'object') {
    // Older manifests have no hashes; fall back to existence checking only.
    return {ok: true, checked: 0, mismatches: [], legacy: true};
  }
  const mismatches = [];
  let checked = 0;
  for (const file of manifest.files ?? []) {
    const expected = manifest.fileHashes[file];
    if (!expected) continue;
    checked += 1;
    let actual = null;
    try {
      actual = sha256File(path.join(root, file));
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      mismatches.push(file);
      if (mismatches.length >= 8) break;
    }
  }
  return {ok: mismatches.length === 0, checked, mismatches};
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
      buildId: manifest.build?.buildId ?? null,
      commit: manifest.build?.commit ?? null,
      sourceHash: manifest.build?.sourceHash ?? null,
      extractedAt: new Date(now()).toISOString()
    }, null, 2)}\n`, 'utf8');
    const verified = verifyTree(staging, manifest);
    if (!verified.ok) {
      const error = new Error(`extracted assets do not match manifest: ${verified.mismatches.join(', ')}`);
      error.code = 'ASSET_HASH_MISMATCH';
      error.mismatches = verified.mismatches;
      throw error;
    }
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
      const verified = verifyTree(candidate, manifest);
      if (verified.ok) {
        log.record('app-root.reuse', {
          ok: true,
          path: candidate,
          hash: manifest.hash,
          buildId: manifest.build?.buildId ?? null,
          filesVerified: verified.checked
        });
        return {appRoot: candidate, reused: true, failures, verified};
      }
      log.record('app-root.stale', {
        ok: false,
        path: candidate,
        hash: manifest.hash,
        mismatchCount: verified.mismatches.length,
        mismatches: verified.mismatches
      });
      // Contaminated or partially overwritten cache: remove it and re-extract.
      try {
        await fs.promises.rm(candidate, {recursive: true, force: true});
      } catch {
        /* extractAtomically will report the real failure */
      }
    }
    try {
      await extractAtomically({target: candidate, manifest, getAsset, now});
      const verified = verifyTree(candidate, manifest);
      log.record('app-root.extract', {
        ok: true,
        path: candidate,
        files: manifest.files.length,
        hash: manifest.hash,
        buildId: manifest.build?.buildId ?? null,
        filesVerified: verified.checked
      });
      return {appRoot: candidate, reused: false, failures, verified};
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
  return asciiOnly ? foldAscii(lines.join('\n')) : lines.join('\n');
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
  asciiOnly = !prepareConsole();
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
      process.stdout.write(`  ${asciiOnly ? foldAscii(messages.pressKey) : messages.pressKey}\n`);
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
    log.record('manifest.loaded', {
      ok: true,
      hash: manifest.hash,
      version: manifest.version ?? null,
      files: manifest.files.length,
      buildId: manifest.build?.buildId ?? null,
      commit: manifest.build?.commit ?? null,
      builtAt: manifest.build?.builtAt ?? null
    });

    const {appRoot: extracted, reused, failures, verified} = await ensureAppRoot({
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
    log.record('app-root.ready', {
      ok: true,
      path: appRoot,
      reused,
      filesVerified: verified?.checked ?? 0,
      legacyManifest: verified?.legacy === true
    });

    const build = manifest.build && typeof manifest.build === 'object' ? manifest.build : {};
    process.env.LIVE_MEMORY_APP_ROOT = appRoot;
    process.env.LIVE_MEMORY_BUILD_ID = build.buildId ?? '';
    process.env.LIVE_MEMORY_BUILD_COMMIT = build.commit ?? '';
    process.env.LIVE_MEMORY_BUILD_SHORT = build.shortCommit ?? '';
    process.env.LIVE_MEMORY_BUILD_VERSION = build.version ?? manifest.version ?? '';
    process.env.LIVE_MEMORY_BUILD_TIME = build.builtAt ?? '';
    process.env.LIVE_MEMORY_BUILD_SOURCE_HASH = build.sourceHash ?? '';
    process.env.LIVE_MEMORY_ASSET_HASH = build.assetHash ?? manifest.hash ?? '';
    process.env.LIVE_MEMORY_BUILD_VERIFY = verified?.ok === false ? 'failed' : 'ok';
    log.record('build.identity', {
      ok: verified?.ok !== false,
      buildId: build.buildId ?? null,
      commit: build.commit ?? null,
      shortCommit: build.shortCommit ?? null,
      builtAt: build.builtAt ?? null,
      assetHash: build.assetHash ?? manifest.hash,
      filesVerified: verified?.checked ?? 0
    });

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
  normalizeLocale,
  prepareConsole,
  MARKER_NAME,
  appRootCandidates,
  buildFatalText,
  createEarlyLog,
  dateStamp,
  earlyLogCandidates,
  ensureAppRoot,
  extractAtomically,
  markerMatches,
  sha256File,
  verifyTree,
  messagesFor,
  normalizeLocale,
  pickLocale,
  readMarker,
  resolveHome
};
