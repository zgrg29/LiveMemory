import {api} from './api.js';
import {createModal} from './dialog.js';
import {openActionMenu} from './actions-menu.js';
import {el, formatDateTime, formatInteger} from './ui.js';
import {platformLabel} from './pages/shared.js';

/**
 * Session management used by both the history list and the history detail page.
 *
 * Having one module means "stop recording", "archive" and "permanent delete"
 * cannot drift between the two surfaces: the same confirmation copy, the same
 * API calls and the same post-action navigation happen in both places.
 */

export function sessionDisplayName(session, t) {
  return session?.roomTitle || platformLabel(session?.platform, t) || t('live.tabs.untitled');
}

function broadcasterText(session, t) {
  return session?.broadcasterName || t('common.unknown');
}

function defRow(key, value) {
  return el('div', {className: 'def-row'},
    el('span', {className: 'def-key', text: key}),
    el('span', {className: 'def-value'}, value instanceof Node ? value : document.createTextNode(String(value ?? ''))));
}

function sessionFacts(session, ctx) {
  const t = ctx.t;
  return el('div', {className: 'def-list'},
    defRow(t('history.manage.broadcaster'), broadcasterText(session, t)),
    defRow(t('history.manage.title'), sessionDisplayName(session, t)),
    defRow(t('history.manage.platform'), platformLabel(session.platform, t)),
    defRow(t('history.manage.date'), formatDateTime(session.startedAt, ctx.locale)),
    defRow(t('history.manage.messages'), formatInteger(session.messageCount ?? 0, ctx.locale)),
    defRow(t('history.manage.viewers'), formatInteger(session.uniqueViewerCount ?? 0, ctx.locale)));
}

/** Executable actions for the current state; never shows an invalid action. */
export function sessionMenuItems(ctx, session, {onChanged, onDeleted, isRecording = false} = {}) {
  const t = ctx.t;
  const live = session.status === 'live' || isRecording;
  const items = [];
  if (live) {
    items.push({
      key: 'stop',
      label: t('history.actions.stop'),
      onSelect: () => confirmStopRecording(ctx, session, {onChanged})
    });
    return items;
  }
  if (session.archived) {
    items.push({
      key: 'unarchive',
      label: t('history.actions.unarchive'),
      onSelect: () => toggleArchive(ctx, session, false, {onChanged})
    });
  } else {
    items.push({
      key: 'archive',
      label: t('history.actions.archive'),
      onSelect: () => toggleArchive(ctx, session, true, {onChanged})
    });
  }
  items.push({
    key: 'delete',
    label: t('history.actions.delete'),
    tone: 'danger',
    onSelect: () => confirmDeleteRecording(ctx, session, {onDeleted})
  });
  return items;
}

export function openSessionMenu(anchor, ctx, session, options = {}) {
  return openActionMenu(anchor, sessionMenuItems(ctx, session, options), {
    t: ctx.t,
    label: ctx.t('history.actions.menuFor', {name: sessionDisplayName(session, ctx.t)})
  });
}

/* -------------------------------------------------------------------- stop */

export function confirmStopRecording(ctx, session, {onChanged} = {}) {
  const t = ctx.t;
  const modal = createModal({
    title: t('history.stop.title'),
    subtitle: t('history.stop.subtitle'),
    t
  });
  const errorHost = el('div');
  const cancel = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: t('common.cancel'),
    onClick: () => modal.close()
  });
  const confirm = el('button', {
    className: 'button button--primary',
    type: 'button',
    text: t('history.stop.confirm')
  });
  let busy = false;
  confirm.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = t('history.stop.stopping');
    errorHost.replaceChildren();
    try {
      await api.post(`/api/sessions/${encodeURIComponent(session.id)}/stop`, {});
      modal.close();
      ctx.toast(t('history.stop.done'));
      onChanged?.();
    } catch (error) {
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = t('history.stop.confirm');
    } finally {
      busy = false;
    }
  });
  modal.actions.append(cancel, confirm);
  modal.body.append(el('div', {className: 'modal-form'},
    sessionFacts(session, ctx),
    el('div', {className: 'callout callout--warn'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('history.stop.noteTitle')}),
        el('div', {text: t('history.stop.note')}))),
    errorHost));
  confirm.focus();
  return modal;
}

/* ----------------------------------------------------------------- archive */

export async function toggleArchive(ctx, session, archived, {onChanged} = {}) {
  const t = ctx.t;
  try {
    await api.post(`/api/sessions/${encodeURIComponent(session.id)}/archive`, {archived});
    ctx.toast(archived ? t('history.archive.done') : t('history.unarchive.done'));
    onChanged?.();
  } catch (error) {
    ctx.toast(ctx.describeError(error), {tone: 'error'});
  }
}

/* ------------------------------------------------------------------ delete */

export function confirmDeleteRecording(ctx, session, {onDeleted} = {}) {
  const t = ctx.t;
  const modal = createModal({
    title: t('history.delete.title'),
    subtitle: t('history.delete.subtitle'),
    t,
    tone: 'danger'
  });
  const errorHost = el('div');
  const ack = el('input', {type: 'checkbox'});
  const cancel = el('button', {
    className: 'button button--ghost',
    type: 'button',
    text: t('common.cancel'),
    onClick: () => modal.close()
  });
  const confirm = el('button', {
    className: 'button button--danger',
    type: 'button',
    text: t('history.delete.confirm'),
    attrs: {disabled: true}
  });
  let busy = false;
  const sync = () => {
    confirm.disabled = busy || !ack.checked;
  };
  ack.addEventListener('change', sync);
  sync();

  confirm.addEventListener('click', async () => {
    if (busy || !ack.checked) return;
    busy = true;
    sync();
    cancel.disabled = true;
    ack.disabled = true;
    confirm.textContent = t('history.delete.deleting');
    errorHost.replaceChildren();
    try {
      await api.delete(`/api/sessions/${encodeURIComponent(session.id)}`, {confirm: true});
      modal.close();
      ctx.toast(t('history.delete.done'));
      onDeleted?.();
    } catch (error) {
      errorHost.replaceChildren(el('div', {className: 'callout callout--warn'}, ctx.describeError(error)));
      cancel.disabled = false;
      ack.disabled = false;
      confirm.textContent = t('history.delete.confirm');
    } finally {
      busy = false;
      sync();
    }
  });

  modal.actions.append(cancel, confirm);
  modal.body.append(el('div', {className: 'modal-form'},
    sessionFacts(session, ctx),
    el('div', {className: 'callout callout--danger'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('history.delete.deletesTitle')}),
        el('div', {text: t('history.delete.deletesBody')}))),
    el('div', {className: 'callout callout--neutral'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('history.delete.keepsTitle')}),
        el('div', {text: t('history.delete.keepsBody')}))),
    el('label', {className: 'choice'},
      ack,
      el('div', {className: 'choice-text'},
        el('div', {className: 'choice-title', text: t('history.delete.ackTitle')}),
        el('div', {className: 'choice-desc', text: t('history.delete.ackBody')}))),
    errorHost));
  ack.focus();
  return modal;
}
