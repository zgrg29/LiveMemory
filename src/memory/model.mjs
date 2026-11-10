import {createHash} from 'node:crypto';
import {createId} from '../shared/ids.mjs';
import {
  MEMORY_CERTAINTIES,
  MEMORY_CERTAINTY,
  MEMORY_KINDS,
  MEMORY_STATUS,
  MEMORY_STATUSES,
  MAX_STATEMENT_LENGTH,
  MAX_TOPIC_LENGTH,
  TIMELESS_KINDS
} from './constants.mjs';
import {listEvidence, listFacts} from '../storage/repositories/viewer-memory.mjs';

/**
 * Pure memory model helpers: normalisation, dedupe keys, fact factories and the
 * before/after diff.
 *
 * Nothing here touches the database, so the same code path can produce a
 * preview (dry run) and an applied version. That is what makes the preview
 * trustworthy: it is the real engine, not a second implementation.
 */

const PUNCTUATION = /[\s\u3000.,!?;:'"`~^*_\-+=\\/|@#$%&()\[\]{}<>，。！？；：、…～·“”‘’（）【】《》〈〉「」『』〔〕]/g;
// Emoji / pictographs and variation selectors are not part of a topic key.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** Collapse whitespace, strip control characters and clamp the length. */
export function normalizeText(value, maxLength = MAX_STATEMENT_LENGTH) {
  if (value === null || value === undefined) return '';
  const text = String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

/**
 * Topic key used for de-duplication. Case, spacing, punctuation and emoji are
 * removed so "RPG游戏" / "rpg 游戏" / "RPG游戏🎮" collapse into one topic.
 * Chinese/Japanese are preserved as-is; a translation is never inferred.
 */
export function normalizeTopic(value) {
  if (value === null || value === undefined) return '';
  const text = String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(EMOJI, '')
    .replace(PUNCTUATION, '')
    .trim();
  return text.length > MAX_TOPIC_LENGTH * 2 ? text.slice(0, MAX_TOPIC_LENGTH * 2) : text;
}

/**
 * Stable key for "the same fact".
 *
 * Topic is the primary key for interests/dislikes/topics/preferences so the
 * same interest can never accumulate twice. Kinds without a topic fall back to
 * the normalised statement. `identity` is keyed by topic only (a viewer has one
 * identity statement per label such as "nickname origin").
 */
export function dedupeKeyFor({kind, topic, statement}) {
  const normalizedTopic = normalizeTopic(topic);
  const kindKey = MEMORY_KINDS.includes(kind) ? kind : 'other';
  if (normalizedTopic) return `${kindKey}:${normalizedTopic}`;
  const normalizedStatement = normalizeText(statement, 160)
    .normalize('NFKC')
    .toLowerCase()
    .replace(EMOJI, '')
    .replace(PUNCTUATION, '');
  return `${kindKey}:s:${normalizedStatement.slice(0, 80)}`;
}

export function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, Math.round(number * 1000) / 1000));
}

export function normalizeCertainty(value) {
  return MEMORY_CERTAINTIES.includes(value) ? value : MEMORY_CERTAINTY.UNCERTAIN;
}

export function normalizeKind(value) {
  return MEMORY_KINDS.includes(value) ? value : 'other';
}

export function normalizeStatus(value) {
  return MEMORY_STATUSES.includes(value) ? value : MEMORY_STATUS.ACTIVE;
}

/**
 * @param {object} input
 * @returns {object} a fact in engine shape (persistable by replaceFacts)
 */
export function createFact({
  id = null,
  broadcasterId,
  viewerId,
  kind = 'other',
  topic = null,
  statement,
  certainty = MEMORY_CERTAINTY.INFERRED,
  status = MEMORY_STATUS.ACTIVE,
  statusReason = null,
  confidence = null,
  sourceKind = 'ai_memory_update',
  sourceSessionId = null,
  sourceJobId = null,
  sourceResultId = null,
  sourceLabel = null,
  validFrom = null,
  validUntil = null,
  supersededBy = null,
  conflictsWith = null,
  userVerified = false,
  now = Date.now()
}) {
  const normalizedKind = normalizeKind(kind);
  const normalizedTopic = topic ? normalizeText(topic, MAX_TOPIC_LENGTH) : null;
  const normalizedStatement = normalizeText(statement, MAX_STATEMENT_LENGTH);
  return {
    id: id ?? createId('mfc'),
    broadcasterId,
    viewerId,
    kind: normalizedKind,
    topic: normalizedTopic,
    statement: normalizedStatement,
    certainty: normalizeCertainty(certainty),
    status: normalizeStatus(status),
    statusReason,
    confidence: clampConfidence(confidence),
    dedupeKey: dedupeKeyFor({kind: normalizedKind, topic: normalizedTopic, statement: normalizedStatement}),
    evidenceStatus: 'none',
    evidenceCount: 0,
    evidenceAvailable: 0,
    sourceKind,
    sourceSessionId,
    sourceJobId,
    sourceResultId,
    sourceLabel,
    validFrom,
    validUntil,
    supersededBy,
    conflictsWith,
    userVerified: Boolean(userVerified),
    firstSeenAt: now,
    lastConfirmedAt: now,
    createdAt: now,
    evidence: []
  };
}

export function evidenceSourceKey({sessionId, batchIndex = null, seq = null, resultId = null}) {
  if (resultId) return `r:${resultId}`;
  return `s:${sessionId}:b${batchIndex ?? 0}:${seq ?? 0}`;
}

/** Add an evidence reference once; duplicates are ignored by source key. */
export function addEvidence(fact, evidence) {
  const sourceKey = evidence.sourceKey ?? evidenceSourceKey(evidence);
  if (fact.evidence.some((entry) => entry.sourceKey === sourceKey)) return false;
  fact.evidence.push({
    sourceKey,
    sessionId: evidence.sessionId,
    batchIndex: evidence.batchIndex ?? null,
    seq: evidence.seq ?? null,
    eventId: evidence.eventId ?? null,
    observedAt: evidence.observedAt ?? null,
    available: evidence.available !== false
  });
  return true;
}

/** Recompute the evidence counters that are persisted on the fact row. */
export function recalcEvidence(fact) {
  const total = fact.evidence.length;
  const available = fact.evidence.filter((entry) => entry.available !== false).length;
  fact.evidenceCount = total;
  fact.evidenceAvailable = available;
  if (total === 0) fact.evidenceStatus = 'none';
  else if (available === total) fact.evidenceStatus = 'available';
  else if (available > 0) fact.evidenceStatus = 'partial';
  else fact.evidenceStatus = 'unavailable';
  return fact;
}

/** Facts of one memory in engine shape, with their evidence attached. */
export function loadMemoryFacts(db, memoryId) {
  const facts = listFacts(db, memoryId).map((fact) => ({...fact, evidence: []}));
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const evidence of listEvidence(db, memoryId)) {
    const fact = byId.get(evidence.factId);
    if (!fact) continue;
    fact.evidence.push({
      sourceKey: evidence.sourceKey,
      sessionId: evidence.sessionId,
      batchIndex: evidence.batchIndex,
      seq: evidence.seq,
      eventId: evidence.eventId,
      observedAt: evidence.observedAt,
      available: evidence.available !== false && evidence.contentExists !== false
    });
  }
  return facts;
}

/**
 * Facts that are still relevant for merging: superseded facts stay in history
 * but are not matched by a new `add` (a new statement is a new fact).
 */
export function findMatch(facts, {kind, topic, statement}) {
  const key = dedupeKeyFor({kind, topic, statement});
  for (const fact of facts) {
    if (fact.status === MEMORY_STATUS.SUPERSEDED) continue;
    if (fact.dedupeKey === key) return fact;
  }
  return null;
}

export function findOpposite(facts, {kind, topic}) {
  const opposite = kind === 'interest' ? 'dislike' : (kind === 'dislike' ? 'interest' : null);
  if (!opposite || !topic) return null;
  const key = dedupeKeyFor({kind: opposite, topic, statement: ''});
  return facts.find((fact) => (
    fact.dedupeKey === key
    && fact.status !== MEMORY_STATUS.SUPERSEDED
    && fact.status !== MEMORY_STATUS.OUTDATED
  )) ?? null;
}

function factSummary(fact) {
  return {
    id: fact.id,
    kind: fact.kind,
    topic: fact.topic,
    statement: fact.statement,
    certainty: fact.certainty,
    status: fact.status,
    confidence: fact.confidence
  };
}

const TRACKED_FIELDS = Object.freeze([
  'kind',
  'topic',
  'statement',
  'certainty',
  'status',
  'supersededBy',
  'conflictsWith',
  'validUntil'
]);

/**
 * Compare two fact sets by id. Used for the version diff shown in the UI.
 *
 * `confirmed` counts facts that kept their meaning but were re-confirmed (later
 * `lastConfirmedAt`), which is the most common outcome of a quiet session and
 * should be reported as such rather than as a change.
 */
export function diffFacts(before, after) {
  const beforeById = new Map(before.map((fact) => [fact.id, fact]));
  const afterById = new Map(after.map((fact) => [fact.id, fact]));
  const added = [];
  const changed = [];
  const removed = [];
  const confirmed = [];
  let unchanged = 0;
  for (const fact of after) {
    const previous = beforeById.get(fact.id);
    if (!previous) {
      added.push(factSummary(fact));
      continue;
    }
    const fields = [];
    for (const field of TRACKED_FIELDS) {
      const from = previous[field] ?? null;
      const to = fact[field] ?? null;
      if (from !== to) fields.push({field, from, to});
    }
    if (fields.length > 0) {
      changed.push({...factSummary(fact), changes: fields});
    } else if (Number(fact.lastConfirmedAt) > Number(previous.lastConfirmedAt)) {
      confirmed.push(factSummary(fact));
    } else {
      unchanged += 1;
    }
  }
  for (const fact of before) {
    if (!afterById.has(fact.id)) removed.push(factSummary(fact));
  }
  return {
    added,
    changed,
    removed,
    confirmed,
    unchanged,
    counts: {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      confirmed: confirmed.length,
      unchanged,
      total: after.length
    }
  };
}

export function isEmptyDiff(diff) {
  return diff.added.length === 0
    && diff.changed.length === 0
    && diff.removed.length === 0
    && diff.confirmed.length === 0;
}

/** Stable digest of a fact set, used to skip no-op version writes. */
export function factSetChecksum(facts) {
  const canonical = facts.map((fact) => [
    fact.id,
    fact.kind,
    fact.topic ?? '',
    fact.statement,
    fact.certainty,
    fact.status,
    fact.supersededBy ?? '',
    fact.conflictsWith ?? '',
    fact.validUntil ?? ''
  ]);
  canonical.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Age-based rule: a non-timeless active fact that stopped being confirmed. */
export function applyOutdatedRule(facts, {now = Date.now(), outdatedAfterMs}) {
  const touched = [];
  for (const fact of facts) {
    if (fact.status !== MEMORY_STATUS.ACTIVE) continue;
    if (TIMELESS_KINDS.includes(fact.kind)) continue;
    if (fact.certainty === MEMORY_CERTAINTY.UNCERTAIN) continue;
    if (now - Number(fact.lastConfirmedAt) < outdatedAfterMs) continue;
    fact.status = MEMORY_STATUS.OUTDATED;
    fact.statusReason = 'not_recently_confirmed';
    touched.push(fact);
  }
  return touched;
}

/** Group facts for the viewer profile UI. */
export function groupFacts(facts) {
  const groups = {
    attention: [],
    confirmed: [],
    inferred: [],
    outdated: [],
    conflicts: [],
    history: []
  };
  for (const fact of facts) {
    if (fact.status === MEMORY_STATUS.CONFLICTED) groups.conflicts.push(fact);
    else if (fact.status === MEMORY_STATUS.NEEDS_CONFIRMATION) groups.attention.push(fact);
    else if (fact.status === MEMORY_STATUS.SUPERSEDED) groups.history.push(fact);
    else if (fact.status === MEMORY_STATUS.OUTDATED) groups.outdated.push(fact);
    else if (fact.certainty === MEMORY_CERTAINTY.STATED || fact.userVerified) groups.confirmed.push(fact);
    else groups.inferred.push(fact);
  }
  return groups;
}

export const __internal = {PUNCTUATION, EMOJI, TRACKED_FIELDS, factSummary};
