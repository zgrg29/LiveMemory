/**
 * Fact-quality counters for one memory job.
 *
 * Counting every row as an "effective fact" was the core measurement mistake in
 * the earlier 10-vs-20 comparison: a cautious model that emitted 37
 * `needs_confirmation` rows looked better than a model that emitted 47
 * evidence-backed `stated` rows. The counters below keep the two apart without
 * changing storage or validation.
 */

const EMPTY = Object.freeze({
  total: 0,
  stated: 0,
  inferred: 0,
  uncertain: 0,
  active: 0,
  needsConfirmation: 0,
  outdated: 0,
  conflicted: 0,
  superseded: 0,
  viewersWithFacts: 0
});

export function countFactQuality(db, jobId) {
  if (!db || !jobId) return {...EMPTY};
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT viewer_id) AS viewers_with_facts,
        SUM(CASE WHEN certainty = 'stated' THEN 1 ELSE 0 END) AS stated,
        SUM(CASE WHEN certainty = 'inferred' THEN 1 ELSE 0 END) AS inferred,
        SUM(CASE WHEN certainty = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'needs_confirmation' THEN 1 ELSE 0 END) AS needs_confirmation,
        SUM(CASE WHEN status = 'outdated' THEN 1 ELSE 0 END) AS outdated,
        SUM(CASE WHEN status = 'conflicted' THEN 1 ELSE 0 END) AS conflicted,
        SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded
      FROM memory_facts
      WHERE source_job_id = ?
    `).get(jobId);
    return {
      total: Number(row?.total ?? 0),
      stated: Number(row?.stated ?? 0),
      inferred: Number(row?.inferred ?? 0),
      uncertain: Number(row?.uncertain ?? 0),
      active: Number(row?.active ?? 0),
      needsConfirmation: Number(row?.needs_confirmation ?? 0),
      outdated: Number(row?.outdated ?? 0),
      conflicted: Number(row?.conflicted ?? 0),
      superseded: Number(row?.superseded ?? 0),
      viewersWithFacts: Number(row?.viewers_with_facts ?? 0)
    };
  } catch {
    return {...EMPTY};
  }
}
