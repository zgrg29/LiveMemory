import {api} from '../api.js';
import {TimelineChart} from '../chart.js';
import {
  chip,
  el,
  emptyState,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatTime,
  pageHead,
  statCard
} from '../ui.js';
import {
  aiChip,
  broadcasterIdentityChip,
  platformLabel,
  statusChip,
  supportPrimaryText,
  supportRows
} from './shared.js';

/**
 * History: a list of recorded sessions and a detail view with locally computed
 * statistics. AI results are not fabricated here; the detail view states
 * honestly when no analysis has been imported.
 */
export const historyPage = {
  titleKey: 'history.pageTitle',

  async render(container, ctx, params) {
    if (params?.id) return renderDetail(container, ctx, params.id);
    return renderList(container, ctx);
  }
};

async function renderList(container, ctx) {
  const t = ctx.t;
  container.append(pageHead({title: t('history.pageTitle'), subtitle: t('history.pageSubtitle')}));
  const payload = await api.get('/api/sessions?limit=200');
  const sessions = payload.sessions ?? [];
  if (sessions.length === 0) {
    container.append(el('div', {className: 'card card--padded'},
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
    return undefined;
  }

  const list = el('div', {className: 'history-list'});
  list.append(el('div', {className: 'history-head'},
    el('span', {text: t('history.columns.session')}),
    el('span', {text: t('history.columns.duration')}),
    el('span', {text: t('history.columns.messages')}),
    el('span', {text: t('history.columns.viewers')}),
    el('span', {text: t('history.columns.support')}),
    el('span', {})));

  for (const row of sessions) {
    const duration = row.endedAt ? row.endedAt - row.startedAt : Date.now() - row.startedAt;
    const support = supportPrimaryText(row.support, ctx.locale);
    const node = el('div', {
      className: 'history-row',
      attrs: {role: 'link', tabindex: '0'},
      onClick: () => ctx.navigate(`/history/${encodeURIComponent(row.id)}`),
      onKeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ctx.navigate(`/history/${encodeURIComponent(row.id)}`);
        }
      }
    },
      el('div', {className: 'history-title-cell'},
        el('div', {className: 'history-title', text: row.roomTitle || platformLabel(row.platform, t)}),
        el('div', {className: 'history-sub'},
          statusChip(row, t),
          row.simulated ? chip(t('status.simulated'), 'neutral') : null,
          row.broadcasterName
            ? el('span', {text: row.broadcasterName})
            : broadcasterIdentityChip(row.broadcasterIdentity, t),
          el('span', {text: formatDateTime(row.startedAt, ctx.locale)}),
          aiChip(row.aiStatus, t))),
      el('div', {className: 'history-cell', text: formatDuration(duration, t)}),
      el('div', {className: 'history-cell', text: formatInteger(row.messageCount, ctx.locale)}),
      el('div', {className: 'history-cell', text: formatInteger(row.uniqueViewerCount, ctx.locale)}),
      el('div', {className: 'history-cell', text: support ?? '—'}),
      el('span', {className: 'chevron', attrs: {'aria-hidden': 'true'}}));
    list.append(node);
  }
  container.append(list);
  return undefined;
}

async function renderDetail(container, ctx, sessionId) {
  const t = ctx.t;
  const payload = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const {session, stats, support, top, storage} = payload;
  let chart = null;

  const back = el('button', {
    className: 'detail-back',
    type: 'button',
    onClick: () => ctx.navigate('/history')
  }, el('span', {attrs: {'aria-hidden': 'true'}}), t('history.detail.back'));

  const head = el('div', {className: 'detail-head'},
    el('div', {className: 'hero-text'},
      el('h1', {className: 'detail-title', text: session.roomTitle || platformLabel(session.platform, t)}),
      el('div', {className: 'detail-meta'},
        statusChip(session, t),
        session.simulated ? chip(t('status.simulated'), 'neutral') : null,
        chip(platformLabel(session.platform, t), 'neutral'),
        session.broadcasterName ? chip(session.broadcasterName, 'accent') : null,
        broadcasterIdentityChip(session.broadcasterIdentity, t),
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
      })));

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

  const aiCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'},
      el('div', {className: 'card-title', text: t('history.detail.aiTitle')}),
      aiChip(session.aiStatus, t)),
    el('div', {className: 'card-body'},
      el('div', {className: 'callout'},
        el('div', {},
          el('div', {className: 'callout-title', text: t('history.detail.aiPendingTitle')}),
          el('div', {text: t('history.detail.aiPendingBody')}))),
      el('div', {className: 'inline', style: {marginTop: '12px'}},
        el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('history.detail.aiCta'),
          onClick: () => ctx.navigate(`/ai?session=${encodeURIComponent(session.id)}`)
        }))));

  const storageCard = el('section', {className: 'card'},
    el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('history.detail.storageTitle')})),
    el('div', {className: 'card-body'},
      el('div', {className: 'def-list'},
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('history.detail.eventsKept')}),
          el('span', {className: 'def-value', text: `${formatInteger(storage.events, ctx.locale)} · ${formatBytes(storage.contentBytes, ctx.locale)}`})),
        el('div', {className: 'def-row'},
          el('span', {className: 'def-key', text: t('settings.storage.title')}),
          el('span', {className: 'def-value', text: session.storageMode === 'full' ? t('settings.storage.full') : t('settings.storage.compact')})))));

  const notices = [];
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

  container.append(
    back,
    head,
    statsGrid,
    ...notices,
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
