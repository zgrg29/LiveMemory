import {
  getMemory,
  getMemoryJob,
  latestMemoryResultForBatch,
  listFacts,
  listMemories,
  listMemoryBatches,
  listMemoryJobs,
  listMemoryResults,
  listVersions,
  memoryOverview
} from '../storage/repositories/viewer-memory.mjs';
import {getSession, listSessions} from '../storage/repositories/sessions.mjs';
import {getViewer} from '../storage/repositories/viewers.mjs';
import {getBroadcaster} from '../storage/repositories/broadcasters.mjs';
import {loadMemoryFacts} from './model.mjs';
import {selectAnalysisSource} from './local.mjs';
import {objectiveHistory} from './objective.mjs';
import {MEMORY_VERSIONS_KEPT} from './constants.mjs';

/**
 * Read models for the memory UI.
 *
 * Everything the viewer profile shows is derived from the database on demand;
 * the browser never stores a memory version. Evidence is resolved against the
 * real event table so "the original message is gone" is a fact the UI can show,
 * not a guess.
 */

/** Status of one memory update job, computed from real rows. */
export function memoryJobStatus(db, job) {
  if (!job) return null;
  const batches = listMemoryBatches(db, job.id);
  const results = listMemoryResults(db, job.id);
  const appliedByBatch = new Map();
  for (const result of results) {
    if (!appliedByBatch.has(result.batchIndex)) appliedByBatch.set(result.batchIndex, result);
  }
  const missingBatches = batches
    .filter((batch) => !appliedByBatch.has(batch.batchIndex))
    .map((batch) => batch.batchIndex);
  let status;
  if (appliedByBatch.size === 0) status = job.lastErrorAt ? 'invalid' : 'awaiting_import';
  else if (missingBatches.length > 0) status = 'partial';
  else status = 'complete';
  let latestError = null;
  if (job.lastErrorJson) {
    try {
      latestError = JSON.parse(job.lastErrorJson);
    } catch {
      latestError = null;
    }
  }
  return {
    status,
    labelKey: `memory.job.status.${status}`,
    complete: status === 'complete',
    batchTotal: job.batchTotal,
    batchesApplied: appliedByBatch.size,
    missingBatches,
    viewersTotal: job.viewersTotal,
    messagesTotal: job.messagesTotal,
    latestError
  };
}

export function buildMemoryJobView(db, job) {
  if (!job) return null;
  const status = memoryJobStatus(db, job);
  const batches = listMemoryBatches(db, job.id);
  const results = listMemoryResults(db, job.id);
  const resultByBatch = new Map();
  for (const result of results) {
    if (!resultByBatch.has(result.batchIndex)) resultByBatch.set(result.batchIndex, result);
  }
  const session = getSession(db, job.sessionId);
  return {
    job: {
      id: job.id,
      sessionId: job.sessionId,
      broadcasterId: job.broadcasterId,
      locale: job.locale,
      promptVersion: job.promptVersion,
      protocolVersion: job.protocolVersion,
      schemaVersion: job.schemaVersion,
      scope: job.scope,
      batchTotal: job.batchTotal,
      viewersTotal: job.viewersTotal,
      messagesTotal: job.messagesTotal,
      createdAt: job.createdAt
    },
    session: session
      ? {
        id: session.id,
        platform: session.platform,
        roomTitle: session.room_title,
        broadcasterName: session.broadcaster_name,
        startedAt: session.started_at,
        endedAt: session.ended_at
      }
      : null,
    status,
    batches: batches.map((batch) => {
      const applied = resultByBatch.get(batch.batchIndex) ?? null;
      const latest = latestMemoryResultForBatch(db, job.id, batch.batchIndex);
      return {
        ...batch,
        applied: Boolean(applied),
        resultId: applied?.id ?? null,
        appliedAt: applied?.appliedAt ?? null,
        latestResultId: latest?.id ?? null,
        latestAppliedAt: latest?.appliedAt ?? null
      };
    }),
    results: results.map((result) => ({
      id: result.id,
      batchIndex: result.batchIndex,
      batchId: result.batchId,
      viewerTotal: result.viewerTotal,
      opTotal: result.opTotal,
      evidenceTotal: result.evidenceTotal,
      evidenceMissing: result.evidenceMissing,
      source: result.source,
      appliedAt: result.appliedAt,
      schemaVersion: result.schemaVersion,
      locale: result.locale
    }))
  };
}

export function listMemoryJobViews(db, {sessionId = null, broadcasterId = null, limit = 20} = {}) {
  return listMemoryJobs(db, {sessionId, broadcasterId, limit})
    .map((job) => buildMemoryJobView(db, job));
}

/**
 * Sessions the user can merge into memory, with whether they already have an
 * imported M6 analysis (the deterministic merge needs one).
 */
export function listMemorySourceSessions(db, {broadcasterId = null, limit = 30} = {}) {
  const rows = listSessions(db, {
    broadcasterId,
    limit: Math.min(Math.max(Number(limit) || 30, 1), 100),
    includeArchived: true
  });
  return rows
    .filter((row) => row.status !== 'live')
    .map((row) => {
      const analysis = selectAnalysisSource(db, row.id);
      return {
        sessionId: row.id,
        platform: row.platform,
        roomTitle: row.room_title,
        broadcasterName: row.broadcaster_name,
        broadcasterId: row.broadcaster_id ?? null,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        status: row.status,
        archived: row.archived_at !== null && row.archived_at !== undefined,
        messageCount: Number(row.message_count ?? 0),
        viewerCount: Number(row.unique_viewer_count ?? 0),
        analysis: analysis
          ? {
            jobId: analysis.job.id,
            complete: analysis.complete,
            resultCount: analysis.results.length,
            viewerProfiles: analysis.results.reduce((sum, result) => (
              sum + Number(result.result?.viewer_profiles?.length ?? 0)
            ), 0),
            importedAt: analysis.importedAt
          }
          : null
      };
    });
}

const SNIPPET_LENGTH = 200;

function loadEvidenceDetails(db, eventIds) {
  const ids = [...new Set((eventIds ?? []).filter((id) => Number.isFinite(Number(id))).map(Number))];
  if (ids.length === 0) return new Map();
  const map = new Map();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, session_id, occurred_at, display_name, event_type, content, content_purged_at
        FROM events WHERE id IN (${placeholders})
    `).all(...chunk);
    for (const row of rows) {
      const text = row.content === null || row.content === undefined
        ? null
        : String(row.content).slice(0, SNIPPET_LENGTH);
      map.set(Number(row.id), {
        eventId: Number(row.id),
        sessionId: row.session_id,
        occurredAt: row.occurred_at,
        nickname: row.display_name ?? null,
        eventType: row.event_type,
        snippet: text,
        contentAvailable: row.content_purged_at === null || row.content_purged_at === undefined,
        purgedAt: row.content_purged_at ?? null
      });
    }
  }
  return map;
}

function loadSessionTitles(db, sessionIds) {
  const ids = [...new Set((sessionIds ?? []).filter(Boolean).map(String))];
  const map = new Map();
  for (const id of ids) {
    const row = getSession(db, id);
    if (row) {
      map.set(id, {
        id: row.id,
        roomTitle: row.room_title,
        broadcasterName: row.broadcaster_name,
        startedAt: row.started_at,
        platform: row.platform
      });
    }
  }
  return map;
}

function publicFact(fact, {evidenceByEventId}) {
  return {
    id: fact.id,
    kind: fact.kind,
    topic: fact.topic,
    statement: fact.statement,
    certainty: fact.certainty,
    status: fact.status,
    statusReason: fact.statusReason,
    confidence: fact.confidence,
    userVerified: Boolean(fact.userVerified),
    sourceKind: fact.sourceKind,
    sourceLabel: fact.sourceLabel,
    sourceSessionId: fact.sourceSessionId,
    sourceJobId: fact.sourceJobId,
    sourceResultId: fact.sourceResultId,
    firstSeenAt: fact.firstSeenAt,
    lastConfirmedAt: fact.lastConfirmedAt,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    supersededBy: fact.supersededBy,
    conflictsWith: fact.conflictsWith,
    evidenceStatus: fact.evidenceStatus,
    evidenceCount: fact.evidenceCount,
    evidenceAvailable: fact.evidenceAvailable,
    evidence: (fact.evidence ?? []).map((entry) => {
      const detail = entry.eventId ? evidenceByEventId.get(Number(entry.eventId)) : null;
      return {
        sourceKey: entry.sourceKey,
        sessionId: entry.sessionId,
        batchIndex: entry.batchIndex,
        seq: entry.seq,
        eventId: entry.eventId,
        observedAt: entry.observedAt,
        available: entry.available !== false,
        verified: Boolean(detail && detail.contentAvailable),
        snippet: detail?.snippet ?? null,
        nickname: detail?.nickname ?? null,
        messageAt: detail?.occurredAt ?? entry.observedAt ?? null,
        purged: Boolean(detail && !detail.contentAvailable)
      };
    })
  };
}

function evidenceSummary(facts) {
  const summary = {available: 0, partial: 0, purged: 0, unavailable: 0, none: 0};
  for (const fact of facts) {
    const key = fact.evidenceStatus ?? 'none';
    if (key in summary) summary[key] += 1;
    else summary.none += 1;
  }
  return summary;
}

/**
 * Everything the viewer profile's memory tab needs.
 *
 * @returns {object|null} null when the viewer itself does not exist
 */
export function buildViewerMemoryView(db, {broadcasterId, viewerId, now = Date.now()}) {
  const viewer = getViewer(db, viewerId);
  if (!viewer) return null;
  const broadcaster = broadcasterId ? getBroadcaster(db, broadcasterId) : null;
  const memory = broadcasterId ? getMemory(db, {broadcasterId, viewerId}) : null;
  const facts = memory && memory.status === 'active' ? loadMemoryFacts(db, memory.id) : [];
  const evidence = facts.flatMap((fact) => fact.evidence ?? []);
  const evidenceDetails = loadEvidenceDetails(db, evidence.map((entry) => entry.eventId));
  const sessionTitles = loadSessionTitles(db, [
    ...facts.map((fact) => fact.sourceSessionId),
    ...evidence.map((entry) => entry.sessionId)
  ]);
  const publicFacts = facts.map((fact) => publicFact(fact, {evidenceByEventId: evidenceDetails}));
  const versions = memory ? listVersions(db, memory.id, {limit: MEMORY_VERSIONS_KEPT}) : [];
  const latestVersion = versions[0] ?? null;
  return {
    scope: {
      broadcasterId: broadcasterId ?? null,
      broadcaster: broadcaster
        ? {
          id: broadcaster.id,
          platform: broadcaster.platform,
          platformUid: broadcaster.platform_uid,
          displayName: broadcaster.display_name,
          identity: broadcaster.identity_quality
        }
        : null,
      viewerId
    },
    viewer: {
      id: viewer.id,
      platform: viewer.platform,
      platformUid: viewer.platform_uid,
      nickname: viewer.nickname,
      firstSeenAt: viewer.first_seen_at,
      lastSeenAt: viewer.last_seen_at,
      sessionCount: Number(viewer.session_count ?? 0),
      focused: viewer.focused === 1
    },
    memory: memory
      ? {
        id: memory.id,
        status: memory.status,
        version: memory.version,
        summary: memory.summary,
        summaryCertainty: memory.summaryCertainty,
        firstMemoryAt: memory.firstMemoryAt,
        lastUpdateAt: memory.lastUpdateAt,
        lastSessionId: memory.lastSessionId,
        lastJobId: memory.lastJobId,
        deletedAt: memory.deletedAt,
        deleteReason: memory.deleteReason
      }
      : null,
    facts: publicFacts,
    groups: groupForView(publicFacts),
    evidence: evidenceSummary(publicFacts),
    objective: objectiveHistory(db, {broadcasterId, viewerId, limit: 10}),
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      sourceKind: version.sourceKind,
      sourceSessionId: version.sourceSessionId,
      sourceJobId: version.sourceJobId,
      sourceResultId: version.sourceResultId,
      counts: version.counts,
      diff: version.diff,
      appliedAt: version.appliedAt,
      session: version.sourceSessionId ? sessionTitles.get(version.sourceSessionId) ?? null : null
    })),
    latestVersion,
    sessions: sessionTitles.size,
    now
  };
}

function groupForView(facts) {
  const groups = {
    attention: [],
    confirmed: [],
    inferred: [],
    outdated: [],
    conflicts: [],
    history: []
  };
  for (const fact of facts) {
    if (fact.status === 'conflicted') groups.conflicts.push(fact.id);
    else if (fact.status === 'needs_confirmation') groups.attention.push(fact.id);
    else if (fact.status === 'superseded') groups.history.push(fact.id);
    else if (fact.status === 'outdated') groups.outdated.push(fact.id);
    else if (fact.certainty === 'stated' || fact.userVerified) groups.confirmed.push(fact.id);
    else groups.inferred.push(fact.id);
  }
  return groups;
}

/** Overview used by the memory page and the viewer list badges. */
export function buildMemoryOverviewView(db, {broadcasterId = null, now = Date.now()} = {}) {
  const overview = memoryOverview(db, {broadcasterId});
  const memories = listMemories(db, {broadcasterId, status: 'active', limit: 12});
  return {
    scope: {
      broadcasterId: broadcasterId ?? null,
      broadcaster: broadcasterId ? (() => {
        const broadcaster = getBroadcaster(db, broadcasterId);
        return broadcaster
          ? {
            id: broadcaster.id,
            platform: broadcaster.platform,
            platformUid: broadcaster.platform_uid,
            displayName: broadcaster.display_name,
            identity: broadcaster.identity_quality
          }
          : null;
      })() : null
    },
    overview,
    recent: memories.map((memory) => ({
      memoryId: memory.id,
      viewerId: memory.viewerId,
      nickname: memory.nickname,
      platform: memory.platform,
      platformUid: memory.platformUid,
      focused: memory.focused,
      version: memory.version,
      summary: memory.summary,
      factCount: memory.factCount,
      activeCount: memory.activeCount,
      attentionCount: memory.attentionCount,
      lastUpdateAt: memory.lastUpdateAt
    })),
    versionsKept: MEMORY_VERSIONS_KEPT,
    now
  };
}

export const __internal = {loadEvidenceDetails, loadSessionTitles, publicFact, evidenceSummary, SNIPPET_LENGTH};
