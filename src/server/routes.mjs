import {createReadStream, existsSync, statSync, statfsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {sendJson, sendText, readJsonBody} from './http.mjs';
import {AppError, ERROR_CODES} from '../shared/errors.mjs';
import {normalizeLocale} from '../shared/locale.mjs';
import {resolveLocale} from '../shared/locale.mjs';
import {
  serializeBroadcasterRow,
  serializeEvent,
  serializePackage,
  serializeSessionRow,
  serializeViewerRow
} from './serializers.mjs';
import {getSession, listSessions} from '../storage/repositories/sessions.mjs';
import {listEvents, contentStats} from '../storage/repositories/events.mjs';
import {buildSessionSummary} from '../analytics/sessions/summary.mjs';
import {buildViewerProfile} from '../analytics/viewers/profile.mjs';
import {groupCurrencyTotals} from '../analytics/payments/totals.mjs';
import {listViewers, setViewerFocused, sessionSupportBySessionIds, viewerSupportByViewerIds} from '../storage/repositories/viewers.mjs';
import {
  broadcasterAudienceSummary,
  broadcasterSupportByViewerIds,
  broadcasterSupportTotals,
  currentBroadcasterId,
  getBroadcaster,
  listBroadcasterViewers,
  listBroadcasters,
  listUnassignedViewers,
  unassignedOverview,
  unassignedSupportByViewerIds
} from '../storage/repositories/broadcasters.mjs';
import {getPackage, listPackages} from '../storage/repositories/ai-packages.mjs';
import {buildAnalysisPackage, ANALYSIS_PROTOCOL} from '../ai/export/package.mjs';
import {buildInstructions} from '../ai/prompts/instructions.mjs';
import {currentSchemaVersion} from '../storage/database/migrations/index.mjs';
import {databaseSizeBytes} from '../storage/database/connection.mjs';
import {readDataLocation} from '../shared/data-location.mjs';
import {relocateDataDir, validateTarget, __internal as relocationInternal} from './relocation.mjs';
import {openFolder, pickFolder} from './native-dialog.mjs';
import {backupDirectory, clearData, clearPreview, createDatabaseBackup} from './maintenance.mjs';
import {APP_NAME, APP_VERSION, APP_HOMEPAGE} from '../shared/app-info.mjs';
import {toApiError as youtubeError} from '../platforms/youtube/service.mjs';

/**
 * Route table. Every handler is async, returns void and writes the response
 * itself; thrown AppErrors are converted by the HTTP layer.
 */

const SPEEDS = {calm: 1600, normal: 750, busy: 320};

function statusPayload(deps) {
  const {paths, db, settingsStore, sessionManager, startedAt} = deps;
  return {
    server: {
      name: APP_NAME,
      version: APP_VERSION,
      port: deps.getPort(),
      startedAt,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    },
    platform: sessionManager.status(),
    database: {
      ok: true,
      schemaVersion: currentSchemaVersion(db),
      sizeBytes: databaseSizeBytes(paths.databaseFile)
    },
    data: {dir: paths.root},
    storage: {mode: settingsStore.get().storageMode},
    ai: {export: true, import: false, protocol: ANALYSIS_PROTOCOL},
    bilibili: deps.bilibili ? deps.bilibili.status() : null,
    youtube: deps.youtube ? deps.youtube.status() : null
  };
}

function effectiveSettings(deps) {
  const settings = deps.settingsStore.get();
  return {
    settings,
    effective: {
      locale: resolveLocale(settings.locale, deps.systemLocale),
      systemLocale: deps.systemLocale,
      theme: settings.theme,
      storageMode: settings.storageMode
    }
  };
}

function notFound(code = ERROR_CODES.NOT_FOUND, messageKey = 'errors.notFound') {
  return new AppError(code, {messageKey, httpStatus: 404});
}

function freeBytesFor(directory) {
  try {
    const stats = statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function defaultDataDir(env) {
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'LiveMemory');
  if (env.APPDATA) return join(env.APPDATA, 'LiveMemory');
  return null;
}

/** Everything the settings page needs to describe and move the data folder. */
function storageLocation(deps) {
  const pointer = readDataLocation({env: deps.env});
  const dataDir = deps.paths.root;
  const pointerMatches = pointer && resolve(pointer.dataDir) === resolve(dataDir);
  const fallbackDefault = defaultDataDir(deps.env);
  const isDefault = fallbackDefault && resolve(fallbackDefault) === resolve(dataDir);
  const sessions = deps.db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
  const viewers = deps.db.prepare('SELECT COUNT(*) AS count FROM viewers').get();
  const events = deps.db.prepare('SELECT COUNT(*) AS count FROM events').get();
  const live = deps.db.prepare("SELECT id FROM sessions WHERE status = 'live' LIMIT 1").get();
  return {
    dataDir,
    source: pointerMatches ? 'pointer' : (isDefault ? 'default' : 'override'),
    pointerFile: pointer?.pointerFile ?? null,
    pointerUpdatedAt: pointer?.updatedAt ?? null,
    writable: true,
    freeBytes: freeBytesFor(dataDir),
    requiredBytes: relocationInternal.managedSize(deps.paths),
    managedBytes: relocationInternal.managedSize(deps.paths),
    databaseBytes: databaseSizeBytes(deps.paths.databaseFile),
    dirs: {
      data: dataDir,
      exports: deps.paths.exports,
      backups: deps.paths.backups,
      logs: deps.paths.logs
    },
    backupDir: backupDirectory({env: deps.env}),
    counts: {
      sessions: Number(sessions?.count ?? 0),
      viewers: Number(viewers?.count ?? 0),
      events: Number(events?.count ?? 0)
    },
    recording: Boolean(live),
    activeSessionId: live?.id ?? null
  };
}

/**
 * A viewer row inside one broadcaster scope. `scoped` never includes activity
 * from another channel; `lifetime` is the explicit global total.
 */
function scopedViewerRow(row, support = []) {
  const base = serializeViewerRow({
    ...row,
    session_count: row.lifetime_session_count,
    message_count: row.lifetime_message_count,
    payment_event_count: row.lifetime_payment_event_count
  });
  return {
    ...base,
    lifetime: {
      messageCount: base.messageCount,
      paymentEventCount: base.paymentEventCount,
      sessionCount: base.sessionCount
    },
    scoped: {
      messageCount: Number(row.scoped_message_count ?? 0),
      paymentEventCount: Number(row.scoped_payment_event_count ?? 0),
      sessionCount: Number(row.scoped_session_count ?? 0),
      firstSeenAt: row.scoped_first_seen_at ?? null,
      lastSeenAt: row.scoped_last_seen_at ?? null,
      support: groupCurrencyTotals(support)
    }
  };
}

/** Bodies are optional on the small command endpoints. */
async function readOptionalJson(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) return {};
  return readJsonBody(req);
}

/** Platform failures become stable, translatable API errors. */
function bilibiliError(error) {
  if (error instanceof AppError) return error;
  const code = error?.code ?? 'UNKNOWN';
  if (code === 'AUTH' || code === 'AUTH_REQUIRED') {
    return new AppError('BILIBILI_AUTH', {messageKey: 'errors.bilibiliAuth', httpStatus: 401, cause: error});
  }
  if (code === 'ROOM_NOT_FOUND' || code === 'ROOM_INVALID') {
    return new AppError('ROOM_NOT_FOUND', {messageKey: 'errors.roomNotFound', httpStatus: 404, cause: error});
  }
  if (code === 'NETWORK' || code === 'HTTP' || code === 'BAD_RESPONSE') {
    return new AppError('BILIBILI_NETWORK', {messageKey: 'errors.bilibiliNetwork', httpStatus: 502, cause: error});
  }
  return new AppError('BILIBILI_ERROR', {messageKey: 'errors.bilibiliError', httpStatus: 502, cause: error});
}

export function createRouter(routes, deps) {
  const compiled = routes.map((route) => {
    const names = [];
    const pattern = route.path.replace(/:[A-Za-z_]+/g, (token) => {
      names.push(token.slice(1));
      return '([^/]+)';
    });
    return {method: route.method, regex: new RegExp(`^${pattern}$`), names, handler: route.handler};
  });

  return async function route(req, res, url) {
    for (const item of compiled) {
      const match = item.regex.exec(url.pathname);
      if (!match) continue;
      if (item.method !== req.method) continue;
      const params = {};
      item.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      await item.handler({req, res, url, params, deps});
      return true;
    }
    return false;
  };
}

export function buildRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/health',
      handler: ({res, deps}) => {
        sendJson(res, 200, {
          status: 'ok',
          name: APP_NAME,
          version: APP_VERSION,
          port: deps.getPort(),
          startedAt: deps.startedAt
        });
      }
    },
    {
      method: 'GET',
      path: '/api/bootstrap',
      handler: ({res, deps}) => {
        sendJson(res, 200, {
          app: {
            name: APP_NAME,
            version: APP_VERSION,
            homepage: APP_HOMEPAGE,
            startedAt: deps.startedAt
          },
          ...effectiveSettings(deps),
          status: statusPayload(deps),
          capabilities: {
            platforms: [
              {id: 'mock', label: 'Simulation', state: 'available'},
              {id: 'bilibili', label: 'Bilibili Live', state: 'available'},
              {
                id: 'youtube',
                label: 'YouTube Live',
                state: 'available',
                authMode: deps.youtube?.status().authMode ?? 'none',
                captureMode: deps.youtube?.status().captureMode ?? 'official',
                anonymousExperimental: true,
                officialConfigured: Boolean(deps.youtube?.status().officialConfigured)
              }
            ],
            ai: {export: true, import: false},
            backup: {export: false, import: false}
          }
        });
      }
    },
    {
      method: 'GET',
      path: '/api/status',
      handler: ({res, deps}) => sendJson(res, 200, statusPayload(deps))
    },
    {
      method: 'GET',
      path: '/api/settings',
      handler: ({res, deps}) => sendJson(res, 200, effectiveSettings(deps))
    },
    {
      method: 'PATCH',
      path: '/api/settings',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        deps.settingsStore.update(body);
        deps.logger?.info({event: 'settings.updated', keys: Object.keys(body)});
        sendJson(res, 200, effectiveSettings(deps));
      }
    },
    {
      method: 'GET',
      path: '/api/sessions',
      handler: ({res, url, deps}) => {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const platform = url.searchParams.get('platform');
        const broadcasterId = url.searchParams.get('broadcasterId');
        const unassigned = url.searchParams.get('scope') === 'unassigned';
        const rows = listSessions(deps.db, {limit, offset, platform, broadcasterId, unassigned});
        const support = sessionSupportBySessionIds(deps.db, rows.map((row) => row.id));
        sendJson(res, 200, {
          sessions: rows.map((row) => ({...serializeSessionRow(row), support: support.get(row.id) ?? []}))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/current',
      handler: ({res, deps}) => {
        const live = deps.sessionManager.status().activeSession;
        if (!live) {
          sendJson(res, 200, {session: null});
          return;
        }
        sendJson(res, 200, {session: buildSessionSummary(deps.db, live.id)});
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/:id',
      handler: ({res, params, deps}) => {
        const summary = buildSessionSummary(deps.db, params.id);
        if (!summary) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        sendJson(res, 200, summary);
      }
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/stop',
      handler: async ({res, params, deps}) => {
        const session = getSession(deps.db, params.id);
        if (!session) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        if (session.status !== 'live') {
          throw new AppError(ERROR_CODES.SESSION_NOT_ACTIVE, {messageKey: 'errors.sessionNotActive', httpStatus: 409});
        }
        const result = await deps.sessionManager.stopActive();
        sendJson(res, 200, {session: serializeSessionRow(result.session)});
      }
    },
    {
      method: 'POST',
      path: '/api/simulate/start',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'Simulated stream';
        const speed = typeof body.speed === 'string' && Object.hasOwn(SPEEDS, body.speed) ? body.speed : 'normal';
        const result = await deps.sessionManager.startSimulation({title, intervalMs: SPEEDS[speed]});
        if (!result.started) {
          sendJson(res, 409, {
            error: {
              code: 'SESSION_ACTIVE',
              messageKey: 'errors.sessionActive',
              details: {sessionId: result.session?.id ?? null}
            }
          });
          return;
        }
        sendJson(res, 201, {session: serializeSessionRow(result.session), speed});
      }
    },
    {
      method: 'POST',
      path: '/api/simulate/stop',
      handler: async ({res, deps}) => {
        const result = await deps.sessionManager.stopActive();
        sendJson(res, 200, {session: result.session ? serializeSessionRow(result.session) : null});
      }
    },
    {
      method: 'GET',
      path: '/api/broadcasters',
      handler: ({res, url, deps}) => {
        const query = url.searchParams.get('query') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const rows = listBroadcasters(deps.db, {query, limit});
        sendJson(res, 200, {
          broadcasters: rows.map(serializeBroadcasterRow),
          currentId: currentBroadcasterId(deps.db),
          unassigned: unassignedOverview(deps.db)
        });
      }
    },
    {
      method: 'GET',
      path: '/api/broadcasters/:id',
      handler: ({res, params, deps}) => {
        const audience = broadcasterAudienceSummary(deps.db, params.id);
        if (!audience) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.notFound');
        sendJson(res, 200, {
          broadcaster: serializeBroadcasterRow(audience.broadcaster),
          audience: {
            viewerCount: audience.viewerCount,
            sessionCount: audience.sessionCount,
            messageCount: audience.messageCount,
            paymentEventCount: audience.paymentEventCount,
            newViewers: audience.newViewers,
            returningViewers: audience.returningViewers,
            latestSession: audience.latestSession
          },
          support: groupCurrencyTotals(broadcasterSupportTotals(deps.db, params.id))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/broadcasters/:id/viewers',
      handler: ({res, url, params, deps}) => {
        const broadcaster = getBroadcaster(deps.db, params.id);
        if (!broadcaster) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.notFound');
        const query = url.searchParams.get('query') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const sort = url.searchParams.get('sort') ?? 'messages';
        const rows = listBroadcasterViewers(deps.db, params.id, {query, limit, sort});
        const support = broadcasterSupportByViewerIds(deps.db, params.id, rows.map((row) => row.id));
        sendJson(res, 200, {
          broadcaster: serializeBroadcasterRow(broadcaster),
          summary: broadcasterAudienceSummary(deps.db, params.id),
          support: groupCurrencyTotals(broadcasterSupportTotals(deps.db, params.id)),
          viewers: rows.map((row) => scopedViewerRow(row, support.get(row.id) ?? []))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/viewers',
      handler: ({res, url, deps}) => {
        const query = url.searchParams.get('query') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const platform = url.searchParams.get('platform');
        const broadcasterId = url.searchParams.get('broadcasterId');
        const unassigned = url.searchParams.get('scope') === 'unassigned';
        if (broadcasterId) {
          const broadcaster = getBroadcaster(deps.db, broadcasterId);
          if (!broadcaster) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.notFound');
          const rows = listBroadcasterViewers(deps.db, broadcasterId, {
            query,
            limit,
            sort: url.searchParams.get('sort') ?? 'messages'
          });
          const support = broadcasterSupportByViewerIds(deps.db, broadcasterId, rows.map((row) => row.id));
          sendJson(res, 200, {
            scope: {kind: 'broadcaster', broadcaster: serializeBroadcasterRow(broadcaster)},
            viewers: rows.map((row) => scopedViewerRow(row, support.get(row.id) ?? []))
          });
          return;
        }
        if (unassigned) {
          const rows = listUnassignedViewers(deps.db, {query, limit});
          const support = unassignedSupportByViewerIds(deps.db, rows.map((row) => row.id));
          sendJson(res, 200, {
            scope: {kind: 'unassigned', unassigned: unassignedOverview(deps.db)},
            viewers: rows.map((row) => scopedViewerRow(row, support.get(row.id) ?? []))
          });
          return;
        }
        const rows = listViewers(deps.db, {query, limit, platform});
        const support = viewerSupportByViewerIds(deps.db, rows.map((row) => row.id));
        sendJson(res, 200, {
          scope: {kind: 'all'},
          viewers: rows.map((row) => ({
            ...serializeViewerRow(row),
            support: groupCurrencyTotals(support.get(row.id) ?? [])
          }))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/viewers/:id',
      handler: ({res, url, params, deps}) => {
        const broadcasterId = url.searchParams.get('broadcasterId');
        const unassigned = url.searchParams.get('scope') === 'unassigned';
        const profile = buildViewerProfile(deps.db, params.id, {
          broadcasterId: broadcasterId || null,
          unassigned
        });
        if (!profile) throw notFound(ERROR_CODES.VIEWER_NOT_FOUND, 'errors.viewerNotFound');
        sendJson(res, 200, profile);
      }
    },
    {
      method: 'PATCH',
      path: '/api/viewers/:id',
      handler: async ({req, res, params, deps}) => {
        const body = await readJsonBody(req);
        if (typeof body.focused !== 'boolean') {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const profile = buildViewerProfile(deps.db, params.id);
        if (!profile) throw notFound(ERROR_CODES.VIEWER_NOT_FOUND, 'errors.viewerNotFound');
        setViewerFocused(deps.db, params.id, body.focused);
        sendJson(res, 200, buildViewerProfile(deps.db, params.id));
      }
    },
    {
      method: 'GET',
      path: '/api/events',
      handler: ({res, url, deps}) => {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const beforeId = url.searchParams.get('beforeId');
        const rows = listEvents(deps.db, {sessionId, limit, beforeId: beforeId ? Number(beforeId) : null});
        sendJson(res, 200, {events: rows.map(serializeEvent)});
      }
    },
    {
      method: 'GET',
      path: '/api/events/stream',
      handler: ({req, res, deps}) => {
        deps.hub.add(req, res);
        // Response stays open until the client disconnects.
      }
    },
    {
      method: 'GET',
      path: '/api/storage',
      handler: ({res, deps}) => {
        const {db, paths, settingsStore} = deps;
        const sessions = db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
        const viewers = db.prepare('SELECT COUNT(*) AS count FROM viewers').get();
        const events = db.prepare('SELECT COUNT(*) AS count FROM events').get();
        const purged = db.prepare('SELECT COUNT(*) AS count FROM events WHERE content_purged_at IS NOT NULL').get();
        sendJson(res, 200, {
          mode: settingsStore.get().storageMode,
          dataDir: paths.root,
          databaseBytes: databaseSizeBytes(paths.databaseFile),
          exportsDir: paths.exports,
          backupsDir: paths.backups,
          counts: {
            sessions: Number(sessions?.count ?? 0),
            viewers: Number(viewers?.count ?? 0),
            events: Number(events?.count ?? 0),
            purgedEvents: Number(purged?.count ?? 0)
          }
        });
      }
    },
    {
      method: 'GET',
      path: '/api/storage/location',
      handler: ({res, deps}) => sendJson(res, 200, storageLocation(deps))
    },
    {
      method: 'POST',
      path: '/api/storage/location/validate',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        const mode = body.mode === 'new' ? 'new' : 'migrate';
        const validation = validateTarget({
          targetDir: body.targetDir,
          sourceDir: deps.paths.root,
          mode,
          env: deps.env,
          sourceBytes: relocationInternal.managedSize(deps.paths)
        });
        sendJson(res, 200, validation);
      }
    },
    {
      method: 'POST',
      path: '/api/storage/location/pick',
      handler: async ({res}) => {
        const selected = await pickFolder({});
        sendJson(res, 200, {path: selected});
      }
    },
    {
      method: 'POST',
      path: '/api/storage/location',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        if (deps.maintenance) {
          throw new AppError('MAINTENANCE', {messageKey: 'errors.maintenance', httpStatus: 503});
        }
        deps.maintenance = true;
        try {
          const result = await relocateDataDir({
            deps,
            targetDir: body.targetDir,
            mode: body.mode === 'new' ? 'new' : 'migrate',
            acceptWarnings: body.acceptWarnings === true,
            env: deps.env
          });
          deps.logger?.info({
            event: 'storage.relocated',
            mode: result.mode,
            from: result.previousDir,
            to: result.dataDir
          });
          sendJson(res, 200, {relocation: result, storage: storageLocation(deps)});
        } finally {
          deps.maintenance = false;
        }
      }
    },
    {
      method: 'POST',
      path: '/api/storage/open',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        const target = String(body.target ?? 'data');
        const directories = {
          data: deps.paths.root,
          exports: deps.paths.exports,
          backups: deps.paths.backups,
          logs: deps.paths.logs
        };
        if (!Object.hasOwn(directories, target)) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const folder = directories[target];
        const result = await openFolder(folder);
        sendJson(res, 200, {opened: result.opened, path: folder});
      }
    },
    {
      method: 'GET',
      path: '/api/storage/clear/preview',
      handler: ({res, deps}) => sendJson(res, 200, clearPreview(deps.db, deps.paths, {env: deps.env}))
    },
    {
      method: 'POST',
      path: '/api/storage/backup',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        const backup = createDatabaseBackup({db: deps.db, env: deps.env});
        sendJson(res, 201, {backup});
      }
    },
    {
      method: 'POST',
      path: '/api/storage/clear',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        const mode = body.mode === 'factory' ? 'factory' : (body.mode === 'data' ? 'data' : null);
        if (!mode) {
          throw new AppError('CLEAR_MODE_INVALID', {messageKey: 'errors.clearModeInvalid', httpStatus: 400});
        }
        const expected = mode === 'factory' ? 'RESET' : 'DELETE';
        if (String(body.confirmText ?? '') !== expected) {
          throw new AppError('CONFIRM_TEXT_MISMATCH', {
            messageKey: 'errors.confirmTextMismatch',
            details: {expected},
            httpStatus: 400
          });
        }
        if (deps.maintenance) {
          throw new AppError('MAINTENANCE', {messageKey: 'errors.maintenance', httpStatus: 503});
        }
        deps.maintenance = true;
        try {
          const result = await clearData({
            deps,
            mode,
            backupFirst: body.backupFirst === true,
            env: deps.env
          });
          const effective = effectiveSettings(deps);
          deps.logger?.info({
            event: 'storage.cleared',
            mode,
            backup: Boolean(result.backup),
            sessionsBefore: result.before.sessions,
            eventsBefore: result.before.events
          });
          sendJson(res, 200, {
            clear: result,
            ...effective,
            storage: storageLocation(deps)
          });
        } finally {
          deps.maintenance = false;
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/instructions',
      handler: ({res, url, deps}) => {
        const requested = normalizeLocale(url.searchParams.get('locale'));
        const locale = requested && requested !== 'system'
          ? requested
          : resolveLocale(deps.settingsStore.get().locale, deps.systemLocale);
        sendJson(res, 200, {locale, text: buildInstructions(locale)});
      }
    },
    {
      method: 'POST',
      path: '/api/ai/packages',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
        if (!sessionId) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const summary = buildSessionSummary(deps.db, sessionId);
        if (!summary) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        if (summary.stats.messages === 0) {
          throw new AppError('SESSION_EMPTY', {messageKey: 'errors.sessionEmpty', httpStatus: 409});
        }
        const requested = body.locale ? normalizeLocale(body.locale) : null;
        const locale = requested && requested !== 'system'
          ? requested
          : resolveLocale(deps.settingsStore.get().locale, deps.systemLocale);
        const result = await buildAnalysisPackage({
          db: deps.db,
          sessionId,
          locale,
          exportsDir: deps.paths.exports,
          now: Date.now()
        });
        deps.logger?.info({event: 'ai.package.created', packageId: result.id, sessionId, messages: result.messageCount});
        sendJson(res, 201, {
          package: {
            id: result.id,
            sessionId: result.sessionId,
            fileName: result.fileName,
            bytes: result.bytes,
            checksum: result.checksum,
            messageCount: result.messageCount,
            viewerCount: result.viewerCount,
            locale: result.locale,
            protocol: result.protocol,
            createdAt: result.createdAt
          }
        });
      }
    },
    {
      method: 'GET',
      path: '/api/ai/packages',
      handler: ({res, url, deps}) => {
        const sessionId = url.searchParams.get('sessionId');
        const rows = listPackages(deps.db, {sessionId});
        sendJson(res, 200, {packages: rows.map(serializePackage)});
      }
    },
    {
      method: 'GET',
      path: '/api/ai/packages/:id/download',
      handler: ({res, params, deps}) => {
        const record = getPackage(deps.db, params.id);
        if (!record) throw notFound();
        const absolute = join(deps.paths.exports, record.relative_path);
        if (!existsSync(absolute)) throw notFound();
        const stat = statSync(absolute);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${record.file_name.replace(/"/g, '')}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        createReadStream(absolute).pipe(res);
      }
    },
    {
      method: 'GET',
      path: '/api/bilibili/status',
      handler: ({res, deps}) => {
        sendJson(res, 200, deps.bilibili.status());
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/login/qrcode',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        try {
          const qr = await deps.bilibili.loginWithQr();
          sendJson(res, 201, {url: qr.url, expiresAt: qr.expiresAt, state: qr.state});
        } catch (error) {
          throw bilibiliError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/login/poll',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        try {
          const result = await deps.bilibili.pollLogin();
          sendJson(res, 200, {state: result.state, user: result.user});
        } catch (error) {
          throw bilibiliError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/login/logout',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        await deps.bilibili.logout();
        sendJson(res, 200, deps.bilibili.status());
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/room',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        try {
          const room = await deps.bilibili.checkRoom(body.roomId);
          sendJson(res, 200, {room});
        } catch (error) {
          throw bilibiliError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/connect',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        try {
          const result = await deps.bilibili.connect(body.roomId);
          sendJson(res, 201, {
            session: serializeSessionRow(result.session),
            room: result.room,
            connection: result.connection
          });
        } catch (error) {
          throw bilibiliError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/bilibili/disconnect',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        const result = await deps.bilibili.disconnect();
        sendJson(res, 200, {stopped: Boolean(result?.stopped), session: serializeSessionRow(result?.session ?? null)});
      }
    },
    {
      method: 'GET',
      path: '/api/youtube/status',
      handler: ({res, deps}) => {
        sendJson(res, 200, deps.youtube.status());
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/login/start',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        const requested = body.locale ? normalizeLocale(body.locale) : null;
        const locale = requested && requested !== 'system'
          ? requested
          : resolveLocale(deps.settingsStore.get().locale, deps.systemLocale);
        try {
          const result = await deps.youtube.startLogin({locale});
          sendJson(res, 201, result);
        } catch (error) {
          throw youtubeError(error);
        }
      }
    },
    {
      method: 'GET',
      path: '/api/youtube/login/status',
      handler: ({res, deps}) => {
        sendJson(res, 200, deps.youtube.status().login);
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/login/logout',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        const result = await deps.youtube.logout();
        sendJson(res, 200, result);
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/video',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        try {
          const video = await deps.youtube.checkVideo(body.url ?? body.videoId ?? body.input, {
            mode: body.mode ?? null
          });
          sendJson(res, 200, {video});
        } catch (error) {
          throw youtubeError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/connect',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        try {
          const result = await deps.youtube.connect(body.url ?? body.videoId ?? body.input, {
            mode: body.mode ?? null
          });
          sendJson(res, 201, {
            session: serializeSessionRow(result.session),
            video: result.video,
            connection: result.connection
          });
        } catch (error) {
          throw youtubeError(error);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/disconnect',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        const result = await deps.youtube.disconnect();
        sendJson(res, 200, {stopped: Boolean(result?.stopped), session: serializeSessionRow(result?.session ?? null)});
      }
    },
    {
      method: 'POST',
      path: '/api/youtube/retention/apply',
      handler: async ({req, res, deps}) => {
        await readOptionalJson(req);
        const result = deps.youtube.applyRetention();
        sendJson(res, 200, result);
      }
    },
    {
      method: 'GET',
      path: '/api/storage/content',
      handler: ({res, url, deps}) => {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        sendJson(res, 200, {stats: contentStats(deps.db, sessionId)});
      }
    }
  ];
}

/** Exposed for tests. */
export const __internal = {SPEEDS, statusPayload, effectiveSettings};
