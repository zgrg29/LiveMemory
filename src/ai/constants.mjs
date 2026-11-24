/**
 * Versioned AI file contract constants.
 *
 * The package protocol stays `livememory-analysis-v1` and the result protocol
 * stays `livememory-analysis-result-v1`; M6 only *adds* optional fields and a
 * batch wrapper, so packages and results produced by earlier versions remain
 * readable. The prompt version is recorded per job and per package so a user can
 * tell which instructions produced a given result.
 */
import {AI_OUTPUT_LOCALES, DEFAULT_LOCALE} from '../shared/locale.mjs';

export const ANALYSIS_PROTOCOL = 'livememory-analysis-v1';
export const RESULT_PROTOCOL = 'livememory-analysis-result-v1';

/** Revision of the result schema. 1.0.0 results (no schema_version) still validate. */
export const RESULT_SCHEMA_VERSION = '1.3.0';
export const ACCEPTED_RESULT_SCHEMA_VERSIONS = Object.freeze(['1.0.0', '1.1.0', '1.2.0', '1.3.0']);

/**
 * Prompt revisions.
 *
 * P41 added an explicit output-language contract to every prompt surface (system
 * prompt, packaged instructions, memory instructions, aggregate/digest rules and
 * repair requests) and widened the language set to all ten AI output languages.
 * The revision is bumped so a job created before and after the change can be
 * told apart; old jobs keep the version stored on their row, and old results are
 * never rewritten.
 */
export const PROMPT_VERSION = 'lm-prompt-m6.4';
export const PROMPT_VERSION_V13 = 'lm-prompt-v13.3';
export const MEMORY_PROMPT_VERSION_V13 = 'lm-prompt-v13.4';

export const ANALYSIS_MODE = Object.freeze({
  SESSION: 'session',
  MEMORY: 'memory',
  COMBINED: 'combined'
});

/**
 * Unified analysis + memory batching. A viewer is assigned to exactly one
 * analysis batch; that batch contains all of the viewer's session messages as
 * excerpts, so a long-term memory answer is never split across two batches.
 */
export const MEMORY_VIEWERS_PER_BATCH = 200;
export const MAX_MEMORY_EXCERPT_MESSAGES = 3000;
export const MAX_MESSAGES_PER_VIEWER_EXCERPT = 120;

/**
 * Declared AI output languages.
 *
 * This is the interface-language registry narrowed to the entries whose prompt
 * set, result schema and translation target name really exist (`aiOutput`).
 * P41 gave every shipped language that support, so all ten are analysis output
 * languages. The narrowing remains the capability gate: a language without
 * `aiOutput: true` (or an unknown tag such as `th-TH`) can never reach a
 * provider, and `promptVersionFor()` degrades to `DEFAULT_LOCALE` instead of
 * inventing a locale.
 */
export const SUPPORTED_LOCALES = AI_OUTPUT_LOCALES;

export function promptVersionFor(locale, mode = ANALYSIS_MODE.COMBINED) {
  const safeLocale = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const safeMode = Object.values(ANALYSIS_MODE).includes(mode) ? mode : ANALYSIS_MODE.COMBINED;
  if (safeMode === ANALYSIS_MODE.COMBINED) return `${PROMPT_VERSION}-${safeLocale}`;
  return `${safeMode === ANALYSIS_MODE.MEMORY ? MEMORY_PROMPT_VERSION_V13 : PROMPT_VERSION_V13}-${safeMode}-${safeLocale}`;
}

/** Default and bounds for one analyzable batch. Configurable per job. */
export const DEFAULT_BATCH_MESSAGES = 1000;
export const MIN_BATCH_MESSAGES = 100;
export const MAX_BATCH_MESSAGES = 5000;

/** Technical resource guards only; these are not product batch limits. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_ANALYSIS_MESSAGES = 1000000;
export const MAX_ANALYSIS_VIEWERS = 200000;
export const MAX_REPORT_EVIDENCE = 400;

export const TASK_KIND = Object.freeze({
  SESSION_ANALYSIS: 'session_analysis',
  SESSION_AGGREGATE: 'session_analysis_aggregate',
  VIEWER_MEMORY: 'viewer_memory_analysis',
  LEGACY_TOPICS: 'session_topics',
  LEGACY_VIEWERS: 'viewer_profile_update'
});

/** Task id used inside a package manifest (and therefore inside the answer). */
export function batchTaskId(sessionId, batchIndex, batchTotal) {
  return batchTotal === 1
    ? `${sessionId}-analysis`
    : `${sessionId}-analysis-b${String(batchIndex).padStart(2, '0')}`;
}

export function aggregateTaskId(sessionId) {
  return `${sessionId}-analysis-final`;
}
