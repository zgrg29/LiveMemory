import {api} from '../api.js';
import {createModal} from '../dialog.js';
import {
  chip,
  clear,
  el,
  emptyState,
  formatBytes,
  formatDateTime,
  formatInteger,
  pageHead
} from '../ui.js';
import {platformLabel} from './shared.js';
import {renderAnalysisReport} from './ai-report.js';
import {buildRepairInstruction, importGapSummary} from './ai-import-repair.js';

/**
 * AI analysis centre: a manual, provider-neutral file round trip plus the
 * optional automatic free route.
 *
 * 1. choose a recorded broadcast and create a versioned task;
 * 2. download one package per batch and copy the matching prompt;
 * 3. analyse with any AI service (or let the automatic route call one verified
 *    anonymous provider after explicit consent);
 * 4. paste/select the JSON answer, validate it against the real database, and
 *    import it in one transaction;
 * 5. read the report, which is always labelled as AI output.
 *
 * The page stays usable with a keyboard and plain HTML: no innerHTML, no JSON
 * executed, and a failed validation is shown as field → reason → fix.
 */

const MAX_IMPORT_MB = 8;
const STATUS_TONES = {
  awaiting_import: 'warn',
  partial: 'warn',
  awaiting_aggregate: 'warn',
  invalid: 'warn',
  complete: 'accent'
};

function jobStatusChip(ctx, job) {
  const state = job.status?.state ?? 'awaiting_import';
  return chip(ctx.t(`ai.job.status.${state}`), STATUS_TONES[state] ?? 'neutral');
}

function coverageText(ctx, job) {
  return ctx.t('ai.jobs.batches', {
    done: formatInteger(job.status?.batchesImported ?? 0, ctx.locale),
    total: formatInteger(job.batchTotal, ctx.locale)
  });
}

function versionsText(versions) {
  const entries = Object.entries(versions ?? {});
  if (entries.length === 0) return '—';
  return entries.map(([scope, list]) => {
    const label = scope === 'final' ? 'final' : scope.replace('batch:', 'B');
    return `${label} v${(list ?? []).join(',')}`;
  }).join(' · ');
}

async function confirmDialog(ctx, {title, body, confirmLabel}) {
  return new Promise((resolve) => {
    const modal = createModal({title, t: ctx.t});
    modal.body.append(el('p', {className: 'modal-desc', text: body}));
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
      text: confirmLabel,
      onClick: () => {
        modal.close();
        resolve(true);
      }
    });
    modal.actions.append(cancel, ok);
    ok.focus();
  });
}

function field(label, control) {
  return el('div', {className: 'field'},
    el('label', {className: 'label', text: label}),
    control);
}

function defRow(key, value) {
  return el('div', {className: 'def-row'},
    el('span', {className: 'def-key', text: key}),
    el('span', {className: 'def-value', text: value}));
}

export const aiPage = {
  titleKey: 'ai.pageTitle',

  async render(container, ctx, params, query) {
    const t = ctx.t;
    const sessionsPayload = await api.get('/api/sessions?limit=100&includeArchived=1');
    const sessions = sessionsPayload.sessions ?? [];
    const requested = query?.get('session');
    let selectedId = requested && sessions.some((session) => session.id === requested)
      ? requested
      : (sessions[0]?.id ?? null);
    let locale = ctx.locale;
    let jobs = [];
    let activeJobId = null;
    let promptChoice = '1';
    let promptText = '';
    let promptMeta = null;
    let report = null;
    let preview = null;
    let previewText = '';
    let previewSource = 'paste';
    let fileState = null;
    let busy = false;
    let justCreated = false;
    let autoStatus = null;
    let autoTimer = null;
    let autoRunning = false;
    let autoRefreshedFor = null;

    container.append(pageHead({title: t('ai.pageTitle'), subtitle: t('ai.pageSubtitle')}));

    const steps = el('div', {className: 'steps'},
      stepCard('1', t('ai.steps.exportTitle'), t('ai.steps.exportDesc'), 'active'),
      stepCard('2', t('ai.steps.promptTitle'), t('ai.steps.promptDesc'), 'next'),
      stepCard('3', t('ai.steps.importTitle'), t('ai.steps.importDesc'), 'next'));
    container.append(steps);

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

    /* --------------------------------------------------------------- setup */

    const sessionSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.setup.sessionLabel')}},
      sessions.map((session) => el('option', {
        value: session.id,
        text: `${session.roomTitle || platformLabel(session.platform, t)} · ${formatDateTime(session.startedAt, ctx.locale)}`
      })));
    sessionSelect.value = selectedId;

    const languageSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.setup.languageLabel')}},
      el('option', {value: 'zh-CN', text: t('settings.language.zh')}),
      el('option', {value: 'ja', text: t('settings.language.ja')}),
      el('option', {value: 'en', text: t('settings.language.en')}));
    languageSelect.value = locale;

    const batchSizeInput = el('input', {
      className: 'input input--compact',
      type: 'number',
      value: '1000',
      attrs: {'aria-label': t('ai.setup.batchSize'), min: '100', max: '5000', step: '100'}
    });

    const createButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('ai.setup.create')
    });
    const createResult = el('div', {className: 'stack stack--tight'});

    /* ------------------------------------------------------------ automatic */

    const autoButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('ai.auto.button')
    });
    const autoCancelButton = el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('ai.auto.cancel'),
      hidden: true
    });
    const autoStatusText = el('div', {
      className: 'auto-status',
      attrs: {role: 'status', 'aria-live': 'polite'}
    });
    const autoError = el('div', {
      className: 'auto-error',
      attrs: {role: 'alert'},
      hidden: true
    });
    const autoDetailsText = el('div', {className: 'small tertiary'});
    const autoDetails = el('details', {className: 'auto-details', hidden: true},
      el('summary', {text: t('ai.auto.details')}),
      autoDetailsText);
    const autoPanel = el('section', {className: 'auto-panel', attrs: {'aria-label': t('ai.auto.title')}},
      el('div', {className: 'auto-panel-head'},
        el('div', {},
          el('div', {className: 'auto-panel-title', text: t('ai.auto.title')}),
          el('div', {className: 'small tertiary', text: t('ai.auto.body')})),
        chip(t('ai.auto.badge'), 'accent')),
      el('div', {className: 'auto-actions'}, autoButton, autoCancelButton),
      autoError,
      autoStatusText,
      autoDetails);

    const setupCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('ai.setup.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'grid-2-equal'},
          field(t('ai.setup.sessionLabel'), sessionSelect),
          field(t('ai.setup.languageLabel'), languageSelect)),
        autoPanel,
        el('div', {className: 'auto-divider'},
          el('span', {text: t('ai.auto.manualDivider')})),
        el('details', {className: 'advanced'},
          el('summary', {text: t('ai.setup.advanced')}),
          el('div', {className: 'advanced-body'},
            field(t('ai.setup.batchSize'), batchSizeInput),
            el('div', {className: 'small tertiary', text: t('ai.setup.batchSizeHint')}))),
        el('div', {style: {marginTop: '14px'}}, createButton),
        el('div', {className: 'small tertiary', style: {marginTop: '10px'}}, t('ai.setup.note')),
        createResult));

    /* -------------------------------------------------------------- prompt */

    const promptSelect = el('select', {className: 'select select--compact', attrs: {'aria-label': t('ai.prompt.title')}});
    const promptMetaEl = el('span', {className: 'small tertiary'});
    const promptBox = el('pre', {className: 'prompt-box', attrs: {tabindex: '0'}}, t('ai.prompt.loading'));
    const copyButton = el('button', {
      className: 'button button--secondary button--small',
      type: 'button',
      text: t('ai.prompt.copy'),
      disabled: true
    });
    const promptCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.prompt.title')}),
        el('div', {className: 'inline'}, promptMetaEl, copyButton)),
      el('div', {className: 'card-body'},
        el('div', {className: 'field'}, promptSelect),
        promptBox,
        el('div', {className: 'small tertiary', style: {marginTop: '8px'}}, t('ai.prompt.hint'))));

    /* -------------------------------------------------------------- import */

    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      attrs: {'aria-label': t('ai.import.fileLabel')},
      style: {display: 'none'}
    });
    const fileButton = el('button', {
      className: 'button button--secondary',
      type: 'button',
      text: t('ai.import.chooseFile'),
      onClick: () => fileInput.click()
    });
    const fileInfo = el('div', {className: 'small tertiary'});
    const importText = el('textarea', {
      className: 'input import-textarea',
      attrs: {
        'aria-label': t('ai.import.pasteLabel'),
        rows: '8',
        spellcheck: 'false',
        placeholder: t('ai.import.pastePlaceholder')
      }
    });
    const validateButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('ai.import.validate')
    });
    const clearImportButton = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('ai.import.clear'),
      onClick: () => {
        importText.value = '';
        fileState = null;
        preview = null;
        fileInfo.textContent = '';
        renderPreview();
      }
    });
    const previewHost = el('div', {className: 'import-preview'});
    const importCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.import.title')}),
        chip(t('ai.report.aiBadge'), 'accent')),
      el('div', {className: 'card-body'},
        el('div', {className: 'small tertiary', text: t('ai.import.body')}),
        el('div', {className: 'import-source-row', style: {marginTop: '12px'}},
          fileButton,
          fileInput,
          fileInfo),
        el('div', {className: 'field', style: {marginTop: '12px'}},
          el('label', {className: 'label', text: t('ai.import.pasteLabel')}),
          importText),
        el('div', {className: 'inline', style: {marginTop: '12px'}},
          validateButton,
          clearImportButton,
          el('span', {className: 'small tertiary', text: t('ai.import.pasteHint', {limit: MAX_IMPORT_MB})})),
        previewHost));

    /* ---------------------------------------------------------------- jobs */

    const jobsHost = el('div', {className: 'card-body'});
    const jobsCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.jobs.title')}),
        el('div', {className: 'card-hint', text: 'livememory-analysis-v1'})),
      jobsHost);

    const reportHost = el('div', {className: 'report-host'});

    container.append(
      el('div', {className: 'grid-2-equal'}, setupCard, promptCard),
      el('div', {style: {marginTop: '16px'}}, importCard),
      el('div', {style: {marginTop: '16px'}}, jobsCard),
      reportHost);

    /* --------------------------------------------------------------- logic */

    function stepCard(index, title, desc, state) {
      return el('div', {className: 'step-card', dataset: {state}},
        el('span', {className: 'step-index', text: index}),
        el('div', {className: 'step-title', text: title}),
        el('div', {className: 'step-desc', text: desc}));
    }

    function activeJob() {
      return jobs.find((job) => job.id === activeJobId) ?? jobs[0] ?? null;
    }

    function setBusy(node, value, label) {
      node.disabled = value;
      if (label) node.textContent = label;
    }

    function syncUrl() {
      try {
        window.history.replaceState(null, '', `#/ai?session=${encodeURIComponent(selectedId ?? '')}`);
      } catch {
        /* history is best effort */
      }
    }

    async function refreshJobs() {
      const payload = await api.get(`/api/ai/jobs?sessionId=${encodeURIComponent(selectedId ?? '')}`);
      jobs = payload.jobs ?? [];
      if (!jobs.some((job) => job.id === activeJobId)) activeJobId = jobs[0]?.id ?? null;
      const job = activeJob();
      if (job) {
        // The visible "analysis language" follows the task that owns the
        // displayed prompt; changing it only affects the next task.
        locale = job.locale;
        languageSelect.value = locale;
      } else {
        locale = ctx.locale;
        languageSelect.value = locale;
      }
      renderJobs();
      renderPromptSelect();
    }

    async function refreshReport() {
      clear(reportHost);
      try {
        report = await api.get(`/api/ai/sessions/${encodeURIComponent(selectedId ?? '')}/report`);
      } catch {
        report = null;
      }
      if (!report) return;
      const node = renderAnalysisReport(ctx, report, {
        onAggregate: report.mode === 'partial' || report.incompleteReason === 'awaiting_aggregate'
          ? () => createAggregate(report.primaryJob?.id)
          : null
      });
      if (node) reportHost.append(node);
    }

    function renderPromptSelect() {
      clear(promptSelect);
      const job = activeJob();
      if (!job) {
        promptSelect.append(el('option', {value: 'generic', text: `${t('ai.prompt.title')} · ${locale}`}));
        promptSelect.value = 'generic';
        promptSelect.disabled = true;
        return;
      }
      const options = [];
      for (let index = 1; index <= job.batchTotal; index += 1) {
        options.push(el('option', {
          value: String(index),
          text: t('ai.jobs.batch', {index, total: job.batchTotal})
        }));
      }
      if (job.aggregatePackageId) {
        options.push(el('option', {value: 'aggregate', text: t('ai.jobs.aggregatePackage')}));
      }
      promptSelect.append(...options);
      if (!options.some((option) => option.value === promptChoice)) promptChoice = '1';
      promptSelect.value = promptChoice;
      promptSelect.disabled = false;
    }

    async function loadPrompt() {
      const job = activeJob();
      promptMetaEl.textContent = '';
      try {
        let payload;
        if (!job) {
          payload = await api.get(`/api/ai/instructions?locale=${encodeURIComponent(locale)}`);
        } else if (promptChoice === 'aggregate') {
          payload = await api.get(`/api/ai/instructions?jobId=${encodeURIComponent(job.id)}&stage=aggregate`);
        } else {
          payload = await api.get(`/api/ai/instructions?jobId=${encodeURIComponent(job.id)}&batchIndex=${encodeURIComponent(promptChoice)}`);
        }
        promptText = payload.text ?? '';
        promptBox.textContent = promptText;
        promptMeta = payload;
        promptMetaEl.textContent = payload.promptVersion
          ? t('ai.packages.promptVersion', {version: payload.promptVersion})
          : '';
        copyButton.disabled = false;
      } catch (error) {
        promptText = '';
        promptBox.textContent = ctx.describeError(error);
        copyButton.disabled = true;
      }
    }

    function renderCreateResult() {
      clear(createResult);
      const job = activeJob();
      if (!justCreated || !job || job.sessionId !== selectedId) return;
      createResult.append(
        el('div', {className: 'callout', style: {marginTop: '14px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('ai.setup.created')}),
            el('div', {text: t('ai.setup.jobSummary', {
              batches: formatInteger(job.batchTotal, ctx.locale),
              messages: formatInteger(job.totalMessages, ctx.locale),
              promptVersion: job.promptVersion
            })}))));
    }

    function renderJobs() {
      clear(jobsHost);
      if (jobs.length === 0) {
        jobsHost.append(emptyState({title: t('ai.jobs.empty'), glyph: '·'}));
        return;
      }
      for (const job of jobs) {
        const status = job.status ?? {};
        const packages = job.packages ?? [];
        const actions = el('div', {className: 'inline job-actions'},
          job.aggregatePackageId
            ? el('button', {
              className: 'button button--secondary button--small',
              type: 'button',
              text: t('ai.jobs.aggregatePackage'),
              onClick: () => {
                api.download(`/api/ai/packages/${encodeURIComponent(job.aggregatePackageId)}/download`);
                ctx.toast(t('toast.downloadStarted'));
              }
            })
            : null,
          status.state === 'awaiting_aggregate'
            ? el('button', {
              className: 'button button--primary button--small',
              type: 'button',
              text: t('ai.jobs.aggregate'),
              onClick: () => createAggregate(job.id)
            })
            : null,
          el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: t('ai.jobs.viewReport'),
            onClick: () => {
              document.getElementById('ai-report')?.scrollIntoView({block: 'start'});
            }
          }),
          el('button', {
            className: 'button button--ghost button--small',
            type: 'button',
            text: t('ai.jobs.reanalyze'),
            onClick: () => reanalyze()
          }));
        const packagesHost = el('div', {className: 'job-packages'},
          packages.length === 0
            ? el('div', {className: 'small tertiary', text: t('ai.jobs.noPackages')})
            : packages.map((item) => el('div', {className: 'package-row'},
              el('span', {className: 'package-name', text: item.fileName}),
              el('span', {className: 'small tertiary', text: item.stage === 'aggregate'
                ? t('ai.packages.stageAggregate')
                : `${t('ai.jobs.batch', {index: item.batchIndex ?? 1, total: job.batchTotal})} · ${t('live.top.messages', {n: formatInteger(item.messageCount, ctx.locale)})}`}),
              el('span', {className: 'small tertiary', text: `${formatInteger(item.messageCount, ctx.locale)} · ${formatBytes(item.bytes ?? 0, ctx.locale)}`}),
              el('button', {
                className: 'button button--secondary button--small',
                type: 'button',
                text: t('ai.packages.download'),
                onClick: () => {
                  api.download(`/api/ai/packages/${encodeURIComponent(item.id)}/download`);
                  ctx.toast(t('toast.downloadStarted'));
                }
              }))));

        const errorDetail = job.status?.latestError?.errors?.[0];
        jobsHost.append(el('div', {className: `job-row${job.id === activeJobId ? ' job-row--active' : ''}`},
          el('div', {className: 'job-head'},
            el('div', {className: 'job-head-text'},
              el('div', {className: 'job-line'},
                jobStatusChip(ctx, job),
                el('span', {className: 'job-created', text: t('ai.jobs.created', {
                  date: formatDateTime(job.createdAt, ctx.locale)
                })}),
                job.legacy ? chip(t('ai.jobs.legacy'), 'neutral') : null),
              el('div', {className: 'job-meta'},
                el('span', {text: coverageText(ctx, job)}),
                status.memoryCoverage?.total > 0
                  ? el('span', {
                    className: status.memoryCoverage.complete ? '' : 'tertiary',
                    text: t('ai.jobs.memoryCoverage', {
                      covered: formatInteger(status.memoryCoverage.covered ?? 0, ctx.locale),
                      total: formatInteger(status.memoryCoverage.total ?? 0, ctx.locale)
                    })
                  })
                  : null,
                el('span', {text: t('ai.jobs.prompt', {version: job.promptVersion})}),
                el('span', {text: t('ai.jobs.versions', {versions: versionsText(status.versions)})}),
                job.aggregateImported ? chip(t('ai.jobs.aggregateDone'), 'accent') : null)),
            actions),
          status.missingBatches?.length > 0
            ? el('div', {className: 'small tertiary', text: t('ai.jobs.missing', {
              list: status.missingBatches.join(', ')
            })})
            : null,
          status.state === 'awaiting_aggregate' && !job.aggregatePackageId
            ? el('div', {className: 'small tertiary', text: t('ai.jobs.aggregateHint')})
            : null,
          status.latestError
            ? el('div', {className: 'callout callout--warn', style: {marginTop: '10px'}},
              el('div', {},
                el('div', {className: 'callout-title', text: t('ai.jobs.latestError')}),
                el('div', {
                  className: 'small',
                  text: errorDetail
                    ? `${errorDetail.path || '—'} · ${t(`ai.import.reason.${errorDetail.code}`, errorDetail.params ?? {})}`
                    : t('errors.aiImportInvalid')
                })))
            : null,
          packagesHost));
      }
    }

    function renderPreview() {
      clear(previewHost);
      if (!preview) return;
      const payload = preview;
      const target = payload.target ?? {};
      const result = payload.result ?? {};
      const session = target.session;
      const job = target.job;
      const batch = target.batch;
      const errors = payload.errors ?? [];
      const warnings = payload.warnings ?? [];
      const action = payload.action;

      const targetRows = el('div', {className: 'def-list import-target'});
      targetRows.append(
        defRow(t('ai.import.targetSession'), session
          ? `${session.roomTitle || platformLabel(session.platform, t)} · ${formatDateTime(session.startedAt, ctx.locale)}`
          : t('ai.import.noTarget')),
        defRow(t('ai.import.targetTask'), target.taskId ?? '—'),
        defRow(t('ai.import.targetBatch'), target.mode === 'aggregate'
          ? t('ai.report.aggregateMode')
          : (batch
            ? `${t('ai.jobs.batch', {index: batch.index, total: job?.batchTotal ?? batch.index})} · ${t('ai.import.coverageValue', {
              from: batch.fromSeq,
              to: batch.toSeq,
              total: job?.totalMessages ?? batch.messageCount
            })}`
            : '—')),
        defRow(t('ai.import.schemaVersion'), target.schemaVersion ?? '—'),
        defRow(t('ai.report.scope'), job
          ? t('ai.report.batchCoverage', {
            done: formatInteger(payload.action === 'duplicate' ? (job.batchesImported ?? 0) : (job.batchesImported ?? 0), ctx.locale),
            total: formatInteger(job.batchTotal ?? 1, ctx.locale),
            messages: formatInteger(job.totalMessages ?? 0, ctx.locale)
          })
          : '—'));

      const nodes = [
        el('div', {className: 'preview-head'},
          el('div', {className: 'card-title', text: t('ai.import.previewTitle')}),
          payload.ok ? chip(t(`ai.job.status.${action === 'duplicate' ? 'complete' : 'awaiting_import'}`), action === 'duplicate' ? 'accent' : 'warn') : chip(t('ai.job.status.invalid'), 'warn')),
        targetRows
      ];

      if (payload.memory) {
        const memory = payload.memory;
        const coverage = memory.coverage ?? {};
        const gaps = importGapSummary(memory);
        const memoryRows = el('div', {className: 'def-list import-target'});
        memoryRows.append(
          defRow(t('ai.import.memoryViewers'), t('ai.import.memoryCoverageValue', {
            covered: formatInteger(coverage.semantic + coverage.no_semantics, ctx.locale),
            total: formatInteger(coverage.total ?? memory.viewerCount ?? 0, ctx.locale)
          })),
          defRow(t('ai.import.memorySemantic'), formatInteger(coverage.semantic ?? 0, ctx.locale)),
          defRow(t('ai.import.memoryNoSemantic'), formatInteger(coverage.no_semantics ?? 0, ctx.locale)),
          defRow(t('ai.import.memoryObjective'), formatInteger(coverage.objective_only ?? 0, ctx.locale)),
          defRow(t('ai.import.memoryMissing'), formatInteger(coverage.missing_update ?? 0, ctx.locale)),
          defRow(t('ai.import.memoryFacts'), formatInteger(memory.totals?.operations ?? 0, ctx.locale))
        );
        if (!gaps.empty) {
          const gapBlock = el('div', {style: {marginTop: '10px'}});
          gapBlock.append(el('div', {className: 'label', text: t('ai.import.memoryGapsTitle')}));
          const addGapRows = (entries) => {
            for (const entry of entries.slice(0, 50)) {
              gapBlock.append(el('div', {
                className: 'small mono',
                text: entry.nickname ? `${entry.nickname} · ${entry.viewerId}` : String(entry.viewerId ?? '')
              }));
            }
            if (entries.length > 50) {
              gapBlock.append(el('div', {className: 'small tertiary', text: `… +${entries.length - 50}`}));
            }
          };
          addGapRows(gaps.missing);
          addGapRows(gaps.unknown);
          addGapRows(gaps.duplicate);
          memoryRows.append(gapBlock);
        }
        nodes.push(el('section', {className: 'card', style: {marginTop: '12px'}},
          el('div', {className: 'card-head'},
            el('div', {className: 'card-title', text: t('ai.import.memoryTitle')}),
            el('div', {className: 'card-hint', text: t('ai.import.memoryHint')})),
          el('div', {className: 'card-body'},
            memoryRows,
            el('p', {className: 'small tertiary', text: t('ai.import.memoryAuto')}))));
        // A failed import is often an external model's bookkeeping mistake.
        // Offer the exact gaps back as a paste-ready instruction; never change
        // an id on the user's behalf.
        if (!gaps.empty || errors.length > 0) {
          const repairButton = el('button', {
            className: 'button button--secondary',
            type: 'button',
            text: t('ai.import.repairCopy'),
            style: {marginTop: '10px'}
          });
          repairButton.addEventListener('click', async () => {
            const instruction = buildRepairInstruction({
              ...gaps,
              errors,
              t
            });
            try {
              await navigator.clipboard.writeText(instruction);
              ctx.toast(t('ai.import.repairCopied'));
            } catch {
              const helper = el('textarea', {style: {position: 'fixed', opacity: '0'}});
              helper.value = instruction;
              document.body.append(helper);
              helper.select();
              try {
                document.execCommand('copy');
                ctx.toast(t('ai.import.repairCopied'));
              } catch {
                ctx.toast(t('ai.import.repairCopyFailed'), {tone: 'error'});
              }
              helper.remove();
            }
          });
          nodes.push(repairButton);
        }
      }

      if (target.legacy) {
        nodes.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '10px'}}, t('ai.import.legacyNotice')));
      }
      if (action === 'duplicate') {
        nodes.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '10px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('ai.import.duplicateTitle')}),
            el('div', {text: t('ai.import.duplicateBody', {
              version: formatInteger(target.duplicate?.resultVersion ?? 0, ctx.locale)
            })}))));
      }
      if (errors.length > 0) {
        nodes.push(el('div', {className: 'callout callout--warn', style: {marginTop: '10px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('ai.import.errorsTitle', {n: errors.length})}),
            el('div', {text: t('ai.import.errorsHint')}))));
        nodes.push(el('div', {className: 'import-issue-list'}, errors.map((error) => {
          const fix = error.fixGroup && error.fixGroup !== 'none'
            ? t(`ai.import.fix.${error.fixGroup}`)
            : null;
          return el('div', {className: 'import-issue'},
            el('div', {className: 'import-issue-head'},
              el('span', {className: 'mono import-issue-path', text: error.path || '(root)'}),
              chip(error.code, 'warn')),
            el('div', {className: 'import-issue-reason', text: t(`ai.import.reason.${error.code}`, error.params ?? {})}),
            fix ? el('div', {className: 'import-issue-fix', text: `${t('ai.import.fix')}: ${fix}`}) : null);
        })));
      }
      if (warnings.length > 0) {
        nodes.push(el('details', {className: 'import-warnings'},
          el('summary', {text: t('ai.import.warningsTitle', {n: warnings.length})}),
          el('div', {className: 'small tertiary', text: t('ai.import.warningsHint')}),
          el('div', {className: 'import-issue-list'}, warnings.map((warning) => el('div', {className: 'import-issue import-issue--warning'},
            el('div', {className: 'import-issue-head'},
              el('span', {className: 'mono import-issue-path', text: warning.path || '(root)'}),
              chip(warning.code, 'neutral')),
            el('div', {className: 'import-issue-reason', text: t(`ai.import.reason.${warning.code}`, warning.params ?? {})}))))));
      }

      if (payload.ok && action !== 'duplicate') {
        const isVersion = action === 'confirm_version';
        if (isVersion) {
          nodes.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '10px'}},
            el('div', {},
              el('div', {className: 'callout-title', text: t('ai.import.versionTitle')}),
              el('div', {text: t('ai.import.versionBody', {
                version: formatInteger(target.latestVersion ?? 0, ctx.locale),
                next: formatInteger((target.latestVersion ?? 0) + 1, ctx.locale)
              })}))));
        }
        const confirm = el('button', {
          className: 'button button--primary',
          type: 'button',
          text: isVersion ? t('ai.import.confirmVersion') : t('ai.import.confirm')
        });
        confirm.addEventListener('click', () => doImport(confirm));
        nodes.push(el('div', {className: 'inline', style: {marginTop: '12px'}}, confirm));
      }
      previewHost.append(el('div', {className: 'import-preview-body'}, nodes));
    }

    async function doImport(button) {
      if (busy) return;
      const source = previewText.trim() ? 'paste' : 'file';
      busy = true;
      setBusy(button, true, t('ai.import.importing'));
      try {
        const payload = await api.post('/api/ai/import', {
          json: previewText,
          source,
          createVersion: preview?.action === 'confirm_version'
        });
        preview = payload.duplicate ? {...preview, action: 'duplicate', target: {...(preview.target ?? {}), duplicate: payload.result}} : null;
        if (payload.duplicate) {
          ctx.toast(t('toast.aiDuplicate'), {tone: 'info'});
        } else {
          ctx.toast(t('toast.aiImported'));
        }
        importText.value = '';
        fileState = null;
        fileInfo.textContent = '';
        previewText = '';
        preview = null;
        report = payload.report ?? report;
        // The report is reloaded from the database once; rendering it twice here
        // caused a flicker where a transient summary could be observed.
        await refreshJobs();
        await refreshReport();
        if (!payload.duplicate && payload.result) {
          const memoryCoverage = payload.job?.status?.memoryCoverage;
          previewHost.replaceChildren(el('div', {className: 'callout', style: {marginTop: '14px'}},
            el('div', {},
              el('div', {className: 'callout-title', text: t('ai.import.successTitle')}),
              el('div', {text: t('ai.import.successBody', {
                version: formatInteger(payload.result.resultVersion, ctx.locale)
              })}),
              memoryCoverage && Number(memoryCoverage.total) > 0
                ? el('div', {className: 'small', text: t('ai.import.successMemory', {
                  covered: formatInteger(memoryCoverage.covered ?? 0, ctx.locale),
                  total: formatInteger(memoryCoverage.total ?? 0, ctx.locale)
                })})
                : null)));
          document.getElementById('ai-report')?.scrollIntoView({block: 'start'});
        } else {
          renderPreview();
        }
      } catch (error) {
        if (error?.code === 'AI_IMPORT_INVALID' && error.details?.errors) {
          preview = {
            ok: false,
            action: 'blocked',
            errors: error.details.errors,
            warnings: error.details.warnings ?? [],
            target: error.details.target ?? {}
          };
          renderPreview();
        }
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        busy = false;
        if (button.isConnected) {
          setBusy(button, false, preview?.action === 'confirm_version' ? t('ai.import.confirmVersion') : t('ai.import.confirm'));
        }
      }
    }

    async function validateInput() {
      if (busy) return;
      previewText = importText.value.trim();
      previewSource = previewText ? 'paste' : 'file';
      if (!previewText) {
        if (!fileState) {
          ctx.toast(t('ai.import.jsonEmpty'), {tone: 'info'});
          return;
        }
        previewText = fileState.text;
        previewSource = 'file';
      }
      busy = true;
      setBusy(validateButton, true, t('ai.import.validating'));
      try {
        preview = await api.post('/api/ai/import/preview', {json: previewText, source: previewSource});
        renderPreview();
      } catch (error) {
        preview = null;
        renderPreview();
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        busy = false;
        setBusy(validateButton, false, t('ai.import.validate'));
      }
    }

    async function createTask() {
      if (busy) return;
      busy = true;
      setBusy(createButton, true, t('ai.setup.creating'));
      try {
        const payload = await api.post('/api/ai/jobs', {
          sessionId: selectedId,
          locale,
          batchSize: Number(batchSizeInput.value) || 1000
        });
        activeJobId = payload.job.id;
        promptChoice = '1';
        preview = null;
        clear(previewHost);
        justCreated = true;
        await refreshJobs();
        await loadPrompt();
        await refreshReport();
        renderCreateResult();
        ctx.toast(t('toast.aiJobCreated'));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        busy = false;
        setBusy(createButton, false, t('ai.setup.create'));
      }
    }

    async function createAggregate(jobId) {
      if (!jobId || busy) return;
      busy = true;
      try {
        const payload = await api.post(`/api/ai/jobs/${encodeURIComponent(jobId)}/aggregate`, {});
        activeJobId = payload.job.id;
        await refreshJobs();
        promptChoice = 'aggregate';
        renderPromptSelect();
        await loadPrompt();
        await refreshReport();
        ctx.toast(t('ai.jobs.aggregateReady'));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        busy = false;
      }
    }

    async function reanalyze() {
      const job = activeJob();
      if (job && !await confirmDialog(ctx, {
        title: t('ai.jobs.reanalyze'),
        body: t('ai.jobs.reanalyzeHint'),
        confirmLabel: t('ai.jobs.reanalyze')
      })) return;
      await createTask();
    }

    /* ------------------------------------------------------- automatic flow */

    const AUTO_CONSENT_KEY = 'livememory.aiAutoConsent.v1';

    function autoConsentGranted() {
      try {
        return window.localStorage.getItem(AUTO_CONSENT_KEY) === 'granted';
      } catch {
        return false;
      }
    }

    function storeAutoConsent() {
      try {
        window.localStorage.setItem(AUTO_CONSENT_KEY, 'granted');
      } catch {
        // Private mode / disabled storage: ask again next time, but do not block.
      }
    }

    function askAutoConsent() {
      return new Promise((resolve) => {
        const modal = createModal({title: t('ai.auto.consentTitle'), t: ctx.t});
        modal.body.append(
          el('p', {className: 'modal-desc', text: t('ai.auto.consentBody')}),
          el('p', {className: 'small tertiary', text: t('ai.auto.consentHint')}));
        const cancel = el('button', {
          className: 'button button--ghost',
          type: 'button',
          text: t('common.cancel'),
          onClick: () => {
            modal.close();
            resolve(false);
          }
        });
        const ok = el('button', {
          className: 'button button--primary',
          type: 'button',
          text: t('ai.auto.consentContinue'),
          onClick: () => {
            modal.close();
            resolve(true);
          }
        });
        modal.actions.append(cancel, ok);
        ok.focus();
      });
    }

    function clearAutoError() {
      autoError.hidden = true;
      autoError.textContent = '';
      autoDetails.hidden = true;
      autoDetailsText.textContent = '';
    }

    function showAutoError(code, detail) {
      // One simple sentence is the primary message. Technical information only
      // lives in the collapsed details, never in an alert() dialog.
      autoError.hidden = false;
      autoError.textContent = t('ai.auto.error.summary');
      const reasonKey = `ai.auto.reason.${code}`;
      const reason = t(reasonKey);
      const localizedReason = reason === reasonKey ? String(code ?? '') : reason;
      autoDetails.hidden = false;
      autoDetailsText.textContent = detail
        ? `${localizedReason} · ${detail}`
        : localizedReason;
    }

    function autoStageLabel(status) {
      const stage = status?.stage ?? 'preparing';
      const index = Math.max(1, Number(status?.batchIndex ?? 1));
      const total = Math.max(index, Number(status?.batchTotal ?? status?.job?.batchTotal ?? 1));
      if (stage === 'connecting') return t('ai.auto.status.connecting');
      if (stage === 'analyzing') return t('ai.auto.status.analyzing', {index, total});
      if (stage === 'validating') return t('ai.auto.status.validating');
      if (stage === 'importing') return t('ai.auto.status.updating');
      if (stage === 'aggregating') return t('ai.auto.status.aggregating');
      if (stage === 'complete') return t('ai.auto.status.complete');
      if (stage === 'canceled') return t('ai.auto.status.canceled');
      return t('ai.auto.status.preparing');
    }

    function renderAutoStatus(status) {
      autoStatus = status;
      autoRunning = Boolean(status?.running);
      autoCancelButton.hidden = !autoRunning;
      autoCancelButton.disabled = !autoRunning;
      if (autoRunning) {
        autoButton.disabled = true;
        autoButton.textContent = t('ai.auto.buttonBusy');
        clearAutoError();
        autoStatusText.className = 'auto-status';
        autoStatusText.textContent = autoStageLabel(status);
        return;
      }
      autoButton.disabled = !selectedId;
      autoButton.textContent = t('ai.auto.button');
      if (!status || status.status === 'idle') {
        autoStatusText.textContent = '';
        autoStatusText.className = 'auto-status';
        clearAutoError();
        return;
      }
      if (status.status === 'complete') {
        clearAutoError();
        const coverage = status.job?.memoryCoverage;
        autoStatusText.className = 'auto-status auto-status--success';
        autoStatusText.textContent = coverage && Number(coverage.total) > 0
          ? t('ai.auto.status.completeMemory', {
            covered: formatInteger(coverage.covered ?? 0, ctx.locale),
            total: formatInteger(coverage.total ?? 0, ctx.locale)
          })
          : t('ai.auto.status.complete');
        return;
      }
      if (status.status === 'canceled') {
        clearAutoError();
        autoStatusText.className = 'auto-status';
        autoStatusText.textContent = t('ai.auto.status.canceled');
        return;
      }
      // failed or interrupted: red sentence below the button, details collapsed.
      autoStatusText.className = 'auto-status';
      autoStatusText.textContent = '';
      showAutoError(status.error?.code ?? 'AUTO_ALL_PROVIDERS_FAILED', status.error?.detail ?? null);
    }

    async function refreshAutoStatus() {
      if (autoTimer) {
        window.clearTimeout(autoTimer);
        autoTimer = null;
      }
      if (!selectedId) {
        renderAutoStatus({status: 'idle'});
        return;
      }
      try {
        const status = await api.get(`/api/ai/auto/status?sessionId=${encodeURIComponent(selectedId)}`);
        renderAutoStatus(status);
        if (status.running) {
          autoTimer = window.setTimeout(refreshAutoStatus, 1500);
        } else if (status.status === 'complete') {
          const key = `${selectedId}:${status.jobId ?? ''}`;
          if (autoRefreshedFor !== key) {
            autoRefreshedFor = key;
            await Promise.all([refreshJobs(), refreshReport(), loadPrompt()]);
          }
        }
      } catch {
        // A local status read must not be presented as an AI failure.
      }
    }

    async function startAuto() {
      if (autoRunning || !selectedId) return;
      if (!autoConsentGranted()) {
        const accepted = await askAutoConsent();
        if (!accepted) return;
        storeAutoConsent();
      }
      clearAutoError();
      autoButton.disabled = true;
      autoButton.textContent = t('ai.auto.starting');
      try {
        const status = await api.post('/api/ai/auto/run', {
          sessionId: selectedId,
          locale,
          consent: true
        });
        renderAutoStatus(status);
        if (status.running) {
          autoTimer = window.setTimeout(refreshAutoStatus, 800);
        }
        ctx.toast(t('ai.auto.started'), {tone: 'info'});
      } catch (error) {
        autoRunning = false;
        autoButton.disabled = false;
        autoButton.textContent = t('ai.auto.button');
        showAutoError(error?.code ?? 'AUTO_ALL_PROVIDERS_FAILED', ctx.describeError(error));
      }
    }

    async function cancelAuto() {
      if (!selectedId) return;
      autoCancelButton.disabled = true;
      try {
        const status = await api.post('/api/ai/auto/cancel', {sessionId: selectedId});
        renderAutoStatus(status);
        ctx.toast(t('ai.auto.cancelRequested'), {tone: 'info'});
      } catch (error) {
        autoCancelButton.disabled = false;
        showAutoError(error?.code ?? 'AUTO_ALL_PROVIDERS_FAILED', ctx.describeError(error));
      }
    }

    /* ------------------------------------------------------------- events */

    createButton.addEventListener('click', createTask);
    validateButton.addEventListener('click', validateInput);
    autoButton.addEventListener('click', startAuto);
    autoCancelButton.addEventListener('click', cancelAuto);
    sessionSelect.addEventListener('change', async () => {
      selectedId = sessionSelect.value;
      syncUrl();
      activeJobId = null;
      justCreated = false;
      preview = null;
      previewText = '';
      fileState = null;
      importText.value = '';
      fileInfo.textContent = '';
      clear(previewHost);
      clear(createResult);
      autoStatus = null;
      autoRunning = false;
      autoRefreshedFor = null;
      clearAutoError();
      await Promise.all([refreshJobs(), refreshReport(), loadPrompt()]);
      await refreshAutoStatus();
    });
    languageSelect.addEventListener('change', async () => {
      locale = languageSelect.value;
      if (!activeJob()) await loadPrompt();
      renderAutoStatus(autoStatus);
    });
    batchSizeInput.addEventListener('change', () => {
      const value = Number(batchSizeInput.value);
      if (!Number.isFinite(value) || value < 100 || value > 5000) {
        batchSizeInput.value = '1000';
        ctx.toast(t('errors.settingsInvalid'), {tone: 'error'});
      }
    });
    promptSelect.addEventListener('change', async () => {
      promptChoice = promptSelect.value;
      await loadPrompt();
    });
    copyButton.addEventListener('click', async () => {
      if (!promptText) return;
      try {
        await navigator.clipboard.writeText(promptText);
        ctx.toast(t('toast.copied'));
      } catch {
        const helper = el('textarea', {style: {position: 'fixed', opacity: '0'}});
        helper.value = promptText;
        document.body.append(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
        ctx.toast(t('toast.copied'));
      }
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_IMPORT_MB * 1024 * 1024) {
        ctx.toast(t('ai.import.fileTooLarge', {limit: MAX_IMPORT_MB}), {tone: 'error'});
        return;
      }
      try {
        const text = await file.text();
        fileState = {name: file.name, size: file.size, text};
        fileInfo.textContent = t('ai.import.fileChosen', {
          name: file.name,
          size: formatBytes(file.size, ctx.locale)
        });
        preview = null;
        renderPreview();
      } catch {
        ctx.toast(t('ai.import.readError'), {tone: 'error'});
      }
    });
    importText.addEventListener('input', () => {
      preview = null;
      renderPreview();
    });

    /* --------------------------------------------------------------- start */

    syncUrl();
    await refreshJobs();
    await Promise.all([loadPrompt(), refreshReport()]);
    await refreshAutoStatus();
    renderCreateResult();

    if (query?.get('report') === '1') {
      window.requestAnimationFrame(() => {
        document.getElementById('ai-report')?.scrollIntoView({block: 'start'});
      });
    }
    return () => {
      if (autoTimer) window.clearTimeout(autoTimer);
    };
  }
};
