import {el} from './ui.js';

/**
 * Lightweight accessible action menu (the "···" button).
 *
 * - rendered in the body with position: fixed, so an overflow-hidden list row
 *   never clips it;
 * - flips above the trigger when there is no space below and stays inside the
 *   viewport on narrow screens;
 * - closes on outside pointerdown, Escape, scroll, resize and Tab;
 * - supports ArrowUp/ArrowDown/Home/End and returns focus to the trigger.
 */

let active = null;

export function closeActionMenu() {
  active?.close({restoreFocus: false});
}

export function openActionMenu(anchor, items, {t, label = null} = {}) {
  closeActionMenu();
  const enabled = (items ?? []).filter(Boolean);
  if (!anchor || enabled.length === 0) return null;

  const menu = el('div', {
    className: 'action-menu',
    attrs: {role: 'menu', 'aria-label': label ?? t('history.actions.menu')}
  });
  menu.style.visibility = 'hidden';
  const buttons = enabled.map((item) => {
    const button = el('button', {
      className: `action-menu-item${item.tone === 'danger' ? ' action-menu-item--danger' : ''}`,
      type: 'button',
      text: item.label,
      attrs: {role: 'menuitem', ...(item.disabled ? {disabled: ''} : {})},
      onClick: (event) => {
        event.stopPropagation();
        event.preventDefault();
        if (item.disabled) return;
        close({restoreFocus: false});
        item.onSelect?.();
      }
    });
    if (item.key) button.dataset.action = item.key;
    return button;
  });
  menu.append(...buttons);
  document.body.append(menu);

  function place() {
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    let left = rect.right - menuRect.width;
    if (left < margin) left = margin;
    if (left + menuRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - menuRect.width - margin);
    }
    let top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - margin) {
      top = rect.top - menuRect.height - 6;
    }
    if (top < margin) top = margin;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = 'visible';
  }
  place();

  let closed = false;
  function close({restoreFocus = true} = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('scroll', onWindowChange, true);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (active?.menu === menu) active = null;
    if (restoreFocus && document.contains(anchor)) anchor.focus({preventScroll: true});
  }

  function onPointerDown(event) {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    close({restoreFocus: false});
  }

  function moveFocus(step) {
    const focusable = buttons.filter((button) => !button.disabled);
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement);
    const next = current < 0 ? 0 : (current + step + focusable.length) % focusable.length;
    focusable[next].focus();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      buttons.find((button) => !button.disabled)?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const focusable = buttons.filter((button) => !button.disabled);
      focusable.at(-1)?.focus();
      return;
    }
    if (event.key === 'Tab') close({restoreFocus: false});
  }

  function onWindowChange() {
    close({restoreFocus: false});
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
  anchor.setAttribute('aria-expanded', 'true');
  buttons.find((button) => !button.disabled)?.focus({preventScroll: true});

  active = {menu, close};
  return {menu, close};
}
