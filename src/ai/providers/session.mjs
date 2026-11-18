import {createHash} from 'node:crypto';

/**
 * Stable conversation identifiers for providers that group requests.
 *
 * OpenCode Console asks clients to send one session id per conversation
 * (`x-opencode-session`) so it can route requests consistently and reuse its
 * prompt cache; the Go plan rejects requests without it. LiveMemory derives the
 * id deterministically from the object that already owns the conversation:
 *
 *   - an analysis child job (`ai_jobs.id`) for session report / memory batches,
 *     the whole-session merge, repairs and automatic retries. The job row
 *     survives pause, restart and Resume, so every request of the same task
 *     carries the same id without persisting a second identifier;
 *   - a translation run (`session + target locale`) for report reading
 *     translation, so different tasks and languages stay isolated;
 *   - a capability test invocation for the probe stages.
 *
 * The id is an opaque hash: it never contains chat content, a key or a local
 * path, and it is safe to send to the provider and to show in diagnostics.
 */

const SESSION_ID_LENGTH = 32;

export function providerSessionId(...parts) {
  const material = parts
    .filter((part) => part !== null && part !== undefined && String(part) !== '')
    .map((part) => String(part))
    .join('\u0000');
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  return `ses_${digest.slice(0, SESSION_ID_LENGTH)}`;
}

export const __internal = {SESSION_ID_LENGTH};
