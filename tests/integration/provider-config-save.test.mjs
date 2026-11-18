import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {faultyFs} from '../helpers/faulty-fs.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * Browser-facing save flow: real local HTTP route, real ProviderConfigStore,
 * real encrypted credential file. Only the outbound provider `fetch` is mocked
 * (and must stay unused while saving).
 */

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not JSON */ }
  return {status: response.status, payload};
}

function configPayload(overrides = {}) {
  return {
    name: 'DeepSeek',
    providerId: 'deepseek',
    regionId: 'global',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    pricing: null,
    concurrency: 3,
    timeoutMs: 180000,
    batchInputTokens: null,
    allowLocalNetwork: false,
    ...overrides
  };
}

test('a fresh install lists every provider and has no saved configuration', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const list = await jsonRequest(`${server.url}api/ai/providers`);
  assert.equal(list.status, 200);
  assert.ok(list.payload.providers.some((provider) => provider.id === 'opencode'));
  assert.ok(list.payload.providers.some((provider) => provider.id === 'deepseek'));
  assert.ok(list.payload.providers.some((provider) => provider.id === 'custom'));
  assert.deepEqual(list.payload.configs, []);
  assert.equal(list.payload.loadState.error, null);
  assert.equal(list.payload.loadState.credentialError, null);
});

test('saving a valid configuration never calls the provider network', async (t) => {
  const temp = createTempDir();
  let networkCalls = 0;
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async () => {
        networkCalls += 1;
        throw new Error('save must not perform a provider request');
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-valid'})
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.config.hasCredential, true);
  assert.equal(networkCalls, 0, 'creating a config must not test the provider');

  const patched = await jsonRequest(`${server.url}api/ai/providers/configs/${encodeURIComponent(created.payload.config.id)}`, {
    method: 'PATCH',
    body: configPayload({modelId: 'deepseek-reasoner'})
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.payload));
  assert.equal(patched.payload.config.modelId, 'deepseek-reasoner');
  assert.equal(networkCalls, 0, 'editing a config must not test the provider');
  assert.equal(server.providerConfigStore.secret(created.payload.config.id), 'sk-valid');
});

test('validation failures carry distinct codes and message keys', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;

  const newlineKey = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-first\nsk-second'})
  });
  assert.equal(newlineKey.status, 400);
  assert.equal(newlineKey.payload.error.code, 'AI_PROVIDER_KEY_INVALID');
  assert.equal(newlineKey.payload.error.messageKey, 'errors.aiProviderKeyInvalid');

  const unknownProvider = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({providerId: 'not-a-provider', apiKey: 'sk-valid'})
  });
  assert.equal(unknownProvider.status, 400);
  assert.equal(unknownProvider.payload.error.code, 'AI_PROVIDER_UNKNOWN');
  assert.equal(unknownProvider.payload.error.messageKey, 'errors.aiProviderUnknown');

  const noModel = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({modelId: '', apiKey: 'sk-valid'})
  });
  assert.equal(noModel.status, 400);
  assert.equal(noModel.payload.error.code, 'AI_PROVIDER_MODEL_REQUIRED');
  assert.equal(noModel.payload.error.messageKey, 'errors.aiProviderModelRequired');

  const noKey = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: ''})
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.payload.error.code, 'AI_PROVIDER_KEY_REQUIRED');
  assert.equal(noKey.payload.error.messageKey, 'errors.aiProviderKeyRequired');

  const wrongHost = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({baseUrl: 'https://attacker.example/v1', apiKey: 'sk-valid'})
  });
  assert.equal(wrongHost.status, 400);
  assert.equal(wrongHost.payload.error.code, 'AI_PROVIDER_BASE_URL_NOT_ALLOWED');
  assert.equal(wrongHost.payload.error.messageKey, 'errors.aiProviderBaseUrlNotAllowed');

  // A missing config id is a 404, not a generic save failure.
  const missing = await jsonRequest(`${base}api/ai/providers/configs/aicfg_missing`, {
    method: 'PATCH',
    body: {name: 'Missing'}
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error.code, 'NOT_FOUND');
  assert.equal(missing.payload.error.messageKey, 'errors.aiProviderConfigNotFound');
});

test('a key pasted with a trailing newline is accepted and stored trimmed', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: '  sk-pasted-from-dashboard\n'})
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(
    server.providerConfigStore.secret(created.payload.config.id),
    'sk-pasted-from-dashboard'
  );
});

test('a legacy trailing-slash Base URL saves from the form without re-entering the key', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-legacy'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;

  // Simulate an old record or a hand-edited JSON: same endpoint, trailing slash.
  server.providerConfigStore.get(id).baseUrl = 'https://api.deepseek.com/';
  server.providerConfigStore.save();

  const saved = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: configPayload({modelId: 'deepseek-reasoner'})
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.config.baseUrl, 'https://api.deepseek.com');
  assert.equal(saved.payload.config.credentialReference, created.payload.config.credentialReference);
  assert.equal(saved.payload.config.hasCredential, true);
  assert.equal(saved.payload.config.contextLength, null);
  assert.equal(server.providerConfigStore.secret(id), 'sk-legacy');
});

test('a legacy custom trailing-slash Base URL keeps its saved key', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://EXAMPLE.com:443/v1/',
      modelId: 'm',
      apiKey: 'custom-key'
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const id = created.payload.config.id;
  server.providerConfigStore.get(id).baseUrl = 'https://example.com/v1/';
  server.providerConfigStore.save();

  const saved = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm2',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.config.credentialReference, created.payload.config.credentialReference);
  assert.equal(saved.payload.config.hasCredential, true);
  assert.equal(server.providerConfigStore.secret(id), 'custom-key');
});

test('switching OpenCode to DeepSeek requires a new key but then saves and keeps the config', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      name: 'OpenCode',
      providerId: 'opencode',
      regionId: 'payg',
      modelId: 'kimi-k3',
      apiKey: 'oc_sk_old'
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const id = created.payload.config.id;

  const withoutKey = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: configPayload()
  });
  assert.equal(withoutKey.status, 400);
  assert.equal(withoutKey.payload.error.code, 'AI_PROVIDER_REGION_KEY_REQUIRED');
  assert.equal(withoutKey.payload.error.messageKey, 'errors.aiProviderKeyRequiredForChange');

  const withKey = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: configPayload({apiKey: 'sk-new-deepseek'})
  });
  assert.equal(withKey.status, 200, JSON.stringify(withKey.payload));
  assert.equal(withKey.payload.config.providerId, 'deepseek');
  assert.equal(withKey.payload.config.regionId, 'global');
  assert.equal(withKey.payload.config.baseUrl, 'https://api.deepseek.com');
  assert.equal(withKey.payload.config.hasCredential, true);
  assert.equal(server.providerConfigStore.secret(id), 'sk-new-deepseek');
  assert.equal(server.providerConfigStore.list().length, 1, 'switching must edit, not duplicate');
});

test('switching DeepSeek to a custom OpenAI-compatible endpoint saves with a new key', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-deepseek'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;
  const switched = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      name: 'Custom',
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'custom-chat',
      apiKey: 'custom-secret',
      pricing: null,
      concurrency: 3,
      timeoutMs: 180000,
      batchInputTokens: null,
      allowLocalNetwork: false
    }
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.payload));
  assert.equal(switched.payload.config.providerId, 'custom');
  assert.equal(switched.payload.config.baseUrl, 'https://example.com/v1');
  assert.equal(switched.payload.config.hasCredential, true);
  assert.equal(server.providerConfigStore.secret(id), 'custom-secret');
  assert.equal(server.providerConfigStore.list().length, 1);
});

test('a failed save can be retried without losing the original config or key', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-retry'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;
  const originalFs = server.providerConfigStore.fs;
  server.providerConfigStore.fs = faultyFs({
    onRename: (target) => target.endsWith('ai-providers.json') ? 'EBUSY' : null
  });
  try {
    const failed = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: configPayload({name: 'Locked attempt'})
    });
    assert.equal(failed.status, 409);
  } finally {
    server.providerConfigStore.fs = originalFs;
  }
  const retried = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: configPayload({name: 'Retried successfully'})
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.payload));
  assert.equal(retried.payload.config.name, 'Retried successfully');
  assert.equal(server.providerConfigStore.secret(id), 'sk-retry');
});

test('a credential write failure is reported as a local permission error, not an invalid config', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'old-key'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;
  const originalFs = server.providerConfigStore.secrets.fs;
  server.providerConfigStore.secrets.fs = faultyFs({
    onWrite: (path) => path.endsWith('ai-keys.json.tmp') ? 'EACCES' : null
  });
  try {
    const failed = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: configPayload({apiKey: 'new-key'})
    });
    assert.equal(failed.status, 500);
    assert.equal(failed.payload.error.code, 'AI_PROVIDER_CREDENTIAL_PERMISSION');
    assert.equal(failed.payload.error.messageKey, 'errors.aiProviderCredentialPermission');
    assert.equal(failed.payload.error.details.reason, 'EACCES');
  } finally {
    server.providerConfigStore.secrets.fs = originalFs;
  }
  assert.equal(server.providerConfigStore.secret(id), 'old-key');
});

test('a locked config file is reported as a lock, not an invalid config', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'old-key'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;
  const originalFs = server.providerConfigStore.fs;
  server.providerConfigStore.fs = faultyFs({
    onRename: (target) => target.endsWith('ai-providers.json') ? 'EBUSY' : null
  });
  try {
    const failed = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: configPayload({modelId: 'deepseek-reasoner'})
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.payload.error.code, 'AI_PROVIDER_FILE_LOCKED');
    assert.equal(failed.payload.error.messageKey, 'errors.aiProviderFileLocked');
  } finally {
    server.providerConfigStore.fs = originalFs;
  }
  assert.equal(server.providerConfigStore.get(id).modelId, 'deepseek-chat');
});

test('a corrupt config file is reported and preserved, then a new config can be saved', async (t) => {
  const temp = createTempDir();
  mkdirSync(join(temp.dir, 'config'), {recursive: true});
  const configFile = join(temp.dir, 'config', 'ai-providers.json');
  const broken = '{"version":1,"configs":[';
  writeFileSync(configFile, broken);
  const server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const list = await jsonRequest(`${server.url}api/ai/providers`);
  assert.equal(list.status, 200);
  assert.equal(list.payload.configs.length, 0);
  assert.equal(list.payload.loadState.error, 'AI_PROVIDER_CONFIG_UNREADABLE');
  assert.ok(list.payload.loadState.backupFile);
  assert.equal(existsSync(list.payload.loadState.backupFile), true);
  assert.equal(readFileSync(list.payload.loadState.backupFile, 'utf8'), broken);

  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-fresh'})
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(readFileSync(list.payload.loadState.backupFile, 'utf8'), broken);
});

test('saved configuration and key survive a restart and can be edited again', async (t) => {
  const temp = createTempDir();
  let server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: configPayload({apiKey: 'sk-persisted'})
  });
  assert.equal(created.status, 201);
  const id = created.payload.config.id;
  await server.close();

  server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const list = await jsonRequest(`${server.url}api/ai/providers`);
  const listed = list.payload.configs.find((config) => config.id === id);
  assert.ok(listed);
  assert.equal(listed.hasCredential, true);
  assert.equal(server.providerConfigStore.secret(id), 'sk-persisted');

  const edited = await jsonRequest(`${server.url}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: configPayload({modelId: 'deepseek-reasoner'})
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(server.providerConfigStore.secret(id), 'sk-persisted');

  await server.close();
  server = await startServer({auth: false, dataDir: temp.dir, port: 0, systemLocale: 'en'});
  const afterRestart = await jsonRequest(`${server.url}api/ai/providers`);
  const final = afterRestart.payload.configs.find((config) => config.id === id);
  assert.equal(final.modelId, 'deepseek-reasoner');
  assert.equal(final.hasCredential, true);
});
