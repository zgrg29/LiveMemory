import {createHash} from 'node:crypto';
import {withTransaction} from '../storage/database/connection.mjs';
import {getSession} from '../storage/repositories/sessions.mjs';
import {listSessionViewers} from '../storage/repositories/viewers.mjs';
import {listJobs} from '../storage/repositories/ai-jobs.mjs';
import {listResults} from '../storage/repositories/ai-results.mjs';
import {getMemory, listFacts} from '../storage/repositories/viewer-memory.mjs';
import {dedupeKeyFor, diffFacts, loadMemoryFacts, normalizeText} from './model.mjs';
import {applyMemoryOperations, previewMemoryOperations} from './store.mjs';
import {
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_LENGTH,
  MEMORY_CERTAINTY,
  MEMORY_KIND,
  MEMORY_OPERATION,
  MEMORY_SOURCE_KIND
} from './constants.mjs';

/**
 * Deterministic, no-AI incremental merge.
 *
 * The user already paid for one AI round trip per session (M6). Those imported
 * results contain per-viewer interests and a short summary. This module turns
 * them into memory operations and merges them into each viewer's existing
 * memory — no second AI call, no context limit and nothing to copy by hand.
 *
 * Everything produced here is labelled `certainty: inferred`, because a session
 * analysis is still an AI interpretation even when the M6 schema calls a
 * statement "observed". Only a memory update package (where the AI must quote
 * the chat) can create `stated` facts.
 */

function latestResultsByScope(db, jobId) {
  const rows = listResults(db, jobId, {includeJson: true});
  const best = new Map();
  for (const row of rows) {
    const current = best.get(row.scopeKey);
    if (!current || Number(row.resultVersion) > Number(current.resultVersion)) best.set(row.scopeKey, row);
  }
  return best;
}

/**
 * Pick the most recent M6 analysis that actually produced results for a session.
 * Using only one job keeps re-analysis from being merged twice.
 */
export function selectAnalysisSource(db, sessionId) {
  const jobs = listJobs(db, {sessionId, limit: 50});
  for (const job of jobs) {
    const best = latestResultsByScope(db, job.id);
    if (best.size === 0) continue;
    const final = best.get('final') ?? null;
    const results = final
      ? [final]
      : [...best.values()].filter((row) => row.scopeKey !== 'final');
    if (results.length === 0) continue;
    return {
      job,
      results,
      // A single-batch job's batch result already covers the whole session, so
      // it counts as complete; only a multi-batch job needs the final aggregate.
      complete: Boolean(final) || Number(job.batchTotal ?? 1) === 1,
      batchResults: [...best.values()].filter((row) => row.scopeKey !== 'final').length,
      importedAt: Math.max(...results.map((row) => Number(row.importedAt ?? 0)))
    };
  }
  return null;
}

/** Collect every viewer profile an imported session analysis produced. */
export function collectSessionMemoryInputs(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) return {ok: false, reason: 'SESSION_NOT_FOUND'};
  if (!session.broadcaster_id) {
    return {ok: false, reason: 'MEMORY_BROADCASTER_REQUIRED', session};
  }
  const source = selectAnalysisSource(db, sessionId);
  if (!source) {
    return {ok: false, reason: 'MEMORY_NO_ANALYSIS', session, broadcasterId: session.broadcaster_id};
  }
  const profiles = new Map();
  for (const result of source.results) {
    const entries = result.result?.viewer_profiles ?? [];
    for (const profile of entries) {
      if (!profile?.viewer_id) continue;
      const list = profiles.get(profile.viewer_id) ?? [];
      list.push({profile, result});
      profiles.set(profile.viewer_id, list);
    }
  }
  const inputs = [];
  for (const [viewerId, entries] of profiles) {
    const built = buildViewerInput(viewerId, entries);
    if (built.operations.length > 0 || built.summary) inputs.push(built);
  }
  return {
    ok: true,
    session,
    broadcasterId: session.broadcaster_id,
    job: source.job,
    complete: source.complete,
    results: source.results.map((row) => ({
      id: row.id,
      batchIndex: row.batchIndex,
      scopeKey: row.scopeKey,
      resultVersion: row.resultVersion,
      importedAt: row.importedAt
    })),
    inputs,
    viewerCount: inputs.length,
    analyzedViewers: profiles.size
  };
}

function buildViewerInput(viewerId, entries) {
  const byKey = new Map();
  const summaries = [];
  let confidence = null;
  let resultId = null;
  let importedAt = 0;
  let batchIndex = null;
  for (const {profile, result} of entries) {
    if (Number(profile.confidence) > (confidence ?? -1)) confidence = Number(profile.confidence);
    if (profile.summary) summaries.push(normalizeText(profile.summary, MAX_SUMMARY_LENGTH));
    resultId = result.id;
    importedAt = Math.max(importedAt, Number(result.importedAt ?? 0));
    batchIndex = result.batchIndex ?? null;
    const groups = [
      [MEMORY_KIND.INTEREST, profile.interests ?? []],
      [MEMORY_KIND.DISLIKE, profile.dislikes ?? []]
    ];
    for (const [kind, list] of groups) {
      for (const entry of list) {
        const topic = normalizeText(entry?.topic, 80);
        if (!topic) continue;
        const statement = normalizeText(entry?.note || entry?.topic || '', MAX_STATEMENT_LENGTH) || topic;
        const key = dedupeKeyFor({kind, topic, statement});
        const existing = byKey.get(key);
        if (existing) {
          // Same topic from two batches: keep the stronger note, never duplicate.
          if (statement.length > existing.statement.length) existing.statement = statement;
          continue;
        }
        byKey.set(key, {
          op: MEMORY_OPERATION.ADD,
          kind,
          topic,
          statement,
          certainty: MEMORY_CERTAINTY.INFERRED,
          confidence: Number.isFinite(Number(profile.confidence)) ? Number(profile.confidence) : null,
          evidence: [{
            resultId: result.id,
            sessionId: result.sessionId,
            batchIndex: result.batchIndex ?? null,
            observedAt: Number(result.importedAt ?? 0)
          }]
        });
      }
    }
  }
  const summary = summaries.length > 0
    ? normalizeText([...new Set(summaries)].join(' / '), MAX_SUMMARY_LENGTH)
    : null;
  return {
    viewerId,
    operations: [...byKey.values()],
    summary,
    summaryCertainty: MEMORY_CERTAINTY.INFERRED,
    confidence,
    provenance: {resultId, batchIndex, importedAt}
  };
}

export function sessionMergeSourceKey(sessionId, input) {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      sessionId,
      summary: input.summary ?? null,
      operations: input.operations.map((op) => [op.kind, op.topic, op.statement, op.confidence])
    }))
    .digest('hex')
    .slice(0, 24);
  return `session:${sessionId}:${hash}`;
}

/**
 * Preview or apply the deterministic merge for one session.
 *
 * @param {object} options
 * @param {boolean} [options.apply] false = preview only (no writes at all)
 * @param {Array<string>|null} [options.viewerIds] restrict to selected viewers
 * @param {number} [options.limit] cap the number of viewers processed
 */
export function mergeSessionIntoMemory({
  db,
  sessionId,
  apply = false,
  viewerIds = null,
  limit = 500,
  now = Date.now()
} = {}) {
  const collected = collectSessionMemoryInputs(db, sessionId);
  if (!collected.ok) return collected;
  const wanted = viewerIds && viewerIds.length > 0 ? new Set(viewerIds.map(String)) : null;
  const nicknameById = new Map(
    listSessionViewers(db, sessionId, {limit: 20000}).map((row) => [row.viewer_id, row.nickname])
  );
  const selected = (wanted
    ? collected.inputs.filter((input) => wanted.has(input.viewerId))
    : collected.inputs).slice(0, Math.min(Math.max(Number(limit) || 500, 1), 2000));

  const viewers = [];
  const process = () => {
    for (const input of selected) {
      const existing = getMemory(db, {broadcasterId: collected.broadcasterId, viewerId: input.viewerId});
      // A deleted memory is a privacy decision: the no-AI merge must never
      // resurrect it. Only a new, explicit AI package (created after the
      // deletion) may start the memory again.
      if (existing && existing.status === 'deleted') {
        viewers.push({
          viewerId: input.viewerId,
          nickname: nicknameById.get(input.viewerId) ?? null,
          opCount: input.operations.length,
          duplicate: false,
          deleted: true,
          version: 0,
          counts: null,
          diff: null
        });
        continue;
      }
      const sourceKey = sessionMergeSourceKey(sessionId, input);
      if (apply) {
        const outcome = applyMemoryOperations({
          db,
          broadcasterId: collected.broadcasterId,
          viewerId: input.viewerId,
          operations: input.operations,
          source: {
            kind: MEMORY_SOURCE_KIND.SESSION_RESULT,
            sessionId,
            jobId: collected.job?.id ?? null,
            resultId: input.provenance.resultId ?? null,
            label: 'session_analysis'
          },
          sourceKey,
          summary: input.summary,
          summaryCertainty: input.summaryCertainty,
          now,
          // The whole session merge is one transaction, owned by the caller.
          transaction: false
        });
        viewers.push({
          viewerId: input.viewerId,
          nickname: nicknameById.get(input.viewerId) ?? null,
          opCount: input.operations.length,
          duplicate: Boolean(outcome.duplicate),
          version: outcome.version,
          counts: outcome.duplicate ? null : outcome.counts,
          diff: outcome.duplicate ? null : outcome.diff
        });
      } else {
        const preview = previewMemoryOperations({
          db,
          broadcasterId: collected.broadcasterId,
          viewerId: input.viewerId,
          operations: input.operations,
          source: {
            kind: MEMORY_SOURCE_KIND.SESSION_RESULT,
            sessionId,
            jobId: collected.job?.id ?? null,
            resultId: input.provenance.resultId ?? null
          },
          now
        });
        const memory = getMemory(db, {broadcasterId: collected.broadcasterId, viewerId: input.viewerId});
        const already = memory
          ? Boolean(db.prepare('SELECT 1 FROM memory_versions WHERE memory_id = ? AND source_key = ?')
            .get(memory.id, sourceKey))
          : false;
        viewers.push({
          viewerId: input.viewerId,
          nickname: nicknameById.get(input.viewerId) ?? null,
          opCount: input.operations.length,
          duplicate: already,
          baseVersion: preview.baseVersion,
          version: preview.version,
          counts: preview.diff.counts,
          diff: preview.diff,
          warnings: preview.warnings
        });
      }
    }
  };
  if (apply) withTransaction(db, process);
  else process();

  const totals = viewers.reduce((acc, entry) => {
    acc.viewers += 1;
    acc.operations += entry.opCount;
    if (entry.duplicate) acc.skipped += 1;
    if (entry.deleted) acc.deleted += 1;
    for (const key of ['added', 'changed', 'removed', 'confirmed']) {
      acc[key] += Number(entry.counts?.[key] ?? 0);
    }
    return acc;
  }, {viewers: 0, operations: 0, skipped: 0, deleted: 0, added: 0, changed: 0, removed: 0, confirmed: 0});

  return {
    ok: true,
    apply,
    sessionId,
    broadcasterId: collected.broadcasterId,
    analysisJobId: collected.job?.id ?? null,
    analysisComplete: collected.complete,
    analysisResults: collected.results,
    analyzedViewers: collected.analyzedViewers,
    truncated: collected.inputs.length > selected.length,
    totals,
    viewers
  };
}

/** Facts of one memory in a shape safe to render (no raw event text). */
export function memoryFactsForViewer(db, {broadcasterId, viewerId}) {
  const memory = getMemory(db, {broadcasterId, viewerId});
  if (!memory || memory.status !== 'active') return {memory, facts: []};
  return {memory, facts: loadMemoryFacts(db, memory.id)};
}

export function factCount(db, memoryId) {
  return listFacts(db, memoryId, {limit: 2000}).length;
}

export const __internal = {buildViewerInput, latestResultsByScope, diffFacts};
