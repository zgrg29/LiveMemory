/**
 * Persisted hierarchical aggregate nodes.
 *
 * A node is one bounded partial summary of a contiguous slice of an analysis
 * job: either a group of original saved batches (level 1) or a group of lower
 * level nodes (level >= 2). Level 0 is reserved for the final whole-session
 * summary so a completed final answer can be re-imported after a crash without
 * calling the provider again.
 *
 * Nodes are independent rows, written as soon as they pass validation. A
 * resumed task therefore reuses every completed node and only pays for the
 * missing ones. They are never treated as analysis results: only the final node
 * is assembled into Schema 1.3.0 and imported through the normal importer.
 */

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function mapAggregateNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    level: Number(row.level),
    nodeIndex: Number(row.node_index),
    sourceKind: row.source_kind,
    sourceKeys: parseJson(row.source_keys_json, []),
    sourceHash: row.source_hash,
    coveredBatches: parseJson(row.covered_batches_json, []),
    status: row.status,
    digest: parseJson(row.digest_json, null),
    fallback: row.fallback ?? null,
    attempts: Number(row.attempts ?? 0),
    inputTokensEstimated: Number(row.input_tokens_estimated ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    usage: parseJson(row.usage_json, null),
    coverage: parseJson(row.coverage_json, null),
    lastError: parseJson(row.last_error_json, null),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export function upsertAggregateNode(db, {
  id,
  jobId,
  sessionId,
  level,
  nodeIndex,
  sourceKind,
  sourceKeys = [],
  sourceHash,
  coveredBatches = [],
  status = 'complete',
  digest = null,
  fallback = null,
  attempts = 0,
  inputTokensEstimated = 0,
  outputTokens = 0,
  usage = null,
  coverage = null,
  lastError = null,
  now = Date.now()
}) {
  const nodeId = String(id ?? `agg_${jobId}_${level}_${nodeIndex}`);
  db.prepare(`
    INSERT INTO ai_aggregate_nodes (
      id, job_id, session_id, level, node_index, source_kind, source_keys_json,
      source_hash, covered_batches_json, status, digest_json, fallback, attempts,
      input_tokens_estimated, output_tokens, usage_json, coverage_json,
      last_error_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, level, node_index) DO UPDATE SET
      id = excluded.id,
      source_kind = excluded.source_kind,
      source_keys_json = excluded.source_keys_json,
      source_hash = excluded.source_hash,
      covered_batches_json = excluded.covered_batches_json,
      status = excluded.status,
      digest_json = excluded.digest_json,
      fallback = excluded.fallback,
      attempts = excluded.attempts,
      input_tokens_estimated = excluded.input_tokens_estimated,
      output_tokens = excluded.output_tokens,
      usage_json = excluded.usage_json,
      coverage_json = excluded.coverage_json,
      last_error_json = excluded.last_error_json,
      updated_at = excluded.updated_at
  `).run(
    nodeId,
    String(jobId),
    String(sessionId),
    Number(level),
    Number(nodeIndex),
    String(sourceKind),
    JSON.stringify(sourceKeys),
    String(sourceHash),
    JSON.stringify(coveredBatches),
    String(status),
    digest ? JSON.stringify(digest) : null,
    fallback === null || fallback === undefined ? null : String(fallback),
    Number(attempts),
    Number(inputTokensEstimated),
    Number(outputTokens),
    usage ? JSON.stringify(usage) : null,
    coverage ? JSON.stringify(coverage) : null,
    lastError ? JSON.stringify(lastError) : null,
    Number(now),
    Number(now)
  );
  return getAggregateNode(db, {jobId, level, nodeIndex});
}

export function getAggregateNode(db, {jobId, level, nodeIndex}) {
  return mapAggregateNode(db.prepare(`
    SELECT * FROM ai_aggregate_nodes
     WHERE job_id = ? AND level = ? AND node_index = ?
  `).get(String(jobId), Number(level), Number(nodeIndex)));
}

export function listAggregateNodes(db, jobId, {level = null} = {}) {
  const rows = level === null
    ? db.prepare(`
        SELECT * FROM ai_aggregate_nodes
         WHERE job_id = ?
         ORDER BY level ASC, node_index ASC
      `).all(String(jobId))
    : db.prepare(`
        SELECT * FROM ai_aggregate_nodes
         WHERE job_id = ? AND level = ?
         ORDER BY node_index ASC
      `).all(String(jobId), Number(level));
  return rows.map(mapAggregateNode);
}

export function deleteAggregateNodes(db, jobId) {
  db.prepare('DELETE FROM ai_aggregate_nodes WHERE job_id = ?').run(String(jobId));
}

/**
 * Compact status for the console and recovery logic.
 *
 * `nodeTotal` deliberately excludes the final node: the UI shows partial-summary
 * progress separately from "final report saved". `requests` sums the actual
 * usage attached to nodes, which is additional evidence that hierarchical
 * requests are billed, not hidden.
 */
export function aggregateNodeSummary(db, jobId) {
  const rows = listAggregateNodes(db, jobId);
  if (rows.length === 0) {
    return {
      mode: null,
      nodeTotal: 0,
      nodesComplete: 0,
      nodesFailed: 0,
      levels: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallback: null,
      finalSaved: false,
      coverage: null
    };
  }
  const partial = rows.filter((row) => row.level > 0);
  const final = rows.find((row) => row.level === 0) ?? null;
  const levels = partial.reduce((max, row) => Math.max(max, row.level), 0);
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    requests += Number(row.usage?.requests ?? 0);
    inputTokens += Number(row.usage?.inputTokens ?? 0);
    outputTokens += Number(row.usage?.outputTokens ?? 0);
  }
  const fallbacks = rows.filter((row) => row.fallback && row.fallback !== 'none');
  return {
    mode: levels > 0 ? 'hierarchical' : (final ? 'single' : null),
    nodeTotal: partial.length,
    nodesComplete: partial.filter((row) => row.status === 'complete').length,
    nodesFailed: partial.filter((row) => row.status === 'failed').length,
    levels,
    requests,
    inputTokens,
    outputTokens,
    fallback: fallbacks.length > 0 ? fallbacks.map((row) => row.fallback).sort()[0] : null,
    finalSaved: Boolean(final && final.status === 'complete'),
    coverage: final?.coverage ?? null
  };
}

export const __internal = {parseJson};
