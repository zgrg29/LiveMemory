/**
 * Compact memory-only answer (provider mode).
 *
 * The model never copies a stable viewer id. It receives small refs and the only
 * legal evidence seqs. The local assembler maps refs back to exact viewer ids and
 * then calls the ordinary importer. A missing/unknown/duplicate ref is rejected.
 */

/**
 * Session answers are also assembled locally. The model may return only
 * `session_topics` (and optionally per-session viewer_profiles); task IDs,
 * protocol and session IDs are never trusted from the model.
 */
export function buildSessionAnswerSchema(resultSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['session_topics'],
    properties: {
      session_topics: resultSchema?.properties?.session_topics,
      viewer_profiles: resultSchema?.properties?.viewer_profiles
    }
  };
}

/**
 * The aggregate answer is a *merged report*, not a container for every batch.
 * The full result Schema allows up to 60 topics × 2,000 chars and 120 sentiment
 * notes; asking one request to fill that while merging 18 batches is exactly how
 * an 8k answer budget gets truncated. This bounded copy keeps the same required
 * fields and evidence shape but caps the cardinality and text length to the
 * amount a whole-session report actually needs. Validation still runs against
 * the full Schema, so this is a stricter output contract, never a weaker one.
 */
export function buildSessionAggregateAnswerSchema(resultSchema, {
  topics = 24,
  sentiment = 12,
  disputes = 8,
  highlights = 8,
  summaryChars = 800,
  topicSummaryChars = 320,
  keyPoints = 4,
  keyPointChars = 140,
  noteChars = 180,
  messageRefs = 4
} = {}) {
  const base = buildSessionAnswerSchema(resultSchema);
  const section = base?.properties?.session_topics;
  if (!section?.properties) return base;
  const props = section.properties;
  const topicItem = props.topics?.items;
  const topicProps = topicItem?.properties ?? {};
  const sentimentItem = props.sentiment?.items;
  const sentimentProps = sentimentItem?.properties ?? {};
  const disputeItem = props.disputes?.items;
  const disputeProps = disputeItem?.properties ?? {};
  const highlightItem = props.highlights?.items;
  const highlightProps = highlightItem?.properties ?? {};
  const boundedRefs = (refs) => (refs
    ? {...refs, maxItems: Math.min(Number(refs.maxItems ?? messageRefs), messageRefs)}
    : refs);
  // The aggregate never produces viewer_profiles; omit the property entirely so
  // a structured-output provider cannot ask the model to fill it.
  const {viewer_profiles: _viewerProfiles, ...baseProperties} = base.properties;
  return {
    ...base,
    properties: {
      ...baseProperties,
      session_topics: {
        ...section,
        properties: {
          ...props,
          summary: {...props.summary, maxLength: summaryChars},
          topics: {
            ...props.topics,
            maxItems: Math.min(Number(props.topics?.maxItems ?? topics), topics),
            items: {
              ...topicItem,
              properties: {
                ...topicProps,
                summary: {...topicProps.summary, maxLength: topicSummaryChars},
                key_points: {
                  ...topicProps.key_points,
                  maxItems: Math.min(Number(topicProps.key_points?.maxItems ?? keyPoints), keyPoints),
                  items: {
                    ...(topicProps.key_points?.items ?? {type: 'string'}),
                    maxLength: Math.min(
                      Number(topicProps.key_points?.items?.maxLength ?? keyPointChars),
                      keyPointChars
                    )
                  }
                },
                message_refs: boundedRefs(topicProps.message_refs)
              }
            }
          },
          sentiment: {
            ...props.sentiment,
            maxItems: Math.min(Number(props.sentiment?.maxItems ?? sentiment), sentiment),
            items: {
              ...sentimentItem,
              properties: {
                ...sentimentProps,
                note: {...sentimentProps.note, maxLength: noteChars},
                evidence_note: {...sentimentProps.evidence_note, maxLength: noteChars}
              }
            }
          },
          disputes: {
            ...props.disputes,
            maxItems: Math.min(Number(props.disputes?.maxItems ?? disputes), disputes),
            items: {
              ...disputeItem,
              properties: {
                ...disputeProps,
                summary: {...disputeProps.summary, maxLength: topicSummaryChars},
                note: {...disputeProps.note, maxLength: topicSummaryChars},
                viewpoints: {
                  ...disputeProps.viewpoints,
                  maxItems: Math.min(Number(disputeProps.viewpoints?.maxItems ?? 4), 4),
                  items: {...(disputeProps.viewpoints?.items ?? {type: 'string'}), maxLength: keyPointChars}
                },
                message_refs: boundedRefs(disputeProps.message_refs)
              }
            }
          },
          highlights: {
            ...props.highlights,
            maxItems: Math.min(Number(props.highlights?.maxItems ?? highlights), highlights),
            items: {
              ...highlightItem,
              properties: {
                ...highlightProps,
                reason: {...highlightProps.reason, maxLength: topicSummaryChars},
                clip_suggestion: {...highlightProps.clip_suggestion, maxLength: noteChars + 40},
                message_refs: boundedRefs(highlightProps.message_refs)
              }
            }
          }
        }
      }
    }
  };
}

export function assembleSessionAnswer({answer, manifest}) {
  const topics = answer?.session_topics;
  if (!topics || typeof topics !== 'object' || Array.isArray(topics)) {
    return {
      ok: false,
      issues: [{path: 'session_topics', code: 'SESSION_TOPICS_REQUIRED'}],
      result: null
    };
  }
  const profiles = Array.isArray(answer.viewer_profiles) ? answer.viewer_profiles : [];
  return {
    ok: true,
    issues: [],
    result: {
      protocol: 'livememory-analysis-result-v1',
      schema_version: '1.3.0',
      analysis_scope: 'session',
      job_id: manifest.job_id,
      ...(manifest.batch?.batch_id ? {batch_id: manifest.batch.batch_id} : {}),
      ...(Object.prototype.hasOwnProperty.call(manifest, 'broadcaster_id')
        ? {broadcaster_id: manifest.broadcaster_id ?? null}
        : {}),
      task_id: manifest.tasks?.[0]?.task_id,
      session_id: manifest.session_id,
      locale: manifest.locale,
      session_topics: topics,
      viewer_profiles: profiles
    }
  };
}

/**
 * The final aggregate answer is still a session report. It has no batch id and
 * its task id is the job's aggregate task. Batch-qualified evidence refs are
 * validated against every imported batch by the normal importer.
 */
export function assembleSessionAggregateAnswer({answer, manifest}) {
  const topics = answer?.session_topics;
  if (!topics || typeof topics !== 'object' || Array.isArray(topics)) {
    return {
      ok: false,
      issues: [{path: 'session_topics', code: 'SESSION_TOPICS_REQUIRED'}],
      result: null
    };
  }
  return {
    ok: true,
    issues: [],
    result: {
      protocol: 'livememory-analysis-result-v1',
      schema_version: '1.3.0',
      analysis_scope: 'session',
      job_id: manifest.job_id,
      ...(Object.prototype.hasOwnProperty.call(manifest, 'broadcaster_id')
        ? {broadcaster_id: manifest.broadcaster_id ?? null}
        : {}),
      task_id: manifest.tasks?.[0]?.task_id,
      session_id: manifest.session_id,
      locale: manifest.locale,
      session_topics: topics
    }
  };
}

export function buildMemoryRefs(memoryContext) {
  return (memoryContext?.viewers ?? []).map((viewer, index) => ({
    ref: index + 1,
    viewerId: viewer.viewer_id,
    nickname: viewer.nickname ?? null,
    evidenceSeqs: Array.isArray(viewer.evidence_seqs) ? viewer.evidence_seqs.map(Number) : [],
    zeroExcerpt: viewer.zero_excerpt === true || (viewer.evidence_seqs ?? []).length === 0
  }));
}

/**
 * The only fields a model may contribute to one viewer's memory update.
 *
 * Identity (`viewer_id`, `ref`, `session_id`, ...) is owned by the local
 * program. Unknown fields are dropped instead of being spread into the result,
 * so a model can never replace a stable viewer id or inject a second identity
 * into a record that is about to be persisted.
 */
export const MEMORY_UPDATE_FIELDS = Object.freeze([
  'summary',
  'summary_certainty',
  'no_new_information',
  'operations'
]);

function pickMemoryFields(memory) {
  const picked = {};
  const ignored = [];
  for (const key of Object.keys(memory ?? {})) {
    if (MEMORY_UPDATE_FIELDS.includes(key)) picked[key] = memory[key];
    else ignored.push(key);
  }
  return {picked, ignored};
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
  const ignoredFields = [];
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.viewers)) {
    return {
      ok: false,
      issues: [{path: 'viewers', code: 'MEMORY_VIEWERS_REQUIRED'}],
      entries,
      missing: [],
      ignoredFields
    };
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
      // Backward-compatible flat probe shape: {ref,no_new_information,operations}.
      if (Object.prototype.hasOwnProperty.call(entry, 'no_new_information')
        || Array.isArray(entry.operations)) {
        entries.set(ref, {
          no_new_information: entry.no_new_information === true,
          operations: Array.isArray(entry.operations) ? entry.operations : []
        });
        continue;
      }
      issues.push({path: `viewers[${index}].memory`, code: 'MEMORY_REQUIRED', params: {ref}});
      continue;
    }
    const {picked, ignored} = pickMemoryFields(entry.memory);
    if (ignored.length > 0) ignoredFields.push({ref, fields: ignored.slice(0, 12)});
    entries.set(ref, picked);
  }
  const missing = [...allowed].filter((ref) => !entries.has(ref)).sort((a, b) => a - b);
  return {ok: issues.length === 0 && missing.length === 0, issues, entries, missing, ignoredFields};
}

export function assembleMemoryCompact({answer, manifest, refs, onlyRefs = null}) {
  const inspected = inspectCompactMemory(answer, {refs, onlyRefs});
  if (!inspected.ok) {
    return {
      ok: false,
      issues: inspected.issues,
      missing: inspected.missing,
      result: null,
      ignoredFields: inspected.ignoredFields ?? []
    };
  }
  const byRef = new Map(refs.map((entry) => [entry.ref, entry.viewerId]));
  const updates = [];
  for (const ref of [...inspected.entries.keys()].sort((a, b) => a - b)) {
    const memory = inspected.entries.get(ref);
    updates.push({
      ...memory,
      no_new_information: memory.no_new_information === true,
      operations: Array.isArray(memory.operations) ? memory.operations : [],
      // Always last: the model can never overwrite the local stable identity.
      viewer_id: byRef.get(ref)
    });
  }
  return {
    ok: true,
    issues: [],
    missing: [],
    ignoredFields: inspected.ignoredFields ?? [],
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
