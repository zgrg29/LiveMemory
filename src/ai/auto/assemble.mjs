/**
 * Compact automatic-analysis answer format.
 *
 * The anonymous free models are bad at mechanical bookkeeping: they copy
 * 24-character viewer ids, they confuse viewers that appear in
 * `viewer_context.json` but belong to another memory batch, and they silently
 * drop low-activity viewers. LiveMemory already knows every stable viewer id and
 * every assigned excerpt, so the automatic prompt asks only for the semantic
 * work, keyed by a small local `ref` number:
 *
 *   {"session_topics": {...}, "viewers": [{"ref": 1, "memory": {...}, "profile": {...}}]}
 *
 * `assembleCompactAnswer()` maps each ref back to the exact stable id from the
 * batch assignment table. It never guesses, fuzzy-matches or merges an identity;
 * an unknown, duplicate or missing ref is a hard error. The assembled object is
 * then validated by the *same* `validateAnalysisImport()` as a pasted answer.
 */

export const COMPACT_ANSWER_FORMAT = 'livememory-auto-answer-v1';

export const COMPACT_ISSUE = Object.freeze({
  ANSWER_REQUIRED: 'ANSWER_REQUIRED',
  TOPICS_REQUIRED: 'TOPICS_REQUIRED',
  VIEWERS_REQUIRED: 'VIEWERS_REQUIRED',
  REF_INVALID: 'REF_INVALID',
  REF_DUPLICATE: 'REF_DUPLICATE',
  REF_UNKNOWN: 'REF_UNKNOWN',
  REF_MISSING: 'REF_MISSING',
  MEMORY_REQUIRED: 'MEMORY_REQUIRED',
  PROFILE_INVALID: 'PROFILE_INVALID'
});

function issue(path, code, params = {}) {
  return {path, code, params};
}

/**
 * Build the JSON Schema used for structured output. It deliberately reuses the
 * public result schema for `session_topics`, viewer profiles and memory
 * operations, so guided decoding cannot drift from the validated contract.
 */
export function buildCompactAnswerSchema({resultSchema, viewerCount, allowedRefs = null, includeTopics = true}) {
  const refs = Array.isArray(allowedRefs) && allowedRefs.length > 0
    ? allowedRefs.map(Number)
    : Array.from({length: Math.max(1, Number(viewerCount) || 1)}, (_, index) => index + 1);
  const count = refs.length;
  const topics = resultSchema?.properties?.session_topics;
  const profile = resultSchema?.properties?.viewer_profiles?.items;
  const memory = resultSchema?.properties?.viewer_memory_updates?.items;
  if (!topics || !profile || !memory) throw new Error('compact schema: result schema incomplete');
  const profileProperties = {...profile.properties};
  delete profileProperties.viewer_id;
  const memoryProperties = {...memory.properties};
  delete memoryProperties.viewer_id;
  const profileRequired = (profile.required ?? []).filter((key) => key !== 'viewer_id');
  const refSchema = count === 1
    ? {const: refs[0]}
    : {enum: refs};
  const properties = {
    viewers: {
      type: 'array',
      minItems: count,
      maxItems: count,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'memory'],
        properties: {
          ref: {type: 'integer', ...refSchema},
          memory: {
            type: 'object',
            additionalProperties: false,
            required: ['no_new_information', 'operations'],
            properties: memoryProperties
          },
          profile: {
            type: 'object',
            additionalProperties: false,
            required: profileRequired,
            properties: profileProperties
          }
        }
      }
    }
  };
  if (includeTopics) properties.session_topics = topics;
  return {
    type: 'object',
    additionalProperties: false,
    required: includeTopics ? ['session_topics', 'viewers'] : ['viewers'],
    properties
  };
}

/**
 * Aggregate answers keep the public result shape (no compact refs: profiles are
 * about the whole audience and memory is already finished). The only mandated
 * difference is an empty `viewer_memory_updates`, which guided decoding can
 * enforce instead of trusting the model.
 */
export function buildAggregateAnswerSchema(resultSchema) {
  const schema = JSON.parse(JSON.stringify(resultSchema));
  schema.required = [...new Set([...(schema.required ?? []), 'viewer_memory_updates'])];
  schema.properties.viewer_memory_updates = {type: 'array', maxItems: 0};
  if (schema.properties.viewer_profiles) {
    // Profiles are optional at this stage; cap them so a large audience cannot
    // consume the whole output budget.
    schema.properties.viewer_profiles = {...schema.properties.viewer_profiles, maxItems: 200};
  }
  return schema;
}

export function isCompactAnswer(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.viewers));
}

/**
 * Inspect the ref coverage without touching identities.
 * @returns {{ok:boolean, issues:Array, entries:Map<number,object>, missing:number[]}}
 */
export function inspectCompactAnswer(answer, {viewerCount}) {
  const count = Math.max(0, Number(viewerCount) || 0);
  const issues = [];
  const entries = new Map();
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return {ok: false, issues: [issue('', COMPACT_ISSUE.ANSWER_REQUIRED)], entries, missing: []};
  }
  if (!answer.session_topics || typeof answer.session_topics !== 'object' || Array.isArray(answer.session_topics)) {
    issues.push(issue('session_topics', COMPACT_ISSUE.TOPICS_REQUIRED));
  }
  if (!Array.isArray(answer.viewers)) {
    issues.push(issue('viewers', COMPACT_ISSUE.VIEWERS_REQUIRED));
    return {ok: false, issues, entries, missing: []};
  }
  for (let index = 0; index < answer.viewers.length; index += 1) {
    const entry = answer.viewers[index];
    const path = `viewers[${index}]`;
    const ref = entry?.ref;
    if (!Number.isInteger(ref) || ref < 1 || ref > count) {
      issues.push(issue(`${path}.ref`, COMPACT_ISSUE.REF_INVALID, {ref, max: count}));
      continue;
    }
    if (entries.has(ref)) {
      issues.push(issue(`${path}.ref`, COMPACT_ISSUE.REF_DUPLICATE, {ref}));
      continue;
    }
    if (!entry.memory || typeof entry.memory !== 'object' || Array.isArray(entry.memory)) {
      issues.push(issue(`${path}.memory`, COMPACT_ISSUE.MEMORY_REQUIRED, {ref}));
      continue;
    }
    if (entry.profile !== undefined && entry.profile !== null
      && (typeof entry.profile !== 'object' || Array.isArray(entry.profile))) {
      issues.push(issue(`${path}.profile`, COMPACT_ISSUE.PROFILE_INVALID, {ref}));
      continue;
    }
    entries.set(ref, {
      ref,
      memory: entry.memory,
      profile: entry.profile ?? null
    });
  }
  const missing = [];
  for (let ref = 1; ref <= count; ref += 1) {
    if (!entries.has(ref)) missing.push(ref);
  }
  const ok = issues.length === 0 && missing.length === 0;
  return {ok, issues, entries, missing};
}

/**
 * Assemble the public `livememory-analysis-result-v1` object from a validated
 * compact answer. Every identity field comes from the package manifest and the
 * batch assignment; the model never supplies an id.
 *
 * @param {object} options
 * @param {object} options.answer compact answer
 * @param {object} options.manifest batch manifest
 * @param {Array<{ref:number, viewerId:string}>} options.viewerRefs ref → stable id
 */
export function assembleCompactAnswer({answer, manifest, viewerRefs}) {
  const refs = Array.isArray(viewerRefs) ? viewerRefs : [];
  const byRef = new Map(refs.map((entry) => [Number(entry.ref), String(entry.viewerId)]));
  const inspected = inspectCompactAnswer(answer, {viewerCount: refs.length});
  if (!inspected.ok) {
    return {ok: false, issues: inspected.issues, missing: inspected.missing, result: null};
  }
  const updates = [];
  const profiles = [];
  for (let ref = 1; ref <= refs.length; ref += 1) {
    const entry = inspected.entries.get(ref);
    const viewerId = byRef.get(ref);
    if (!viewerId) {
      return {
        ok: false,
        issues: [issue(`viewers[${ref - 1}].ref`, COMPACT_ISSUE.REF_UNKNOWN, {ref})],
        missing: [],
        result: null
      };
    }
    updates.push({
      viewer_id: viewerId,
      ...entry.memory,
      // The schema requires both keys; never invent semantics, only defaults.
      no_new_information: entry.memory.no_new_information === true,
      operations: Array.isArray(entry.memory.operations) ? entry.memory.operations : []
    });
    if (entry.profile) {
      profiles.push({viewer_id: viewerId, ...entry.profile});
    }
  }
  const result = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: manifest.schema_version ?? '1.2.0',
    job_id: manifest.job_id,
    ...(manifest.batch?.batch_id ? {batch_id: manifest.batch.batch_id} : {}),
    ...(Object.prototype.hasOwnProperty.call(manifest, 'broadcaster_id')
      ? {broadcaster_id: manifest.broadcaster_id ?? null}
      : {}),
    task_id: manifest.tasks?.[0]?.task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: answer.session_topics,
    viewer_profiles: profiles,
    viewer_memory_updates: updates
  };
  return {ok: true, issues: [], missing: [], result};
}

/**
 * Merge a targeted supplement (only missing refs) into the original answer.
 * The supplement may not introduce a ref that was not missing, otherwise the
 * caller would be accepting a model-invented target.
 */
export function mergeTargetedAnswer({answer, supplement, missingRefs}) {
  if (!isCompactAnswer(supplement)) {
    return {ok: false, issues: [issue('', COMPACT_ISSUE.VIEWERS_REQUIRED)], answer};
  }
  const allowed = new Set(missingRefs.map(Number));
  const merged = [...answer.viewers].filter((entry) => !allowed.has(Number(entry?.ref)));
  const issues = [];
  for (let index = 0; index < supplement.viewers.length; index += 1) {
    const entry = supplement.viewers[index];
    const ref = Number(entry?.ref);
    if (!allowed.has(ref)) {
      issues.push(issue(`viewers[${index}].ref`, COMPACT_ISSUE.REF_UNKNOWN, {ref}));
      continue;
    }
    if (merged.some((existing) => Number(existing?.ref) === ref)) {
      issues.push(issue(`viewers[${index}].ref`, COMPACT_ISSUE.REF_DUPLICATE, {ref}));
      continue;
    }
    merged.push(entry);
  }
  merged.sort((a, b) => Number(a.ref) - Number(b.ref));
  return {
    ok: issues.length === 0,
    issues,
    answer: {...answer, viewers: merged}
  };
}
