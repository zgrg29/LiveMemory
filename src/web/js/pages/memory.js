import {api} from '../api.js';
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

/**
 * Long-term memory centre.
 *
 * Four steps, in the order a streamer actually works:
 *   1. choose the broadcast whose information is new,
 *   2. merge the analysis already imported for it (no AI involved),
 *   3. optionally export a memory update package for an external AI,
 *   4. import that AI answer, review the exact changes, then apply.
 *
 * Nothing is applied from an AI answer before the validated, human-readable
 * plan is shown, and every number/timestamp on this page comes from LiveMemory
 * itself, never from the AI.
 */

const MAX_IMPORT_MB = 8;

function stepCard(index, title, desc, state = 'next') {
  return el('div', {className: 'step-card', dataset: {state}},
    el('span', {className: 'step-index', text: index, attrs: {'aria-hidden': 'true'}}),
    el('div', {},
      el('div', {className: 'step-title', text: title}),
      el('div', {className: 'step-desc', text: desc})));
}

function field(labelText, control, hint = null) {
  return el('div', {className: 'field'},
    el('label', {className: 'label', text: labelText}),
    control,
    hint ? el('div', {className: 'small tertiary', style: {marginTop: '6px'}}, hint) : null);
}

function issueRow(issue, t) {
  const reason = t(`ai.import.reason.${issue.code}`);
  const fix = t(`ai.import.fix.${issue.fixGroup ?? 'none'}`);
  return el('div', {className: `import-issue${issue.severity === 'warning' ? ' import-issue--warning' : ''}`},
    el('div', {className: 'import-issue-head'},
      el('span', {className: 'import-issue-path mono', text: issue.path || '—'}),
      el('span', {className: 'import-issue-code', text: issue.code})),
    el('div', {className: 'import-issue-reason', text: reason === `ai.import.reason.${issue.code}` ? issue.code : reason}),
    fix && fix !== `ai.import.fix.${issue.fixGroup ?? 'none'}`
      ? el('div', {className: 'import-issue-fix', text: fix})
      : null);
}

function sessionLabel(session, t, locale) {
  const title = session.roomTitle || platformLabel(session.platform, t);
  return `${title} · ${formatDateTime(session.startedAt, locale)}`;
}

function opLabel(op, t) {
  const key = `memory.op.${op}`;
  const text = t(key);
  return text === key ? op : text;
}

function resultLabel(result, t) {
  const key = `memory.import.result.${result}`;
  const text = t(key);
  return text === key ? result : text;
}

export const memoryPage = {
  titleKey: 'memory.pageTitle',

  async render(container, ctx, params, query) {
    const t = ctx.t;
    const locale = ctx.locale;

    /* ------------------------------------------------------------- state */
    const broadcastersPayload = await api.get('/api/broadcasters');
    const broadcasters = broadcastersPayload?.broadcasters ?? [];
    const requestedScope = query?.get('broadcaster') ?? ctx.state.status?.platform?.activeSession?.broadcasterId ?? null;
    let broadcasterId = broadcasters.some((entry) => entry.id === requestedScope)
      ? requestedScope
      : (broadcastersPayload?.currentId ?? broadcasters[0]?.id ?? null);
    let overview = null;
    let selectedSessionId = null;
    let mergePreview = null;
    let mergeBusy = false;
    let jobDetail = null;
    let jobBusy = false;
    let promptText = '';
    let importText = '';
    let preview = null;
    let previewBusy = false;
    let importBusy = false;
    let fileState = null;
    let prunePreview = null;

    container.append(pageHead({title: t('memory.pageTitle'), subtitle: t('memory.pageSubtitle')}));

    const steps = el('div', {className: 'steps'},
      stepCard('1', t('memory.sourceTitle'), t('memory.sourceHint'), 'active'),
      stepCard('2', t('memory.mergeTitle'), t('memory.mergeHint'), 'next'),
      stepCard('3', t('memory.jobTitle'), t('memory.jobHint'), 'next'),
      stepCard('4', t('memory.importTitle'), t('memory.importHint'), 'next'));
    container.append(steps);

    container.append(el('div', {className: 'callout callout--neutral privacy-note'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('memory.privacyTitle')}),
        el('div', {text: t('memory.privacyBody')}),
        el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: t('memory.privacyLocal')}))));

    if (broadcasters.length === 0) {
      container.append(el('section', {className: 'card card--padded'},
        emptyState({
          title: t('memory.sourceAnalysisMissing'),
          body: t('memory.noMemoryBody'),
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

    /* ------------------------------------------------------------- source */
    const scopeSelect = el('select', {className: 'select', attrs: {'aria-label': t('viewers.scope.label')}},
      broadcasters.map((entry) => el('option', {
        value: entry.id,
        text: entry.displayName || entry.platformUid || entry.id
      })));
    scopeSelect.value = broadcasterId ?? '';

    const sessionSelect = el('select', {className: 'select', attrs: {'aria-label': t('memory.sourcePick')}});
    const sourceMeta = el('div', {className: 'small tertiary'});
    const sourceCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.sourceTitle')}),
        el('div', {className: 'card-hint', text: t('memory.sourceHint')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'grid-2-equal'},
          field(t('viewers.scope.label'), scopeSelect),
          field(t('memory.sourcePick'), sessionSelect)),
        sourceMeta));

    /* -------------------------------------------------------------- merge */
    const mergeHost = el('div');
    const mergePreviewButton = el('button', {
      className: 'button button--secondary',
      type: 'button',
      text: t('memory.mergePreview')
    });
    const mergeCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.mergeTitle')}),
        el('div', {className: 'card-hint', text: t('memory.mergeHint')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'inline'}, mergePreviewButton),
        mergeHost));

    /* ---------------------------------------------------------------- job */
    const jobHost = el('div');
    const jobCreateButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('memory.jobCreate')
    });
    const jobMeta = el('div', {className: 'small tertiary'});
    const jobCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.jobTitle')}),
        el('div', {className: 'card-hint', text: t('memory.jobHint')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'inline'}, jobCreateButton, jobMeta),
        jobHost));

    /* ------------------------------------------------------------- import */
    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      attrs: {'aria-label': t('memory.importPasteLabel')},
      style: {display: 'none'}
    });
    const fileButton = el('button', {
      className: 'button button--secondary',
      type: 'button',
      text: t('memory.importChooseFile'),
      onClick: () => fileInput.click()
    });
    const fileInfo = el('div', {className: 'small tertiary'});
    const importArea = el('textarea', {
      className: 'input import-textarea',
      attrs: {
        'aria-label': t('memory.importPasteLabel'),
        rows: '8',
        spellcheck: 'false',
        placeholder: t('memory.importPlaceholder')
      }
    });
    const validateButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('memory.importValidate')
    });
    const applyButton = el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('memory.importApply'),
      disabled: true
    });
    const clearButton = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('memory.importClear'),
      onClick: () => {
        importText = '';
        fileState = null;
        preview = null;
        importArea.value = '';
        fileInfo.textContent = '';
        renderImport();
      }
    });
    const importPreviewHost = el('div', {className: 'import-preview'});
    const importCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.importTitle')}),
        chip(t('memory.sourceAi'), 'accent')),
      el('div', {className: 'card-body'},
        el('div', {className: 'small tertiary', text: t('memory.importHint')}),
        el('div', {className: 'import-source-row', style: {marginTop: '12px'}}, fileButton, fileInput, fileInfo),
        el('div', {className: 'field', style: {marginTop: '12px'}},
          el('label', {className: 'label', text: t('memory.importPasteLabel')}),
          importArea),
        el('div', {className: 'inline', style: {marginTop: '12px'}},
          validateButton,
          applyButton,
          clearButton,
          el('span', {className: 'small tertiary', text: t('ai.import.pasteHint', {limit: MAX_IMPORT_MB})})),
        importPreviewHost));

    /* ---------------------------------------------------------- jobs/recent */
    const jobsHost = el('div', {className: 'card-body'});
    const jobsCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.jobsTitle')}),
        el('div', {className: 'card-hint', text: 'livememory-memory-update-v1'})),
      jobsHost);

    const recentHost = el('div', {className: 'card-body'});
    const recentCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.recentTitle')}),
        el('div', {className: 'card-hint', text: t('memory.versionsHint')})),
      recentHost);

    /* ----------------------------------------------------------- retention */
    const retentionHost = el('div', {className: 'card-body'});
    const retentionCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('memory.retentionTitle')})),
      retentionHost);

    container.append(sourceCard, mergeCard, jobCard, importCard, jobsCard, recentCard, retentionCard);

    /* ------------------------------------------------------------ loading */

    async function loadOverview() {
      const query = broadcasterId ? `?broadcasterId=${encodeURIComponent(broadcasterId)}` : '';
      overview = await api.get(`/api/memory/overview${query}`);
      const sessions = overview.sessions ?? [];
      if (!sessions.some((session) => session.sessionId === selectedSessionId)) {
        selectedSessionId = sessions[0]?.sessionId ?? null;
      }
      renderSessions();
      renderJobs();
      renderRecent();
      renderRetention();
      resetMerge();
      resetJob();
    }

    function renderSessions() {
      const sessions = overview?.sessions ?? [];
      clear(sessionSelect);
      if (sessions.length === 0) {
        sessionSelect.append(el('option', {value: '', text: t('memory.sourceAnalysisMissing')}));
        sessionSelect.disabled = true;
        sourceMeta.textContent = t('memory.noMemoryBody');
        return;
      }
      sessionSelect.disabled = false;
      for (const session of sessions) {
        sessionSelect.append(el('option', {value: session.sessionId, text: sessionLabel(session, t, locale)}));
      }
      sessionSelect.value = selectedSessionId ?? sessions[0].sessionId;
      const current = sessions.find((session) => session.sessionId === sessionSelect.value) ?? sessions[0];
      renderSourceMeta(current);
    }

    function renderSourceMeta(session) {
      clear(sourceMeta);
      if (!session) return;
      const badges = el('div', {className: 'inline'});
      if (session.analysis) {
        badges.append(chip(t('memory.sourceAnalysisReady'), 'accent'));
        badges.append(el('span', {
          className: 'small tertiary',
          text: t('memory.sourceViewers', {n: formatInteger(session.analysis.viewerProfiles, locale)})
        }));
        if (!session.analysis.complete) {
          badges.append(chip(t('ai.job.status.partial'), 'warn'));
        }
      } else {
        badges.append(chip(t('memory.sourceAnalysisMissing'), 'warn'));
      }
      badges.append(el('span', {
        className: 'small tertiary',
        text: `${formatInteger(session.messageCount, locale)} · ${formatInteger(session.viewerCount, locale)}`
      }));
      sourceMeta.append(badges);
    }

    function resetMerge() {
      mergePreview = null;
      mergeHost.replaceChildren(el('div', {className: 'small tertiary', text: t('memory.mergeHint')}));
    }

    function resetJob() {
      jobDetail = null;
      promptText = '';
      jobHost.replaceChildren();
      jobMeta.textContent = '';
    }

    /* --------------------------------------------------------------- merge */

    function mergeTotals(entry) {
      return el('div', {className: 'inline memory-totals'},
        chip(t('memory.totalsViewers') + ' ' + formatInteger(entry.totals?.viewers ?? 0, locale), 'neutral'),
        chip(t('memory.totalsAdded') + ' ' + formatInteger(entry.totals?.added ?? 0, locale), 'accent'),
        chip(t('memory.totalsConfirmed') + ' ' + formatInteger(entry.totals?.confirmed ?? 0, locale), 'neutral'),
        chip(t('memory.totalsChanged') + ' ' + formatInteger(entry.totals?.changed ?? 0, locale), 'warn'),
        entry.totals?.skipped
          ? chip(t('memory.mergeSkipped', {n: formatInteger(entry.totals.skipped, locale)}), 'neutral')
          : null);
    }

    function viewerChangeRow(viewer) {
      const counts = viewer.counts ?? {};
      const facts = [
        ...(viewer.diff?.added ?? []).map((fact) => ({fact, kind: 'added'})),
        ...(viewer.diff?.changed ?? []).map((fact) => ({fact, kind: 'changed'})),
        ...(viewer.diff?.confirmed ?? []).map((fact) => ({fact, kind: 'confirmed'}))
      ].slice(0, 8);
      return el('div', {className: 'memory-change-row'},
        el('div', {className: 'memory-change-head'},
          el('span', {className: 'row-title-text', text: viewer.nickname || viewer.viewerId}),
          chip(`v${viewer.baseVersion ?? 0} → v${viewer.version ?? '?'}`, 'neutral'),
          chip(t('memory.totalsAdded') + ' ' + formatInteger(counts.added ?? 0, locale), 'accent'),
          chip(t('memory.totalsConfirmed') + ' ' + formatInteger(counts.confirmed ?? 0, locale), 'neutral'),
          counts.changed
            ? chip(t('memory.totalsChanged') + ' ' + formatInteger(counts.changed, locale), 'warn')
            : null),
        facts.length === 0
          ? el('div', {className: 'small tertiary', text: t('memory.nothingHere')})
          : el('div', {className: 'memory-change-facts'},
            facts.map(({fact, kind}) => el('div', {className: 'memory-change-fact'},
              chip(resultLabel(kind === 'changed' ? 'updated' : kind, t), kind === 'added' ? 'accent' : 'neutral'),
              el('span', {className: 'mono tertiary', text: fact.topic ?? fact.kind}),
              el('span', {text: fact.statement})))));
    }

    function renderMergeResults(payload) {
      const host = el('div', {className: 'stack'});
      host.append(mergeTotals(payload));
      if ((payload.viewers ?? []).length === 0) {
        host.append(emptyState({title: t('memory.mergeNothing'), glyph: '·'}));
      } else {
        if (payload.truncated) {
          host.append(el('div', {className: 'small tertiary', text: t('memory.mergeTruncated')}));
        }
        host.append(el('div', {className: 'memory-changes'},
          payload.viewers.map(viewerChangeRow)));
      }
      if (!payload.apply) {
        host.append(el('div', {className: 'inline', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('memory.mergeApply'),
            onClick: () => runMerge(true)
          })));
      }
      mergeHost.replaceChildren(host);
    }

    async function runMerge(apply) {
      if (mergeBusy || !selectedSessionId) return;
      mergeBusy = true;
      mergePreviewButton.disabled = true;
      const label = apply ? t('memory.mergeApplying') : t('memory.mergePreview');
      mergePreviewButton.textContent = label;
      try {
        const payload = await api.post('/api/memory/merge', {
          sessionId: selectedSessionId,
          apply
        });
        if (apply) {
          ctx.toast(t('memory.mergeDone'));
          await loadOverview();
        } else {
          mergePreview = payload;
          renderMergeResults(payload);
        }
      } catch (error) {
        const messageKey = error?.messageKey;
        ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
      } finally {
        mergeBusy = false;
        mergePreviewButton.disabled = false;
        mergePreviewButton.textContent = t('memory.mergePreview');
      }
    }

    mergePreviewButton.addEventListener('click', () => runMerge(false).catch(() => {}));

    /* ----------------------------------------------------------------- job */

    function renderJob() {
      if (!jobDetail) {
        jobHost.replaceChildren();
        return;
      }
      const status = jobDetail.status;
      const missingText = status.missingBatches.length > 0
        ? ` · ${t('memory.missingBatches', {list: status.missingBatches.join(', ')})}`
        : '';
      const metaText = [
        t('memory.jobBatchCount', {n: status.batchTotal}),
        t('memory.jobViewers', {n: jobDetail.job.viewersTotal}),
        t('memory.jobMessages', {n: jobDetail.job.messagesTotal})
      ].join(' · ') + missingText;
      const head = el('div', {className: 'job-head'},
        el('div', {className: 'job-head-text'},
          el('div', {className: 'job-title-row'},
            chip(t(status.labelKey), status.complete ? 'accent' : (status.status === 'invalid' ? 'danger' : 'warn')),
            el('span', {className: 'small tertiary', text: jobDetail.job.id}),
            el('span', {className: 'small tertiary', text: jobDetail.job.promptVersion})),
          el('div', {className: 'small tertiary', text: metaText})));

      const batchRows = jobDetail.batches.map((batch) => el('div', {className: 'package-row'},
        el('div', {className: 'row-main'},
          el('div', {className: 'row-title'},
            el('span', {className: 'row-title-text', text: `#${batch.batchIndex}`}),
            batch.applied ? chip(t('memory.job.applied'), 'accent') : chip(t('memory.job.missing'), 'warn')),
          el('div', {className: 'row-sub'},
            el('span', {text: t('memory.jobViewers', {n: formatInteger(batch.viewerCount, locale)})}),
            el('span', {text: t('memory.jobMessages', {n: formatInteger(batch.messageCount, locale)})}),
            el('span', {className: 'mono tertiary', text: batch.batchId}))),
        el('div', {className: 'job-actions'},
          batch.fileName
            ? el('a', {
              className: 'button button--secondary button--small',
              href: `/api/memory/jobs/${encodeURIComponent(jobDetail.job.id)}/batches/${batch.batchIndex}/download`,
              attrs: {download: batch.fileName},
              text: t('memory.jobDownload', {index: batch.batchIndex})
            })
            : null)));

      const promptBox = el('pre', {className: 'prompt-box', attrs: {tabindex: '0'}}, promptText || t('common.loading'));
      const promptHost = el('div', {className: 'stack'},
        el('div', {className: 'inline'},
          el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: t('memory.jobPrompt'),
            onClick: async () => {
              try {
                const result = await api.get(`/api/memory/jobs/${encodeURIComponent(jobDetail.job.id)}/instructions?batchIndex=1`);
                promptText = result.text;
                promptBox.textContent = promptText;
                await navigator.clipboard?.writeText(promptText);
                ctx.toast(t('memory.jobCopied'));
              } catch {
                ctx.toast(t('common.error'), {tone: 'error'});
              }
            }
          }),
          el('div', {className: 'small tertiary', text: t('memory.jobInstructionsHint')})));

      jobHost.replaceChildren(el('div', {className: 'job-created'},
        head,
        el('div', {className: 'job-packages'}, batchRows),
        el('div', {style: {marginTop: '12px'}},
          el('div', {className: 'small tertiary', style: {marginBottom: '6px'}, text: t('memory.jobInstructionsTitle')}),
          promptHost,
          promptBox)));
    }

    async function createJob() {
      if (jobBusy || !selectedSessionId) return;
      jobBusy = true;
      jobCreateButton.disabled = true;
      jobCreateButton.textContent = t('memory.jobCreating');
      try {
        jobDetail = await api.post('/api/memory/jobs', {
          sessionId: selectedSessionId,
          locale,
          viewersPerBatch: 20
        });
        jobMeta.textContent = t('memory.jobCreated');
        promptText = '';
        renderJob();
        await loadOverview();
      } catch (error) {
        const messageKey = error?.messageKey;
        ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
      } finally {
        jobBusy = false;
        jobCreateButton.disabled = false;
        jobCreateButton.textContent = t('memory.jobCreate');
      }
    }

    jobCreateButton.addEventListener('click', () => createJob().catch(() => {}));

    function renderJobs() {
      const jobs = overview?.jobs ?? [];
      clear(jobsHost);
      if (jobs.length === 0) {
        jobsHost.append(emptyState({title: t('memory.jobsEmpty'), glyph: '·'}));
        return;
      }
      const rows = jobs.map((entry) => {
        const open = () => {
          jobDetail = entry;
          promptText = '';
          renderJob();
        };
        return el('div', {
          className: 'list-row list-row--interactive',
          attrs: {role: 'button', tabindex: '0'},
          onClick: open,
          onKeydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          }
        },
        el('div', {className: 'row-main'},
          el('div', {className: 'row-title'},
            el('span', {className: 'row-title-text', text: entry.session?.roomTitle || entry.job.sessionId}),
            chip(t(entry.status.labelKey), entry.status.complete ? 'accent' : 'warn')),
          el('div', {className: 'row-sub'},
            el('span', {text: formatDateTime(entry.job.createdAt, locale)}),
            el('span', {text: t('memory.jobBatchCount', {n: entry.status.batchTotal})}),
            el('span', {text: t('memory.jobViewers', {n: entry.job.viewersTotal})}))),
        el('div', {className: 'row-metrics'},
          el('div', {className: 'metric'},
            el('div', {className: 'metric-label', text: t('memory.job.applied')}),
            el('div', {
              className: 'metric-value',
              text: `${entry.status.batchesApplied}/${entry.status.batchTotal}`
            }))));
      });
      jobsHost.append(el('div', {className: 'list'}, rows));
    }

    function renderRecent() {
      const recent = overview?.recent ?? [];
      clear(recentHost);
      if (recent.length === 0) {
        recentHost.append(emptyState({title: t('memory.recentEmpty'), glyph: '◇'}));
        return;
      }
      const openProfile = (memory) => {
        ctx.navigate(`/viewers/${encodeURIComponent(memory.viewerId)}?broadcaster=${encodeURIComponent(broadcasterId)}`);
      };
      const rows = recent.map((memory) => el('div', {
        className: 'list-row list-row--interactive',
        attrs: {role: 'link', tabindex: '0'},
        onClick: () => openProfile(memory),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openProfile(memory);
          }
        }
      },
      el('div', {className: 'row-main'},
        el('div', {className: 'row-title'},
          el('span', {className: 'row-title-text', text: memory.nickname || memory.viewerId}),
          chip(t('memory.versionLabel', {n: memory.version}), 'neutral'),
          memory.attentionCount
            ? chip(t('memory.attentionCount', {n: formatInteger(memory.attentionCount, locale)}), 'warn')
            : null),
        el('div', {className: 'row-sub'},
          el('span', {text: formatDateTime(memory.lastUpdateAt, locale)}),
          memory.summary ? el('span', {className: 'tertiary', text: memory.summary}) : null)),
      el('div', {className: 'row-metrics'},
        el('div', {className: 'metric'},
          el('div', {className: 'metric-label', text: t('memory.totalsAdded')}),
          el('div', {className: 'metric-value', text: formatInteger(memory.factCount, locale)}))),
      el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}})));
      recentHost.append(el('div', {className: 'list'}, rows));
    }

    /* -------------------------------------------------------------- import */

    function renderImport() {
      clear(importPreviewHost);
      importPreviewHost.append(el('div', {className: 'small tertiary', text: t('memory.importHint')}));
      applyButton.disabled = true;
    }

    function renderIssueList(title, issues, tone) {
      if (!issues || issues.length === 0) return null;
      return el('div', {className: `import-warnings import-${tone}`},
        el('div', {className: 'callout-title', text: title}),
        el('div', {className: 'import-issue-list'}, issues.slice(0, 40).map((issue) => issueRow(issue, t))));
    }

    function planRow(entry) {
      return el('div', {className: 'memory-change-row'},
        el('div', {className: 'memory-change-head'},
          el('span', {className: 'row-title-text', text: entry.viewerId}),
          chip(`v${entry.baseVersion} → v${entry.nextVersion}`, 'neutral'),
          chip(t('memory.totalsAdded') + ' ' + formatInteger(entry.counts?.added ?? 0, locale), 'accent'),
          chip(t('memory.totalsConfirmed') + ' ' + formatInteger(entry.counts?.confirmed ?? 0, locale), 'neutral'),
          entry.counts?.changed
            ? chip(t('memory.totalsChanged') + ' ' + formatInteger(entry.counts.changed, locale), 'warn')
            : null),
        el('div', {className: 'memory-change-facts'}, entry.operations.map((operation) => el('div', {className: 'memory-change-fact'},
          chip(opLabel(operation.op, t), 'neutral'),
          el('span', {className: 'mono tertiary', text: operation.topic || operation.kind || ''}),
          el('span', {text: operation.statement || ''}),
          chip(resultLabel(operation.result, t), operation.result === 'added' ? 'accent' : 'neutral'),
          operation.evidence
            ? el('span', {className: 'small tertiary', text: `· ${formatInteger(operation.evidence, locale)}`})
            : null))));
    }

    function renderPreview() {
      clear(importPreviewHost);
      if (!preview) return;
      const block = el('div', {className: 'stack'});
      const target = preview.target ?? {};
      if (target.session) {
        block.append(el('div', {className: 'import-target'},
          el('div', {className: 'preview-head'},
            el('span', {className: 'small tertiary', text: t('memory.importScope')}),
            el('span', {text: target.session.roomTitle || target.session.id})),
          el('div', {className: 'small tertiary', text: `${t('memory.sourcePick')} #${target.batch?.index ?? '?'} · ${t('memory.jobViewers', {n: formatInteger(target.viewerCount ?? 0, locale)})}`}))); 
      }

      if (!preview.ok) {
        block.append(renderIssueList(t('memory.importErrorsTitle', {n: preview.errors.length}), preview.errors, 'danger'));
      } else if (preview.action === 'duplicate') {
        block.append(el('div', {className: 'callout callout--neutral'},
          el('div', {},
            el('div', {className: 'callout-title', text: t('memory.importDuplicate')}),
            el('div', {text: t('memory.importDuplicateBody')}))));
        block.append(renderTotalChips(preview.totals));
        block.append(el('div', {className: 'memory-changes'}, (preview.plan ?? []).map(planRow)));
        applyButton.disabled = true;
      } else {
        const requiresVersion = preview.action === 'confirm_version';
        block.append(el('div', {className: 'callout callout--success'},
          el('div', {},
            el('div', {className: 'callout-title', text: t('memory.importOk')}),
            el('div', {className: 'small tertiary', text: t('memory.importEvidence', {
              n: formatInteger(preview.evidence?.total ?? 0, locale),
              missing: formatInteger(preview.evidence?.missing ?? 0, locale)
            })}))));
        block.append(renderTotalChips(preview.totals));
        if (requiresVersion) {
          block.append(el('div', {className: 'callout callout--warn'},
            el('div', {},
              el('div', {className: 'callout-title', text: t('memory.importVersionTitle')}),
              el('div', {text: t('memory.importVersionBody')}))));
        }
        if ((preview.plan ?? []).length === 0) {
          block.append(el('div', {className: 'small tertiary', text: t('memory.importEmpty')}));
        } else {
          block.append(el('div', {className: 'memory-changes'}, preview.plan.map(planRow)));
        }
        block.append(renderIssueList(t('memory.importWarningsTitle', {n: (preview.warnings ?? []).length}), preview.warnings, 'warning'));
        applyButton.disabled = (preview.plan ?? []).length === 0;
        applyButton.textContent = requiresVersion ? t('memory.importApplyVersion') : t('memory.importApply');
      }
      importPreviewHost.append(block);
    }

    function renderTotalChips(totals) {
      if (!totals) return el('div');
      return el('div', {className: 'inline memory-totals'},
        chip(t('memory.totalsViewers') + ' ' + formatInteger(totals.viewers ?? 0, locale), 'neutral'),
        chip(t('memory.totalsAdded') + ' ' + formatInteger(totals.added ?? 0, locale), 'accent'),
        chip(t('memory.totalsConfirmed') + ' ' + formatInteger(totals.confirmed ?? 0, locale), 'neutral'),
        chip(t('memory.totalsChanged') + ' ' + formatInteger(totals.changed ?? 0, locale), 'warn'));
    }

    async function checkAnswer() {
      if (previewBusy) return;
      previewBusy = true;
      validateButton.disabled = true;
      validateButton.textContent = t('memory.importValidating');
      try {
        preview = await api.post('/api/memory/import/preview', {
          json: importText,
          source: fileState ? 'file' : 'paste'
        });
        renderPreview();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        previewBusy = false;
        validateButton.disabled = false;
        validateButton.textContent = t('memory.importValidate');
      }
    }

    async function applyAnswer(createVersion = false) {
      if (importBusy || !preview?.ok) return;
      importBusy = true;
      applyButton.disabled = true;
      applyButton.textContent = t('memory.importApplying');
      try {
        const result = await api.post('/api/memory/import', {
          json: importText,
          source: fileState ? 'file' : 'paste',
          createVersion
        });
        ctx.toast(t('memory.importSuccessTitle'));
        preview = null;
        importText = '';
        importArea.value = '';
        fileState = null;
        fileInfo.textContent = '';
        renderImport();
        jobDetail = result.job ?? jobDetail;
        if (jobDetail) renderJob();
        await loadOverview();
        ctx.toast(t('memory.importSuccessBody', {n: formatInteger(result.versions?.length ?? 0, locale)}));
      } catch (error) {
        const messageKey = error?.messageKey;
        ctx.toast(messageKey && t(messageKey) !== messageKey ? t(messageKey) : ctx.describeError(error), {tone: 'error'});
      } finally {
        importBusy = false;
        applyButton.textContent = t('memory.importApply');
      }
    }

    validateButton.addEventListener('click', () => {
      importText = importArea.value;
      checkAnswer().catch(() => {});
    });
    applyButton.addEventListener('click', () => {
      const requiresVersion = preview?.action === 'confirm_version';
      applyAnswer(requiresVersion).catch(() => {});
    });
    importArea.addEventListener('input', () => {
      importText = importArea.value;
      if (preview) {
        preview = null;
        renderImport();
      }
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMPORT_MB * 1024 * 1024) {
        ctx.toast(t('ai.import.fileTooLarge', {limit: MAX_IMPORT_MB}), {tone: 'error'});
        return;
      }
      try {
        importText = await file.text();
        importArea.value = importText;
        fileState = file;
        fileInfo.textContent = `${file.name} · ${formatInteger(file.size, locale)} B`;
        preview = null;
        renderImport();
      } catch {
        ctx.toast(t('ai.import.readError'), {tone: 'error'});
      }
    });

    /* ----------------------------------------------------------- retention */

    function renderRetention() {
      clear(retentionHost);
      const info = overview?.retention ?? {};
      retentionHost.append(
        el('div', {className: 'small tertiary', text: t('memory.retentionBody')}),
        el('div', {className: 'inline', style: {marginTop: '10px'}},
          chip(t('memory.retentionKeep'), 'accent'),
          chip(t('memory.retentionEvidence'), 'neutral')),
        el('div', {className: 'def-list', style: {marginTop: '12px'}},
          el('div', {className: 'def-row'},
            el('span', {className: 'def-key', text: t('viewers.scope.viewers')}),
            el('span', {className: 'def-value', text: formatInteger(info.activeMemories ?? 0, locale)})),
          el('div', {className: 'def-row'},
            el('span', {className: 'def-key', text: t('memory.totalsAdded')}),
            el('span', {className: 'def-value', text: formatInteger(info.facts ?? 0, locale)})),
          el('div', {className: 'def-row'},
            el('span', {className: 'def-key', text: t('memory.deleted')}),
            el('span', {className: 'def-value', text: formatInteger(info.deletedMemories ?? 0, locale)}))));

      const daysInput = el('input', {
        className: 'input input--compact',
        type: 'number',
        value: '365',
        attrs: {'aria-label': t('memory.pruneDays'), min: '30', max: '3650', step: '30'}
      });
      const pruneResult = el('div', {className: 'small tertiary'});
      retentionHost.append(
        el('div', {className: 'setting-block', style: {marginTop: '16px'}},
          el('div', {className: 'setting-title', text: t('memory.pruneTitle')}),
          el('div', {className: 'setting-desc', text: t('memory.pruneBody')}),
          el('div', {className: 'inline', style: {marginTop: '10px'}},
            field(t('memory.pruneDays'), daysInput),
            el('button', {
              className: 'button button--secondary button--small',
              type: 'button',
              text: t('memory.prunePreview'),
              onClick: async () => {
                try {
                  prunePreview = await api.post('/api/memory/prune', {
                    broadcasterId,
                    olderThanDays: Number(daysInput.value),
                    dryRun: true
                  });
                  pruneResult.textContent = prunePreview.candidates === 0
                    ? t('memory.pruneNone')
                    : t('memory.pruneCandidates', {n: formatInteger(prunePreview.candidates, locale)});
                } catch (error) {
                  ctx.toast(ctx.describeError(error), {tone: 'error'});
                }
              }
            }),
            el('button', {
              className: 'button button--danger button--small',
              type: 'button',
              text: t('memory.pruneApply'),
              onClick: async () => {
                try {
                  const result = await api.post('/api/memory/prune', {
                    broadcasterId,
                    olderThanDays: Number(daysInput.value),
                    dryRun: false
                  });
                  pruneResult.textContent = t('memory.pruneResult', {n: formatInteger(result.removed ?? 0, locale)});
                  await loadOverview();
                } catch (error) {
                  ctx.toast(ctx.describeError(error), {tone: 'error'});
                }
              }
            })),
          pruneResult));
    }

    /* --------------------------------------------------------------- wire */

    sessionSelect.addEventListener('change', () => {
      selectedSessionId = sessionSelect.value;
      const current = (overview?.sessions ?? []).find((session) => session.sessionId === selectedSessionId);
      renderSourceMeta(current);
      resetMerge();
    });

    scopeSelect.addEventListener('change', () => {
      broadcasterId = scopeSelect.value;
      window.history.replaceState(null, '', `#/memory?broadcaster=${encodeURIComponent(broadcasterId)}`);
      loadOverview().catch((error) => ctx.toast(ctx.describeError(error), {tone: 'error'}));
    });

    renderImport();
    await loadOverview();
    return undefined;
  }
};
