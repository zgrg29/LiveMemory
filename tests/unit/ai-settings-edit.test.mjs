import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const source = read('src/web/js/pages/ai-settings.js');
const routes = read('src/server/routes.mjs');
const store = read('src/ai/providers/store.mjs');

function valueAt(object, key) {
  return key.split('.').reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), object);
}

test('a saved provider card exposes edit mode that reuses the existing form', () => {
  assert.ok(source.includes("t('ai.v13.providers.edit')"), 'missing edit button');
  assert.ok(source.includes('beginEdit(config)'), 'edit button does not enter edit mode');
  assert.ok(source.includes('function beginEdit(config)'), 'missing beginEdit');
  assert.ok(source.includes('function resetForm()'), 'missing cancel/reset');
  assert.ok(source.includes("t('ai.v13.providers.editTitle')"), 'missing edit title');
  assert.ok(source.includes("t('ai.v13.providers.saveChanges')"), 'missing save-changes label');
  assert.ok(source.includes('nameInput'), 'missing editable display name');
  assert.ok(source.includes('cancelButton'), 'missing cancel button');
  assert.ok(source.includes('editingId'), 'missing edit target id');
  assert.ok(source.includes('api.patch(`/api/ai/providers/configs/'), 'edit must PATCH the existing config');
  assert.equal(source.includes("api.post('/api/ai/providers/configs', payload)"), true, 'create path must remain');
});

test('the edit form never sends a blank key over an existing credential', () => {
  assert.ok(source.includes('const keyProvided = keyInput.value.trim() !== \'\''), 'missing blank-key detection');
  assert.ok(source.includes('if (keyProvided) payload.apiKey = keyInput.value;'), 'key must be conditional');
  assert.ok(source.includes("t('ai.v13.providers.keyKeepHint')"), 'missing keep-key hint');
  assert.ok(source.includes("t('ai.v13.providers.keyStoredEdit')"), 'missing saved-key status');
  assert.ok(source.includes("t('ai.v13.providers.keyRequiredForChange')"), 'missing region-change key guard');
  assert.ok(source.includes("t('ai.v13.providers.modelChangedReverify')"), 'missing model-change warning');
});

test('the backend preserves credentials and invalidates capability on model-only edits', () => {
  assert.ok(store.includes('modelChanged'), 'missing model-change detection');
  assert.ok(store.includes('credentialReference: nextReference'), 'missing credential reference handling');
  assert.ok(store.includes('API_KEY_REQUIRED_FOR_REGION'), 'region change must require a new key');
  assert.ok(store.includes('normalizeCapabilities(null)'), 'model change must clear capability');
  assert.ok(store.includes("status: 'untested'"), 'model change must reset test status');
  assert.ok(store.includes('PRICING_STATUS.UNKNOWN'), 'model change must clear stale pricing');
  assert.ok(store.includes("delete merged.modelLabel"), 'model label must update with the model');
  assert.ok(store.includes("delete merged.contextLength"), 'context length must not carry across models');
});

test('the PATCH route omits unspecified pricing and blocks a config in use', () => {
  assert.ok(routes.includes("Object.prototype.hasOwnProperty.call(body, 'pricing')"), 'partial PATCH must not clear pricing');
  assert.ok(routes.includes('isConfigInUse?.(params.id)'), 'running config must be protected');
  assert.ok(routes.includes("code === 'AI_PROVIDER_CONFIG_IN_USE'"), 'in-use error mapping missing');
  assert.ok(routes.includes("CONFIG_CHANGED: ['AI_PROVIDER_CONFIG_CHANGED'"), 'resume mismatch mapping missing');
});

test('edit labels exist in all three dictionaries', () => {
  const keys = [
    'ai.v13.providers.edit',
    'ai.v13.providers.editTitle',
    'ai.v13.providers.editHint',
    'ai.v13.providers.saveChanges',
    'ai.v13.providers.updated',
    'ai.v13.providers.name',
    'ai.v13.providers.keyStoredEdit',
    'ai.v13.providers.keyKeepHint',
    'ai.v13.providers.keyNewHint',
    'ai.v13.providers.keyRequiredForChange',
    'ai.v13.providers.modelChangedReverify',
    'errors.aiProviderConfigInUse',
    'errors.aiProviderConfigChanged'
  ];
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const dict = JSON.parse(read(`src/web/i18n/${locale}.json`));
    for (const key of keys) {
      const value = valueAt(dict, key);
      assert.equal(typeof value, 'string', `${locale} missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});
