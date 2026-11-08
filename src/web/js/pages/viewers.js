import {api} from '../api.js';
import {
  chip,
  debounce,
  el,
  emptyState,
  formatDateTime,
  formatInteger,
  initials,
  pageHead,
  statCard
} from '../ui.js';
import {platformLabel, statusChip, supportPrimaryText, supportRows} from './shared.js';

/**
 * Viewer directory and long-term profile.
 *
 * The profile page deliberately shows aggregates and recorded facts only.
 * Interests and dislikes are AI-derived and therefore appear only after the
 * profile import of milestone M7.
 */
export const viewersPage = {
  titleKey: 'viewers.pageTitle',

  async render(container, ctx, params) {
    if (params?.id) return renderDetail(container, ctx, params.id);
    return renderList(container, ctx);
  }
};

async function renderList(container, ctx) {
  const t = ctx.t;
  container.append(pageHead({title: t('viewers.pageTitle'), subtitle: t('viewers.pageSubtitle')}));

  const searchInput = el('input', {
    className: 'input',
    type: 'search',
    placeholder: t('viewers.searchPlaceholder'),
    attrs: {'aria-label': t('viewers.searchPlaceholder'), autocomplete: 'off'}
  });
  const countLabel = el('span', {className: 'small tertiary'});
  const toolbar = el('div', {className: 'toolbar'}, searchInput, countLabel);
  const listHost = el('div', {className: 'card', style: {overflow: 'hidden'}});
  container.append(toolbar, listHost);

  let requestToken = 0;

  async function load(query = '') {
    const token = ++requestToken;
    listHost.replaceChildren();
    const payload = await api.get(`/api/viewers?limit=200&query=${encodeURIComponent(query)}`);
    if (token !== requestToken) return;
    const viewers = payload.viewers ?? [];
    countLabel.textContent = t('viewers.countLabel', {n: viewers.length});
    listHost.replaceChildren();
    if (viewers.length === 0) {
      listHost.append(emptyState({
        title: query ? t('viewers.emptySearch') : t('viewers.empty'),
        body: query ? null : t('viewers.emptyBody'),
        glyph: '·'
      }));
      return;
    }
    const list = el('div', {className: 'list'});
    for (const viewer of viewers) {
      list.append(viewerRow(viewer));
    }
    listHost.append(list);
  }

  function viewerRow(viewer) {
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
    const support = supportPrimaryText(viewer.support, ctx.locale);
    return el('div', {
      className: 'list-row list-row--interactive viewer-row',
      attrs: {role: 'link', tabindex: '0'},
      onClick: () => ctx.navigate(`/viewers/${encodeURIComponent(viewer.id)}`),
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ctx.navigate(`/viewers/${encodeURIComponent(viewer.id)}`);
        }
      }
    },
      star,
      el('span', {className: 'avatar', text: initials(viewer.nickname ?? viewer.platformUid), attrs: {'aria-hidden': 'true'}}),
      el('div', {className: 'row-main'},
        el('div', {className: 'row-title'},
          el('span', {className: 'row-title-text', text: viewer.nickname ?? viewer.platformUid}),
          viewer.focused ? chip(t('viewers.detail.focusedChip'), 'warn') : null),
        el('div', {className: 'row-sub'},
          el('span', {text: platformLabel(viewer.platform, t)}),
          el('span', {className: 'mono tertiary', text: viewer.platformUid}))),
      el('div', {className: 'row-metrics'},
        el('div', {className: 'metric'},
          el('div', {className: 'metric-label', text: t('viewers.metric.sessions')}),
          el('div', {className: 'metric-value', text: formatInteger(viewer.sessionCount, ctx.locale)})),
        el('div', {className: 'metric metric--optional'},
          el('div', {className: 'metric-label', text: t('viewers.metric.messages')}),
          el('div', {className: 'metric-value', text: formatInteger(viewer.messageCount, ctx.locale)})),
        el('div', {className: 'metric metric--optional'},
          el('div', {className: 'metric-label', text: t('viewers.metric.support')}),
          el('div', {className: 'metric-value', text: support ?? '—'}))),
      el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}}));
  }

  searchInput.addEventListener('input', debounce(() => {
    load(searchInput.value.trim()).catch((error) => ctx.toast(ctx.describeError(error), {tone: 'error'}));
  }, 260));
  await load('');
  return undefined;
}

async function renderDetail(container, ctx, viewerId) {
  const t = ctx.t;
  const profile = await api.get(`/api/viewers/${encodeURIComponent(viewerId)}`);
  const {viewer, support, nicknames, sessions} = profile;

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
        headerChips)),
    el('div', {className: 'page-actions'}, focusButton));

  const statsGrid = el('div', {className: 'stat-grid'},
    statCard({label: t('viewers.metric.sessions'), value: formatInteger(viewer.sessionCount, ctx.locale)}),
    statCard({label: t('viewers.metric.messages'), value: formatInteger(viewer.messageCount, ctx.locale)}),
    statCard({label: t('live.stats.payments'), value: formatInteger(viewer.paymentEventCount, ctx.locale)}),
    statCard({label: t('viewers.metric.lastSeen'), value: formatDateTime(viewer.lastSeenAt, ctx.locale)}));

  const supportCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('viewers.detail.supportTitle')}),
      el('div', {className: 'card-hint', text: t('common.actualPaid')})),
    el('div', {className: 'card-body'},
      support.length === 0
        ? emptyState({title: t('viewers.detail.supportEmpty'), glyph: '·'})
        : el('div', {className: 'support-list'}, supportRows(support, ctx.locale, t))));

  const nicknameRows = nicknames.length === 0
    ? emptyState({title: t('common.noData'), glyph: '·'})
    : el('div', {className: 'nickname-list'}, nicknames.map((entry) => el('div', {className: 'nickname-row'},
      el('span', {}, entry.nickname, entry.nickname === viewer.nickname ? chip(t('viewers.detail.nicknameCurrent'), 'accent') : null),
      el('span', {className: 'small tertiary', text: `${formatDateTime(entry.firstSeenAt, ctx.locale)} → ${formatDateTime(entry.lastSeenAt, ctx.locale)}`}))));

  const nicknameCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('viewers.detail.nicknamesTitle')})),
    el('div', {className: 'card-body'}, nicknameRows));

  const sessionRows = sessions.length === 0
    ? emptyState({title: t('viewers.detail.sessionsEmpty'), glyph: '·'})
    : el('div', {className: 'list'}, sessions.map((session) => el('div', {
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
      el('div', {className: 'card-title', text: t('viewers.detail.sessionsTitle')}),
      el('div', {className: 'card-hint', text: t('viewers.metric.sessions')})),
    el('div', {className: 'card-body', style: {padding: '0'}}, sessionRows));

  const interestsCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('viewers.detail.interestsTitle')})),
    el('div', {className: 'card-body'},
      emptyState({title: t('common.notAvailable'), body: t('viewers.detail.interestsEmpty'), glyph: '◇'}),
      el('div', {className: 'callout callout--neutral', style: {marginTop: '12px'}}, t('viewers.detail.notes'))));

  const identityCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('viewers.detail.identityTitle')})),
    el('div', {className: 'card-body'},
      el('div', {className: 'def-list'},
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('viewers.detail.platformUid')}),
          el('span', {className: 'def-value mono', text: viewer.platformUid})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('viewers.detail.firstSeen')}),
          el('span', {className: 'def-value', text: formatDateTime(viewer.firstSeenAt, ctx.locale)})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('viewers.detail.lastSeen')}),
          el('span', {className: 'def-value', text: formatDateTime(viewer.lastSeenAt, ctx.locale)})))));

  container.append(
    back,
    hero,
    statsGrid,
    el('div', {className: 'grid-2-equal', style: {marginTop: '16px'}}, supportCard, identityCard),
    el('div', {className: 'grid-2-equal', style: {marginTop: '16px'}}, sessionsCard, nicknameCard),
    el('div', {style: {marginTop: '16px'}}, interestsCard)
  );

  return undefined;
}
