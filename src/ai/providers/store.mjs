import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {createId} from '../../shared/ids.mjs';
import {EncryptedJsonStore} from '../../platforms/shared/secret-store.mjs';
import {FileCredentialBackend} from '../../platforms/shared/credential-store.mjs';
import {getProvider, getRegion, PRICING_STATUS} from './catalog.mjs';
import {normalizePricing, normalizePricingStatus} from './pricing.mjs';
import {sameBaseUrl, validateBaseUrl} from './url-safety.mjs';

/**
 * API configurations and encrypted credentials.
 *
 * `config/ai-providers.json` contains no secret. In production the API key is a
 * generic Windows Credential Manager credential (DPAPI-protected, scoped to the
 * current user SID), keyed by an opaque random `credentialReference`. The
 * historical `secrets/ai-keys.json` AES file is only read for migration and as
 * an encrypted read-only fallback; new keys are never written there.
 *
 * A config stores only the reference. Changing provider/region/base URL rotates
 * that reference so an old region's key can never be silently reused.
 */

const FILE_VERSION = 1;
const MAX_API_KEY_BYTES = 8192;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 600000;
const MIN_BATCH_INPUT_TOKENS = 2000;
const MAX_BATCH_INPUT_TOKENS = 32000;

/**
 * Stable local-storage error with a machine-readable code. File system errors
 * keep their original `code` (EACCES/EBUSY/...) and path; the HTTP layer maps
 * them to a specific message instead of collapsing them into "invalid config".
 */
function storeError(code, {message = null, path = null, cause = null, details = null} = {}) {
  const error = new Error(message ?? code);
  error.code = code;
  if (path) error.path = path;
  if (cause) error.cause = cause;
  if (details) error.details = details;
  return error;
}

function normalizeConcurrency(value, {fallback = DEFAULT_CONCURRENCY} = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(number)));
}

function normalizeTimeoutMs(value, {fallback = DEFAULT_TIMEOUT_MS} = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(10000, Math.min(MAX_TIMEOUT_MS, Math.floor(number)));
}

/**
 * Optional per-request input-token budget. `null` means "derive from the model
 * context window" (the runner's documented default), which keeps the default
 * adaptive instead of hard-coding one batch size for every model.
 */
function normalizeBatchInputTokens(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(MIN_BATCH_INPUT_TOKENS, Math.min(MAX_BATCH_INPUT_TOKENS, Math.floor(number)));
}

function normalizeCapabilities(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    network: source.network === true,
    auth: source.auth === true,
    text: source.text === true,
    json: source.json === true,
    structuredOutputs: source.structuredOutputs === true,
    session: source.session === true,
    memory: source.memory === true,
    multilingual: source.multilingual === true,
    testedAt: typeof source.testedAt === 'string' ? source.testedAt : null,
    model: typeof source.model === 'string' ? source.model : null,
    providerId: typeof source.providerId === 'string' ? source.providerId : null,
    regionId: typeof source.regionId === 'string' ? source.regionId : null
  };
}

function normalizeTestStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {status: 'untested', at: null, error: null, stages: null, usage: null};
  }
  return {
    status: ['untested', 'running', 'passed', 'failed', 'partial'].includes(input.status)
      ? input.status
      : 'untested',
    at: typeof input.at === 'string' ? input.at : null,
    error: typeof input.error === 'string' ? input.error.slice(0, 200) : null,
    stages: input.stages && typeof input.stages === 'object' ? input.stages : null,
    // A capability test makes real billable requests. Keeping its usage next to
    // the status lets the settings page show what the last test cost instead of
    // hiding those requests.
    usage: input.usage && typeof input.usage === 'object' && !Array.isArray(input.usage)
      ? input.usage
      : null,
    testedAt: typeof input.testedAt === 'string' ? input.testedAt : null
  };
}

function normalizeConfig(raw, {now = Date.now()} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const providerId = String(raw.providerId ?? '');
  const provider = getProvider(providerId);
  if (!provider) return null;
  const regionId = String(raw.regionId ?? provider.regions[0]?.id ?? '');
  const region = getRegion(providerId, regionId);
  if (!region) return null;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? provider.label).slice(0, 80),
    providerId,
    protocol: provider.protocol,
    regionId,
    baseUrl: String(raw.baseUrl ?? region.baseUrl).slice(0, 1000),
    credentialReference: String(raw.credentialReference ?? ''),
    modelId: String(raw.modelId ?? '').slice(0, 200),
    modelLabel: String(raw.modelLabel ?? raw.modelId ?? '').slice(0, 200),
    supportsModelList: provider.supportsModelList === true,
    supportsStructuredOutputs: provider.supportsStructuredOutputs === true,
    docsUrl: provider.docsUrl ?? null,
    pricingStatus: normalizePricingStatus(raw.pricingStatus),
    pricing: normalizePricing(raw.pricing),
    capabilities: normalizeCapabilities(raw.capabilities),
    lastTestStatus: normalizeTestStatus(raw.lastTestStatus),
    isDefault: raw.isDefault === true,
    allowLocalNetwork: raw.allowLocalNetwork === true,
    contextLength: raw.contextLength === null || raw.contextLength === undefined
      ? null
      : (Number.isFinite(Number(raw.contextLength)) ? Number(raw.contextLength) : null),
    // A safe starting concurrency, not a claimed provider quota. The scheduler
    // lowers it on 429 and slowly restores it; the UI shows the live value.
    concurrency: normalizeConcurrency(raw.concurrency),
    timeoutMs: normalizeTimeoutMs(raw.timeoutMs),
    batchInputTokens: normalizeBatchInputTokens(raw.batchInputTokens),
    createdAt: Number(raw.createdAt ?? now),
    updatedAt: Number(raw.updatedAt ?? now)
  };
}

function publicConfig(config) {
  return {
    id: config.id,
    name: config.name,
    providerId: config.providerId,
    protocol: config.protocol,
    regionId: config.regionId,
    baseUrl: config.baseUrl,
    credentialReference: config.credentialReference,
    hasCredential: Boolean(config.credentialReference),
    supportsModelList: config.supportsModelList,
    supportsStructuredOutputs: config.supportsStructuredOutputs,
    docsUrl: config.docsUrl,
    modelId: config.modelId,
    modelLabel: config.modelLabel,
    pricingStatus: config.pricingStatus,
    pricing: config.pricing,
    capabilities: config.capabilities,
    lastTestStatus: config.lastTestStatus,
    isDefault: config.isDefault,
    allowLocalNetwork: config.allowLocalNetwork,
    contextLength: config.contextLength,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    batchInputTokens: config.batchInputTokens,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

export class ProviderConfigStore {
  constructor({
    configFile,
    secretsDir,
    now = Date.now,
    fs = {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync},
    secretStore = null,
    credentialStore = null
  }) {
    if (!configFile) throw new Error('ProviderConfigStore: configFile is required');
    this.file = configFile;
    this.now = now;
    this.fs = fs;
    this.configs = [];
    this.loadState = {error: null, skipped: 0, backupFile: null};
    const injected = credentialStore ?? secretStore;
    // Without an injected backend the store keeps the historical encrypted-file
    // behaviour. The launcher opts into Windows Credential Manager explicitly;
    // this keeps every existing in-process test and embedded use isolated from
    // the real user vault.
    this.credentialStore = injected ?? new FileCredentialBackend({
      dir: secretsDir,
      fs,
      // Never regenerate an unreadable per-install key: that would make every
      // saved API key undecryptable and overwrite the only copy of the key.
      strictKey: true
    });
    // Keep the historical property name for callers/tests that inspect the
    // backing store. For the file backend this is the same object.
    this.secrets = this.credentialStore;
    // Legacy credentials are read only when a different backend was injected.
    // They are never written, renamed or deleted by this class.
    this.legacySecrets = injected
      ? new EncryptedJsonStore({
        dir: secretsDir,
        fileName: 'ai-keys.json',
        keyFileName: 'ai-keys.key',
        fs,
        strictKey: true
      })
      : null;
    this.legacyStatus = null;
    this.credentialState = {error: null, win32: null};
  }

  load() {
    this.#loadConfigs();
    this.#prepareCredentials();
    return this.list();
  }

  #loadConfigs() {
    this.configs = [];
    this.loadState = {error: null, skipped: 0, backupFile: null};
    if (!this.fs.existsSync(this.file)) return;

    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      // The file is there but unreadable. Do not overwrite it: the caller can
      // show a permission error and the user can repair the folder.
      this.loadState.error = 'AI_PROVIDER_CONFIG_UNREADABLE';
      this.loadState.cause = error?.code ?? 'READ_FAILED';
      return;
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#preserveUnreadable(text, 'unreadable');
      this.loadState.error = 'AI_PROVIDER_CONFIG_UNREADABLE';
      return;
    }
    if (raw?.version !== FILE_VERSION || !Array.isArray(raw.configs)) {
      // A newer/unknown format is never silently replaced by an empty list:
      // keep the original bytes next to the file before offering a fresh start.
      this.#preserveUnreadable(text, 'unsupported');
      this.loadState.error = 'AI_PROVIDER_CONFIG_VERSION_UNSUPPORTED';
      return;
    }

    const normalized = raw.configs.map((entry) => normalizeConfig(entry, {now: this.now()}));
    this.configs = normalized.filter(Boolean);
    const skipped = raw.configs.length - this.configs.length;
    if (skipped > 0) {
      // A future provider or region id, or an old record with no recognisable
      // provider, must not disappear without a trace.
      this.#preserveUnreadable(text, 'partial');
      this.loadState.error = 'AI_PROVIDER_CONFIG_PARTIAL';
      this.loadState.skipped = skipped;
    }
    if (!this.configs.some((entry) => entry.isDefault) && this.configs.length > 0) {
      this.configs[0].isDefault = true;
    }
  }

  #preserveUnreadable(text, reason) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.${reason}-${stamp}.json`;
    try {
      this.fs.writeFileSync(backup, text, {mode: 0o600});
      this.loadState.backupFile = backup;
    } catch {
      // Preserving support data is best effort and must not block startup.
    }
  }

  save() {
    this.fs.mkdirSync(dirname(this.file), {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    this.fs.writeFileSync(temp, `${JSON.stringify({
      version: FILE_VERSION,
      savedAt: new Date(this.now()).toISOString(),
      configs: this.configs
    }, null, 2)}\n`, {mode: 0o600});
    this.fs.renameSync(temp, this.file);
    return this.file;
  }

  /**
   * Migrate legacy encrypted-file keys, then warm the new backend once.
   *
   * Migration is per reference and only ever writes a value that is not already
   * present in the new backend. A crash at any point is safe: the next load
   * sees the already-migrated reference and skips it. The old ciphertext is
   * never renamed, truncated or deleted, so a migration failure can always be
   * retried and a downgrade still finds the original file.
   */
  #prepareCredentials() {
    this.legacyStatus = null;
    this.credentialState = {error: null, win32: null};
    this.legacyDataLoaded = false;
    this.legacyData = null;
    if (this.legacySecrets) this.#migrateLegacy();

    const references = this.configs
      .map((config) => config.credentialReference)
      .filter(Boolean);
    if (references.length === 0) return;
    try {
      if (typeof this.credentialStore.readMany === 'function') {
        this.credentialStore.readMany(references);
      } else {
        for (const reference of references) this.credentialStore.read(reference);
      }
      this.credentialState = {error: null, win32: null};
    } catch (error) {
      this.#recordCredentialError(error);
    }
  }

  #recordCredentialError(error) {
    this.credentialState = {
      error: error?.code ?? 'CREDENTIAL_BACKEND_UNAVAILABLE',
      win32: error?.win32 ?? null
    };
  }

  #legacyBackendName() {
    return this.credentialStore?.status?.().backend ?? 'custom';
  }

  #legacyMarkerFile() {
    return join(dirname(this.legacySecrets.file), 'ai-keys.migration.json');
  }

  #legacySourceHash() {
    try {
      const text = this.fs.readFileSync(this.legacySecrets.file, 'utf8');
      return createHash('sha256').update(text, 'utf8').digest('hex');
    } catch {
      return null;
    }
  }

  #migrationMarkerMatches() {
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.#legacyMarkerFile(), 'utf8'));
      return raw?.version === 1
        && raw?.backend === this.#legacyBackendName()
        && typeof raw?.sourceSha256 === 'string'
        && raw.sourceSha256 === this.#legacySourceHash();
    } catch {
      return false;
    }
  }

  #writeMigrationMarker({migrated, alreadyPresent}) {
    const sourceSha256 = this.#legacySourceHash();
    if (!sourceSha256) return false;
    const marker = this.#legacyMarkerFile();
    const temp = `${marker}.${process.pid}.tmp`;
    try {
      this.fs.mkdirSync(dirname(marker), {recursive: true});
      this.fs.writeFileSync(temp, `${JSON.stringify({
        version: 1,
        backend: this.#legacyBackendName(),
        sourceSha256,
        migrated,
        alreadyPresent,
        completedAt: new Date(this.now()).toISOString()
      }, null, 2)}\n`, {mode: 0o600});
      this.fs.renameSync(temp, marker);
      return true;
    } catch {
      // The marker is an optimization. Migration remains idempotent without it.
      return false;
    }
  }

  #migrateLegacy() {
    const loaded = this.legacySecrets.loadDetailed();
    if (loaded.error === 'CREDENTIAL_STORE_MISSING') {
      this.legacyStatus = {present: false, readable: true};
      return;
    }
    if (loaded.error) {
      // An unreadable legacy store is never modified. New keys still go to the
      // new backend, so a corrupt old file cannot block a new configuration.
      this.legacyStatus = {
        present: true,
        readable: false,
        error: loaded.error,
        path: this.legacySecrets.file
      };
      return;
    }

    if (this.#migrationMarkerMatches()) {
      this.legacyStatus = {present: true, readable: true, completed: true, fromMarker: true};
      return;
    }

    const legacySecrets = loaded.data?.secrets && typeof loaded.data.secrets === 'object'
      ? loaded.data.secrets
      : {};
    const references = [...new Set(this.configs
      .map((config) => config.credentialReference)
      .filter(Boolean))];
    const status = {
      present: true,
      readable: true,
      referenced: references.length,
      migrated: 0,
      alreadyPresent: 0,
      failed: 0,
      completed: false,
      error: null
    };
    if (references.length === 0) {
      status.completed = true;
      if (this.#writeMigrationMarker({migrated: 0, alreadyPresent: 0})) {
        status.fromMarker = false;
      }
      this.legacyStatus = status;
      return;
    }

    let current;
    try {
      current = typeof this.credentialStore.readMany === 'function'
        ? this.credentialStore.readMany(references)
        : new Map(references.map((reference) => [reference, this.credentialStore.read(reference)]));
    } catch (error) {
      this.#recordCredentialError(error);
      status.error = error?.code ?? 'CREDENTIAL_BACKEND_UNAVAILABLE';
      status.failed = references.length;
      this.legacyStatus = status;
      return;
    }

    for (const reference of references) {
      const legacyValue = legacySecrets[reference]?.apiKey;
      if (typeof legacyValue !== 'string' || legacyValue.length === 0) continue;
      if (typeof current.get(reference) === 'string' && current.get(reference).length > 0) {
        status.alreadyPresent += 1;
        continue;
      }
      try {
        this.credentialStore.write(reference, legacyValue);
        const verified = this.credentialStore.read(reference);
        if (verified !== legacyValue) {
          throw storeError('CREDENTIAL_BACKEND_VERIFY_FAILED', {
            message: 'migrated credential could not be read back',
            details: {backend: this.#legacyBackendName()}
          });
        }
        status.migrated += 1;
      } catch (error) {
        status.failed += 1;
        status.error = error?.code ?? 'CREDENTIAL_BACKEND_MIGRATION_FAILED';
        this.#recordCredentialError(error);
        // A backend-wide failure will fail every remaining write; stop instead
        // of starting one PowerShell process per provider.
        if (status.error !== 'CREDENTIAL_BACKEND_VERIFY_FAILED') break;
      }
    }

    if (status.failed === 0) {
      status.completed = true;
      this.#writeMigrationMarker({
        migrated: status.migrated,
        alreadyPresent: status.alreadyPresent
      });
    }
    this.legacyStatus = status;
  }

  /**
   * Read a legacy value only when the new backend has none. This keeps an old
   * key working if migration was blocked, while a key saved to the new backend
   * always wins. The old file is never written by this path.
   */
  #legacySecret(reference) {
    if (!this.legacySecrets) return null;
    if (!this.legacyDataLoaded) {
      this.legacyDataLoaded = true;
      const loaded = this.legacySecrets.loadDetailed();
      this.legacyData = loaded.error ? null : (loaded.data?.secrets ?? null);
    }
    const value = this.legacyData?.[reference]?.apiKey;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /** Safe browser-facing state, including a corrupted credential store. */
  status() {
    const backendStatus = this.credentialStore?.status?.() ?? null;
    let credentialError = this.credentialState.error ?? null;
    let credentialWin32 = this.credentialState.win32 ?? null;
    if (!credentialError && backendStatus?.error) {
      credentialError = backendStatus.error;
      credentialWin32 = backendStatus.win32 ?? null;
    }
    return {
      ...this.loadState,
      credentialError,
      credentialWin32,
      credentialBackend: backendStatus,
      legacyCredential: this.legacyStatus
    };
  }

  list() {
    return this.configs.map((config) => ({
      ...publicConfig(config),
      hasCredential: this.#hasSecretSafe(config.id)
    }));
  }

  get(id) {
    return this.configs.find((entry) => entry.id === id) ?? null;
  }

  getPublic(id) {
    const config = this.get(id);
    return config ? {...publicConfig(config), hasCredential: this.#hasSecretSafe(id)} : null;
  }

  getDefault() {
    return this.configs.find((entry) => entry.isDefault) ?? this.configs[0] ?? null;
  }

  #hasSecretSafe(id) {
    try {
      return this.hasSecret(id);
    } catch {
      return false;
    }
  }

  #storeSecret(reference, apiKey) {
    try {
      this.credentialStore.write(reference, apiKey);
      this.credentialState = {error: null, win32: null};
    } catch (error) {
      this.#recordCredentialError(error);
      throw error;
    }
  }

  #readSecret(reference) {
    if (!reference) return null;
    let backendError = null;
    try {
      const value = this.credentialStore.read(reference);
      this.credentialState = {error: null, win32: null};
      if (typeof value === 'string' && value.length > 0) return value;
    } catch (error) {
      backendError = error;
      this.#recordCredentialError(error);
    }
    const legacy = this.#legacySecret(reference);
    if (legacy) return legacy;
    if (backendError) throw backendError;
    return null;
  }

  #removeSecretQuietly(reference) {
    if (!reference) return;
    try {
      this.credentialStore.remove(reference);
    } catch {
      // The config no longer references the secret; an orphaned ciphertext is
      // preferable to failing a successful save or losing the config.
    }
  }

  #restoreSecretQuietly(reference, apiKey) {
    try {
      if (apiKey === null || apiKey === undefined) {
        this.credentialStore.remove(reference);
      } else {
        this.credentialStore.write(reference, apiKey);
      }
    } catch {
      // Rollback is best effort; the caller still reports the original failure.
    }
  }

  /** Read a secret. Never exposed by an HTTP response. */
  secret(id) {
    const config = this.get(id);
    if (!config?.credentialReference) return null;
    return this.#readSecret(config.credentialReference);
  }

  hasSecret(id) {
    return Boolean(this.secret(id));
  }

  #validate(input, {existing = null} = {}) {
    const providerId = String(input.providerId ?? existing?.providerId ?? '');
    const provider = getProvider(providerId);
    if (!provider) throw Object.assign(new Error('PROVIDER_UNKNOWN'), {code: 'PROVIDER_UNKNOWN'});
    const regionId = String(input.regionId ?? existing?.regionId ?? provider.regions[0]?.id ?? '');
    const region = getRegion(providerId, regionId);
    if (!region) throw Object.assign(new Error('REGION_UNKNOWN'), {code: 'REGION_UNKNOWN'});
    const isCustom = Boolean(provider.custom);
    const requestedBaseUrl = String(input.baseUrl ?? (isCustom ? existing?.baseUrl ?? '' : region.baseUrl)).trim();
    if (!requestedBaseUrl) throw Object.assign(new Error('BASE_URL_REQUIRED'), {code: 'BASE_URL_REQUIRED'});
    const allowLocalNetwork = input.allowLocalNetwork === undefined
      ? Boolean(existing?.allowLocalNetwork)
      : input.allowLocalNetwork === true;
    try {
      validateBaseUrl(requestedBaseUrl, {allowLocalNetwork});
    } catch (error) {
      throw Object.assign(new Error(error.code ?? 'BASE_URL_INVALID'), {
        code: error.code ?? 'BASE_URL_INVALID',
        details: error.details ?? null
      });
    }
    // Known providers must use their official regional base URL. This prevents a
    // key from being sent to an arbitrary host by editing the JSON. Trailing
    // slashes, host case and an explicit default port are the same endpoint.
    if (!isCustom && !sameBaseUrl(requestedBaseUrl, region.baseUrl)) {
      throw Object.assign(new Error('BASE_URL_NOT_ALLOWED'), {code: 'BASE_URL_NOT_ALLOWED'});
    }
    // Store the catalogue's canonical URL for built-in providers so a legacy
    // trailing slash cannot make a later form save look like an endpoint change.
    const baseUrl = isCustom ? requestedBaseUrl : region.baseUrl;
    const modelId = String(input.modelId ?? existing?.modelId ?? '').trim();
    const modelChanged = Boolean(existing && modelId !== existing.modelId);
    const pricing = Object.prototype.hasOwnProperty.call(input, 'pricing')
      ? normalizePricing(input.pricing)
      : normalizePricing(existing?.pricing);
    // Pricing is optional display metadata. A partial or empty price simply
    // means "unknown"; it never blocks a request, a capability test, or memory.
    const pricingStatus = pricing
      ? (pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0
        ? PRICING_STATUS.API_FREE
        : PRICING_STATUS.PAID)
      : PRICING_STATUS.UNKNOWN;
    return {
      provider,
      region,
      baseUrl,
      allowLocalNetwork,
      modelId,
      pricingStatus,
      pricing,
      name: String(input.name ?? existing?.name ?? provider.label).trim().slice(0, 80) || provider.label,
      modelLabel: String(input.modelLabel ?? (modelChanged ? modelId : existing?.modelLabel) ?? modelId).slice(0, 200),
      // A full form PATCH carries no `contextLength`, but `merged` already
      // contains the stored `null`. Treat null/empty as "not supplied" instead
      // of letting `Number(null) === 0` overwrite it with a fake zero context.
      contextLength: (input.contextLength === undefined
        || input.contextLength === null
        || input.contextLength === '')
        ? (modelChanged ? null : (existing?.contextLength ?? null))
        : (Number.isFinite(Number(input.contextLength)) ? Number(input.contextLength) : null),
      concurrency: normalizeConcurrency(
        input.concurrency === undefined ? existing?.concurrency : input.concurrency,
        {fallback: existing?.concurrency ?? DEFAULT_CONCURRENCY}
      ),
      timeoutMs: normalizeTimeoutMs(
        input.timeoutMs === undefined ? existing?.timeoutMs : input.timeoutMs,
        {fallback: existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS}
      ),
      batchInputTokens: normalizeBatchInputTokens(
        input.batchInputTokens === undefined ? existing?.batchInputTokens : input.batchInputTokens
      ),
      // Capabilities are only ever written by recordTest(). A client-supplied
      // capability object is ignored so a config cannot self-certify memory.
      capabilities: normalizeCapabilities(existing?.capabilities)
    };
  }

  create(input) {
    const now = this.now();
    const checked = this.#validate(input);
    if (!checked.modelId) throw Object.assign(new Error('MODEL_REQUIRED'), {code: 'MODEL_REQUIRED'});
    const hasKey = Boolean(input.apiKey !== undefined
      && input.apiKey !== null
      && String(input.apiKey).trim() !== '');
    if (!hasKey && !checked.provider.custom) {
      throw Object.assign(new Error('API_KEY_REQUIRED'), {code: 'API_KEY_REQUIRED'});
    }
    const apiKey = hasKey ? this.#validateKey(input.apiKey) : null;
    const id = createId('aicfg');
    const credentialReference = `aicred_${randomBytes(16).toString('hex')}`;
    const config = normalizeConfig({
      id,
      name: checked.name,
      providerId: checked.provider.id,
      regionId: checked.region.id,
      baseUrl: checked.baseUrl,
      credentialReference,
      modelId: checked.modelId,
      modelLabel: checked.modelLabel,
      pricingStatus: checked.pricingStatus,
      pricing: checked.pricing,
      capabilities: checked.capabilities,
      lastTestStatus: {status: 'untested', at: null},
      isDefault: this.configs.length === 0,
      allowLocalNetwork: checked.allowLocalNetwork,
      contextLength: checked.contextLength,
      concurrency: checked.concurrency,
      timeoutMs: checked.timeoutMs,
      batchInputTokens: checked.batchInputTokens,
      createdAt: now,
      updatedAt: now
    }, {now});

    let configPushed = false;
    let secretStored = false;
    try {
      // Credential first: if it cannot be written, no config is persisted and
      // the user can retry without an orphaned record.
      if (apiKey) {
        this.#storeSecret(credentialReference, apiKey);
        secretStored = true;
      }
      this.configs.push(config);
      configPushed = true;
      this.save();
    } catch (error) {
      if (configPushed) this.configs.pop();
      if (secretStored) this.#removeSecretQuietly(credentialReference);
      throw error;
    }
    return this.getPublic(id);
  }

  update(id, patch) {
    const index = this.configs.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const existing = this.configs[index];
    const merged = {...existing, ...patch};
    const requestedModelId = String(patch.modelId ?? existing.modelId ?? '').trim();
    const modelChanged = requestedModelId !== existing.modelId;
    if (modelChanged
      && !Object.prototype.hasOwnProperty.call(patch, 'pricing')) {
      // A different model must not inherit the previous model's price. Keeping
      // stale pricing would under- or over-state the budget. The user can enter
      // the new price, or leave it explicitly unknown.
      merged.pricingStatus = PRICING_STATUS.UNKNOWN;
      merged.pricing = null;
    }
    if (modelChanged) {
      if (!Object.prototype.hasOwnProperty.call(patch, 'modelLabel')) delete merged.modelLabel;
      if (!Object.prototype.hasOwnProperty.call(patch, 'contextLength')) delete merged.contextLength;
    }
    if ((patch.providerId !== undefined || patch.regionId !== undefined)
      && patch.baseUrl === undefined) {
      // Never carry one region's URL into another region's config. The region's
      // official base URL is applied by validation instead.
      delete merged.baseUrl;
    }
    const checked = this.#validate(merged, {existing});
    if (!checked.modelId) throw Object.assign(new Error('MODEL_REQUIRED'), {code: 'MODEL_REQUIRED'});

    let keyToStore = null;
    if (patch.apiKey !== undefined && patch.apiKey !== null && String(patch.apiKey).trim() !== '') {
      keyToStore = this.#validateKey(patch.apiKey);
    }
    const previousSecret = this.secret(id);
    const regionChanged = checked.provider.id !== existing.providerId
      || checked.region.id !== existing.regionId
      || !sameBaseUrl(checked.baseUrl, existing.baseUrl);
    if (!checked.provider.custom && !keyToStore && !previousSecret) {
      throw Object.assign(new Error('API_KEY_REQUIRED'), {code: 'API_KEY_REQUIRED'});
    }
    if (regionChanged && !keyToStore && (!checked.provider.custom || previousSecret)) {
      throw Object.assign(new Error('API_KEY_REQUIRED_FOR_REGION'), {code: 'API_KEY_REQUIRED_FOR_REGION'});
    }

    // Keep the old reference when the endpoint did not really change (a legacy
    // trailing slash is not a change). A legacy record without a reference gets
    // one when a key is saved, instead of writing the secret under an empty key.
    const nextReference = regionChanged || !existing.credentialReference
      ? `aicred_${randomBytes(16).toString('hex')}`
      : existing.credentialReference;
    const endpointChanged = checked.provider.id !== existing.providerId
      || checked.region.id !== existing.regionId
      || !sameBaseUrl(checked.baseUrl, existing.baseUrl);
    const updated = normalizeConfig({
      ...existing,
      ...checked,
      providerId: checked.provider.id,
      regionId: checked.region.id,
      protocol: checked.provider.protocol,
      baseUrl: checked.baseUrl,
      credentialReference: nextReference,
      updatedAt: this.now(),
      // Capability results are only valid for the exact provider/region/model.
      capabilities: (endpointChanged || checked.modelId !== existing.modelId)
        ? normalizeCapabilities(null)
        : normalizeCapabilities(existing.capabilities),
      lastTestStatus: (endpointChanged || checked.modelId !== existing.modelId)
        ? {status: 'untested', at: null, error: null, stages: null}
        : existing.lastTestStatus
    }, {now: this.now()});

    let newSecretWritten = false;
    let sameReferenceOverwritten = false;
    try {
      if (keyToStore) {
        this.#storeSecret(nextReference, keyToStore);
        if (nextReference === existing.credentialReference) {
          sameReferenceOverwritten = true;
        } else {
          newSecretWritten = true;
        }
      }
      this.configs[index] = updated;
      this.save();
    } catch (error) {
      this.configs[index] = existing;
      if (newSecretWritten) this.#removeSecretQuietly(nextReference);
      if (sameReferenceOverwritten) {
        this.#restoreSecretQuietly(nextReference, previousSecret);
      }
      throw error;
    }

    // Only after the config is safely on disk may the old key be removed. A
    // failure here leaves an orphaned ciphertext, never a broken config.
    if (existing.credentialReference && existing.credentialReference !== nextReference) {
      this.#removeSecretQuietly(existing.credentialReference);
    }
    return this.getPublic(id);
  }

  remove(id) {
    const index = this.configs.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const previous = structuredClone(this.configs);
    const [removed] = this.configs.splice(index, 1);
    if (removed.isDefault && this.configs.length > 0) this.configs[0].isDefault = true;
    try {
      // Persist the removal first. If this fails the config is still on disk and
      // in memory; the key must not be deleted before that.
      this.save();
    } catch (error) {
      this.configs = previous;
      throw error;
    }
    this.#removeSecretQuietly(removed.credentialReference);
    return true;
  }

  /**
   * Remove every credential referenced by the current configs. Used by the
   * factory reset path; the legacy file is left alone (the reset already
   * removes the whole secrets directory) and is never rewritten here.
   */
  clearCredentials() {
    const references = [...new Set(this.configs
      .map((config) => config.credentialReference)
      .filter(Boolean))];
    if (typeof this.credentialStore.clear === 'function') {
      const result = this.credentialStore.clear(references);
      return {
        removed: result?.removed ?? 0,
        failures: result?.failures ?? []
      };
    }
    let removed = 0;
    const failures = [];
    for (const reference of references) {
      try {
        this.credentialStore.remove(reference);
        removed += 1;
      } catch (error) {
        failures.push({code: error?.code ?? 'CREDENTIAL_BACKEND_FAILED'});
      }
    }
    return {removed, failures};
  }

  setDefault(id) {
    if (!this.get(id)) return false;
    const previous = structuredClone(this.configs);
    for (const config of this.configs) config.isDefault = config.id === id;
    try {
      this.save();
    } catch (error) {
      this.configs = previous;
      throw error;
    }
    return true;
  }

  recordTest(id, result) {
    const config = this.get(id);
    if (!config) return null;
    const previous = structuredClone(this.configs);
    config.capabilities = normalizeCapabilities(result.capabilities);
    config.lastTestStatus = normalizeTestStatus({
      status: result.status,
      at: result.at ?? new Date(this.now()).toISOString(),
      error: result.error ?? null,
      stages: result.stages ?? null,
      usage: result.usage ?? null,
      testedAt: result.at ?? new Date(this.now()).toISOString()
    });
    config.updatedAt = this.now();
    try {
      this.save();
    } catch (error) {
      this.configs = previous;
      throw error;
    }
    return this.getPublic(id);
  }

  /**
   * Turn off structured output for a configuration after the provider rejected
   * `response_format` on a real analysis request.
   *
   * The capability test proves the format on a small schema; a provider route
   * can still reject the large LiveMemory schema later. Downgrading persists so
   * the next request (and every later task) carries the full schema in the
   * prompt instead of repeating a paid request that cannot succeed. Only the
   * structured flag is touched: `session`/`memory` capability stay verified.
   */
  downgradeStructuredOutputs(id) {
    const config = this.get(id);
    if (!config) return null;
    if (config.capabilities?.structuredOutputs !== true) return this.getPublic(id);
    const previous = structuredClone(this.configs);
    config.capabilities = {...config.capabilities, structuredOutputs: false};
    config.updatedAt = this.now();
    try {
      this.save();
    } catch (error) {
      this.configs = previous;
      throw error;
    }
    return this.getPublic(id);
  }

  #validateKey(apiKey) {
    // Copy/paste from a provider dashboard often includes a trailing newline or
    // spaces. Trim the outer whitespace before checking: an internal CR/LF/NUL is
    // still rejected because it would produce an invalid Authorization header.
    const value = String(apiKey ?? '').trim();
    if (value.length === 0) throw Object.assign(new Error('API_KEY_REQUIRED'), {code: 'API_KEY_REQUIRED'});
    if (Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) {
      throw Object.assign(new Error('API_KEY_TOO_LARGE'), {code: 'API_KEY_TOO_LARGE'});
    }
    if (/[\r\n\u0000]/.test(value)) {
      throw Object.assign(new Error('API_KEY_INVALID'), {code: 'API_KEY_INVALID'});
    }
    return value;
  }
}

export const __internal = {normalizeConfig, publicConfig, normalizeCapabilities, normalizeTestStatus};
