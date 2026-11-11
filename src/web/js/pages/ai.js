import {api} from '../api.js';
import {createModal} from '../dialog.js';
import {
  chip,
  clear,
  el,
  emptyState,
  formatDateTime,
  formatInteger,
  pageHead
} from '../ui.js';
import {platformLabel} from './shared.js';
import {renderAnalysisReport} from './ai-report.js';

/**
 * AI analysis centre (v0.13.1).
 *
 * One flow only:
 *   1. choose a recorded broadcast;
 *   2. choose a configured API provider/model;
 *   3. choose the analysis scope;
 *   4. review price, task size and budget;
 *   5. click "Start AI analysis".
 *
 * The local program creates the internal packages, calls the provider, validates
 * the answer, imports it in one transaction and saves the report. There is no
 * anonymous free route, no prompt copying and no JSON paste/upload UI.
 */

const CONSENT_KEY = 'livememory.aiConsent.v1';
const TERMINAL = new Set(['complete', 'partial', 'failed', 'canceled', 'interrupted']);

function field(label, control, hint = null) {
  return el('div', {className: 'field'},
    el('label', {className: 'label', text: label}),
    control,
    hint ? el('div', {className: 'small tertiary', text: hint}) : null);
}

function stepCard(index, title, desc) {
  return el('div', {className: 'step-card'},
    el('span', {className: 'step-index', text: String(index)}),
    el('div', {className: 'step-title', text: title}),
    el('div', {className: 'step-desc', text: desc}));
}

function consentDialog(ctx) {
  return new Promise((resolve) => {
    const modal = createModal({title: ctx.t('ai.center.consentTitle'), t: ctx.t});
    modal.body.append(
      el('p', {className: 'modal-desc', text: ctx.t('ai.center.consentBody')}),
      el('p', {className: 'small tertiary', text: ctx.t('ai.center.consentHint')}));
    const cancel = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: ctx.t('common.cancel'),
      onClick: () => {
        modal.close();
        resolve(false);
      }
    });
    const ok = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: ctx.t('ai.center.consentContinue'),
      onClick: () => {
        modal.close();
        resolve(true);
      }
    });
    modal.actions.append(cancel, ok);
    ok.focus();
  });
}

function consentGranted() {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'granted';
  } catch {
    return false;
  }
}

function rememberConsent() {
  try {
    window.localStorage.setItem(CONSENT_KEY, 'granted');
  } catch {
    // Private mode / disabled storage: ask again next time.
  }
}

function priceText(ctx, config) {
  if (!config) return ctx.t('ai.v13.price.unknown');
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

function configLine(config) {
  if (!config) return '—';
  return `${config.providerId} / ${config.regionId} / ${config.modelId || '—'}`;
}

function memoryAllowed(config) {
  return Boolean(config
    && config.pricingStatus === 'paid'
    && config.pricing
    && config.capabilities?.session
    && config.capabilities?.memory);
}

function viewersPerBatch(config) {
  const context = Number(config?.contextLength ?? 0);
  if (context >= 200000) return 20;
  if (context >= 100000) return 15;
  return 10;
}

function estimatedRequests(config, scope, session) {
  const viewers = Math.max(0, Number(session?.uniqueViewerCount ?? 0));
  const sessionRequests = scope === 'memory' ? 0 : 1;
  if (scope === 'session') return sessionRequests;
  const memoryRequests = Math.max(1, Math.ceil(viewers / viewersPerBatch(config)));
  return sessionRequests + memoryRequests;
}

function mmss(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return null;
  const total = Math.round(Number(ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export const aiPage = {
  titleKey: 'ai.pageTitle',

  async render(container, ctx) {
    const t = ctx.t;
    const sessionsPayload = await api.get('/api/sessions?limit=100&includeArchived=1');
    const sessions = sessionsPayload.sessions ?? [];
    let providerData = {providers: [], configs: []};
    try {
      providerData = await api.get('/api/ai/providers');
    } catch {
      // The page still explains that a provider is required.
    }
    const providerConfigs = providerData.configs ?? [];

    container.append(pageHead({title: t('ai.pageTitle'), subtitle: t('ai.pageSubtitle')}));

    if (sessions.length === 0) {
      container.append(el('div', {className: 'card card--padded'},
        emptyState({
          title: t('ai.setup.empty'),
          glyph: '◇',
          action: el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('nav.live'),
            onClick: () => ctx.navigate('/live')
          })
        })));
      return undefined;
    }

    container.append(el('div', {className: 'steps'},
      stepCard(1, t('ai.center.stepSession'), t('ai.center.stepSessionDesc')),
      stepCard(2, t('ai.center.stepConfig'), t('ai.center.stepConfigDesc')),
      stepCard(3, t('ai.center.stepScope'), t('ai.center.stepScopeDesc')),
      stepCard(4, t('ai.center.stepCost'), t('ai.center.stepCostDesc')),
      stepCard(5, t('ai.center.stepStart'), t('ai.center.stepStartDesc'))));

    let selectedId = sessions[0]?.id ?? null;
    let locale = ctx.locale;
    let runScope = 'session';
    let status = null;
    let timer = null;
    let busy = false;

    const sessionSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.center.sessionLabel')}},
      sessions.map((session) => el('option', {
        value: session.id,
        text: `${session.roomTitle || platformLabel(session.platform, t)} · ${formatDateTime(session.startedAt, ctx.locale)}`
      })));
    sessionSelect.value = selectedId;

    const languageSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.center.languageLabel')}},
      el('option', {value: 'zh-CN', text: t('settings.language.zh')}),
      el('option', {value: 'ja', text: t('settings.language.ja')}),
      el('option', {value: 'en', text: t('settings.language.en')}));
    languageSelect.value = locale;

    const configSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.center.configLabel')}},
      providerConfigs.map((config) => el('option', {
        value: config.id,
        text: `${config.name} · ${config.modelId || '—'}`
      })));
    const defaultConfig = providerConfigs.find((config) => config.isDefault) ?? providerConfigs[0];
    if (defaultConfig) configSelect.value = defaultConfig.id;

    const scopeSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.center.scopeLabel')}});
    const budgetInput = el('input', {
      className: 'input input--compact',
      type: 'number',
      attrs: {min: '0', step: '0.01', placeholder: t('ai.v13.budget.placeholder')}
    });
    const confirmBilling = el('input', {type: 'checkbox'});
    const optInMemory = el('input', {type: 'checkbox'});
    const configSummary = el('div', {className: 'small tertiary'});
    const pricingSummary = el('div', {className: 'small tertiary'});
    const scaleSummary = el('div', {className: 'def-list'});
    const scopeHint = el('div', {className: 'callout callout--neutral', hidden: true});
    const billingRow = el('label', {className: 'choice'},
      confirmBilling,
      el('div', {className: 'choice-text'},
        el('div', {className: 'choice-title', text: t('ai.v13.billing.confirm')}),
        el('div', {className: 'choice-desc', text: t('ai.v13.billing.hint')})));
    const memoryOptRow = el('label', {className: 'choice'},
      optInMemory,
      el('div', {className: 'choice-text'},
        el('div', {className: 'choice-title', text: t('ai.v13.memory.optIn')}),
        el('div', {className: 'choice-desc', text: t('ai.v13.memory.optInHint')})));
    const settingsLink = el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('ai.center.openSettings'),
      onClick: () => ctx.navigate('/settings')
    });
    const noConfig = el('div', {className: 'callout callout--warn', hidden: providerConfigs.length > 0},
      t('ai.center.noConfig'));

    const startButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('ai.center.start')
    });

    const setupCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.center.setupTitle')}),
        chip(t('ai.center.badge'), 'accent')),
      el('div', {className: 'card-body'},
        el('div', {className: 'grid-2-equal'},
          field(t('ai.center.sessionLabel'), sessionSelect),
          field(t('ai.center.languageLabel'), languageSelect)),
        el('div', {className: 'grid-2-equal'},
          field(t('ai.center.configLabel'), configSelect),
          el('div', {className: 'field'},
            el('button', {
              className: 'button button--secondary',
              type: 'button',
              text: t('ai.center.openSettings'),
              onClick: () => ctx.navigate('/settings')
            }))),
        configSummary,
        pricingSummary,
        noConfig,
        field(t('ai.center.scopeLabel'), scopeSelect),
        scopeHint,
        el('div', {className: 'grid-2-equal'},
          field(t('ai.v13.budget.label'), budgetInput, t('ai.v13.budget.hint')),
          el('div', {className: 'stack stack--tight'}, billingRow, memoryOptRow)),
        el('div', {className: 'divider'}),
        el('div', {className: 'small tertiary', text: t('ai.center.scaleTitle')}),
        scaleSummary,
        el('div', {className: 'inline', style: {marginTop: '14px'}},
          startButton,
          settingsLink)));

    const statusCard = el('section', {className: 'card', hidden: true},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.center.statusTitle')}),
        el('div', {className: 'inline'},
          el('button', {
            className: 'button button--ghost button--small',
            type: 'button',
            text: t('ai.v13.run.refresh'),
            onClick: () => refreshStatus()
          }))),
      el('div', {className: 'card-body'}));
    const statusText = el('div', {className: 'auto-status', attrs: {role: 'status', 'aria-live': 'polite'}});
    const progressText = el('div', {className: 'small tertiary'});
    const statsHost = el('div', {className: 'def-list'});
    const errorText = el('div', {className: 'auto-error', attrs: {role: 'alert'}, hidden: true});
    const errorDetailsText = el('div', {className: 'small tertiary'});
    const errorDetails = el('details', {className: 'auto-details', hidden: true},
      el('summary', {text: t('ai.center.errorDetails')}),
      errorDetailsText);
    const pauseButton = el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('ai.v13.run.pause'),
      hidden: true
    });
    const cancelButton = el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('ai.center.cancel'),
      hidden: true
    });
    statusCard.querySelector('.card-body').append(
      statusText,
      progressText,
      statsHost,
      el('div', {className: 'inline', style: {marginTop: '10px'}}, pauseButton, cancelButton),
      errorText,
      errorDetails);

    const reportHost = el('div', {className: 'report-host'});
    container.append(setupCard, el('div', {style: {marginTop: '16px'}}, statusCard), reportHost);

    function selectedSession() {
      return sessions.find((session) => session.id === selectedId) ?? null;
    }

    function selectedConfig() {
      return providerConfigs.find((config) => config.id === configSelect.value) ?? null;
    }

    function renderScopeOptions() {
      const config = selectedConfig();
      const previous = runScope;
      const allowed = memoryAllowed(config);
      const options = [['session', t('ai.v13.scope.session')]];
      if (allowed) {
        options.push(['memory', t('ai.v13.scope.memory')]);
        options.push(['both', t('ai.v13.scope.both')]);
      }
      scopeSelect.replaceChildren(...options.map(([value, label]) => el('option', {value, text: label})));
      if (!options.some(([value]) => value === previous)) runScope = 'session';
      scopeSelect.value = runScope;
      scopeSelect.disabled = !allowed;
      scopeHint.hidden = allowed;
      scopeHint.textContent = allowed ? '' : t('ai.v13.run.locked');
      memoryOptRow.hidden = !allowed || runScope === 'session';
      billingRow.hidden = !config || config.pricingStatus === 'api_free';
      if (!billingRow.hidden) confirmBilling.checked = false;
      if (memoryOptRow.hidden) optInMemory.checked = false;
    }

    function renderSummary() {
      const config = selectedConfig();
      const session = selectedSession();
      configSummary.textContent = config
        ? `${config.name} · ${configLine(config)} · ${config.capabilities?.memory
          ? t('ai.v13.capability.memory')
          : (config.capabilities?.session ? t('ai.v13.capability.session') : t('ai.v13.capability.untested'))}`
        : t('ai.center.noConfigShort');
      pricingSummary.textContent = config
        ? `${t('ai.v13.price.status')}: ${priceText(ctx, config)}`
        : '';
      const messages = Number(session?.messageCount ?? 0);
      const viewers = Number(session?.uniqueViewerCount ?? 0);
      const requests = estimatedRequests(config, runScope, session);
      scaleSummary.replaceChildren(
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.center.scaleMessages')}),
          el('span', {className: 'def-value', text: formatInteger(messages, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.center.scaleViewers')}),
          el('span', {className: 'def-value', text: formatInteger(viewers, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.center.scaleRequests')}),
          el('span', {className: 'def-value', text: formatInteger(requests, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('ai.center.scaleBudget')}),
          el('span', {className: 'def-value', text: budgetInput.value
            ? `${budgetInput.value} ${config?.pricing?.currency ?? ''}`
            : t('ai.center.scaleNoBudget')})));
      syncStartGate();
    }

    function syncStartGate() {
      const config = selectedConfig();
      const paidUnknown = config && config.pricingStatus !== 'api_free';
      const needsMemoryOptIn = runScope !== 'session';
      startButton.disabled = Boolean(busy)
        || !config
        || config.capabilities?.session !== true
        || (paidUnknown && !confirmBilling.checked)
        || (needsMemoryOptIn && !optInMemory.checked);
    }

    function budgetPayload() {
      const amount = Number(budgetInput.value);
      if (!budgetInput.value || !Number.isFinite(amount) || amount <= 0) return null;
      return {amount, currency: selectedConfig()?.pricing?.currency ?? 'USD'};
    }

    function stageLabel(current) {
      const stage = current?.stage ?? 'preparing';
      const index = Math.max(0, Number(current?.batchIndex ?? 0));
      const total = Math.max(0, Number(current?.batchTotal ?? 0));
      const keys = {
        preparing: 'ai.v13.stage.preparing',
        packaging_session: 'ai.v13.stage.packagingSession',
        session_analyzing: 'ai.v13.stage.sessionAnalyzing',
        session_importing: 'ai.v13.stage.sessionImporting',
        session_done: 'ai.v13.stage.sessionDone',
        packaging_memory: 'ai.v13.stage.packagingMemory',
        memory_analyzing: 'ai.v13.stage.memoryAnalyzing',
        memory_importing: 'ai.v13.stage.memoryImporting',
        memory_batch_done: 'ai.v13.stage.memoryBatchDone',
        memory_done: 'ai.v13.stage.memoryDone',
        resuming: 'ai.v13.stage.resuming',
        paused: 'ai.v13.stage.paused',
        complete: 'ai.center.complete',
        canceled: 'ai.center.canceled'
      };
      const key = keys[stage];
      if (stage === 'memory_analyzing' || stage === 'memory_importing' || stage === 'memory_batch_done') {
        return t(key ?? 'ai.v13.stage.preparing', {index, total});
      }
      return key ? t(key) : t('ai.v13.stage.preparing');
    }

    function reasonText(code) {
      const key = `ai.center.reason.${code}`;
      const value = t(key);
      return value === key ? String(code ?? '') : value;
    }

    function renderStats(current) {
      clear(statsHost);
      const requests = current?.requestStats;
      if (!requests) return;
      const rows = [
        [t('ai.center.stats.total'), formatInteger(requests.total ?? 0, ctx.locale)],
        [t('ai.center.stats.done'), formatInteger(requests.completed ?? 0, ctx.locale)],
        [t('ai.center.stats.failed'), formatInteger(requests.failed ?? 0, ctx.locale)],
        [t('ai.center.stats.active'), `${formatInteger(requests.active ?? 0, ctx.locale)} / ${formatInteger(requests.concurrency ?? 0, ctx.locale)}`],
        [t('ai.center.stats.queued'), formatInteger(requests.waiting ?? 0, ctx.locale)],
        [t('ai.center.stats.modelTime'), requests.averageModelMs === null
          ? '—'
          : t('ai.center.stats.msValue', {ms: formatInteger(requests.averageModelMs, ctx.locale)})],
        [t('ai.center.stats.queueWait'), t('ai.center.stats.msValue', {ms: formatInteger(requests.queueWaitMs ?? 0, ctx.locale)})],
        [t('ai.center.stats.throttleWait'), t('ai.center.stats.msValue', {ms: formatInteger(requests.throttleWaitMs ?? 0, ctx.locale)})],
        [t('ai.center.stats.rateLimited'), formatInteger(requests.rateLimited ?? 0, ctx.locale)]
      ];
      if (current.usage) {
        rows.push([t('ai.center.stats.tokens'), t('ai.v13.run.usageTokens', {
          input: formatInteger(current.usage.inputTokens ?? 0, ctx.locale),
          output: formatInteger(current.usage.outputTokens ?? 0, ctx.locale)
        })]);
        if (current.usage.cost) {
          rows.push([t('ai.center.stats.cost'), t('ai.v13.run.usageCost', {
            amount: Number(current.usage.cost.amount).toFixed(4),
            currency: current.usage.cost.currency
          })]);
        }
      }
      if (Number.isFinite(Number(current.estimatedRemainingMs))) {
        rows.push([t('ai.center.stats.eta'), mmss(current.estimatedRemainingMs) ?? '—']);
      }
      statsHost.append(...rows.map(([key, value]) => el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: key}),
        el('span', {className: 'def-value', text: value}))));
    }

    function renderStatus(current) {
      status = current;
      const visible = Boolean(current && current.status && current.status !== 'idle');
      statusCard.hidden = !visible;
      if (!visible) return;
      const running = current.status === 'running';
      const paused = current.status === 'paused';
      pauseButton.hidden = !running && !paused;
      pauseButton.disabled = !running && !paused;
      pauseButton.textContent = paused ? t('ai.v13.run.resume') : t('ai.v13.run.pause');
      cancelButton.hidden = !running;
      startButton.disabled = running;
      const total = Number(current.batchTotal ?? 0);
      const done = Number(current.batchIndex ?? 0);
      progressText.textContent = total > 0
        ? t('ai.v13.run.progress', {
          done: formatInteger(done, ctx.locale),
          total: formatInteger(total, ctx.locale)
        })
        : '';
      errorText.hidden = true;
      errorDetails.hidden = true;
      errorText.textContent = '';
      errorDetailsText.textContent = '';
      statusText.className = 'auto-status';
      if (running) {
        statusText.textContent = `${stageLabel(current)}${current.estimatedRemainingMs
          ? ` · ${t('ai.center.eta', {time: mmss(current.estimatedRemainingMs)})}`
          : ''}`;
      } else if (current.status === 'complete') {
        statusText.className = 'auto-status auto-status--success';
        const coverage = current.memoryJob?.memoryCoverage;
        statusText.textContent = [
          t('ai.center.complete'),
          current.memoryDone && coverage?.total > 0
            ? t('ai.center.completeMemory', {
              covered: formatInteger(coverage.covered ?? 0, ctx.locale),
              total: formatInteger(coverage.total ?? 0, ctx.locale)
            })
            : null
        ].filter(Boolean).join(' · ');
      } else if (current.status === 'canceled') {
        statusText.textContent = t('ai.center.canceled');
      } else if (current.status === 'paused') {
        statusText.textContent = t('ai.v13.stage.paused');
      } else if (current.status === 'partial') {
        statusText.textContent = t('ai.v13.run.partial');
        errorText.hidden = false;
        errorText.textContent = reasonText(current.error?.code);
        errorDetails.hidden = !current.error?.detail;
        errorDetailsText.textContent = current.error?.detail ?? '';
      } else {
        statusText.textContent = t('ai.center.failed');
        errorText.hidden = false;
        errorText.textContent = reasonText(current.error?.code);
        errorDetails.hidden = !current.error?.detail;
        errorDetailsText.textContent = current.error?.detail ?? '';
      }
      renderStats(current);
      if (!running) syncStartGate();
    }

    async function refreshStatus() {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (!selectedId) return;
      try {
        const current = await api.get(`/api/ai/analyze/status?sessionId=${encodeURIComponent(selectedId)}`);
        renderStatus(current);
        if (current.running) {
          timer = window.setTimeout(refreshStatus, 1500);
        } else if (TERMINAL.has(current.status)) {
          await Promise.all([refreshReport()]);
        }
      } catch {
        statusText.textContent = t('ai.v13.run.pollFailed');
        if (status?.running) timer = window.setTimeout(refreshStatus, 2500);
      }
    }

    async function refreshReport() {
      clear(reportHost);
      let report = null;
      try {
        report = await api.get(`/api/ai/sessions/${encodeURIComponent(selectedId ?? '')}/report`);
      } catch {
        report = null;
      }
      if (!report) return;
      const node = renderAnalysisReport(ctx, report, {onAggregate: null});
      if (node) reportHost.append(node);
    }

    function renderAll() {
      renderScopeOptions();
      renderSummary();
    }

    async function startAnalysis() {
      if (busy) return;
      const config = selectedConfig();
      if (!config) {
        ctx.toast(t('ai.center.noConfigShort'), {tone: 'error'});
        return;
      }
      if (config.capabilities?.session !== true) {
        ctx.toast(t('ai.v13.config.needCapability'), {tone: 'error'});
        return;
      }
      if (runScope !== 'session' && !memoryAllowed(config)) {
        ctx.toast(t('ai.v13.run.locked'), {tone: 'error'});
        return;
      }
      if (!consentGranted()) {
        if (!await consentDialog(ctx)) return;
        rememberConsent();
      }
      busy = true;
      syncStartGate();
      startButton.textContent = t('ai.center.starting');
      try {
        const current = await api.post('/api/ai/analyze/run', {
          sessionId: selectedId,
          locale,
          mode: runScope,
          configId: config.id,
          consent: true,
          confirmBilling: confirmBilling.checked,
          optInMemory: optInMemory.checked,
          budget: budgetPayload()
        });
        renderStatus(current);
        if (current.running) timer = window.setTimeout(refreshStatus, 800);
        ctx.toast(t('ai.center.started'), {tone: 'info'});
      } catch (error) {
        renderStatus({
          status: 'failed',
          stage: 'failed',
          error: {code: error?.code ?? 'ANALYSIS_FAILED', detail: ctx.describeError(error)},
          requestStats: null
        });
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        busy = false;
        startButton.textContent = t('ai.center.start');
        syncStartGate();
      }
    }

    async function cancelAnalysis() {
      if (!selectedId) return;
      try {
        const current = await api.post('/api/ai/analyze/cancel', {sessionId: selectedId});
        renderStatus(current);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      }
    }

    async function pauseOrResume() {
      if (!selectedId) return;
      if (status?.status === 'paused') {
        try {
          const current = await api.post('/api/ai/analyze/resume', {
            sessionId: selectedId,
            consent: true,
            confirmBilling: confirmBilling.checked,
            optInMemory: optInMemory.checked,
            budget: budgetPayload()
          });
          renderStatus(current);
          if (current.running) timer = window.setTimeout(refreshStatus, 800);
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
        return;
      }
      try {
        const current = await api.post('/api/ai/analyze/pause', {sessionId: selectedId});
        renderStatus(current);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      }
    }

    startButton.addEventListener('click', startAnalysis);
    cancelButton.addEventListener('click', cancelAnalysis);
    pauseButton.addEventListener('click', pauseOrResume);
    configSelect.addEventListener('change', renderAll);
    scopeSelect.addEventListener('change', () => {
      runScope = scopeSelect.value;
      memoryOptRow.hidden = runScope === 'session';
      optInMemory.checked = false;
      renderSummary();
    });
    confirmBilling.addEventListener('change', syncStartGate);
    optInMemory.addEventListener('change', syncStartGate);
    budgetInput.addEventListener('input', () => renderSummary());
    languageSelect.addEventListener('change', () => {
      locale = languageSelect.value;
    });
    sessionSelect.addEventListener('change', async () => {
      selectedId = sessionSelect.value;
      status = null;
      renderAll();
      await Promise.all([refreshStatus(), refreshReport()]);
    });

    renderAll();
    await Promise.all([refreshStatus(), refreshReport()]);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }
};
