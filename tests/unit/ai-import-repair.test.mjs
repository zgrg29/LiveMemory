import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRepairInstruction, importGapSummary} from '../../src/web/js/pages/ai-import-repair.js';

/** Minimal t() that echoes the key and params, so text shape is testable. */
function t(key, params = {}) {
  const suffix = Object.keys(params).length > 0 ? ` ${JSON.stringify(params)}` : '';
  return `${key}${suffix}`;
}

const gaps = {
  missing: [
    {viewerId: 'youtube:UC_MISSING_A', nickname: '@missing-a'},
    {viewerId: 'youtube:UC_MISSING_B', nickname: null}
  ],
  unknown: [{viewerId: 'youtube:UC_NOT_IN_BATCH', nickname: null}],
  duplicate: [{viewerId: 'youtube:UC_MISSING_A', nickname: '@missing-a'}]
};

test('the repair instruction repeats exact ids and never rewrites them', () => {
  const text = buildRepairInstruction({
    ...gaps,
    errors: [
      {path: 'viewer_memory_updates[6].viewer_id', code: 'MEMORY_VIEWER_UNKNOWN'},
      {path: 'viewer_memory_updates', code: 'MEMORY_VIEWER_UPDATE_MISSING'}
    ],
    t
  });
  assert.match(text, /youtube:UC_MISSING_A/);
  assert.match(text, /youtube:UC_MISSING_B/);
  assert.match(text, /youtube:UC_NOT_IN_BATCH/);
  assert.match(text, /@missing-a/);
  assert.match(text, /viewer_memory_updates\[6\]\.viewer_id/);
  assert.match(text, /MEMORY_VIEWER_UPDATE_MISSING/);
  assert.match(text, /ai\.import\.repairRuleExactId/);
  assert.match(text, /ai\.import\.repairRuleCoverage/);
  assert.match(text, /ai\.import\.repairAsk/);
});

test('importGapSummary tolerates a preview without gaps', () => {
  assert.deepEqual(importGapSummary(null), {
    missing: [],
    unknown: [],
    duplicate: [],
    empty: true
  });
  const summary = importGapSummary({gaps});
  assert.equal(summary.empty, false);
  assert.equal(summary.missing.length, 2);
});
