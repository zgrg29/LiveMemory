import test from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDER_CATALOG, getProvider, getRegion, publicCatalog} from '../../src/ai/providers/catalog.mjs';
import {callAnthropic, callOpenAICompatible, listProviderModels, normalizeUsage} from '../../src/ai/providers/adapters.mjs';
import {pricingFromOpenCodeModel} from '../../src/ai/providers/pricing.mjs';
import {providerSessionId} from '../../src/ai/providers/session.mjs';
import {APP_VERSION} from '../../src/shared/app-info.mjs';

/**
 * OpenCode Console provider (2026-11-18).
 *
 * The official facts pinned here were verified against
 * https://opencode.ai/docs/console/api and the live endpoints:
 *   - pay-as-you-go base URL `https://opencode.ai/inference/openai/v1`;
 *   - Go base URL `https://opencode.ai/inference/go/openai/v1`;
 *   - model catalogue `/inference/v1/models` (and `/inference/go/v1/models`);
 *   - `Authorization: Bearer oc_sk_…`;
 *   - Go rejects a request without `x-opencode-session` with HTTP 400
 *     `{"type":"error","error":{"type":"MissingSessionID",...}}`.
 *
 * Nothing here calls the network: every response is a synthetic `Response`.
 * A real paid request needs a user-provided key and is still outstanding.
 */

const PAYG_BASE = 'https://opencode.ai/inference/openai/v1';
const GO_BASE = 'https://opencode.ai/inference/go/openai/v1';

function sseBody(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

function chatPayload({model = 'kimi-k3', content = '{"ok":true}'} = {}) {
  return {
    model,
    choices: [{message: {content}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.00042},
    provider: 'opencode'
  };
}

test('OpenCode is a first-class OpenAI-compatible provider with two billing endpoints', () => {
  const opencode = getProvider('opencode');
  assert.ok(opencode, 'OpenCode must be in the provider catalogue');
  assert.equal(opencode.protocol, 'openai');
  assert.equal(opencode.label, 'OpenCode');
  assert.equal(opencode.docsUrl, 'https://opencode.ai/docs/console/api');
  assert.equal(opencode.keyHint, 'oc_sk_…');
  assert.equal(opencode.supportsModelList, true);
  assert.equal(opencode.supportsStructuredOutputs, false);
  assert.equal(opencode.sessionHeader, 'x-opencode-session');

  assert.deepEqual(opencode.regions.map((region) => region.id), ['payg', 'go']);
  assert.equal(opencode.regions[0].baseUrl, PAYG_BASE);
  assert.equal(opencode.regions[0].modelsUrl, 'https://opencode.ai/inference/v1/models');
  assert.equal(opencode.regions[1].baseUrl, GO_BASE);
  assert.equal(opencode.regions[1].modelsUrl, 'https://opencode.ai/inference/go/v1/models');
  // Only Go requires the conversation header (verified against the live API).
  assert.notEqual(opencode.regions[0].requiresSession, true);
  assert.equal(opencode.regions[1].requiresSession, true);
  assert.equal(getRegion('opencode', 'payg').currency, 'USD');
  assert.equal(getRegion('opencode', 'go').currency, 'USD');

  // The browser catalogue exposes the provider without leaking anything secret.
  const publicEntry = publicCatalog().find((entry) => entry.id === 'opencode');
  assert.ok(publicEntry);
  assert.equal(publicEntry.regions.length, 2);
  assert.equal(JSON.stringify(publicEntry).includes('oc_sk_1'), false);

  // Every pre-existing provider is still registered in its original order.
  assert.deepEqual(
    PROVIDER_CATALOG.map((entry) => entry.id),
    ['openai', 'anthropic', 'deepseek', 'minimax', 'dashscope', 'openrouter', 'opencode', 'custom']
  );
});

test('pay-as-you-go requests carry bearer auth, the client user agent and the session header', async () => {
  const calls = [];
  const result = await callOpenAICompatible({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'payg',
      baseUrl: PAYG_BASE,
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'system', content: 'rules'}, {role: 'user', content: 'hello'}],
    maxTokens: 6000,
    sessionId: 'ses_abcdef0123456789',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers, body: JSON.parse(options.body)});
      return Response.json(chatPayload());
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${PAYG_BASE}/chat/completions`);
  assert.equal(calls[0].headers.authorization, 'Bearer oc_sk_test_secret_value');
  assert.equal(calls[0].headers['x-opencode-session'], 'ses_abcdef0123456789');
  assert.equal(calls[0].headers['user-agent'], `LiveMemory/${APP_VERSION}`);
  // The generic OpenAI-compatible request shape is reused; no OpenCode-only body.
  assert.equal(calls[0].body.model, 'kimi-k3');
  assert.equal(calls[0].body.max_tokens, 6000);
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].body.max_completion_tokens, undefined);
  assert.equal(calls[0].body.stream, undefined);
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.providerReportedCost, 0.00042);
  // Neither the result nor its usage may echo the credential.
  assert.equal(JSON.stringify(result).includes('oc_sk_test_secret_value'), false);
});

test('streaming requests keep the session header and ask for the final usage chunk', async () => {
  const calls = [];
  const result = await callOpenAICompatible({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'payg',
      baseUrl: PAYG_BASE,
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'user', content: 'hello'}],
    maxTokens: 100,
    streaming: true,
    sessionId: 'ses_stream12345678',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers, body: JSON.parse(options.body)});
      return new Response(sseBody([
        'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"cost":0.0001}}\n\n',
        'data: [DONE]\n\n'
      ]), {headers: {'content-type': 'text/event-stream'}});
    }
  });

  assert.equal(calls[0].body.stream, true);
  // OpenCode documents `stream_options.include_usage` for Chat Completions.
  assert.deepEqual(calls[0].body.stream_options, {include_usage: true});
  assert.equal(calls[0].headers['x-opencode-session'], 'ses_stream12345678');
  assert.equal(result.responseMode, 'streaming');
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.inputTokens, 9);
  assert.equal(result.usage.providerReportedCost, 0.0001);
});

test('Go requires x-opencode-session and fails before any request when it is missing', async () => {
  let fetchCalls = 0;
  const config = {
    providerId: 'opencode',
    protocol: 'openai',
    regionId: 'go',
    baseUrl: GO_BASE,
    modelId: 'kimi-k3'
  };

  await assert.rejects(
    () => callOpenAICompatible({
      config,
      apiKey: 'oc_sk_test_secret_value',
      messages: [{role: 'user', content: 'hello'}],
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json(chatPayload());
      }
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_CONFIG_INVALID');
      assert.equal(error.detail, 'x-opencode-session-required');
      assert.equal(error.retryable, false);
      return true;
    }
  );
  assert.equal(fetchCalls, 0, 'a missing required header must not spend a request');

  const calls = [];
  await callOpenAICompatible({
    config,
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'user', content: 'hello'}],
    sessionId: 'ses_go1234567890ab',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers});
      return Response.json(chatPayload());
    }
  });
  assert.equal(calls[0].url, `${GO_BASE}/chat/completions`);
  assert.equal(calls[0].headers['x-opencode-session'], 'ses_go1234567890ab');
});

test('pay-as-you-go does not require the session header but still sends it when available', async () => {
  const calls = [];
  await callOpenAICompatible({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'payg',
      baseUrl: PAYG_BASE,
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'user', content: 'hello'}],
    fetchImpl: async (url, options) => {
      calls.push({headers: options.headers});
      return Response.json(chatPayload());
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-opencode-session'], undefined);

  await callOpenAICompatible({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'payg',
      baseUrl: PAYG_BASE,
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'user', content: 'hello'}],
    sessionId: 'ses_payg1234567890',
    fetchImpl: async (url, options) => {
      calls.push({headers: options.headers});
      return Response.json(chatPayload());
    }
  });
  assert.equal(calls[1].headers['x-opencode-session'], 'ses_payg1234567890');
});

test('the Anthropic adapter also applies the provider headers when used for an OpenCode region', async () => {
  const calls = [];
  await callAnthropic({
    config: {
      providerId: 'opencode',
      protocol: 'anthropic',
      regionId: 'payg',
      baseUrl: 'https://opencode.ai/inference/anthropic/v1',
      modelId: 'claude-sonnet-5-5'
    },
    apiKey: 'oc_sk_test_secret_value',
    messages: [{role: 'user', content: 'hello'}],
    maxTokens: 64,
    sessionId: 'ses_anthropic123456',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers});
      return Response.json({
        model: 'claude-sonnet-5-5',
        content: [{type: 'text', text: '{"ok":true}'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 3, output_tokens: 2, cost: 0.00003}
      });
    }
  });
  assert.equal(calls[0].url, 'https://opencode.ai/inference/anthropic/v1/messages');
  assert.equal(calls[0].headers['x-opencode-session'], 'ses_anthropic123456');
  assert.equal(calls[0].headers['user-agent'], `LiveMemory/${APP_VERSION}`);
  assert.equal(calls[0].headers['x-api-key'], 'oc_sk_test_secret_value');
});

test('a MissingSessionID response is reported as a configuration error with the provider message', async () => {
  await assert.rejects(
    () => callOpenAICompatible({
      config: {
        providerId: 'opencode',
        protocol: 'openai',
        regionId: 'go',
        baseUrl: GO_BASE,
        modelId: 'kimi-k3'
      },
      apiKey: 'oc_sk_test_secret_value',
      messages: [{role: 'user', content: 'hello'}],
      // Bypass the local guard on purpose: this exercises the provider path.
      sessionId: 'ses_bypass123456789',
      fetchImpl: async () => Response.json({
        type: 'error',
        error: {
          type: 'MissingSessionID',
          message: 'Request is missing x-opencode-session and cannot be routed efficiently.'
        }
      }, {status: 400})
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_CONFIG_INVALID');
      assert.match(error.detail, /x-opencode-session/);
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test('the OpenCode model catalogue is read from the documented URL and normalizes cost/context', async () => {
  const calls = [];
  const models = await listProviderModels({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'payg',
      baseUrl: PAYG_BASE,
      modelId: ''
    },
    apiKey: 'oc_sk_test_secret_value',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers});
      return Response.json({
        object: 'list',
        data: [
          {
            id: 'kimi-k3',
            object: 'model',
            name: 'Kimi K3',
            type: 'chat',
            description: 'Long-context chat model',
            limit: {context: 1000000, output: 128000},
            capabilities: {structured_output: true},
            cost: {text: {input: {price: 3, cache: {read: 0.3, write: 3}}, output: {price: 15}}},
            api: {'chat-completions': {base_url: PAYG_BASE}}
          },
          {
            id: 'big-pickle',
            object: 'model',
            name: 'Big Pickle',
            type: 'chat',
            limit: {context: 200000},
            cost: {text: {input: {price: 0}, output: {price: 0}}}
          },
          {
            id: 'an-image-model',
            object: 'model',
            name: 'Image',
            type: 'image'
          },
          {
            id: 'no-cost-model',
            object: 'model',
            name: 'No cost',
            type: 'chat'
          }
        ]
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.ai/inference/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer oc_sk_test_secret_value');
  assert.equal(calls[0].headers['user-agent'], `LiveMemory/${APP_VERSION}`);
  assert.match(calls[0].headers['x-opencode-session'], /^ses_[0-9a-f]{32}$/);

  assert.deepEqual(models.map((model) => model.id), ['kimi-k3', 'big-pickle', 'no-cost-model']);
  const paid = models[0];
  assert.equal(paid.pricingStatus, 'paid');
  assert.equal(paid.pricing.currency, 'USD');
  assert.equal(paid.pricing.inputPerMillion, 3);
  assert.equal(paid.pricing.outputPerMillion, 15);
  assert.equal(paid.pricing.cachedInputPerMillion, 0.3);
  assert.equal(paid.contextLength, 1000000);
  assert.equal(paid.structuredOutputs, true);
  assert.equal(paid.free, false);

  const free = models[1];
  assert.equal(free.pricingStatus, 'api_free');
  assert.equal(free.pricing.inputPerMillion, 0);
  assert.equal(free.contextLength, 200000);
  assert.equal(free.free, true);

  // A missing cost block is unknown, never silently "free".
  assert.equal(models[2].pricingStatus, 'unknown');
  assert.equal(models[2].pricing, null);
});

test('the Go model catalogue uses the Go base URL', async () => {
  const calls = [];
  await listProviderModels({
    config: {
      providerId: 'opencode',
      protocol: 'openai',
      regionId: 'go',
      baseUrl: GO_BASE,
      modelId: ''
    },
    apiKey: 'oc_sk_test_secret_value',
    fetchImpl: async (url, options) => {
      calls.push({url, headers: options.headers});
      return Response.json({data: []});
    }
  });
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/v1/models');
  // Console asks for a session id on every request; the catalogue call derives a
  // stable one because it is not part of an analysis task.
  assert.match(calls[0].headers['x-opencode-session'], /^ses_[0-9a-f]{32}$/);
  assert.match(calls[0].headers.authorization, /^Bearer /);
});

test('OpenCode pricing is USD per million tokens and missing cost stays unknown', () => {
  const paid = pricingFromOpenCodeModel({cost: {text: {input: {price: 2, cache: {read: 0.1}}, output: {price: 10}}}});
  assert.equal(paid.pricingStatus, 'paid');
  assert.equal(paid.pricing.inputPerMillion, 2);
  assert.equal(paid.pricing.outputPerMillion, 10);
  assert.equal(paid.pricing.cachedInputPerMillion, 0.1);

  const free = pricingFromOpenCodeModel({cost: {text: {input: {price: 0}, output: {price: 0}}}});
  assert.equal(free.pricingStatus, 'api_free');

  const unknown = pricingFromOpenCodeModel({});
  assert.equal(unknown.pricingStatus, 'unknown');
  assert.equal(unknown.pricing, null);
});

test('session ids are stable per task and isolated between tasks', () => {
  const first = providerSessionId('job', 'aij_abc');
  assert.equal(first, providerSessionId('job', 'aij_abc'));
  assert.match(first, /^ses_[0-9a-f]{32}$/);
  assert.notEqual(first, providerSessionId('job', 'aij_def'));
  assert.notEqual(first, providerSessionId('job', 'aij_abc', 'memory'));
  assert.notEqual(
    providerSessionId('translate', 'aicfg_1', 'ses_1', 'ja'),
    providerSessionId('translate', 'aicfg_1', 'ses_1', 'ko')
  );
  // No chat content or key material is part of the id.
  assert.equal(first.includes('aij_abc'), false);
});

test('OpenCode usage keeps the provider-reported charge separate from the local estimate', () => {
  const usage = normalizeUsage({
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      cost: 0.00412,
      opencode: {billing_source: 'balance', list_cost: 0.00412, tokens: {input: 1200, output: 300}}
    }
  });
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 300);
  assert.equal(usage.providerReportedCost, 0.00412);
});
