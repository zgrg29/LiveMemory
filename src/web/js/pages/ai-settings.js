import {api} from '../api.js';
import {createModal} from '../dialog.js';
import {chip, el} from '../ui.js';

/**
 * Settings → AI providers. All values come from the local server; no API key is
 * ever rendered back into the DOM. The form writes one configuration at a time.
 */

function priceLabel(ctx, config) {
  if (config.pricingStatus === 'api_free') return ctx.t('ai.v13.price.free');
  if (config.pricingStatus === 'paid' && config.pricing) {
    return ctx.t('ai.v13.price.paidValue', {
      input: String(config.pricing.inputPerMillion),
      output: String(config.pricing.outputPerMillion),
      currency: config.pricing.currency
    });
  }
  return ctx.t('ai.v13.price.unknown');
}

function capabilityLabel(ctx, config) {
  if (config.capabilities?.memory) return ctx.t('ai.v13.capability.memory');
  if (config.capabilities?.session) return ctx.t('ai.v13.capability.session');
  if (config.lastTestStatus?.status === 'failed') return ctx.t('ai.v13.capability.failed');
  return ctx.t('ai.v13.capability.untested');
}

function field(label, control, hint = null) {
  return el('div', {className: 'field'},
    el('label', {className: 'label', text: label}),
    control,
    hint ? el('div', {className: 'small tertiary', text: hint}) : null);
}

async function confirmCharge(ctx) {
  return new Promise((resolve) => {
    const modal = createModal({title: ctx.t('ai.v13.test.chargeTitle'), t: ctx.t});
    modal.body.append(el('p', {className: 'modal-desc', text: ctx.t('ai.v13.test.chargeBody')}));
    const cancel = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: ctx.t('common.cancel'),
      onClick: () => { modal.close(); resolve(false); }
    });
    const ok = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: ctx.t('ai.v13.test.chargeContinue'),
      onClick: () => { modal.close(); resolve(true); }
    });
    modal.actions.append(cancel, ok);
    ok.focus();
  });
}

export async function renderProviderSettingsCard(ctx) {
  const t = ctx.t;
  let payload = {providers: [], configs: []};
  try {
    payload = await api.get('/api/ai/providers');
  } catch {
    // The settings page remains usable even if the provider service is down.
  }
  const providers = payload.providers ?? [];
  const configs = payload.configs ?? [];

  const card = el('section', {className: 'card card--wide'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('ai.v13.providers.title')}),
      el('div', {className: 'card-hint', text: t('ai.v13.providers.hint')})),
    el('div', {className: 'card-body'}));
  const body = card.querySelector('.card-body');

  body.append(el('div', {className: 'setting-desc', text: t('ai.v13.providers.desc')}));

  const list = el('div', {className: 'def-list', style: {marginTop: '12px'}});
  if (configs.length === 0) {
    list.append(el('div', {className: 'small tertiary', text: t('ai.v13.providers.empty')}));
  }
  for (const config of configs) {
    const testStatus = config.lastTestStatus?.status ?? 'untested';
    const row = el('div', {className: 'provider-config'},
      el('div', {className: 'provider-config-head'},
        el('div', {className: 'provider-config-title'},
          el('span', {text: config.name}),
          config.isDefault ? chip(t('ai.v13.providers.default'), 'accent') : null),
        chip(priceLabel(ctx, config), config.pricingStatus === 'paid' ? 'accent' : 'neutral')),
      el('div', {className: 'small tertiary mono', text: `${config.providerId} / ${config.regionId} / ${config.modelId}`}),
      el('div', {className: 'small tertiary', text: `${capabilityLabel(ctx, config)} · ${t('ai.v13.providers.testStatus.' + testStatus)} · ${t('ai.v13.providers.concurrency')}: ${config.concurrency ?? 3}`}),
      el('div', {className: 'inline', style: {marginTop: '8px'}},
        !config.isDefault ? el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('ai.v13.providers.makeDefault'),
          onClick: async () => {
            try {
              await api.post(`/api/ai/providers/configs/${encodeURIComponent(config.id)}/default`, {});
              ctx.toast(t('settings.saved'));
              ctx.navigate('/settings');
            } catch (error) {
              ctx.toast(ctx.describeError(error), {tone: 'error'});
            }
          }
        }) : null,
        el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('ai.v13.providers.test'),
          onClick: async (event) => {
            const paid = config.pricingStatus !== 'api_free';
            if (paid && !await confirmCharge(ctx)) return;
            event.target.disabled = true;
            event.target.textContent = t('ai.v13.providers.testing');
            try {
              const result = await api.post(`/api/ai/providers/configs/${encodeURIComponent(config.id)}/test`, {
                confirmBilling: paid
              });
              ctx.toast(t('ai.v13.providers.testDone', {status: result.result?.status ?? 'failed'}), {
                tone: result.result?.status === 'failed' ? 'error' : 'info'
              });
              ctx.navigate('/settings');
            } catch (error) {
              ctx.toast(ctx.describeError(error), {tone: 'error'});
              event.target.disabled = false;
              event.target.textContent = t('ai.v13.providers.test');
            }
          }
        }),
        config.hasCredential ? chip(t('ai.v13.providers.keyStored'), 'neutral') : chip(t('ai.v13.providers.noKey'), 'warn'),
        el('button', {
          className: 'button button--ghost button--small',
          type: 'button',
          text: t('ai.v13.providers.delete'),
          onClick: async () => {
            if (!await new Promise((resolve) => {
              const modal = createModal({title: t('ai.v13.providers.deleteTitle'), t});
              modal.body.append(el('p', {className: 'modal-desc', text: config.name}));
              modal.actions.append(
                el('button', {className: 'button button--ghost', type: 'button', text: t('common.cancel'), onClick: () => { modal.close(); resolve(false); }}),
                el('button', {className: 'button button--danger', type: 'button', text: t('ai.v13.providers.delete'), onClick: () => { modal.close(); resolve(true); }})
              );
            })) return;
            try {
              await api.delete(`/api/ai/providers/configs/${encodeURIComponent(config.id)}`);
              ctx.navigate('/settings');
            } catch (error) {
              ctx.toast(ctx.describeError(error), {tone: 'error'});
            }
          }
        })));
    list.append(row);
  }
  body.append(list);

  /* --------------------------------------------------------------- add form */
  const providerSelect = el('select', {className: 'select'}, providers.map((provider) => el('option', {
    value: provider.id,
    text: provider.label
  })));
  const regionSelect = el('select', {className: 'select'});
  const baseUrlInput = el('input', {className: 'input', type: 'url', attrs: {placeholder: 'https://…'}});
  const keyInput = el('input', {className: 'input', type: 'password', attrs: {autocomplete: 'off', spellcheck: 'false'}});
  const modelInput = el('input', {className: 'input', type: 'text', attrs: {placeholder: t('ai.v13.providers.modelPlaceholder')}});
  const presetSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.v13.providers.preset')}});
  const presetNote = el('div', {className: 'small tertiary'});
  const pricingSelect = el('select', {className: 'select'},
    el('option', {value: 'unknown', text: t('ai.v13.price.unknown')}),
    el('option', {value: 'api_free', text: t('ai.v13.price.free')}),
    el('option', {value: 'paid', text: t('ai.v13.price.paid')}));
  const inputPrice = el('input', {className: 'input input--compact', type: 'number', attrs: {min: '0', step: '0.0001'}});
  const outputPrice = el('input', {className: 'input input--compact', type: 'number', attrs: {min: '0', step: '0.0001'}});
  const currencyInput = el('input', {className: 'input input--compact', type: 'text', value: 'USD', attrs: {maxlength: '8'}});
  const concurrencyInput = el('input', {
    className: 'input input--compact',
    type: 'number',
    value: '3',
    attrs: {min: '1', max: '8', step: '1'}
  });
  const localCheck = el('input', {type: 'checkbox'});
  const priceFields = el('div', {className: 'grid-2-equal'}, field(t('ai.v13.providers.inputPrice'), inputPrice), field(t('ai.v13.providers.outputPrice'), outputPrice));
  const modelListBox = el('div', {className: 'small tertiary'});

  function selectedProvider() {
    return providers.find((entry) => entry.id === providerSelect.value) ?? providers[0];
  }
  function applyPreset(preset) {
    if (!preset) return;
    modelInput.value = preset.id;
    if (preset.pricingStatus) pricingSelect.value = preset.pricingStatus;
    if (preset.pricing) {
      inputPrice.value = String(preset.pricing.inputPerMillion ?? 0);
      outputPrice.value = String(preset.pricing.outputPerMillion ?? 0);
      currencyInput.value = preset.pricing.currency ?? 'USD';
    }
    presetNote.textContent = preset.note ?? '';
    syncPricing();
  }
  function syncPresets() {
    const provider = selectedProvider();
    const region = provider?.regions?.find((entry) => entry.id === regionSelect.value);
    const presets = (provider?.presets ?? []).filter((preset) => (
      !preset.regionIds?.length || preset.regionIds.includes(region?.id)
    ));
    presetSelect.replaceChildren(
      el('option', {value: '', text: t('ai.v13.providers.customPreset')}),
      ...presets.map((preset) => el('option', {value: preset.id, text: preset.label}))
    );
    presetSelect.hidden = presets.length === 0;
    presetNote.textContent = '';
    if (presets.length > 0) {
      presetSelect.value = presets[0].id;
      applyPreset(presets[0]);
    }
  }
  function syncRegions() {
    const provider = selectedProvider();
    regionSelect.replaceChildren(...(provider?.regions ?? []).map((region) => el('option', {
      value: region.id,
      text: `${region.label} · ${region.baseUrl || '—'}`
    })));
    baseUrlInput.value = provider?.regions?.[0]?.baseUrl ?? '';
    baseUrlInput.disabled = !provider?.custom;
    localCheck.checked = false;
    syncPresets();
    syncModelPicker();
  }
  function syncPricing() {
    priceFields.hidden = pricingSelect.value !== 'paid';
  }
  providerSelect.addEventListener('change', syncRegions);
  regionSelect.addEventListener('change', syncPresets);
  pricingSelect.addEventListener('change', syncPricing);
  presetSelect.addEventListener('change', () => {
    const provider = selectedProvider();
    const preset = (provider?.presets ?? []).find((entry) => entry.id === presetSelect.value);
    if (preset) applyPreset(preset);
    else presetNote.textContent = '';
  });
  modelInput.addEventListener('input', () => {
    const provider = selectedProvider();
    const known = (provider?.presets ?? []).some((entry) => entry.id === modelInput.value.trim());
    if (!known) {
      presetSelect.value = '';
      presetNote.textContent = '';
    }
  });

  const loadModels = el('button', {
    className: 'button button--ghost button--small',
    type: 'button',
    text: t('ai.v13.providers.loadModels'),
    onClick: async () => {      const provider = selectedProvider();
      const region = provider?.regions?.find((entry) => entry.id === regionSelect.value);
      try {
        const result = await api.get(`/api/ai/providers/models?providerId=${encodeURIComponent(provider.id)}&regionId=${encodeURIComponent(region?.id ?? '')}`);
        const models = result.models ?? [];
        if (models.length === 0) {
          modelListBox.textContent = t('ai.v13.providers.noModels');
          return;
        }
        const select = el('select', {className: 'select'});
        for (const model of models) {
          const price = model.pricingStatus === 'api_free' ? t('ai.v13.price.free') : (model.pricing ? `${model.pricing.currency} ${model.pricing.inputPerMillion}/${model.pricing.outputPerMillion}` : t('ai.v13.price.unknown'));
          select.append(el('option', {
            value: model.id,
            text: `${model.name} · ${model.id}${model.contextLength ? ` · ${model.contextLength}` : ''} · ${price}`
          }));
        }
        select.addEventListener('change', () => {
          modelInput.value = select.value;
          const selected = models.find((model) => model.id === select.value);
          if (selected?.pricing) {
            pricingSelect.value = selected.pricingStatus === 'api_free' ? 'api_free' : 'paid';
            inputPrice.value = String(selected.pricing.inputPerMillion ?? 0);
            outputPrice.value = String(selected.pricing.outputPerMillion ?? 0);
            currencyInput.value = selected.pricing.currency ?? 'USD';
            syncPricing();
          }
        });
        modelListBox.replaceChildren(select);
        modelInput.value = select.value;
      } catch (error) {
        modelListBox.textContent = ctx.describeError(error);
      }
    }
  });

  function syncModelPicker() {
    const provider = selectedProvider();
    const supported = provider?.supportsModelList === true;
    loadModels.hidden = !supported;
    if (!supported) {
      modelListBox.textContent = t('ai.v13.providers.manualModelHint');
    } else {
      modelListBox.textContent = '';
    }
  }

  const saveButton = el('button', {
    className: 'button button--primary',
    type: 'button',
    text: t('ai.v13.providers.save'),
    onClick: async () => {
      saveButton.disabled = true;
      try {
        const provider = selectedProvider();
        const region = provider.regions.find((entry) => entry.id === regionSelect.value);
        const pricingStatus = pricingSelect.value;
        const modelId = modelInput.value.trim();
        const fail = (key) => {
          ctx.toast(t(key), {tone: 'error'});
          saveButton.disabled = false;
        };
        if (!modelId) {
          fail('ai.v13.providers.modelRequired');
          return;
        }
        if (!provider.custom && !keyInput.value.trim()) {
          fail('ai.v13.providers.keyRequired');
          return;
        }
        const input = Number(inputPrice.value);
        const output = Number(outputPrice.value);
        if (pricingStatus === 'paid') {
          if (inputPrice.value.trim() === '' || outputPrice.value.trim() === '') {
            fail('ai.v13.providers.priceRequired');
            return;
          }
          if (input === 0 && output === 0) {
            fail('ai.v13.providers.priceRequired');
            return;
          }
        }
        await api.post('/api/ai/providers/configs', {
          providerId: provider.id,
          regionId: region.id,
          baseUrl: provider.custom ? baseUrlInput.value.trim() : region.baseUrl,
          apiKey: keyInput.value,
          modelId,
          pricingStatus,
          pricing: (pricingStatus === 'paid' || pricingStatus === 'api_free') ? {
            inputPerMillion: pricingStatus === 'api_free' ? 0 : input,
            outputPerMillion: pricingStatus === 'api_free' ? 0 : output,
            currency: currencyInput.value.trim() || 'USD',
            confirmedAt: new Date().toISOString()
          } : null,
          concurrency: Number(concurrencyInput.value) || 3,
          allowLocalNetwork: localCheck.checked
        });
        keyInput.value = '';
        ctx.toast(t('ai.v13.providers.saved'));
        ctx.navigate('/settings');
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        saveButton.disabled = false;
      }
    }
  });

  syncRegions();
  syncPricing();

  body.append(el('div', {className: 'setting-block', style: {marginTop: '18px'}},
    el('div', {className: 'choice-title', text: t('ai.v13.providers.addTitle')}),
    el('div', {className: 'grid-2-equal', style: {marginTop: '10px'}},
      field(t('ai.v13.providers.provider'), providerSelect),
      field(t('ai.v13.providers.region'), regionSelect)),
    field(t('ai.v13.providers.baseUrl'), baseUrlInput),
    field(t('ai.v13.providers.apiKey'), keyInput, t('ai.v13.providers.keyHint')),
    el('div', {className: 'grid-2-equal'},
      field(t('ai.v13.providers.preset'), presetSelect),
      field(t('ai.v13.providers.model'), modelInput)),
    presetNote,
    el('div', {className: 'inline'}, loadModels, modelListBox),
    el('div', {className: 'grid-2-equal'},
      field(t('ai.v13.providers.pricingStatus'), pricingSelect),
      field(t('ai.v13.providers.currency'), currencyInput)),
    priceFields,
    field(t('ai.v13.providers.concurrency'), concurrencyInput, t('ai.v13.providers.concurrencyHint')),
    el('label', {className: 'choice', style: {marginTop: '10px'}},
      localCheck,
      el('div', {className: 'choice-text'},
        el('div', {className: 'choice-title', text: t('ai.v13.providers.localTitle')}),
        el('div', {className: 'choice-desc', text: t('ai.v13.providers.localDesc')}))),
    el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}}, t('ai.v13.providers.security')),
    el('div', {className: 'inline', style: {marginTop: '12px'}}, saveButton)));

  return card;
}
