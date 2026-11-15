/**
 * DOM and formatting helpers.
 *
 * Text always goes through textContent (never innerHTML), so chat messages and
 * nicknames from a platform can never inject markup into the console.
 */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'attrs') {
      for (const [name, attrValue] of Object.entries(value)) {
        if (attrValue === null || attrValue === undefined || attrValue === false) continue;
        node.setAttribute(name, attrValue === true ? '' : String(attrValue));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function icon(text) {
  return el('span', {className: 'empty-icon', text, attrs: {'aria-hidden': 'true'}});
}

/* --------------------------------------------------------------- formatting */

const numberCache = new Map();

function numberFormatter(locale, options) {
  const key = `${locale}:${JSON.stringify(options)}`;
  if (!numberCache.has(key)) numberCache.set(key, new Intl.NumberFormat(locale, options));
  return numberCache.get(key);
}

export function formatInteger(value, locale) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '—';
  return numberFormatter(locale, {maximumFractionDigits: 0}).format(number);
}

export function formatDecimal(value, locale, digits = 1) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '—';
  return numberFormatter(locale, {maximumFractionDigits: digits, minimumFractionDigits: 0}).format(number);
}

const CURRENCY_DIGITS = {
  CNY: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, HKD: 2, TWD: 2, SGD: 2, NZD: 2, CHF: 2,
  JPY: 0, KRW: 0, VND: 0
};

export function currencyDigits(currency) {
  return CURRENCY_DIGITS[String(currency ?? '').toUpperCase()] ?? 2;
}

export function formatMoney(minor, currency, locale) {
  const code = String(currency ?? 'CNY').toUpperCase();
  const digits = currencyDigits(code);
  const amount = Number(minor ?? 0);
  if (!Number.isFinite(amount)) return '—';
  const value = amount / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${code}`;
  }
}

export function formatDateTime(epochMs, locale) {
  if (!epochMs) return '—';
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
}

export function formatDate(epochMs, locale) {
  if (!epochMs) return '—';
  return new Intl.DateTimeFormat(locale, {dateStyle: 'medium'}).format(new Date(epochMs));
}

export function formatTime(epochMs, locale, {seconds = false} = {}) {
  if (!epochMs) return '—';
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? {second: '2-digit'} : {})
  }).format(date);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDuration(ms, t) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('format.durationHM', {h: hours, m: minutes});
  if (minutes > 0) return t('format.durationMS', {m: minutes, s: seconds});
  return t('format.durationS', {s: seconds});
}

export function formatBytes(bytes, locale) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const formatted = numberFormatter(locale, {maximumFractionDigits: size >= 10 || index === 0 ? 0 : 1}).format(size);
  return `${formatted} ${units[index]}`;
}

export function initials(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  const characters = [...text];
  return characters.slice(0, 2).join('').toUpperCase();
}

/* ------------------------------------------------------------------ pieces */

export function chip(text, tone = null, {dot = false} = {}) {
  return el('span', {className: `chip${tone ? ` chip--${tone}` : ''}`},
    dot ? el('span', {className: 'chip-dot', attrs: {'aria-hidden': 'true'}}) : null,
    text);
}

export function statCard({label, value, unit = null, sub = null}) {
  return el('div', {className: 'stat'},
    el('div', {className: 'stat-label', text: label}),
    el('div', {className: 'stat-value'},
      el('span', {text: value}),
      unit ? el('span', {className: 'stat-unit', text: unit}) : null),
    sub ? el('div', {className: 'stat-sub', text: sub}) : null);
}

export function emptyState({title, body, action = null, glyph = '·'}) {
  return el('div', {className: 'empty'},
    icon(glyph),
    el('div', {className: 'empty-title', text: title}),
    body ? el('div', {className: 'empty-body', text: body}) : null,
    action ?? null);
}

export function loadingBlock() {
  return el('div', {className: 'loading-block'},
    el('div', {className: 'skeleton'}),
    el('div', {className: 'skeleton'}),
    el('div', {className: 'skeleton'}));
}

export function pageHead({title, subtitle, actions = null}) {
  return el('div', {className: 'page-head'},
    el('div', {className: 'page-head-text'},
      el('h1', {className: 'page-title', text: title}),
      subtitle ? el('p', {className: 'page-subtitle', text: subtitle}) : null),
    actions ? el('div', {className: 'page-actions'}, actions) : null);
}

/** Toast notifications. The container is created in index.html. */
export function createToaster(region) {
  return function toast(message, {tone = 'success', timeout = 4200} = {}) {
    if (!region) return;
    const node = el('div', {className: 'toast', dataset: {tone}, attrs: {role: 'status'}}, message);
    region.append(node);
    window.setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(4px)';
      node.style.transition = 'opacity 180ms ease, transform 180ms ease';
      window.setTimeout(() => node.remove(), 220);
    }, timeout);
  };
}

/** Map a stable error code to the localized message key. */
export function describeError(error, t) {
  const messageKey = error?.messageKey;
  if (messageKey) {
    const text = t(messageKey);
    if (text && text !== messageKey) return text;
  }
  return t('errors.generic');
}

/** Debounce helper for the viewer search box. */
export function debounce(fn, delay = 250) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}
