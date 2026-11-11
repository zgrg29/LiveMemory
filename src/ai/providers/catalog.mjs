/**
 * Provider catalogue for user-supplied AI APIs.
 *
 * Only transport facts are hard-coded here: protocol family, official base
 * URLs per region and the documentation used to verify them. Model IDs and
 * prices are NOT invented. OpenRouter supplies a live model catalogue; the
 * other providers expose a `/models` endpoint where the vendor supports one,
 * and otherwise the user enters the model ID manually.
 *
 * Region separation is deliberate. MiniMax and Alibaba Cloud Model Studio run
 * separate platforms with separate keys, quotas and occasionally separate
 * model names. A credential is therefore bound to one config (and one region),
 * never shared through the provider name.
 */

export const PROVIDER_PROTOCOL = Object.freeze({
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic'
});

export const PRICING_STATUS = Object.freeze({
  API_FREE: 'api_free',
  PAID: 'paid',
  UNKNOWN: 'unknown'
});

export const PRICING_STATUSES = Object.freeze(Object.values(PRICING_STATUS));

/** Provider definitions. `regions[0]` is the default region. */
export const PROVIDER_CATALOG = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyHint: 'sk-…',
    supportsModelList: true,
    supportsStructuredOutputs: true,
    regions: Object.freeze([
      Object.freeze({id: 'global', label: 'Global', baseUrl: 'https://api.openai.com/v1', currency: 'USD'})
    ])
  }),
  Object.freeze({
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: PROVIDER_PROTOCOL.ANTHROPIC,
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    keyHint: 'sk-ant-…',
    supportsModelList: true,
    supportsStructuredOutputs: false,
    anthropicVersion: '2023-06-01',
    regions: Object.freeze([
      Object.freeze({id: 'global', label: 'Global', baseUrl: 'https://api.anthropic.com/v1', currency: 'USD'})
    ])
  }),
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: 'https://api-docs.deepseek.com/',
    keyHint: 'sk-…',
    supportsModelList: true,
    supportsStructuredOutputs: false,
    regions: Object.freeze([
      Object.freeze({id: 'global', label: 'Global', baseUrl: 'https://api.deepseek.com', currency: 'USD'})
    ])
  }),
  Object.freeze({
    id: 'minimax',
    label: 'MiniMax',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: 'https://platform.minimaxi.com/docs/guides/text-generation',
    keyHint: 'API key',
    supportsModelList: false,
    supportsStructuredOutputs: false,
    regions: Object.freeze([
      Object.freeze({
        id: 'cn',
        label: '中国大陆版',
        baseUrl: 'https://api.minimaxi.com/v1',
        currency: 'CNY',
        docsUrl: 'https://platform.minimaxi.com/docs/guides/text-generation'
      }),
      Object.freeze({
        id: 'intl',
        label: 'International',
        baseUrl: 'https://api.minimax.io/v1',
        currency: 'USD',
        docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api'
      })
    ])
  }),
  Object.freeze({
    id: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/base-url',
    keyHint: 'sk-…',
    supportsModelList: false,
    supportsStructuredOutputs: false,
    // Optional convenience presets. Prices are reference prices from the
    // official Chinese pricing page, for the Beijing region only. They are
    // never presented as a live quote; the user can still type any Model ID.
    presets: Object.freeze([
      Object.freeze({
        id: 'qwen-plus',
        label: 'Qwen Plus（推荐）',
        regionIds: Object.freeze(['cn-beijing']),
        pricingStatus: 'paid',
        pricing: Object.freeze({
          currency: 'CNY',
          inputPerMillion: 0.8,
          outputPerMillion: 2,
          sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
          confirmedAt: '2026-11-11'
        }),
        note: '北京地域、非思考模式、0–128K 输入参考价'
      }),
      Object.freeze({
        id: 'qwen-max',
        label: 'Qwen Max',
        regionIds: Object.freeze(['cn-beijing']),
        pricingStatus: 'paid',
        pricing: Object.freeze({
          currency: 'CNY',
          inputPerMillion: 2.4,
          outputPerMillion: 9.6,
          sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
          confirmedAt: '2026-11-11'
        }),
        note: '北京地域、非思考模式参考价'
      }),
      Object.freeze({
        id: 'qwen3.8-max',
        label: 'Qwen3.8 Max',
        regionIds: Object.freeze(['cn-beijing']),
        pricingStatus: 'paid',
        pricing: Object.freeze({
          currency: 'CNY',
          inputPerMillion: 12,
          outputPerMillion: 36,
          sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
          confirmedAt: '2026-11-11'
        }),
        note: '北京地域、非思考/思考模式参考价'
      })
    ]),
    regions: Object.freeze([
      Object.freeze({
        id: 'cn-beijing',
        label: '中国大陆（北京）',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        currency: 'CNY',
        docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/base-url'
      }),
      Object.freeze({
        id: 'singapore',
        label: 'Singapore',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        currency: 'USD',
        docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/base-url'
      }),
      Object.freeze({
        id: 'us',
        label: 'US (Virginia)',
        baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        currency: 'USD',
        docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/base-url'
      }),
      Object.freeze({
        id: 'hongkong',
        label: '中国香港',
        baseUrl: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
        currency: 'HKD',
        docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/base-url'
      })
    ])
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: 'https://openrouter.ai/docs/api_reference/overview',
    keyHint: 'sk-or-v1-…',
    supportsModelList: true,
    supportsStructuredOutputs: true,
    dynamicModelList: true,
    regions: Object.freeze([
      Object.freeze({id: 'global', label: 'Global', baseUrl: 'https://openrouter.ai/api/v1', currency: 'USD'})
    ])
  }),
  Object.freeze({
    id: 'custom',
    label: '自定义 OpenAI-compatible',
    protocol: PROVIDER_PROTOCOL.OPENAI,
    docsUrl: null,
    keyHint: 'API key (optional)',
    supportsModelList: false,
    supportsStructuredOutputs: false,
    custom: true,
    regions: Object.freeze([
      Object.freeze({id: 'custom', label: 'Custom base URL', baseUrl: '', currency: 'USD'})
    ])
  })
]);

export function getProvider(providerId) {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

export function getRegion(providerId, regionId) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  return provider.regions.find((region) => region.id === regionId) ?? null;
}

export function providerMatchesProtocol(providerId, protocol) {
  const provider = getProvider(providerId);
  return Boolean(provider && provider.protocol === protocol);
}

/** Public catalogue, safe for the browser: no secrets, no endpoints keys. */
export function publicCatalog() {
  return PROVIDER_CATALOG.map((provider) => ({
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    docsUrl: provider.docsUrl,
    keyHint: provider.keyHint,
    supportsModelList: provider.supportsModelList,
    supportsStructuredOutputs: provider.supportsStructuredOutputs,
    custom: Boolean(provider.custom),
    presets: (provider.presets ?? []).map((preset) => ({
      id: preset.id,
      label: preset.label,
      regionIds: [...(preset.regionIds ?? [])],
      pricingStatus: preset.pricingStatus ?? 'unknown',
      pricing: preset.pricing ? {...preset.pricing} : null,
      note: preset.note ?? null
    })),
    regions: provider.regions.map((region) => ({
      id: region.id,
      label: region.label,
      baseUrl: region.baseUrl,
      currency: region.currency,
      docsUrl: region.docsUrl ?? provider.docsUrl
    }))
  }));
}

/** Chinese/English/Japanese labels are supplied by the GUI i18n layer. */
export function providerLabelKey(providerId) {
  return `ai.provider.${providerId}`;
}
