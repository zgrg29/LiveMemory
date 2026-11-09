import {api} from '../api.js';
import {TimelineChart} from '../chart.js';
import {openSessionMenu, sessionDisplayName} from '../session-actions.js';
import {
  archivedChip,
  aiChip,
  broadcasterIdentityChip,
  platformLabel,
  statusChip,
  supportPrimaryText,
  supportRows
} from './shared.js';
import {
  chip,
  clear,
  debounce,
  el,
  emptyState,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatTime,
  loadingBlock,
  pageHead,
  statCard
} from '../ui.js';

/**
 * Two read surfaces over the same local data:
 *
 * - list: server-side search (broadcaster / title / viewer) combined with
 *   platform, status, date and archive filters, paginated by 20 sessions;
 * - detail: the locally computed statistics of one session, with the same
 *   management menu as the list.
 *
 * No chat row is ever loaded for search. Viewer drill-down loads at most 50
 * messages for one identity in one session.
 */

const PAGE_SIZE = 20;
const MAX_VIEWER_LINES = 3;

export const historyPage = {
  titleKey: 'history.pageTitle',

  async render(container, ctx, params, query) {
    if (params?.id) return renderDetail(container, ctx, params.id, query);
    return renderList(container, ctx);
  }
};

/* -------------------------------------------------------------------- list */

async function renderList(container, ctx) {
  const t = ctx.t;
  container.append(pageHead({title: t('history.pageTitle'), subtitle: t('history.pageSubtitle')}));

  const state = {
    query: '',
    scope: 'all',
    platform: 'all',
    status: 'all',
    from: '',
    to: '',
    includeArchived: false,
    limit: PAGE_SIZE,
    offset: 0,
    total: 0,
    hiddenArchived: 0,
    rows: [],
    token: 0,
    busy: false
  };

  /* ---------------------------------------------------------------- toolbar */

  const searchInput = el('input', {
    className: 'input history-search-input',
    type: 'search',
    value: '',
    placeholder: t('history.search.placeholder'),
    attrs: {
      'aria-label': t('history.search.label'),
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '120'
    }
  });
  const scopeSelect = el('select', {
    className: 'select history-scope-select',
    attrs: {'aria-label': t('history.search.scopeLabel')}
  },
    el('option', {value: 'all', text: t('history.search.scope.all')}),
    el('option', {value: 'broadcaster', text: t('history.search.scope.broadcaster')}),
    el('option', {value: 'title', text: t('history.search.scope.title')}),
    el('option', {value: 'viewer', text: t('history.search.scope.viewer')}));
  scopeSelect.value = 'all';

  const platformSelect = el('select', {
    className: 'select select--compact',
    attrs: {'aria-label': t('history.filters.platform')}
  },
    el('option', {value: 'all', text: t('common.all')}),
    el('option', {value: 'bilibili', text: t('common.platform.bilibili')}),
    el('option', {value: 'youtube', text: t('common.platform.youtube')}));
  const statusSelect = el('select', {
    className: 'select select--compact',
    attrs: {'aria-label': t('history.filters.status')}
  },
    el('option', {value: 'all', text: t('common.all')}),
    el('option', {value: 'live', text: t('status.live')}),
    el('option', {value: 'ended', text: t('history.filters.ended')}),
    el('option', {value: 'interrupted', text: t('status.interrupted')}));
  const fromInput = el('input', {
    className: 'input input--compact',
    type: 'date',
    attrs: {'aria-label': t('history.filters.from')}
  });
  const toInput = el('input', {
    className: 'input input--compact',
    type: 'date',
    attrs: {'aria-label': t('history.filters.to')}
  });
  const archivedInput = el('input', {type: 'checkbox'});
  const resetButton = el('button', {
    className: 'button button--ghost button--small',
    type: 'button',
    text: t('history.filters.reset')
  });

  function field(label, control) {
    return el('label', {className: 'filter-field'},
      el('span', {className: 'filter-label', text: label}),
      control);
  }

  const searchRow = el('div', {className: 'history-search-row'},
    el('span', {className: 'history-search-icon', attrs: {'aria-hidden': 'true'}}, '⌕'),
    searchInput,
    scopeSelect);

  const filtersRow = el('div', {className: 'history-filters'},
    field(t('history.filters.platform'), platformSelect),
    field(t('history.filters.status'), statusSelect),
    field(t('history.filters.from'), fromInput),
    field(t('history.filters.to'), toInput),
    el('label', {className: 'filter-check'},
      archivedInput,
      el('span', {text: t('history.filters.includeArchived')})),
    resetButton);

  const toolbar = el('section', {className: 'card history-toolbar'}, searchRow, filtersRow);
  const summaryHost = el('div', {className: 'history-summary-host', attrs: {'aria-live': 'polite'}});
  const resultsHost = el('div', {className: 'history-results'});
  const moreHost = el('div', {className: 'history-more'});
  container.append(toolbar, summaryHost, resultsHost, moreHost);

  let listNode = null;

  function resetResults() {
    clear(resultsHost);
    listNode = null;
    moreHost.replaceChildren();
  }

  function renderSkeleton() {
    resetResults();
    resultsHost.append(el('div', {className: 'card card--padded'}, loadingBlock()));
  }

  function ensureList() {
    if (listNode) return listNode;
    listNode = el('div', {className: 'history-list'});
    listNode.append(el('div', {className: 'history-head'},
      el('span', {text: t('history.columns.session')}),
      el('span', {text: t('history.columns.duration')}),
      el('span', {text: t('history.columns.messages')}),
      el('span', {text: t('history.columns.viewers')}),
      el('span', {text: t('history.columns.support')}),
      el('span', {className: 'sr-only', text: t('history.columns.actions')})));
    resultsHost.append(listNode);
    return listNode;
  }

  function appendRows(rows) {
    const list = ensureList();
    for (const row of rows) list.append(buildRow(ctx, row, {onChanged: refresh}));
  }

  function refresh() {
    return runSearch({reset: true});
  }

  function renderSummary(payload) {
    clear(summaryHost);
    if (payload.total > 0) {
      summaryHost.append(el('div', {className: 'history-summary', text: t('history.search.summary', {
        total: formatInteger(payload.total, ctx.locale),
        shown: formatInteger(state.rows.length, ctx.locale)
      })}));
    }
    if (payload.hiddenArchivedCount > 0 && !state.includeArchived) {
      summaryHost.append(el('div', {className: 'history-note'},
        el('span', {text: t('history.search.hiddenArchived', {n: formatInteger(payload.hiddenArchivedCount, ctx.locale)})}),
        el('button', {
          className: 'link-button',
          type: 'button',
          text: t('history.search.viewArchived'),
          onClick: () => {
            state.includeArchived = true;
            archivedInput.checked = true;
            runSearch({reset: true});
          }
        })));
    }
    if (payload.anonymousIdentityNotice) {
      summaryHost.append(el('div', {
        className: 'history-note',
        text: t('history.search.identityHint')
      }));
    }
    summaryHost.hidden = summaryHost.childElementCount === 0;
  }

  function renderEmpty(payload) {
    if (payload.total > 0) return;
    moreHost.replaceChildren();
    clear(resultsHost);
    listNode = null;
    const pristine = !state.query.trim()
      && state.scope === 'all'
      && state.platform === 'all'
      && state.status === 'all'
      && !state.from
      && !state.to
      && !state.includeArchived;
    if (pristine) {
      resultsHost.append(el('div', {className: 'card card--padded'},
        emptyState({
          title: t('history.empty'),
          body: t('history.emptyBody'),
          glyph: '◷',
          action: el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('nav.live'),
            onClick: () => ctx.navigate('/live')
          })
        })));
      return;
    }
    resultsHost.append(el('div', {className: 'card card--padded'},
      emptyState({
        title: t('history.search.noResults'),
        body: t('history.search.noResultsBody'),
        glyph: '⌕',
        action: el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('history.filters.reset'),
          onClick: () => {
            resetFilters();
            runSearch({reset: true});
          }
        })
      })));
  }

  function renderLoadMore(payload) {
    clear(moreHost);
    if (!payload.hasMore) return;
    moreHost.append(el('button', {
      className: 'button button--secondary',
      type: 'button',
      text: t('history.search.loadMore'),
      onClick: () => {
        state.offset = state.rows.length;
        runSearch({reset: false});
      }
    }));
  }

  function currentSearchParams() {
    const params = new URLSearchParams();
    params.set('limit', String(state.limit));
    params.set('offset', String(state.offset));
    params.set('scope', state.scope);
    const query = state.query.trim();
    if (query) params.set('q', query);
    if (state.platform !== 'all') params.set('platform', state.platform);
    if (state.status !== 'all') params.set('status', state.status);
    const from = dayStartMs(state.from);
    const to = dayEndMs(state.to);
    if (from !== null) params.set('from', String(from));
    if (to !== null) params.set('to', String(to));
    if (state.includeArchived) params.set('includeArchived', '1');
    return params;
  }

  async function runSearch({reset = false} = {}) {
    if (reset) {
      state.offset = 0;
      renderSkeleton();
    }
    const token = ++state.token;
    state.busy = true;
    try {
      const payload = await api.get(`/api/history/search?${currentSearchParams().toString()}`);
      if (token !== state.token) return;
      const rows = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (reset) {
        state.rows = rows;
      } else {
        state.rows = state.rows.concat(rows);
      }
      state.total = Number(payload.total ?? 0);
      state.hiddenArchived = Number(payload.hiddenArchivedCount ?? 0);
      if (reset && rows.length === 0) {
        renderEmpty(payload);
        renderSummary(payload);
        return;
      }
      resetResults();
      appendRows(state.rows);
      renderSummary(payload);
      renderLoadMore(payload);
    } catch (error) {
      if (token !== state.token) return;
      clear(resultsHost);
      listNode = null;
      moreHost.replaceChildren();
      summaryHost.hidden = true;
      resultsHost.append(el('div', {className: 'card card--padded'},
        emptyState({
          title: t('common.error'),
          body: ctx.describeError(error),
          glyph: '!',
          action: el('button', {
            className: 'button button--secondary',
            type: 'button',
            text: t('common.retry'),
            onClick: () => runSearch({reset: true})
          })
        })));
    } finally {
      if (token === state.token) state.busy = false;
    }
  }

  function resetFilters() {
    state.query = '';
    state.scope = 'all';
    state.platform = 'all';
    state.status = 'all';
    state.from = '';
    state.to = '';
    state.includeArchived = false;
    searchInput.value = '';
    scopeSelect.value = 'all';
    platformSelect.value = 'all';
    statusSelect.value = 'all';
    fromInput.value = '';
    toInput.value = '';
    archivedInput.checked = false;
  }

  const debouncedSearch = debounce(() => {
    state.query = searchInput.value;
    runSearch({reset: true});
  }, 280);

  searchInput.addEventListener('input', () => debouncedSearch());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.query = searchInput.value;
      runSearch({reset: true});
    }
  });
  scopeSelect.addEventListener('change', () => {
    state.scope = scopeSelect.value;
    runSearch({reset: true});
  });
  platformSelect.addEventListener('change', () => {
    state.platform = platformSelect.value;
    runSearch({reset: true});
  });
  statusSelect.addEventListener('change', () => {
    state.status = statusSelect.value;
    runSearch({reset: true});
  });
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      state.from = fromInput.value;
      state.to = toInput.value;
      runSearch({reset: true});
    });
  }
  archivedInput.addEventListener('change', () => {
    state.includeArchived = archivedInput.checked;
    runSearch({reset: true});
  });
  resetButton.addEventListener('click', () => {
    resetFilters();
    runSearch({reset: true});
  });

  await runSearch({reset: true});
  return undefined;
}

function buildRow(ctx, row, {onChanged}) {
  const t = ctx.t;
  const duration = row.endedAt ? row.endedAt - row.startedAt : Date.now() - row.startedAt;
  const support = supportPrimaryText(row.support, ctx.locale);
  const openDetail = (viewerId = null) => {
    const suffix = viewerId ? `?viewer=${encodeURIComponent(viewerId)}` : '';
    ctx.navigate(`/history/${encodeURIComponent(row.id)}${suffix}`);
  };
  const actionButton = el('button', {
    className: 'history-actions',
    type: 'button',
    text: '···',
    attrs: {
      'aria-label': t('history.actions.menuFor', {name: sessionDisplayName(row, t)}),
      'aria-haspopup': 'menu',
      'aria-expanded': 'false'
    },
    onClick: (event) => {
      event.stopPropagation();
      openSessionMenu(event.currentTarget, ctx, row, {
        isRecording: row.status === 'live',
        onChanged,
        onDeleted: onChanged
      });
    },
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.stopPropagation();
      }
    }
  });

  const reasonChips = [];
  if (row.match?.title) reasonChips.push(chip(t('history.search.reason.title'), 'accent'));
  if (row.match?.broadcaster) reasonChips.push(chip(t('history.search.reason.broadcaster'), 'neutral'));
  if (row.match?.viewer) reasonChips.push(chip(t('history.search.reason.viewer'), 'neutral'));

  const viewerLines = (row.matchedViewers ?? []).slice(0, MAX_VIEWER_LINES).map((viewer) => el('button', {
    className: 'history-viewer-match',
    type: 'button',
    onClick: (event) => {
      event.stopPropagation();
      openDetail(viewer.viewerId);
    }
  },
    el('span', {className: 'history-viewer-name', text: viewer.nickname || viewer.viewerId}),
    el('span', {className: 'history-viewer-meta', text: `${platformLabel(viewer.platform, t)} · ${viewer.platformUid}`}),
    el('span', {className: 'history-viewer-count', text: t('history.search.viewerMessages', {
      n: formatInteger(viewer.messageCount, ctx.locale)
    })})));
  if ((row.matchedViewers ?? []).length > MAX_VIEWER_LINES) {
    viewerLines.push(el('span', {
      className: 'history-viewer-more',
      text: t('history.search.moreViewers', {n: row.matchedViewers.length - MAX_VIEWER_LINES})
    }));
  }

  const node = el('div', {
    className: 'history-row',
    dataset: {sessionId: row.id},
    attrs: {role: 'link', tabindex: '0'},
    onClick: (event) => {
      if (event.target.closest('button, a')) return;
      openDetail();
    },
    onKeydown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail();
      }
    }
  },
    el('div', {className: 'history-title-cell'},
      el('div', {className: 'history-title', text: row.roomTitle || platformLabel(row.platform, t)}),
      el('div', {className: 'history-sub'},
        statusChip(row, t),
        archivedChip(row, t),
        row.simulated ? chip(t('status.simulated'), 'neutral') : null,
        row.broadcasterName
          ? el('span', {className: 'history-broadcaster', text: row.broadcasterName})
          : (row.simulated && row.broadcasterIdentity === 'simulated'
            ? null
            : broadcasterIdentityChip(row.broadcasterIdentity, t)),
        el('span', {text: formatDateTime(row.startedAt, ctx.locale)}),
        aiChip(row.aiStatus, t)),
      reasonChips.length > 0 ? el('div', {className: 'history-reasons'}, reasonChips) : null,
      viewerLines.length > 0 ? el('div', {className: 'history-matched-viewers'}, viewerLines) : null),
    el('div', {className: 'history-cell', text: formatDuration(duration, t)}),
    el('div', {className: 'history-cell', text: formatInteger(row.messageCount, ctx.locale)}),
    el('div', {className: 'history-cell', text: formatInteger(row.uniqueViewerCount, ctx.locale)}),
    el('div', {className: 'history-cell', text: support ?? '—'}),
    el('div', {className: 'history-action-cell'}, actionButton));
  return node;
}

/* ------------------------------------------------------------------ detail */

async function renderDetail(container, ctx, sessionId, query) {
  const t = ctx.t;
  let payload;
  try {
    payload = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    if (error?.status === 404) {
      container.append(
        pageHead({title: t('history.pageTitle')}),
        el('div', {className: 'card card--padded'},
          emptyState({
            title: t('errors.sessionNotFound'),
            body: t('history.detail.deletedBody'),
            glyph: '!',
            action: el('button', {
              className: 'button button--primary',
              type: 'button',
              text: t('history.detail.back'),
              onClick: () => ctx.navigate('/history')
            })
          })));
      return undefined;
    }
    throw error;
  }

  const {session, stats, support, top, storage} = payload;
  const viewerId = query?.get('viewer') ?? null;
  let chart = null;
  // The AI report is a separate, optional read model. A missing report must not
  // break the deterministic session detail page.
  let analysisReport = null;
  try {
    analysisReport = await api.get(`/api/ai/sessions/${encodeURIComponent(session.id)}/report`);
  } catch {
    analysisReport = null;
  }

  const back = el('button', {
    className: 'detail-back',
    type: 'button',
    onClick: () => ctx.navigate('/history')
  }, el('span', {attrs: {'aria-hidden': 'true'}}), t('history.detail.back'));

  const viewPath = `/history/${encodeURIComponent(session.id)}${viewerId ? `?viewer=${encodeURIComponent(viewerId)}` : ''}`;
  const refresh = () => ctx.navigate(viewPath);
  const menuButton = el('button', {
    className: 'button button--secondary history-actions-trigger',
    type: 'button',
    text: '···',
    attrs: {
      'aria-label': t('history.actions.menuFor', {name: sessionDisplayName(session, t)}),
      'aria-haspopup': 'menu',
      'aria-expanded': 'false'
    },
    onClick: () => openSessionMenu(menuButton, ctx, session, {
      isRecording: session.status === 'live',
      onChanged: refresh,
      onDeleted: () => ctx.navigate('/history')
    })
  });

  const head = el('div', {className: 'detail-head'},
    el('div', {className: 'hero-text'},
      el('h1', {className: 'detail-title', text: session.roomTitle || platformLabel(session.platform, t)}),
      el('div', {className: 'detail-meta'},
        statusChip(session, t),
        archivedChip(session, t),
        session.simulated ? chip(t('status.simulated'), 'neutral') : null,
        chip(platformLabel(session.platform, t), 'neutral'),
        session.broadcasterName ? chip(session.broadcasterName, 'accent') : null,
        session.simulated && session.broadcasterIdentity === 'simulated'
          ? null
          : broadcasterIdentityChip(session.broadcasterIdentity, t),
        el('span', {text: session.endedAt
          ? `${formatDateTime(session.startedAt, ctx.locale)} → ${formatTime(session.endedAt, ctx.locale)}`
          : formatDateTime(session.startedAt, ctx.locale)}),
        el('span', {text: formatDuration(session.durationMs, t)}))),
    el('div', {className: 'page-actions'},
      el('button', {
        className: 'button button--secondary',
        type: 'button',
        text: t('history.detail.aiCta'),
        onClick: () => ctx.navigate(`/ai?session=${encodeURIComponent(session.id)}`)
      }),
      menuButton));

  const statsGrid = el('div', {className: 'stat-grid'},
    statCard({label: t('live.stats.messages'), value: formatInteger(stats.messages, ctx.locale), sub: t('live.stats.messagesSub')}),
    statCard({label: t('live.stats.viewers'), value: formatInteger(stats.activeViewers, ctx.locale), sub: t('live.stats.viewersSub')}),
    statCard({
      label: t('live.stats.support'),
      value: supportPrimaryText(support, ctx.locale) ?? t('live.stats.noSupport'),
      sub: t('live.stats.supportSub')
    }),
    statCard({label: t('live.stats.rate'), value: formatInteger(stats.peakMessagesPerMinute, ctx.locale), sub: t('live.stats.rateSub')}));

  const canvas = el('canvas', {className: 'chart-canvas', attrs: {role: 'img'}});
  const chartCard = el('section', {className: 'card', style: {marginTop: '16px'}},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('history.detail.timelineTitle')}),
      el('div', {className: 'card-hint', text: t('live.chart.hint')})),
    el('div', {className: 'chart-wrap'}, canvas),
    el('div', {className: 'chart-legend'},
      el('span', {}, el('span', {className: 'legend-swatch'}), t('live.chart.messages'))));

  const supportCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('history.detail.supportTitle')}),
      el('div', {className: 'card-hint', text: t('common.actualPaid')})),
    el('div', {className: 'card-body'},
      support.length === 0
        ? emptyState({title: t('history.detail.supportEmpty'), glyph: '·'})
        : el('div', {className: 'support-list'}, supportRows(support, ctx.locale, t))));

  const speakersList = top.speakers?.length
    ? el('div', {className: 'top-list'}, top.speakers.map((speaker, index) => el('div', {className: 'top-item'},
      el('span', {className: 'top-rank', text: String(index + 1)}),
      el('span', {className: 'top-name', text: speaker.nickname ?? speaker.viewer_id}),
      el('span', {className: 'top-value', text: t('live.top.messages', {n: speaker.message_count})}))))
    : emptyState({title: t('history.detail.topEmpty'), glyph: '·'});
  const speakersCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('history.detail.topSpeakers')}),
      el('div', {className: 'card-hint', text: t('live.top.hint')})),
    el('div', {className: 'card-body'}, speakersList));

  const aiCard = buildAiCard(ctx, session, analysisReport);

  const storageCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('history.detail.storageTitle')})),
    el('div', {className: 'card-body'},
      el('div', {className: 'def-list'},
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('history.detail.eventsKept')}),
          el('span', {className: 'def-value', text: `${formatInteger(storage.events, ctx.locale)} · ${formatBytes(storage.contentBytes, ctx.locale)}`})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('settings.storage.title')}),
          el('span', {
            className: 'def-value',
            text: session.storageMode === 'full' ? t('settings.storage.full') : t('settings.storage.compact')
          })))));

  const notices = [];
  if (session.archived) {
    notices.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '16px'}},
      el('div', {},
        el('div', {className: 'callout-title', text: t('history.detail.archivedTitle')}),
        el('div', {text: t('history.detail.archivedBody')}))));
  }
  if (session.status === 'ended' && session.endReason === 'user') {
    notices.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}},
      el('div', {},
        el('div', {className: 'callout-title', text: t('history.detail.stoppedTitle')}),
        el('div', {text: t('history.detail.stoppedBody')}))));
  }
  if (session.simulated) {
    notices.push(el('div', {className: 'callout callout--neutral', style: {marginTop: '16px'}},
      el('div', {className: 'callout-title', text: t('status.simulated')}),
      el('div', {text: t('history.detail.simulatedNote')})));
  }
  if (session.status === 'interrupted') {
    notices.push(el('div', {className: 'callout callout--warn', style: {marginTop: '12px'}},
      el('div', {className: 'callout-title', text: t('status.interrupted')}),
      el('div', {text: t('history.detail.interruptedNote')})));
  }

  container.append(back, head, statsGrid, ...notices);

  if (viewerId) {
    container.append(await buildViewerCard(ctx, session, viewerId));
  }

  container.append(
    chartCard,
    el('div', {className: 'grid-2-equal', style: {marginTop: '16px'}}, supportCard, speakersCard),
    el('div', {className: 'grid-2-equal', style: {marginTop: '16px'}}, aiCard, storageCard)
  );

  chart = new TimelineChart(canvas);
  chart.setLabelFormatter((timestamp) => formatTime(timestamp, ctx.locale));
  chart.setData(payload.timeline, {
    tooltipBuilder: (bucket) => [
      formatTime(bucket.startAt, ctx.locale),
      `${t('live.chart.messages')}: ${bucket.messages}`,
      `${t('live.chart.viewers')}: ${bucket.uniqueViewers}`
    ],
    ariaLabel: `${t('history.detail.timelineTitle')}. ${t('live.chart.peak', {n: stats.peakMessagesPerBucket})}`
  });
  chart.draw();

  return () => {
    chart?.destroy();
    chart = null;
  };
}

/**
 * Compact AI summary inside the deterministic session detail.
 *
 * When a validated AI result exists, the card shows the AI summary and a link to
 * the full report. It never presents batch results as a complete analysis and
 * never mixes AI numbers into the local statistics above.
 */
function buildAiCard(ctx, session, report) {
  const t = ctx.t;
  const openAi = () => ctx.navigate(`/ai?session=${encodeURIComponent(session.id)}`);
  const openReport = () => ctx.navigate(`/ai?session=${encodeURIComponent(session.id)}&report=1`);
  const head = el('div', {className: 'card-head'},
    el('div', {className: 'card-title', text: t('history.detail.aiTitle')}),
    aiChip(report?.complete ? 'imported' : (report?.mode === 'partial' ? 'partial' : session.aiStatus), t));

  let body;
  if (report?.report) {
    const summary = report.report.summary || t('ai.report.summaryEmpty');
    const excerpt = summary.length > 420 ? `${summary.slice(0, 420)}…` : summary;
    body = el('div', {},
      el('div', {className: 'ai-report-preview'},
        el('div', {className: 'inline'},
          chip(t('ai.report.aiBadge'), 'accent'),
          chip(t('ai.report.topicsTitle'), 'neutral'),
          el('span', {className: 'small tertiary', text: t('ai.report.viewerProfilesCount', {
            count: report.viewerProfiles?.count ?? 0,
            low: report.viewerProfiles?.lowConfidence ?? 0
          })})),
        el('p', {className: 'ai-report-summary', text: excerpt}),
        el('div', {className: 'small tertiary', text: t('ai.report.importedAt', {
          date: report.result?.importedAt ? formatDateTime(report.result.importedAt, ctx.locale) : '—'
        })})),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--primary button--small',
          type: 'button',
          text: t('history.detail.aiViewReport'),
          onClick: openReport
        }),
        el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('history.detail.aiCta'),
          onClick: openAi
        })));
  } else if (report?.mode === 'partial') {
    body = el('div', {},
      el('div', {className: 'callout callout--warn'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('ai.report.incompleteTitle')}),
          el('div', {text: t('ai.report.incompleteBody')}))),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('ai.report.openAi'),
          onClick: openReport
        })));
  } else if (report?.jobs?.length > 0) {
    body = el('div', {},
      el('div', {className: 'callout callout--neutral'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('ai.import.title')}),
          el('div', {text: t('history.detail.aiPendingBody')}))),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('ai.report.openAi'),
          onClick: openAi
        })));
  } else {
    body = el('div', {},
      el('div', {className: 'callout'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('history.detail.aiPendingTitle')}),
          el('div', {text: t('history.detail.aiPendingBody')}))),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('history.detail.aiCta'),
          onClick: openAi
        })));
  }
  return el('section', {className: 'card'}, head, el('div', {className: 'card-body'}, body));
}

/**
 * One viewer inside one session. Loads at most 50 messages and states clearly
 * when the text is no longer stored (compact mode / retention) or when no stable
 * identity can be shown.
 */
async function buildViewerCard(ctx, session, viewerId) {
  const t = ctx.t;
  let detail;
  try {
    detail = await api.get(`/api/sessions/${encodeURIComponent(session.id)}/viewers/${encodeURIComponent(viewerId)}?limit=50`);
  } catch (error) {
    if (error?.status === 404) {
      return el('div', {className: 'callout callout--warn', style: {marginTop: '16px'}}, t('history.detail.viewerMissing'));
    }
    throw error;
  }
  const participation = detail.participation ?? {};
  const viewer = detail.viewer ?? {};
  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const profilePath = `/viewers/${encodeURIComponent(viewer.id)}${session.broadcasterId
    ? `?broadcaster=${encodeURIComponent(session.broadcasterId)}`
    : ''}`;

  const rows = el('div', {className: 'def-list'},
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('history.detail.viewerUid')}),
      el('span', {className: 'def-value mono', text: `${viewer.platform}:${viewer.platformUid}`})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('history.detail.viewerMessages')}),
      el('span', {className: 'def-value', text: formatInteger(participation.messageCount, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('history.detail.viewerPayments')}),
      el('span', {className: 'def-value', text: formatInteger(participation.paymentEventCount, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('history.detail.viewerFirstSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(participation.firstSeenAt, ctx.locale)})),
    el('div', {className: 'def-row'},
      el('span', {className: 'def-key', text: t('history.detail.viewerLastSeen')}),
      el('span', {className: 'def-value', text: formatDateTime(participation.lastSeenAt, ctx.locale)})));

  const messageList = messages.length > 0
    ? el('div', {className: 'history-viewer-messages'}, messages.map((message) => el('div', {className: 'history-viewer-message'},
      el('span', {className: 'history-message-time', text: formatTime(message.occurredAt, ctx.locale, {seconds: true})}),
      el('span', {className: 'history-message-text', text: message.content || emoteFallback(message, t)}))))
    : el('div', {className: 'small tertiary', text: Number(participation.messageCount) > 0
      ? t('history.detail.viewerNoText')
      : t('history.detail.viewerNoMessages')});

  return el('section', {className: 'card history-viewer-card', style: {marginTop: '16px'}},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('history.detail.viewerTitle')}),
      el('div', {className: 'card-hint', text: viewer.nickname || viewer.id})),
    el('div', {className: 'card-body'},
      rows,
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--secondary button--small',
          type: 'button',
          text: t('history.detail.viewerOpenProfile'),
          onClick: () => ctx.navigate(profilePath)
        })),
      messageList,
      el('div', {className: 'small tertiary', style: {marginTop: '10px'}, text: t('history.detail.viewerHint')})));
}

function emoteFallback(message, t) {
  const first = Array.isArray(message.emotes) ? message.emotes[0] : null;
  if (!first) return '—';
  return t('live.feed.emoteFallback', {name: first.name || first.code || first.id || t('common.unknown')});
}

/* ------------------------------------------------------------------- dates */

function dayStartMs(value) {
  if (!value) return null;
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function dayEndMs(value) {
  if (!value) return null;
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}
