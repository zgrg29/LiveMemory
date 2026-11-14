import {api} from '../api.js';
import {createModal} from '../dialog.js';
import {el, formatBytes, formatDateTime, formatInteger} from '../ui.js';

/**
 * Settings card: portable backup, verification and transactional restore.
 *
 * The user never sees SQLite files, WAL sidecars or command lines. A native
 * Windows dialog selects the file; the server validates it and the console only
 * offers "restore" after a successful preview. Credentials are never in a
 * backup, so the dialog states which services must be reconnected.
 */

function defRow(key, value, className = null) {
  return el('div', {className: `def-row${className ? ` ${className}` : ''}`},
    el('span', {className: 'def-key', text: key}),
    el('span', {className: 'def-value'}, value instanceof Node ? value : document.createTextNode(String(value))));
}

function progressBar() {
  const fill = el('div', {className: 'backup-progress-fill'});
  const track = el('div', {className: 'backup-progress', attrs: {role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0'}}, fill);
  return {
    track,
    set(percent) {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      fill.style.width = `${value}%`;
      track.setAttribute('aria-valuenow', String(Math.round(value)));
    }
  };
}

function phaseLabel(t, phase) {
  const key = `settings.backup.phase.${phase}`;
  const text = t(key);
  return text === key ? phase : text;
}

const RECONNECT_KEYS = Object.freeze({
  'bilibili-login': 'reconnectBilibili',
  'ai-provider-key': 'reconnectAi',
  'youtube-login': 'reconnectYoutube'
});

function reconnectItems(services) {
  const keys = (Array.isArray(services) ? services : [])
    .map((service) => RECONNECT_KEYS[service])
    .filter(Boolean);
  return keys.length > 0 ? keys : Object.values(RECONNECT_KEYS);
}

function countSummary(t, ctx, counts) {
  return t('settings.backup.currentCounts', {
    sessions: formatInteger(counts?.sessions ?? 0, ctx.locale),
    viewers: formatInteger(counts?.viewers ?? 0, ctx.locale),
    events: formatInteger(counts?.events ?? 0, ctx.locale)
  });
}

async function pickBackupFile(ctx, mode, {initialDir = null, defaultName = null} = {}) {
  const payload = await api.post(mode === 'save' ? '/api/backup/pick/save' : '/api/backup/pick/open', {
    ...(initialDir ? {initialDir} : {}),
    ...(defaultName ? {defaultName} : {})
  });
  return payload?.path ?? null;
}

function showJobDialog(ctx, initialJob, {kind, onDone = null}) {
  const t = ctx.t;
  const modal = createModal({
    title: t('settings.backup.progressTitle'),
    subtitle: kind === 'restore' ? t('settings.backup.restoring') : t('settings.backup.creating'),
    t
  });
  const phase = el('div', {className: 'setting-title', text: phaseLabel(t, initialJob.phase)});
  const percent = el('div', {className: 'small tertiary', text: `${initialJob.percent ?? 0}%`});
  const bar = progressBar();
  const errorHost = el('div');
  const details = el('div', {className: 'def-list', style: {marginTop: '14px'}});
  let job = initialJob;
  let timer = null;
  let finished = false;

  const cancelButton = kind === 'create'
    ? el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('settings.backup.cancel'),
      onClick: async () => {
        if (job.status !== 'running' || job.cancelling) return;
        cancelButton.disabled = true;
        cancelButton.textContent = t('settings.backup.cancelRequested');
        try {
          const payload = await api.post(`/api/backup/jobs/${encodeURIComponent(job.id)}/cancel`, {});
          job = payload.job;
        } catch (error) {
          cancelButton.disabled = false;
          cancelButton.textContent = t('settings.backup.cancel');
          errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
        }
      }
    })
    : null;
  const closeButton = el('button', {
    className: 'button button--secondary',
    type: 'button',
    text: t('common.close'),
    onClick: () => {
      if (timer) window.clearTimeout(timer);
      modal.close();
    }
  });
  modal.actions.append(...[cancelButton, closeButton].filter(Boolean));

  modal.body.append(
    el('div', {className: 'modal-form'},
      phase,
      bar.track,
      el('div', {className: 'inline', style: {marginTop: '6px'}}, percent),
      errorHost,
      details)
  );
  bar.set(initialJob.percent ?? 0);

  function renderFinished(current) {
    finished = true;
    phase.textContent = current.status === 'completed'
      ? t('settings.backup.phase.done')
      : current.status === 'cancelled'
        ? t('settings.backup.cancelled')
        : t('settings.backup.failedTitle');
    bar.set(current.status === 'completed' ? 100 : current.percent ?? 0);
    percent.textContent = current.status === 'completed' ? '100%' : `${current.percent ?? 0}%`;
    if (cancelButton) cancelButton.remove();
    if (current.status === 'cancelled') {
      errorHost.replaceChildren(el('div', {className: 'callout callout--neutral'}, t('settings.backup.cancelled')));
      return;
    }
    if (current.status === 'failed') {
      const messageKey = current.error?.messageKey ?? 'errors.backupFailed';
      const text = t(messageKey) === messageKey ? t('errors.backupFailed') : t(messageKey);
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('settings.backup.failedTitle')}),
          el('div', {text}),
          current.error?.rolledBack === true
            ? el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: t('settings.backup.rolledBack')})
            : null)));
      return;
    }
    const result = current.result ?? {};
    if (current.kind === 'create') {
      details.replaceChildren(
        el('div', {className: 'callout callout--success'},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.backup.successTitle')}),
            el('div', {text: t('settings.backup.successBody')}))),
        defRow(t('settings.backup.filePath'), el('span', {className: 'mono', text: result.file ?? ''})),
        defRow(t('settings.backup.fileSize'), formatBytes(result.bytes, ctx.locale)),
        defRow(t('settings.backup.created'), formatDateTime(result.createdAtMs, ctx.locale)),
        defRow(t('settings.backup.sessions'), formatInteger(result.counts?.sessions ?? 0, ctx.locale)),
        defRow(t('settings.backup.viewers'), formatInteger(result.counts?.viewers ?? 0, ctx.locale)),
        defRow(t('settings.backup.events'), formatInteger(result.counts?.events ?? 0, ctx.locale))
      );
      const openButton = el('button', {
        className: 'button button--secondary',
        type: 'button',
        text: t('settings.backup.openFolder'),
        onClick: async () => {
          try {
            await api.post('/api/backup/open', {jobId: current.id});
          } catch (error) {
            ctx.toast(ctx.describeError(error), {tone: 'error'});
          }
        }
      });
      modal.actions.replaceChildren(openButton, closeButton);
      ctx.toast(t('toast.backupCreated'));
    } else {
      const counts = result.counts ?? {};
      details.replaceChildren(
        el('div', {className: 'callout callout--success'},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.backup.restoreSuccessTitle')}),
            el('div', {text: t('settings.backup.restoreSuccessBody')}))),
        defRow(t('settings.backup.sessions'), `${formatInteger(counts.before?.sessions ?? 0, ctx.locale)} → ${formatInteger(counts.after?.sessions ?? 0, ctx.locale)}`),
        defRow(t('settings.backup.viewers'), `${formatInteger(counts.before?.viewers ?? 0, ctx.locale)} → ${formatInteger(counts.after?.viewers ?? 0, ctx.locale)}`),
        defRow(t('settings.backup.events'), `${formatInteger(counts.before?.events ?? 0, ctx.locale)} → ${formatInteger(counts.after?.events ?? 0, ctx.locale)}`),
        result.safetySnapshot?.file
          ? defRow(t('settings.backup.safeSnapshot'), el('span', {className: 'mono', text: result.safetySnapshot.file}))
          : null,
        defRow(t('settings.backup.credentialsIncluded'), t('settings.backup.credentialsExcluded')),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.backup.reconnectTitle')}),
            el('div', {text: t('settings.backup.reconnectBody')}),
            el('ul', {className: 'compact-list'},
              reconnectItems(result.requiresReconnect).map((key) => el('li', {text: t(`settings.backup.${key}`)})))))
      );
      const reloadButton = el('button', {
        className: 'button button--primary',
        type: 'button',
        text: t('settings.backup.restoreReload'),
        onClick: () => window.location.reload()
      });
      modal.actions.replaceChildren(reloadButton);
      ctx.toast(t('toast.restoreCompleted'));
    }
    if (onDone) onDone(current);
  }

  async function poll() {
    if (finished || modal.isClosed()) return;
    try {
      const payload = await api.get(`/api/backup/jobs/${encodeURIComponent(job.id)}`);
      job = payload.job;
      if (job.status === 'running') {
        phase.textContent = phaseLabel(t, job.phase);
        bar.set(job.percent);
        percent.textContent = job.cancelling
          ? t('settings.backup.cancelRequested')
          : `${job.percent}%`;
      } else {
        renderFinished(job);
        return;
      }
    } catch (error) {
      if (error?.status === 404) {
        finished = true;
        errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
        return;
      }
    }
    timer = window.setTimeout(poll, 600);
  }
  timer = window.setTimeout(poll, 350);
  return modal;
}

async function startBackup(ctx, {path = null, overwrite = false} = {}) {
  let target = path;
  if (!target) {
    target = await pickBackupFile(ctx, 'save');
    if (!target) return null;
  }
  try {
    const payload = await api.post('/api/backup/create', {path: target, overwrite});
    return payload.job;
  } catch (error) {
    if (error?.code === 'BACKUP_TARGET_EXISTS') {
      return new Promise((resolve) => {
        const modal = createModal({
          title: ctx.t('settings.backup.overwriteTitle'),
          subtitle: ctx.t('settings.backup.overwriteBody'),
          t: ctx.t,
          tone: 'danger'
        });
        modal.body.append(
          el('div', {className: 'callout callout--warn'},
            el('div', {},
              el('div', {className: 'callout-title', text: ctx.t('settings.backup.overwriteTitle')}),
              el('div', {className: 'mono', text: target})))
        );
        modal.actions.append(
          el('button', {
            className: 'button button--ghost',
            type: 'button',
            text: ctx.t('common.cancel'),
            onClick: () => {
              modal.close();
              resolve(null);
            }
          }),
          el('button', {
            className: 'button button--danger',
            type: 'button',
            text: ctx.t('settings.backup.overwriteConfirm'),
            onClick: async () => {
              modal.close();
              try {
                const payload = await api.post('/api/backup/create', {path: target, overwrite: true});
                resolve(payload.job);
              } catch (nextError) {
                ctx.toast(ctx.describeError(nextError), {tone: 'error'});
                resolve(null);
              }
            }
          })
        );
      });
    }
    throw error;
  }
}

function renderSummary(ctx, backup, currentCounts) {
  const t = ctx.t;
  const summary = el('div', {className: 'def-list'},
    defRow(t('settings.backup.created'), formatDateTime(backup.createdAtMs, ctx.locale)),
    defRow(t('settings.backup.appVersion'), `v${backup.appVersion ?? '—'}${backup.buildId ? ` · ${backup.buildId}` : ''}`),
    defRow(t('settings.backup.schema'), `${backup.schemaVersion}${backup.upgradedFrom ? ` → ${backup.currentSchemaVersion}` : ''}`),
    defRow(t('settings.backup.fileSize'), formatBytes(backup.archiveBytes, ctx.locale)),
    defRow(t('settings.backup.sessions'), formatInteger(backup.counts?.sessions ?? 0, ctx.locale)),
    defRow(t('settings.backup.viewers'), formatInteger(backup.counts?.viewers ?? 0, ctx.locale)),
    defRow(t('settings.backup.events'), formatInteger(backup.counts?.events ?? 0, ctx.locale)),
    defRow(t('settings.backup.aiReports'), formatInteger(backup.counts?.ai_results ?? 0, ctx.locale)),
    defRow(t('settings.backup.memoryFacts'), formatInteger(backup.counts?.memory_facts ?? 0, ctx.locale)),
    defRow(t('settings.backup.includesMemory'), backup.hasLongTermMemory ? t('settings.backup.yes') : t('settings.backup.no')),
    defRow(t('settings.backup.includesReports'), backup.hasAiReports ? t('settings.backup.yes') : t('settings.backup.no')),
    defRow(t('settings.backup.credentialsIncluded'), t('settings.backup.credentialsExcluded'))
  );
  const warnings = (backup.warnings ?? []).map((warning) => {
    if (warning.code === 'schema_upgrade') {
      return el('div', {className: 'small tertiary', text: t('settings.backup.schemaUpgrade', {
        from: warning.from,
        to: warning.to
      })});
    }
    if (warning.code === 'settings_missing') {
      return el('div', {className: 'small tertiary', text: t('settings.backup.settingsMissing')});
    }
    return null;
  }).filter(Boolean);
  return el('div', {},
    el('div', {className: 'callout callout--warn'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('settings.backup.replacesTitle')}),
        el('div', {text: t('settings.backup.replacesBody')}),
        el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: countSummary(t, ctx, currentCounts)}))),
    summary,
    warnings.length ? el('div', {className: 'callout callout--neutral', style: {marginTop: '10px'}}, warnings) : null
  );
}

function openRestoreConfirm(ctx, backup, {onConfirm}) {
  const t = ctx.t;
  const modal = createModal({
    title: t('settings.backup.confirmTitle'),
    subtitle: t('settings.backup.confirmBody'),
    t,
    tone: 'danger'
  });
  const input = el('input', {
    className: 'input confirm-input',
    type: 'text',
    placeholder: 'RESTORE',
    attrs: {'aria-label': t('settings.backup.confirmWord'), autocomplete: 'off', spellcheck: 'false'}
  });
  const errorHost = el('div');
  const confirm = el('button', {
    className: 'button button--danger',
    type: 'button',
    text: t('settings.backup.restore'),
    attrs: {disabled: true}
  });
  input.addEventListener('input', () => {
    confirm.disabled = input.value !== 'RESTORE';
  });
  confirm.addEventListener('click', async () => {
    if (input.value !== 'RESTORE') return;
    confirm.disabled = true;
    input.disabled = true;
    modal.close();
    try {
      await onConfirm();
    } catch (error) {
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
    }
  });
  modal.body.append(
    el('div', {className: 'modal-form'},
      el('div', {className: 'callout callout--warn'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('settings.backup.warningTitle')}),
          el('div', {text: t('settings.backup.warningBody')}))),
      el('div', {className: 'small tertiary', text: t('settings.backup.credentialsNotice')}),
      el('div', {className: 'field'},
        el('span', {className: 'label', text: t('settings.backup.confirmWord')}),
        input),
      el('div', {className: 'small tertiary', text: t('settings.backup.confirmHint')}),
      errorHost)
  );
  modal.actions.append(
    el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('common.cancel'),
      onClick: () => modal.close()
    }),
    confirm
  );
  return modal;
}

async function chooseAndInspect(ctx, currentCounts) {
  const target = await pickBackupFile(ctx, 'open');
  if (!target) return;
  const modal = createModal({
    title: ctx.t('settings.backup.fileTitle'),
    subtitle: target,
    t: ctx.t
  });
  const body = el('div', {className: 'modal-form'});
  modal.body.append(body);
  body.append(el('div', {className: 'loading-block'},
    el('div', {className: 'skeleton'}),
    el('div', {className: 'skeleton'}),
    el('div', {className: 'skeleton'})));
  modal.actions.append(el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: ctx.t('common.cancel'),
    onClick: () => modal.close()
  }));
  let backup;
  try {
    const payload = await api.post('/api/backup/inspect', {path: target});
    backup = payload.backup;
  } catch (error) {
    body.replaceChildren(el('div', {className: 'callout callout--warn'},
      el('div', {},
        el('div', {className: 'callout-title', text: ctx.t('settings.backup.failedTitle')}),
        el('div', {text: ctx.describeError(error)}))));
    return;
  }
  const verifyLine = el('div', {className: 'small tertiary', text: ctx.t('settings.backup.verified')});
  const verifyButton = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: ctx.t('settings.backup.verify'),
    onClick: async () => {
      verifyButton.disabled = true;
      verifyLine.textContent = ctx.t('settings.backup.verifying');
      try {
        const payload = await api.post('/api/backup/inspect', {path: target});
        backup = payload.backup;
        verifyLine.textContent = ctx.t('settings.backup.verified');
      } catch (error) {
        verifyLine.textContent = ctx.describeError(error);
      } finally {
        verifyButton.disabled = false;
      }
    }
  });
  const restoreButton = el('button', {
    className: 'button button--danger',
    type: 'button',
    text: ctx.t('settings.backup.restore'),
    onClick: () => {
      openRestoreConfirm(ctx, backup, {
        onConfirm: async () => {
          let payload;
          try {
            payload = await api.post('/api/backup/restore', {path: target, confirmText: 'RESTORE'});
          } catch (error) {
            ctx.toast(ctx.describeError(error), {tone: 'error'});
            return;
          }
          modal.close();
          showJobDialog(ctx, payload.job, {kind: 'restore'});
        }
      });
    }
  });
  body.replaceChildren(
    el('div', {className: 'callout callout--success'},
      el('div', {},
        el('div', {className: 'callout-title', text: ctx.t('settings.backup.verified')}),
        el('div', {className: 'small tertiary', text: target}))),
    renderSummary(ctx, backup, currentCounts),
    el('div', {className: 'inline', style: {marginTop: '10px'}}, verifyButton, verifyLine),
    el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}},
      el('div', {},
        el('div', {className: 'callout-title', text: ctx.t('settings.backup.reconnectTitle')}),
        el('div', {text: ctx.t('settings.backup.reconnectBody')}),
        el('ul', {className: 'compact-list'},
          el('li', {text: ctx.t('settings.backup.reconnectBilibili')}),
          el('li', {text: ctx.t('settings.backup.reconnectYoutube')}),
          el('li', {text: ctx.t('settings.backup.reconnectAi')}))))
  );
  modal.actions.replaceChildren(
    el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: ctx.t('common.cancel'),
      onClick: () => modal.close()
    }),
    restoreButton
  );
}

function openManualInspect(ctx, currentCounts) {
  const t = ctx.t;
  const modal = createModal({title: t('settings.backup.choose'), t});
  const input = el('input', {
    className: 'input',
    type: 'text',
    placeholder: 'C:\\Users\\you\\Documents\\LiveMemory-Backup.livememory',
    attrs: {'aria-label': t('settings.backup.advancedPath'), spellcheck: 'false', autocomplete: 'off'}
  });
  const start = el('button', {
    className: 'button button--secondary',
    type: 'button',
    text: t('settings.backup.verify'),
    onClick: async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        const payload = await api.post('/api/backup/inspect', {path: value});
        modal.close();
        await inspectInModal(ctx, value, currentCounts, payload.backup);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      }
    }
  });
  modal.body.append(el('div', {className: 'modal-form'},
    el('div', {className: 'small tertiary', text: t('settings.backup.advancedHint')}),
    input));
  modal.actions.append(
    el('button', {className: 'button button--ghost', type: 'button', text: t('common.cancel'), onClick: () => modal.close()}),
    start
  );
}

async function inspectInModal(ctx, target, currentCounts, backup) {
  // Reuse the summary dialog by running the same preview path without another
  // file dialog. The helper below is intentionally small and only used by the
  // manual path.
  const modal = createModal({title: ctx.t('settings.backup.fileTitle'), subtitle: target, t: ctx.t});
  const body = el('div', {className: 'modal-form'});
  modal.body.append(body);
  const restoreButton = el('button', {
    className: 'button button--danger',
    type: 'button',
    text: ctx.t('settings.backup.restore'),
    onClick: () => {
      openRestoreConfirm(ctx, backup, {
        onConfirm: async () => {
          const payload = await api.post('/api/backup/restore', {path: target, confirmText: 'RESTORE'});
          modal.close();
          showJobDialog(ctx, payload.job, {kind: 'restore'});
        }
      });
    }
  });
  body.append(renderSummary(ctx, backup, currentCounts));
  modal.actions.append(
    el('button', {className: 'button button--ghost', type: 'button', text: ctx.t('common.cancel'), onClick: () => modal.close()}),
    restoreButton
  );
}

export function renderBackupCard(ctx, {status}) {
  const t = ctx.t;
  const currentCounts = status?.counts ?? {};
  const createButton = el('button', {
    className: 'button button--primary',
    type: 'button',
    text: t('settings.backup.create'),
    attrs: {disabled: Boolean(status?.busy)},
    onClick: async () => {
      createButton.disabled = true;
      const original = createButton.textContent;
      createButton.textContent = t('settings.backup.creating');
      try {
        const job = await startBackup(ctx);
        if (job) showJobDialog(ctx, job, {kind: 'create'});
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        createButton.disabled = false;
        createButton.textContent = original;
      }
    }
  });
  const chooseButton = el('button', {
    className: 'button button--secondary',
    type: 'button',
    text: t('settings.backup.choose'),
    onClick: async () => {
      chooseButton.disabled = true;
      try {
        await chooseAndInspect(ctx, currentCounts);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        chooseButton.disabled = false;
      }
    }
  });
  const openFolderButton = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: t('settings.backup.openFolder'),
    onClick: async () => {
      try {
        await api.post('/api/backup/open', {});
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      }
    }
  });
  const manualDetails = el('details', {className: 'backup-advanced'},
    el('summary', {text: t('settings.backup.advancedPath')}),
    el('button', {
      className: 'button button--ghost button--small',
      type: 'button',
      text: t('settings.backup.advancedPath'),
      onClick: () => openManualInspect(ctx, currentCounts)
    }));

  return el('section', {className: 'card card--wide'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('settings.backup.title')})),
    el('div', {className: 'card-body'},
      el('div', {className: 'setting-desc', text: t('settings.backup.desc')}),
      el('div', {className: 'def-list', style: {marginTop: '12px'}},
        defRow(t('settings.backup.currentTitle'), countSummary(t, ctx, currentCounts)),
        defRow(t('settings.dataLocation.backupDir'), el('span', {className: 'mono', text: status?.backupDir ?? '—'})),
        defRow(t('settings.backup.credentialsIncluded'), t('settings.backup.credentialsExcluded'))),
      el('div', {className: 'callout callout--warn', style: {marginTop: '12px'}},
        el('div', {},
          el('div', {className: 'callout-title', text: t('settings.backup.warningTitle')}),
          el('div', {text: t('settings.backup.warningBody')}))),
      status?.busy
        ? el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}},
          el('div', {}, t('errors.backupBusy')))
        : null,
      el('div', {className: 'inline', style: {marginTop: '14px'}},
        createButton, chooseButton, openFolderButton),
      manualDetails));
}

export const __internal = {phaseLabel, progressBar, renderSummary};
