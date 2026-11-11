/**
 * Compact memory-only answer (provider mode).
 *
 * The model never copies a stable viewer id. It receives small refs and the only
 * legal evidence seqs. The local assembler maps refs back to exact viewer ids and
 * then calls the ordinary importer. A missing/unknown/duplicate ref is rejected.
 */

export function buildMemoryRefs(memoryContext) {
  return (memoryContext?.viewers ?? []).map((viewer, index) => ({
    ref: index + 1,
    viewerId: viewer.viewer_id,
    nickname: viewer.nickname ?? null,
    evidenceSeqs: Array.isArray(viewer.evidence_seqs) ? viewer.evidence_seqs.map(Number) : [],
    zeroExcerpt: viewer.zero_excerpt === true || (viewer.evidence_seqs ?? []).length === 0
  }));
}

export function buildMemoryCompactSchema({resultSchema, refs, onlyRefs = null}) {
  const allowed = Array.isArray(onlyRefs) && onlyRefs.length > 0
    ? onlyRefs.map(Number)
    : refs.map((entry) => entry.ref);
  const memoryItem = resultSchema?.properties?.viewer_memory_updates?.items;
  if (!memoryItem) throw new Error('memory compact schema: result schema missing viewer_memory_updates');
  const memoryProperties = {...memoryItem.properties};
  delete memoryProperties.viewer_id;
  const required = (memoryItem.required ?? []).filter((key) => key !== 'viewer_id');
  const refSchema = allowed.length === 1 ? {const: allowed[0]} : {enum: allowed};
  return {
    type: 'object',
    additionalProperties: false,
    required: ['viewers'],
    properties: {
      viewers: {
        type: 'array',
        minItems: allowed.length,
        maxItems: allowed.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'memory'],
          properties: {
            ref: {type: 'integer', ...refSchema},
            memory: {
              type: 'object',
              additionalProperties: false,
              required,
              properties: memoryProperties
            }
          }
        }
      }
    }
  };
}

export function inspectCompactMemory(answer, {refs, onlyRefs = null}) {
  const allowed = new Set((onlyRefs ?? refs.map((entry) => entry.ref)).map(Number));
  const issues = [];
  const entries = new Map();
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.viewers)) {
    return {ok: false, issues: [{path: 'viewers', code: 'MEMORY_VIEWERS_REQUIRED'}], entries, missing: []};
  }
  for (let index = 0; index < answer.viewers.length; index += 1) {
    const entry = answer.viewers[index];
    const ref = Number(entry?.ref);
    if (!Number.isInteger(ref) || !allowed.has(ref)) {
      issues.push({path: `viewers[${index}].ref`, code: 'MEMORY_REF_UNKNOWN', params: {ref}});
      continue;
    }
    if (entries.has(ref)) {
      issues.push({path: `viewers[${index}].ref`, code: 'MEMORY_REF_DUPLICATE', params: {ref}});
      continue;
    }
    if (!entry.memory || typeof entry.memory !== 'object' || Array.isArray(entry.memory)) {
      issues.push({path: `viewers[${index}].memory`, code: 'MEMORY_REQUIRED', params: {ref}});
      continue;
    }
    entries.set(ref, entry.memory);
  }
  const missing = [...allowed].filter((ref) => !entries.has(ref)).sort((a, b) => a - b);
  return {ok: issues.length === 0 && missing.length === 0, issues, entries, missing};
}

export function assembleMemoryCompact({answer, manifest, refs, onlyRefs = null}) {
  const inspected = inspectCompactMemory(answer, {refs, onlyRefs});
  if (!inspected.ok) {
    return {ok: false, issues: inspected.issues, missing: inspected.missing, result: null};
  }
  const byRef = new Map(refs.map((entry) => [entry.ref, entry.viewerId]));
  const updates = [];
  for (const ref of [...inspected.entries.keys()].sort((a, b) => a - b)) {
    const memory = inspected.entries.get(ref);
    updates.push({
      viewer_id: byRef.get(ref),
      ...memory,
      no_new_information: memory.no_new_information === true,
      operations: Array.isArray(memory.operations) ? memory.operations : []
    });
  }
  return {
    ok: true,
    issues: [],
    missing: [],
    result: {
      protocol: 'livememory-analysis-result-v1',
      schema_version: '1.3.0',
      analysis_scope: 'viewer_memory',
      job_id: manifest.job_id,
      ...(manifest.batch?.batch_id ? {batch_id: manifest.batch.batch_id} : {}),
      ...(manifest.broadcaster_id ? {broadcaster_id: manifest.broadcaster_id} : {}),
      task_id: manifest.tasks?.[0]?.task_id,
      session_id: manifest.session_id,
      locale: manifest.locale,
      viewer_memory_updates: updates
    }
  };
}

export function mergeMemorySupplement({answer, supplement, refs, missingRefs}) {
  const allowed = new Set(missingRefs.map(Number));
  const inspected = inspectCompactMemory(supplement, {refs, onlyRefs: [...allowed]});
  if (!inspected.ok) return {ok: false, issues: inspected.issues, missing: inspected.missing, answer};
  const kept = (answer.viewers ?? []).filter((entry) => !allowed.has(Number(entry?.ref)));
  const added = [...inspected.entries.entries()].map(([ref, memory]) => ({ref, memory}));
  const merged = [...kept, ...added].sort((a, b) => Number(a.ref) - Number(b.ref));
  return {ok: true, issues: [], missing: [], answer: {...answer, viewers: merged}};
}
