import {chip, el, formatMoney} from '../ui.js';

/** Helpers shared by pages. */

export function platformLabel(platform, t) {
  const key = `common.platform.${platform}`;
  const value = t(key);
  return value === key ? String(platform) : value;
}

export function paidSupport(support) {
  return (support ?? []).filter((entry) => Number(entry.actualMinor) > 0)
    .sort((a, b) => Number(b.actualMinor) - Number(a.actualMinor));
}

export function displaySupport(support) {
  return (support ?? []).filter((entry) => Number(entry.displayMinor) > 0);
}

export function supportPrimaryText(support, locale) {
  const paid = paidSupport(support);
  if (paid.length === 0) return null;
  return paid.map((entry) => formatMoney(entry.actualMinor, entry.currency, locale)).join(' + ');
}

export function supportSecondaryText(support, locale, t) {
  const display = displaySupport(support);
  if (display.length === 0) return null;
  return `${t('common.displayValue')}: ${display.map((entry) => formatMoney(entry.displayMinor, entry.currency, locale)).join(' + ')}`;
}

export function statusChip(session, t) {
  if (!session) return null;
  if (session.status === 'live') return chip(t('status.live'), 'live', {dot: true});
  if (session.status === 'interrupted') return chip(t('status.interrupted'), 'warn');
  return chip(t('status.ended'), 'neutral');
}

/** How reliably a broadcaster identity is known. Never invents a channel. */
export function broadcasterIdentityChip(identity, t) {
  const key = `viewers.scope.identity.${identity ?? 'unresolved'}`;
  const resolved = t(key);
  const label = resolved === key ? t('viewers.scope.identity.unresolved') : resolved;
  const tone = identity === 'verified'
    ? 'accent'
    : identity === 'room_fallback'
      ? 'warn'
      : identity === 'simulated'
        ? 'neutral'
        : 'warn';
  return chip(label, tone);
}

export function aiChip(aiStatus, t) {
  if (aiStatus === 'imported') return chip(t('history.ai.imported'), 'accent');
  if (aiStatus === 'exported') return chip(t('history.ai.exported'), 'warn');
  return chip(t('history.ai.none'), 'neutral');
}

export function card({title, hint = null, children = [], flush = false, className = ''}) {
  const node = el('section', {className: `card ${className}`.trim()});
  if (title) {
    node.append(el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: title}),
      hint ? el('div', {className: 'card-hint', text: hint}) : null));
  }
  if (children.length > 0) {
    node.append(el('div', {className: flush ? '' : 'card-body'}, children));
  }
  return node;
}

export function detailCard({title, hint = null, children = [], flush = false}) {
  return card({title, hint, children, flush});
}

export function metric(label, value) {
  return el('div', {className: 'metric'},
    el('div', {className: 'metric-label', text: label}),
    el('div', {className: 'metric-value', text: value}));
}

export function supportRows(support, locale, t) {
  const rows = [];
  for (const entry of paidSupport(support)) {
    rows.push(el('div', {className: 'support-row'},
      el('div', {},
        el('div', {className: 'support-value', text: formatMoney(entry.actualMinor, entry.currency, locale)}),
        el('div', {className: 'support-note', text: `${t('common.actualPaid')} · ${entry.currency}`})),
      el('div', {className: 'support-currency', text: `${entry.actualEventCount} ${t('common.events')}`})));
  }
  for (const entry of displaySupport(support)) {
    rows.push(el('div', {className: 'support-row'},
      el('div', {},
        el('div', {className: 'support-value', text: formatMoney(entry.displayMinor, entry.currency, locale)}),
        el('div', {className: 'support-note', text: `${t('common.displayValue')} · ${entry.currency}`})),
      el('div', {className: 'support-currency', text: `${entry.displayEventCount} ${t('common.events')}`})));
  }
  return rows;
}
