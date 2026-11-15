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
import {assembleSessionAnswer} from '../../src/ai/api/compact.mjs';

function mockProviderFetch() {
  return async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/models')) {
      return Response.json({data: [{id: 'mock-model'}]});
    }
    const prompt = (body?.messages ?? []).map((message) => message.content).join('\n');
    let content = 'OK';
    if (prompt.includes('Synthetic livestream chat')) {
      content = "{\"session_topics\":{\"summary\":\"summary\",\"topics\":[{\"title\":\"chat\",\"started_at\":\"2026-01-01T00:00:00Z\",\"ended_at\":\"2026-01-01T00:01:00Z\",\"summary\":\"talk\",\"key_points\":[\"point\"],\"confidence\":0.7,\"evidence\":\"observed\"}],\"sentiment\":[],\"disputes\":[],\"highlights\":[]}}";
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
  assert.equal(memoryPermission({pricingStatus: 'unknown', pricing: null, capabilities: {session: true, memory: true}, optIn: false}).allowed, true);
  assert.equal(memoryPermission({pricingStatus: 'paid', pricing: null, capabilities: {session: true, memory: true}, optIn: false}).allowed, true);
  assert.equal(memoryPermission({capabilities: {session: true, memory: false}}).allowed, false);
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
    const zeroPriced = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'zero-priced',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 0, outputPerMillion: 0, currency: 'USD'}
    });
    assert.equal(zeroPriced.pricingStatus, 'api_free', 'zero prices are accepted and display as free, not blocked');
    const noPrice = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'no-price'
    });
    assert.equal(noPrice.pricing, null);
    assert.equal(noPrice.pricingStatus, 'unknown');

    assert.throws(() => store.update(config.id, {regionId: 'intl'}), (error) => error.code === 'API_KEY_REQUIRED_FOR_REGION');
    const rotated = store.update(config.id, {regionId: 'intl', apiKey: 'test-intl-value'});
    assert.notEqual(rotated.credentialReference, config.credentialReference);
    assert.equal(store.secret(config.id), 'test-intl-value');
  } finally {
    temp.cleanup();
  }
});

test('editing a saved config keeps its id, default state and API key unless replaced', () => {
  const temp = createTempDir();
  try {
    const configFile = join(temp.dir, 'config', 'ai-providers.json');
    const store = new ProviderConfigStore({
      configFile,
      secretsDir: join(temp.dir, 'secrets'),
      now: () => Date.parse('2026-11-11T10:00:00Z')
    });
    const first = store.create({
      providerId: 'dashscope',
      regionId: 'cn-beijing',
      modelId: 'qwen-old',
      name: 'Bailian',
      apiKey: 'old-secret',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY'},
      concurrency: 3
    });
    const second = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'other-secret',
      pricingStatus: 'unknown'
    });
    store.recordTest(first.id, {
      status: 'passed',
      capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
      stages: {}
    });
    assert.equal(store.list().find((config) => config.id === first.id).capabilities.memory, true);

    // Only the model changes: same configId/default/credential, old capability
    // and stale price are invalidated, and the key is preserved.
    const edited = store.update(first.id, {modelId: 'qwen-new'});
    assert.equal(edited.id, first.id);
    assert.equal(edited.isDefault, true);
    assert.equal(edited.credentialReference, first.credentialReference);
    assert.equal(store.secret(first.id), 'old-secret');
    assert.equal(edited.modelId, 'qwen-new');
    assert.equal(edited.modelLabel, 'qwen-new');
    assert.equal(edited.contextLength, null);
    assert.equal(edited.capabilities.memory, false);
    assert.equal(edited.lastTestStatus.status, 'untested');
    assert.equal(edited.pricingStatus, 'unknown');
    assert.equal(edited.pricing, null);
    assert.equal(store.get(second.id).modelId, 'deepseek-chat');

    // A blank key is not a replacement.
    const blank = store.update(first.id, {apiKey: ''});
    assert.equal(blank.credentialReference, first.credentialReference);
    assert.equal(store.secret(first.id), 'old-secret');

    // An explicit new key replaces it without changing the id.
    const replaced = store.update(first.id, {apiKey: 'new-secret'});
    assert.equal(replaced.id, first.id);
    assert.equal(store.secret(first.id), 'new-secret');

    // Name/concurrency edits keep capability results because the model did not change.
    store.recordTest(first.id, {
      status: 'passed',
      capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
      stages: {}
    });
    const cosmetic = store.update(first.id, {name: 'Renamed', concurrency: 5});
    assert.equal(cosmetic.name, 'Renamed');
    assert.equal(cosmetic.concurrency, 5);
    assert.equal(cosmetic.capabilities.memory, true);
    assert.equal(store.secret(first.id), 'new-secret');

    // A new store instance (program restart) reads the edited model and key.
    const reloaded = new ProviderConfigStore({
      configFile,
      secretsDir: join(temp.dir, 'secrets'),
      now: () => Date.parse('2026-11-11T11:00:00Z')
    });
    reloaded.load();
    const persisted = reloaded.get(first.id);
    assert.equal(persisted.modelId, 'qwen-new');
    assert.equal(persisted.name, 'Renamed');
    assert.equal(reloaded.secret(first.id), 'new-secret');
    assert.equal(reloaded.get(second.id).modelId, 'deepseek-chat');
  } finally {
    temp.cleanup();
  }
});

test('a hard provider auth failure is reported as failed, not partial', async () => {
  const result = await verifyProviderConfig({
    config: {
      providerId: 'custom',
      protocol: 'openai',
      regionId: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: 'qwen-plus',
      allowLocalNetwork: true,
      supportsStructuredOutputs: false
    },
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      error: {message: 'Free quota exhausted. Add funds or disable use-free-tier-only mode.'}
    }), {
      status: 403,
      headers: {'content-type': 'application/json'}
    })
  });
  assert.equal(result.status, 'failed', JSON.stringify(result.stages));
  assert.equal(result.capabilities.text, false);
  assert.equal(result.stages.text.status, 'failed');
  assert.equal(result.stages.text.httpStatus, 403);
  assert.equal(result.stages.text.code, 'PROVIDER_AUTH_FAILED');
  assert.match(result.stages.text.detail, /free quota|funds/i);
  assert.equal(result.error, 'PROVIDER_AUTH_FAILED');
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

test('session metadata is generated locally and model-supplied IDs are ignored', () => {
  const assembled = assembleSessionAnswer({
    answer: {
      protocol: 'forged',
      schema_version: '0.0.0',
      analysis_scope: 'viewer_memory',
      job_id: 'forged_job',
      batch_id: 'forged_batch',
      task_id: 'forged_task',
      session_id: 'forged_session',
      locale: 'fr',
      session_topics: {
        summary: 'ok',
        topics: [],
        sentiment: [],
        disputes: [],
        highlights: []
      }
    },
    manifest: {
      job_id: 'aij_real',
      batch: {batch_id: 'aij_real-b01'},
      broadcaster_id: 'youtube:UC_real',
      tasks: [{task_id: 'ses_real-analysis'}],
      session_id: 'ses_real',
      locale: 'en'
    }
  });
  assert.equal(assembled.ok, true);
  assert.equal(assembled.result.protocol, 'livememory-analysis-result-v1');
  assert.equal(assembled.result.schema_version, '1.3.0');
  assert.equal(assembled.result.analysis_scope, 'session');
  assert.equal(assembled.result.job_id, 'aij_real');
  assert.equal(assembled.result.task_id, 'ses_real-analysis');
  assert.equal(assembled.result.session_id, 'ses_real');
  assert.equal(assembled.result.locale, 'en');
  assert.equal(assembled.result.viewer_memory_updates, undefined);
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

