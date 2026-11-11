/**
 * Pure progress calculation for the AI analysis centre.
 *
 * Percent is derived only from server-reported batch counts, never from elapsed
 * time. A stage with no countable unit returns `percent: null`, which the UI
 * renders as an indeterminate bar.
 */

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function buildAnalysisProgress(status) {
  const current = status ?? {};
  const mode = ['session', 'memory', 'combined'].includes(current.mode)
    ? current.mode
    : 'session';
  const sessionSelected = mode === 'session' || mode === 'combined';
  const memorySelected = (mode === 'memory' || mode === 'combined') && current.memorySkipped !== true;
  const sessionDone = current.sessionReportDone === true;
  const memoryTotal = number(current.batchTotal);
  const memoryDone = Math.min(number(current.batchIndex), memoryTotal);
  const viewersTotal = number(current.memoryViewersTotal ?? current.memoryJob?.memoryCoverage?.total);
  const viewersDone = Math.min(
    number(current.memoryViewersProcessed ?? current.memoryJob?.memoryCoverage?.covered),
    viewersTotal
  );
  const parts = [];

  if (sessionSelected) {
    parts.push({
      key: 'session',
      done: sessionDone ? 1 : 0,
      total: 1,
      complete: sessionDone
    });
  }
  if (current.memorySkipped === true) {
    parts.push({
      key: 'memory',
      skipped: true,
      reason: current.memorySkipReason ?? null,
      done: 0,
      total: 0,
      completed: true
    });
  } else if (memorySelected) {
    parts.push({
      key: 'memory',
      done: memoryDone,
      total: memoryTotal,
      complete: memoryTotal > 0 && memoryDone >= memoryTotal,
      viewersDone,
      viewersTotal
    });
  }

  let percent = null;
  if (current.status === 'complete') {
    percent = 100;
  } else if (mode === 'memory' && !current.memorySkipped) {
    percent = memoryTotal > 0 ? clampPercent((memoryDone / memoryTotal) * 100) : null;
  } else if (mode === 'combined') {
    const totalUnits = (sessionSelected ? 1 : 0) + (current.memorySkipped ? 0 : memoryTotal);
    const doneUnits = (sessionDone ? 1 : 0) + memoryDone;
    percent = totalUnits > 0 ? clampPercent((doneUnits / totalUnits) * 100) : null;
  }
  // A session-only task is one request; its duration is not predictable from a
  // batch count, so it stays indeterminate until the server marks it complete.

  // Only the server's terminal "complete" state may display 100%. A failure
  // after importing every batch must not look like a successful finish.
  if (current.status !== 'complete' && percent !== null && percent >= 100) percent = 99;

  return {
    mode,
    parts,
    percent,
    indeterminate: percent === null && current.status === 'running',
    memorySkipped: current.memorySkipped === true,
    memorySkipReason: current.memorySkipReason ?? null
  };
}

export const __internal = {clampPercent};
