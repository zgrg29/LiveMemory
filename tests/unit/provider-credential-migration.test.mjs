import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {faultyFs} from '../helpers/faulty-fs.mjs';
import {ProviderConfigStore} from '../../src/ai/providers/store.mjs';
import {CredentialBackendError} from '../../src/platforms/shared/credential-store.mjs';

/**
 * Migration from the legacy AES-256-GCM `ai-keys.json` file to an injected
 * credential backend. No test connects to Windows Credential Manager; the
 * backend is deterministic and in-memory so write failures are reproducible.
 */

class MemoryCredentialBackend {
  constructor() {
    this.values = new Map();
    this.writes = [];
    this.removes = [];
    this.failRead = null;
    this.failWrite = null;
    this.failRemove = null;
    this.available = true;
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
    this.writes.push(reference);
    this.values.set(reference, value);
  }

  remove(reference) {
    if (this.failRemove) throw this.failRemove;
    this.removes.push(reference);
    this.values.delete(reference);
  }

  status() {
    return {
      backend: 'memory-test',
      available: this.available,
      error: this.failRead?.code ?? this.failWrite?.code ?? null
    };
  }
}

function paths(temp) {
  return {
    configFile: join(temp.dir, 'config', 'ai-providers.json'),
    secretsDir: join(temp.dir, 'secrets')
  };
}

function secretFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.json');
}

function keyFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.key');
}

function markerFile(temp) {
  return join(temp.dir, 'secrets', 'ai-keys.migration.json');
}

function seedConfig(temp, overrides = {}) {
  const store = new ProviderConfigStore(paths(temp));
  store.load();
  const config = store.create({
    providerId: 'deepseek',
    regionId: 'global',
    modelId: 'deepseek-chat',
    apiKey: 'legacy-key',
    ...overrides
  });
  return {store, config};
}

function migratedStore(temp, backend, options = {}) {
  const store = new ProviderConfigStore({
    ...paths(temp),
    credentialStore: backend,
    ...options
  });
  store.load();
  return store;
}

test('a readable legacy key is migrated, verified, and the old ciphertext stays byte-identical', () => {
  const temp = createTempDir();
  try {
    const {config} = seedConfig(temp);
    const before = readFileSync(secretFile(temp), 'utf8');
    const backend = new MemoryCredentialBackend();
    const store = migratedStore(temp, backend);

    assert.equal(backend.values.get(config.credentialReference), 'legacy-key');
    assert.equal(store.secret(config.id), 'legacy-key');
    assert.equal(readFileSync(secretFile(temp), 'utf8'), before, 'old credentials must not be modified');
    assert.equal(store.status().legacyCredential.completed, true);
    assert.equal(existsSync(markerFile(temp)), true);

    // A second load uses the marker and does not rewrite the migrated key.
    const writesBefore = backend.writes.length;
    const reloaded = migratedStore(temp, backend);
    assert.equal(reloaded.secret(config.id), 'legacy-key');
    assert.equal(backend.writes.length, writesBefore);
    assert.equal(reloaded.status().legacyCredential.fromMarker, true);
  } finally {
    temp.cleanup();
  }
});

test('a corrupt legacy store is preserved and does not block saving a new key', () => {
  const temp = createTempDir();
  try {
    const {config} = seedConfig(temp);
    const broken = '{"version":1,"payload":"broken","iv":"AA==","tag":"AA=="}\n';
    writeFileSync(secretFile(temp), broken);
    const backend = new MemoryCredentialBackend();
    const store = migratedStore(temp, backend);

    assert.equal(store.status().legacyCredential.readable, false);
    assert.equal(store.status().legacyCredential.error, 'CREDENTIAL_STORE_UNREADABLE');
    assert.equal(readFileSync(secretFile(temp), 'utf8'), broken);

    const created = store.create({
      providerId: 'openai',
      regionId: 'global',
      modelId: 'gpt-4o-mini',
      apiKey: 'new-after-corrupt'
    });
    assert.equal(store.secret(created.id), 'new-after-corrupt');
    assert.equal(readFileSync(secretFile(temp), 'utf8'), broken);
    assert.equal(store.secret(config.id), null);
  } finally {
    temp.cleanup();
  }
});

test('an unreadable legacy key file is preserved and new saves still work', () => {
  const temp = createTempDir();
  try {
    seedConfig(temp);
    writeFileSync(keyFile(temp), 'not-a-32-byte-key');
    const before = readFileSync(keyFile(temp), 'utf8');
    const backend = new MemoryCredentialBackend();
    const store = migratedStore(temp, backend);

    assert.equal(store.status().legacyCredential.readable, false);
    assert.equal(store.status().legacyCredential.error, 'CREDENTIAL_KEY_INVALID');
    assert.equal(readFileSync(keyFile(temp), 'utf8'), before);

    const created = store.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'm',
      apiKey: 'fresh-key'
    });
    assert.equal(store.secret(created.id), 'fresh-key');
    assert.equal(readFileSync(keyFile(temp), 'utf8'), before);
  } finally {
    temp.cleanup();
  }
});

test('a failed migration is retried and never deletes or rewrites the old file', () => {
  const temp = createTempDir();
  try {
    const {config} = seedConfig(temp);
    const before = readFileSync(secretFile(temp), 'utf8');
    const backend = new MemoryCredentialBackend();
    backend.failWrite = new CredentialBackendError('CREDENTIAL_BACKEND_UNAVAILABLE');

    const first = migratedStore(temp, backend);
    assert.equal(first.status().legacyCredential.completed, false);
    assert.equal(first.status().legacyCredential.failed, 1);
    assert.equal(readFileSync(secretFile(temp), 'utf8'), before);
    assert.equal(backend.values.has(config.credentialReference), false);

    backend.failWrite = null;
    const second = migratedStore(temp, backend);
    assert.equal(second.status().legacyCredential.completed, true);
    assert.equal(second.secret(config.id), 'legacy-key');
    assert.equal(readFileSync(secretFile(temp), 'utf8'), before);
  } finally {
    temp.cleanup();
  }
});

test('a legacy key remains readable when the new backend read fails', () => {
  const temp = createTempDir();
  try {
    const {config} = seedConfig(temp);
    const backend = new MemoryCredentialBackend();
    backend.failRead = new CredentialBackendError('CREDENTIAL_BACKEND_UNAVAILABLE');
    const store = migratedStore(temp, backend);

    // Migration could not write, but the encrypted legacy value is still
    // readable and is never treated as a new save success.
    assert.equal(store.secret(config.id), 'legacy-key');
    assert.equal(store.status().credentialError, 'CREDENTIAL_BACKEND_UNAVAILABLE');
    assert.equal(backend.values.size, 0);
  } finally {
    temp.cleanup();
  }
});

test('multiple providers migrate independently and keep their own keys', () => {
  const temp = createTempDir();
  try {
    const base = new ProviderConfigStore(paths(temp));
    base.load();
    const first = base.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'key-one'
    });
    const second = base.create({
      providerId: 'openai',
      regionId: 'global',
      modelId: 'gpt-4o-mini',
      apiKey: 'key-two'
    });
    const backend = new MemoryCredentialBackend();
    const store = migratedStore(temp, backend);

    assert.equal(store.secret(first.id), 'key-one');
    assert.equal(store.secret(second.id), 'key-two');

    store.update(second.id, {apiKey: 'key-two-updated'});
    assert.equal(store.secret(first.id), 'key-one');
    assert.equal(store.secret(second.id), 'key-two-updated');
    assert.equal(backend.values.get(first.credentialReference), 'key-one');
    assert.equal(backend.values.get(second.credentialReference), 'key-two-updated');

    store.remove(second.id);
    assert.equal(backend.values.has(second.credentialReference), false);
    assert.equal(backend.values.get(first.credentialReference), 'key-one');
  } finally {
    temp.cleanup();
  }
});

test('a failed config save rolls the new backend credential back', () => {
  const temp = createTempDir();
  try {
    const backend = new MemoryCredentialBackend();
    const store = new ProviderConfigStore({
      ...paths(temp),
      credentialStore: backend,
      fs: faultyFs({
        onRename: (target) => target.endsWith('ai-providers.json') ? 'EACCES' : null
      })
    });
    store.load();
    assert.throws(() => store.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'rollback-me'
    }), (error) => error.code === 'EACCES');
    assert.equal(backend.values.size, 0);
    assert.deepEqual(store.list(), []);
  } finally {
    temp.cleanup();
  }
});

test('a failed same-reference update restores the old key in the new backend', () => {
  const temp = createTempDir();
  try {
    const {config} = seedConfig(temp);
    const backend = new MemoryCredentialBackend();
    const store = migratedStore(temp, backend);
    assert.equal(store.secret(config.id), 'legacy-key');

    const fs = faultyFs({
      onRename: (target) => target.endsWith('ai-providers.json') ? 'EACCES' : null
    });
    store.fs = fs;
    assert.throws(() => store.update(config.id, {apiKey: 'new-key'}), (error) => error.code === 'EACCES');
    assert.equal(store.secret(config.id), 'legacy-key');
    assert.equal(backend.values.get(config.credentialReference), 'legacy-key');
  } finally {
    temp.cleanup();
  }
});
