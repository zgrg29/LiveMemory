import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {faultyFs} from '../helpers/faulty-fs.mjs';
import {ProviderConfigStore} from '../../src/ai/providers/store.mjs';
import {EncryptedJsonStore} from '../../src/platforms/shared/secret-store.mjs';
import {sameBaseUrl} from '../../src/ai/providers/url-safety.mjs';
import {callOpenAICompatible} from '../../src/ai/providers/adapters.mjs';
import {APP_VERSION} from '../../src/shared/app-info.mjs';

/**
 * Provider save reliability.
 *
 * These tests use an isolated data directory and an injectable file system.
 * They never touch %LOCALAPPDATA%, and they never make a real API request.
 */

function newStore(temp) {
  return new ProviderConfigStore({
    configFile: join(temp.dir, 'config', 'ai-providers.json'),
    secretsDir: join(temp.dir, 'secrets'),
    now: () => Date.parse('2026-11-18T12:00:00Z')
  });
}

function secretFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.json');
}

function keyFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.key');
}

function readSecretData(temp) {
  const store = new EncryptedJsonStore({
    dir: join(temp.dir, 'secrets'),
    fileName: 'ai-keys.json',
    keyFileName: 'ai-keys.key'
  });
  const result = store.loadDetailed();
  return result.error ? {error: result.error} : result.data;
}

test('Base URL comparison treats trailing slash, host case and default port as one endpoint', () => {
  assert.equal(sameBaseUrl('https://api.deepseek.com/', 'https://api.deepseek.com'), true);
  assert.equal(sameBaseUrl('https://API.DeepSeek.com:443/v1/', 'https://api.deepseek.com/v1'), true);
  assert.equal(sameBaseUrl('https://example.com/v1/', 'https://example.com/v1'), true);
  assert.equal(sameBaseUrl('https://example.com/v1', 'https://example.com/v2'), false);
  assert.equal(sameBaseUrl('https://example.com/v1', 'http://example.com/v1'), false);
  assert.equal(sameBaseUrl('https://example.com/v1?x=1', 'https://example.com/v1?x=2'), false);
});

test('every supported provider saves with only the fields it actually needs', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const cases = [
      ['openai', 'global', 'gpt-4o-mini', 'https://api.openai.com/v1', 'openai'],
      ['deepseek', 'global', 'deepseek-chat', 'https://api.deepseek.com', 'openai'],
      ['openrouter', 'global', 'openrouter/auto', 'https://openrouter.ai/api/v1', 'openai'],
      ['opencode', 'payg', 'kimi-k3', 'https://opencode.ai/inference/openai/v1', 'openai'],
      ['opencode', 'go', 'kimi-k3', 'https://opencode.ai/inference/go/openai/v1', 'openai'],
      ['dashscope', 'cn-beijing', 'qwen-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai'],
      ['minimax', 'cn', 'MiniMax-M2', 'https://api.minimaxi.com/v1', 'openai'],
      ['minimax', 'intl', 'MiniMax-M2', 'https://api.minimax.io/v1', 'openai'],
      ['anthropic', 'global', 'claude-sonnet-4-5', 'https://api.anthropic.com/v1', 'anthropic']
    ];
    for (const [providerId, regionId, modelId, baseUrl, protocol] of cases) {
      const config = store.create({providerId, regionId, modelId, apiKey: 'sk-test'});
      assert.equal(config.providerId, providerId, providerId);
      assert.equal(config.regionId, regionId, `${providerId}/${regionId}`);
      assert.equal(config.baseUrl, baseUrl, `${providerId}/${regionId}`);
      assert.equal(config.protocol, protocol, `${providerId}/${regionId}`);
      assert.equal(config.hasCredential, true, `${providerId}/${regionId}`);
      assert.equal(store.secret(config.id), 'sk-test');
    }

    // Custom OpenAI-compatible is the only provider that may omit a key.
    const custom = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1/',
      modelId: 'custom-model:latest@2026'
    });
    assert.equal(custom.baseUrl, 'https://example.com/v1/');
    assert.equal(custom.hasCredential, false);
    assert.equal(custom.modelId, 'custom-model:latest@2026');

    // A custom endpoint with a key also saves.
    const customWithKey = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm',
      apiKey: 'custom-key'
    });
    assert.equal(customWithKey.hasCredential, true);
    assert.equal(store.secret(customWithKey.id), 'custom-key');

    // A built-in provider may not be pointed at an arbitrary host.
    assert.throws(() => store.create({
      providerId: 'openai',
      regionId: 'global',
      baseUrl: 'https://attacker.example/v1',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test'
    }), (error) => error.code === 'BASE_URL_NOT_ALLOWED');
  } finally {
    temp.cleanup();
  }
});

test('provider keys are trimmed, internal line breaks are rejected, and the key stays single-line', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const created = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: '  sk-pasted-with-trailing-newline\n'
    });
    assert.equal(store.secret(created.id), 'sk-pasted-with-trailing-newline');

    assert.throws(() => store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'sk-line1\nsk-line2'
    }), (error) => error.code === 'API_KEY_INVALID');

    assert.throws(() => store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'x'.repeat(8193)
    }), (error) => error.code === 'API_KEY_TOO_LARGE');
  } finally {
    temp.cleanup();
  }
});

test('a failed config save rolls back the new credential and leaves no config in memory', () => {
  const temp = createTempDir();
  try {
    const store = new ProviderConfigStore({
      configFile: join(temp.dir, 'config', 'ai-providers.json'),
      secretsDir: join(temp.dir, 'secrets'),
      fs: faultyFs({
        onRename: (target) => target.endsWith('ai-providers.json') ? 'EACCES' : null
      })
    });
    assert.throws(() => store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'sk-rollback'
    }), (error) => error.code === 'EACCES');
    assert.equal(store.list().length, 0, 'in-memory list must not show an unsaved config');
    assert.equal(existsSync(join(temp.dir, 'config', 'ai-providers.json')), false);
    const secrets = readSecretData(temp);
    assert.equal(secrets.error, undefined, JSON.stringify(secrets));
    assert.deepEqual(secrets.secrets, {}, 'the newly written secret must be removed on rollback');
  } finally {
    temp.cleanup();
  }
});

test('a failed same-reference key update restores the previous key', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const config = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'old-key'
    });
    const before = readFileSync(join(temp.dir, 'config', 'ai-providers.json'), 'utf8');
    const fs = faultyFs({
      onRename: (target) => target.endsWith('ai-providers.json') ? 'EACCES' : null
    });
    store.fs = fs;
    store.secrets.fs = fs;

    assert.throws(() => store.update(config.id, {apiKey: 'new-key'}), (error) => error.code === 'EACCES');
    assert.equal(store.secret(config.id), 'old-key');
    assert.equal(readFileSync(join(temp.dir, 'config', 'ai-providers.json'), 'utf8'), before);
    assert.equal(store.get(config.id).credentialReference, config.credentialReference);
  } finally {
    temp.cleanup();
  }
});

test('a failed endpoint change keeps the old key and old config', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const config = store.create({
      providerId: 'minimax',
      regionId: 'cn',
      modelId: 'MiniMax-M2',
      apiKey: 'cn-old-key'
    });
    const fs = faultyFs({
      onRename: (target) => target.endsWith('ai-providers.json') ? 'EACCES' : null
    });
    store.fs = fs;
    store.secrets.fs = fs;

    assert.throws(() => store.update(config.id, {
      regionId: 'intl',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'intl-new-key'
    }), (error) => error.code === 'EACCES');

    assert.equal(store.get(config.id).regionId, 'cn');
    assert.equal(store.get(config.id).credentialReference, config.credentialReference);
    assert.equal(store.secret(config.id), 'cn-old-key');
    const secrets = readSecretData(temp);
    assert.equal(secrets.error, undefined, JSON.stringify(secrets));
    assert.deepEqual(Object.values(secrets.secrets).map((entry) => entry.apiKey), ['cn-old-key']);
  } finally {
    temp.cleanup();
  }
});

test('a failed new-key write leaves the old key untouched', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const config = store.create({
      providerId: 'minimax',
      regionId: 'cn',
      modelId: 'MiniMax-M2',
      apiKey: 'cn-old-key'
    });
    store.secrets.fs = faultyFs({
      onWrite: (path) => path.endsWith('ai-keys.json.tmp') ? 'EACCES' : null
    });
    assert.throws(() => store.update(config.id, {
      regionId: 'intl',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'intl-new-key'
    }), (error) => error.code === 'EACCES');
    assert.equal(store.get(config.id).regionId, 'cn');
    assert.equal(store.get(config.id).credentialReference, config.credentialReference);
    assert.equal(store.secret(config.id), 'cn-old-key');
  } finally {
    temp.cleanup();
  }
});

test('an unreadable encrypted store is never overwritten by a new save', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const config = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'keep-this-key'
    });
    const broken = '{"version":1,"payload":"broken","iv":"AA==","tag":"AA=="}\n';
    writeFileSync(secretFile(temp), broken);

    assert.match(store.status().credentialError, /^CREDENTIAL_(STORE_UNREADABLE|STORE_INVALID)$/);
    assert.throws(() => store.create({
      providerId: 'openai',
      regionId: 'global',
      modelId: 'gpt-4o-mini',
      apiKey: 'overwrite-attempt'
    }), (error) => ['CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_INVALID'].includes(error.code));
    assert.equal(readFileSync(secretFile(temp), 'utf8'), broken, 'the corrupted store must stay byte-identical');
    assert.equal(store.get(config.id).modelId, 'deepseek-chat');
  } finally {
    temp.cleanup();
  }
});

test('an unreadable per-install key is never regenerated or overwritten', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'keep-this-key'
    });
    writeFileSync(keyFile(temp), 'not-a-valid-32-byte-key');
    const before = readFileSync(keyFile(temp), 'utf8');

    assert.throws(() => store.create({
      providerId: 'openai',
      regionId: 'global',
      modelId: 'gpt-4o-mini',
      apiKey: 'new-key'
    }), (error) => error.code === 'CREDENTIAL_KEY_INVALID');
    assert.equal(readFileSync(keyFile(temp), 'utf8'), before);
    assert.equal(store.status().credentialError, 'CREDENTIAL_KEY_INVALID');
  } finally {
    temp.cleanup();
  }
});

test('a corrupt provider config is preserved and reported instead of silently replaced', () => {
  const temp = createTempDir();
  try {
    const configFile = join(temp.dir, 'config', 'ai-providers.json');
    mkdirSync(join(temp.dir, 'config'), {recursive: true});
    const broken = '{"version":1,"configs":[';
    writeFileSync(configFile, broken);

    const store = newStore(temp);
    store.load();
    assert.equal(store.loadState.error, 'AI_PROVIDER_CONFIG_UNREADABLE');
    assert.equal(store.list().length, 0);
    assert.ok(store.loadState.backupFile, 'a backup file must be preserved');
    assert.equal(readFileSync(store.loadState.backupFile, 'utf8'), broken);

    const created = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'new-key'
    });
    assert.equal(store.list().length, 1);
    assert.equal(store.secret(created.id), 'new-key');
    assert.equal(readFileSync(store.loadState.backupFile, 'utf8'), broken);
  } finally {
    temp.cleanup();
  }
});

test('old unknown fields are ignored, while an unknown provider entry is preserved in a backup', () => {
  const temp = createTempDir();
  try {
    const configFile = join(temp.dir, 'config', 'ai-providers.json');
    const store = newStore(temp);
    const config = store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'legacy-key'
    });
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    raw.configs[0].legacyProviderFlag = 'old-value';
    raw.configs.push({id: 'future', providerId: 'future-provider', regionId: 'x', modelId: 'm'});
    writeFileSync(configFile, JSON.stringify(raw, null, 2));

    const reloaded = newStore(temp);
    reloaded.load();
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(config.id).modelId, 'deepseek-chat');
    assert.equal(reloaded.loadState.skipped, 1);
    assert.equal(reloaded.loadState.error, 'AI_PROVIDER_CONFIG_PARTIAL');
    assert.ok(reloaded.loadState.backupFile);
  } finally {
    temp.cleanup();
  }
});

test('a full-form update preserves the context length and never turns null into zero', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const withContext = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm',
      contextLength: 128000,
      apiKey: 'k'
    });
    const renamed = store.update(withContext.id, {name: 'Renamed'});
    assert.equal(renamed.contextLength, 128000);

    const noContext = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm2',
      apiKey: 'k'
    });
    assert.equal(noContext.contextLength, null);
    const renamedAgain = store.update(noContext.id, {name: 'Renamed again'});
    assert.equal(renamedAgain.contextLength, null);
  } finally {
    temp.cleanup();
  }
});

test('a legacy config without a credential reference gets one when a key is saved', () => {
  const temp = createTempDir();
  try {
    const store = newStore(temp);
    const config = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm'
    });
    const internal = store.get(config.id);
    internal.credentialReference = '';
    store.save();

    const updated = store.update(config.id, {apiKey: 'legacy-added-key'});
    assert.match(updated.credentialReference, /^aicred_/);
    assert.equal(updated.hasCredential, true);
    assert.equal(store.secret(config.id), 'legacy-added-key');
  } finally {
    temp.cleanup();
  }
});

test('a custom OpenCode endpoint receives the required session header and user agent', async () => {
  let captured = null;
  const result = await callOpenAICompatible({
    config: {
      providerId: 'custom',
      protocol: 'openai',
      baseUrl: 'https://opencode.ai/inference/openai/v1',
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test',
    messages: [{role: 'user', content: 'hello'}],
    sessionId: 'ses_custom_test',
    responseFormat: 'none',
    fetchImpl: async (url, options) => {
      captured = {url, headers: options.headers, body: JSON.parse(options.body)};
      return Response.json({
        model: 'kimi-k3',
        choices: [{message: {content: 'OK'}, finish_reason: 'stop'}]
      });
    }
  });
  assert.equal(result.text, 'OK');
  assert.equal(captured.headers['x-opencode-session'], 'ses_custom_test');
  assert.equal(captured.headers['user-agent'], `LiveMemory/${APP_VERSION}`);

  // A missing session id fails locally, before OpenCode answers 400.
  await assert.rejects(callOpenAICompatible({
    config: {
      providerId: 'custom',
      protocol: 'openai',
      baseUrl: 'https://opencode.ai/inference/openai/v1',
      modelId: 'kimi-k3'
    },
    apiKey: 'oc_sk_test',
    messages: [{role: 'user', content: 'hello'}],
    responseFormat: 'none',
    fetchImpl: async () => {
      throw new Error('must not be called');
    }
  }), (error) => error.code === 'PROVIDER_CONFIG_INVALID');

  // An arbitrary custom host must never receive the OpenCode header.
  let otherHeaders = null;
  await callOpenAICompatible({
    config: {
      providerId: 'custom',
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm'
    },
    apiKey: 'k',
    messages: [{role: 'user', content: 'hello'}],
    responseFormat: 'none',
    fetchImpl: async (url, options) => {
      otherHeaders = options.headers;
      return Response.json({
        model: 'm',
        choices: [{message: {content: 'OK'}, finish_reason: 'stop'}]
      });
    }
  });
  assert.equal(otherHeaders['x-opencode-session'], undefined);
  assert.equal(otherHeaders['user-agent'], undefined);
});
