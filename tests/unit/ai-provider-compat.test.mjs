import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage, callOpenAICompatible} from '../../src/ai/providers/adapters.mjs';
import {isReasoningModelId} from '../../src/ai/providers/catalog.mjs';
import {verifyProviderConfig} from '../../src/ai/providers/verify.mjs';
import {addUsage} from '../../src/ai/providers/pricing.mjs';
import {resolveMaxCompletionTokens} from '../../src/ai/batching/tokens.mjs';

/**
 * P0-3 provider compatibility audit (offline).
 *
 * These tests pin the protocol facts that differ between providers and model
 * families. Nothing here calls a real (billable) endpoint: every response is a
 * synthetic `Response` object.
 */

function messageText(body) {
  return body.messages.map((message) => message.content).join('\n');
}

async function captureBody(config, {responseSchema = null, maxTokens = 100, maxCompletionTokens = null} = {}) {
  let captured = null;
  await callOpenAICompatible({
    config,
    apiKey: 'test-key',
    messages: [{role: 'system', content: 'system rule'}, {role: 'user', content: 'hello'}],
    maxTokens,
    maxCompletionTokens,
    responseSchema,
    responseFormat: responseSchema ? 'json_schema' : 'none',
    fetchImpl: async (url, options) => {
      captured = {url, body: JSON.parse(options.body)};
      return Response.json({
        model: config.modelId,
        choices: [{message: {content: '{"ok":true}'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 2, completion_tokens: 1}
      });
    }
  });
  return captured;
}

test('OpenAI reports cache writes on prompt_tokens_details.cache_write_tokens', () => {
  const usage = normalizeUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: {cached_tokens: 600, cache_write_tokens: 150},
      completion_tokens_details: {reasoning_tokens: 20}
    }
  });
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.cachedInputTokens, 600);
  assert.equal(usage.cacheWriteInputTokens, 150);
  assert.equal(usage.reasoningTokens, 20);
  // Reasoning tokens are already inside completion_tokens; they must never be
  // added to the output total a second time.
  assert.equal(usage.outputTokens, 50);
});

test('a provider-reported charge stays separate from the local cost estimate', () => {
  const usage = normalizeUsage({
    usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0012}
  });
  assert.equal(usage.providerReportedCost, 0.0012);
  const pricing = {currency: 'USD', inputPerMillion: 1, outputPerMillion: 2};
  const total = addUsage(null, usage, pricing);
  assert.equal(total.providerReportedCost, 0.0012);
  assert.equal(total.providerCostRequests, 1);
  // The estimate is derived from the entered price, never from the provider's
  // reported charge.
  assert.equal(total.cost.amount, (100 / 1e6) * 1 + (20 / 1e6) * 2);
  const without = addUsage(total, normalizeUsage({usage: {prompt_tokens: 10, completion_tokens: 2}}), null);
  assert.equal(without.providerCostRequests, 1);
  assert.equal(without.providerReportedCost, 0.0012);
});

test('reasoning model detection covers o-series and GPT-5+ but not GPT-4 family', () => {  for (const id of ['o1', 'o3-mini', 'o4-mini-2025-04-16', 'gpt-5', 'gpt-5-mini', 'gpt-6.1-sol', 'openai/o3']) {
    assert.equal(isReasoningModelId(id), true, id);
  }
  for (const id of ['gpt-4.1-mini', 'gpt-4o', 'deepseek-chat', 'qwen-plus', 'claude-sonnet-4-5', '']) {
    assert.equal(isReasoningModelId(id), false, id);
  }
});

test('OpenAI reasoning models use max_completion_tokens and omit temperature', async () => {
  const captured = await captureBody({
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'o3-mini'
  }, {maxTokens: 6000, maxCompletionTokens: 22000});
  assert.equal(captured.body.max_completion_tokens, 22000);
  assert.equal(captured.body.max_tokens, undefined);
  assert.equal(captured.body.temperature, undefined);
  // o-series replaced `system` with `developer`.
  assert.equal(captured.body.messages[0].role, 'developer');
});

test('OpenAI non-reasoning models keep temperature 0 and max_completion_tokens', async () => {
  const captured = await captureBody({
    providerId: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4.1-mini'
  }, {maxTokens: 6000});
  assert.equal(captured.body.max_completion_tokens, 6000);
  assert.equal(captured.body.max_tokens, undefined);
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.messages[0].role, 'system');
});

test('non-OpenAI families keep the documented max_tokens request shape', async () => {
  for (const providerId of ['deepseek', 'dashscope', 'minimax', 'openrouter', 'custom']) {
    const captured = await captureBody({
      providerId,
      protocol: 'openai',
      baseUrl: 'https://example.com/v1',
      modelId: 'some-model'
    }, {maxTokens: 6000});
    assert.equal(captured.body.max_tokens, 6000, providerId);
    assert.equal(captured.body.max_completion_tokens, undefined, providerId);
    assert.equal(captured.body.temperature, 0, providerId);
  }
});

test('the reasoning reserve is a ceiling, not a claim that tokens were spent', () => {
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'openai', modelId: 'gpt-4.1-mini', answerTokens: 6000
  }), null);
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'deepseek', modelId: 'deepseek-chat', answerTokens: 6000
  }), null);
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'openai', modelId: 'o3-mini', answerTokens: 6000
  }), 22000);
  // The context window still wins over the reserve.
  assert.equal(resolveMaxCompletionTokens({
    providerId: 'openai', modelId: 'o3-mini', answerTokens: 6000,
    estimatedInputTokens: 10000, contextLength: 20000
  }), 9500);
});

/* ------------------------------------------------------------------ verify */

function probeFetch({rejectSchema = false, formats = [], bodies = null} = {}) {
  return async (url, options) => {
    if (String(url).endsWith('/models')) return Response.json({data: [{id: 'mock-model'}]});
    const body = JSON.parse(options.body);
    bodies?.push(body);
    const format = body.response_format?.type ?? 'none';
    formats.push(format);
    if (rejectSchema && format === 'json_schema') {
      return Response.json({
        error: {message: "Invalid value for 'response_format': json_schema is not supported", type: 'invalid_request_error'}
      }, {status: 400, headers: {'content-type': 'application/json'}});
    }
    const text = messageText(body);
    let content = 'OK';
    if (text.includes('Synthetic livestream chat')) {
      content = JSON.stringify({
        session_topics: {
          summary: 'summary',
          topics: [{
            title: 'chat',
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T00:01:00Z',
            summary: 'talk',
            key_points: ['point'],
            confidence: 0.7,
            evidence: 'observed'
          }],
          sentiment: [],
          disputes: [],
          highlights: []
        }
      });
    } else if (text.includes('Synthetic LiveMemory memory test')) {
      content = JSON.stringify({
        viewers: [
          {ref: 1, memory: {no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'guitar', statement: 'learning guitar', certainty: 'stated', evidence: [1]}]}},
          {ref: 2, memory: {no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'drawing', statement: 'enjoys drawing', certainty: 'stated', evidence: [2]}]}},
          {ref: 3, memory: {no_new_information: true, operations: []}}
        ]
      });
    } else if (text.includes('"ok":true')) {
      content = JSON.stringify({ok: true});
    }
    return Response.json({
      model: body.model,
      choices: [{message: {content}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 10, completion_tokens: 5}
    });
  };
}

function baseConfig(overrides = {}) {
  return {
    providerId: 'openai',
    protocol: 'openai',
    regionId: 'global',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'mock-model',
    supportsModelList: true,
    supportsStructuredOutputs: true,
    ...overrides
  };
}

test('a declared structured-output provider is actually probed with json_schema', async () => {
  const formats = [];
  const result = await verifyProviderConfig({
    config: baseConfig(),
    apiKey: 'test-key',
    fetchImpl: probeFetch({formats})
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.stages));
  assert.equal(result.capabilities.structuredOutputs, true);
  // text (no schema) -> json -> session -> memory
  assert.deepEqual(formats, ['none', 'json_schema', 'json_schema', 'json_schema']);
});

test('reasoning-model capability probes reserve room for hidden reasoning', async () => {
  const bodies = [];
  const result = await verifyProviderConfig({
    config: baseConfig({modelId: 'o3-mini'}),
    apiKey: 'test-key',
    fetchImpl: probeFetch({bodies})
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.stages));
  const jsonProbe = bodies.find((body) => (
    body.messages.some((message) => String(message.content).includes('Return only {"ok":true}'))
  ));
  assert.ok(jsonProbe);
  assert.equal(jsonProbe.max_tokens, undefined);
  assert.equal(jsonProbe.temperature, undefined);
  assert.equal(jsonProbe.max_completion_tokens, 64 + 16000);
  assert.equal(jsonProbe.messages[0].role, 'developer');
});

test('a rejected json_schema downgrades once to json_object and stays usable', async () => {  const formats = [];
  const result = await verifyProviderConfig({
    config: baseConfig(),
    apiKey: 'test-key',
    fetchImpl: probeFetch({rejectSchema: true, formats})
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.stages));
  assert.equal(result.capabilities.json, true);
  assert.equal(result.capabilities.session, true);
  assert.equal(result.capabilities.memory, true);
  // The format is never silently claimed as verified.
  assert.equal(result.capabilities.structuredOutputs, false);
  assert.equal(result.stages.json.format, 'json_object');
  assert.equal(result.stages.json.formatFallbackFrom, 'json_schema');
  // json must not be retried more than once; later stages go straight to
  // json_object.
  assert.deepEqual(formats, ['none', 'json_schema', 'json_object', 'json_object', 'json_object']);
});

test('a generic 400 that only mentions schema is not retried as a format rejection', async () => {
  const result = await verifyProviderConfig({
    config: baseConfig(),
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) return Response.json({data: [{id: 'mock-model'}]});
      const body = JSON.parse(options.body);
      if (messageText(body).includes('"ok":true')) {
        return Response.json({error: {message: 'synthetic schema failure'}}, {status: 400});
      }
      return Response.json({
        model: body.model,
        choices: [{message: {content: 'OK'}, finish_reason: 'stop'}]
      });
    }
  });
  assert.equal(result.capabilities.json, false);
  assert.equal(result.stages.json.formatFallbackFrom, undefined);
});

test('an unrelated HTTP 400 is still a hard capability failure', async () => {  const result = await verifyProviderConfig({
    config: baseConfig(),
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) return Response.json({data: [{id: 'mock-model'}]});
      const body = JSON.parse(options.body);
      if (messageText(body).includes('"ok":true')) {
        return Response.json({error: {message: 'maximum context length exceeded'}}, {status: 400});
      }
      return Response.json({
        model: body.model,
        choices: [{message: {content: 'OK'}, finish_reason: 'stop'}]
      });
    }
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.capabilities.json, false);
  assert.equal(result.stages.json.code, 'PROVIDER_HTTP_ERROR');
  assert.equal(result.stages.json.formatFallbackFrom, undefined);
});
