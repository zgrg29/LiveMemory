import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callProvider,
  extractJsonObject,
  SlidingWindowLimiter
} from '../../src/ai/auto/client.mjs';
import {AutoAnalysisError} from '../../src/ai/auto/errors.mjs';

const provider = {
  id: 'test-provider',
  label: 'Test',
  endpoint: 'https://example.invalid/v1/chat/completions',
  model: 'test-model',
  timeoutMs: 5000,
  reasoningEffort: 'low',
  rateLimit: {limit: 100, windowMs: 1000}
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'}
  });
}

test('extractJsonObject accepts a plain object, one fence and surrounding prose', () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), {ok: true});
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), {ok: true});
  assert.deepEqual(extractJsonObject('Here is the answer:\n{"ok":true}\nDone.'), {ok: true});
  assert.deepEqual(extractJsonObject('{"text":"a } brace inside a string","n":1}'), {
    text: 'a } brace inside a string',
    n: 1
  });
});

test('extractJsonObject rejects arrays, empty and broken JSON', () => {
  assert.equal(extractJsonObject(''), null);
  assert.equal(extractJsonObject('[{"ok":true}]'), null);
  assert.equal(extractJsonObject('{"ok":'), null);
  assert.equal(extractJsonObject('not json at all'), null);
});

test('the sliding window limiter prunes old slots', () => {
  let now = 100000;
  const limiter = new SlidingWindowLimiter({limit: 2, windowMs: 1000, now: () => now});
  limiter.record();
  limiter.record();
  limiter.prune();
  assert.equal(limiter.timestamps.length, 2);
  now += 1001;
  limiter.prune();
  assert.equal(limiter.timestamps.length, 0);
});

test('callProvider is anonymous and sends a JSON-mode request', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = {url, options};
    return jsonResponse({
      model: 'test-model',
      choices: [{message: {content: '{"ok":true}'}}],
      usage: {prompt_tokens: 1, completion_tokens: 1}
    });
  };
  const result = await callProvider({
    provider,
    messages: [{role: 'user', content: 'hi'}],
    maxTokens: 100,
    fetchImpl,
    now: () => 1000
  });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(captured.url, provider.endpoint);
  assert.equal(captured.options.headers.authorization, undefined);
  assert.equal(captured.options.headers.cookie, undefined);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.response_format, {type: 'json_object'});
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.temperature, 0);
});

test('callProvider classifies 429 with Retry-After', async () => {
  const fetchImpl = async () => new Response('{}', {
    status: 429,
    headers: {'retry-after': '3'}
  });
  await assert.rejects(
    () => callProvider({provider, messages: [], maxTokens: 100, fetchImpl}),
    (error) => {
      assert.ok(error instanceof AutoAnalysisError);
      assert.equal(error.code, 'AUTO_RATE_LIMITED');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 3000);
      return true;
    }
  );
});

test('callProvider classifies 5xx as a retryable provider failure', async () => {
  const fetchImpl = async () => new Response('{}', {status: 503});
  await assert.rejects(
    () => callProvider({provider, messages: [], maxTokens: 100, fetchImpl}),
    (error) => {
      assert.equal(error.code, 'AUTO_PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.equal(error.httpStatus, 503);
      return true;
    }
  );
});

test('callProvider reports timeout and empty content separately', async () => {
  const timeoutFetch = async () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(
    () => callProvider({provider, messages: [], maxTokens: 100, fetchImpl: timeoutFetch}),
    (error) => error.code === 'AUTO_TIMEOUT' && error.retryable === true
  );

  const emptyFetch = async () => jsonResponse({choices: [{message: {content: ''}}]});
  await assert.rejects(
    () => callProvider({provider, messages: [], maxTokens: 100, fetchImpl: emptyFetch}),
    (error) => error.code === 'AUTO_INVALID_JSON'
  );
});

test('callProvider reports a non-JSON response body', async () => {
  const fetchImpl = async () => new Response('<html>not json</html>', {status: 200});
  await assert.rejects(
    () => callProvider({provider, messages: [], maxTokens: 100, fetchImpl}),
    (error) => error.code === 'AUTO_INVALID_JSON'
  );
});
