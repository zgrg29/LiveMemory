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

/**
 * Platform state and local capture state are different facts.
 *
 * The pure mapping is exported so the browser and the Node tests use exactly
 * the same labels. It never turns "socket connected" or "no chat messages"
 * into "live", and it never shows a green Live chip after the platform has
 * reported an end.
 */
const PLATFORM_STATUS_META = Object.freeze({
  live: {label: 'status.platformLive', tone: 'live', dot: true},
  ended: {label: 'status.platformEnded', tone: 'neutral', dot: false},
  not_started: {label: 'status.platformNotStarted', tone: 'neutral', dot: false},
  carousel: {label: 'status.platformCarousel', tone: 'warn', dot: false},
  unknown: {label: 'status.platformUnknown', tone: 'warn', dot: false},
  ending: {label: 'status.platformEnding', tone: 'warn', dot: true}
});

export function platformStatusMeta(status) {
  return PLATFORM_STATUS_META[status] ?? PLATFORM_STATUS_META.unknown;
}

export function platformStatusLabel(status, t) {
  return t(platformStatusMeta(status).label);
}

/**
 * Capture status label. An ended capture with `endReason = user` is a manual
 * stop, not a platform end. While an end signal is being confirmed the capture
 * chip stops being green and says "ending recording".
 */
export function captureStatusMeta(session) {
  if (!session) return null;
  if (session.status === 'live') {
    const platform = session.platformStatus;
    if (platform === 'ending') {
      return {label: 'status.confirmingEnd', tone: 'warn', dot: true};
    }
    if (platform === 'ended' || platform === 'not_started' || platform === 'carousel') {
      return {label: 'status.endingCapture', tone: 'warn', dot: true};
    }
    return {label: 'status.live', tone: 'live', dot: true};
  }
  if (session.status === 'interrupted') {
    return {label: 'status.captureInterrupted', tone: 'warn', dot: false};
  }
  if (session.endReason === 'user') {
    return {label: 'status.manualStopped', tone: 'neutral', dot: false};
  }
  if (session.endReason === 'platform_ended'
    || session.platformStatus === 'ended'
    || session.platformStatus === 'carousel') {
    return {label: 'status.platformEnded', tone: 'neutral', dot: false};
  }
  return {label: 'status.ended', tone: 'neutral', dot: false};
}

export function statusChip(session, t) {
  if (!session) return null;
  const meta = captureStatusMeta(session);
  return chip(t(meta.label), meta.tone, {dot: meta.dot});
}

const END_REASON_KEYS = Object.freeze({
  user: 'history.endReason.user',
  platform_ended: 'history.endReason.platformEnded',
  platform_not_live: 'history.endReason.platformNotLive',
  startup_recovery: 'history.endReason.startupRecovery',
  shutdown: 'history.endReason.shutdown',
  failed: 'history.endReason.failed',
  adapter_end: 'history.endReason.adapterEnd'
});

export function endReasonLabelKey(reason) {
  return END_REASON_KEYS[reason] ?? 'history.endReason.unknown';
}

/**
 * Secondary platform chip. It is omitted when the capture chip already states
 * the same fact, but callers can force it (the session detail always does).
 */
export function platformStatusChip(session, t, {force = false} = {}) {
  if (!session || !session.platformStatus) return null;
  if (!force) {
    // The capture chip already covers a running capture (including the
    // "confirming end" transition). The platform chip adds information only
    // for ended/interrupted rows.
    if (session.status === 'live') return null;
    if (session.platformStatus === 'ended' || session.platformStatus === 'carousel') return null;
  }
  const meta = platformStatusMeta(session.platformStatus);
  return chip(`${t('status.platformPrefix')}: ${t(meta.label)}`, meta.tone, {dot: meta.dot});
}

/** Archive is a management flag, shown next to (never instead of) the status. */
export function archivedChip(session, t) {
  return session?.archived ? chip(t('history.archived'), 'neutral') : null;
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
  if (aiStatus === 'imported' || aiStatus === 'complete') return chip(t('history.ai.imported'), 'accent');
  if (aiStatus === 'partial') return chip(t('history.ai.partial'), 'warn');
  if (aiStatus === 'exported') return chip(t('history.ai.exported'), 'warn');
  if (aiStatus === 'invalid') return chip(t('history.ai.invalid'), 'warn');
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
