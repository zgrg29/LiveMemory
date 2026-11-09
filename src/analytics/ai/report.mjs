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

  // Prefer a complete job; otherwise the most recent job that has any result.
  let primary = summaries.find((summary) => summary.complete) ?? null;
  if (!primary) {
    for (const summary of summaries) {
      const hasResult = summary.batchesImported > 0 || summary.aggregateImported;
      if (hasResult) {
        primary = summary;
        break;
      }
    }
  }
  if (!primary && summaries.length > 0) primary = summaries[0];
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
      jobs: [],
      primaryJob: null,
      mode: 'none',
      complete: false,
      incompleteReason: 'no_task',
      report: null,
      perBatch: [],
      localStats: null,
      viewerProfiles: null
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
    else if (job.batchTotal > 1) incompleteReason = 'awaiting_aggregate';
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
