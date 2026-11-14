import {createSession, endSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {GQ_BROADCASTER, buildGoldCorpusMessages} from '../fixtures/memory-quality/gold-corpus.mjs';

/**
 * Helpers shared by the memory-quality integration test and the evaluation CLI.
 *
 * They intentionally read only local SQLite rows. Nothing here calls a provider
 * and nothing here writes to a production data directory.
 */

export function seedGoldCorpus(db, {now = Date.parse('2026-11-01T09:00:00.000Z')} = {}) {
  upsertBroadcaster(db, {
    id: GQ_BROADCASTER.id,
    platform: GQ_BROADCASTER.platform,
    platformUid: GQ_BROADCASTER.platformUid,
    displayName: GQ_BROADCASTER.displayName,
    identity: 'verified',
    seenAt: now,
    now
  });
  const created = [];
  for (const spec of buildGoldCorpusMessages()) {
    const session = createSession(db, {
      id: spec.id,
      platform: 'youtube',
      platformRoomId: `gq-${spec.key}`,
      roomTitle: spec.title,
      broadcasterName: GQ_BROADCASTER.displayName,
      broadcasterId: GQ_BROADCASTER.id,
      broadcasterIdentity: 'verified',
      storageMode: 'full',
      sourceQuality: 'mock',
      simulated: true,
      startedAt: spec.startedAt
    });
    const ingest = new EventIngest({db, now: () => spec.startedAt});
    let lastAt = spec.startedAt;
    for (const message of spec.messages) {
      lastAt = message.at;
      const uid = message.viewerId.replace(/^youtube:/, '');
      if (message.type === 'gift') {
        ingest.record({
          session_id: session.id,
          platform: 'youtube',
          event_type: 'gift',
          viewer_uid: uid,
          display_name: message.name,
          occurred_at: message.at,
          external_id: message.key,
          gift_id: 'gq_gift',
          gift_name: 'Synthetic gift',
          gift_type: 'paid',
          gift_quantity: 1,
          unit_amount_minor: 500,
          currency: 'CNY',
          value_kind: 'actual',
          is_paid: true,
          source_quality: 'mock'
        });
      } else {
        ingest.record({
          session_id: session.id,
          platform: 'youtube',
          event_type: 'chat',
          viewer_uid: uid,
          display_name: message.name,
          occurred_at: message.at,
          content: message.content,
          external_id: message.key,
          source_quality: 'mock'
        });
      }
    }
    endSession(db, session.id, {
      status: 'ended',
      endedAt: lastAt + 1000,
      reason: 'adapter_end'
    });
    created.push(session);
  }
  return created;
}

/** Chat message events of one session in package order (1-based seq). */
export function sessionMessageMap(db, sessionId) {
  const rows = db.prepare(`
    SELECT id, viewer_id, content, occurred_at, external_id
    FROM events
    WHERE session_id = ? AND event_type IN ('chat', 'super_chat', 'super_sticker', 'membership')
    ORDER BY occurred_at ASC, id ASC
  `).all(sessionId);
  return rows.map((row, index) => ({
    ...row,
    seq: index + 1,
    eventKey: `${sessionId}#${index + 1}`
  }));
}

/**
 * Load saved facts with their evidence text and event keys.
 *
 * @param {object} db
 * @param {object} options
 * @param {string} [options.jobId] filter by `source_job_id`
 * @param {string} [options.sessionId] filter by `source_session_id`
 */
export function loadSavedFacts(db, {jobId = null, sessionId = null} = {}) {
  const where = [];
  const params = [];
  if (jobId) {
    where.push('f.source_job_id = ?');
    params.push(jobId);
  }
  if (sessionId) {
    where.push('f.source_session_id = ?');
    params.push(sessionId);
  }
  const rows = db.prepare(`
    SELECT f.id, f.memory_id, f.viewer_id, f.kind, f.topic, f.statement,
           f.certainty, f.status, f.confidence, f.dedupe_key,
           f.source_session_id, f.source_job_id, f.first_seen_at, f.last_confirmed_at
    FROM memory_facts f
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.viewer_id, f.id
  `).all(...params);
  const evidenceRows = db.prepare(`
    SELECT e.fact_id, e.session_id, e.batch_index, e.seq, e.event_id, ev.content, ev.viewer_id
    FROM memory_fact_evidence e
    LEFT JOIN events ev ON ev.id = e.event_id
  `).all();
  const eventsBySession = new Map();
  const eventKeyById = new Map();
  for (const row of db.prepare(`
    SELECT id, session_id FROM events
    WHERE event_type IN ('chat', 'super_chat', 'super_sticker', 'membership')
    ORDER BY session_id, occurred_at ASC, id ASC
  `).all()) {
    const list = eventsBySession.get(row.session_id) ?? [];
    list.push(row.id);
    eventsBySession.set(row.session_id, list);
  }
  for (const [sessionKey, ids] of eventsBySession) {
    ids.forEach((id, index) => eventKeyById.set(String(id), `${sessionKey}#${index + 1}`));
  }
  const evidenceByFact = new Map();
  for (const evidence of evidenceRows) {
    const list = evidenceByFact.get(evidence.fact_id) ?? [];
    list.push({
      sessionKey: evidence.session_id,
      seq: evidence.seq,
      eventId: evidence.event_id,
      eventKey: evidence.event_id ? eventKeyById.get(String(evidence.event_id)) ?? null : null,
      viewerKey: evidence.viewer_id ?? null,
      content: evidence.content ?? ''
    });
    evidenceByFact.set(evidence.fact_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    viewerKey: row.viewer_id,
    kind: row.kind,
    topic: row.topic,
    statement: row.statement,
    certainty: row.certainty,
    status: row.status,
    confidence: row.confidence,
    dedupeKey: row.dedupe_key,
    sourceSessionId: row.source_session_id,
    sourceJobId: row.source_job_id,
    firstSeenAt: row.first_seen_at,
    lastConfirmedAt: row.last_confirmed_at,
    evidence: evidenceByFact.get(row.id) ?? []
  }));
}

export function loadJobUsage(db, jobId) {
  if (!jobId) return null;
  const row = db.prepare('SELECT id, usage_json FROM ai_jobs WHERE id = ?').get(jobId);
  if (!row?.usage_json) return null;
  try {
    const usage = JSON.parse(row.usage_json);
    return {
      requests: Number(usage.requests ?? 0),
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      totalTokens: Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0),
      cost: usage.cost ?? null
    };
  } catch {
    return null;
  }
}

/** Latest memory job of one session (used by the archived-run evaluator). */
export function latestMemoryJob(db, sessionId) {
  return db.prepare(`
    SELECT id, session_id, usage_json, batch_total, memory_viewers_total, created_at
    FROM ai_jobs
    WHERE session_id = ? AND kind = 'viewer_memory_analysis'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(sessionId) ?? null;
}
