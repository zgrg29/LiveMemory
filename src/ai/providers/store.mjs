import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createId} from '../../shared/ids.mjs';
import {EncryptedJsonStore} from '../../platforms/shared/secret-store.mjs';
import {getProvider, getRegion, PRICING_STATUS} from './catalog.mjs';
import {normalizePricing, normalizePricingStatus} from './pricing.mjs';
import {validateBaseUrl} from './url-safety.mjs';

/**
 * API configurations and encrypted credentials.
 *
 * `config/ai-providers.json` contains no secret. The API key lives in
 * `secrets/ai-keys.json` encrypted with the per-install AES key used by the
 * existing platform credential store. A config stores only an opaque
 * `credentialReference`; changing provider/region/base URL rotates that
 * reference so an old region's key can never be silently reused.
 */

const FILE_VERSION = 1;
const MAX_API_KEY_BYTES = 8192;

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
    return {status: 'untested', at: null, error: null, stages: null};
  }
  return {
    status: ['untested', 'running', 'passed', 'failed', 'partial'].includes(input.status)
      ? input.status
      : 'untested',
    at: typeof input.at === 'string' ? input.at : null,
    error: typeof input.error === 'string' ? input.error.slice(0, 200) : null,
    stages: input.stages && typeof input.stages === 'object' ? input.stages : null,
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
    contextLength: Number.isFinite(Number(raw.contextLength)) ? Number(raw.contextLength) : null,
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
    secretStore = null
  }) {
    if (!configFile) throw new Error('ProviderConfigStore: configFile is required');
    this.file = configFile;
    this.now = now;
    this.fs = fs;
    this.configs = [];
    this.secrets = secretStore ?? new EncryptedJsonStore({
      dir: secretsDir,
      fileName: 'ai-keys.json',
      keyFileName: 'ai-keys.key',
      fs
    });
  }

  load() {
    this.configs = [];
    if (!this.fs.existsSync(this.file)) return this.list();
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (raw?.version !== FILE_VERSION || !Array.isArray(raw.configs)) return this.list();
      this.configs = raw.configs
        .map((entry) => normalizeConfig(entry, {now: this.now()}))
        .filter(Boolean);
      if (!this.configs.some((entry) => entry.isDefault) && this.configs.length > 0) {
        this.configs[0].isDefault = true;
      }
    } catch {
      // A corrupt config must not prevent startup. Keep the file untouched for
      // support and start with no configurations; the user can add one again.
      this.configs = [];
    }
    return this.list();
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

  list() {
    return this.configs.map((config) => ({
      ...publicConfig(config),
      hasCredential: this.hasSecret(config.id)
    }));
  }

  get(id) {
    return this.configs.find((entry) => entry.id === id) ?? null;
  }

  getPublic(id) {
    const config = this.get(id);
    return config ? {...publicConfig(config), hasCredential: this.hasSecret(id)} : null;
  }

  getDefault() {
    return this.configs.find((entry) => entry.isDefault) ?? this.configs[0] ?? null;
  }

  #secretData() {
    const loaded = this.secrets.load();
    return loaded?.data?.secrets && typeof loaded.data.secrets === 'object'
      ? loaded.data.secrets
      : {};
  }

  #storeSecret(reference, apiKey) {
    const data = this.#secretData();
    data[reference] = {apiKey, updatedAt: new Date(this.now()).toISOString()};
    this.secrets.save({secrets: data}, {now: this.now()});
  }

  #removeSecret(reference) {
    const data = this.#secretData();
    if (!data[reference]) return;
    delete data[reference];
    this.secrets.save({secrets: data}, {now: this.now()});
  }

  /** Read a secret. Never exposed by an HTTP response. */
  secret(id) {
    const config = this.get(id);
    if (!config?.credentialReference) return null;
    const data = this.#secretData();
    const value = data[config.credentialReference]?.apiKey;
    return typeof value === 'string' && value.length > 0 ? value : null;
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
    const baseUrl = String(input.baseUrl ?? (isCustom ? existing?.baseUrl ?? '' : region.baseUrl)).trim();
    if (!baseUrl) throw Object.assign(new Error('BASE_URL_REQUIRED'), {code: 'BASE_URL_REQUIRED'});
    const allowLocalNetwork = input.allowLocalNetwork === undefined
      ? Boolean(existing?.allowLocalNetwork)
      : input.allowLocalNetwork === true;
    try {
      validateBaseUrl(baseUrl, {allowLocalNetwork});
    } catch (error) {
      throw Object.assign(new Error(error.code ?? 'BASE_URL_INVALID'), {
        code: error.code ?? 'BASE_URL_INVALID',
        details: error.details ?? null
      });
    }
    // Known providers must use their official regional base URL. This prevents a
    // key from being sent to an arbitrary host by editing the JSON.
    if (!isCustom && baseUrl.replace(/\/+$/, '') !== region.baseUrl.replace(/\/+$/, '')) {
      throw Object.assign(new Error('BASE_URL_NOT_ALLOWED'), {code: 'BASE_URL_NOT_ALLOWED'});
    }
    const modelId = String(input.modelId ?? existing?.modelId ?? '').trim();
    const pricingStatus = normalizePricingStatus(
      input.pricingStatus ?? existing?.pricingStatus,
      {fallback: PRICING_STATUS.UNKNOWN}
    );
    const pricing = normalizePricing(input.pricing ?? existing?.pricing);
    if (pricingStatus === PRICING_STATUS.PAID && !pricing) {
      throw Object.assign(new Error('PRICING_REQUIRED'), {code: 'PRICING_REQUIRED'});
    }
    if (pricingStatus === PRICING_STATUS.PAID
      && pricing
      && pricing.inputPerMillion === 0
      && pricing.outputPerMillion === 0) {
      // A "paid" model cannot be priced at zero in both directions. Free models
      // must be configured as api_free; otherwise the budget/memory gate would
      // be bypassed by a contradictory price declaration.
      throw Object.assign(new Error('PRICING_INVALID'), {code: 'PRICING_INVALID'});
    }
    if (pricingStatus === PRICING_STATUS.API_FREE) {
      const zeroPrice = pricing && pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0;
      const freeSuffix = /:free$/i.test(modelId);
      if (!zeroPrice && !freeSuffix) {
        throw Object.assign(new Error('FREE_PRICING_UNVERIFIED'), {code: 'FREE_PRICING_UNVERIFIED'});
      }
    }
    return {
      provider,
      region,
      baseUrl,
      allowLocalNetwork,
      modelId,
      pricingStatus,
      pricing,
      name: String(input.name ?? existing?.name ?? provider.label).trim().slice(0, 80) || provider.label,
      modelLabel: String(input.modelLabel ?? existing?.modelLabel ?? modelId).slice(0, 200),
      contextLength: input.contextLength === undefined
        ? (existing?.contextLength ?? null)
        : (Number.isFinite(Number(input.contextLength)) ? Number(input.contextLength) : null),
      // Capabilities are only ever written by recordTest(). A client-supplied
      // capability object is ignored so a config cannot self-certify memory.
      capabilities: normalizeCapabilities(existing?.capabilities)
    };
  }

  create(input) {
    const now = this.now();
    const checked = this.#validate(input);
    if (!checked.modelId) throw Object.assign(new Error('MODEL_REQUIRED'), {code: 'MODEL_REQUIRED'});
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
      createdAt: now,
      updatedAt: now
    }, {now});
    this.configs.push(config);
    if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey) !== '') {
      this.#storeSecret(credentialReference, this.#validateKey(input.apiKey));
    } else if (!checked.provider.custom) {
      this.configs.pop();
      throw Object.assign(new Error('API_KEY_REQUIRED'), {code: 'API_KEY_REQUIRED'});
    }
    this.save();
    return this.getPublic(id);
  }

  update(id, patch) {
    const index = this.configs.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const existing = this.configs[index];
    const merged = {...existing, ...patch};
    if ((patch.providerId !== undefined || patch.regionId !== undefined)
      && patch.baseUrl === undefined) {
      // Never carry one region's URL into another region's config. The region's
      // official base URL is applied by validation instead.
      delete merged.baseUrl;
    }
    const checked = this.#validate(merged, {existing});
    const regionChanged = checked.provider.id !== existing.providerId
      || checked.region.id !== existing.regionId
      || checked.baseUrl !== existing.baseUrl;
    const nextReference = regionChanged
      ? `aicred_${randomBytes(16).toString('hex')}`
      : existing.credentialReference;
    let keyToStore = null;
    if (patch.apiKey !== undefined && patch.apiKey !== null && String(patch.apiKey) !== '') {
      keyToStore = this.#validateKey(patch.apiKey);
    }
    if (regionChanged && !keyToStore && !checked.provider.custom) {
      throw Object.assign(new Error('API_KEY_REQUIRED_FOR_REGION'), {code: 'API_KEY_REQUIRED_FOR_REGION'});
    }
    if (regionChanged) this.#removeSecret(existing.credentialReference);
    if (keyToStore) this.#storeSecret(nextReference, keyToStore);
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
      capabilities: (checked.provider.id !== existing.providerId
        || checked.region.id !== existing.regionId
        || checked.baseUrl !== existing.baseUrl
        || checked.modelId !== existing.modelId)
        ? normalizeCapabilities(null)
        : normalizeCapabilities(existing.capabilities),
      lastTestStatus: (checked.provider.id !== existing.providerId
        || checked.region.id !== existing.regionId
        || checked.baseUrl !== existing.baseUrl
        || checked.modelId !== existing.modelId)
        ? {status: 'untested', at: null, error: null, stages: null}
        : existing.lastTestStatus
    }, {now: this.now()});
    this.configs[index] = updated;
    this.save();
    return this.getPublic(id);
  }

  remove(id) {
    const index = this.configs.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [removed] = this.configs.splice(index, 1);
    this.#removeSecret(removed.credentialReference);
    if (removed.isDefault && this.configs.length > 0) this.configs[0].isDefault = true;
    this.save();
    return true;
  }

  setDefault(id) {
    if (!this.get(id)) return false;
    for (const config of this.configs) config.isDefault = config.id === id;
    this.save();
    return true;
  }

  recordTest(id, result) {
    const config = this.get(id);
    if (!config) return null;
    config.capabilities = normalizeCapabilities(result.capabilities);
    config.lastTestStatus = normalizeTestStatus({
      status: result.status,
      at: result.at ?? new Date(this.now()).toISOString(),
      error: result.error ?? null,
      stages: result.stages ?? null,
      testedAt: result.at ?? new Date(this.now()).toISOString()
    });
    config.updatedAt = this.now();
    this.save();
    return this.getPublic(id);
  }

  #validateKey(apiKey) {
    const value = String(apiKey);
    if (value.length === 0) throw Object.assign(new Error('API_KEY_REQUIRED'), {code: 'API_KEY_REQUIRED'});
    if (Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) {
      throw Object.assign(new Error('API_KEY_TOO_LARGE'), {code: 'API_KEY_TOO_LARGE'});
    }
    if (/[\r\n\u0000]/.test(value)) {
      throw Object.assign(new Error('API_KEY_INVALID'), {code: 'API_KEY_INVALID'});
    }
    return value.trim();
  }
}

export const __internal = {normalizeConfig, publicConfig, normalizeCapabilities, normalizeTestStatus};
