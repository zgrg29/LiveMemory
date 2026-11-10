import {createId} from '../shared/ids.mjs';
import {withTransaction} from '../storage/database/connection.mjs';
import {
  ensureMemory,
  getMemory,
  getMemoryById,
  insertVersion,
  latestVersion,
  listFacts,
  pruneVersions,
  refreshMemoryEvidence,
  replaceFacts,
  touchMemory,
  versionForSource
} from '../storage/repositories/viewer-memory.mjs';
import {applyOperations, reviewFact} from './engine.mjs';
import {diffFacts, factSetChecksum, loadMemoryFacts} from './model.mjs';
import {MEMORY_SOURCE_KIND, MEMORY_VERSIONS_KEPT} from './constants.mjs';

/**
 * Persistence layer for memory versions.
 *
 * Every applied change creates exactly one version row (full snapshot + diff)
 * and rewrites the live fact set in the same transaction. Versions are
 * append-only, so an earlier state can always be restored and a bad AI import
 * can never destroy accumulated knowledge.
 */

const DIFF_PREVIEW_FACTS = 40;

function emptyDiff() {
  return {
    added: [],
    changed: [],
    removed: [],
    confirmed: [],
    unchanged: 0,
    counts: {added: 0, changed: 0, removed: 0, confirmed: 0, unchanged: 0, total: 0}
  };
}

function snapshotOf(facts) {
  return facts.map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    topic: fact.topic,
    statement: fact.statement,
    certainty: fact.certainty,
    status: fact.status,
    statusReason: fact.statusReason ?? null,
    confidence: fact.confidence,
    dedupeKey: fact.dedupeKey,
    sourceKind: fact.sourceKind,
    sourceSessionId: fact.sourceSessionId ?? null,
    sourceJobId: fact.sourceJobId ?? null,
    sourceResultId: fact.sourceResultId ?? null,
    sourceLabel: fact.sourceLabel ?? null,
    validFrom: fact.validFrom ?? null,
    validUntil: fact.validUntil ?? null,
    supersededBy: fact.supersededBy ?? null,
    conflictsWith: fact.conflictsWith ?? null,
    userVerified: Boolean(fact.userVerified),
    firstSeenAt: fact.firstSeenAt,
    lastConfirmedAt: fact.lastConfirmedAt,
    evidence: (fact.evidence ?? []).map((entry) => ({
      sourceKey: entry.sourceKey,
      sessionId: entry.sessionId,
      batchIndex: entry.batchIndex ?? null,
      seq: entry.seq ?? null,
      eventId: entry.eventId ?? null,
      observedAt: entry.observedAt ?? null,
      available: entry.available !== false
    }))
  }));
}

/** Restore a snapshot to engine shape (used by rollback). */
function factsFromSnapshot(snapshot, {broadcasterId, viewerId}) {
  return (snapshot ?? []).map((fact) => ({
    ...fact,
    broadcasterId,
    viewerId,
    evidence: (fact.evidence ?? []).map((entry) => ({...entry}))
  }));
}

/**
 * Compute what an operation list would do, without writing anything.
 *
 * @returns {{ok:boolean, memoryId:string|null, version:number, facts:Array, diff:object, results:Array, warnings:Array}}
 */
export function previewMemoryOperations({db, broadcasterId, viewerId, operations, source = {}, now = Date.now()}) {
  const memory = getMemory(db, {broadcasterId, viewerId});
  const facts = memory && memory.status === 'active' ? loadMemoryFacts(db, memory.id) : [];
  const outcome = applyOperations({
    facts,
    operations,
    context: {broadcasterId, viewerId, now, source}
  });
  const diff = diffFacts(facts, outcome.facts);
  return {
    ok: true,
    memoryId: memory?.id ?? null,
    baseVersion: memory?.version ?? 0,
    version: (memory?.version ?? 0) + 1,
    facts: outcome.facts,
    diff,
    results: outcome.results,
    warnings: outcome.warnings
  };
}

/**
 * Apply one operation list as a new memory version.
 *
 * @param {object} options
 * @param {boolean} [options.transaction] wrap in its own transaction (default true)
 * @param {string} [options.sourceKey] idempotency key; an existing version with
 *   the same key is returned as `duplicate` and nothing is written.
 */
export function applyMemoryOperations({
  db,
  broadcasterId,
  viewerId,
  operations,
  source = {},
  sourceKey,
  summary,
  summaryCertainty,
  now = Date.now(),
  transaction = true,
  outdatedAfterMs = undefined
}) {
  const run = () => {
    const key = String(sourceKey ?? `${source.kind ?? 'manual'}:${now}`);
    const memory = ensureMemory(db, {
      id: createId('vmem'),
      broadcasterId,
      viewerId,
      now
    });
    const existing = versionForSource(db, memory.id, key);
    if (existing) {
      return {
        duplicate: true,
        memoryId: memory.id,
        version: existing.version,
        versionRecord: existing,
        diff: existing.diff,
        facts: listFacts(db, memory.id)
      };
    }
    const facts = memory.status === 'active' && memory.version > 0 ? loadMemoryFacts(db, memory.id) : [];
    const outcome = applyOperations({
      facts,
      operations,
      context: {broadcasterId, viewerId, now, source, outdatedAfterMs}
    });
    const diff = diffFacts(facts, outcome.facts);
    const checksum = factSetChecksum(outcome.facts);
    const previousVersion = latestVersion(db, memory.id);
    if (previousVersion && previousVersion.sourceKey === key) {
      return {duplicate: true, memoryId: memory.id, version: previousVersion.version, diff: previousVersion.diff, facts};
    }
    const version = Number(memory.version ?? 0) + 1;
    replaceFacts(db, memory.id, outcome.facts, {now});
    insertVersion(db, {
      id: createId('mver'),
      memoryId: memory.id,
      version,
      sourceKind: source.kind ?? MEMORY_SOURCE_KIND.MANUAL,
      sourceJobId: source.jobId ?? null,
      sourceResultId: source.resultId ?? null,
      sourceSessionId: source.sessionId ?? null,
      sourceKey: key,
      counts: {...diff.counts, checksum, operations: outcome.results.length},
      diff,
      snapshot: snapshotOf(outcome.facts),
      appliedAt: now
    });
    touchMemory(db, memory.id, {
      version,
      summary: summary === undefined ? null : summary,
      summaryCertainty: summaryCertainty === undefined ? null : summaryCertainty,
      lastSessionId: source.sessionId ?? null,
      lastJobId: source.jobId ?? null,
      now
    });
    refreshMemoryEvidence(db, {memoryId: memory.id, now});
    pruneVersions(db, {memoryId: memory.id, keep: MEMORY_VERSIONS_KEPT});
    return {
      duplicate: false,
      memoryId: memory.id,
      version,
      diff,
      counts: diff.counts,
      checksum,
      results: outcome.results,
      warnings: outcome.warnings,
      facts: listFacts(db, memory.id)
    };
  };
  return transaction ? withTransaction(db, run) : run();
}

/**
 * Restore an earlier version as a *new* version.
 *
 * History stays append-only: a rollback is visible in the version list and can
 * itself be rolled back.
 */
export function rollbackMemory({db, memoryId, version, now = Date.now(), transaction = true}) {
  const run = () => {
    const memory = getMemoryById(db, memoryId);
    if (!memory) return {ok: false, reason: 'MEMORY_NOT_FOUND'};
    if (memory.status !== 'active') return {ok: false, reason: 'MEMORY_DELETED'};
    const target = db.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(String(memoryId), Number(version));
    if (!target) return {ok: false, reason: 'MEMORY_VERSION_NOT_FOUND'};
    let snapshot;
    try {
      snapshot = JSON.parse(target.snapshot_json);
    } catch {
      return {ok: false, reason: 'MEMORY_VERSION_CORRUPT'};
    }
    const facts = factsFromSnapshot(snapshot, {
      broadcasterId: memory.broadcasterId,
      viewerId: memory.viewerId
    });
    const before = loadMemoryFacts(db, memoryId);
    const diff = diffFacts(before, facts);
    const nextVersion = Number(memory.version ?? 0) + 1;
    const sourceKey = `rollback:${version}:${nextVersion}`;
    replaceFacts(db, memoryId, facts, {now});
    insertVersion(db, {
      id: createId('mver'),
      memoryId,
      version: nextVersion,
      sourceKind: MEMORY_SOURCE_KIND.ROLLBACK,
      sourceJobId: target.source_job_id ?? null,
      sourceResultId: target.source_result_id ?? null,
      sourceSessionId: target.source_session_id ?? null,
      sourceKey,
      counts: {...diff.counts, restoredFrom: Number(version)},
      diff,
      snapshot: snapshotOf(facts),
      appliedAt: now
    });
    touchMemory(db, memoryId, {version: nextVersion, now});
    refreshMemoryEvidence(db, {memoryId, now});
    return {ok: true, memoryId, version: nextVersion, restoredFrom: Number(version), diff};
  };
  return transaction ? withTransaction(db, run) : run();
}

/** Manual review of one fact; always creates a new version for the trail. */
export function reviewMemoryFact({db, memoryId, factId, action, now = Date.now()}) {
  return withTransaction(db, () => {
    const memory = getMemoryById(db, memoryId);
    if (!memory) return {ok: false, reason: 'MEMORY_NOT_FOUND'};
    if (memory.status !== 'active') return {ok: false, reason: 'MEMORY_DELETED'};
    const before = loadMemoryFacts(db, memoryId);
    const outcome = reviewFact({
      facts: before,
      factId,
      action,
      now,
      source: {kind: MEMORY_SOURCE_KIND.MANUAL}
    });
    if (!outcome.ok) return outcome;
    const diff = diffFacts(before, outcome.facts);
    const nextVersion = Number(memory.version ?? 0) + 1;
    replaceFacts(db, memoryId, outcome.facts, {now});
    insertVersion(db, {
      id: createId('mver'),
      memoryId,
      version: nextVersion,
      sourceKind: MEMORY_SOURCE_KIND.MANUAL,
      sourceKey: `review:${action}:${factId}:${nextVersion}`,
      counts: {...diff.counts, action},
      diff,
      snapshot: snapshotOf(outcome.facts),
      appliedAt: now
    });
    touchMemory(db, memoryId, {version: nextVersion, now});
    refreshMemoryEvidence(db, {memoryId, now});
    return {ok: true, memoryId, version: nextVersion, action, diff};
  });
}

export const __internal = {snapshotOf, factsFromSnapshot, emptyDiff, DIFF_PREVIEW_FACTS};
