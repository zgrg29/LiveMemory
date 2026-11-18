import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {CredentialBackendError} from '../../src/platforms/shared/credential-store.mjs';
import {ProviderConfigStore} from '../../src/ai/providers/store.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * HTTP-level provider storage using the same backend interface as Windows
 * Credential Manager. The backend is in-memory so these tests never read or
 * write the real user vault and can reproduce write/read failures.
 */

class MemoryCredentialBackend {
  constructor() {
    this.values = new Map();
    this.failRead = null;
    this.failWrite = null;
  }

  read(reference) {
    if (this.failRead) throw this.failRead;
    return this.values.get(reference) ?? null;
  }

  readMany(references) {
    if (this.failRead) throw this.failRead;
    return new Map(references.map((reference) => [reference, this.values.get(reference) ?? null]));
  }

  write(reference, value) {
    if (this.failWrite) throw this.failWrite;
    this.values.set(reference, value);
  }

  remove(reference) {
    this.values.delete(reference);
  }

  status() {
    return {
      backend: 'memory-test',
      available: !this.failRead,
      error: this.failRead?.code ?? null
    };
  }
}

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

function payload(overrides = {}) {
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

function seedLegacyConfig(temp, {apiKey = 'legacy-key'} = {}) {
  const seed = new ProviderConfigStore({
    configFile: join(temp.dir, 'config', 'ai-providers.json'),
    secretsDir: join(temp.dir, 'secrets')
  });
  seed.load();
  return seed.create({
    providerId: 'deepseek',
    regionId: 'global',
    modelId: 'deepseek-chat',
    apiKey
  });
}

function legacyFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.json');
}

test('a fresh save uses the injected backend, not the legacy JSON file', async (t) => {
  const temp = createTempDir();
  const backend = new MemoryCredentialBackend();
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({apiKey: 'sk-new-backend'})
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const id = created.payload.config.id;
  assert.equal(created.payload.config.hasCredential, true);
  assert.equal(server.providerConfigStore.secret(id), 'sk-new-backend');
  assert.equal(existsSync(legacyFile(temp)), false, 'a fresh install must not create ai-keys.json');
  assert.equal(readFileSync(join(temp.dir, 'config', 'ai-providers.json'), 'utf8').includes('sk-new-backend'), false);

  const updated = await jsonRequest(`${server.url}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: payload({apiKey: 'sk-updated-backend'})
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(server.providerConfigStore.secret(id), 'sk-updated-backend');

  const removed = await jsonRequest(`${server.url}api/ai/providers/configs/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(server.providerConfigStore.secret(id), null);
  assert.equal(backend.values.size, 0);
});

test('legacy credentials are migrated before the provider list is returned', async (t) => {
  const temp = createTempDir();
  const config = seedLegacyConfig(temp);
  const before = readFileSync(legacyFile(temp), 'utf8');
  const backend = new MemoryCredentialBackend();
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const list = await jsonRequest(`${server.url}api/ai/providers`);
  assert.equal(list.status, 200);
  const listed = list.payload.configs.find((entry) => entry.id === config.id);
  assert.equal(listed.hasCredential, true);
  assert.equal(backend.values.get(config.credentialReference), 'legacy-key');
  assert.equal(readFileSync(legacyFile(temp), 'utf8'), before);
  assert.equal(list.payload.loadState.legacyCredential.completed, true);
});

test('a corrupt legacy file does not block a new provider and is preserved', async (t) => {
  const temp = createTempDir();
  seedLegacyConfig(temp);
  const broken = '{"version":1,"payload":"broken","iv":"AA==","tag":"AA=="}\n';
  writeFileSync(legacyFile(temp), broken);
  const backend = new MemoryCredentialBackend();
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({
      name: 'OpenAI',
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-after-corrupt'
    })
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(server.providerConfigStore.secret(created.payload.config.id), 'sk-after-corrupt');
  assert.equal(readFileSync(legacyFile(temp), 'utf8'), broken);

  const list = await jsonRequest(`${server.url}api/ai/providers`);
  assert.equal(list.payload.loadState.legacyCredential.readable, false);
});

test('backend unavailability is a specific error, not a false save, and can be retried', async (t) => {
  const temp = createTempDir();
  const backend = new MemoryCredentialBackend();
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  backend.failWrite = new CredentialBackendError('CREDENTIAL_BACKEND_UNAVAILABLE');
  const failed = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({apiKey: 'sk-must-not-be-saved'})
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.payload.error.code, 'AI_PROVIDER_CREDENTIAL_BACKEND_UNAVAILABLE');
  assert.equal(failed.payload.error.messageKey, 'errors.aiProviderCredentialBackendUnavailable');
  assert.equal(backend.values.size, 0);
  const listAfterFailure = await jsonRequest(`${server.url}api/ai/providers`);
  assert.deepEqual(listAfterFailure.payload.configs, []);

  backend.failWrite = null;
  const retried = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({apiKey: 'sk-retry-succeeds'})
  });
  assert.equal(retried.status, 201, JSON.stringify(retried.payload));
  assert.equal(server.providerConfigStore.secret(retried.payload.config.id), 'sk-retry-succeeds');
});

test('Credential Manager access denial is classified separately', async (t) => {
  const temp = createTempDir();
  const backend = new MemoryCredentialBackend();
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  backend.failWrite = new CredentialBackendError('CREDENTIAL_BACKEND_ACCESS_DENIED', {win32: 5});
  const failed = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({apiKey: 'sk-denied'})
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.payload.error.code, 'AI_PROVIDER_CREDENTIAL_ACCESS_DENIED');
  assert.equal(failed.payload.error.details.win32, 5);
});

test('two providers keep independent backend credentials across a restart', async (t) => {
  const temp = createTempDir();
  const backend = new MemoryCredentialBackend();
  let server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const first = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({name: 'DeepSeek', apiKey: 'key-one'})
  });
  const second = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: payload({
      name: 'OpenAI',
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      apiKey: 'key-two'
    })
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.payload.config.credentialReference, second.payload.config.credentialReference);
  assert.equal(backend.values.get(first.payload.config.credentialReference), 'key-one');
  assert.equal(backend.values.get(second.payload.config.credentialReference), 'key-two');

  await server.close();
  server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    credentialStore: backend
  });
  const list = await jsonRequest(`${server.url}api/ai/providers`);
  const listed = Object.fromEntries(list.payload.configs.map((entry) => [entry.id, entry]));
  assert.equal(listed[first.payload.config.id].hasCredential, true);
  assert.equal(listed[second.payload.config.id].hasCredential, true);
  assert.equal(server.providerConfigStore.secret(second.payload.config.id), 'key-two');
});

test('the UI error renderer substitutes the server-provided path', async () => {
  const {describeError} = await import('../../src/web/js/ui.js');
  const t = (key, params = {}) => `${key}|${params.path ?? ''}`;
  const message = describeError({
    messageKey: 'errors.aiProviderCredentialPermission',
    details: {path: 'C:\\Temp\\LiveMemory'}
  }, t);
  assert.match(message, /C:\\Temp\\LiveMemory/);
  assert.equal(message.includes('{path}'), false);
});
