import test from 'node:test';
import assert from 'node:assert/strict';
import {callOpenAICompatible, normalizeUsage} from '../../src/ai/providers/adapters.mjs';

function config(providerId = 'dashscope') {
  return {
    providerId,
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    modelId: 'qwen3.8-max',
    supportsStructuredOutputs: false
  };
}

test('DashScope thinking output is bounded with max_completion_tokens and measured', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = {url, options, body: JSON.parse(options.body)};
    return Response.json({
      model: 'qwen3.8-max',
      choices: [{
        message: {content: '{"ok":true}', reasoning_content: 'think-think-think'},
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 135744,
        completion_tokens: 18684,
        total_tokens: 154428,
        completion_tokens_details: {reasoning_tokens: 10684}
      }
    });
  };
  const result = await callOpenAICompatible({
    config: config('dashscope'),
    apiKey: 'test-key',
    messages: [{role: 'user', content: 'Return JSON'}],
    maxTokens: 8000,
    maxCompletionTokens: 16000,
    streaming: false,
    fetchImpl
  });
  assert.equal(captured.body.max_tokens, 8000);
  assert.equal(captured.body.max_completion_tokens, 16000);
  assert.equal(captured.body.stream, undefined);
  assert.equal(result.requestBytes, Buffer.byteLength(JSON.stringify(captured.body), 'utf8'));
  assert.equal(result.usage.outputTokens, 18684, 'provider output includes thinking');
  assert.equal(result.usage.reasoningTokens, 10684);
  assert.equal(result.reasoningChars, 'think-think-think'.length);
});

test('non-DashScope OpenAI-compatible providers do not receive max_completion_tokens', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return Response.json({
      model: 'paid-model',
      choices: [{message: {content: '{"ok":true}'}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}
    });
  };
  await callOpenAICompatible({
    config: config('custom'),
    apiKey: 'test-key',
    messages: [{role: 'user', content: 'Return JSON'}],
    maxTokens: 8000,
    maxCompletionTokens: 16000,
    streaming: false,
    fetchImpl
  });
  assert.equal(captured.max_completion_tokens, undefined);
});

test('usage normalization reports reasoning tokens when the provider exposes them', () => {
  assert.deepEqual(normalizeUsage({
    usage: {
      prompt_tokens: 135744,
      completion_tokens: 18684,
      output_tokens_details: {reasoning_tokens: 10684}
    }
  }).reasoningTokens, 10684);
  assert.equal(normalizeUsage({usage: {prompt_tokens: 1, completion_tokens: 1}}).reasoningTokens, 0);
});
