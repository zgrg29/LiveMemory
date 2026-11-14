/**
 * Incremental Server-Sent Events reader for provider streaming.
 *
 * Streaming is an internal transport detail: callers only receive the finished
 * text (buffered locally) and a metrics object. Nothing is written to the
 * database until the whole answer has been validated, so a broken stream can
 * never leave a partial analysis behind.
 *
 * The reader also owns the idle watchdog. A provider that keeps sending tokens
 * is making progress and is not cut off by a fixed total timeout; a provider
 * that stops sending for `idleTimeoutMs` is aborted and reported as a timeout.
 */

export class StreamIdleTimeoutError extends Error {
  constructor(idleTimeoutMs) {
    super('stream-idle-timeout');
    this.name = 'StreamIdleTimeoutError';
    this.code = 'PROVIDER_STREAM_IDLE_TIMEOUT';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export class StreamCanceledError extends Error {
  constructor() {
    super('stream-canceled');
    this.name = 'StreamCanceledError';
    this.code = 'ANALYSIS_CANCELED';
  }
}

/** Parse one SSE block (`event:` + one or more `data:` lines). */
export function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const rawLine of String(block ?? '').split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return {event, data: dataLines.join('\n')};
}

/**
 * Read an HTTP event stream.
 *
 * @returns metrics: bytes, chunks, events, timing fields and idle statistics.
 * The caller decides how to treat event data; this function never parses the
 * model's JSON, so a provider can change chunk shape without touching the
 * analysis pipeline.
 */
export async function consumeEventStream(response, {
  signal = null,
  idleTimeoutMs = 60000,
  now = Date.now,
  abort = null,
  onEvent = null
} = {}) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    throw Object.assign(new Error('stream-body-missing'), {
      name: 'StreamInterruptedError',
      code: 'PROVIDER_STREAM_INTERRUPTED',
      detail: 'stream-body-missing'
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const startedAt = now();
  let buffer = '';
  let bytes = 0;
  let chunks = 0;
  let events = 0;
  let firstByteAt = null;
  let firstEventAt = null;
  let lastByteAt = null;
  let maxIdleMs = 0;

  const emitBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    events += 1;
    if (firstEventAt === null) firstEventAt = now();
    onEvent?.(parsed.event, parsed.data);
  };

  const drain = (flush = false) => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emitBlock(block);
    }
    if (flush && buffer.trim() !== '') {
      emitBlock(buffer);
      buffer = '';
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new StreamCanceledError();
      let idleTimer = null;
      const idleDeadline = new Promise((_, reject) => {
        idleTimer = setTimeout(() => {
          try {
            abort?.();
          } catch {
            // The abort controller may already be finished.
          }
          reject(new StreamIdleTimeoutError(idleTimeoutMs));
        }, Math.max(1000, Number(idleTimeoutMs) || 60000));
        idleTimer.unref?.();
      });
      const readPromise = reader.read();
      // If the idle watchdog wins the race, the pending read is settled by the
      // abort in `finish()`. Attach a catch so it can never become an unhandled
      // rejection after the caller has already seen the timeout.
      readPromise.catch(() => {});
      let result;
      try {
        result = await Promise.race([readPromise, idleDeadline]);
      } catch (error) {
        if (signal?.aborted) throw new StreamCanceledError();
        throw error;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (result.done) break;
      const timestamp = now();
      const chunk = result.value;
      bytes += Number(chunk?.byteLength ?? chunk?.length ?? 0);
      chunks += 1;
      if (firstByteAt === null) firstByteAt = timestamp;
      if (lastByteAt !== null) maxIdleMs = Math.max(maxIdleMs, timestamp - lastByteAt);
      lastByteAt = timestamp;
      buffer += decoder.decode(chunk, {stream: true});
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
    const finishedAt = now();
    return {
      bytes,
      chunks,
      events,
      startedAt,
      firstByteAt,
      firstEventAt,
      lastByteAt,
      finishedAt,
      maxIdleMs,
      timeToFirstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
      streamDurationMs: finishedAt - (firstByteAt ?? startedAt),
      totalMs: finishedAt - startedAt
    };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort: the stream may already be closed or aborted.
    }
  }
}

/**
 * Collect assistant text from OpenAI-compatible streaming chunks and Anthropic
 * message events. Kept independent from the transport so it is unit-testable.
 */
export function createStreamAccumulator({protocol = 'openai'} = {}) {
  const state = {
    text: '',
    finishReason: null,
    usage: null,
    done: false,
    chunkCount: 0,
    contentType: 'text',
    error: null,
    routedProvider: null,
    sawDelta: false,
    // Thinking text is counted, never buffered: the importer only receives the
    // final JSON answer, while the attempt log can show that thinking happened.
    reasoningChars: 0
  };
  const appendText = (value) => {
    if (typeof value !== 'string' || value === '') return;
    state.text += value;
    state.sawDelta = true;
  };
  const handleOpenAi = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.error) {
      state.error = payload.error;
      return;
    }
    if (payload.provider) state.routedProvider = payload.provider;
    const choice = payload.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? choice.message ?? {};
      if (typeof delta.reasoning_content === 'string') {
        state.reasoningChars += delta.reasoning_content.length;
      }
      const content = delta.content ?? choice.text;
      if (typeof content === 'string') appendText(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') appendText(part);
          else if (part?.type === 'text' && typeof part.text === 'string') appendText(part.text);
        }
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason === 'max_tokens'
        ? 'length'
        : choice.finish_reason;
    }
    if (payload.usage && typeof payload.usage === 'object') state.usage = payload.usage;
  };
  const handleAnthropic = (event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (event === 'error' || payload.type === 'error') {
      state.error = payload.error ?? {type: 'error', message: 'stream error'};
      return;
    }
    if (event === 'message_start' || payload.type === 'message_start') {
      state.usage = {...(state.usage ?? {}), ...(payload.message?.usage ?? {})};
      if (payload.message?.model) state.model = payload.message.model;
      return;
    }
    if (event === 'content_block_start' || payload.type === 'content_block_start') {
      const block = payload.content_block;
      if (block?.type === 'text' && typeof block.text === 'string') appendText(block.text);
      return;
    }
    if (event === 'content_block_delta' || payload.type === 'content_block_delta') {
      if (typeof payload.delta?.text === 'string') appendText(payload.delta.text);
      return;
    }
    if (event === 'message_delta' || payload.type === 'message_delta') {
      state.usage = {...(state.usage ?? {}), ...(payload.usage ?? {})};
      if (payload.delta?.stop_reason) {
        state.finishReason = payload.delta.stop_reason === 'max_tokens' ? 'length' : payload.delta.stop_reason;
      }
      return;
    }
    if (event === 'message_stop' || payload.type === 'message_stop') state.done = true;
  };
  return {
    state,
    add(event, data) {
      if (data === '[DONE]') {
        state.done = true;
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        // A non-JSON SSE payload is not a usable model chunk.
        return;
      }
      state.chunkCount += 1;
      if (protocol === 'anthropic') handleAnthropic(event, payload);
      else handleOpenAi(payload);
    },
    result() {
      return {...state, text: state.text.trim()};
    }
  };
}
