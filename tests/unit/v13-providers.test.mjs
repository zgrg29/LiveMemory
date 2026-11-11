import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync, existsSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {ProviderConfigStore} from '../../src/ai/providers/store.mjs';
import {verifyProviderConfig} from '../../src/ai/providers/verify.mjs';
import {pricingFromOpenRouterModel, estimateCost, memoryPermission} from '../../src/ai/providers/pricing.mjs';
import {validateBaseUrl} from '../../src/ai/providers/url-safety.mjs';
import {callAnthropic, callOpenAICompatible, listProviderModels} from '../../src/ai/providers/adapters.mjs';

function mockProviderFetch() {
  return async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/models')) {
      return Response.json({data: [{id: 'mock-model'}]});
    }
    const prompt = (body?.messages ?? []).map((message) => message.content).join('\n');
    let content = 'OK';
    if (prompt.includes('Synthetic livestream chat')) {
      content = JSON.stringify({summary: 'summary', topics: [{title: 'chat', summary: 'talk'}]});
    } else if (prompt.includes('Synthetic LiveMemory memory test')) {
      content = JSON.stringify({
        viewers: [
          {ref: 1, no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'guitar', statement: 'learning guitar', certainty: 'stated', evidence: [1]}]},
          {ref: 2, no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'drawing', statement: 'enjoys drawing', certainty: 'stated', evidence: [2]}]},
          {ref: 3, no_new_information: true, operations: []}
        ]
      });
    } else if (prompt.includes('"ok":true')) {
      content = JSON.stringify({ok: true});
    }
    return Response.json({
      model: body?.model ?? 'mock-model',
      choices: [{message: {content}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
    });
  };
}

test('provider catalogue keeps regional platforms separate', async () => {
  const {PROVIDER_CATALOG} = await import('../../src/ai/providers/catalog.mjs');
  const minimax = PROVIDER_CATALOG.find((entry) => entry.id === 'minimax');
  assert.deepEqual(minimax.regions.map((region) => region.id), ['cn', 'intl']);
  assert.notEqual(minimax.regions[0].baseUrl, minimax.regions[1].baseUrl);
  const dashscope = PROVIDER_CATALOG.find((entry) => entry.id === 'dashscope');
  assert.ok(dashscope.regions.length >= 3);
  assert.equal(dashscope.presets[0].id, 'qwen-plus');
  assert.equal(dashscope.presets[0].pricing.currency, 'CNY');
  assert.equal(PROVIDER_CATALOG.find((entry) => entry.id === 'openrouter').regions[0].baseUrl, 'https://openrouter.ai/api/v1');
});

test('OpenRouter pricing distinguishes free and paid and never infers from provider name', () => {
  const free = pricingFromOpenRouterModel({id: 'foo/bar:free', pricing: {prompt: '0', completion: '0'}});
  assert.equal(free.pricingStatus, 'api_free');
  const paid = pricingFromOpenRouterModel({id: 'foo/bar', pricing: {prompt: '0.000001', completion: '0.000002'}});
  assert.equal(paid.pricingStatus, 'paid');
  assert.equal(paid.pricing.inputPerMillion, 1);
  assert.equal(paid.pricing.outputPerMillion, 2);
  const unknown = pricingFromOpenRouterModel({id: 'foo/bar'});
  assert.equal(unknown.pricingStatus, 'unknown');
  assert.equal(memoryPermission({pricingStatus: 'unknown', pricing: null, capabilities: {session: true, memory: true}, optIn: true}).allowed, false);
  assert.equal(memoryPermission({pricingStatus: 'paid', pricing: {currency: 'USD'}, capabilities: {session: true, memory: true}, optIn: true}).allowed, true);
  const cost = estimateCost({pricing: {currency: 'USD', inputPerMillion: 1, outputPerMillion: 2}, inputTokens: 1_000_000, outputTokens: 500_000});
  assert.equal(cost.amount, 2);
});

test('base URL safety blocks metadata/private addresses unless explicitly local', () => {
  assert.throws(() => validateBaseUrl('http://169.254.169.254/latest'), /metadata|private/i);
  assert.throws(() => validateBaseUrl('http://127.0.0.1:11434/v1'), /local|private/i);
  assert.equal(validateBaseUrl('http://127.0.0.1:11434/v1', {allowLocalNetwork: true}).hostname, '127.0.0.1');
  assert.throws(() => validateBaseUrl('http://example.com/v1'), /https/i);
});

test('configuration store encrypts keys and rotates credentials on region change', () => {
  const temp = createTempDir();
  try {
    const configFile = join(temp.dir, 'config', 'ai-providers.json');
    const store = new ProviderConfigStore({
      configFile,
      secretsDir: join(temp.dir, 'secrets'),
      now: () => Date.parse('2026-11-11T10:00:00Z')
    });
    const config = store.create({
      providerId: 'minimax',
      regionId: 'cn',
      modelId: 'MiniMax-M2',
      apiKey: 'test-secret-value',
      pricingStatus: 'unknown',
      capabilities: {memory: true, session: true}
    });
    assert.equal(config.capabilities.memory, false, 'client cannot self-certify capabilities');
    assert.equal(config.hasCredential, true);
    assert.equal(config.credentialReference.startsWith('aicred_'), true);
    const raw = readFileSync(configFile, 'utf8');
    assert.equal(raw.includes('test-secret-value'), false);
    assert.equal(store.secret(config.id), 'test-secret-value');
    assert.equal(store.list()[0].apiKey, undefined);
    assert.equal(existsSync(join(temp.dir, 'secrets', 'ai-keys.json')), true);
    assert.throws(() => store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'paid-but-zero',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 0, outputPerMillion: 0, currency: 'USD'}
    }), (error) => error.code === 'PRICING_INVALID');

    assert.throws(() => store.update(config.id, {regionId: 'intl'}), (error) => error.code === 'API_KEY_REQUIRED_FOR_REGION');
    const rotated = store.update(config.id, {regionId: 'intl', apiKey: 'test-intl-value'});
    assert.notEqual(rotated.credentialReference, config.credentialReference);
    assert.equal(store.secret(config.id), 'test-intl-value');
  } finally {
    temp.cleanup();
  }
});

test('capability verification records session and memory stages separately', async () => {
  const temp = createTempDir();
  try {
    const store = new ProviderConfigStore({
      configFile: join(temp.dir, 'config', 'ai-providers.json'),
      secretsDir: join(temp.dir, 'secrets')
    });
    const config = store.create({
      providerId: 'openai',
      regionId: 'global',
      modelId: 'mock-model',
      apiKey: 'test-key',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
    });
    const result = await verifyProviderConfig({
      config: {...config, supportsModelList: true},
      apiKey: store.secret(config.id),
      fetchImpl: mockProviderFetch()
    });
    assert.equal(result.status, 'passed', JSON.stringify(result.stages));
    assert.equal(result.capabilities.network, true);
    assert.equal(result.capabilities.auth, true);
    assert.equal(result.capabilities.text, true);
    assert.equal(result.capabilities.json, true);
    assert.equal(result.capabilities.session, true);
    assert.equal(result.capabilities.memory, true);
    assert.equal(result.capabilities.multilingual, true);
    const updated = store.recordTest(config.id, result);
    assert.equal(updated.lastTestStatus.status, 'passed');
    assert.equal(updated.capabilities.memory, true);
  } finally {
    temp.cleanup();
  }
});

test('OpenAI-compatible and Anthropic adapters keep protocol differences explicit', async () => {
  let captured = null;
  const openaiResult = await callOpenAICompatible({
    config: {providerId: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-chat', supportsStructuredOutputs: true},
    apiKey: 'test-key',
    messages: [{role: 'user', content: 'hello'}],
    responseSchema: {type: 'object', properties: {ok: {type: 'boolean'}}},
    fetchImpl: async (url, options) => {
      captured = {url, options, body: JSON.parse(options.body)};
      return Response.json({model: 'deepseek-chat', choices: [{message: {content: '{"ok":true}'}, finish_reason: 'stop'}], usage: {prompt_tokens: 2, completion_tokens: 1}});
    }
  });
  assert.equal(openaiResult.text, '{"ok":true}');
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer test-key');
  assert.equal(captured.body.response_format.type, 'json_schema');

  const anthropic = await callAnthropic({
    config: {providerId: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-test'},
    apiKey: 'test-ant-key',
    messages: [{role: 'system', content: 'system rule'}, {role: 'user', content: 'hello'}],
    maxTokens: 100,
    fetchImpl: async (url, options) => {
      captured = {url, options, body: JSON.parse(options.body)};
      return Response.json({
        model: 'claude-test',
        content: [{type: 'text', text: '{"ok":true}'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 3, output_tokens: 2}
      });
    }
  });
  assert.equal(anthropic.text, '{"ok":true}');
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.options.headers['x-api-key'], 'test-ant-key');
  assert.equal(captured.body.system, 'system rule');
  assert.deepEqual(captured.body.messages, [{role: 'user', content: 'hello'}]);
});

test('OpenRouter model list normalizes price/context/structure without inventing values', async () => {
  const models = await listProviderModels({
    config: {providerId: 'openrouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', modelId: ''},
    apiKey: null,
    fetchImpl: async () => Response.json({
      data: [
        {id: 'free/model:free', name: 'Free', context_length: 4096, pricing: {prompt: '0', completion: '0'}, supported_parameters: ['structured_outputs']},
        {id: 'paid/model', name: 'Paid', context_length: 8192, pricing: {prompt: '0.000001', completion: '0.000002'}},
        {id: 'unknown/model', name: 'Unknown'}
      ]
    })
  });
  assert.equal(models[0].pricingStatus, 'api_free');
  assert.equal(models[0].structuredOutputs, true);
  assert.equal(models[1].pricingStatus, 'paid');
  assert.equal(models[1].pricing.inputPerMillion, 1);
  assert.equal(models[2].pricingStatus, 'unknown');
  assert.equal(models[2].pricing, null);
});

