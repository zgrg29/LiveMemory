import {createReadStream, existsSync, statSync, statfsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {sendJson, sendText, readJsonBody} from './http.mjs';
import {AppError, ERROR_CODES} from '../shared/errors.mjs';
import {normalizeLocale} from '../shared/locale.mjs';
import {resolveLocale} from '../shared/locale.mjs';
import {
  serializeBatch,
  serializeBroadcasterRow,
  serializeEvent,
  serializeJob,
  serializePackage,
  serializeResult,
  serializeSessionRow,
  serializeViewerRow
} from './serializers.mjs';
import {getSession, listSessions} from '../storage/repositories/sessions.mjs';
import {listEvents, contentStats, listViewerSessionMessages} from '../storage/repositories/events.mjs';
import {buildSessionSummary} from '../analytics/sessions/summary.mjs';
import {buildSessionLeaderboard, LEADERBOARD_LIMIT} from '../analytics/sessions/leaderboard.mjs';
import {
  HISTORY_MAX_LIMIT,
  HISTORY_PAGE_SIZE,
  searchHistory
} from '../analytics/sessions/history-search.mjs';
import {archiveSession, deleteSessionRecord, stopSessionRecording} from './session-admin.mjs';
import {buildViewerProfile} from '../analytics/viewers/profile.mjs';
import {groupCurrencyTotals} from '../analytics/payments/totals.mjs';
import {
  getViewer,
  listViewers,
  sessionCurrencyTotals,
  setViewerFocused,
  sessionSupportBySessionIds,
  viewerSessionStats,
  viewerSupportByViewerIds
} from '../storage/repositories/viewers.mjs';
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
import {buildAggregatePackage, createAnalysisJob} from '../ai/export/job.mjs';
import {buildInstructions, instructionVersion} from '../ai/prompts/instructions.mjs';
import {
  getJob,
  getJobBatch,
  listJobBatches,
  listJobs
} from '../storage/repositories/ai-jobs.mjs';
import {getResult, listResults} from '../storage/repositories/ai-results.mjs';
import {
  getMemory,
  getMemoryBatch,
  getMemoryJob,
  listMemoryBatches
} from '../storage/repositories/viewer-memory.mjs';
import {
  buildMemoryJobView,
  buildMemoryOverviewView,
  buildViewerMemoryView,
  listMemoryJobViews,
  listMemorySourceSessions
} from '../memory/view.mjs';
import {mergeSessionIntoMemory} from '../memory/local.mjs';
import {createMemoryUpdateJob} from '../memory/export.mjs';
import {validateMemoryImport} from '../memory/validate.mjs';
import {importMemoryUpdate} from '../memory/importer.mjs';
import {buildMemoryInstructions, memoryInstructionVersion} from '../memory/prompt.mjs';
import {
  deleteViewerMemory,
  memoryRetentionStatus,
  pruneStaleMemories
} from '../memory/maintenance.mjs';
import {reviewMemoryFact, rollbackMemory} from '../memory/store.mjs';
import {
  MAX_MEMORY_IMPORT_BYTES,
  MEMORY_PROTOCOL,
  MEMORY_SCHEMA_VERSION,
  MEMORY_PROMPT_VERSION
} from '../memory/constants.mjs';
import {computeJobStatus, recomputeSessionAiStatus} from '../ai/tasks/status.mjs';
import {validateAnalysisImport} from '../ai/import/validate.mjs';
import {importAnalysisResult} from '../ai/import/importer.mjs';
import {buildSessionAnalysisReport} from '../analytics/ai/report.mjs';
import {
  DEFAULT_BATCH_MESSAGES,
  MAX_IMPORT_BYTES,
  RESULT_SCHEMA_VERSION
} from '../ai/constants.mjs';
import {currentSchemaVersion} from '../storage/database/migrations/index.mjs';
import {databaseSizeBytes} from '../storage/database/connection.mjs';
import {readDataLocation} from '../shared/data-location.mjs';
import {relocateDataDir, validateTarget, __internal as relocationInternal} from './relocation.mjs';
import {openFolder, pickFolder} from './native-dialog.mjs';
import {backupDirectory, clearData, clearPreview, createDatabaseBackup} from './maintenance.mjs';
import {APP_NAME, APP_VERSION, APP_HOMEPAGE} from '../shared/app-info.mjs';
import {toApiError as youtubeError} from '../platforms/youtube/service.mjs';
import {sessionIdRequiredError} from '../shared/recording.mjs';

/**
 * Route table. Every handler is async, returns void and writes the response
 * itself; thrown AppErrors are converted by the HTTP layer.
 */

const SPEEDS = {calm: 1600, normal: 750, busy: 320};

function statusPayload(deps) {
  const {paths, db, settingsStore, sessionManager, startedAt} = deps;
  const monitoringStatus = deps.monitoring ? deps.monitoring.status() : null;
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
    ai: {export: true, import: true, protocol: ANALYSIS_PROTOCOL, schemaVersion: RESULT_SCHEMA_VERSION},
    memory: {
      enabled: true,
      protocol: MEMORY_PROTOCOL,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      promptVersion: MEMORY_PROMPT_VERSION
    },
    bilibili: deps.bilibili ? deps.bilibili.status() : null,
    youtube: deps.youtube ? deps.youtube.status() : null,
    monitoring: monitoringStatus
      ? {
        enabled: true,
        summary: monitoringStatus.summary,
        policy: monitoringStatus.policy
      }
      : null
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
 * Lightweight overview of one active recording. Full timelines and leaderboards
 * stay on their own endpoints so a tab refresh never scans every event row.
 */
function liveRecordingOverview(deps, recording) {
  const row = getSession(deps.db, recording.sessionId);
  return {
    sessionId: recording.sessionId,
    platform: recording.platform,
    platformRoomId: recording.platformRoomId,
    roomTitle: recording.roomTitle,
    broadcasterName: recording.broadcasterName,
    broadcasterId: recording.broadcasterId ?? null,
    broadcasterIdentity: recording.broadcasterIdentity ?? 'unresolved',
    monitorTargetId: recording.monitorTargetId ?? row?.monitor_target_id ?? null,
    simulated: Boolean(recording.simulated),
    startedAt: recording.startedAt,
    platformStartedAt: recording.platformStartedAt ?? null,
    connection: {
      state: recording.connection,
      detail: recording.detail ?? null
    },
    meta: recording.meta ?? null,
    status: row?.status ?? 'live',
    platformStatus: row?.platform_status ?? recording.platformStatus ?? null,
    platformStatusAt: row?.platform_status_at ?? recording.platformStatusAt ?? null,
    lastLiveSeenAt: row?.last_live_seen_at ?? recording.lastLiveSeenAt ?? null,
    platformEndedAt: row?.platform_ended_at ?? recording.platformEndedAt ?? null,
    platformEndQuality: row?.platform_end_quality ?? recording.platformEndQuality ?? null,
    messageCount: Number(row?.message_count ?? 0),
    uniqueViewerCount: Number(row?.unique_viewer_count ?? 0),
    paymentEventCount: Number(row?.payment_event_count ?? 0),
    lastEventAt: row?.last_event_at ?? null,
    support: groupCurrencyTotals(sessionCurrencyTotals(deps.db, recording.sessionId))
  };
}

function readTopLimit(url, fallback = 5) {
  const raw = Number(url.searchParams.get('topLimit'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(raw), 1), LEADERBOARD_LIMIT);
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
                mode: 'web',
                requiresApiKey: false,
                requiresLogin: false,
                requiresCookie: false
              }
            ],
            ai: {export: true, import: true, schemaVersion: RESULT_SCHEMA_VERSION},
            memory: {
              enabled: true,
              protocol: MEMORY_PROTOCOL,
              schemaVersion: MEMORY_SCHEMA_VERSION,
              promptVersion: MEMORY_PROMPT_VERSION
            },
            monitoring: {enabled: Boolean(deps.monitoring), requiresApiKey: false, requiresLogin: false},
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
        const includeArchived = url.searchParams.get('includeArchived') === '1';
        const archivedOnly = url.searchParams.get('archivedOnly') === '1';
        const rows = listSessions(deps.db, {
          limit,
          offset,
          platform,
          broadcasterId,
          unassigned,
          includeArchived,
          archivedOnly
        });
        const support = sessionSupportBySessionIds(deps.db, rows.map((row) => row.id));
        sendJson(res, 200, {
          sessions: rows.map((row) => ({...serializeSessionRow(row), support: support.get(row.id) ?? []}))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/live/recordings',
      handler: ({res, deps}) => {
        const manager = deps.sessionManager.status();
        const recordings = deps.sessionManager.listRecordings()
          .map((recording) => liveRecordingOverview(deps, recording));
        sendJson(res, 200, {
          recordings,
          count: recordings.length,
          connection: manager.connection,
          activeCount: manager.activeCount
        });
      }
    },
    {
      method: 'POST',
      path: '/api/live/recordings/:sessionId/stop',
      handler: async ({res, params, deps}) => {
        // Same service as the history page: one stop implementation, one set of
        // rules. Only the addressed session is stopped.
        const result = await stopSessionRecording({deps, sessionId: params.sessionId});
        sendJson(res, 200, {
          stopped: Boolean(result.stopped),
          session: serializeSessionRow(result.session)
        });
      }
    },
    {
      method: 'GET',
      path: '/api/history/search',
      handler: ({res, url, deps}) => {
        const limit = Number(url.searchParams.get('limit') ?? HISTORY_PAGE_SIZE);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const payload = searchHistory(deps.db, {
          query: url.searchParams.get('q') ?? '',
          scope: url.searchParams.get('scope') ?? 'all',
          platform: url.searchParams.get('platform'),
          status: url.searchParams.get('status'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          includeArchived: url.searchParams.get('includeArchived') === '1',
          archivedOnly: url.searchParams.get('archivedOnly') === '1',
          limit: Math.min(Math.max(limit || HISTORY_PAGE_SIZE, 1), HISTORY_MAX_LIMIT),
          offset
        });
        sendJson(res, 200, payload);
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/current',
      handler: ({res, deps}) => {
        const active = deps.sessionManager.listRecordings().at(-1) ?? null;
        if (!active) {
          sendJson(res, 200, {session: null});
          return;
        }
        sendJson(res, 200, {session: buildSessionSummary(deps.db, active.sessionId, {topLimit: 5})});
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/top-viewers',
      handler: ({res, url, params, deps}) => {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || LEADERBOARD_LIMIT, 1), LEADERBOARD_LIMIT);
        const query = url.searchParams.get('query') ?? '';
        const leaderboard = buildSessionLeaderboard(deps.db, params.id, {limit, query});
        if (!leaderboard) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        sendJson(res, 200, leaderboard);
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/:id',
      handler: ({res, url, params, deps}) => {
        const summary = buildSessionSummary(deps.db, params.id, {topLimit: readTopLimit(url)});
        if (!summary) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        sendJson(res, 200, summary);
      }
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/stop',
      handler: async ({res, params, deps}) => {
        const result = await stopSessionRecording({deps, sessionId: params.id});
        sendJson(res, 200, {stopped: Boolean(result.stopped), session: serializeSessionRow(result.session)});
      }
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/archive',
      handler: async ({req, res, params, deps}) => {
        const body = await readOptionalJson(req);
        const archived = body.archived !== false;
        const session = archiveSession({
          db: deps.db,
          sessionId: params.id,
          archived,
          manager: deps.sessionManager
        });
        deps.logger?.info({event: 'session.archived', sessionId: params.id, archived});
        sendJson(res, 200, {session: serializeSessionRow(session)});
      }
    },
    {
      method: 'DELETE',
      path: '/api/sessions/:id',
      handler: async ({req, res, params, deps}) => {
        const body = await readOptionalJson(req);
        const result = await deleteSessionRecord({
          deps,
          sessionId: params.id,
          confirm: body.confirm === true
        });
        sendJson(res, 200, result);
      }
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/viewers/:viewerId',
      handler: ({res, url, params, deps}) => {
        const session = getSession(deps.db, params.id);
        if (!session) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        const viewer = getViewer(deps.db, params.viewerId);
        if (!viewer) throw notFound(ERROR_CODES.VIEWER_NOT_FOUND, 'errors.viewerNotFound');
        const stats = viewerSessionStats(deps.db, params.id, params.viewerId);
        if (!stats) throw notFound(ERROR_CODES.VIEWER_NOT_FOUND, 'errors.viewerNotInSession');
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
        const messages = listViewerSessionMessages(deps.db, {
          sessionId: params.id,
          viewerId: params.viewerId,
          limit
        });
        sendJson(res, 200, {
          session: serializeSessionRow(session),
          viewer: serializeViewerRow(viewer),
          participation: stats,
          messages: messages.map(serializeEvent)
        });
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
        const result = await deps.sessionManager.stopPlatform('mock', {status: 'ended', reason: 'user'});
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
      handler: async ({res, deps}) => {
        const selected = await pickFolder({
          workDir: deps.paths.cache,
          initialDir: deps.paths.root,
          logger: deps.logger
        });
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
        const jobId = url.searchParams.get('jobId');
        if (jobId) {
          const job = getJob(deps.db, jobId);
          if (!job) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiJobNotFound');
          const summary = buildSessionSummary(deps.db, job.sessionId);
          if (!summary) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
          const session = summary.session;
          const stage = url.searchParams.get('stage');
          const batchIndexRaw = url.searchParams.get('batchIndex');
          const aggregate = stage === 'aggregate' || (job.batchTotal > 1 && (batchIndexRaw === null || batchIndexRaw === '') && stage !== 'batch');
          let batch = null;
          let taskId = job.aggregateTaskId ?? `${job.sessionId}-analysis-final`;
          if (!aggregate) {
            const index = Math.max(1, Number(batchIndexRaw) || 1);
            const row = getJobBatch(deps.db, job.id, index);
            if (!row) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiBatchNotFound');
            batch = {
              index: row.batchIndex,
              total: job.batchTotal,
              batchId: row.batchId,
              fromSeq: row.fromSeq,
              toSeq: row.toSeq,
              messageCount: row.messageCount,
              fromAt: row.fromAt,
              toAt: row.toAt
            };
            taskId = row.taskId;
          }
          const text = buildInstructions(job.locale, {
            session: {
              id: session.id,
              platform: session.platform,
              simulated: session.simulated,
              started_at: session.startedAt,
              ended_at: session.endedAt
            },
            broadcaster: {
              id: session.broadcasterId ?? null,
              name: session.broadcasterName ?? null,
              identity: session.broadcasterIdentity ?? 'unresolved'
            },
            messageCount: batch ? batch.messageCount : job.totalMessages,
            support: summary.support,
            jobId: job.id,
            taskId,
            promptVersion: job.promptVersion,
            batch,
            aggregate: aggregate ? {batchCount: job.batchTotal} : null
          });
          sendJson(res, 200, {
            locale: job.locale,
            text,
            promptVersion: job.promptVersion,
            schemaVersion: RESULT_SCHEMA_VERSION,
            taskId,
            batch: batch ? {index: batch.index, batchId: batch.batchId} : null,
            stage: aggregate ? 'aggregate' : 'batch'
          });
          return;
        }
        const locale = requested && requested !== 'system'
          ? requested
          : resolveLocale(deps.settingsStore.get().locale, deps.systemLocale);
        sendJson(res, 200, {
          locale,
          text: buildInstructions(locale),
          promptVersion: instructionVersion(locale),
          schemaVersion: RESULT_SCHEMA_VERSION
        });
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
      method: 'POST',
      path: '/api/ai/jobs',
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
        let result;
        try {
          result = await createAnalysisJob({
            db: deps.db,
            sessionId,
            locale,
            exportsDir: deps.paths.exports,
            batchSize: body.batchSize ?? DEFAULT_BATCH_MESSAGES,
            now: Date.now()
          });
        } catch (error) {
          if (error?.code === 'ANALYSIS_TOO_LARGE') {
            throw new AppError('AI_ANALYSIS_TOO_LARGE', {
              messageKey: 'errors.aiAnalysisTooLarge',
              details: {totalMessages: error.totalMessages, limit: error.limit},
              httpStatus: 413
            });
          }
          if (error?.code === 'ANALYSIS_SESSION_CHANGED') {
            throw new AppError('AI_SESSION_CHANGED', {
              messageKey: 'errors.aiSessionChanged',
              httpStatus: 409
            });
          }
          throw error;
        }
        if (!result) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        deps.logger?.info({
          event: 'ai.job.created',
          jobId: result.job.id,
          sessionId,
          batches: result.job.batchTotal,
          messages: result.job.totalMessages
        });
        sendJson(res, 201, {
          job: serializeJob(result.job, computeJobStatus(deps.db, getJob(deps.db, result.job.id))),
          packages: result.packages.map((entry) => serializePackage(getPackage(deps.db, entry.id)))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/ai/jobs',
      handler: ({res, url, deps}) => {
        const sessionId = url.searchParams.get('sessionId');
        const rows = listJobs(deps.db, {sessionId, limit: 100});
        sendJson(res, 200, {
          jobs: rows.map((job) => ({
            ...serializeJob(job, computeJobStatus(deps.db, job)),
            packages: listPackages(deps.db, {jobId: job.id}).map(serializePackage)
          }))
        });
      }
    },
    {
      method: 'GET',
      path: '/api/ai/jobs/:id',
      handler: ({res, params, deps}) => {
        const job = getJob(deps.db, params.id);
        if (!job) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiJobNotFound');
        const status = computeJobStatus(deps.db, job);
        const batches = listJobBatches(deps.db, job.id);
        const packages = listPackages(deps.db, {jobId: job.id});
        const packageById = new Map(packages.map((row) => [row.id, row]));
        sendJson(res, 200, {
          job: serializeJob(job, status),
          batches: batches.map((batch) => serializeBatch(batch, packageById.get(batch.packageId) ?? null)),
          packages: packages.map(serializePackage),
          results: listResults(deps.db, job.id).map(serializeResult)
        });
      }
    },
    {
      method: 'POST',
      path: '/api/ai/jobs/:id/aggregate',
      handler: async ({req, res, params, deps}) => {
        await readOptionalJson(req);
        const job = getJob(deps.db, params.id);
        if (!job) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiJobNotFound');
        try {
          const built = await buildAggregatePackage({
            db: deps.db,
            jobId: job.id,
            exportsDir: deps.paths.exports,
            now: Date.now()
          });
          deps.logger?.info({event: 'ai.aggregate.created', jobId: job.id, batches: built.batchCount});
          sendJson(res, 201, {
            package: serializePackage(getPackage(deps.db, built.id)),
            job: serializeJob(getJob(deps.db, job.id), computeJobStatus(deps.db, getJob(deps.db, job.id)))
          });
        } catch (error) {
          if (error?.code === 'AGGREGATE_BATCHES_MISSING') {
            throw new AppError('AI_AGGREGATE_NOT_READY', {
              messageKey: 'errors.aiAggregateNotReady',
              details: {missing: error.missing},
              httpStatus: 409
            });
          }
          if (error?.code === 'AGGREGATE_NOT_REQUIRED') {
            throw new AppError('AI_AGGREGATE_NOT_REQUIRED', {
              messageKey: 'errors.aiAggregateNotRequired',
              httpStatus: 409
            });
          }
          throw error;
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/packages',
      handler: ({res, url, deps}) => {
        const sessionId = url.searchParams.get('sessionId');
        const jobId = url.searchParams.get('jobId');
        const rows = listPackages(deps.db, {sessionId, jobId});
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
      method: 'POST',
      path: '/api/ai/import/preview',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req, {limit: MAX_IMPORT_BYTES + 64 * 1024});
        if (typeof body.json !== 'string') {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.aiImportTextRequired', httpStatus: 400});
        }
        const preview = validateAnalysisImport({
          db: deps.db,
          text: body.json,
          source: body.source === 'file' ? 'file' : 'paste',
          now: Date.now()
        });
        sendJson(res, 200, {
          ok: preview.ok,
          action: preview.action,
          errors: preview.errors,
          warnings: preview.warnings,
          target: preview.target,
          duplicate: preview.target?.duplicate ?? null,
          requiresVersionConfirm: Boolean(preview.target?.requiresVersionConfirm),
          evidence: preview.evidenceRows
            ? {
              total: preview.evidenceRows.length,
              missing: preview.evidenceRows.filter((row) => !row.available).length
            }
            : null,
          viewerProfiles: preview.sanitized?.viewer_profiles?.length ?? 0,
          schemaVersion: RESULT_SCHEMA_VERSION
        });
      }
    },
    {
      method: 'POST',
      path: '/api/ai/import',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req, {limit: MAX_IMPORT_BYTES + 64 * 1024});
        if (typeof body.json !== 'string') {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.aiImportTextRequired', httpStatus: 400});
        }
        const outcome = importAnalysisResult({
          db: deps.db,
          text: body.json,
          source: body.source === 'file' ? 'file' : 'paste',
          createVersion: body.createVersion === true,
          now: Date.now()
        });
        const report = buildSessionAnalysisReport(deps.db, outcome.job.sessionId);
        deps.logger?.info({
          event: 'ai.result.imported',
          jobId: outcome.job.id,
          resultId: outcome.result.id,
          duplicate: outcome.duplicate,
          version: outcome.result.resultVersion
        });
        sendJson(res, outcome.duplicate ? 200 : 201, {
          duplicate: outcome.duplicate,
          result: serializeResult(outcome.result),
          job: serializeJob(outcome.job, outcome.status),
          report
        });
      }
    },
    {
      method: 'GET',
      path: '/api/ai/sessions/:id/report',
      handler: ({res, params, deps}) => {
        const report = buildSessionAnalysisReport(deps.db, params.id);
        if (!report) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        sendJson(res, 200, report);
      }
    },
    {
      method: 'GET',
      path: '/api/ai/results/:id',
      handler: ({res, params, deps}) => {
        const result = getResult(deps.db, params.id, {includeJson: true});
        if (!result) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiResultNotFound');
        sendJson(res, 200, {result: serializeResult(result), raw: result.result});
      }
    },
    {
      method: 'GET',
      path: '/api/ai/results/:id/download',
      handler: ({res, params, deps}) => {
        const result = getResult(deps.db, params.id, {includeJson: true});
        if (!result) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.aiResultNotFound');
        const body = Buffer.from(`${JSON.stringify(result.result, null, 2)}\n`, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Content-Disposition': `attachment; filename="livememory-result-${result.id}.json"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(body);
      }
    },
    /* ------------------------------------------------- long-term memory (M7) */
    {
      method: 'GET',
      path: '/api/memory/overview',
      handler: ({res, url, deps}) => {
        const broadcasterId = url.searchParams.get('broadcasterId') || null;
        sendJson(res, 200, {
          ...buildMemoryOverviewView(deps.db, {broadcasterId}),
          sessions: listMemorySourceSessions(deps.db, {broadcasterId, limit: 30}),
          jobs: listMemoryJobViews(deps.db, {broadcasterId, limit: 10}),
          retention: memoryRetentionStatus(deps.db, {broadcasterId})
        });
      }
    },
    {
      method: 'GET',
      path: '/api/memory/sessions',
      handler: ({res, url, deps}) => {
        const broadcasterId = url.searchParams.get('broadcasterId') || null;
        sendJson(res, 200, {
          sessions: listMemorySourceSessions(deps.db, {broadcasterId, limit: 30})
        });
      }
    },
    {
      method: 'POST',
      path: '/api/memory/merge',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
        if (!sessionId) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const result = mergeSessionIntoMemory({
          db: deps.db,
          sessionId,
          apply: body.apply === true,
          viewerIds: Array.isArray(body.viewerIds) ? body.viewerIds : null,
          limit: body.limit ?? 500,
          now: Date.now()
        });
        if (!result.ok) {
          if (result.reason === 'SESSION_NOT_FOUND') {
            throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
          }
          if (result.reason === 'MEMORY_BROADCASTER_REQUIRED') {
            throw new AppError('MEMORY_BROADCASTER_REQUIRED', {
              messageKey: 'errors.memoryBroadcasterRequired',
              httpStatus: 409
            });
          }
          if (result.reason === 'MEMORY_NO_ANALYSIS') {
            throw new AppError('MEMORY_NO_ANALYSIS', {
              messageKey: 'errors.memoryNoAnalysis',
              httpStatus: 409
            });
          }
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        if (result.apply) {
          deps.logger?.info({
            event: 'memory.session_merged',
            sessionId,
            viewers: result.totals.viewers,
            added: result.totals.added,
            skipped: result.totals.skipped
          });
        }
        sendJson(res, 200, result);
      }
    },
    {
      method: 'POST',
      path: '/api/memory/jobs',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
        if (!sessionId) {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.badRequest', httpStatus: 400});
        }
        const requested = body.locale ? normalizeLocale(body.locale) : null;
        const locale = requested && requested !== 'system'
          ? requested
          : resolveLocale(deps.settingsStore.get().locale, deps.systemLocale);
        let created;
        try {
          created = await createMemoryUpdateJob({
            db: deps.db,
            sessionId,
            locale,
            exportsDir: deps.paths.exports,
            viewerIds: Array.isArray(body.viewerIds) ? body.viewerIds : null,
            viewersPerBatch: body.viewersPerBatch,
            now: Date.now()
          });
        } catch (error) {
          if (error?.code === 'MEMORY_BROADCASTER_REQUIRED') {
            throw new AppError('MEMORY_BROADCASTER_REQUIRED', {
              messageKey: 'errors.memoryBroadcasterRequired',
              httpStatus: 409
            });
          }
          if (error?.code === 'MEMORY_NO_VIEWERS') {
            throw new AppError('MEMORY_NO_VIEWERS', {
              messageKey: 'errors.memoryNoViewers',
              httpStatus: 409
            });
          }
          throw error;
        }
        if (!created) throw notFound(ERROR_CODES.SESSION_NOT_FOUND, 'errors.sessionNotFound');
        deps.logger?.info({
          event: 'memory.job.created',
          jobId: created.job.id,
          sessionId,
          batches: created.job.batchTotal,
          viewers: created.job.viewersTotal
        });
        sendJson(res, 201, buildMemoryJobView(deps.db, {
          ...created.job,
          lastErrorAt: null,
          lastErrorCode: null,
          lastErrorJson: null,
          updatedAt: created.job.createdAt
        }));
      }
    },
    {
      method: 'GET',
      path: '/api/memory/jobs',
      handler: ({res, url, deps}) => {
        sendJson(res, 200, {
          jobs: listMemoryJobViews(deps.db, {
            sessionId: url.searchParams.get('sessionId') || null,
            broadcasterId: url.searchParams.get('broadcasterId') || null,
            limit: 30
          })
        });
      }
    },
    {
      method: 'GET',
      path: '/api/memory/jobs/:id',
      handler: ({res, params, deps}) => {
        const job = getMemoryJob(deps.db, params.id);
        if (!job) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryJobNotFound');
        sendJson(res, 200, buildMemoryJobView(deps.db, job));
      }
    },
    {
      method: 'GET',
      path: '/api/memory/jobs/:id/instructions',
      handler: ({res, url, params, deps}) => {
        const mapped = getMemoryJob(deps.db, params.id);
        if (!mapped) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryJobNotFound');
        const batches = listMemoryBatches(deps.db, mapped.id);
        const requested = Number(url.searchParams.get('batchIndex'));
        const batch = batches.find((row) => row.batchIndex === (Number.isFinite(requested) ? requested : 1))
          ?? batches[0];
        if (!batch) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryJobNotFound');
        const session = getSession(deps.db, mapped.sessionId);
        const text = buildMemoryInstructions(mapped.locale, {
          session: session
            ? {id: session.id, startedAt: session.started_at, endedAt: session.ended_at}
            : null,
          broadcaster: {id: mapped.broadcasterId},
          batch: {
            index: batch.batchIndex,
            total: mapped.batchTotal,
            batchId: batch.batchId,
            taskId: batch.taskId,
            viewerCount: batch.viewerCount
          },
          jobId: mapped.id
        });
        sendJson(res, 200, {
          locale: mapped.locale,
          text,
          promptVersion: mapped.promptVersion,
          protocolVersion: mapped.protocolVersion,
          schemaVersion: mapped.schemaVersion,
          batch: {
            index: batch.batchIndex,
            batchId: batch.batchId,
            taskId: batch.taskId,
            viewerCount: batch.viewerCount,
            messageCount: batch.messageCount
          },
          promptVersionLabel: memoryInstructionVersion(mapped.locale)
        });
      }
    },
    {
      method: 'GET',
      path: '/api/memory/jobs/:id/batches/:index/download',
      handler: ({res, params, deps}) => {
        const batch = getMemoryBatch(deps.db, params.id, Number(params.index));
        if (!batch?.fileName) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryPackageNotFound');
        const absolute = join(deps.paths.exports, batch.fileName);
        if (!existsSync(absolute)) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryPackageNotFound');
        const stat = statSync(absolute);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${batch.fileName.replace(/"/g, '')}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        createReadStream(absolute).pipe(res);
      }
    },
    {
      method: 'GET',
      path: '/api/memory/viewers/:id',
      handler: ({res, url, params, deps}) => {
        const broadcasterId = url.searchParams.get('broadcasterId') || currentBroadcasterId(deps.db) || null;
        const view = buildViewerMemoryView(deps.db, {broadcasterId, viewerId: params.id});
        if (!view) throw notFound(ERROR_CODES.VIEWER_NOT_FOUND, 'errors.viewerNotFound');
        sendJson(res, 200, view);
      }
    },
    {
      method: 'POST',
      path: '/api/memory/viewers/:id/delete',
      handler: async ({req, res, params, deps}) => {
        const body = await readOptionalJson(req);
        const broadcasterId = body.broadcasterId || currentBroadcasterId(deps.db) || null;
        const result = deleteViewerMemory({
          db: deps.db,
          broadcasterId,
          viewerId: params.id,
          confirm: body.confirm === true,
          now: Date.now()
        });
        if (result.deleted) {
          deps.logger?.info({
            event: 'memory.deleted',
            viewerId: params.id,
            broadcasterId,
            facts: result.factsRemoved,
            versions: result.versionsRemoved
          });
        }
        sendJson(res, 200, result);
      }
    },
    {
      method: 'POST',
      path: '/api/memory/viewers/:id/facts/:factId/review',
      handler: async ({req, res, params, deps}) => {
        const body = await readOptionalJson(req);
        const broadcasterId = body.broadcasterId || currentBroadcasterId(deps.db) || null;
        const memory = getMemory(deps.db, {broadcasterId, viewerId: params.id});
        if (!memory) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryNotFound');
        if (memory.status !== 'active') {
          throw new AppError('MEMORY_DELETED', {messageKey: 'errors.memoryDeleted', httpStatus: 409});
        }
        const result = reviewMemoryFact({
          db: deps.db,
          memoryId: memory.id,
          factId: params.factId,
          action: String(body.action ?? ''),
          now: Date.now()
        });
        if (!result.ok) {
          throw new AppError('MEMORY_REVIEW_FAILED', {
            messageKey: 'errors.memoryReviewFailed',
            details: {reason: result.reason},
            httpStatus: 409
          });
        }
        sendJson(res, 200, {
          ...result,
          view: buildViewerMemoryView(deps.db, {broadcasterId, viewerId: params.id})
        });
      }
    },
    {
      method: 'POST',
      path: '/api/memory/viewers/:id/rollback',
      handler: async ({req, res, params, deps}) => {
        const body = await readOptionalJson(req);
        const broadcasterId = body.broadcasterId || currentBroadcasterId(deps.db) || null;
        const memory = getMemory(deps.db, {broadcasterId, viewerId: params.id});
        if (!memory) throw notFound(ERROR_CODES.NOT_FOUND, 'errors.memoryNotFound');
        const result = rollbackMemory({
          db: deps.db,
          memoryId: memory.id,
          version: Number(body.version),
          now: Date.now()
        });
        if (!result.ok) {
          throw new AppError('MEMORY_ROLLBACK_FAILED', {
            messageKey: 'errors.memoryRollbackFailed',
            details: {reason: result.reason},
            httpStatus: 409
          });
        }
        deps.logger?.info({event: 'memory.rolled_back', memoryId: memory.id, version: result.version});
        sendJson(res, 200, {
          ...result,
          view: buildViewerMemoryView(deps.db, {broadcasterId, viewerId: params.id})
        });
      }
    },
    {
      method: 'POST',
      path: '/api/memory/import/preview',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req, {limit: MAX_MEMORY_IMPORT_BYTES + 64 * 1024});
        if (typeof body.json !== 'string') {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.aiImportTextRequired', httpStatus: 400});
        }
        const preview = validateMemoryImport({
          db: deps.db,
          text: body.json,
          source: body.source === 'file' ? 'file' : 'paste',
          now: Date.now()
        });
        sendJson(res, 200, {
          ok: preview.ok,
          action: preview.action,
          errors: preview.errors,
          warnings: preview.warnings,
          target: preview.target,
          totals: preview.totals,
          plan: preview.plan,
          operations: preview.operations,
          checksum: preview.checksum,
          evidence: {total: preview.evidenceTotal, missing: preview.evidenceMissing},
          requiresVersionConfirm: Boolean(preview.target?.requiresVersionConfirm),
          schemaVersion: preview.target?.schemaVersion ?? null
        });
      }
    },
    {
      method: 'POST',
      path: '/api/memory/import',
      handler: async ({req, res, deps}) => {
        const body = await readJsonBody(req, {limit: MAX_MEMORY_IMPORT_BYTES + 64 * 1024});
        if (typeof body.json !== 'string') {
          throw new AppError(ERROR_CODES.BAD_REQUEST, {messageKey: 'errors.aiImportTextRequired', httpStatus: 400});
        }
        const outcome = importMemoryUpdate({
          db: deps.db,
          text: body.json,
          source: body.source === 'file' ? 'file' : 'paste',
          createVersion: body.createVersion === true,
          now: Date.now()
        });
        deps.logger?.info({
          event: 'memory.result_imported',
          jobId: outcome.job?.id ?? null,
          duplicate: outcome.duplicate,
          viewers: outcome.versions?.length ?? 0
        });
        sendJson(res, outcome.duplicate ? 200 : 201, {
          duplicate: outcome.duplicate,
          applied: outcome.applied,
          result: outcome.result,
          versions: outcome.versions ?? [],
          job: outcome.job ? buildMemoryJobView(deps.db, outcome.job) : null,
          totals: outcome.preview?.totals ?? null
        });
      }
    },
    {
      method: 'POST',
      path: '/api/memory/prune',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        const broadcasterId = body.broadcasterId || null;
        const result = pruneStaleMemories({
          db: deps.db,
          broadcasterId,
          olderThanDays: body.olderThanDays,
          dryRun: body.dryRun !== false,
          now: Date.now()
        });
        if (!result.dryRun) {
          deps.logger?.info({event: 'memory.pruned', removed: result.removed, days: result.days});
        }
        sendJson(res, 200, result);
      }
    },
    {
      method: 'GET',
      path: '/api/memory/retention',
      handler: ({res, url, deps}) => {
        sendJson(res, 200, memoryRetentionStatus(deps.db, {
          broadcasterId: url.searchParams.get('broadcasterId') || null
        }));
      }
    },
    {
      method: 'GET',
      path: '/api/monitoring',
      handler: ({res, deps}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        sendJson(res, 200, deps.monitoring.status());
      }
    },
    {
      method: 'POST',
      path: '/api/monitoring',
      handler: async ({req, res, deps}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        const body = await readOptionalJson(req);
        const target = await deps.monitoring.createTarget({
          platform: body.platform,
          input: body.input ?? body.url ?? body.roomId ?? body.channelId ?? body.handle,
          enabled: body.autoMonitor !== false && body.enabled !== false
        });
        sendJson(res, 201, {target});
      }
    },
    {
      method: 'PATCH',
      path: '/api/monitoring/:id',
      handler: async ({req, res, deps, params}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        const body = await readOptionalJson(req);
        const target = await deps.monitoring.updateTarget(params.id, {
          action: body.action ?? null,
          enabled: body.enabled === undefined ? null : body.enabled === true
        });
        sendJson(res, 200, {target});
      }
    },
    {
      method: 'POST',
      path: '/api/monitoring/:id/check',
      handler: async ({req, res, deps, params}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        await readOptionalJson(req);
        const target = await deps.monitoring.checkNow(params.id);
        sendJson(res, 200, {target});
      }
    },
    {
      method: 'DELETE',
      path: '/api/monitoring/:id',
      handler: async ({req, res, deps, params}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        const body = await readOptionalJson(req);
        const result = await deps.monitoring.deleteTarget(params.id, {confirm: body.confirm === true});
        sendJson(res, 200, result);
      }
    },
    {
      method: 'GET',
      path: '/api/monitoring/:id/sessions',
      handler: ({res, url, deps, params}) => {
        if (!deps.monitoring) {
          throw new AppError('MONITORING_DISABLED', {messageKey: 'errors.monitoringDisabled', httpStatus: 503});
        }
        const sessions = deps.monitoring.listSessions(params.id, {
          limit: url.searchParams.get('limit') ?? 20
        });
        sendJson(res, 200, {sessions: sessions.map((row) => serializeSessionRow(row))});
      }
    },
    {
      method: 'GET',
      path: '/api/bilibili/status',
      handler: ({res, deps}) => {
        sendJson(res, 200, deps.bilibili.status());
      }
    },    {
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
        const body = await readOptionalJson(req);
        const result = await deps.bilibili.disconnect({sessionId: body.sessionId ?? null});
        if (result.reason === 'session_id_required') {
          throw sessionIdRequiredError({count: result.count, platform: 'bilibili'});
        }
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
      path: '/api/youtube/video',
      handler: async ({req, res, deps}) => {
        const body = await readOptionalJson(req);
        try {
          const video = await deps.youtube.checkVideo(body.url ?? body.videoId ?? body.input);
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
          const result = await deps.youtube.connect(body.url ?? body.videoId ?? body.input);
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
        const body = await readOptionalJson(req);
        try {
          const result = await deps.youtube.disconnect({sessionId: body.sessionId ?? null});
          sendJson(res, 200, {stopped: Boolean(result?.stopped), session: serializeSessionRow(result?.session ?? null)});
        } catch (error) {
          throw youtubeError(error);
        }
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
