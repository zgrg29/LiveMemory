import {getSession} from '../../storage/repositories/sessions.mjs';
import {getEventById} from '../../storage/repositories/events.mjs';
import {getViewer} from '../../storage/repositories/viewers.mjs';
import {listJobs} from '../../storage/repositories/ai-jobs.mjs';
import {
  listEvidence,
  listResults,
  latestResultForScope
} from '../../storage/repositories/ai-results.mjs';
import {computeJobStatus} from '../../ai/tasks/status.mjs';
import {MAX_REPORT_EVIDENCE} from '../../ai/constants.mjs';
import {listFacts} from '../../storage/repositories/viewer-memory.mjs';

/**
 * Read model for the AI analysis report.
 *
 * Everything here is derived from a validated, imported result. The report never
 * invents a summary and never merges batches into one "complete" analysis:
 * - a final aggregate result is shown as the session-wide report;
 * - a single-batch job is complete on its own;
 * - incomplete jobs show each imported batch separately, with an explicit
 *   "incomplete" state, plus which batches are missing.
 *
 * Evidence references are resolved against the real event rows. If the text was
 * purged by retention or the row no longer exists, the report says so instead of
 * fabricating the original message.
 */

function evidenceByItem(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.section}:${row.itemIndex}`;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function resolveEvidence(db, rows, cache, budget) {
  const refs = [];
  for (const row of rows) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    let event = cache.get(row.eventId);
    if (event === undefined) {
      event = row.eventId === null ? null : getEventById(db, row.eventId);
      cache.set(row.eventId, event);
    }
    refs.push({
      seq: row.seq,
      batchIndex: row.batchIndex,
      eventId: row.eventId,
      available: Boolean(event),
      contentAvailable: Boolean(event && event.content !== null && event.content !== undefined),
      purged: Boolean(event?.content_purged_at),
      occurredAt: event?.occurred_at ?? null,
      displayName: event?.display_name ?? null,
      eventType: event?.event_type ?? null,
      content: event?.content ?? null
    });
  }
  return refs;
}

function decorate(db, result, evidenceRows) {
  const byItem = evidenceByItem(evidenceRows);
  const cache = new Map();
  const budget = {remaining: MAX_REPORT_EVIDENCE};
  const topics = result.session_topics ?? {};
  const refsFor = (section, index) => resolveEvidence(db, byItem.get(`${section}:${index}`) ?? [], cache, budget);
  const lowConfidence = (value) => Number(value) < 0.5;

  return {
    summary: topics.summary ?? '',
    topics: (topics.topics ?? []).map((topic, index) => ({
      title: topic.title,
      startedAt: Date.parse(topic.started_at),
      startedAtIso: topic.started_at,
      endedAt: Date.parse(topic.ended_at),
      endedAtIso: topic.ended_at,
      summary: topic.summary ?? '',
      keyPoints: topic.key_points ?? [],
      confidence: Number(topic.confidence),
      lowConfidence: lowConfidence(topic.confidence),
      evidence: topic.evidence,
      refs: refsFor('topics', index)
    })),
    sentiment: (topics.sentiment ?? []).map((entry) => ({
      at: Date.parse(entry.at),
      atIso: entry.at,
      tone: entry.tone,
      note: entry.note ?? '',
      confidence: Number(entry.confidence),
      lowConfidence: lowConfidence(entry.confidence),
      sampleSize: entry.sample_size ?? null,
      evidenceNote: entry.evidence_note ?? null
    })),
    disputes: (topics.disputes ?? []).map((entry, index) => ({
      title: entry.title ?? null,
      summary: entry.summary ?? '',
      startedAt: Date.parse(entry.started_at),
      startedAtIso: entry.started_at,
      endedAt: entry.ended_at ? Date.parse(entry.ended_at) : null,
      endedAtIso: entry.ended_at ?? null,
      note: entry.note ?? '',
      viewpoints: entry.viewpoints ?? [],
      confidence: Number(entry.confidence),
      lowConfidence: lowConfidence(entry.confidence),
      evidence: entry.evidence ?? null,
      refs: refsFor('disputes', index)
    })),
    highlights: (topics.highlights ?? []).map((entry, index) => ({
      title: entry.title ?? null,
      startedAt: Date.parse(entry.started_at),
      startedAtIso: entry.started_at,
      endedAt: Date.parse(entry.ended_at),
      endedAtIso: entry.ended_at,
      reason: entry.reason ?? '',
      clipSuggestion: entry.clip_suggestion ?? '',
      confidence: entry.confidence === undefined ? null : Number(entry.confidence),
      lowConfidence: entry.confidence === undefined ? false : lowConfidence(entry.confidence),
      evidence: entry.evidence ?? null,
      refs: refsFor('highlights', index)
    })),
    evidenceBudgetExceeded: budget.remaining <= 0
  };
}

function resultMeta(result) {
  return {
    id: result.id,
    resultVersion: result.resultVersion,
    taskId: result.taskId,
    taskKind: result.taskKind,
    importedAt: result.importedAt,
    source: result.source,
    locale: result.locale,
    protocolVersion: result.protocolVersion,
    schemaVersion: result.schemaVersion,
    checksum: result.checksum,
    evidenceTotal: result.evidenceTotal,
    evidenceMissing: result.evidenceMissing
  };
}

function summarizeViewerProfiles(result, db, limit = 50) {
  const profiles = result.viewer_profiles ?? [];
  return {
    count: profiles.length,
    lowConfidence: profiles.filter((profile) => Number(profile.confidence) < 0.5).length,
    items: profiles.slice(0, limit).map((profile) => {
      const viewer = getViewer(db, profile.viewer_id);
      return {
        viewerId: profile.viewer_id,
        nickname: viewer?.nickname ?? null,
        summary: profile.summary ?? '',
        confidence: Number(profile.confidence),
        lowConfidence: Number(profile.confidence) < 0.5,
        interests: profile.interests ?? [],
        dislikes: profile.dislikes ?? []
      };
    })
  };
}

/**
 * Long-term memory is a separate task from the session report. The report page
 * must still surface it when it exists, otherwise a user who ran both tasks sees
 * an empty "viewer profiles" card and concludes that memory was never written.
 */
/**
 * Explain long-term coverage without conflating "processed" with "has semantic
 * facts". The old UI showed only `count` (active memory headers) and users
 * reasonably read it as "27 viewers have a full AI profile", even when 9 of
 * them had objective interaction history only and 10 were still pending.
 */
function memoryJobStats(db, session) {
  const jobs = listJobs(db, {sessionId: session.id, limit: 50})
    .filter((job) => Number(job.memoryViewersTotal ?? 0) > 0);
  for (const job of jobs) {
    const status = computeJobStatus(db, job);
    const coverage = status?.memoryCoverage;
    if (!coverage || Number(coverage.total ?? 0) <= 0) continue;
    const failedBatches = Array.isArray(status.failedBatches) ? status.failedBatches : [];
    // `coverage.failed` is the authoritative viewer count. `failedBatches`
    // remains for traceability and for the per-batch technical details.
    const failed = Number(coverage.failed ?? 0);
    return {
      jobId: job.id,
      status: status.status,
      total: Number(coverage.total ?? 0),
      processed: Number(coverage.covered ?? 0),
      semantic: Number(coverage.semantic ?? 0),
      objectiveOnly: Number(coverage.no_semantics ?? 0) + Number(coverage.objective_only ?? 0),
      pending: Number(coverage.pending ?? 0),
      failed,
      failedBatches,
      complete: coverage.complete === true
    };
  }
  return null;
}

function summarizeLongTermProfiles(db, session, {limit = 50} = {}) {
  if (!session?.broadcaster_id) {
    return {count: 0, items: [], reason: 'no_broadcaster', stats: null};
  }
  const rows = db.prepare(`
    SELECT vm.*, v.nickname
      FROM viewer_memories vm
      JOIN viewer_sessions vs ON vs.viewer_id = vm.viewer_id AND vs.session_id = ?
      LEFT JOIN viewers v ON v.id = vm.viewer_id
     WHERE vm.broadcaster_id = ?
       AND vm.status = 'active'
     ORDER BY vm.last_update_at DESC
     LIMIT ?
  `).all(String(session.id), String(session.broadcaster_id), Math.max(1, Number(limit) || 50));
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
      FROM viewer_memories vm
      JOIN viewer_sessions vs ON vs.viewer_id = vm.viewer_id AND vs.session_id = ?
     WHERE vm.broadcaster_id = ? AND vm.status = 'active'
  `).get(String(session.id), String(session.broadcaster_id))?.count ?? 0);
  return {
    count: total,
    reason: total === 0 ? 'none' : null,
    stats: memoryJobStats(db, session),
    items: rows.map((row) => {
      const facts = listFacts(db, row.id, {limit: 8});
      return {
        viewerId: row.viewer_id,
        nickname: row.nickname ?? null,
        version: Number(row.version ?? 0),
        summary: row.summary ?? '',
        lastUpdateAt: Number(row.last_update_at ?? 0),
        facts: facts.map((fact) => ({
          id: fact.id,
          kind: fact.kind,
          topic: fact.topic ?? null,
          statement: fact.statement,
          certainty: fact.certainty,
          status: fact.status,
          confidence: fact.confidence
        }))
      };
    })
  };
}

function jobSummary(db, job, {now = Date.now()} = {}) {
  const status = computeJobStatus(db, job);
  return {
    id: job.id,
    sessionId: job.sessionId,
    locale: job.locale,
    promptVersion: job.promptVersion,
    protocolVersion: job.protocolVersion,
    batchTotal: job.batchTotal,
    totalMessages: job.totalMessages,
    maxMessages: job.maxMessages,
    analysisMode: job.analysisMode ?? 'combined',
    legacy: job.legacy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: status.status,
    complete: status.complete,
    batchesImported: status.batchesImported,
    missingBatches: status.missingBatches,
    aggregateRequired: status.aggregateRequired,
    aggregateImported: status.aggregateImported,
    aggregatePackageReady: status.aggregatePackageReady,
    versions: status.versions,
    latestError: status.latestError,
    agedMs: Math.max(0, now - job.createdAt)
  };
}

/**
 * @returns {object|null} report payload, or null when the session is unknown.
 */
export function buildSessionAnalysisReport(db, sessionId, {now = Date.now()} = {}) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const jobs = listJobs(db, {sessionId, limit: 50});
  const summaries = jobs.map((job) => jobSummary(db, job, {now}));
  const byId = new Map(jobs.map((job, index) => [job.id, summaries[index]]));
  // Memory-only jobs are an independent task. Their result JSON has no session
  // report and must never become the primary report (or be mistaken for one).
  const reportJobs = jobs.filter((job) => (job.analysisMode ?? 'combined') !== 'memory');
  const reportIds = new Set(reportJobs.map((job) => job.id));

  // Prefer a complete report job; otherwise the most recent report job that has
  // any result.
  let primary = summaries.find((summary) => reportIds.has(summary.id) && summary.complete) ?? null;
  if (!primary) {
    for (const summary of summaries) {
      if (!reportIds.has(summary.id)) continue;
      const hasResult = summary.batchesImported > 0 || summary.aggregateImported;
      if (hasResult) {
        primary = summary;
        break;
      }
    }
  }
  if (!primary && reportJobs.length > 0) primary = summaries.find((summary) => summary.id === reportJobs[0].id) ?? null;
  if (!primary) {
    return {
      session: {
        id: session.id,
        platform: session.platform,
        roomTitle: session.room_title,
        broadcasterName: session.broadcaster_name,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        archived: session.archived_at !== null && session.archived_at !== undefined,
        simulated: session.simulated === 1,
        broadcasterIdentity: session.broadcaster_identity ?? 'unresolved'
      },
      jobs: summaries,
      primaryJob: null,
      mode: 'none',
      complete: false,
      incompleteReason: summaries.length > 0 ? 'memory_only' : 'no_task',
      report: null,
      perBatch: [],
      localStats: null,
      viewerProfiles: null,
      longTermProfiles: summarizeLongTermProfiles(db, session)
    };
  }

  const job = jobs.find((row) => row.id === primary.id);
  const finalResult = latestResultForScope(db, job.id, 'final', {includeJson: true});
  const batchResults = listResults(db, job.id, {includeJson: true}).filter((row) => row.batchIndex !== null);
  const latestByBatch = new Map();
  for (const row of batchResults) latestByBatch.set(row.batchIndex, row);

  let mode = 'exported';
  let report = null;
  const perBatch = [];
  if (finalResult) {
    mode = 'final';
    report = decorate(db, finalResult.result, listEvidence(db, finalResult.id));
  } else if (job.batchTotal === 1 && latestByBatch.has(1)) {
    mode = 'single';
    const result = latestByBatch.get(1);
    report = decorate(db, result.result, listEvidence(db, result.id));
  } else if (latestByBatch.size > 0) {
    mode = 'partial';
    for (const [batchIndex, result] of [...latestByBatch.entries()].sort((a, b) => a[0] - b[0])) {
      perBatch.push({
        batchIndex,
        result: resultMeta(result),
        report: decorate(db, result.result, listEvidence(db, result.id))
      });
    }
  }

  const displayed = finalResult ?? (mode === 'single' ? latestByBatch.get(1) : null);
  let incompleteReason = null;
  if (mode === 'exported' || mode === 'partial') {
    if (primary.missingBatches.length > 0) incompleteReason = 'missing_batches';
    else if ((primary.analysisMode ?? 'combined') !== 'memory' && job.batchTotal > 1) incompleteReason = 'awaiting_aggregate';
    else incompleteReason = 'no_results';
  }

  return {
    session: {
      id: session.id,
      platform: session.platform,
      roomTitle: session.room_title,
      broadcasterName: session.broadcaster_name,
      broadcasterId: session.broadcaster_id ?? null,
      broadcasterIdentity: session.broadcaster_identity ?? 'unresolved',
      startedAt: session.started_at,
      endedAt: session.ended_at,
      archived: session.archived_at !== null && session.archived_at !== undefined,
      simulated: session.simulated === 1
    },
    jobs: summaries,
    primaryJob: byId.get(primary.id) ?? primary,
    mode,
    complete: primary.complete,
    incompleteReason,
    report,
    perBatch,
    result: displayed ? resultMeta(displayed) : null,
    viewerProfiles: displayed ? summarizeViewerProfiles(displayed.result, db) : null,
    longTermProfiles: summarizeLongTermProfiles(db, session),
    evidence: displayed
      ? {
        total: displayed.evidenceTotal,
        missing: displayed.evidenceMissing,
        budget: MAX_REPORT_EVIDENCE
      }
      : null
  };
}

export const __internal = {decorate, resolveEvidence, evidenceByItem};
