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
import {buildAnalysisProgress} from './ai-progress.js';
import {providerConfigState} from './ai-config-state.js';
import {chooseInitialSessionId} from './ai-selection.js';

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
const TERMINAL = new Set(['complete', 'partial', 'failed', 'canceled', 'interrupted', 'needs_action']);

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
  if (!config || !config.pricing) return ctx.t('ai.v13.price.optional');
  return ctx.t('ai.v13.price.paidValue', {
    input: String(config.pricing.inputPerMillion),
    output: String(config.pricing.outputPerMillion),
    currency: config.pricing.currency
  });
}

function configLine(config) {
  if (!config) return '—';
  return `${config.providerId} / ${config.regionId} / ${config.modelId || '—'}`;
}

function memoryAllowed(config) {
  return Boolean(config
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
  // Session request count depends on the real message sizes and the token
  // budget chosen at task start; showing a made-up number is worse than saying
  // it is automatic. Memory-only requests can be estimated from viewers.
  if (scope !== 'memory') return null;
  const viewers = Math.max(0, Number(session?.uniqueViewerCount ?? 0));
  return Math.max(1, Math.ceil(viewers / viewersPerBatch(config)));
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

  async render(container, ctx, params, query) {
    const t = ctx.t;
    const sessionsPayload = await api.get('/api/sessions?limit=100&includeArchived=1');
    const sessions = sessionsPayload.sessions ?? [];
    const requestedId = query?.get('session') ?? null;
    if (requestedId && !sessions.some((session) => session.id === requestedId)) {
      // The requested broadcast may be older than the first 100 rows. Resolve it
      // by stable id instead of relying on the list window or a title match.
      try {
        const detail = await api.get(`/api/sessions/${encodeURIComponent(requestedId)}`);
        if (detail?.session?.id) sessions.unshift(detail.session);
      } catch {
        // Deleted or inaccessible: fall back to the normal first session.
      }
    }
    let providerData = {providers: [], configs: []};
    let providerLoadFailed = false;
    try {
      providerData = await api.get('/api/ai/providers');
    } catch {
      providerLoadFailed = true;
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
      stepCard(4, t('ai.center.stepConfirm'), t('ai.center.stepConfirmDesc')),
      stepCard(5, t('ai.center.stepStart'), t('ai.center.stepStartDesc'))));

    let selectedId = chooseInitialSessionId(sessions, requestedId);
    let locale = ctx.locale;
    let runScope = 'session';
    let status = null;
    let timer = null;
    let requestTicker = null;
    let busy = false;
    let statusEpoch = 0;
    let reportEpoch = 0;

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
    const configSummary = el('div', {className: 'small tertiary'});
    const pricingSummary = el('div', {className: 'small tertiary'});
    const scaleSummary = el('div', {className: 'def-list'});
    const scopeHint = el('div', {className: 'callout callout--neutral', hidden: true});
    const settingsLink = el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('ai.center.openSettings'),
      onClick: () => ctx.navigate('/settings')
    });
    const configWarning = el('div', {className: 'callout callout--warn', hidden: true});
    const configNotice = el('div', {className: 'callout callout--neutral', hidden: true});

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
        configWarning,
        configNotice,
        field(t('ai.center.scopeLabel'), scopeSelect),
        scopeHint,
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
    const progressBar = el('div', {
      className: 'analysis-progress',
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0'
      }
    });
    const progressFill = el('div', {className: 'analysis-progress-fill'});
    progressBar.append(progressFill);
    const progressParts = el('div', {className: 'analysis-progress-parts'});
    const progressText = el('div', {className: 'small tertiary'});
    const requestStatus = el('div', {className: 'small tertiary', hidden: true});
    const requestElapsed = el('div', {className: 'small tertiary', hidden: true});
    const savedStatus = el('div', {className: 'small tertiary', hidden: true});
    const budgetStatus = el('div', {className: 'small tertiary', hidden: true});
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
      progressBar,
      progressText,
      progressParts,
      requestStatus,
      requestElapsed,
      savedStatus,
      budgetStatus,
      statusText,
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
    }

    function renderSummary() {
      const config = selectedConfig();
      const session = selectedSession();
      const state = providerConfigState(config);
      configSummary.textContent = config
        ? `${config.name} · ${configLine(config)} · ${config.capabilities?.memory
          ? t('ai.v13.capability.memory')
          : (config.capabilities?.session ? t('ai.v13.capability.session') : t('ai.v13.capability.untested'))}`
        : (providerLoadFailed ? t('ai.center.configLoadFailed') : t('ai.center.noConfigShort'));
      pricingSummary.textContent = config
        ? `${t('ai.v13.price.status')}: ${priceText(ctx, config)}`
        : '';
      configWarning.hidden = true;
      configWarning.textContent = '';
      configNotice.hidden = true;
      configNotice.textContent = '';
      if (providerLoadFailed) {
        configWarning.hidden = false;
        configWarning.textContent = t('ai.center.configLoadFailed');
      } else if (!config) {
        configWarning.hidden = false;
        configWarning.textContent = t('ai.center.noConfig');
      } else if (state.kind === 'missing_key') {
        configWarning.hidden = false;
        configWarning.textContent = t('ai.center.configMissingKey');
      } else if (state.kind === 'test_failed') {
        configWarning.hidden = false;
        configWarning.textContent = t('ai.center.configTestFailed', {
          reason: state.detail ? String(state.detail).slice(0, 200) : t('common.unknown')
        });
      } else if (state.kind === 'untested') {
        configNotice.hidden = false;
        configNotice.textContent = t('ai.center.configUntested');
      }
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
          el('span', {className: 'def-value', text: requests === null
            ? t('ai.center.scaleRequestsAuto')
            : formatInteger(requests, ctx.locale)})));
      syncStartGate();
    }

    function syncStartGate() {
      const config = selectedConfig();
      const state = providerConfigState(config);
      startButton.disabled = Boolean(busy)
        || status?.running === true
        || !state.usable;
    }

    function stageLabel(current) {
      const stage = current?.stage ?? 'preparing';
      const index = Math.max(0, Number(current?.batchIndex ?? 0));
      const total = Math.max(0, Number(current?.batchTotal ?? 0));
      const sessionIndex = Math.max(0, Number(current?.sessionBatchIndex ?? 0));
      const sessionTotal = Math.max(0, Number(current?.sessionBatchTotal ?? 0));
      const keys = {
        preparing: 'ai.v13.stage.preparing',
        packaging_session: 'ai.v13.stage.packagingSession',
        session_analyzing: 'ai.v13.stage.sessionAnalyzing',
        session_batch_done: 'ai.v13.stage.sessionBatchDone',
        session_aggregating: 'ai.v13.stage.sessionAggregating',
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
      if (stage === 'session_analyzing' && sessionTotal > 1) {
        return t('ai.v13.stage.sessionBatchAnalyzing', {
          index: String(sessionIndex),
          total: String(sessionTotal)
        });
      }
      if (stage === 'session_aggregating') {
        return t('ai.v13.stage.sessionAggregating', {
          total: String(sessionTotal)
        });
      }
      if (stage === 'memory_analyzing' || stage === 'memory_importing' || stage === 'memory_batch_done') {
        return t(key ?? 'ai.v13.stage.preparing', {index, total});
      }
      return keys[stage] ? t(keys[stage]) : t('ai.v13.stage.preparing');
    }

    function durationLabel(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes > 0
        ? t('ai.center.request.durationMinutes', {minutes: String(minutes), seconds: String(seconds).padStart(2, '0')})
        : t('ai.center.request.durationSeconds', {seconds: String(seconds)});
    }

    function elapsedLabel(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes > 0
        ? t('ai.center.request.elapsedMinutes', {minutes: String(minutes), seconds: String(seconds).padStart(2, '0')})
        : t('ai.center.request.elapsedSeconds', {seconds: String(seconds)});
    }

    function reasonText(code) {
      const key = `ai.center.reason.${code}`;
      const value = t(key);
      return value === key ? String(code ?? '') : value;
    }

    function renderProgress(current) {
      const progress = buildAnalysisProgress(current);
      progressBar.hidden = false;
      progressParts.replaceChildren();
      if (progress.percent === null) {
        progressBar.dataset.indeterminate = 'true';
        progressBar.removeAttribute('aria-valuenow');
        progressBar.setAttribute('aria-valuetext', t('ai.center.progressIndeterminate'));
        progressFill.style.width = '35%';
        progressText.textContent = `${stageLabel(current)} · ${t('ai.center.progressIndeterminate')}`;
      } else {
        delete progressBar.dataset.indeterminate;
        progressBar.setAttribute('aria-valuenow', String(progress.percent));
        progressBar.setAttribute('aria-valuetext', `${progress.percent}%`);
        progressFill.style.width = `${progress.percent}%`;
        progressText.textContent = `${stageLabel(current)} · ${progress.percent}%`;
      }
      for (const part of progress.parts) {
        if (part.key === 'session') {
          if (part.batchTotal > 1) {
            progressParts.append(el('div', {className: 'small tertiary'},
              t('ai.center.progressSessionBatches', {
                done: formatInteger(part.batchDone, ctx.locale),
                total: formatInteger(part.batchTotal, ctx.locale)
              })));
            if (part.aggregateRequired) {
              progressParts.append(el('div', {className: 'small tertiary'},
                part.aggregateDone
                  ? t('ai.center.progressAggregateDone')
                  : t('ai.center.progressAggregate')));
            }
          } else {
            progressParts.append(el('div', {className: 'small tertiary'},
              t('ai.center.progressSession', {
                done: part.complete ? 1 : 0,
                total: 1
              })));
          }
        } else if (part.skipped) {
          progressParts.append(el('div', {className: 'small tertiary'},
            t('ai.center.progressMemorySkipped', {
              reason: reasonText(part.reason ?? 'ANALYSIS_MEMORY_NO_VIEWERS')
            })));
        } else {
          progressParts.append(el('div', {className: 'small tertiary'},
            t('ai.center.progressMemory', {
              done: formatInteger(part.done, ctx.locale),
              total: formatInteger(part.total, ctx.locale)
            })));
          if (part.viewersTotal > 0) {
            progressParts.append(el('div', {className: 'small tertiary'},
              t('ai.center.progressViewers', {
                done: formatInteger(part.viewersDone, ctx.locale),
                total: formatInteger(part.viewersTotal, ctx.locale)
              })));
          }
        }
      }
    }

    function requestKindLabel(kind) {
      if (!kind) return t('ai.center.request.unknown');
      if (kind === 'session-aggregate') return t('ai.center.request.aggregate');
      if (kind.startsWith('memory')) return t('ai.center.request.memory');
      return t('ai.center.request.session');
    }

    function requestStateLabel(request) {
      if (!request) return '';
      if (request.retrying) {
        return t('ai.center.request.retrying', {
          attempt: String(request.attempt ?? 1),
          max: String(request.maxAttempts ?? 1)
        });
      }
      if (request.receivedOutput) return t('ai.center.request.output');
      if (request.receivedHeaders) return t('ai.center.request.headers');
      return t('ai.center.request.waiting');
    }

    function renderRequestDetail(current) {
      const request = current?.currentRequest ?? null;
      const last = current?.lastRequest ?? null;
      if (!request && !last) {
        requestStatus.hidden = true;
        requestElapsed.hidden = true;
        return;
      }
      requestStatus.hidden = false;
      if (request) {
        const batch = Number.isFinite(Number(request.batchIndex)) && request.batchIndex !== null
          ? ` · ${t('ai.center.request.batch', {index: formatInteger(request.batchIndex, ctx.locale)})}`
          : '';
        requestStatus.textContent = `${requestKindLabel(request.kind)} · ${requestStateLabel(request)}${batch}`;
        requestElapsed.hidden = false;
        requestElapsed.dataset.startedAt = String(request.startedAt ?? '');
        requestElapsed.textContent = elapsedLabel(Date.now() - Number(request.startedAt ?? Date.now()));
      } else {
        requestStatus.textContent = t('ai.center.request.last', {
          kind: requestKindLabel(last.kind),
          outcome: t(`ai.center.request.outcome.${last.outcome ?? 'failed'}`),
          elapsed: durationLabel(last.elapsedMs ?? 0)
        });
        requestElapsed.hidden = true;
        requestElapsed.dataset.startedAt = '';
      }
    }

    function renderSaved(current) {
      const saved = current?.saved;
      if (!saved) {
        savedStatus.hidden = true;
        return;
      }
      const parts = [];
      if (saved.sessionReport) parts.push(t('ai.center.saved.session'));
      if (Number(saved.sessionBatches ?? 0) > 0 && Number(current.sessionBatchTotal ?? 0) > 1) {
        parts.push(t('ai.center.saved.sessionBatches', {
          done: formatInteger(saved.sessionBatches, ctx.locale),
          total: formatInteger(current.sessionBatchTotal, ctx.locale)
        }));
      }
      if (Number(saved.memoryBatches ?? 0) > 0) {
        parts.push(t('ai.center.saved.memoryBatches', {
          done: formatInteger(saved.memoryBatches, ctx.locale),
          total: formatInteger(current.memoryBatchTotal ?? 0, ctx.locale)
        }));
      }
      if (saved.memory) parts.push(t('ai.center.saved.memory'));
      savedStatus.hidden = parts.length === 0;
      savedStatus.textContent = parts.length > 0
        ? `${t('ai.center.saved.label')}: ${parts.join(' · ')}`
        : '';
    }

    function renderBudget(current) {
      const elapsed = Number(current?.taskElapsedMs);
      const parts = [];
      if (Number.isFinite(elapsed)) parts.push(t('ai.center.task.elapsed', {elapsed: elapsedLabel(elapsed)}));
      if (current?.waitingAggregate) parts.push(t('ai.center.task.waitingAggregate'));
      if (current?.needsUserAction) parts.push(t('ai.center.task.needsAction'));
      if (current?.canResume && current.status !== 'running') parts.push(t('ai.center.task.resumeHint'));
      budgetStatus.hidden = parts.length === 0;
      budgetStatus.textContent = parts.join(' · ');
    }

    function renderStats(current) {
      clear(statsHost);
      const attempts = current?.attemptStats;
      const requests = current?.requestStats;
      const rows = [];
      if (attempts && Number(attempts.total ?? 0) > 0) {
        rows.push([t('ai.center.stats.attempts'), formatInteger(attempts.total ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.succeeded'), formatInteger(attempts.succeeded ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.failed'), formatInteger(attempts.failed ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.canceled'), formatInteger(attempts.canceled ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.timedOut'), formatInteger(attempts.timedOut ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.retried'), formatInteger(attempts.retried ?? 0, ctx.locale)]);
      }
      if (requests) {
        rows.push([t('ai.center.stats.active'), `${formatInteger(requests.active ?? 0, ctx.locale)} / ${formatInteger(requests.concurrency ?? 0, ctx.locale)}`]);
        rows.push([t('ai.center.stats.queued'), formatInteger(requests.waiting ?? 0, ctx.locale)]);
        rows.push([t('ai.center.stats.modelTime'), requests.averageModelMs === null
          ? '—'
          : t('ai.center.stats.msValue', {ms: formatInteger(requests.averageModelMs, ctx.locale)})]);
        rows.push([t('ai.center.stats.queueWait'), t('ai.center.stats.msValue', {ms: formatInteger(requests.queueWaitMs ?? 0, ctx.locale)})]);
        rows.push([t('ai.center.stats.throttleWait'), t('ai.center.stats.msValue', {ms: formatInteger(requests.throttleWaitMs ?? 0, ctx.locale)})]);
        rows.push([t('ai.center.stats.rateLimited'), formatInteger(requests.rateLimited ?? 0, ctx.locale)]);
      }
      if (current?.usage) {
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
      } else if (Number(current?.usageUnknownAttempts ?? 0) > 0) {
        rows.push([t('ai.center.stats.usage'), t('ai.center.stats.usageUnknown')]);
      }
      if (current?.estimatedRemainingMs !== null
        && current?.estimatedRemainingMs !== undefined
        && Number.isFinite(Number(current.estimatedRemainingMs))) {
        rows.push([t('ai.center.stats.eta'), mmss(current.estimatedRemainingMs) ?? '—']);
      }
      statsHost.append(...rows.map(([key, value]) => el('div', {className: 'def-row'},
        el('span', {className: 'def-key', text: key}),
        el('span', {className: 'def-value', text: value}))));
    }

    function syncRequestTicker(active) {
      if (requestTicker) {
        window.clearInterval(requestTicker);
        requestTicker = null;
      }
      if (!active) return;
      // Local clock only: the server supplies the request start time, so the
      // displayed "running for" value never invents progress or an ETA.
      requestTicker = window.setInterval(() => {
        const startedAt = Number(status?.currentRequest?.startedAt);
        if (!Number.isFinite(startedAt) || startedAt <= 0) return;
        requestElapsed.textContent = elapsedLabel(Date.now() - startedAt);
      }, 1000);
    }

    function renderStatus(current) {
      status = current;
      const visible = Boolean(current && current.status && current.status !== 'idle');
      statusCard.hidden = !visible;
      if (!visible) {
        syncRequestTicker(false);
        return;
      }
      const running = current.status === 'running';
      const canResume = current.canResume === true && !running;
      pauseButton.hidden = !running && !canResume;
      pauseButton.disabled = !running && !canResume;
      pauseButton.textContent = canResume ? t('ai.v13.run.resume') : t('ai.v13.run.pause');
      cancelButton.hidden = !running;
      startButton.disabled = running;
      renderProgress(current);
      renderRequestDetail(current);
      renderSaved(current);
      renderBudget(current);
      syncRequestTicker(running && Boolean(current.currentRequest));
      errorText.hidden = true;
      errorDetails.hidden = true;
      errorText.textContent = '';
      errorDetailsText.textContent = '';
      statusText.className = 'auto-status';
      if (running) {
        statusText.textContent = t('ai.center.running');
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
            : null,
          current.memorySkipped
            ? t('ai.center.memorySkipped', {
              reason: reasonText(current.memorySkipReason ?? 'ANALYSIS_MEMORY_NO_VIEWERS')
            })
            : null
        ].filter(Boolean).join(' · ');
      } else if (current.status === 'canceled') {
        statusText.textContent = t('ai.center.canceled');
      } else if (current.status === 'paused') {
        statusText.textContent = t('ai.v13.stage.paused');
      } else if (current.status === 'needs_action') {
        statusText.textContent = t('ai.center.needsAction');
        errorText.hidden = false;
        errorText.textContent = reasonText(current.error?.code);
        errorDetails.hidden = !current.error?.detail;
        errorDetailsText.textContent = current.error?.detail ?? '';
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
      const requestId = ++statusEpoch;
      const sessionId = selectedId;
      try {
        const current = await api.get(`/api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`);
        if (requestId !== statusEpoch || sessionId !== selectedId) return;
        renderStatus(current);
        if (current.running) {
          timer = window.setTimeout(refreshStatus, 1500);
        } else if (TERMINAL.has(current.status)) {
          await refreshReport();
        }
      } catch {
        if (requestId !== statusEpoch || sessionId !== selectedId) return;
        statusText.textContent = t('ai.v13.run.pollFailed');
        if (status?.running) timer = window.setTimeout(refreshStatus, 2500);
      }
    }

    async function refreshReport() {
      if (!selectedId) {
        reportEpoch += 1;
        clear(reportHost);
        return;
      }
      const requestId = ++reportEpoch;
      const sessionId = selectedId;
      let report = null;
      try {
        report = await api.get(`/api/ai/sessions/${encodeURIComponent(sessionId)}/report`);
      } catch {
        report = null;
      }
      // A slower, older response must never append a second report after a newer
      // one (or after the user selected another broadcast).
      if (requestId !== reportEpoch || sessionId !== selectedId) return;
      clear(reportHost);
      if (!report) return;
      const node = renderAnalysisReport(ctx, report, {onAggregate: null});
      if (node) reportHost.append(node);
    }

    function syncUrl() {
      try {
        const suffix = selectedId ? `?session=${encodeURIComponent(selectedId)}` : '';
        window.history.replaceState(null, '', `#/ai${suffix}`);
      } catch {
        // History is best effort; the selection still works in memory.
      }
    }

    function renderAll() {
      renderScopeOptions();
      renderSummary();
    }

    async function startAnalysis() {
      if (busy) return;
      const config = selectedConfig();
      const state = providerConfigState(config);
      if (!config) {
        ctx.toast(providerLoadFailed ? t('ai.center.configLoadFailed') : t('ai.center.noConfigShort'), {tone: 'error'});
        return;
      }
      if (!state.usable) {
        ctx.toast(t('ai.center.configNotUsable'), {tone: 'error'});
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
      statusEpoch += 1;
      reportEpoch += 1;
      renderStatus({
        status: 'running',
        stage: 'preparing',
        mode: runScope === 'both' ? 'combined' : runScope,
        batchIndex: 0,
        batchTotal: 0,
        sessionReportDone: false,
        memoryDone: false,
        requestStats: null
      });
      try {
        const current = await api.post('/api/ai/analyze/run', {
          sessionId: selectedId,
          locale,
          mode: runScope,
          configId: config.id,
          consent: true
        });
        statusEpoch += 1;
        renderStatus(current);
        if (current.running) timer = window.setTimeout(refreshStatus, 800);
        ctx.toast(t('ai.center.started'), {tone: 'info'});
      } catch (error) {
        renderStatus({
          status: 'failed',
          stage: 'failed',
          mode: runScope === 'both' ? 'combined' : runScope,
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
      if (status?.canResume === true && status?.status !== 'running') {
        try {
          const current = await api.post('/api/ai/analyze/resume', {
            sessionId: selectedId,
            consent: true
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
      renderSummary();
    });
    languageSelect.addEventListener('change', () => {
      locale = languageSelect.value;
    });
    sessionSelect.addEventListener('change', async () => {
      selectedId = sessionSelect.value;
      status = null;
      statusEpoch += 1;
      reportEpoch += 1;
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      syncUrl();
      renderAll();
      await Promise.all([refreshStatus(), refreshReport()]);
    });

    syncUrl();
    renderAll();
    await Promise.all([refreshStatus(), refreshReport()]);
    return () => {
      if (timer) window.clearTimeout(timer);
      syncRequestTicker(false);
      statusEpoch += 1;
      reportEpoch += 1;
    };
  }
};
