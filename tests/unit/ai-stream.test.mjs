import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamAccumulator,
  consumeEventStream,
  parseSseBlock,
  StreamIdleTimeoutError
} from '../../src/ai/runtime/stream.mjs';

function streamFrom(chunks, {delayMs = 0} = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

test('SSE blocks accept event, data, comments and multi-line data', () => {
  assert.deepEqual(parseSseBlock('event: content_block_delta\ndata: {"a":1}\n'), {
    event: 'content_block_delta',
    data: '{"a":1}'
  });
  assert.deepEqual(parseSseBlock(': keep-alive\ndata: first\ndata: second'), {
    event: 'message',
    data: 'first\nsecond'
  });
  assert.equal(parseSseBlock(': only a comment'), null);
});

test('the stream reader reassembles events split across arbitrary chunks', async () => {
  const events = [];
  const metrics = await consumeEventStream(
    new Response(streamFrom([
      'data: {"n":',
      '1}\n\n',
      'event: custom\ndata: {"n":2}\n',
      '\n',
      'data: [DONE]\n\n'
    ]), {headers: {'content-type': 'text/event-stream'}}),
    {idleTimeoutMs: 5000, onEvent: (event, data) => events.push({event, data})}
  );
  assert.deepEqual(events, [
    {event: 'message', data: '{"n":1}'},
    {event: 'custom', data: '{"n":2}'},
    {event: 'message', data: '[DONE]'}
  ]);
  assert.ok(metrics.bytes > 0);
  assert.equal(metrics.events, 3);
  assert.ok(metrics.timeToFirstByteMs >= 0);
});

test('an idle stream is aborted as an idle timeout, not a generic network error', async () => {
  let aborted = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
      // Never closes: the watchdog must fire.
    }
  });
  await assert.rejects(
    () => consumeEventStream(new Response(stream), {
      idleTimeoutMs: 1000,
      abort: () => { aborted = true; },
      onEvent: () => {}
    }),
    (error) => {
      assert.equal(error instanceof StreamIdleTimeoutError, true);
      assert.equal(error.code, 'PROVIDER_STREAM_IDLE_TIMEOUT');
      return true;
    }
  );
  assert.equal(aborted, true);
});

test('OpenAI streaming chunks accumulate text, finish reason and usage', () => {
  const accumulator = createStreamAccumulator({protocol: 'openai'});
  accumulator.add('message', JSON.stringify({choices: [{delta: {role: 'assistant'}, finish_reason: null}]}));
  accumulator.add('message', JSON.stringify({choices: [{delta: {content: '{"session_topics":'}, finish_reason: null}]}));
  accumulator.add('message', JSON.stringify({choices: [{delta: {content: '{"summary":"ok"}}'}, finish_reason: 'stop'}]}));
  accumulator.add('message', JSON.stringify({usage: {prompt_tokens: 12, completion_tokens: 5, total_tokens: 17}}));
  accumulator.add('message', '[DONE]');
  const result = accumulator.result();
  assert.equal(result.text, '{"session_topics":{"summary":"ok"}}');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.done, true);
  assert.equal(result.usage.prompt_tokens, 12);
});

test('Anthropic streaming events accumulate text and stop reason', () => {
  const accumulator = createStreamAccumulator({protocol: 'anthropic'});
  accumulator.add('message_start', JSON.stringify({type: 'message_start', message: {usage: {input_tokens: 9}}}));
  accumulator.add('content_block_delta', JSON.stringify({type: 'content_block_delta', delta: {type: 'text_delta', text: 'hello '}}));
  accumulator.add('content_block_delta', JSON.stringify({type: 'content_block_delta', delta: {type: 'text_delta', text: 'world'}}));
  accumulator.add('message_delta', JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 4}}));
  accumulator.add('message_stop', JSON.stringify({type: 'message_stop'}));
  const result = accumulator.result();
  assert.equal(result.text, 'hello world');
  assert.equal(result.finishReason, 'end_turn');
  assert.equal(result.done, true);
  assert.equal(result.usage.input_tokens, 9);
  assert.equal(result.usage.output_tokens, 4);
});
