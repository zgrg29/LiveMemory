import {writeFileSync, rmSync} from 'node:fs';
import {openDatabase, closeDatabase} from '../storage/database/connection.mjs';
import {migrate} from '../storage/database/migrations/index.mjs';
import {createPaths, ensureDirectories, assertWritable} from './paths.mjs';
import {SettingsStore} from './settings-store.mjs';
import {EventStream} from './sse.mjs';
import {SessionManager} from '../platforms/shared/session-manager.mjs';
import {BilibiliService} from '../platforms/bilibili/service.mjs';
import {YouTubeService} from '../platforms/youtube/service.mjs';
import {runRetention} from '../storage/retention.mjs';
import {createApp} from './app.mjs';
import {startHttpServer, resolveWebRoot} from './http.mjs';
import {serializeEvent} from './serializers.mjs';
import {detectSystemLocale} from '../shared/locale.mjs';
import {AppError} from '../shared/errors.mjs';
import {APP_VERSION} from '../shared/app-info.mjs';
import {isoFromEpochMs} from '../shared/time.mjs';

/**
 * Start the full application (settings, database, platform manager, HTTP).
 * Shared by the Windows launcher, development runs and integration tests.
 *
 * The database-dependent services are built by `buildRuntime`, so a verified
 * data-folder relocation can stop the old runtime, build a new one at the
 * target and keep the same HTTP socket (and open console) alive.
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
  systemLocale = null,
  youtubeWebBase = null,
  beginLockMove = null,
  env = process.env
} = {}) {
  if (!dataDir) throw new Error('startServer: dataDir is required');
  const hub = new EventStream();
  let runtime = null;

  function buildRuntime(dir) {
    const paths = ensureDirectories(createPaths(dir));
    assertWritable(paths);
    const settingsStore = new SettingsStore({file: paths.settingsFile, logger});
    settingsStore.load();
    const db = openDatabase({file: paths.databaseFile});
    let migration;
    try {
      migration = migrate(db, {now: now(), log: (record) => logger?.info(record)});
    } catch (error) {
      closeDatabase(db);
      throw error;
    }
    const sessionManager = new SessionManager({
      db,
      settings: settingsStore,
      logger,
      now,
      onEvent: (event) => hub.broadcast('event', serializeEvent(event)),
      onStatusChange: (status) => hub.broadcast('status', status)
    });
    const recovered = sessionManager.recoverInterrupted();
    const bilibili = new BilibiliService({
      secretsDir: paths.secrets,
      sessionManager,
      logger,
      now
    });
    const youtube = new YouTubeService({
      sessionManager,
      db,
      settings: settingsStore,
      logger,
      now,
      webBase: youtubeWebBase
    });
    runRetention(db, {
      now: now(),
      days: settingsStore.get().youtubeRawRetentionDays,
      logger
    });
    return {paths, db, settingsStore, sessionManager, bilibili, youtube, recovered, migration};
  }

  async function stopAdapters(instance) {
    // SessionManager owns every adapter, including their per-stream timers.
    try {
      await instance.sessionManager.shutdown();
    } catch (error) {
      logger?.error({event: 'shutdown.session.failed', code: error?.code ?? 'unknown'});
    }
  }

  async function stopRuntime(instance) {
    await stopAdapters(instance);
    closeDatabase(instance.db);
  }

  runtime = buildRuntime(dataDir);
  const startedAt = now();
  const state = {port: 0, maintenance: false};
  const deps = {
    get paths() { return runtime.paths; },
    get db() { return runtime.db; },
    get settingsStore() { return runtime.settingsStore; },
    get sessionManager() { return runtime.sessionManager; },
    get bilibili() { return runtime.bilibili; },
    get youtube() { return runtime.youtube; },
    get maintenance() { return state.maintenance; },
    set maintenance(value) { state.maintenance = Boolean(value); },
    hub,
    logger,
    startedAt,
    webRoot: webRoot ?? resolveWebRoot(),
    getPort: () => state.port,
    systemLocale: systemLocale ?? detectSystemLocale(),
    env,
    relocation: {
      get current() { return runtime; },
      stop: () => stopRuntime(runtime),
      build: (dir) => buildRuntime(dir),
      close: (instance) => stopRuntime(instance),
      swap: (next) => { runtime = next; },
      beginLockMove
    }
  };
  const handler = createApp(deps);

  const preferred = port ?? deps.settingsStore.get().preferredPort ?? 47800;
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
      closeDatabase(runtime.db);
      throw error;
    }
  }
  if (!server) {
    closeDatabase(runtime.db);
    throw new AppError('PORT_UNAVAILABLE', {
      messageKey: 'errors.portUnavailable',
      httpStatus: 409,
      cause: lastError
    });
  }

  state.port = server.address().port;
  const url = `http://127.0.0.1:${state.port}/`;
  writeRuntime(deps.paths, {
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
    dataDir: deps.paths.root,
    schemaVersion: runtime.migration.to,
    recoveredSessions: runtime.recovered.length
  });

  // Historical rows abandoned by a crash/shutdown are probed after the server
  // is available so a slow/blocked platform cannot delay startup. The probe is
  // idempotent, never changes `ended_at`, and only annotates platform state.
  runtime.bilibili?.repairHistoricalSessions({now: now()})
    .then((result) => {
      if (result.checked > 0) {
        logger?.info({
          event: 'session.platform.repair.summary',
          checked: result.checked,
          updated: result.updated,
          failed: result.failed,
          skipped: result.skipped
        });
      }
    })
    .catch((error) => {
      logger?.warn({event: 'session.platform.repair.error', code: error?.code ?? 'unknown'});
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
    await stopAdapters(runtime);
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
    closeDatabase(runtime.db);
    removeRuntime(runtime.paths);
    logger?.info({event: 'server.closed', port: state.port});
    return true;
  }

  return {
    server,
    url,
    port: state.port,
    get paths() { return runtime.paths; },
    get db() { return runtime.db; },
    get settings() { return runtime.settingsStore; },
    get sessionManager() { return runtime.sessionManager; },
    get bilibili() { return runtime.bilibili; },
    get youtube() { return runtime.youtube; },
    get runtime() { return runtime; },
    get deps() { return deps; },
    hub,
    get recovered() { return runtime.recovered; },
    get migration() { return runtime.migration; },
    startedAt,
    systemLocale: deps.systemLocale,
    close,
    webRoot: deps.webRoot
  };
}
