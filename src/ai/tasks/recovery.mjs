/**
 * Recovery affordance for an analysis task.
 *
 * The database is the source of truth: a task is recoverable when at least one
 * required unit is still missing and the completed units are already persisted.
 * This module never decides to re-run a saved batch, and it never claims that a
 * task is recoverable when every remaining unit requires a different model or
 * configuration that a same-task resume cannot use.
 *
 * The UI renders one explicit action from this object:
 *
 *   resume-aggregate  only the missing whole-session aggregate
 *   resume-session    only missing/failed session batches
 *   resume-memory     only pending/failed memory viewers or batches
 *   change-model      the input/output cannot fit the current model; no fake
 *                     "continue" may be shown
 *
 * `pendingAggregate` is deliberately checked before pending batches: a task
 * whose 18/18 batches are saved and whose aggregate failed must offer
 * "继续最终汇总", not a generic retry of the session stage.
 */

const TERMINAL_RECOVERABLE = new Set(['failed', 'partial', 'needs_action', 'interrupted', 'paused']);

const CONFIG_BLOCKED_CODES = new Set([
  'CONFIG_CHANGED',
  'AI_PROVIDER_CONFIG_CHANGED',
  'PROVIDER_CONFIG_NOT_FOUND',
  'MODEL_REQUIRED',
  'SESSION_CAPABILITY_REQUIRED',
  'MEMORY_CAPABILITY_REQUIRED',
  'ANALYSIS_AGGREGATE_TOO_LARGE',
  'ANALYSIS_REPAIR_TOO_LARGE',
  'ANALYSIS_CONTEXT_TOO_SMALL'
]);

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/**
 * @returns {null | {
 *   kind:'aggregate'|'session'|'memory'|'config',
 *   action:'resume-aggregate'|'resume-session'|'resume-memory'|'change-model',
 *   canResume:boolean,
 *   reasonCode:string|null,
 *   session:{batchTotal:number,batchesSaved:number,pendingBatches:number,aggregateRequired:boolean,aggregateDone:boolean},
 *   memory:{batchTotal:number,batchesSaved:number,pendingBatches:number,viewersTotal:number,viewersProcessed:number,complete:boolean},
 *   savedResults:number
 * }}
 */
export function buildRecovery({
  status = null,
  errorCode = null,
  sessionJobId = null,
  memoryJobId = null,
  sessionStatus = null,
  memoryStatus = null
} = {}) {
  if (!TERMINAL_RECOVERABLE.has(String(status ?? ''))) return null;
  if (!sessionJobId && !memoryJobId) return null;
  if (errorCode === 'ANALYSIS_MEMORY_OUT_OF_ORDER') return null;

  const sessionBatchTotal = integer(sessionStatus?.batchTotal);
  const sessionBatchesSaved = integer(sessionStatus?.batchesImported);
  const sessionPending = Math.max(0, sessionBatchTotal - sessionBatchesSaved);
  const aggregateRequired = Boolean(sessionStatus?.aggregateRequired)
    || Boolean(sessionJobId && sessionBatchTotal > 1);
  const aggregateDone = Boolean(sessionStatus?.aggregateImported);
  const memoryBatchTotal = integer(memoryStatus?.batchTotal);
  const memoryBatchesSaved = integer(memoryStatus?.batchesImported);
  const memoryPending = Math.max(0, memoryBatchTotal - memoryBatchesSaved);
  const memoryComplete = Boolean(memoryStatus?.complete);
  const coverage = memoryStatus?.memoryCoverage ?? null;
  const viewersTotal = integer(coverage?.total);
  const viewersProcessed = integer(coverage?.covered);
  const pendingViewers = Math.max(0, viewersTotal - viewersProcessed);

  const aggregatePending = Boolean(sessionJobId)
    && aggregateRequired
    && !aggregateDone
    && sessionBatchTotal > 0
    && sessionPending === 0;

  let kind = null;
  if (aggregatePending) {
    kind = 'aggregate';
  } else if (sessionJobId && sessionPending > 0) {
    // Session comes before memory: a combined task cannot start the memory
    // stage until the saved session report exists, and re-running memory first
    // would not fix the session half.
    kind = 'session';
  } else if (memoryJobId && (memoryPending > 0 || pendingViewers > 0 || !memoryComplete)) {
    kind = 'memory';
  } else if (sessionJobId && aggregateRequired && !aggregateDone) {
    // All batch rows exist but the final result is missing (for example the
    // state was lost after a restart). Only the aggregate is left.
    kind = 'aggregate';
  } else if (sessionJobId && !sessionStatus?.complete) {
    // A single-batch session without a saved result: retrying the batch is the
    // only remaining work.
    kind = 'session';
  }

  if (!kind) return null;

  const blocked = CONFIG_BLOCKED_CODES.has(String(errorCode ?? ''));
  const action = blocked
    ? 'change-model'
    : (kind === 'aggregate' ? 'resume-aggregate' : (kind === 'session' ? 'resume-session' : 'resume-memory'));

  return {
    kind,
    action,
    canResume: !blocked,
    reasonCode: errorCode ?? null,
    session: {
      batchTotal: sessionBatchTotal,
      batchesSaved: sessionBatchesSaved,
      pendingBatches: sessionPending,
      aggregateRequired,
      aggregateDone
    },
    memory: {
      batchTotal: memoryBatchTotal,
      batchesSaved: memoryBatchesSaved,
      pendingBatches: memoryPending,
      viewersTotal,
      viewersProcessed,
      complete: memoryComplete
    },
    savedResults: sessionBatchesSaved
      + (aggregateDone ? 1 : 0)
      + memoryBatchesSaved
  };
}
