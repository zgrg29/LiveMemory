import {createHash} from 'node:crypto';
import {validateAgainstSchema} from '../import/schema-validator.mjs';
import {estimateJsonTokens, estimateTokens} from '../batching/tokens.mjs';
import {
  DIGEST_AGGREGATE_LIMITS,
  TIGHT_AGGREGATE_LIMITS,
  buildAggregateDigestSchema,
  buildAggregateFinalEnvelopeSchema
} from '../api/compact.mjs';

/**
 * Pure planning/validation helpers for the hierarchical session aggregate.
 *
 * The runner owns provider calls and persistence. Everything here is
 * deterministic so the same saved batch results always produce the same
 * grouping, source hashes, coverage checks and fallback report. That is what
 * makes a resume reuse completed nodes instead of silently starting over.
 */

export const AGGREGATE_NODE_PROTOCOL = 'livememory-aggregate-node-v1';
export const AGGREGATE_NODE_VERSION = '1.0.0';
export const AGGREGATE_PLAN_VERSION = 'lm-aggregate-plan-v1';
export const MAX_AGGREGATE_NODES = 2001;
export const MAX_DIGEST_UNITS = 72;
export const MAX_FINAL_UNITS = 24;
export const FINAL_AGGREGATE_LIMITS = Object.freeze({
  ...DIGEST_AGGREGATE_LIMITS,
  topics: 24,
  sentiment: 12,
  disputes: 8,
  highlights: 8,
  messageRefs: 6
});
export {DIGEST_AGGREGATE_LIMITS, TIGHT_AGGREGATE_LIMITS};
export {uniqueIntegers};

const SECTION_LIMITS = Object.freeze({
  topics: 'topics',
  sentiment: 'sentiment',
  disputes: 'disputes',
  highlights: 'highlights'
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uniqueIntegers(values) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || seen.has(number)) continue;
    seen.add(number);
    out.push(number);
  }
  return out.sort((a, b) => a - b);
}

function string(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function iso(value, fallback = null) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }
  return fallback;
}

export function refKey(batch, seq) {
  return `${Number(batch)}:${Number(seq)}`;
}

export function parseRefKey(key) {
  const match = /^(\d+):(\d+)$/.exec(String(key ?? ''));
  return match ? {batch: Number(match[1]), seq: Number(match[2])} : null;
}

/** Normalize any evidence ref to `{batch, seq}` using the owning batch. */
export function qualifyRefs(refs, batchIndex) {
  const out = [];
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    let batch = null;
    let seq = null;
    if (typeof ref === 'number' || typeof ref === 'string') {
      const number = Number(ref);
      if (!Number.isInteger(number) || number < 1) continue;
      batch = Number(batchIndex);
      seq = number;
    } else if (ref && typeof ref === 'object') {
      batch = Number(ref.batch);
      seq = Number(ref.seq);
    }
    if (!Number.isInteger(batch) || batch < 1 || !Number.isInteger(seq) || seq < 1) continue;
    const key = refKey(batch, seq);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({batch, seq});
  }
  return out;
}

export function collectResultRefs(result, batchIndex) {
  const keys = new Set();
  const topics = result?.session_topics ?? {};
  for (const section of ['topics', 'disputes', 'highlights']) {
    for (const item of Array.isArray(topics[section]) ? topics[section] : []) {
      for (const ref of qualifyRefs(item?.message_refs, batchIndex)) {
        keys.add(refKey(ref.batch, ref.seq));
      }
    }
  }
  return keys;
}

export function resultIsReportable(result) {
  const topics = result?.session_topics ?? {};
  return Boolean(
    (Array.isArray(topics.topics) && topics.topics.length > 0)
    || (Array.isArray(topics.sentiment) && topics.sentiment.length > 0)
    || (Array.isArray(topics.disputes) && topics.disputes.length > 0)
    || (Array.isArray(topics.highlights) && topics.highlights.length > 0)
    || (typeof topics.summary === 'string' && topics.summary.trim() !== '')
  );
}

export function digestIsReportable(digest) {
  return resultIsReportable(digest);
}

export function collectDigestRefs(digest) {
  const keys = new Set();
  const topics = digest?.session_topics ?? {};
  for (const section of ['topics', 'disputes', 'highlights']) {
    for (const item of Array.isArray(topics[section]) ? topics[section] : []) {
      for (const ref of qualifyRefs(item?.message_refs, null)) {
        keys.add(refKey(ref.batch, ref.seq));
      }
    }
  }
  return keys;
}

/** Whether a digest/report item's time overlaps a batch coverage window. */
function itemOverlaps(item, meta) {
  if (!meta || meta.fromAt === null || meta.toAt === null) return false;
  const start = Date.parse(iso(item?.started_at) ?? '');
  const end = Date.parse(iso(item?.ended_at ?? item?.started_at) ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end >= Number(meta.fromAt) && start <= Number(meta.toAt);
}

function reportableItems(digest) {
  const topics = digest?.session_topics ?? {};
  return [
    ...(Array.isArray(topics.topics) ? topics.topics : []),
    ...(Array.isArray(topics.disputes) ? topics.disputes : []),
    ...(Array.isArray(topics.highlights) ? topics.highlights : [])
  ];
}

/**
 * Deterministic batch coverage.
 *
 * A reportable batch is covered only when:
 *   - an item cites one of its validated evidence seqs, or
 *   - the batch had no usable evidence in its validated result, and an item's
 *     time range overlaps the batch window.
 * The second rule never invents a ref; it only proves the slice was not
 * silently skipped when there was nothing citable.
 */
export function checkBatchCoverage({
  digest,
  batchBatches = [],
  batchMeta = new Map(),
  reportable = new Map(),
  validRefs = new Map()
} = {}) {
  const wanted = uniqueIntegers(batchBatches);
  const cited = collectDigestRefs(digest);
  const items = reportableItems(digest);
  const missing = [];
  const byBatch = {};
  for (const batch of wanted) {
    const meta = batchMeta.get(batch) ?? null;
    const refs = validRefs.get(batch) ?? new Set();
    let covered = false;
    let reason = null;
    if (refs.size > 0) {
      for (const key of cited) {
        const ref = parseRefKey(key);
        if (ref?.batch === batch && refs.has(key)) {
          covered = true;
          break;
        }
      }
      reason = covered ? 'evidence' : 'no-evidence-ref';
    } else {
      covered = items.some((item) => itemOverlaps(item, meta));
      reason = covered ? 'time-window' : 'no-time-overlap';
    }
    // A batch with no reportable content needs no representation beyond the
    // covered_batches ledger; it is not "dropped" because there was nothing to
    // report.
    if (!reportable.get(batch) && refs.size === 0) {
      covered = true;
      reason = 'empty-batch';
    }
    byBatch[batch] = {covered, reason};
    if (!covered) missing.push(batch);
  }
  return {ok: missing.length === 0, missing, byBatch, cited: [...cited].sort()};
}

/**
 * Coverage at the unit we actually merged.
 *
 * Leaf nodes cover batches one by one; higher-level nodes and the final report
 * cover child partial-summary units. Requiring every batch to be cited in the
 * final 4-ref topics would make large sessions impossible for a bounded schema
 * even though every batch was correctly summarized at the lower level. This
 * check therefore proves that every *unit* is represented, while each unit's
 * own digest was already checked batch-by-batch when it was created.
 */
export function checkUnitCoverage({
  digest,
  units = [],
  batchMeta = new Map(),
  reportable = new Map(),
  validRefs = new Map()
} = {}) {
  const cited = collectDigestRefs(digest);
  const items = reportableItems(digest);
  const missing = [];
  const byUnit = [];
  for (const unit of units) {
    const batches = uniqueIntegers(unit);
    if (batches.length === 0) continue;
    const unitSet = new Set(batches);
    const anyReportable = batches.some((batch) => reportable.get(batch) === true);
    if (!anyReportable) {
      byUnit.push({batches, covered: true, reason: 'empty-unit'});
      continue;
    }
    let covered = [...cited].some((key) => {
      const ref = parseRefKey(key);
      return ref && unitSet.has(ref.batch) && (validRefs.get(ref.batch)?.has(key) ?? false);
    });
    let reason = covered ? 'evidence' : 'no-evidence-ref';
    if (!covered && batches.every((batch) => (validRefs.get(batch)?.size ?? 0) === 0)) {
      covered = items.some((item) => batches.some((batch) => itemOverlaps(item, batchMeta.get(batch))));
      reason = covered ? 'time-window' : 'no-time-overlap';
    }
    byUnit.push({batches, covered, reason});
    if (!covered) missing.push(...batches);
  }
  return {ok: missing.length === 0, missing, byUnit, cited: [...cited].sort()};
}

export function groupBatchesContiguously(items, {budgetTokens, fixedOverhead = 0, maxItems = null} = {}) {
  const budget = Math.max(1000, Number(budgetTokens) || 0);
  const overhead = Math.max(0, Number(fixedOverhead) || 0);
  const itemLimit = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0
    ? Math.floor(Number(maxItems))
    : Number.POSITIVE_INFINITY;
  const groups = [];
  let current = [];
  let used = 0;
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    used = 0;
  };
  for (const item of items ?? []) {
    const cost = Math.max(1, Number(item?.tokens) || 1);
    const wouldOverflow = current.length > 0
      && (overhead + used + cost > budget || current.length >= itemLimit);
    if (wouldOverflow) flush();
    current.push(item);
    used += cost;
  }
  flush();
  return groups;
}

export function splitGroup(items) {
  if (!Array.isArray(items) || items.length < 2) return null;
  const middle = Math.ceil(items.length / 2);
  return [items.slice(0, middle), items.slice(middle)];
}

export function groupSourceHash({
  kind,
  level,
  sources,
  planVersion = AGGREGATE_PLAN_VERSION
} = {}) {
  const payload = JSON.stringify({
    kind,
    level,
    planVersion,
    sources: (sources ?? []).map((source) => String(source))
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function digestHash(digest) {
  return createHash('sha256').update(canonicalJson(digest), 'utf8').digest('hex');
}

/** Canonical JSON (sorted keys) for stable node reuse. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function normalizeKeyPoint(value, maxChars) {
  const text = string(value, maxChars).trim();
  return text === '' ? null : text;
}

function normalizeTopic(item, {limits, allowedRefs, fallbackTime, batchIndex = null}) {
  if (!item || typeof item !== 'object') return null;
  const title = string(item.title, 120).trim();
  if (title === '') return null;
  const started = iso(item.started_at, fallbackTime);
  const ended = iso(item.ended_at, started);
  if (!started || !ended) return null;
  const refs = qualifyRefs(item.message_refs, batchIndex)
    .filter((ref) => !allowedRefs || allowedRefs.has(refKey(ref.batch, ref.seq)));
  return {
    title,
    started_at: started,
    ended_at: Date.parse(ended) < Date.parse(started) ? started : ended,
    summary: string(item.summary, limits.topicSummaryChars),
    key_points: (Array.isArray(item.key_points) ? item.key_points : [])
      .map((point) => normalizeKeyPoint(point, limits.keyPointChars))
      .filter(Boolean)
      .slice(0, limits.keyPoints),
    confidence: clamp(Number(item.confidence), 0, 1) || 0,
    evidence: item.evidence === 'inferred' ? 'inferred' : 'observed',
    ...(refs.length > 0 ? {message_refs: refs.slice(0, limits.messageRefs)} : {})
  };
}

function normalizeSentiment(item, {limits, fallbackTime}) {
  if (!item || typeof item !== 'object') return null;
  const at = iso(item.at, fallbackTime);
  if (!at) return null;
  const tone = ['positive', 'neutral', 'negative', 'mixed'].includes(item.tone)
    ? item.tone
    : 'neutral';
  return {
    at,
    tone,
    note: string(item.note, limits.noteChars ?? 180),
    confidence: clamp(Number(item.confidence), 0, 1) || 0,
    ...(Number.isFinite(Number(item.sample_size))
      ? {sample_size: clamp(Math.trunc(Number(item.sample_size)), 0, 100000)}
      : {}),
    ...(typeof item.evidence_note === 'string'
      ? {evidence_note: string(item.evidence_note, 160)}
      : {})
  };
}

function normalizeDispute(item, {limits, allowedRefs, fallbackTime, batchIndex = null}) {
  if (!item || typeof item !== 'object') return null;
  const started = iso(item.started_at, fallbackTime);
  if (!started) return null;
  const ended = item.ended_at ? iso(item.ended_at, started) : null;
  const refs = qualifyRefs(item.message_refs, batchIndex)
    .filter((ref) => !allowedRefs || allowedRefs.has(refKey(ref.batch, ref.seq)));
  return {
    summary: string(item.summary, limits.topicSummaryChars),
    ...(typeof item.title === 'string' && item.title.trim() !== ''
      ? {title: string(item.title, 120)}
      : {}),
    started_at: started,
    ...(ended ? {ended_at: Date.parse(ended) < Date.parse(started) ? started : ended} : {}),
    note: string(item.note, limits.topicSummaryChars),
    ...(Array.isArray(item.viewpoints)
      ? {
        viewpoints: item.viewpoints
          .map((point) => normalizeKeyPoint(point, limits.keyPointChars))
          .filter(Boolean)
          .slice(0, 4)
      }
      : {}),
    confidence: clamp(Number(item.confidence), 0, 1) || 0,
    evidence: item.evidence === 'inferred' ? 'inferred' : 'observed',
    ...(refs.length > 0 ? {message_refs: refs.slice(0, limits.messageRefs)} : {})
  };
}

function normalizeHighlight(item, {limits, allowedRefs, fallbackTime, batchIndex = null}) {
  if (!item || typeof item !== 'object') return null;
  const started = iso(item.started_at, fallbackTime);
  if (!started) return null;
  const ended = iso(item.ended_at, started);
  if (!ended) return null;
  const refs = qualifyRefs(item.message_refs, batchIndex)
    .filter((ref) => !allowedRefs || allowedRefs.has(refKey(ref.batch, ref.seq)));
  return {
    started_at: started,
    ended_at: Date.parse(ended) < Date.parse(started) ? started : ended,
    ...(typeof item.title === 'string' && item.title.trim() !== ''
      ? {title: string(item.title, 120)}
      : {}),
    reason: string(item.reason, limits.topicSummaryChars),
    clip_suggestion: string(item.clip_suggestion, limits.topicSummaryChars + 40),
    ...(Number.isFinite(Number(item.confidence))
      ? {confidence: clamp(Number(item.confidence), 0, 1)}
      : {}),
    evidence: item.evidence === 'inferred' ? 'inferred' : 'observed',
    ...(refs.length > 0 ? {message_refs: refs.slice(0, limits.messageRefs)} : {})
  };
}

function sortTopics(items) {
  return [...items].sort((a, b) => (
    Date.parse(a.started_at) - Date.parse(b.started_at)
    || String(a.title).localeCompare(String(b.title))
  ));
}

function sortTimed(items) {
  return [...items].sort((a, b) => (
    Date.parse(a.started_at ?? a.at) - Date.parse(b.started_at ?? b.at)
  ));
}

function topicKey(item) {
  const minute = Math.floor(Date.parse(item.started_at) / 60000);
  return `${String(item.title).trim().toLowerCase()}|${minute}`;
}

function mergeTopic(target, item) {
  const keyPoints = [...(target.key_points ?? [])];
  for (const point of item.key_points ?? []) {
    if (!keyPoints.includes(point) && keyPoints.length < 8) keyPoints.push(point);
  }
  // Keep at most one evidence ref per batch when merging. A bucket that covers
  // six batches should need six refs, not every ref of every original item;
  // this is what keeps a bounded digest able to cite every batch.
  const refs = [];
  const seenBatches = new Set();
  for (const ref of [...(target.message_refs ?? []), ...(item.message_refs ?? [])]) {
    if (seenBatches.has(ref.batch)) continue;
    seenBatches.add(ref.batch);
    refs.push(ref);
  }
  return {
    ...target,
    started_at: Date.parse(item.started_at) < Date.parse(target.started_at)
      ? item.started_at : target.started_at,
    ended_at: Date.parse(item.ended_at) > Date.parse(target.ended_at)
      ? item.ended_at : target.ended_at,
    summary: item.summary.length > target.summary.length ? item.summary : target.summary,
    key_points: keyPoints,
    confidence: Math.max(Number(target.confidence ?? 0), Number(item.confidence ?? 0)),
    evidence: target.evidence === 'observed' || item.evidence === 'observed' ? 'observed' : 'inferred',
    ...(refs.length > 0 ? {message_refs: refs} : {})
  };
}

function dedupeTopics(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = topicKey(item);
    const current = byKey.get(key);
    byKey.set(key, current ? mergeTopic(current, item) : item);
  }
  return sortTopics([...byKey.values()]);
}

function splitWideTopics(items, maxRefs) {
  const limit = Number(maxRefs);
  if (!Number.isFinite(limit) || limit < 1) return items;
  const out = [];
  for (const item of items) {
    const refs = Array.isArray(item.message_refs) ? item.message_refs : [];
    if (refs.length <= limit) {
      out.push(item);
      continue;
    }
    for (let start = 0; start < refs.length; start += limit) {
      const index = start / limit;
      out.push({
        ...item,
        title: index === 0
          ? item.title
          : `${String(item.title).slice(0, 112)} (${index + 1})`,
        message_refs: refs.slice(start, start + limit)
      });
    }
  }
  return out;
}

function bucketAndMerge(items, cap, merge, {maxRefs = null} = {}) {
  const sorted = [...items];
  if (sorted.length <= cap) return maxRefs ? splitWideTopics(sorted, maxRefs) : sorted;
  const buckets = Array.from({length: cap}, () => []);
  for (let index = 0; index < sorted.length; index += 1) {
    const target = Math.min(cap - 1, Math.floor((index * cap) / sorted.length));
    buckets[target].push(sorted[index]);
  }
  const merged = buckets.filter((bucket) => bucket.length > 0).map(merge);
  return maxRefs ? splitWideTopics(merged, maxRefs) : merged;
}

function mergeTopicBucket(bucket) {
  return bucket.reduce((merged, item) => mergeTopic(merged, item));
}

function mergeHighlightBucket(bucket) {
  const first = bucket[0];
  const refs = [];
  const seenBatches = new Set();
  for (const item of bucket) {
    for (const ref of item.message_refs ?? []) {
      if (seenBatches.has(ref.batch)) continue;
      seenBatches.add(ref.batch);
      refs.push(ref);
    }
  }
  return {
    ...first,
    title: bucket.length > 1
      ? `${first.title ?? first.reason} / ${bucket.slice(1).map((item) => item.title ?? item.reason).join(' / ')}`.slice(0, 120)
      : first.title,
    reason: bucket.map((item) => item.reason).filter(Boolean).join(' ').slice(0, 300),
    clip_suggestion: first.clip_suggestion,
    confidence: Math.max(...bucket.map((item) => Number(item.confidence ?? 0))),
    evidence: bucket.some((item) => item.evidence === 'observed') ? 'observed' : 'inferred',
    ...(refs.length > 0 ? {message_refs: refs.slice(0, 6)} : {})
  };
}

function mergeDisputeBucket(bucket) {
  const first = bucket[0];
  const refs = [];
  const seenBatches = new Set();
  const viewpoints = [];
  for (const item of bucket) {
    for (const ref of item.message_refs ?? []) {
      if (seenBatches.has(ref.batch)) continue;
      seenBatches.add(ref.batch);
      refs.push(ref);
    }
    for (const point of item.viewpoints ?? []) {
      if (!viewpoints.includes(point) && viewpoints.length < 4) viewpoints.push(point);
    }
  }
  return {
    ...first,
    title: bucket.length > 1
      ? `${first.title ?? first.summary} / ${bucket.slice(1).map((item) => item.title ?? item.summary).join(' / ')}`.slice(0, 120)
      : first.title,
    summary: bucket.map((item) => item.summary).filter(Boolean).join(' ').slice(0, 300),
    note: first.note,
    viewpoints,
    evidence: bucket.some((item) => item.evidence === 'observed') ? 'observed' : 'inferred',
    ...(refs.length > 0 ? {message_refs: refs.slice(0, 6)} : {})
  };
}

function mergeSentimentBucket(bucket) {
  const first = bucket[0];
  return {
    at: first.at,
    tone: first.tone,
    note: bucket.map((item) => item.note).filter(Boolean).join(' ').slice(0, 240),
    confidence: Math.max(...bucket.map((item) => Number(item.confidence ?? 0))),
    ...(bucket.some((item) => Number.isFinite(Number(item.sample_size)))
      ? {sample_size: clamp(bucket.reduce((sum, item) => sum + Number(item.sample_size ?? 0), 0), 0, 100000)}
      : {}),
    ...(bucket.some((item) => typeof item.evidence_note === 'string')
      ? {evidence_note: bucket.map((item) => item.evidence_note).filter(Boolean).join(' ').slice(0, 160)}
      : {})
  };
}

function normalizeSections(answer, {limits, allowedRefs, fallbackTime}) {
  const topics = dedupeTopics((Array.isArray(answer?.topics) ? answer.topics : [])
    .map((item) => normalizeTopic(item, {limits, allowedRefs, fallbackTime}))
    .filter(Boolean));
  const sentiment = sortTimed((Array.isArray(answer?.sentiment) ? answer.sentiment : [])
    .map((item) => normalizeSentiment(item, {limits, fallbackTime}))
    .filter(Boolean));
  const disputes = sortTimed((Array.isArray(answer?.disputes) ? answer.disputes : [])
    .map((item) => normalizeDispute(item, {limits, allowedRefs, fallbackTime}))
    .filter(Boolean));
  const highlights = sortTimed((Array.isArray(answer?.highlights) ? answer.highlights : [])
    .map((item) => normalizeHighlight(item, {limits, allowedRefs, fallbackTime}))
    .filter(Boolean));
  return {
    summary: string(answer?.summary, limits.summaryChars),
    topics: bucketAndMerge(topics, limits.topics, mergeTopicBucket, {maxRefs: limits.messageRefs}),
    sentiment: bucketAndMerge(sentiment, limits.sentiment, mergeSentimentBucket),
    disputes: bucketAndMerge(disputes, limits.disputes, mergeDisputeBucket),
    highlights: bucketAndMerge(highlights, limits.highlights, mergeHighlightBucket)
  };
}

export function normalizeDigestAnswer(answer, {
  groupBatches,
  units = null,
  batchMeta = new Map(),
  reportable = new Map(),
  validRefs = new Map(),
  limits = DIGEST_AGGREGATE_LIMITS,
  fallbackTime = null
} = {}) {
  const wanted = uniqueIntegers(groupBatches);
  const declared = Array.isArray(answer?.covered_batches)
    ? uniqueIntegers(answer.covered_batches)
    : [];
  const coveredOk = declared.length === wanted.length
    && declared.every((batch, index) => batch === wanted[index]);
  const sessionTopics = normalizeSections(answer?.session_topics, {
    limits,
    allowedRefs: new Set([...validRefs.values()].flatMap((set) => [...set])),
    fallbackTime
  });
  const digest = {
    covered_batches: wanted,
    session_topics: sessionTopics
  };
  const coverageUnits = Array.isArray(units) && units.length > 0
    ? units
    : wanted.map((batch) => [batch]);
  const coverage = checkUnitCoverage({
    digest,
    units: coverageUnits,
    batchMeta,
    reportable,
    validRefs
  });
  const issues = [];
  if (!coveredOk) {
    issues.push({
      path: 'covered_batches',
      code: 'AGGREGATE_COVERAGE_INCOMPLETE',
      params: {expected: wanted.join(','), actual: declared.join(',')}
    });
  }
  if (!coverage.ok) {
    issues.push({
      path: 'session_topics',
      code: 'AGGREGATE_COVERAGE_INCOMPLETE',
      params: {missing: coverage.missing.join(',')}
    });
  }
  return {
    ok: issues.length === 0,
    digest,
    issues,
    coverage,
    declaredCovered: declared
  };
}

/**
 * Deterministic partial summary from already validated batch results.
 *
 * This is used only after the bounded AI retry for one node still cannot
 * produce a complete/valid answer. It never invents evidence and never drops a
 * reportable batch: all refs from every batch are merged, and a batch with no
 * citable evidence gets an explicit inferred coverage topic with no refs.
 */
export function deterministicDigest({
  batchEntries,
  groupBatches,
  limits = DIGEST_AGGREGATE_LIMITS,
  fallbackTime = null
} = {}) {
  const wanted = uniqueIntegers(groupBatches);
  const byBatch = new Map((batchEntries ?? []).map((entry) => [Number(entry.batchIndex), entry]));
  const topics = [];
  const sentiment = [];
  const disputes = [];
  const highlights = [];
  const summaries = [];
  const perBatchTopicQuota = Math.max(
    1,
    Math.floor((limits.topics * limits.messageRefs) / Math.max(1, wanted.length))
  );
  for (const batch of wanted) {
    const entry = byBatch.get(batch);
    const source = entry?.result?.session_topics ?? {};
    if (typeof source.summary === 'string' && source.summary.trim() !== '') {
      summaries.push(source.summary.trim());
    }
    const allowedRefs = entry?.validRefs ?? new Set();
    const fallback = entry?.fromAt ? new Date(entry.fromAt).toISOString() : fallbackTime;
    for (const item of (Array.isArray(source.topics) ? source.topics : []).slice(0, perBatchTopicQuota)) {
      const normalized = normalizeTopic(item, {limits, allowedRefs, fallbackTime: fallback, batchIndex: batch});
      if (normalized) topics.push(normalized);
    }
    for (const item of Array.isArray(source.sentiment) ? source.sentiment : []) {
      const normalized = normalizeSentiment(item, {limits, fallbackTime: fallback});
      if (normalized) sentiment.push(normalized);
    }
    for (const item of Array.isArray(source.disputes) ? source.disputes : []) {
      const normalized = normalizeDispute(item, {limits, allowedRefs, fallbackTime: fallback, batchIndex: batch});
      if (normalized) disputes.push(normalized);
    }
    for (const item of Array.isArray(source.highlights) ? source.highlights : []) {
      const normalized = normalizeHighlight(item, {limits, allowedRefs, fallbackTime: fallback, batchIndex: batch});
      if (normalized) highlights.push(normalized);
    }
  }
  const mergedTopics = bucketAndMerge(dedupeTopics(topics), limits.topics, mergeTopicBucket, {maxRefs: limits.messageRefs});
  // Guarantee at least one time-bearing item for every reportable batch that
  // has no citable evidence, so coverage does not depend on a hallucinated ref.
  const coverageRefs = new Set();
  for (const item of [...mergedTopics, ...disputes, ...highlights]) {
    for (const ref of item.message_refs ?? []) coverageRefs.add(refKey(ref.batch, ref.seq));
  }
  for (const batch of wanted) {
    const entry = byBatch.get(batch);
    if (!entry?.reportable) continue;
    if ([...coverageRefs].some((key) => parseRefKey(key)?.batch === batch)) continue;
    const from = entry.fromAt ? new Date(entry.fromAt).toISOString() : fallbackTime;
    const to = entry.toAt ? new Date(entry.toAt).toISOString() : from;
    if (!from || !to) continue;
    const summary = entry.result?.session_topics?.summary ?? '';
    mergedTopics.push({
      title: `Batch ${batch}`,
      started_at: from,
      ended_at: to,
      summary: String(summary).slice(0, limits.topicSummaryChars),
      key_points: [],
      confidence: 0.4,
      evidence: 'inferred'
    });
  }
  return {
    covered_batches: wanted,
    session_topics: {
      summary: summaries.join(' ').slice(0, limits.summaryChars),
      topics: sortTopics(bucketAndMerge(mergedTopics, limits.topics, mergeTopicBucket, {maxRefs: limits.messageRefs})),
      sentiment: bucketAndMerge(sortTimed(sentiment), limits.sentiment, mergeSentimentBucket),
      disputes: bucketAndMerge(sortTimed(disputes), limits.disputes, mergeDisputeBucket),
      highlights: bucketAndMerge(sortTimed(highlights), limits.highlights, mergeHighlightBucket)
    }
  };
}

export function normalizeFinalAnswer(answer, {
  allBatches,
  units = null,
  batchMeta = new Map(),
  reportable = new Map(),
  validRefs = new Map(),
  limits = null,
  fallbackTime = null
} = {}) {
  const wanted = uniqueIntegers(allBatches);
  const finalLimits = limits ?? FINAL_AGGREGATE_LIMITS;
  const declared = Array.isArray(answer?.covered_batches)
    ? uniqueIntegers(answer.covered_batches) : [];
  const sessionTopics = normalizeSections(answer?.session_topics, {
    limits: finalLimits,
    allowedRefs: new Set([...validRefs.values()].flatMap((set) => [...set])),
    fallbackTime
  });
  const digest = {
    covered_batches: wanted,
    session_topics: sessionTopics
  };
  const coverageUnits = Array.isArray(units) && units.length > 0
    ? units
    : wanted.map((batch) => [batch]);
  const coverage = checkUnitCoverage({
    digest,
    units: coverageUnits,
    batchMeta,
    reportable,
    validRefs
  });
  const issues = [];
  if (declared.length > 0
    && (declared.length !== wanted.length || declared.some((batch, index) => batch !== wanted[index]))) {
    issues.push({
      path: 'covered_batches',
      code: 'AGGREGATE_COVERAGE_INCOMPLETE',
      params: {expected: wanted.join(','), actual: declared.join(',')}
    });
  }
  if (!coverage.ok) {
    issues.push({
      path: 'session_topics',
      code: 'AGGREGATE_COVERAGE_INCOMPLETE',
      params: {missing: coverage.missing.join(',')}
    });
  }
  return {
    ok: issues.length === 0,
    envelope: digest,
    issues,
    coverage,
    declaredCovered: declared
  };
}

/**
 * Deterministic final report from partial summaries. Used only when the final
 * synthesis request is still truncated/invalid after its bounded retry. It
 * preserves every reportable batch and every valid evidence ref; the caps are
 * the same bounded schema used by the AI answer.
 */
export function deterministicFinal({
  childDigests,
  allBatches,
  batchEntries = [],
  resultSchema,
  limits = null,
  fallbackTime = null
} = {}) {
  const wanted = uniqueIntegers(allBatches);
  const finalLimits = limits ?? FINAL_AGGREGATE_LIMITS;
  const byBatch = new Map((batchEntries ?? []).map((entry) => [Number(entry.batchIndex), entry]));
  const units = (childDigests ?? []).map((digest, index) => ({
    digest,
    index,
    batches: uniqueIntegers(digest?.covered_batches)
  }));
  if (units.length === 0) {
    units.push({
      digest: {covered_batches: wanted, session_topics: {summary: '', topics: [], sentiment: [], disputes: [], highlights: []}},
      index: 0,
      batches: wanted
    });
  }
  const unitCount = Math.max(1, units.length);
  const preserveAllBatches = units.length === 1;
  const perUnitTopics = preserveAllBatches
    ? finalLimits.topics
    : Math.max(1, Math.floor(finalLimits.topics / unitCount));
  const perUnitSentiment = Math.max(1, Math.floor(finalLimits.sentiment / unitCount));
  const perUnitDisputes = Math.max(1, Math.floor(finalLimits.disputes / unitCount));
  const perUnitHighlights = Math.max(1, Math.floor(finalLimits.highlights / unitCount));
  const topics = [];
  const sentiment = [];
  const disputes = [];
  const highlights = [];
  const summaries = [];
  const titleKeys = new Set();
  const addUniqueTopics = (items) => {
    for (const topic of dedupeTopics(items)) {
      const key = topicKey(topic);
      if (titleKeys.has(key)) {
        topic.title = `${topic.title.slice(0, 112)} [${topics.length + 1}]`;
      }
      titleKeys.add(topicKey(topic));
      topics.push(topic);
    }
  };
  for (const unit of units) {
    const source = unit.digest?.session_topics ?? {};
    if (typeof source.summary === 'string' && source.summary.trim() !== '') {
      summaries.push(source.summary.trim());
    }
    const wideLimits = {...finalLimits, messageRefs: MAX_DIGEST_UNITS};
    const unitTopics = splitWideTopics(
      (Array.isArray(source.topics) ? source.topics : [])
        .map((item) => normalizeTopic(item, {limits: wideLimits, fallbackTime}))
        .filter(Boolean),
      finalLimits.messageRefs
    ).slice(0, perUnitTopics);
    if (unitTopics.length === 0) {
      const entry = byBatch.get(unit.batches[0]);
      if (entry?.reportable) {
        const from = entry.fromAt ? new Date(entry.fromAt).toISOString() : fallbackTime;
        const to = entry.toAt ? new Date(entry.toAt).toISOString() : from;
        if (from && to) {
          const refs = [...(entry.validRefs ?? [])].slice(0, finalLimits.messageRefs)
            .map(parseRefKey).filter(Boolean);
          unitTopics.push({
            title: `Segment ${unit.index + 1}`,
            started_at: from,
            ended_at: to,
            summary: String(entry.result?.session_topics?.summary ?? '').slice(0, finalLimits.topicSummaryChars),
            key_points: [],
            confidence: 0.4,
            evidence: refs.length > 0 ? 'observed' : 'inferred',
            ...(refs.length > 0 ? {message_refs: refs} : {})
          });
        }
      }
    }
    addUniqueTopics(unitTopics);
    for (const item of (Array.isArray(source.sentiment) ? source.sentiment : []).slice(0, perUnitSentiment)) {
      const normalized = normalizeSentiment(item, {limits: finalLimits, fallbackTime});
      if (normalized) sentiment.push(normalized);
    }
    for (const item of (Array.isArray(source.disputes) ? source.disputes : []).slice(0, perUnitDisputes)) {
      const normalized = normalizeDispute(item, {limits: finalLimits, fallbackTime});
      if (normalized) disputes.push(normalized);
    }
    for (const item of (Array.isArray(source.highlights) ? source.highlights : []).slice(0, perUnitHighlights)) {
      const normalized = normalizeHighlight(item, {limits: finalLimits, fallbackTime});
      if (normalized) highlights.push(normalized);
    }
  }
  // If a unit still has no citable evidence (for example a summary-only batch),
  // add one honest coverage topic for it. No ref is fabricated.
  const citedBatches = new Set(topics.flatMap((topic) => (topic.message_refs ?? []).map((ref) => ref.batch)));
  for (const unit of units) {
    const missing = unit.batches.filter((batch) => byBatch.get(batch)?.reportable && !citedBatches.has(batch));
    if (missing.length === 0 || topics.length >= finalLimits.topics) continue;
    const entry = byBatch.get(missing[0]);
    const from = entry?.fromAt ? new Date(entry.fromAt).toISOString() : fallbackTime;
    const to = entry?.toAt ? new Date(entry.toAt).toISOString() : from;
    if (!from || !to) continue;
    topics.push({
      title: `Coverage ${missing[0]}`,
      started_at: from,
      ended_at: to,
      summary: String(entry?.result?.session_topics?.summary ?? '').slice(0, finalLimits.topicSummaryChars),
      key_points: [],
      confidence: 0.4,
      evidence: 'inferred'
    });
  }
  return {
    covered_batches: wanted,
    session_topics: {
      summary: summaries.join(' ').slice(0, finalLimits.summaryChars),
      topics: sortTopics(topics).slice(0, finalLimits.topics),
      sentiment: sortTimed(sentiment).slice(0, finalLimits.sentiment),
      disputes: sortTimed(disputes).slice(0, finalLimits.disputes),
      highlights: sortTimed(highlights).slice(0, finalLimits.highlights)
    }
  };
}

export function schemaIssuesFor(value, schema) {
  return validateAgainstSchema(schema, value);
}

/**
 * Add only already-validated evidence refs to a final report.
 *
 * A model can describe a batch but cite a seq that was never in that batch's
 * validated result; the normalizer drops such a ref. Dropping a fabricated ref
 * is correct, but it must not leave the final report looking as if a later
 * batch was ignored. For sessions small enough that every batch fits the final
 * ref budget (24 topics x 6 refs), this deterministic pass attaches one real
 * ref per uncovered reportable batch from the persisted batch/partial results.
 * It never invents a ref and never alters the model's prose.
 */
export function ensureFinalBatchEvidence({
  envelope,
  allBatches,
  batchEntries = [],
  nodes = [],
  maxRefsPerTopic = 4,
  maxTopics = 24
} = {}) {
  const batches = uniqueIntegers(allBatches);
  if (batches.length > maxTopics * maxRefsPerTopic) return envelope;
  const byBatch = new Map((batchEntries ?? []).map((entry) => [Number(entry.batchIndex), entry]));
  const validRef = new Map();
  for (const node of nodes ?? []) {
    for (const item of reportableItems(node.digest)) {
      for (const ref of item.message_refs ?? []) {
        if (!validRef.has(ref.batch)) validRef.set(ref.batch, ref);
      }
    }
  }
  for (const entry of batchEntries ?? []) {
    if (validRef.has(entry.batchIndex)) continue;
    const first = [...(entry.validRefs ?? [])].sort()[0];
    const parsed = first ? parseRefKey(first) : null;
    if (parsed) validRef.set(entry.batchIndex, parsed);
  }
  const topics = Array.isArray(envelope?.session_topics?.topics)
    ? envelope.session_topics.topics
    : [];
  const cited = new Set(topics.flatMap((topic) => (topic.message_refs ?? []).map((ref) => ref.batch)));
  const missing = batches.filter((batch) => (
    byBatch.get(batch)?.reportable === true
    && !cited.has(batch)
    && validRef.has(batch)
  ));
  if (missing.length === 0) return envelope;
  for (const batch of missing) {
    const entry = byBatch.get(batch);
    const from = entry?.fromAt ? new Date(entry.fromAt).toISOString() : null;
    const to = entry?.toAt ? new Date(entry.toAt).toISOString() : from;
    const fromMs = from ? Date.parse(from) : NaN;
    const toMs = to ? Date.parse(to) : NaN;
    let topic = topics.find((candidate) => {
      if ((candidate.message_refs ?? []).length >= maxRefsPerTopic) return false;
      const start = Date.parse(candidate.started_at ?? '');
      const end = Date.parse(candidate.ended_at ?? candidate.started_at ?? '');
      return Number.isFinite(fromMs) && Number.isFinite(toMs)
        && Number.isFinite(start) && Number.isFinite(end)
        && end >= fromMs && start <= toMs;
    });
    if (!topic) {
      topic = topics.find((candidate) => (candidate.message_refs ?? []).length < maxRefsPerTopic);
    }
    if (!topic && topics.length < maxTopics && from && to) {
      topic = {
        title: `Coverage ${batch}`,
        started_at: from,
        ended_at: to,
        summary: String(entry?.result?.session_topics?.summary ?? '').slice(0, 300),
        key_points: [],
        confidence: 0.4,
        evidence: 'inferred',
        message_refs: []
      };
      topics.push(topic);
    }
    if (!topic) continue;
    topic.message_refs = [...(topic.message_refs ?? []), validRef.get(batch)]
      .slice(0, maxRefsPerTopic);
    cited.add(batch);
  }
  envelope.session_topics.topics = topics;
  return envelope;
}

export function digestSchema(resultSchema, {limits = DIGEST_AGGREGATE_LIMITS} = {}) {
  return buildAggregateDigestSchema(resultSchema, {limits});
}

export function finalEnvelopeSchema(resultSchema, {limits = null} = {}) {
  return buildAggregateFinalEnvelopeSchema(resultSchema, {limits});
}

/** Data block for the final prompt: bounded partial reports, never raw chat. */
export function partialReportsForPrompt(nodes) {
  return (nodes ?? []).map((node) => ({
    node_id: node.id,
    level: Number(node.level),
    covered_batches: uniqueIntegers(node.coveredBatches),
    session_topics: node.digest?.session_topics ?? {}
  }));
}

export function coverageLedger({batchEntries = [], nodes = [], batchTotal = 0} = {}) {
  const byBatch = new Map((batchEntries ?? []).map((entry) => [Number(entry.batchIndex), entry]));
  const lines = [];
  for (let batch = 1; batch <= Number(batchTotal); batch += 1) {
    const entry = byBatch.get(batch);
    if (!entry) continue;
    const coveredBy = (nodes ?? [])
      .filter((node) => node.coveredBatches?.includes(batch))
      .map((node) => node.id);
    lines.push({
      batch,
      from_seq: entry.fromSeq,
      to_seq: entry.toSeq,
      messages: entry.messageCount,
      from_at: entry.fromAt ? new Date(entry.fromAt).toISOString() : null,
      to_at: entry.toAt ? new Date(entry.toAt).toISOString() : null,
      reportable: entry.reportable === true,
      partial_nodes: coveredBy
    });
  }
  return lines;
}

export function estimateDigestTokens(digest) {
  return estimateJsonTokens(digest);
}

export function estimatePromptTokens(text) {
  return estimateTokens(text);
}

export const __internal = {
  uniqueIntegers,
  normalizeTopic,
  normalizeSentiment,
  normalizeDispute,
  normalizeHighlight,
  dedupeTopics,
  bucketAndMerge,
  mergeTopicBucket,
  itemOverlaps,
  reportableItems,
  TIGHT_AGGREGATE_LIMITS
};
