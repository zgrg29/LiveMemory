import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {WindowsCredentialStore} from '../../src/platforms/shared/credential-store.mjs';
import {ProviderConfigStore} from '../../src/ai/providers/store.mjs';

/**
 * Real Windows Credential Manager acceptance.
 *
 * This test writes random, non-production targets under the app's namespace and
 * removes them in `finally`. It is opt-in because a normal in-process test run
 * must not touch the developer's real vault:
 *
 *   $env:LIVE_MEMORY_TEST_REAL_CREDMAN='1'; node --test tests/integration/windows-credential-manager.test.mjs
 *
 * It is also run once with a temporarily elevated/full-access test harness in
 * the release verification documented in docs/TEST_PLAN.md.
 */

const enabled = process.platform === 'win32' && process.env.LIVE_MEMORY_TEST_REAL_CREDMAN === '1';

function ref() {
  return `aicred_${randomBytes(16).toString('hex')}`;
}

test('real Windows Credential Manager round-trips, updates, chunks and deletes', {skip: !enabled}, () => {
  const temp = createTempDir();
  const store = new WindowsCredentialStore({tempDir: `${temp.dir}/cache`});
  const created = [];
  try {
    const single = ref();
    created.push(single);
    store.write(single, 'real-credman-key');
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(single), 'real-credman-key');

    store.write(single, 'real-credman-key-updated');
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(single), 'real-credman-key-updated');

    const large = ref();
    created.push(large);
    const big = `${'K'.repeat(5000)}-tail`;
    store.write(large, big);
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(large), big);

    store.write(large, 'small-again');
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(large), 'small-again');

    for (const reference of created) store.remove(reference);
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(single), null);
    assert.equal(new WindowsCredentialStore({tempDir: `${temp.dir}/cache`}).read(large), null);
  } finally {
    for (const reference of created) {
      try { store.remove(reference); } catch { /* best effort cleanup */ }
    }
    temp.cleanup();
  }
});

test('real Credential Manager migrates a legacy key without touching the old file', {skip: !enabled}, () => {
  const temp = createTempDir();
  const backend = new WindowsCredentialStore({tempDir: `${temp.dir}/cache`});
  let config = null;
  try {
    const seed = new ProviderConfigStore({
      configFile: `${temp.dir}/config/ai-providers.json`,
      secretsDir: `${temp.dir}/secrets`
    });
    seed.load();
    config = seed.create({
      providerId: 'deepseek',
      regionId: 'global',
      modelId: 'deepseek-chat',
      apiKey: 'legacy-real-credman'
    });
    const legacyFile = `${temp.dir}/secrets/ai-keys.json`;
    const before = readFileSync(legacyFile, 'utf8');

    const migrated = new ProviderConfigStore({
      configFile: `${temp.dir}/config/ai-providers.json`,
      secretsDir: `${temp.dir}/secrets`,
      credentialStore: backend
    });
    migrated.load();
    assert.equal(migrated.secret(config.id), 'legacy-real-credman');
    assert.equal(readFileSync(legacyFile, 'utf8'), before);
    assert.equal(migrated.status().legacyCredential.completed, true);
  } finally {
    if (config?.credentialReference) {
      try { backend.remove(config.credentialReference); } catch { /* best effort */ }
    }
    temp.cleanup();
  }
});
