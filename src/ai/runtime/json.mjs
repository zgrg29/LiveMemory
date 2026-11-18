/**
 * Shared helpers for local AI answers.
 *
 * These functions are provider-neutral. They are kept separate from the removed
 * anonymous OVH client so the configured-provider runner (and its validators)
 * do not depend on a free anonymous service.
 */

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

export function sleepWithSignal(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      cleanup();
      reject(cancellationError());
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    signal?.addEventListener?.('abort', onAbort, {once: true});
  });
}

export function cancellationError() {
  const error = new Error('ANALYSIS_CANCELED');
  error.code = 'ANALYSIS_CANCELED';
  return error;
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value, {now = Date.now()} = {}) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now());
  return null;
}

/**
 * Extract exactly one JSON object. A single Markdown fence is accepted because
 * many chat models add one; prose around the object is tolerated only when the
 * object itself is balanced and parses. Schema validation still decides whether
 * the answer is usable.
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let source = text.replace(/^\uFEFF/, '').trim();
  if (source === '') return null;
  const fence = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(source);
  if (fence) source = fence[1].trim();
  // A top-level array is not a LiveMemory result. Reject it before the
  // balanced-object scan, otherwise an array wrapper could be mistaken for a
  // legitimate answer.
  if (source.startsWith('[')) return null;
  const attempt = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(source);
  if (direct) return direct;

  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return attempt(source.slice(start, index + 1));
    }
  }
  return null;
}

/**
 * Detect a repetition loop instead of valid JSON. Kept generic: it only looks
 * for structural key names repeated many times in the tail.
 */
export function looksDegenerate(text) {
  const source = String(text ?? '');
  if (source.length < 2000) return false;
  const tail = source.slice(-6000);
  const keys = ['"viewer_memory_updates"', '"viewer_profiles"', '"session_topics"', '"viewers"'];
  let max = 0;
  for (const key of keys) {
    const occurrences = tail.split(key).length - 1;
    if (occurrences > max) max = occurrences;
  }
  return max >= 8;
}
