import {el} from './ui.js';

/**
 * Shared modal dialog.
 *
 * Uses the native <dialog> element so focus trapping, Esc handling and the
 * backdrop work without a custom implementation. Text is always set through
 * textContent by `el`, never innerHTML.
 */
export function createModal({title, subtitle = null, t, tone = 'neutral'}) {
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
  return {dialog, body, actions, close, isClosed: () => closed};
}
