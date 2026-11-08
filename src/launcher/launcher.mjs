import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createPaths} from '../server/paths.mjs';
import {AppError} from '../shared/errors.mjs';
import {detectSystemLocale, normalizeLocale, resolveLocale} from '../shared/locale.mjs';
import {APP_NAME, APP_VERSION} from '../shared/app-info.mjs';
import {SettingsStore} from '../server/settings-store.mjs';
import {createLogger} from '../server/logger.mjs';
import {resolveDataDir} from './data-dir.mjs';
import {acquireInstanceLock, readRuntimeInfo} from './lock.mjs';
import {enableUtf8Console, createConsole, openDefaultBrowser} from './console.mjs';
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
 * The console window stays open on purpose (M1 requirement); it shows a small
 * number of human lines, never raw chat messages.
 */

export function parseArguments(argv = []) {
  const options = {
    open: true,
    port: null,
    dataDir: null,
    lang: null,
    help: false,
    version: false,
    waitOnError: true,
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

async function waitForEnter({enabled, stdin = process.stdin, stdout = process.stdout}) {
  if (!enabled || !stdin.isTTY) return;
  stdout.write('\n');
  await new Promise((resolve) => {
    const onData = () => {
      stdin.pause();
      resolve();
    };
    stdin.resume();
    stdin.once('data', onData);
  });
}

function statusLineText(status, locale) {
  const session = status?.activeSession ?? null;
  if (!session) {
    return ['connecting', 'reconnecting'].includes(status?.connection)
      ? t(locale, 'statusStarting')
      : t(locale, 'statusIdle');
  }
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

/**
 * Run the launcher to completion. Resolves with an exit code.
 * @param {{argv?: string[], env?: object, stdout?: object, stderr?: object, openBrowser?: Function, now?: Function}} context
 */
export async function runLauncher({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openBrowser = openDefaultBrowser,
  now = () => Date.now()
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${APP_NAME}: ${error.code}\n`);
    return 2;
  }

  const utf8 = enableUtf8Console({stdout});
  const systemLocale = detectSystemLocale(env);
  let locale = options.lang ?? resolveLocale('system', systemLocale);
  const unicode = process.platform !== 'win32' || utf8.changed;
  let ui = createConsole({locale, stdout, stderr, unicode});

  if (options.version) {
    stdout.write(`${APP_NAME} ${APP_VERSION}\n`);
    return 0;
  }
  if (options.help) {
    stdout.write(`\n${APP_NAME} ${APP_VERSION}\n\n${t(locale, 'helpTitle')}\n${t(locale, 'helpBody')}\n\n`);
    return 0;
  }

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    ui.error(t(locale, 'unsupportedNode', {expected: nodeCheck.expected, actual: nodeCheck.actual}));
    await waitForEnter({enabled: options.waitOnError, stdout});
    return 1;
  }
  const sqlite = await checkSqliteSupport();
  if (!sqlite.ok) {
    ui.error(t(locale, 'sqliteUnavailable'));
    await waitForEnter({enabled: options.waitOnError, stdout});
    return 1;
  }

  let dataDirInfo;
  try {
    dataDirInfo = resolveDataDir({env, requested: options.dataDir});
  } catch (error) {
    ui.error(`${t(locale, 'fatalTitle')}: ${t(locale, 'dataDirUnwritable', {path: error.path ?? options.dataDir ?? '?'})}`);
    ui.note(t(locale, 'dataDirHint'));
    for (const attempt of error.attempts ?? []) {
      ui.note(`  ${attempt.dir} (${attempt.code ?? 'error'})`);
    }
    await waitForEnter({enabled: options.waitOnError, stdout});
    return 1;
  }

  const paths = createPaths(dataDirInfo.dir);
  const settingsStore = new SettingsStore({file: paths.settingsFile});
  settingsStore.load();
  if (!options.lang) {
    locale = resolveLocale(settingsStore.get().locale, systemLocale);
  }
  ui = createConsole({locale, stdout, stderr, unicode});

  const logger = createLogger({dir: paths.logs});
  logger.info({event: 'launcher.start', version: APP_VERSION, dataDir: paths.root, locale, system: systemLocale});

  ui.banner({name: APP_NAME, version: APP_VERSION, productLine: t(locale, 'productLine')});
  ui.info(t(locale, 'checkingEnvironment'));
  ui.info(t(locale, 'environmentOk'));

  const lock = acquireInstanceLock({lockFile: paths.lockFile, now: now()});
  if (!lock.acquired) {
    const runtime = readRuntimeInfo(paths.runtimeFile);
    const fallbackPort = lock.existing?.port ?? settingsStore.get().preferredPort ?? 47800;
    const url = runtime?.url ?? `http://127.0.0.1:${fallbackPort}/`;
    ui.blank();
    ui.info(t(locale, 'alreadyRunning'));
    ui.field(t(locale, 'consoleUrl'), url);
    if (options.open) {
      const opened = openBrowser(url);
      ui.info(opened.opened ? t(locale, 'alreadyRunningUrl') : t(locale, 'browserFailed'));
    }
    ui.blank();
    logger.info({event: 'launcher.already_running', pid: lock.existing?.pid ?? null, url});
    return 0;
  }

  let server = null;
  let shuttingDown = false;
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async (reason) => {
    ui.blank();
    ui.info(t(locale, 'shuttingDown'));
    logger.info({event: 'launcher.shutdown', reason});
    try {
      if (server) await server.close();
    } catch (error) {
      logger.error({event: 'launcher.shutdown.failed', code: error?.code ?? 'unknown'});
    }
    lock.release();
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
  const signalHandlers = {SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM'), SIGHUP: () => onSignal('SIGHUP')};
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

  try {
    silenceSqliteExperimentalWarning();
    const {startServer} = await import('../server/index.mjs');
    server = await startServer({
      dataDir: dataDirInfo.dir,
      port: options.port ?? null,
      logger,
      now,
      systemLocale
    });
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
      ui.info(opened.opened ? t(locale, 'browserOpened') : t(locale, 'browserFailed'));
      logger.info({event: 'launcher.browser', opened: opened.opened});
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
    logger.error({event: 'launcher.fatal', code: error?.code ?? 'unknown', messageKey: error?.messageKey ?? null});
    try {
      writeFileSync(paths.errorFile, `${JSON.stringify({
        at: new Date(now()).toISOString(),
        code: error?.code ?? 'unknown',
        messageKey: error?.messageKey ?? null,
        port: options.port ?? null
      }, null, 2)}\n`, 'utf8');
    } catch {
      /* diagnostics are best effort */
    }
    const code = String(error?.code ?? '');
    ui.blank();
    ui.error(t(locale, 'fatalTitle'));
    const detail = code === 'PORT_UNAVAILABLE'
      ? t(locale, 'portConflict')
      : code.includes('SQLITE') || error?.messageKey === 'databaseError'
        ? t(locale, 'databaseError')
        : t(locale, 'dataDirHint');
    ui.note(detail);
    ui.field(t(locale, 'dataDir'), dataDirInfo.dir);
    if (code) ui.note(`code: ${code}`);
    if (shuttingDown) {
      if (server) await server.close().catch(() => {});
    } else {
      shuttingDown = true;
      await shutdown('startup-failed');
    }
    lock.release();
    await waitForEnter({enabled: options.waitOnError, stdout});
    return 1;
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      try {
        process.removeListener(signal, handler);
      } catch {
        /* ignore */
      }
    }
    if (lock.acquired) lock.release();
  }
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

export const __internal = {statusLineText};
