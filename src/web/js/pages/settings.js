import {api} from '../api.js';
import {localeDisplayName} from '../i18n.js';
import {el, formatBytes, formatInteger, pageHead} from '../ui.js';

/**
 * Settings: language, appearance, storage mode, data facts and about.
 * Each control writes through the local API, so the choice is persisted in
 * config/settings.json and reused by the launcher on the next start.
 */
export const settingsPage = {
  titleKey: 'settings.pageTitle',

  async render(container, ctx) {
    const t = ctx.t;
    container.append(pageHead({title: t('settings.pageTitle'), subtitle: t('settings.pageSubtitle')}));

    const [storageInfo, location] = await Promise.all([
      api.get('/api/storage'),
      api.get('/api/storage/location')
    ]);
    const grid = el('div', {className: 'settings-grid'});
    container.append(grid);

    /* ------------------------------------------------------------ language */

    const languageOptions = [
      ['system', t('settings.language.system')],
      ['zh-CN', t('settings.language.zh')],
      ['ja', t('settings.language.ja')],
      ['en', t('settings.language.en')]
    ];
    const languageButtons = languageOptions.map(([value, label]) => el('button', {
      type: 'button',
      text: label,
      attrs: {'aria-pressed': String(ctx.state.settings.locale === value), 'data-value': value},
      onClick: async () => {
        if (ctx.state.settings.locale === value) return;
        try {
          await ctx.setLocale(value);
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
      }
    }));
    const languageCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.language.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-block'},
          el('div', {className: 'setting-desc', text: t('settings.language.desc')}),
          el('div', {className: 'segmented', attrs: {role: 'group', 'aria-label': t('settings.language.title')}}, languageButtons),
          el('div', {className: 'effective-note', text: t('settings.language.systemHint', {
            locale: localeDisplayName(ctx.state.systemLocale ?? ctx.locale)
          })}),
          el('div', {className: 'effective-note', text: t('settings.language.effective', {
            locale: localeDisplayName(ctx.state.locale)
          })}),
          el('div', {className: 'effective-note', text: t('settings.language.headerHint')}),
          el('div', {className: 'small tertiary', text: t('settings.language.note')}))));

    /* --------------------------------------------------------------- theme */

    const themeOptions = [
      ['system', t('settings.theme.system'), t('settings.theme.hint')],
      ['light', t('settings.theme.light'), null],
      ['dark', t('settings.theme.dark'), null]
    ];
    const themeButtons = themeOptions.map(([value, label]) => el('button', {
      className: 'theme-option',
      type: 'button',
      attrs: {'aria-pressed': String(ctx.state.settings.theme === value)},
      onClick: async () => {
        if (ctx.state.settings.theme === value) return;
        try {
          await ctx.setTheme(value);
          for (const button of themeButtons) {
            const pressed = button.dataset.theme === value;
            button.setAttribute('aria-pressed', String(pressed));
          }
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
      }
    },
      el('span', {className: `theme-preview theme-preview--${value}`}),
      el('span', {className: 'theme-option-label'},
        label,
        el('span', {className: 'theme-option-check', attrs: {'aria-hidden': 'true'}}))));
    themeButtons.forEach((button, index) => {
      button.dataset.theme = themeOptions[index][0];
    });

    const themeCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.theme.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.theme.desc')}),
        el('div', {className: 'theme-options', style: {marginTop: '12px'}}, themeButtons)));

    /* ------------------------------------------------------------- storage */

    const storageChoices = [
      ['compact', t('settings.storage.compact'), t('settings.storage.compactDesc')],
      ['full', t('settings.storage.full'), t('settings.storage.fullDesc')]
    ];
    const storageCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.storage.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.storage.desc')}),
        el('div', {className: 'choice-list', style: {marginTop: '12px'}},
          storageChoices.map(([value, title, desc]) => {
            const input = el('input', {
              type: 'radio',
              name: 'storage-mode',
              value,
              attrs: {checked: ctx.state.settings.storageMode === value}
            });
            input.addEventListener('change', async () => {
              if (!input.checked) return;
              try {
                const payload = await api.patch('/api/settings', {storageMode: value});
                ctx.state.settings = payload.settings;
                ctx.toast(t('settings.saved'));
              } catch (error) {
                ctx.toast(ctx.describeError(error), {tone: 'error'});
              }
            });
            return el('label', {className: 'choice'},
              input,
              el('div', {className: 'choice-text'},
                el('div', {className: 'choice-title', text: title}),
                el('div', {className: 'choice-desc', text: desc})));
          })),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '14px'}}, t('settings.storage.note'))));

    /* ------------------------------------------------------------- YouTube */

    const youtubeCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('settings.youtube.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.youtube.desc')}),
        el('div', {className: 'def-list', style: {marginTop: '12px'}},
          defRow(t('settings.youtube.requires'), t('settings.youtube.notRequired')),
          defRow(t('settings.youtube.dataPolicy'), t('settings.youtube.retention'))),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '14px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.youtube.privacyTitle')}),
            el('div', {text: t('settings.youtube.privacyBody')})))));

    /* ------------------------------------------------------- data location */

    const sourceLabel = location.source === 'pointer'
      ? t('settings.dataLocation.sourcePointer')
      : location.source === 'override'
        ? t('settings.dataLocation.sourceOverride')
        : t('settings.dataLocation.sourceDefault');
    const dataDirRows = [
      defRow(t('settings.dataLocation.current'), el('span', {className: 'mono', text: location.dataDir})),
      defRow(t('settings.dataLocation.source'), sourceLabel)
    ];
    if (location.pointerFile) {
      dataDirRows.push(defRow(t('settings.dataLocation.pointerFile'), el('span', {className: 'mono', text: location.pointerFile})));
    }
    dataDirRows.push(
      defRow(t('settings.dataLocation.supports'), t('settings.dataLocation.writable')),
      defRow(t('settings.dataLocation.freeSpace'), formatBytes(location.freeBytes, ctx.locale)),
      defRow(t('settings.dataLocation.managedSize'), formatBytes(location.managedBytes, ctx.locale)),
      defRow(t('settings.data.dbSize'), formatBytes(storageInfo.databaseBytes, ctx.locale)),
      defRow(t('settings.data.sessions'), formatInteger(storageInfo.counts.sessions, ctx.locale)),
      defRow(t('settings.data.viewers'), formatInteger(storageInfo.counts.viewers, ctx.locale)),
      defRow(t('settings.data.events'), formatInteger(storageInfo.counts.events, ctx.locale))
    );

    const changeLocationButton = el('button', {
      className: 'button button--secondary',
      type: 'button',
      text: t('settings.dataLocation.change'),
      onClick: () => openLocationDialog(ctx, location)
    });
    const openFolderButton = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('settings.dataLocation.open'),
      onClick: async () => {
        try {
          await api.post('/api/storage/open', {target: 'data'});
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
      }
    });
    const refreshButton = el('button', {
      className: 'button button--ghost',
      type: 'button',
      text: t('settings.dataLocation.refresh'),
      onClick: () => ctx.navigate('/settings')
    });
    if (location.recording) {
      changeLocationButton.disabled = true;
    }

    const dataLocationCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('settings.dataLocation.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.dataLocation.desc')}),
        el('div', {className: 'def-list', style: {marginTop: '12px'}}, dataDirRows),
        location.recording
          ? el('div', {className: 'callout callout--warn', style: {marginTop: '12px'}},
            t('settings.dataLocation.recordingBlocked'))
          : null,
        el('div', {className: 'inline', style: {marginTop: '14px'}},
          changeLocationButton, openFolderButton, refreshButton),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '14px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.dataLocation.backupDir')}),
            el('div', {className: 'mono', text: location.backupDir}),
            el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: t('settings.dataLocation.note')})))));

    /* --------------------------------------------------------------- danger */

    const dangerCard = el('section', {className: 'card card--wide danger-zone'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('settings.danger.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.danger.desc')}),
        el('div', {className: 'danger-block'},
          el('div', {className: 'danger-block-text'},
            el('div', {className: 'choice-title', text: t('settings.danger.clearTitle')}),
            el('div', {className: 'choice-desc', text: t('settings.danger.clearDesc')})),
          el('button', {
            className: 'button button--danger',
            type: 'button',
            text: t('settings.danger.clearAction'),
            attrs: {disabled: location.recording},
            onClick: () => openClearDialog(ctx, location, 'data')
          })),
        el('div', {className: 'danger-block'},
          el('div', {className: 'danger-block-text'},
            el('div', {className: 'choice-title', text: t('settings.danger.factoryTitle')}),
            el('div', {className: 'choice-desc', text: t('settings.danger.factoryDesc')})),
          el('button', {
            className: 'button button--danger',
            type: 'button',
            text: t('settings.danger.factoryAction'),
            attrs: {disabled: location.recording},
            onClick: () => openClearDialog(ctx, location, 'factory')
          })),
        location.recording
          ? el('div', {className: 'callout callout--warn', style: {marginTop: '14px'}}, t('settings.danger.recording'))
          : null));

    /* --------------------------------------------------------------- about */

    const about = ctx.state.bootstrap?.app ?? {};
    const aboutCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.about.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'def-list'},
          defRow(t('settings.about.version'), `v${about.version ?? ctx.state.version}`),
          defRow(t('settings.about.license'), 'MIT'),
          defRow(t('settings.about.repo'), el('a', {
            href: about.homepage ?? 'https://github.com/zgrg29/LiveMemory',
            attrs: {target: '_blank', rel: 'noopener noreferrer'},
            text: 'github.com/zgrg29/LiveMemory'
          })),
          defRow(t('settings.about.runtime'), `http://127.0.0.1:${ctx.state.status?.server?.port ?? '—'}`),
          defRow(t('settings.about.schema'), String(ctx.state.status?.database?.schemaVersion ?? '—')),
          defRow(t('settings.about.language'), localeDisplayName(ctx.state.locale)),
          defRow(t('settings.about.theme'), `${t(`settings.theme.${ctx.state.settings.theme}`)} · ${document.documentElement.getAttribute('data-theme')}`))));

    grid.append(languageCard, themeCard, storageCard, youtubeCard, dataLocationCard, dangerCard, aboutCard);
    return undefined;
  }
};

function defRow(key, value) {
  return el('div', {className: 'def-row'},
    el('span', {className: 'def-key', text: key}),
    el('span', {className: 'def-value'}, value instanceof Node ? value : document.createTextNode(String(value))));
}

/* ------------------------------------------------------------------ modals */

function createModal({title, subtitle = null, t, tone = 'neutral'}) {
  const dialog = el('dialog', {className: `modal${tone === 'danger' ? ' modal--danger' : ''}`});
  const body = el('div', {className: 'modal-body'});
  const actions = el('div', {className: 'modal-actions'});
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try {
      if (dialog.open) dialog.close();
    } catch {
      /* older browser */
    }
    dialog.remove();
  }
  const closeButton = el('button', {
    className: 'modal-close',
    type: 'button',
    text: '✕',
    attrs: {'aria-label': t('common.close')},
    onClick: close
  });
  dialog.append(
    el('div', {className: 'modal-head'},
      el('div', {className: 'modal-head-text'},
        el('h2', {className: 'modal-title', text: title}),
        subtitle ? el('p', {className: 'modal-desc', text: subtitle}) : null),
      closeButton),
    body,
    actions
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
  return {dialog, body, actions, close};
}

function openLocationDialog(ctx, location) {
  const t = ctx.t;
  const modal = createModal({
    title: t('settings.locationDialog.title'),
    subtitle: t('settings.locationDialog.desc'),
    t
  });
  let mode = 'migrate';
  let busy = false;
  const pathInput = el('input', {
    className: 'input',
    type: 'text',
    value: '',
    placeholder: t('settings.locationDialog.targetPlaceholder'),
    attrs: {'aria-label': t('settings.locationDialog.targetLabel'), spellcheck: 'false', autocomplete: 'off'}
  });
  const browseButton = el('button', {
    className: 'button button--secondary',
    type: 'button',
    text: t('settings.locationDialog.browse'),
    onClick: async () => {
      browseButton.disabled = true;
      try {
        const payload = await api.post('/api/storage/location/pick', {});
        if (payload?.path) pathInput.value = payload.path;
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        pathInput.focus();
      } finally {
        browseButton.disabled = false;
      }
    }
  });
  const acceptInput = el('input', {type: 'checkbox'});
  const acceptWrap = el('label', {className: 'choice hidden'},
    acceptInput,
    el('div', {className: 'choice-text'},
      el('div', {className: 'choice-title', text: t('settings.locationDialog.acceptWarnings')})));
  const warningHost = el('div');
  const errorHost = el('div');
  const confirmButton = el('button', {
    className: 'button button--primary',
    type: 'button',
    text: t('settings.locationDialog.confirm')
  });
  const cancelButton = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: t('common.cancel'),
    onClick: () => modal.close()
  });
  modal.actions.append(cancelButton, confirmButton);

  const modeName = 'relocation-mode';
  function modeChoice(value, title, desc) {
    const input = el('input', {type: 'radio', name: modeName, value, attrs: {checked: value === 'migrate'}});
    input.addEventListener('change', () => {
      if (!input.checked) return;
      mode = value;
      confirmButton.textContent = mode === 'new'
        ? t('settings.locationDialog.newConfirm')
        : t('settings.locationDialog.confirm');
    });
    return el('label', {className: 'choice'},
      input,
      el('div', {className: 'choice-text'},
        el('div', {className: 'choice-title', text: title}),
        el('div', {className: 'choice-desc', text: desc})));
  }

  const modeGroup = el('div', {className: 'choice-list'},
    modeChoice('migrate', t('settings.locationDialog.migrateTitle'), t('settings.locationDialog.migrateDesc')),
    modeChoice('new', t('settings.locationDialog.newTitle'), t('settings.locationDialog.newDesc')));

  function warningText(warning) {
    if (warning.code === 'cloud_sync') {
      return t('settings.locationDialog.cloudWarning', {provider: warning.provider ?? ''});
    }
    if (warning.code === 'temp_folder') return t('settings.locationDialog.tempWarning');
    if (warning.code === 'long_path') return t('settings.locationDialog.longPathWarning');
    return warning.code;
  }

  function renderWarnings(warnings) {
    warningHost.replaceChildren();
    if (!warnings || warnings.length === 0) {
      acceptWrap.classList.add('hidden');
      return;
    }
    warningHost.append(el('div', {className: 'callout callout--warn'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('settings.locationDialog.warningTitle')}),
        el('ul', {className: 'compact-list'}, warnings.map((warning) => el('li', {text: warningText(warning)}))))));
    acceptWrap.classList.remove('hidden');
  }

  function renderResult(payload) {
    const relocation = payload.relocation ?? {};
    const before = relocation.counts?.before?.events ?? 0;
    const after = relocation.counts?.after?.events ?? 0;
    modal.body.replaceChildren(
      el('div', {className: 'callout callout--success'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('settings.locationDialog.resultTitle')}),
          el('div', {text: t('settings.locationDialog.resultBody')}))),
      el('div', {className: 'def-list', style: {marginTop: '14px'}},
        defRow(t('settings.locationDialog.oldDir'), el('span', {className: 'mono', text: relocation.previousDir ?? location.dataDir})),
        defRow(t('settings.locationDialog.newDir'), el('span', {className: 'mono', text: relocation.dataDir ?? payload.storage?.dataDir ?? ''})),
        defRow(t('settings.locationDialog.beforeAfterLabel'), t('settings.locationDialog.beforeAfter', {
          before: formatInteger(before, ctx.locale),
          after: formatInteger(after, ctx.locale)
        })),
        relocation.pointerFiles?.[0]
          ? defRow(t('settings.locationDialog.pointer'), el('span', {className: 'mono', text: relocation.pointerFiles[0]}))
          : null)
    );
    modal.actions.replaceChildren(el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('settings.locationDialog.done'),
      onClick: () => {
        modal.close();
        ctx.navigate('/settings');
      }
    }));
  }

  confirmButton.addEventListener('click', async () => {
    if (busy) return;
    const targetDir = pathInput.value.trim();
    errorHost.replaceChildren();
    if (!targetDir) {
      pathInput.focus();
      return;
    }
    busy = true;
    const originalLabel = confirmButton.textContent;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    browseButton.disabled = true;
    pathInput.disabled = true;
    for (const input of modeGroup.querySelectorAll('input')) input.disabled = true;
    confirmButton.textContent = t('settings.locationDialog.validating');
    try {
      const validation = await api.post('/api/storage/location/validate', {targetDir, mode});
      renderWarnings(validation.warnings);
      if ((validation.warnings ?? []).length > 0 && !acceptInput.checked) {
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        browseButton.disabled = false;
        pathInput.disabled = false;
        for (const input of modeGroup.querySelectorAll('input')) input.disabled = false;
        confirmButton.textContent = originalLabel;
        return;
      }
      confirmButton.textContent = t('settings.locationDialog.migrating');
      const payload = await api.post('/api/storage/location', {
        targetDir: validation.targetDir,
        mode,
        acceptWarnings: acceptInput.checked
      });
      renderResult(payload);
    } catch (error) {
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      browseButton.disabled = false;
      pathInput.disabled = false;
      for (const input of modeGroup.querySelectorAll('input')) input.disabled = false;
      confirmButton.textContent = originalLabel;
    } finally {
      busy = false;
    }
  });

  modal.body.append(
    el('div', {className: 'modal-form'},
      el('label', {className: 'field'},
        el('span', {className: 'label', text: t('settings.locationDialog.targetLabel')}),
        el('div', {className: 'path-row'}, pathInput, browseButton)),
      el('div', {className: 'setting-title', text: t('settings.locationDialog.modeLabel')}),
      modeGroup,
      warningHost,
      acceptWrap,
      errorHost)
  );
}

function openClearDialog(ctx, location, mode) {
  const t = ctx.t;
  const factory = mode === 'factory';
  const word = factory ? 'RESET' : 'DELETE';
  const modal = createModal({
    title: factory ? t('settings.danger.confirmFactoryTitle') : t('settings.danger.confirmTitle'),
    subtitle: factory ? t('settings.danger.factoryDesc') : t('settings.danger.clearDesc'),
    t,
    tone: 'danger'
  });
  let busy = false;
  const backupInput = el('input', {type: 'checkbox', attrs: {checked: true}});
  const backupStatus = el('div', {className: 'small tertiary'});
  const backupButton = el('button', {
    className: 'button button--secondary button--small',
    type: 'button',
    text: t('settings.danger.backupRun')
  });
  const skipWarning = el('div', {className: 'callout callout--warn hidden'}, t('settings.danger.skipBackupWarning'));
  backupInput.addEventListener('change', () => {
    skipWarning.classList.toggle('hidden', backupInput.checked);
  });
  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    backupInput.checked = true;
    skipWarning.classList.add('hidden');
    try {
      const payload = await api.post('/api/storage/backup', {});
      backupStatus.textContent = t('settings.danger.backupCreated', {path: payload.backup.file});
    } catch (error) {
      backupStatus.textContent = ctx.describeError(error);
    } finally {
      backupButton.disabled = false;
    }
  });

  const confirmInput = el('input', {
    className: 'input confirm-input',
    type: 'text',
    placeholder: word,
    attrs: {'aria-label': t('settings.danger.confirmWord'), autocomplete: 'off', spellcheck: 'false'}
  });
  const confirmButton = el('button', {
    className: 'button button--danger',
    type: 'button',
    text: t('settings.danger.deleteForever'),
    attrs: {disabled: true}
  });
  const cancelButton = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: t('common.cancel'),
    onClick: () => modal.close()
  });
  const errorHost = el('div');
  const countsBefore = location.counts ?? {};

  function updateConfirm() {
    confirmButton.disabled = busy || location.recording || confirmInput.value !== word;
  }
  confirmInput.addEventListener('input', updateConfirm);
  updateConfirm();
  if (location.recording) {
    confirmButton.disabled = true;
  }
  modal.actions.append(cancelButton, confirmButton);

  function renderResult(payload) {
    const result = payload.clear ?? {};
    const before = result.before ?? {};
    const after = result.after ?? {};
    modal.body.replaceChildren(
      el('div', {className: 'callout callout--success'},
        el('div', {},
          el('div', {className: 'callout-title', text: factory ? t('settings.danger.resultFactoryTitle') : t('settings.danger.resultTitle')}),
          el('div', {text: factory ? t('settings.danger.resultFactoryBody') : t('settings.danger.resultBody')}))),
      el('div', {className: 'def-list', style: {marginTop: '14px'}},
        defRow(t('settings.danger.counts', {
          sessions: formatInteger(before.sessions, ctx.locale),
          events: formatInteger(before.events, ctx.locale),
          viewers: formatInteger(before.viewers, ctx.locale)
        }), ''),
        defRow(t('settings.data.sessions'), `${formatInteger(before.sessions, ctx.locale)} → ${formatInteger(after.sessions, ctx.locale)}`),
        defRow(t('settings.data.events'), `${formatInteger(before.events, ctx.locale)} → ${formatInteger(after.events, ctx.locale)}`),
        defRow(t('settings.data.viewers'), `${formatInteger(before.viewers, ctx.locale)} → ${formatInteger(after.viewers, ctx.locale)}`),
        result.backup?.file
          ? defRow(t('settings.danger.backupFile'), el('span', {className: 'mono', text: result.backup.file}))
          : defRow(t('settings.danger.backupSkipped'), ''),
        defRow(t('settings.danger.filesRemovedLabel'), formatInteger(result.removedFiles ?? 0, ctx.locale))
      )
    );
    modal.actions.replaceChildren(el('button', {
      className: 'button button--primary',
      type: 'button',
      text: t('settings.danger.reload'),
      onClick: () => {
        modal.close();
        window.location.reload();
      }
    }));
  }

  confirmButton.addEventListener('click', async () => {
    if (busy || confirmInput.value !== word) return;
    busy = true;
    updateConfirm();
    cancelButton.disabled = true;
    confirmInput.disabled = true;
    backupInput.disabled = true;
    backupButton.disabled = true;
    confirmButton.textContent = t('settings.danger.busy');
    errorHost.replaceChildren();
    try {
      const payload = await api.post('/api/storage/clear', {
        mode,
        confirmText: confirmInput.value,
        backupFirst: backupInput.checked
      });
      renderResult(payload);
    } catch (error) {
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
      cancelButton.disabled = false;
      confirmInput.disabled = false;
      backupInput.disabled = false;
      backupButton.disabled = false;
      confirmButton.textContent = t('settings.danger.deleteForever');
    } finally {
      busy = false;
      updateConfirm();
    }
  });

  modal.body.append(
    el('div', {className: 'modal-form'},
      location.recording
        ? el('div', {className: 'callout callout--warn'}, t('settings.danger.recording'))
        : null,
      el('div', {className: 'callout callout--neutral'},
        el('div', {},
          el('div', {className: 'callout-title', text: factory ? t('settings.danger.factoryTitle') : t('settings.danger.clearTitle')}),
          el('div', {text: t('settings.danger.counts', {
            sessions: formatInteger(countsBefore.sessions, ctx.locale),
            events: formatInteger(countsBefore.events, ctx.locale),
            viewers: formatInteger(countsBefore.viewers, ctx.locale)
          })}),
          el('div', {className: 'small tertiary', style: {marginTop: '6px'}, text: t('settings.danger.backupDesc', {dir: location.backupDir})}))),
      el('label', {className: 'choice'},
        backupInput,
        el('div', {className: 'choice-text'},
          el('div', {className: 'choice-title', text: t('settings.danger.backupTitle')}),
          el('div', {className: 'choice-desc', text: t('settings.danger.backupDesc', {dir: location.backupDir})}))),
      el('div', {className: 'inline'}, backupButton, backupStatus),
      skipWarning,
      el('div', {className: 'field'},
        el('span', {className: 'label', text: t('settings.danger.confirmBody', {word})}),
        confirmInput),
      errorHost)
  );
}
