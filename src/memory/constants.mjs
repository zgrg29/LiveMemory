import {DAY} from '../shared/time.mjs';

/**
 * Versioned constants for the long-term memory round trip (M7).
 *
 * The analysis protocol (M6) is untouched. Memory updates use their own
 * protocol so an older/newer package can never be mistaken for session
 * analysis, and so the two validators stay independent.
 */

export const MEMORY_PROTOCOL = 'livememory-memory-update-v1';
export const MEMORY_SCHEMA_VERSION = '1.0.0';
export const ACCEPTED_MEMORY_SCHEMA_VERSIONS = Object.freeze(['1.0.0']);

export const MEMORY_PROMPT_VERSION = 'lm-prompt-m7.1';

export function memoryPromptVersionFor(locale) {
  return `${MEMORY_PROMPT_VERSION}-${SUPPORTED_MEMORY_LOCALES.includes(locale) ? locale : 'en'}`;
}

export const SUPPORTED_MEMORY_LOCALES = Object.freeze(['zh-CN', 'ja', 'en']);

/** Atomic knowledge kinds. Deliberately small: everything else is `other`. */
export const MEMORY_KIND = Object.freeze({
  INTEREST: 'interest',
  DISLIKE: 'dislike',
  IDENTITY: 'identity',
  LIFE_EVENT: 'life_event',
  TOPIC: 'topic',
  PREFERENCE: 'preference',
  COMMUNITY: 'community',
  OTHER: 'other'
});

export const MEMORY_KINDS = Object.freeze(Object.values(MEMORY_KIND));

/**
 * `stated`  – the viewer explicitly said it in chat.
 * `inferred` – the AI derived it; must never be presented as a fact.
 * `uncertain` – cannot be confirmed from the chat at all.
 */
export const MEMORY_CERTAINTY = Object.freeze({
  STATED: 'stated',
  INFERRED: 'inferred',
  UNCERTAIN: 'uncertain'
});

export const MEMORY_CERTAINTIES = Object.freeze(Object.values(MEMORY_CERTAINTY));

/**
 * `active`            – believed true now.
 * `outdated`          – may no longer be true (never deleted automatically).
 * `conflicted`        – two statements disagree; a human must decide.
 * `superseded`        – explicitly replaced by a newer state.
 * `needs_confirmation`– inference / uncertainty that a human should review.
 */
export const MEMORY_STATUS = Object.freeze({
  ACTIVE: 'active',
  OUTDATED: 'outdated',
  CONFLICTED: 'conflicted',
  SUPERSEDED: 'superseded',
  NEEDS_CONFIRMATION: 'needs_confirmation'
});

export const MEMORY_STATUSES = Object.freeze(Object.values(MEMORY_STATUS));

export const MEMORY_OPERATION = Object.freeze({
  ADD: 'add',
  CONFIRM: 'confirm',
  UPDATE: 'update',
  SUPERSEDE: 'supersede',
  CONFLICT: 'conflict',
  OUTDATED: 'outdated',
  UNCERTAIN: 'uncertain'
});

export const MEMORY_OPERATIONS = Object.freeze(Object.values(MEMORY_OPERATION));

/** Operations that must reference an existing fact. */
export const TARGETED_OPERATIONS = Object.freeze([
  MEMORY_OPERATION.CONFIRM,
  MEMORY_OPERATION.UPDATE,
  MEMORY_OPERATION.SUPERSEDE,
  MEMORY_OPERATION.CONFLICT,
  MEMORY_OPERATION.OUTDATED
]);

export const MEMORY_SOURCE_KIND = Object.freeze({
  AI_UPDATE: 'ai_memory_update',
  SESSION_RESULT: 'session_result',
  MANUAL: 'manual',
  ROLLBACK: 'rollback'
});

/* ------------------------------------------------------------------ limits */

export const MAX_MEMORY_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_VIEWERS_PER_BATCH = 20;
export const MIN_VIEWERS_PER_BATCH = 1;
export const MAX_MESSAGES_PER_VIEWER = 120;
export const MAX_MESSAGES_PER_BATCH = 2000;
export const MAX_OPS_PER_VIEWER = 40;
export const MAX_EVIDENCE_PER_OP = 50;
export const MAX_STATEMENT_LENGTH = 400;
export const MAX_TOPIC_LENGTH = 80;
export const MAX_SUMMARY_LENGTH = 800;

/** Versions keep enough history for a rollback without unbounded growth. */
export const MEMORY_VERSIONS_KEPT = 20;

/**
 * An `active` interest/topic/preference that has not been confirmed for this
 * long is marked `outdated` (never deleted, never turned into a dislike).
 */
export const MEMORY_OUTDATED_AFTER_MS = 180 * DAY;

/** Facts that are still true regardless of age. */
export const TIMELESS_KINDS = Object.freeze([MEMORY_KIND.IDENTITY]);

export function memoryTaskId(sessionId) {
  return `${sessionId}-memory`;
}

export function memoryBatchTaskId(sessionId, batchIndex, batchTotal) {
  return batchTotal <= 1
    ? memoryTaskId(sessionId)
    : `${sessionId}-memory-b${String(batchIndex).padStart(2, '0')}`;
}

export function memoryBatchId(jobId, batchIndex) {
  return `${jobId}-b${String(batchIndex).padStart(2, '0')}`;
}
