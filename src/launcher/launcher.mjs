import {existsSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPaths, ensureDirectories} from '../server/paths.mjs';
import {AppError} from '../shared/errors.mjs';
import {detectSystemLocale, normalizeLocale} from '../shared/locale.mjs';
import {APP_NAME, APP_VERSION} from '../shared/app-info.mjs';
import {SettingsStore} from '../server/settings-store.mjs';
import {createLogger} from '../server/logger.mjs';
import {resolveDataDir, probeWritable} from './data-dir.mjs';
import {findExistingUserDataDirs} from './profile-scan.mjs';
import {isAdministrator} from './admin.mjs';
import {readDataLocation, clearDataLocation} from '../shared/data-location.mjs';
import {acquireInstanceLock, readRuntimeInfo} from './lock.mjs';
import {probeInstance} from './instance.mjs';
import {createStartupLog} from './startup-log.mjs';
import {enableUtf8Console, createConsole, openDefaultBrowser} from './console.mjs';
import {isInteractive, pauseForUser, showErrorDialog} from './diagnostics.mjs';
import {t} from './cli-i18n.mjs';
import {checkNodeVersion, checkSqliteSupport} from './env-check.mjs';

/**
 * Windows launcher.
 *
 * Startup sequence required by the product spec:
 *   check environment -> resolve data folder -> prepare config/database ->
 *   pick a free local port -> start HTTP server -> wait until ready ->
 *   open the default browser -> show status.
 *
 * Every step is recorded by the startup logger *before* the database exists, so
 * a failure on a normal (non-elevated) Windows account can always be explained:
 * which operation failed, the real error code, the folder, and where the log is.
 * A failure must never close the console without a readable message.
 */

const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  fileFor() {
    return null;
  }
});

function createSafeLogger({dir, startupLog}) {
  try {
    return createLogger({dir});
  } catch (error) {
    startupLog.fail('logger.init', error, {dir, degraded: true});
    return NOOP_LOGGER;
  }
}

export function parseArguments(argv = []) {
  const options = {
    open: true,
    port: null,
    dataDir: null,
    lang: null,
    help: false,
    version: false,
    diagnose: false,
    waitOnError: true,
    errorDialog: false,
    forgetDataLocation: false,
    unknown: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [flag, inlineValue] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, null];
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case '--no-open':
        options.open = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '--no-wait':
        options.waitOnError = false;
        break;
      case '--error-dialog':
        options.errorDialog = true;
        break;
      case '--diagnose':
        options.diagnose = true;
        break;
      case '--forget-data-location':
        options.forgetDataLocation = true;
        break;
      case '--port': {
        const raw = takeValue();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new AppError('INVALID_ARGUMENT', {messageKey: 'errors.invalidPort', details: {value: raw ?? null}});
        }
        options.port = port;
        break;
      }
      case '--data-dir': {
        const value = takeValue();
        if (!value) throw new AppError('INVALID_ARGUMENT', {messageKey: 'errors.invalidDataDir'});
        options.dataDir = String(value);
        break;
      }
      case '--lang': {
        const value = takeValue();
        const locale = normalizeLocale(value);
        if (!locale || locale === 'system') {
          throw new AppError('INVALID_ARGUMENT', {messageKey: 'errors.invalidLanguage', details: {value: value ?? null}});
        }
        options.lang = locale;
        break;
      }
      case '--version':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        options.unknown.push(arg);
        break;
    }
  }
  return options;
}

/**
 * Console language is independent from the web UI locale. It defaults to
 * English so double-clicking the EXE always yields readable, stable CLI text;
 * `--lang zh-CN|ja|en` still overrides it. The web console keeps its own
 * three-language setting and system detection.
 */
function resolveConsoleLocale(options) {
  return options?.lang ?? 'en';
}

function statusLineText(status, locale) {
  const session = status?.activeSession ?? null;
  const count = Number(status?.activeCount ?? (session ? 1 : 0));
  if (!session) {
    return ['connecting', 'reconnecting'].includes(status?.connection)
      ? t(locale, 'statusStarting')
      : t(locale, 'statusIdle');
  }
  if (count > 1) return t(locale, 'statusRecordingMultiple', {count});
  if (status.connection === 'connected') {
    return `${t(locale, 'statusRecording', {title: session.roomTitle ?? ''})} · ${t(locale, 'statusRecordingStats', {
      messages: session.messageCount ?? 0,
      viewers: session.uniqueViewerCount ?? 0
    })}`;
  }
  return t(locale, 'statusRecording', {title: session.roomTitle ?? ''});
}

/** The built-in SQLite module prints an experimental warning; hide only that one. */
function silenceSqliteExperimentalWarning() {
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning?.name === 'ExperimentalWarning' && /sqlite/i.test(String(warning.message ?? ''))) return;
    for (const listener of listeners) listener(warning);
    if (listeners.length === 0) process.stderr.write(`${warning?.name ?? 'Warning'}: ${warning?.message ?? ''}\n`);
  });
}

function startupError({code, step, userMessage, extra = [], cause = null}) {
  const error = new Error(userMessage ?? code ?? 'startup failed');
  error.code = code ?? 'STARTUP_FAILED';
  error.step = step ?? null;
  error.userMessage = userMessage ?? null;
  error.extra = extra;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Run the launcher to completion. Resolves with an exit code.
 * @param {{argv?: string[], env?: object, stdout?: object, stderr?: object, stdin?: object,
 *   openBrowser?: Function, now?: Function, fetchImpl?: Function, registerProcessHandlers?: boolean}} context
 */
export async function runLauncher({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  openBrowser = openDefaultBrowser,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  registerProcessHandlers = true
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${APP_NAME}: ${error.code}\n`);
    return 2;
  }

  const startupLog = createStartupLog({env, argv, version: APP_VERSION});
  const utf8 = enableUtf8Console({stdout});
  const systemLocale = detectSystemLocale(env);
  // The launcher console defaults to English and does not depend on the web
  // console's saved locale. `--lang zh-CN|ja|en` still overrides it; the web UI
  // keeps its own three-language setting and system detection.
  let locale = resolveConsoleLocale(options);
  const unicode = process.platform !== 'win32' || utf8.changed;
  let ui = createConsole({locale, stdout, stderr, unicode});
  startupLog.record('console.ready', {utf8: utf8.changed, reason: utf8.reason ?? null, locale});
  let dataDirInfo = null;
  let paths = null;
  let logger = NOOP_LOGGER;
  let lock = null;
  let server = null;
  let shuttingDown = false;
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const signalHandlers = {};
  let handlersAttached = false;

  const buildFailureText = (error, failure = null) => {
    const lines = [t(locale, 'fatalTitle')];
    if (error?.userMessage) lines.push(error.userMessage);
    if (failure?.step) lines.push(t(locale, 'failedStep', {step: failure.step}));
    if (failure?.code) lines.push(t(locale, 'errorCode', {code: failure.code}));
    for (const extra of error?.extra ?? []) if (extra) lines.push(extra);
    if (dataDirInfo?.dir) lines.push(`${t(locale, 'dataDir')}: ${dataDirInfo.dir}`);
    const logFile = startupLog.file();
    if (logFile) lines.push(`${t(locale, 'logFile')}: ${logFile}`);
    lines.push(t(locale, 'dataDirHint'));
    return lines.join('\n');
  };

  const reportFatal = async (error) => {
    const failureStep = error?.step ?? 'startup';
    const failure = startupLog.fail(failureStep, error, {dataDir: dataDirInfo?.dir ?? null});
    const logFile = startupLog.file();
    try {
      startupLog.writeErrorReport({
        code: failure.code ?? 'STARTUP_FAILED',
        step: failure.step ?? null,
        message: error?.message ?? null,
        dataDir: dataDirInfo?.dir ?? null
      });
    } catch {
      /* best effort */
    }
    if (paths) {
      try {
        writeFileSync(paths.errorFile, `${JSON.stringify({
          at: new Date(now()).toISOString(),
          code: failure.code ?? 'STARTUP_FAILED',
          step: failure.step ?? null,
          messageKey: error?.messageKey ?? null,
          dataDir: paths.root,
          logFile
        }, null, 2)}\n`, 'utf8');
      } catch {
        /* diagnostics are best effort */
      }
    }
    const text = buildFailureText(error, failure);
    ui.blank();
    ui.error(t(locale, 'fatalTitle'));
    if (error?.userMessage) ui.note(error.userMessage);
    for (const extra of error?.extra ?? []) if (extra) ui.note(extra);
    if (failure.step) ui.note(t(locale, 'failedStep', {step: failure.step}));
    if (failure.code) ui.note(t(locale, 'errorCode', {code: failure.code}));
    if (dataDirInfo?.dir) ui.field(t(locale, 'dataDir'), dataDirInfo.dir);
    if (logFile) ui.field(t(locale, 'logFile'), logFile);
    ui.blank();
    ui.note(t(locale, 'dataDirHint'));
    ui.blank();

    shuttingDown = true;
    if (server) await server.close().catch(() => {});
    if (lock?.acquired) lock.release();

    if (options.errorDialog && !isInteractive({stdin})) {
      await showErrorDialog({title: APP_NAME, text, env});
    }
    await pauseForUser({
      stdin,
      stdout,
      enabled: options.waitOnError,
      prompt: t(locale, 'pressKey')
    });
    return 1;
  };

  const installProcessHandlers = () => {
    if (!registerProcessHandlers || handlersAttached) return;
    handlersAttached = true;
    const handle = (kind, error) => {
      startupLog.fail(kind, error instanceof Error ? error : new Error(String(error)));
      if (server) {
        server.close().catch(() => {});
      }
      ui.blank();
      ui.error(t(locale, 'crashTitle'));
      ui.note(t(locale, 'crashBody', {message: String(error?.message ?? error)}));
      const logFile = startupLog.file();
      if (logFile) ui.field(t(locale, 'logFile'), logFile);
      ui.blank();
      const exit = () => process.exit(1);
      const canPause = isInteractive({stdin}) && options.waitOnError && !options.version && !options.help && !options.diagnose;
      if (canPause) {
        pauseForUser({stdin, stdout, enabled: true, prompt: t(locale, 'pressKey')}).then(exit, exit);
      } else {
        exit();
      }
    };
    process.on('uncaughtException', (error) => handle('uncaughtException', error));
    process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
  };

  try {
    installProcessHandlers();
    if (options.version) {
      stdout.write(`${APP_NAME} ${APP_VERSION}\n`);
      startupLog.record('version', {ok: true});
      return 0;
    }
    if (options.help) {
      stdout.write(`\n${APP_NAME} ${APP_VERSION}\n\n${t(locale, 'helpTitle')}\n${t(locale, 'helpBody')}\n\n`);
      startupLog.record('help', {ok: true});
      return 0;
    }

    if (options.diagnose) {
      return runDiagnostics({options, env, ui, locale, startupLog, stdout, stdin});
    }

    const nodeCheck = checkNodeVersion();
    startupLog.record('node-check', {ok: nodeCheck.ok, actual: nodeCheck.actual, expected: nodeCheck.expected});
    if (!nodeCheck.ok) {
      throw startupError({
        code: 'UNSUPPORTED_NODE',
        step: 'node-check',
        userMessage: t(locale, 'unsupportedNode', {expected: nodeCheck.expected, actual: nodeCheck.actual})
      });
    }
    const sqlite = await checkSqliteSupport();
    startupLog.record('sqlite-check', {ok: sqlite.ok});
    if (!sqlite.ok) {
      throw startupError({code: 'SQLITE_UNAVAILABLE', step: 'sqlite-check', userMessage: t(locale, 'sqliteUnavailable')});
    }

    try {
      // A saved location pointer wins over the default folder, but never over an
      // explicit `--data-dir` / environment override. An unavailable target is a
      // hard error: silently starting with an empty default database would look
      // like data loss.
      if (!options.dataDir && !env.LIVE_MEMORY_DATA_DIR) {
        if (options.forgetDataLocation) {
          const removed = clearDataLocation({env});
          startupLog.record('data-location.forget', {ok: true, removed});
        } else {
          const pointer = readDataLocation({env});
          if (pointer) {
            // A saved folder that no longer exists, or exists without its
            // database, must never be recreated empty: that would look exactly
            // like data loss. Only a complete existing folder is probed;
            // reconnecting the drive restores it.
            const databaseFile = join(pointer.dataDir, 'database', 'livememory.db');
            const folderExists = existsSync(pointer.dataDir);
            const hasDatabase = folderExists && existsSync(databaseFile);
            const probe = folderExists && hasDatabase
              ? probeWritable(pointer.dataDir)
              : {
                ok: false,
                dir: pointer.dataDir,
                code: folderExists ? 'ENODB' : 'ENOENT',
                step: folderExists ? 'database-missing' : 'missing'
              };
            if (!probe.ok) {
              const extra = [
                t(locale, 'dataDirPointer', {path: pointer.pointerFile}),
                t(locale, 'dataDirUnavailableHint')
              ];
              if (folderExists && !hasDatabase) {
                extra.splice(1, 0, t(locale, 'dataDirMissingDatabase', {path: databaseFile}));
              }
              throw startupError({
                code: 'DATA_DIR_UNAVAILABLE',
                step: 'data-dir',
                userMessage: t(locale, 'dataDirUnavailable', {path: pointer.dataDir}),
                extra
              });
            }
            dataDirInfo = {
              dir: pointer.dataDir,
              explicit: true,
              source: 'pointer',
              pointerFile: pointer.pointerFile,
              fallback: false,
              attempts: [{dir: pointer.dataDir, ok: true}]
            };
          }
        }
      }
      // With a requireAdministrator manifest, UAC can run the process under a
      // different administrator account. Before creating a new empty database,
      // look for exactly one existing LiveMemory data folder in local profiles.
      // Several candidates are ambiguous and must not be guessed.
      const currentDefault = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'LiveMemory') : null;
      const currentDefaultHasData = Boolean(currentDefault && existsSync(join(currentDefault, 'database', 'livememory.db')));
      if (!dataDirInfo && !options.dataDir && !env.LIVE_MEMORY_DATA_DIR && env.LIVE_MEMORY_APP_ROOT && !currentDefaultHasData) {
        const existing = findExistingUserDataDirs({env});
        startupLog.record('data-dir.profile-scan', {count: existing.length, dirs: existing});
        if (existing.length === 1) {
          dataDirInfo = {
            dir: existing[0],
            explicit: true,
            source: 'profile',
            fallback: false,
            attempts: [{dir: existing[0], ok: true}]
          };
        } else if (existing.length > 1) {
          throw startupError({
            code: 'DATA_DIR_AMBIGUOUS',
            step: 'data-dir',
            userMessage: t(locale, 'dataDirAmbiguous', {count: existing.length}),
            extra: existing.map((dir) => `  ${dir}`)
          });
        }
      }
      if (!dataDirInfo) {
        dataDirInfo = resolveDataDir({env, requested: options.dataDir});
        dataDirInfo.source = 'default';
      }
    } catch (error) {
      if (error?.code === 'DATA_DIR_UNAVAILABLE') throw error;
      startupLog.fail('data-dir', error, {requested: options.dataDir ?? null, attempts: error.attempts ?? []});
      const extra = (error.attempts ?? []).map((attempt) => `  ${attempt.dir} (${attempt.code ?? 'error'}${attempt.step ? `, ${attempt.step}` : ''})`);
      throw startupError({
        code: error.code ?? 'DATA_DIR_UNWRITABLE',
        step: 'data-dir',
        userMessage: t(locale, 'dataDirUnwritable', {path: error.path ?? options.dataDir ?? '?'}),
        extra,
        cause: error
      });
    }
    startupLog.record('data-dir', {
      ok: true,
      dir: dataDirInfo.dir,
      explicit: dataDirInfo.explicit,
      fallback: dataDirInfo.fallback,
      attempts: dataDirInfo.attempts
    });

    paths = createPaths(dataDirInfo.dir);
    try {
      ensureDirectories(paths);
    } catch (error) {
      throw startupError({
        code: error.code ?? 'DATA_DIR_UNWRITABLE',
        step: 'prepare-directories',
        userMessage: t(locale, 'dataDirUnwritable', {path: paths.root}),
        extra: [`${error.code ?? 'error'}: ${error.message}`],
        cause: error
      });
    }
    startupLog.record('prepare-directories', {ok: true, dir: paths.root});
    const relocated = startupLog.relocate(paths.root);
    startupLog.record('startup-log', {ok: relocated, dir: startupLog.dir()});

    let settingsLoaded = false;
    try {
      const settingsStore = new SettingsStore({file: paths.settingsFile});
      settingsStore.load();
      settingsLoaded = true;
      // Deliberately ignored for the console language: the web console chooses
      // its own locale from settings. The launcher stays English unless --lang
      // was supplied.
    } catch (error) {
      // Preferences are optional: never block startup because of them.
      startupLog.fail('settings.load', error, {degraded: true});
    }
    ui = createConsole({locale, stdout, stderr, unicode});

    logger = createSafeLogger({dir: paths.logs, startupLog});
    logger.info({event: 'launcher.start', version: APP_VERSION, dataDir: paths.root, locale, system: systemLocale});

    // The manifest normally guarantees elevation before this point. This check
    // covers manifest bypass/filtered-token environments and gives a localized
    // explanation instead of a permission stack trace.
    // LIVE_MEMORY_SKIP_ADMIN_CHECK is only for the automated asInvoker EXE
    // regression copy; the shipped EXE still carries requireAdministrator in its
    // manifest, so Windows enforces elevation before this code runs.
    if (process.platform === 'win32' && env.LIVE_MEMORY_APP_ROOT && env.LIVE_MEMORY_SKIP_ADMIN_CHECK !== '1') {
      const admin = await isAdministrator();
      startupLog.record('admin-check', {ok: admin !== false, admin});
      if (admin === false) {
        ui.blank();
        ui.error(t(locale, 'adminRequired'));
        if (!settingsLoaded) {
          for (const fallbackLocale of ['zh-CN', 'ja', 'en']) {
            if (fallbackLocale !== locale) ui.note(t(fallbackLocale, 'adminRequired'));
          }
        }
        const logFile = startupLog.file();
        if (logFile) ui.field(t(locale, 'logFile'), logFile);
        ui.blank();
        if (options.errorDialog && !isInteractive({stdin})) {
          await showErrorDialog({title: APP_NAME, text: t(locale, 'adminRequired'), env});
        }
        await pauseForUser({stdin, stdout, enabled: options.waitOnError, prompt: t(locale, 'pressKey')});
        return 1;
      }
    }

    ui.banner({name: APP_NAME, version: APP_VERSION, productLine: t(locale, 'productLine')});
    ui.info(t(locale, 'checkingEnvironment'));
    ui.info(t(locale, 'environmentOk'));
    if (dataDirInfo.fallback) {
      ui.warn(t(locale, 'fallbackDataDir', {path: dataDirInfo.dir}));
    }

    lock = acquireInstanceLock({lockFile: paths.lockFile, now: now(), exePath: process.execPath});
    startupLog.record('instance-lock', {
      ok: lock.acquired,
      reason: lock.reason ?? null,
      code: lock.error?.code ?? null,
      pid: lock.existing?.pid ?? null
    });

    if (!lock.acquired && lock.reason === 'running') {
      const probe = await probeInstance({
        runtimeFile: paths.runtimeFile,
        lockPid: lock.existing?.pid ?? null,
        fetchImpl
      });
      startupLog.record('instance-probe', {running: probe.running, reason: probe.reason});
      if (probe.running) {
        const url = probe.url ?? readRuntimeInfo(paths.runtimeFile)?.url ?? `http://127.0.0.1:${lock.existing?.port ?? 47800}/`;
        ui.blank();
        ui.info(t(locale, 'alreadyRunning'));
        ui.field(t(locale, 'consoleUrl'), url);
        if (options.open) {
          const opened = openBrowser(url);
          ui.info(opened.opened ? t(locale, 'alreadyRunningUrl') : t(locale, 'browserFailed'));
        }
        ui.blank();
        logger.info({event: 'launcher.already_running', pid: lock.existing?.pid ?? null, url});
        lock = null;
        return 0;
      }
      // The recorded process is not a healthy LiveMemory instance: the lock is
      // stale (crashed window, reused PID or a different integrity level). Take
      // it over instead of pretending the app is already running.
      try {
        rmSync(paths.lockFile, {force: true});
      } catch (error) {
        throw startupError({
          code: error.code ?? 'LOCK_FAILED',
          step: 'instance-lock',
          userMessage: t(locale, 'lockUnremovable', {path: paths.lockFile}),
          extra: [`${error.code ?? 'error'}: ${error.message}`],
          cause: error
        });
      }
      lock = acquireInstanceLock({lockFile: paths.lockFile, now: now(), exePath: process.execPath});
      if (!lock.acquired) {
        throw startupError({
          code: lock.error?.code ?? 'LOCK_FAILED',
          step: 'instance-lock',
          userMessage: t(locale, 'lockFailed', {path: paths.lockFile}),
          cause: lock.error ?? null
        });
      }
      ui.warn(t(locale, 'staleLock'));
      startupLog.record('instance-lock.takeover', {ok: true, stale: true});
    } else if (!lock.acquired) {
      throw startupError({
        code: lock.error?.code ?? 'LOCK_FAILED',
        step: 'instance-lock',
        userMessage: t(locale, 'lockFailed', {path: paths.lockFile}),
        extra: lock.error ? [`${lock.error.code ?? 'error'}: ${lock.error.message}`] : [],
        cause: lock.error ?? null
      });
    }

    const shutdown = async (reason) => {
      ui.blank();
      ui.info(t(locale, 'shuttingDown'));
      logger.info({event: 'launcher.shutdown', reason});
      try {
        if (server) await server.close();
      } catch (error) {
        logger.error({event: 'launcher.shutdown.failed', code: error?.code ?? 'unknown'});
      }
      lock?.release();
      startupLog.record('shutdown', {ok: true, reason});
      logger.info({event: 'launcher.exit'});
      ui.info(t(locale, 'stoppedRecording'));
      ui.info(t(locale, 'exited'));
      resolveDone();
    };

    const onSignal = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdown(`signal:${signal}`).catch(() => resolveDone());
      const force = setTimeout(() => process.exit(0), 5000);
      force.unref?.();
    };
    Object.assign(signalHandlers, {
      SIGINT: () => onSignal('SIGINT'),
      SIGTERM: () => onSignal('SIGTERM'),
      SIGHUP: () => onSignal('SIGHUP')
    });
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      try {
        process.on(signal, handler);
      } catch {
        /* signal may be unsupported on this platform */
      }
    }

    let lastStatusKey = null;
    const printStatus = (status) => {
      const key = `${status?.connection}:${status?.activeSession?.id ?? 'none'}`;
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      ui.field(t(locale, 'recording'), statusLineText(status, locale));
    };

    silenceSqliteExperimentalWarning();
    const {startServer} = await import('../server/index.mjs');
    try {
      server = await startServer({
        dataDir: dataDirInfo.dir,
        port: options.port ?? null,
        logger,
        now,
        systemLocale,
        env,
        // Relocation changes the data folder while the process keeps running.
        // Move the single-instance lock with it so a second launch cannot write
        // the new folder at the same time.
        beginLockMove: async ({paths: targetPaths}) => {
          const nextLock = acquireInstanceLock({
            lockFile: targetPaths.lockFile,
            now: now(),
            exePath: process.execPath
          });
          if (!nextLock.acquired) {
            throw new AppError('LOCK_FAILED', {
              messageKey: 'errors.relocationLockFailed',
              details: {path: targetPaths.lockFile},
              httpStatus: 409
            });
          }
          const previousLock = lock;
          return {
            commit: () => {
              previousLock?.release?.();
              lock = nextLock;
              try {
                writeFileSync(targetPaths.runtimeFile, `${JSON.stringify({
                  pid: process.pid,
                  port: server?.port ?? null,
                  url: server?.url ?? null,
                  version: APP_VERSION,
                  startedAt: new Date(now()).toISOString()
                }, null, 2)}\n`, 'utf8');
              } catch {
                /* the lock still prevents a second writer */
              }
            },
            abort: () => {
              nextLock?.release?.();
            }
          };
        }
      });
    } catch (error) {
      const code = String(error?.code ?? '');
      const detail = code === 'PORT_UNAVAILABLE'
        ? t(locale, 'portConflict')
        : code.includes('SQLITE') || error?.messageKey === 'databaseError' || code === 'DATABASE_ERROR'
          ? t(locale, 'databaseError')
          : t(locale, 'serverStartFailed');
      throw startupError({
        code: code || 'SERVER_START_FAILED',
        step: 'server-start',
        userMessage: detail,
        extra: error?.path ? [`${error.code ?? 'error'}: ${error.path}`] : [],
        cause: error
      });
    }
    startupLog.record('server-start', {ok: true, port: server.port, url: server.url});
    lock.update({url: server.url, port: server.port});

    ui.blank();
    ui.field(t(locale, 'dataDir'), server.paths.root);
    ui.field(t(locale, 'consoleUrl'), server.url);
    ui.field(t(locale, 'logFile'), server.paths.logs);
    if (server.recovered.length > 0) {
      ui.warn(t(locale, 'recoveredSessions', {count: server.recovered.length}));
    }
    printStatus(server.sessionManager.status());
    const originalStatusChange = server.sessionManager.onStatusChange;
    server.sessionManager.onStatusChange = (status) => {
      originalStatusChange?.(status);
      printStatus(status);
    };
    ui.blank();
    ui.note(t(locale, 'simulatedNote'));
    ui.note(t(locale, 'webHint'));
    ui.field(t(locale, 'quitting'), t(locale, 'quitHint'));
    ui.footer();

    if (options.open) {
      ui.info(t(locale, 'openingBrowser'));
      const opened = openBrowser(server.url);
      startupLog.record('browser', {ok: Boolean(opened?.opened)});
      logger.info({event: 'launcher.browser', opened: opened.opened});
      ui.info(opened.opened ? t(locale, 'browserOpened') : t(locale, 'browserFailed'));
    }

    server.server.once('close', () => {
      if (!shuttingDown) {
        shuttingDown = true;
        shutdown('server-closed').catch(() => resolveDone());
      } else {
        resolveDone();
      }
    });

    await done;
    return 0;
  } catch (error) {
    return reportFatal(error);
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      try {
        process.removeListener(signal, handler);
      } catch {
        /* ignore */
      }
    }
    if (lock?.acquired) lock.release();
  }
}

/**
 * `--diagnose` prints the environment facts a support report needs: candidate
 * data folders with the real write-probe result, the log location, ports.
 * It never opens a browser and never touches the database.
 */
function runDiagnostics({options, env, ui, locale, startupLog, stdout, stdin}) {
  const dataEnv = env;
  let resolved = null;
  let resolveError = null;
  try {
    resolved = resolveDataDir({env: dataEnv, requested: options.dataDir});
  } catch (error) {
    resolveError = error;
  }
  startupLog.record('diagnose', {dataDir: resolved?.dir ?? null, ok: Boolean(resolved)});
  const localeOut = locale;
  ui.blank();
  ui.info(`${APP_NAME} ${APP_VERSION}`);
  ui.info(t(localeOut, 'diagTitle'));
  ui.blank();
  ui.note(t(localeOut, 'diagCandidates'));
  const attempts = resolved?.attempts ?? resolveError?.attempts ?? [];
  for (const attempt of attempts) {
    const state = attempt.ok
      ? t(localeOut, 'diagWritable')
      : t(localeOut, 'diagNotWritable', {code: attempt.code ?? 'error', step: attempt.step ?? 'probe'});
    ui.note(`  ${attempt.dir} — ${state}`);
  }
  if (resolved) {
    ui.blank();
    ui.field(t(localeOut, 'dataDir'), resolved.dir);
    ui.info(resolved.fallback ? t(localeOut, 'fallbackDataDir', {path: resolved.dir}) : '');
  } else {
    ui.blank();
    ui.error(t(localeOut, 'dataDirUnwritable', {path: resolveError?.path ?? options.dataDir ?? '?'}));
  }
  const logFile = startupLog.file();
  if (logFile) ui.field(t(localeOut, 'logFile'), logFile);
  ui.blank();
  if (resolved) ui.note(t(localeOut, 'diagResult'));
  if (isInteractive({stdin})) {
    return pauseForUser({stdin, stdout, enabled: options.waitOnError, prompt: t(localeOut, 'pressKey')}).then(() => (resolved ? 0 : 1));
  }
  return resolved ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runLauncher()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${APP_NAME}: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

export const __internal = {statusLineText, resolveConsoleLocale};
