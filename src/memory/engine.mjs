import {
  MEMORY_CERTAINTY,
  MEMORY_KIND,
  MEMORY_OPERATION,
  MEMORY_STATUS,
  MEMORY_OUTDATED_AFTER_MS,
  TARGETED_OPERATIONS
} from './constants.mjs';
import {
  addEvidence,
  applyOutdatedRule,
  createFact,
  dedupeKeyFor,
  findMatch,
  findOpposite,
  normalizeCertainty,
  normalizeKind,
  normalizeText,
  normalizeTopic,
  recalcEvidence
} from './model.mjs';

/**
 * The memory merge engine.
 *
 * It takes the current fact set and a list of operations and returns a new fact
 * set plus an honest record of what happened to every operation. It is pure, so
 * the preview shown to the user is produced by exactly the same code that later
 * writes the version.
 *
 * Safety rules enforced here (not left to the AI):
 * - an `add` for a topic that is already known becomes a confirmation, never a
 *   duplicate row;
 * - `interest` and `dislike` for the same topic become an explicit conflict; the
 *   engine never picks a winner on its own;
 * - a `supersede` keeps the old fact as history instead of deleting it;
 * - nothing is ever deleted by an operation;
 * - an inference is never upgraded to `stated` because the AI said so twice.
 */

function findById(facts, factId) {
  return facts.find((fact) => fact.id === factId) ?? null;
}

function liveKeyOwner(facts, dedupeKey, exceptId = null) {
  return facts.find((fact) => (
    fact.dedupeKey === dedupeKey
    && fact.status !== MEMORY_STATUS.SUPERSEDED
    && fact.id !== exceptId
  )) ?? null;
}

function mergeEvidence(target, entries) {
  for (const entry of entries ?? []) addEvidence(target, entry);
}

function applyEvidenceState(fact) {
  recalcEvidence(fact);
  return fact;
}

function scopeFor(context, fact) {
  return {
    ...fact,
    broadcasterId: context.broadcasterId,
    viewerId: context.viewerId
  };
}

/**
 * @param {object} options
 * @param {Array<object>} options.facts current facts (engine shape)
 * @param {Array<object>} options.operations validated operations
 * @param {object} options.context {broadcasterId, viewerId, now, source, outdatedAfterMs}
 * @returns {{facts:Array<object>, results:Array<object>, warnings:Array<object>}}
 */
export function applyOperations({facts, operations, context}) {
  const now = Number(context.now ?? Date.now());
  const outdatedAfterMs = Number(context.outdatedAfterMs ?? MEMORY_OUTDATED_AFTER_MS);
  const source = context.source ?? {};
  const working = facts.map((fact) => ({...fact, evidence: [...(fact.evidence ?? [])]}));
  const results = [];
  const warnings = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const op = operation.op;
    const evidence = operation.evidence ?? [];
    const baseResult = {index, op, viewerId: context.viewerId};
    let target = null;

    if (TARGETED_OPERATIONS.includes(op)) {
      target = operation.targetFactId ? findById(working, operation.targetFactId) : null;
      if (!target) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_FACT_UNKNOWN'});
        warnings.push({code: 'MEMORY_FACT_UNKNOWN', opIndex: index, targetFactId: operation.targetFactId ?? null});
        continue;
      }
    }

    if (op === MEMORY_OPERATION.ADD || op === MEMORY_OPERATION.UNCERTAIN) {
      const kind = normalizeKind(operation.kind);
      const certainty = op === MEMORY_OPERATION.UNCERTAIN
        ? MEMORY_CERTAINTY.UNCERTAIN
        : normalizeCertainty(operation.certainty);
      const topic = operation.topic ? normalizeText(operation.topic, 80) : null;
      const statement = normalizeText(operation.statement ?? operation.note ?? topic ?? '', 400);
      const match = findMatch(working, {kind, topic, statement});
      if (match) {
        match.lastConfirmedAt = now;
        mergeEvidence(match, evidence);
        if (certainty === MEMORY_CERTAINTY.STATED && match.certainty === MEMORY_CERTAINTY.INFERRED) {
          match.certainty = MEMORY_CERTAINTY.STATED;
        }
        if (match.status === MEMORY_STATUS.OUTDATED) {
          match.status = MEMORY_STATUS.ACTIVE;
          match.statusReason = null;
        }
        if (match.status === MEMORY_STATUS.NEEDS_CONFIRMATION && certainty !== MEMORY_CERTAINTY.UNCERTAIN) {
          match.status = MEMORY_STATUS.ACTIVE;
          match.statusReason = null;
        }
        if (operation.confidence !== undefined && operation.confidence !== null) {
          match.confidence = Number(operation.confidence);
        }
        applyEvidenceState(match);
        results.push({...baseResult, status: 'confirmed', factId: match.id, dedupeKey: match.dedupeKey});
        continue;
      }
      const opposite = findOpposite(working, {kind, topic});
      const created = scopeFor(context, createFact({
        broadcasterId: context.broadcasterId,
        viewerId: context.viewerId,
        kind,
        topic,
        statement,
        certainty,
        status: certainty === MEMORY_CERTAINTY.UNCERTAIN
          ? MEMORY_STATUS.NEEDS_CONFIRMATION
          : MEMORY_STATUS.ACTIVE,
        confidence: operation.confidence,
        sourceKind: source.kind ?? 'ai_memory_update',
        sourceSessionId: source.sessionId ?? null,
        sourceJobId: source.jobId ?? null,
        sourceResultId: source.resultId ?? null,
        sourceLabel: source.label ?? null,
        validFrom: operation.validFrom ?? null,
        now
      }));
      mergeEvidence(created, evidence);
      applyEvidenceState(created);
      if (opposite) {
        created.status = MEMORY_STATUS.CONFLICTED;
        created.conflictsWith = opposite.id;
        opposite.status = MEMORY_STATUS.CONFLICTED;
        opposite.conflictsWith = created.id;
        warnings.push({code: 'MEMORY_CONFLICT_CREATED', opIndex: index, factId: created.id, otherFactId: opposite.id});
      }
      working.push(created);
      results.push({
        ...baseResult,
        status: created.status === MEMORY_STATUS.CONFLICTED ? 'conflicted' : 'added',
        factId: created.id,
        dedupeKey: created.dedupeKey
      });
      continue;
    }

    if (op === MEMORY_OPERATION.CONFIRM) {
      if (target.status === MEMORY_STATUS.SUPERSEDED) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TARGET_SUPERSEDED', factId: target.id});
        warnings.push({code: 'MEMORY_TARGET_SUPERSEDED', opIndex: index, factId: target.id});
        continue;
      }
      target.lastConfirmedAt = now;
      mergeEvidence(target, evidence);
      if (operation.certainty && normalizeCertainty(operation.certainty) === MEMORY_CERTAINTY.STATED
        && target.certainty === MEMORY_CERTAINTY.INFERRED) {
        target.certainty = MEMORY_CERTAINTY.STATED;
      }
      if (target.status === MEMORY_STATUS.OUTDATED) {
        target.status = MEMORY_STATUS.ACTIVE;
        target.statusReason = null;
        target.validUntil = null;
      }
      if (target.status === MEMORY_STATUS.NEEDS_CONFIRMATION && target.certainty !== MEMORY_CERTAINTY.UNCERTAIN) {
        target.status = MEMORY_STATUS.ACTIVE;
        target.statusReason = null;
      }
      if (operation.confidence !== undefined && operation.confidence !== null) {
        target.confidence = Number(operation.confidence);
      }
      applyEvidenceState(target);
      results.push({...baseResult, status: 'confirmed', factId: target.id});
      continue;
    }

    if (op === MEMORY_OPERATION.UPDATE) {
      if (target.status === MEMORY_STATUS.SUPERSEDED) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TARGET_SUPERSEDED', factId: target.id});
        continue;
      }
      const kind = operation.kind ? normalizeKind(operation.kind) : target.kind;
      const topic = operation.topic !== undefined ? normalizeTopic(operation.topic) : normalizeTopic(target.topic);
      const statement = operation.statement
        ? normalizeText(operation.statement, 400)
        : target.statement;
      const dedupeKey = dedupeKeyFor({kind, topic, statement});
      const owner = liveKeyOwner(working, dedupeKey, target.id);
      if (owner) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TOPIC_CONFLICT', factId: target.id, otherFactId: owner.id});
        warnings.push({code: 'MEMORY_TOPIC_CONFLICT', opIndex: index, factId: target.id, otherFactId: owner.id});
        continue;
      }
      target.kind = kind;
      target.topic = operation.topic === undefined ? target.topic : (operation.topic ? normalizeText(operation.topic, 80) : null);
      target.statement = statement;
      target.dedupeKey = dedupeKey;
      if (operation.certainty) target.certainty = normalizeCertainty(operation.certainty);
      if (operation.confidence !== undefined && operation.confidence !== null) {
        target.confidence = Number(operation.confidence);
      }
      target.lastConfirmedAt = now;
      mergeEvidence(target, evidence);
      applyEvidenceState(target);
      results.push({...baseResult, status: 'updated', factId: target.id});
      continue;
    }

    if (op === MEMORY_OPERATION.SUPERSEDE) {
      if (target.status === MEMORY_STATUS.SUPERSEDED) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TARGET_SUPERSEDED', factId: target.id});
        continue;
      }
      const kind = operation.kind ? normalizeKind(operation.kind) : target.kind;
      const topic = operation.topic !== undefined ? operation.topic : target.topic;
      const statement = normalizeText(operation.statement ?? '', 400);
      if (!statement) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_STATEMENT_REQUIRED', factId: target.id});
        continue;
      }
      const dedupeKey = dedupeKeyFor({kind, topic, statement});
      const owner = liveKeyOwner(working, dedupeKey, target.id);
      if (owner) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TOPIC_CONFLICT', factId: target.id, otherFactId: owner.id});
        continue;
      }
      const validFrom = operation.validFrom ?? now;
      target.status = MEMORY_STATUS.SUPERSEDED;
      target.statusReason = 'superseded';
      target.validUntil = operation.validFrom ?? now;
      const created = scopeFor(context, createFact({
        broadcasterId: context.broadcasterId,
        viewerId: context.viewerId,
        kind,
        topic,
        statement,
        certainty: normalizeCertainty(operation.certainty ?? target.certainty),
        status: MEMORY_STATUS.ACTIVE,
        confidence: operation.confidence,
        sourceKind: source.kind ?? 'ai_memory_update',
        sourceSessionId: source.sessionId ?? null,
        sourceJobId: source.jobId ?? null,
        sourceResultId: source.resultId ?? null,
        sourceLabel: source.label ?? null,
        validFrom,
        now
      }));
      target.supersededBy = created.id;
      mergeEvidence(created, evidence);
      applyEvidenceState(created);
      applyEvidenceState(target);
      working.push(created);
      results.push({...baseResult, status: 'superseded', factId: created.id, replacedFactId: target.id});
      continue;
    }

    if (op === MEMORY_OPERATION.CONFLICT) {
      if (target.status === MEMORY_STATUS.SUPERSEDED) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TARGET_SUPERSEDED', factId: target.id});
        continue;
      }
      const statement = normalizeText(operation.statement ?? '', 400);
      if (!statement) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_STATEMENT_REQUIRED', factId: target.id});
        continue;
      }
      const kind = operation.kind ? normalizeKind(operation.kind) : target.kind;
      const topic = operation.topic !== undefined ? operation.topic : target.topic;
      const dedupeKey = dedupeKeyFor({kind, topic, statement});
      if (dedupeKey === target.dedupeKey) {
        // The target stays live, so an identical key would violate the unique
        // "one live fact per topic" index. Ask the AI for an update instead.
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TOPIC_CONFLICT', factId: target.id});
        warnings.push({code: 'MEMORY_TOPIC_CONFLICT', opIndex: index, factId: target.id});
        continue;
      }
      const owner = liveKeyOwner(working, dedupeKey, target.id);
      if (owner) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TOPIC_CONFLICT', factId: target.id, otherFactId: owner.id});
        continue;
      }
      const created = scopeFor(context, createFact({
        broadcasterId: context.broadcasterId,
        viewerId: context.viewerId,
        kind,
        topic,
        statement,
        certainty: normalizeCertainty(operation.certainty ?? MEMORY_CERTAINTY.INFERRED),
        status: MEMORY_STATUS.CONFLICTED,
        confidence: operation.confidence,
        sourceKind: source.kind ?? 'ai_memory_update',
        sourceSessionId: source.sessionId ?? null,
        sourceJobId: source.jobId ?? null,
        sourceResultId: source.resultId ?? null,
        sourceLabel: source.label ?? null,
        validFrom: operation.validFrom ?? null,
        now
      }));
      created.conflictsWith = target.id;
      target.status = MEMORY_STATUS.CONFLICTED;
      target.conflictsWith = created.id;
      mergeEvidence(created, evidence);
      applyEvidenceState(created);
      applyEvidenceState(target);
      working.push(created);
      results.push({...baseResult, status: 'conflicted', factId: created.id, replacedFactId: target.id});
      continue;
    }

    if (op === MEMORY_OPERATION.OUTDATED) {
      if (target.status === MEMORY_STATUS.SUPERSEDED) {
        results.push({...baseResult, status: 'skipped', reason: 'MEMORY_TARGET_SUPERSEDED', factId: target.id});
        continue;
      }
      target.status = MEMORY_STATUS.OUTDATED;
      target.statusReason = operation.reason ? normalizeText(operation.reason, 120) : 'marked_outdated';
      target.validUntil = operation.validUntil ?? now;
      mergeEvidence(target, evidence);
      applyEvidenceState(target);
      results.push({...baseResult, status: 'outdated', factId: target.id});
      continue;
    }

    results.push({...baseResult, status: 'skipped', reason: 'MEMORY_OP_UNKNOWN'});
  }

  applyOutdatedRule(working, {now, outdatedAfterMs});
  for (const fact of working) applyEvidenceState(fact);

  return {facts: working, results, warnings};
}

/**
 * Manual review of one fact (the human-in-the-loop path).
 *
 * `confirm` promotes an inference to a user-confirmed fact; `dismiss` marks it
 * outdated; `restore` returns it to active. Every action only changes the fact's
 * own confidence markers — it never rewrites what the AI extracted.
 */
export function reviewFact({facts, factId, action, now = Date.now(), source = {}}) {
  const target = findById(facts, factId);
  if (!target) return {ok: false, reason: 'MEMORY_FACT_UNKNOWN', facts};
  // Re-activating a superseded fact would collide with the newer fact that
  // replaced it (one live fact per topic). The user decides with a new update.
  if (target.status === MEMORY_STATUS.SUPERSEDED && (action === 'confirm' || action === 'restore')) {
    return {ok: false, reason: 'MEMORY_TARGET_SUPERSEDED', facts};
  }
  const working = facts.map((fact) => ({...fact, evidence: [...(fact.evidence ?? [])]}));
  const fact = findById(working, factId);
  if (action === 'confirm') {
    fact.certainty = MEMORY_CERTAINTY.STATED;
    fact.status = MEMORY_STATUS.ACTIVE;
    fact.statusReason = null;
    fact.userVerified = true;
    fact.validUntil = null;
    fact.lastConfirmedAt = Number(now);
  } else if (action === 'dismiss') {
    fact.status = MEMORY_STATUS.OUTDATED;
    fact.statusReason = 'dismissed_by_user';
    fact.validUntil = Number(now);
  } else if (action === 'forget') {
    working.splice(working.indexOf(fact), 1);
    return {ok: true, facts: working, factId, action, removed: true, source};
  } else if (action === 'restore') {
    fact.status = MEMORY_STATUS.ACTIVE;
    fact.statusReason = null;
    fact.validUntil = null;
    fact.lastConfirmedAt = Number(now);
  } else if (action === 'mark_inferred') {
    fact.certainty = MEMORY_CERTAINTY.INFERRED;
    fact.userVerified = false;
    fact.status = MEMORY_STATUS.NEEDS_CONFIRMATION;
  } else {
    return {ok: false, reason: 'MEMORY_REVIEW_ACTION_UNKNOWN', facts};
  }
  return {ok: true, facts: working, factId, action, source};
}

export const __internal = {findById, liveKeyOwner, applyEvidenceState};
