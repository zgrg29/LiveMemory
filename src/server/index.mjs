import {writeFileSync, rmSync} from 'node:fs';
import {openDatabase, closeDatabase} from '../storage/database/connection.mjs';
import {migrate} from '../storage/database/migrations/index.mjs';
import {createPaths, ensureDirectories, assertWritable} from './paths.mjs';
import {SettingsStore} from './settings-store.mjs';
import {EventStream} from './sse.mjs';
import {SessionManager} from '../platforms/shared/session-manager.mjs';
import {createApp} from './app.mjs';
import {startHttpServer, resolveWebRoot} from './http.mjs';
import {serializeEvent} from './serializers.mjs';
import {detectSystemLocale} from '../shared/locale.mjs';
import {AppError, ERROR_CODES} from '../shared/errors.mjs';
import {APP_VERSION} from '../shared/app-info.mjs';
import {isoFromEpochMs} from '../shared/time.mjs';

/**
 * Start the full application (settings, database, platform manager, HTTP).
 * Shared by the Windows launcher, development runs and integration tests.
 */

function writeRuntime(paths, payload) {
  writeFileSync(paths.runtimeFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function removeRuntime(paths) {
  try {
    rmSync(paths.runtimeFile, {force: true});
  } catch {
    /* best effort */
  }
}

function buildPortCandidates(preferred) {
  const base = Number.isInteger(preferred) && preferred > 0 ? preferred : 47800;
  const candidates = [];
  for (let offset = 0; offset < 10; offset += 1) candidates.push(base + offset);
  candidates.push(0); // let the OS pick any free port
  return candidates;
}

export async function startServer({
  dataDir,
  port = null,
  logger = null,
  now = () => Date.now(),
  webRoot = null,
  systemLocale = null
} = {}) {
  if (!dataDir) throw new Error('startServer: dataDir is required');
  const paths = ensureDirectories(createPaths(dataDir));
  assertWritable(paths);

  const settingsStore = new SettingsStore({file: paths.settingsFile, logger});
  settingsStore.load();

  const db = openDatabase({file: paths.databaseFile});
  const migration = migrate(db, {now: now(), log: (record) => logger?.info(record)});

  const hub = new EventStream();
  const sessionManager = new SessionManager({
    db,
    settings: settingsStore,
    logger,
    now,
    onEvent: (event) => hub.broadcast('event', serializeEvent(event)),
    onStatusChange: (status) => hub.broadcast('status', status)
  });
  const recovered = sessionManager.recoverInterrupted();

  const startedAt = now();
  const state = {port: 0};
  const deps = {
    paths,
    db,
    settingsStore,
    sessionManager,
    hub,
    logger,
    startedAt,
    webRoot: webRoot ?? resolveWebRoot(),
    getPort: () => state.port,
    systemLocale: systemLocale ?? detectSystemLocale()
  };
  const handler = createApp(deps);

  const preferred = port ?? settingsStore.get().preferredPort ?? 47800;
  const candidates = port === 0 ? [0] : buildPortCandidates(preferred);
  let server = null;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      server = await startHttpServer({handler, preferredPort: candidate, logger});
      break;
    } catch (error) {
      if (error.code === 'PORT_UNAVAILABLE') {
        lastError = error;
        continue;
      }
      closeDatabase(db);
      throw error;
    }
  }
  if (!server) {
    closeDatabase(db);
    throw new AppError('PORT_UNAVAILABLE', {
      messageKey: 'errors.portUnavailable',
      httpStatus: 409,
      cause: lastError
    });
  }

  state.port = server.address().port;
  const url = `http://127.0.0.1:${state.port}/`;
  writeRuntime(paths, {
    pid: process.pid,
    port: state.port,
    url,
    version: APP_VERSION,
    startedAt: isoFromEpochMs(startedAt)
  });
  logger?.info({
    event: 'server.ready',
    port: state.port,
    url,
    dataDir: paths.root,
    schemaVersion: migration.to,
    recoveredSessions: recovered.length
  });

  let closed = false;
  async function close() {
    if (closed) return false;
    closed = true;
    try {
      hub.closeAll();
    } catch {
      /* ignore */
    }
    try {
      await sessionManager.shutdown();
    } catch (error) {
      logger?.error({event: 'shutdown.session.failed', code: error?.code ?? 'unknown'});
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      timer.unref?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections?.();
    });
    server.closeAllConnections?.();
    closeDatabase(db);
    removeRuntime(paths);
    logger?.info({event: 'server.closed', port: state.port});
    return true;
  }

  return {
    server,
    url,
    port: state.port,
    paths,
    db,
    settings: settingsStore,
    sessionManager,
    hub,
    recovered,
    migration,
    startedAt,
    systemLocale: deps.systemLocale,
    close,
    webRoot: deps.webRoot
  };
}
