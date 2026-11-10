import {api} from '../api.js';
import {
  chip,
  debounce,
  el,
  emptyState,
  formatDateTime,
  formatInteger,
  initials,
  loadingBlock,
  pageHead,
  statCard
} from '../ui.js';
import {
  broadcasterIdentityChip,
  platformLabel,
  statusChip,
  supportPrimaryText,
  supportRows
} from './shared.js';
import {
  fetchMemoryView,
  renderMemorySummaryCard,
  renderMemoryTab,
  renderVersionsTab
} from './viewer-memory.js';
import {
  SCOPE_ALL,
  SCOPE_UNASSIGNED,
  broadcasterName,
  readScope,
  resolveDetailScope,
  resolveScope,
  scopeOptions,
  scopeSuffix
} from './viewer-scope.js';

/**
 * Viewer directory and long-term profile.
 *
 * Identity is platform-global (`platform:uid`), but the interaction context is
 * per broadcaster. The scope selector defaults to the current broadcaster and
 * every number on this page follows it; the global overview is always labelled
 * separately and never mixed into a broadcaster's context.
 */

function replaceScopeUrl(path, scope) {
  window.history.replaceState(null, '', `#${path}${scopeSuffix(scope)}`);
}

function createScopePicker({t, payload, profile = null, includeAll = true, value, onChange}) {
  const options = scopeOptions(payload, t, {profile, includeAll});
  const select = el('select', {
    className: 'select scope-select',
    attrs: {'aria-label': t('viewers.scope.label')}
  });
  const search = el('input', {
    className: 'input scope-search',
    type: 'search',
    placeholder: t('viewers.scope.searchPlaceholder'),
    attrs: {'aria-label': t('viewers.scope.searchPlaceholder'), autocomplete: 'off'}
  });

  function renderOptions(filter = '') {
    const needle = filter.trim().toLowerCase();
    const visible = options.filter((option) => (
      option.value === value || !needle || option.searchText.includes(needle)
    ));
    select.replaceChildren(...visible.map((option) => el('option', {
      value: option.value,
      text: option.label,
      attrs: {selected: option.value === value}
    })));
    select.value = value;
  }
  renderOptions();

  select.addEventListener('change', () => {
    value = select.value;
    renderOptions(search.value);
    onChange(value);
  });
  if (options.length > 8) {
    search.addEventListener('input', debounce(() => renderOptions(search.value), 160));
  } else {
    search.classList.add('hidden');
  }

  return el('div', {className: 'scope-control'},
    el('span', {className: 'scope-label', text: t('viewers.scope.label')}),
    select,
    search);
}

function summaryCard({broadcaster, summary, support, t, locale}) {
  const supportText = supportPrimaryText(support, locale) ?? '—';
  return el('section', {className: 'card scope-summary'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title inline'},
        el('span', {text: broadcasterName(broadcaster)}),
        broadcasterIdentityChip(broadcaster.identity, t)),
      el('div', {className: 'card-hint', text: platformLabel(broadcaster.platform, t)})),
    el('div', {className: 'card-body'},
      el('div', {className: 'stat-grid'},
        statCard({label: t('viewers.scope.viewers'), value: formatInteger(summary.viewerCount, locale)}),
        statCard({label: t('viewers.scope.sessions'), value: formatInteger(summary.sessionCount, locale)}),
        statCard({label: t('viewers.scope.messages'), value: formatInteger(summary.messageCount, locale)}),
        statCard({label: t('viewers.scope.support'), value: supportText})),
      el('div', {className: 'scope-foot'},
        chip(`${t('viewers.scope.newViewers')} ${formatInteger(summary.newViewers, locale)}`, 'accent'),
        chip(`${t('viewers.scope.returningViewers')} ${formatInteger(summary.returningViewers, locale)}`, 'neutral'),
        el('span', {className: 'small tertiary', text: t('viewers.scope.scopedHint')}))));
}

function unassignedCard({unassigned, t, locale}) {
  return el('div', {className: 'callout callout--warn scope-callout'},
    el('div', {},
      el('div', {className: 'callout-title', text: t('viewers.scope.unassignedTitle')}),
      el('div', {text: t('viewers.scope.unassignedBody', {
        sessions: formatInteger(unassigned?.sessionCount ?? 0, locale),
        viewers: formatInteger(unassigned?.viewerCount ?? 0, locale)
      })})));
}

function scopedMetrics(viewer, scoped) {
  return scoped ? (viewer.scoped ?? {}) : viewer;
}

function viewerRow(viewer, {ctx, scoped, scope}) {
  const t = ctx.t;
  const metrics = scopedMetrics(viewer, scoped);
  const support = supportPrimaryText(metrics.support ?? viewer.support, ctx.locale);
  const sessionCount = metrics.sessionCount ?? viewer.sessionCount;
  const messageCount = metrics.messageCount ?? viewer.messageCount;
  const star = el('button', {
    className: 'focus-star',
    type: 'button',
    text: viewer.focused ? '★' : '☆',
    attrs: {
      'aria-pressed': String(viewer.focused),
      'aria-label': viewer.focused ? t('viewers.detail.unfocus') : t('viewers.detail.focus'),
      title: viewer.focused ? t('viewers.detail.unfocus') : t('viewers.detail.focus')
    },
    onClick: async (event) => {
      event.stopPropagation();
      star.disabled = true;
      try {
        const profile = await api.patch(`/api/viewers/${encodeURIComponent(viewer.id)}`, {focused: !viewer.focused});
        viewer.focused = profile.viewer.focused;
        star.textContent = viewer.focused ? '★' : '☆';
        star.setAttribute('aria-pressed', String(viewer.focused));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        star.disabled = false;
      }
    }
  });

  const open = () => ctx.navigate(`/viewers/${encodeURIComponent(viewer.id)}${scopeSuffix(scope)}`);
  const sub = [
    el('span', {text: platformLabel(viewer.platform, t)}),
    el('span', {className: 'mono tertiary', text: viewer.platformUid})
  ];
  if (scoped) {
    sub.push(el('span', {className: 'tertiary', text: t('viewers.scope.scopedBadge')}));
  } else if (Number(viewer.broadcasterCount ?? 0) > 0) {
    sub.push(el('span', {className: 'tertiary', text: t('viewers.scope.otherBroadcasters', {
      n: formatInteger(viewer.broadcasterCount, ctx.locale)
    })}));
  }

  return el('div', {
    className: 'list-row list-row--interactive viewer-row',
    attrs: {role: 'link', tabindex: '0'},
    onClick: open,
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    }
  },
    star,
    el('span', {className: 'avatar', text: initials(viewer.nickname ?? viewer.platformUid), attrs: {'aria-hidden': 'true'}}),
    el('div', {className: 'row-main'},
      el('div', {className: 'row-title'},
        el('span', {className: 'row-title-text', text: viewer.nickname ?? viewer.platformUid}),
        viewer.focused ? chip(t('viewers.detail.focusedChip'), 'warn') : null),
      el('div', {className: 'row-sub'}, sub)),
    el('div', {className: 'row-metrics'},
      el('div', {className: 'metric'},
        el('div', {className: 'metric-label', text: t('viewers.metric.sessions')}),
        el('div', {className: 'metric-value', text: formatInteger(sessionCount, ctx.locale)})),
      el('div', {className: 'metric metric--optional'},
        el('div', {className: 'metric-label', text: t('viewers.metric.messages')}),
        el('div', {className: 'metric-value', text: formatInteger(messageCount, ctx.locale)})),
      el('div', {className: 'metric metric--optional'},
        el('div', {className: 'metric-label', text: t('viewers.metric.support')}),
        el('div', {className: 'metric-value', text: support ?? '—'}))),
    el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}}));
}

export const viewersPage = {
  titleKey: 'viewers.pageTitle',

  async render(container, ctx, params, query) {
    if (params?.id) return renderDetail(container, ctx, params.id, query);
    return renderList(container, ctx, query);
  }
};

async function renderList(container, ctx, query) {
  const t = ctx.t;
  container.append(pageHead({title: t('viewers.pageTitle'), subtitle: t('viewers.pageSubtitle')}));

  const payload = await api.get('/api/broadcasters');
  let scope = resolveScope(payload, readScope(query));
  let searchText = '';
  let sort = 'messages';
  let requestToken = 0;

  const searchInput = el('input', {
    className: 'input',
    type: 'search',
    placeholder: t('viewers.searchPlaceholder'),
    attrs: {'aria-label': t('viewers.searchPlaceholder'), autocomplete: 'off'}
  });
  const sortSelect = el('select', {className: 'select scope-select', attrs: {'aria-label': t('viewers.scope.sort')}},
    [
      ['messages', t('viewers.scope.sortMessages')],
      ['sessions', t('viewers.scope.sortSessions')],
      ['support', t('viewers.scope.sortSupport')],
      ['recent', t('viewers.scope.sortRecent')],
      ['newest', t('viewers.scope.sortNewest')]
    ].map(([value, label]) => el('option', {value, text: label})));
  sortSelect.value = sort;
  const sortWrap = el('div', {className: 'inline scope-sort'}, sortSelect);

  const countLabel = el('span', {className: 'small tertiary'});
  const toolbar = el('div', {className: 'toolbar viewer-toolbar'});
  const summaryHost = el('div', {className: 'scope-summary-host'});
  const listHost = el('div', {className: 'card', style: {overflow: 'hidden'}});
  container.append(toolbar, summaryHost, listHost);

  function renderToolbar() {
    toolbar.replaceChildren(
      searchInput,
      createScopePicker({
        t,
        payload,
        value: scope,
        onChange: (next) => {
          scope = next;
          replaceScopeUrl('/viewers', scope);
          renderToolbar();
          load().catch((error) => ctx.toast(ctx.describeError(error), {tone: 'error'}));
        }
      }),
      sortWrap,
      countLabel
    );
    sortWrap.classList.toggle('hidden', scope === SCOPE_ALL);
  }

  async function load() {
    const token = ++requestToken;
    const queryText = searchText.trim();
    listHost.replaceChildren();
    summaryHost.replaceChildren();
    let response;
    if (scope === SCOPE_UNASSIGNED) {
      response = await api.get(`/api/viewers?scope=unassigned&limit=200&query=${encodeURIComponent(queryText)}`);
      summaryHost.append(unassignedCard({unassigned: response.scope?.unassigned ?? payload.unassigned, t, locale: ctx.locale}));
    } else if (scope !== SCOPE_ALL) {
      response = await api.get(`/api/broadcasters/${encodeURIComponent(scope)}/viewers?limit=200&query=${encodeURIComponent(queryText)}&sort=${encodeURIComponent(sort)}`);
      summaryHost.append(summaryCard({
        broadcaster: response.broadcaster,
        summary: response.summary,
        support: response.support ?? [],
        t,
        locale: ctx.locale
      }));
    } else {
      response = await api.get(`/api/viewers?limit=200&query=${encodeURIComponent(queryText)}`);
    }
    if (token !== requestToken) return;
    const viewers = response.viewers ?? [];
    countLabel.textContent = t('viewers.countLabel', {n: formatInteger(viewers.length, ctx.locale)});
    listHost.replaceChildren();
    if (viewers.length === 0) {
      listHost.append(emptyState({
        title: queryText ? t('viewers.emptySearch') : t('viewers.empty'),
        body: queryText ? null : t('viewers.emptyBody'),
        glyph: '·'
      }));
      return;
    }
    const list = el('div', {className: 'list'});
    for (const viewer of viewers) {
      list.append(viewerRow(viewer, {
        ctx,
        scoped: scope !== SCOPE_ALL,
        scope
      }));
    }
    listHost.append(list);
  }

  searchInput.addEventListener('input', debounce(() => {
    searchText = searchInput.value;
    load().catch((error) => ctx.toast(ctx.describeError(error), {tone: 'error'}));
  }, 260));
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value;
    load().catch((error) => ctx.toast(ctx.describeError(error), {tone: 'error'}));
  });

  renderToolbar();
  await load();
  return undefined;
}

async function renderDetail(container, ctx, viewerId, query) {
  const t = ctx.t;
  const [payload, baseProfile] = await Promise.all([
    api.get('/api/broadcasters'),
    api.get(`/api/viewers/${encodeURIComponent(viewerId)}`)
  ]);
  const related = baseProfile.broadcasters ?? [];
  const scope = resolveDetailScope(baseProfile, readScope(query), {currentId: payload.currentId});
  const profilePromise = scope
    ? api.get(`/api/viewers/${encodeURIComponent(viewerId)}?broadcasterId=${encodeURIComponent(scope)}`)
    : Promise.resolve(baseProfile);
  const profile = await profilePromise;
  const {viewer, nicknames} = profile;
  const scoped = Boolean(scope);
  const scopeData = profile.scope ?? null;
  const scopeName = scoped
    ? broadcasterName(scopeData?.broadcaster)
    : t('viewers.scope.noRelatedTitle');
  const metrics = scoped
    ? {
      sessionCount: scopeData?.sessionCount ?? 0,
      messageCount: scopeData?.messageCount ?? 0,
      paymentEventCount: scopeData?.paymentEventCount ?? 0,
      support: scopeData?.support ?? [],
      sessions: scopeData?.sessions ?? [],
      lastSeenAt: scopeData?.lastSeenAt ?? null
    }
    : {
      sessionCount: viewer.sessionCount,
      messageCount: viewer.messageCount,
      paymentEventCount: viewer.paymentEventCount,
      support: profile.support ?? [],
      sessions: profile.sessions ?? [],
      lastSeenAt: viewer.lastSeenAt
    };

  const back = el('button', {
    className: 'detail-back',
    type: 'button',
    onClick: () => ctx.navigate('/viewers')
  }, el('span', {attrs: {'aria-hidden': 'true'}}), t('viewers.detail.back'));

  const focusButton = el('button', {
    className: viewer.focused ? 'button button--secondary' : 'button button--primary',
    type: 'button',
    text: viewer.focused ? t('viewers.detail.unfocus') : t('viewers.detail.focus'),
    onClick: async () => {
      focusButton.disabled = true;
      try {
        const next = await api.patch(`/api/viewers/${encodeURIComponent(viewer.id)}`, {focused: !viewer.focused});
        viewer.focused = next.viewer.focused;
        focusButton.textContent = viewer.focused ? t('viewers.detail.unfocus') : t('viewers.detail.focus');
        focusButton.className = viewer.focused ? 'button button--secondary' : 'button button--primary';
        headerChips.replaceChildren(focusedChip());
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        focusButton.disabled = false;
      }
    }
  });

  function focusedChip() {
    return viewer.focused ? chip(t('viewers.detail.focusedChip'), 'warn') : chip(t('status.ended'), 'neutral');
  }

  const headerChips = el('div', {className: 'inline'}, focusedChip());
  const hero = el('div', {className: 'viewer-hero'},
    el('span', {className: 'avatar avatar--lg', text: initials(viewer.nickname ?? viewer.platformUid), attrs: {'aria-hidden': 'true'}}),
    el('div', {className: 'viewer-hero-text'},
      el('h1', {className: 'viewer-name', text: viewer.nickname ?? viewer.platformUid}),
      el('div', {className: 'viewer-platform'},
        el('span', {text: platformLabel(viewer.platform, t)}),
        el('span', {className: 'mono', text: viewer.platformUid}),
        el('span', {text: t('viewers.scope.otherBroadcasters', {
          n: formatInteger(viewer.broadcasterCount ?? 0, ctx.locale)
        })}),
        headerChips)),
    el('div', {className: 'page-actions'}, focusButton));

  let scopePicker = null;
  if (related.length > 1) {
    scopePicker = createScopePicker({
      t,
      payload,
      profile: baseProfile,
      includeAll: false,
      value: scope,
      onChange: (next) => {
        ctx.navigate(`/viewers/${encodeURIComponent(viewerId)}${scopeSuffix(next)}`);
      }
    });
  } else if (related.length === 1) {
    // One real association: a dropdown would be a no-op. Show the channel as
    // read-only context instead of rendering a select with one option.
    scopePicker = el('div', {className: 'scope-control'},
      el('span', {className: 'scope-label', text: t('viewers.scope.label')}),
      el('span', {className: 'scope-static', text: broadcasterName(related[0])}));
  }

  const scopeBar = related.length > 0
    ? el('section', {className: 'card scope-bar'},
      el('div', {className: 'card-body'},
        scopePicker,
        el('div', {className: 'small tertiary', text: scoped
          ? t('viewers.detail.scopeHint', {name: scopeName})
          : t('viewers.detail.allScopeHint')})))
    : el('div', {className: 'callout callout--warn scope-callout'},
      el('div', {},
        el('div', {className: 'callout-title', text: t('viewers.scope.noRelatedTitle')}),
        el('div', {text: t('viewers.scope.noRelatedBody')})));

  const statsGrid = el('div', {className: 'stat-grid'},
    statCard({label: t('viewers.metric.sessions'), value: formatInteger(metrics.sessionCount, ctx.locale)}),
    statCard({label: t('viewers.metric.messages'), value: formatInteger(metrics.messageCount, ctx.locale)}),
    statCard({label: t('live.stats.payments'), value: formatInteger(metrics.paymentEventCount, ctx.locale)}),
    statCard({label: t('viewers.metric.lastSeen'), value: formatDateTime(metrics.lastSeenAt ?? viewer.lastSeenAt, ctx.locale)}));

  const contextTitle = scoped
    ? t('viewers.detail.currentContextTitle', {name: scopeName})
    : t('viewers.detail.globalContextTitle');

  const supportCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: scoped
        ? t('viewers.detail.scopedSupportTitle')
        : t('viewers.detail.supportTitle')}),
      el('div', {className: 'card-hint', text: t('common.actualPaid')})),
    el('div', {className: 'card-body'},
      metrics.support.length === 0
        ? emptyState({title: t('viewers.detail.supportEmpty'), glyph: '·'})
        : el('div', {className: 'support-list'}, supportRows(metrics.support, ctx.locale, t))));

  const identityRows = [
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('viewers.detail.platformUid')}),
      el('span', {className: 'def-value mono', text: viewer.platformUid})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('viewers.detail.firstSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(scoped ? scopeData?.firstSeenAt : viewer.firstSeenAt, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('viewers.detail.lastSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(metrics.lastSeenAt ?? viewer.lastSeenAt, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('viewers.scope.label')}),
      el('span', {className: 'def-value', text: scopeName}))
  ];
  const identityCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('viewers.detail.identityTitle')})),
    el('div', {className: 'card-body'}, el('div', {className: 'def-list'}, identityRows)));

  const sessionRows = metrics.sessions.length === 0
    ? emptyState({title: t('viewers.detail.sessionsEmpty'), glyph: '·'})
    : el('div', {className: 'list'}, metrics.sessions.map((session) => el('div', {
      className: 'list-row list-row--interactive',
      attrs: {role: 'link', tabindex: '0'},
      onClick: () => ctx.navigate(`/history/${encodeURIComponent(session.sessionId)}`),
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ctx.navigate(`/history/${encodeURIComponent(session.sessionId)}`);
        }
      }
    },
      el('div', {className: 'row-main'},
        el('div', {className: 'row-title'},
          el('span', {className: 'row-title-text', text: session.roomTitle || platformLabel(session.platform, t)}),
          statusChip(session, t)),
        el('div', {className: 'row-sub'},
          el('span', {text: formatDateTime(session.startedAt, ctx.locale)}),
          session.endedAt ? el('span', {text: formatDateTime(session.endedAt, ctx.locale)}) : null)),
      el('div', {className: 'row-metrics'},
        el('div', {className: 'metric'},
          el('div', {className: 'metric-label', text: t('viewers.metric.messages')}),
          el('div', {className: 'metric-value', text: formatInteger(session.messageCount, ctx.locale)})),
        el('div', {className: 'metric metric--optional'},
          el('div', {className: 'metric-label', text: t('live.stats.payments')}),
          el('div', {className: 'metric-value', text: formatInteger(session.paymentEventCount, ctx.locale)}))),
      el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}}))));

  const sessionsCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: scoped
        ? t('viewers.detail.scopedSessionsTitle')
        : t('viewers.detail.sessionsTitle')}),
      el('div', {className: 'card-hint', text: scopeName})),
    el('div', {className: 'card-body', style: {padding: '0'}}, sessionRows));

  const broadcasterRows = (profile.broadcasters ?? []).length === 0
    ? emptyState({title: t('viewers.detail.broadcastersEmpty'), glyph: '·'})
    : el('div', {className: 'list'}, profile.broadcasters.map((entry) => {
      const active = entry.id === scope;
      return el('div', {
        className: `list-row list-row--interactive scope-row${active ? ' scope-row--active' : ''}`,
        attrs: {role: 'link', tabindex: '0', 'aria-current': active ? 'true' : null},
        onClick: () => ctx.navigate(`/viewers/${encodeURIComponent(viewerId)}${scopeSuffix(entry.id)}`),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            ctx.navigate(`/viewers/${encodeURIComponent(viewerId)}${scopeSuffix(entry.id)}`);
          }
        }
      },
        el('div', {className: 'row-main'},
          el('div', {className: 'row-title'},
            el('span', {className: 'row-title-text', text: broadcasterName(entry)}),
            broadcasterIdentityChip(entry.identity, t),
            active ? chip(t('viewers.scope.selectedBadge'), 'accent') : null),
          el('div', {className: 'row-sub'},
            el('span', {text: platformLabel(entry.platform, t)}),
            el('span', {className: 'mono tertiary', text: entry.platformUid}),
            el('span', {text: t('viewers.scope.sessionCount', {
              n: formatInteger(entry.sessionCount ?? 0, ctx.locale)
            })}))),
        el('div', {className: 'row-metrics'},
          el('div', {className: 'metric'},
            el('div', {className: 'metric-label', text: t('viewers.metric.messages')}),
            el('div', {className: 'metric-value', text: formatInteger(entry.messageCount, ctx.locale)})),
          el('div', {className: 'metric metric--optional'},
            el('div', {className: 'metric-label', text: t('viewers.detail.supportShort')}),
            el('div', {className: 'metric-value', text: supportPrimaryText(entry.support, ctx.locale) ?? '—'}))),
        el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}}));
    }));

  const broadcastersCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('viewers.detail.broadcastersTitle')}),
      el('div', {className: 'card-hint', text: t('viewers.detail.broadcastersHint')})),
    el('div', {className: 'card-body', style: {padding: '0'}}, broadcasterRows));

  const nicknameRows = nicknames.length === 0
    ? emptyState({title: t('common.noData'), glyph: '·'})
    : el('div', {className: 'nickname-list'}, nicknames.map((entry) => el('div', {className: 'nickname-row'},
      el('span', {}, entry.nickname, entry.nickname === viewer.nickname ? chip(t('viewers.detail.nicknameCurrent'), 'accent') : null),
      el('span', {className: 'small tertiary', text: `${formatDateTime(entry.firstSeenAt, ctx.locale)} → ${formatDateTime(entry.lastSeenAt, ctx.locale)}`}))));

  const nicknameCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('viewers.detail.nicknamesTitle')})),
    el('div', {className: 'card-body'}, nicknameRows));

  const globalCard = scoped
    ? el('section', {className: 'card card--wide global-overview'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('viewers.detail.globalOverviewTitle')}),
        el('div', {className: 'card-hint', text: t('viewers.scope.global')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'stat-grid'},
          statCard({label: t('viewers.metric.sessions'), value: formatInteger(viewer.sessionCount, ctx.locale)}),
          statCard({label: t('viewers.metric.messages'), value: formatInteger(viewer.messageCount, ctx.locale)}),
          statCard({label: t('live.stats.payments'), value: formatInteger(viewer.paymentEventCount, ctx.locale)}),
          statCard({label: t('viewers.detail.supportShort'), value: supportPrimaryText(profile.support, ctx.locale) ?? '—'})),
        el('div', {className: 'small tertiary', style: {marginTop: '10px'}, text: t('viewers.detail.globalHint')})))
    : null;

  // Long-term memory is always scoped to one broadcaster. When the page is in
  // the "all broadcasters" scope we fall back to the current broadcaster, and
  // never merge two channels' memories together.
  const memoryBroadcasterId = scope ?? related[0]?.id ?? null;
  let memoryView = null;
  let memoryState = 'idle';

  const tabsHost = el('div', {className: 'tabs', attrs: {role: 'tablist', 'aria-label': t('memory.pageTitle')}});
  const panelHost = el('div', {className: 'tab-panel'});
  const TAB_KEYS = Object.freeze([
    ['overview', 'viewers.detail.tabOverview'],
    ['memory', 'viewers.detail.tabMemory'],
    ['history', 'viewers.detail.tabHistory'],
    ['versions', 'viewers.detail.tabVersions']
  ]);
  let activeTab = 'overview';

  const overviewPanel = el('div', {className: 'stack'},
    el('div', {className: 'scope-context-head'},
      el('div', {className: 'section-title', text: contextTitle}),
      scoped && scopeData?.broadcaster
        ? broadcasterIdentityChip(scopeData.broadcaster.identity, t)
        : null),
    statsGrid,
    el('div', {className: 'grid-2-equal'}, supportCard, identityCard),
    el('div', {className: 'grid-2-equal'}, broadcastersCard, nicknameCard),
    globalCard,
    el('div', {className: 'memory-summary-host'}));

  const historyPanel = el('div', {className: 'stack'},
    sessionsCard,
    el('div', {className: 'small tertiary', text: t('memory.versionsHint')}));

  const versionsPanel = el('div', {className: 'stack'});
  const memoryPanel = el('div', {className: 'stack'});

  const summaryHost = overviewPanel.querySelector('.memory-summary-host');

  function paintTabs() {
    tabsHost.replaceChildren(...TAB_KEYS.map(([key, labelKey]) => el('button', {
      className: 'tab',
      type: 'button',
      text: t(labelKey),
      attrs: {
        role: 'tab',
        'aria-selected': String(activeTab === key),
        tabindex: activeTab === key ? '0' : '-1'
      },
      onClick: () => setTab(key)
    })));
  }

  function paintSummary() {
    if (!summaryHost) return;
    summaryHost.replaceChildren(renderMemorySummaryCard({
      ctx,
      view: memoryView ?? {memory: null, facts: [], groups: {}},
      onOpen: () => setTab('memory')
    }));
  }

  function paintPanel() {
    panelHost.replaceChildren();
    if (activeTab === 'overview') {
      panelHost.append(overviewPanel);
      return;
    }
    if (activeTab === 'history') {
      panelHost.append(historyPanel);
      return;
    }
    if (!memoryBroadcasterId) {
      panelHost.append(el('section', {className: 'card'},
        el('div', {className: 'card-body'},
          emptyState({title: t('memory.noMemory'), body: t('memory.noMemoryBody'), glyph: '◇'}))));
      return;
    }
    if (memoryState === 'loading') panelHost.append(loadingBlock());
    else if (memoryState === 'error') {
      panelHost.append(el('section', {className: 'card'},
        el('div', {className: 'card-body'},
          emptyState({
            title: t('common.error'),
            body: null,
            glyph: '!',
            action: el('button', {
              className: 'button button--secondary',
              type: 'button',
              text: t('common.retry'),
              onClick: () => loadMemory(true)
            })
          }))));
    } else if (activeTab === 'versions') {
      renderVersionsTab({ctx, host: panelHost, view: memoryView, viewerId, broadcasterId: memoryBroadcasterId, reload: () => loadMemory(true)});
    } else {
      renderMemoryTab({ctx, host: panelHost, view: memoryView, viewerId, broadcasterId: memoryBroadcasterId, reload: () => loadMemory(true)});
    }
  }

  async function loadMemory(force = false) {
    if (!memoryBroadcasterId) return;
    if (memoryView && !force) return;
    memoryState = 'loading';
    if (activeTab === 'memory' || activeTab === 'versions') paintPanel();
    try {
      memoryView = await fetchMemoryView(viewerId, memoryBroadcasterId);
      memoryState = 'ready';
    } catch (error) {
      memoryState = 'error';
      ctx.toast(ctx.describeError(error), {tone: 'error'});
    }
    paintSummary();
    if (activeTab === 'memory' || activeTab === 'versions') paintPanel();
  }

  function setTab(key) {
    activeTab = key;
    paintTabs();
    paintPanel();
    if ((key === 'memory' || key === 'versions') && !memoryView) {
      loadMemory().catch(() => {});
    }
  }

  container.append(
    back,
    hero,
    scopeBar,
    tabsHost,
    panelHost
  );
  paintTabs();
  paintSummary();
  paintPanel();
  loadMemory().catch(() => {});

  return undefined;
}
