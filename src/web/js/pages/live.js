import {api} from '../api.js';
import {TimelineChart} from '../chart.js';
import {
  chip,
  clear,
  el,
  emptyState,
  formatClock,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatMoney,
  formatTime,
  statCard
} from '../ui.js';
import {platformLabel, supportPrimaryText} from './shared.js';

/**
 * Live page: start/stop a (simulated) recording and watch it accumulate.
 * Only the newest 40 events are rendered; raw history stays in the database.
 */
export const livePage = {
  titleKey: 'live.pageTitle',

  async render(container, ctx) {
    const t = ctx.t;
    let summary = null;
    let mode = null;
    let feedEvents = [];
    let chart = null;
    let refs = {};
    let lastSessionRow = null;
    let elapsedTimer = null;
    let destroyed = false;
    let startBusy = false;

    const [currentPayload, sessionsPayload] = await Promise.all([
      api.get('/api/sessions/current'),
      api.get('/api/sessions?limit=1')
    ]);
    summary = currentPayload.session ?? null;
    lastSessionRow = sessionsPayload.sessions?.[0] ?? null;

    /* ------------------------------------------------------------- building */

    function startButton() {
      const button = el('button', {
        className: 'button button--primary',
        type: 'button',
        text: t('live.hero.start'),
        onClick: () => handleStart(button)
      });
      return button;
    }

    function buildIdle() {
      chart?.destroy();
      chart = null;
      refs = {};
      clear(container);
      container.append(
        el('section', {className: 'hero', dataset: {live: 'false'}},
          el('div', {className: 'hero-body'},
            el('div', {className: 'hero-text'},
              el('div', {className: 'hero-eyebrow'}, chip(t('live.hero.idleEyebrow'), 'neutral')),
              el('h1', {className: 'hero-title', text: t('live.hero.idleTitle')}),
              el('p', {className: 'hero-sub', text: t('live.hero.idleSubtitle')})),
            el('div', {className: 'hero-actions'}, startButton()))),
        buildLastSessionCard()
      );
    }

    function buildLastSessionCard() {
      const node = el('section', {className: 'card', style: {marginTop: '16px'}});
      node.append(el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('live.last.title')}),
        el('button', {
          className: 'button button--ghost button--small',
          type: 'button',
          text: t('live.last.link'),
          onClick: () => ctx.navigate(lastSessionRow ? `/history/${encodeURIComponent(lastSessionRow.id)}` : '/history')
        })));
      if (!lastSessionRow) {
        node.append(el('div', {className: 'card-body'}, emptyState({title: t('live.last.empty'), glyph: '·'})));
        return node;
      }
      const row = lastSessionRow;
      const duration = row.endedAt ? row.endedAt - row.startedAt : Date.now() - row.startedAt;
      node.append(el('div', {className: 'card-body'},
        el('div', {className: 'row-title'},
          el('span', {className: 'row-title-text', text: row.roomTitle || platformLabel(row.platform, t)})),
        el('div', {className: 'hero-sub', text: `${formatDateTime(row.startedAt, ctx.locale)} · ${formatDuration(duration, t)}`}),
        el('div', {className: 'stat-grid', style: {marginTop: '16px'}},
          statCard({label: t('live.stats.messages'), value: formatInteger(row.messageCount, ctx.locale)}),
          statCard({label: t('live.stats.viewers'), value: formatInteger(row.uniqueViewerCount, ctx.locale)}),
          statCard({label: t('live.stats.payments'), value: formatInteger(row.paymentEventCount, ctx.locale), sub: t('live.stats.supportSub')}),
          statCard({label: t('history.aiTitle'), value: row.aiStatus === 'exported' ? '✓' : '—'}))));
      return node;
    }

    function statRef({label, sub}) {
      const value = el('span', {text: '0'});
      const node = el('div', {className: 'stat'},
        el('div', {className: 'stat-label', text: label}),
        el('div', {className: 'stat-value'}, value),
        el('div', {className: 'stat-sub', text: sub}));
      return {node, value};
    }

    function buildLive(next) {
      chart?.destroy();
      chart = null;
      refs = {};
      clear(container);

      const elapsedValue = el('span', {className: 'hero-clock-value', text: formatClock(Date.now() - next.session.startedAt)});
      const hero = el('section', {className: 'hero', dataset: {live: 'true'}},
        el('div', {className: 'hero-body'},
          el('div', {className: 'hero-text'},
            el('div', {className: 'hero-eyebrow'},
              chip(t('live.hero.liveEyebrow'), 'live', {dot: true}),
              next.session.simulated ? chip(t('live.hero.simulatedChip'), 'neutral') : null,
              next.session.platform === 'mock' ? null : chip(platformLabel(next.session.platform, t), 'neutral')),
            el('h1', {className: 'hero-title', text: next.session.roomTitle || platformLabel(next.session.platform, t)}),
            el('p', {className: 'hero-sub', text: `${t('live.hero.startedAt')} ${formatDateTime(next.session.startedAt, ctx.locale)}`}),
            el('div', {className: 'hero-clock'},
              elapsedValue,
              el('span', {className: 'hero-clock-label', text: t('live.hero.elapsed')}),
              el('span', {className: 'hero-divider'}),
              el('span', {className: 'hero-clock-label', text: t('live.stats.messages')}),
              el('span', {className: 'hero-clock-value', text: '0', dataset: {role: 'hero-messages'}}))),
          el('div', {className: 'hero-actions'},
            el('button', {
              className: 'button button--danger',
              type: 'button',
              text: t('live.hero.stop'),
              onClick: (clickEvent) => handleStop(clickEvent.currentTarget)
            }))));
      refs.elapsedValue = elapsedValue;
      refs.heroMessages = hero.querySelector('[data-role="hero-messages"]');

      const messages = statRef({label: t('live.stats.messages'), sub: t('live.stats.messagesSub')});
      const viewers = statRef({label: t('live.stats.viewers'), sub: t('live.stats.viewersSub')});
      const support = statRef({label: t('live.stats.support'), sub: t('live.stats.supportSub')});
      const rate = statRef({label: t('live.stats.rate'), sub: t('live.stats.rateSub')});
      const statsGrid = el('div', {className: 'stat-grid', style: {marginTop: '16px'}},
        messages.node, viewers.node, support.node, rate.node);
      refs.messages = messages.value;
      refs.viewers = viewers.value;
      refs.support = support.value;
      refs.rate = rate.value;

      const canvas = el('canvas', {className: 'chart-canvas', attrs: {role: 'img'}});
      const chartCard = el('section', {className: 'card', style: {marginTop: '16px'}},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.chart.title')}),
          el('div', {className: 'card-hint', text: t('live.chart.hint')})),
        el('div', {className: 'chart-wrap'}, canvas),
        el('div', {className: 'chart-legend'},
          el('span', {}, el('span', {className: 'legend-swatch'}), t('live.chart.messages'))));

      const feedHost = el('div', {className: 'feed'});
      const feedCard = el('section', {className: 'card'},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.feed.title')}),
          el('div', {className: 'card-hint', text: t('live.feed.hint')})),
        feedHost);
      refs.feedHost = feedHost;

      const topHost = el('div', {className: 'top-list'});
      const topCard = el('section', {className: 'card'},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.top.title')}),
          el('div', {className: 'card-hint', text: t('live.top.hint')})),
        topHost);
      refs.topHost = topHost;

      container.append(hero, statsGrid, chartCard, el('div', {className: 'grid-2', style: {marginTop: '16px'}}, feedCard, topCard));

      chart = new TimelineChart(canvas);
      chart.setLabelFormatter((timestamp) => formatTime(timestamp, ctx.locale));
      renderFeed();
      renderTop(next.top?.speakers ?? []);
      updateLive(next);
      startElapsedTimer(next.session.startedAt);
    }

    function startElapsedTimer(startedAt) {
      clearInterval(elapsedTimer);
      const tick = () => {
        if (destroyed || !refs.elapsedValue) return;
        refs.elapsedValue.textContent = formatClock(Date.now() - startedAt);
      };
      tick();
      elapsedTimer = window.setInterval(tick, 1000);
    }

    function updateLive(next) {
      if (!next) return;
      if (refs.heroMessages) refs.heroMessages.textContent = formatInteger(next.stats.messages, ctx.locale);
      if (refs.messages) refs.messages.textContent = formatInteger(next.stats.messages, ctx.locale);
      if (refs.viewers) refs.viewers.textContent = formatInteger(next.stats.activeViewers, ctx.locale);
      if (refs.support) {
        const primary = supportPrimaryText(next.support, ctx.locale);
        refs.support.textContent = primary ?? t('live.stats.noSupport');
      }
      if (refs.rate) refs.rate.textContent = formatInteger(next.stats.peakMessagesPerMinute, ctx.locale);
      if (chart) {
        chart.setData(next.timeline, {
          tooltipBuilder: (bucket) => [
            formatTime(bucket.startAt, ctx.locale),
            `${t('live.chart.messages')}: ${bucket.messages}`,
            `${t('live.chart.viewers')}: ${bucket.uniqueViewers}`
          ],
          ariaLabel: `${t('live.chart.title')}. ${t('live.chart.peak', {n: next.stats.peakMessagesPerBucket})}`
        });
        chart.draw();
      }
      renderTop(next.top?.speakers ?? []);
    }

    function renderTop(speakers) {
      const host = refs.topHost;
      if (!host) return;
      clear(host);
      if (!speakers || speakers.length === 0) {
        host.append(emptyState({title: t('live.top.empty'), glyph: '·'}));
        return;
      }
      speakers.forEach((speaker, index) => {
        host.append(el('div', {className: 'top-item'},
          el('span', {className: 'top-rank', text: String(index + 1)}),
          el('span', {className: 'top-name', text: speaker.nickname ?? speaker.viewer_id}),
          el('span', {className: 'top-value', text: t('live.top.messages', {n: speaker.message_count})})));
      });
    }

    function feedTagFor(type) {
      if (type === 'gift') return {text: t('live.feed.giftTag'), kind: 'gift'};
      if (type === 'super_chat') return {text: t('live.feed.scLabel'), kind: 'super_chat'};
      if (type === 'guard') return {text: t('live.feed.guardLabel'), kind: 'guard'};
      if (type === 'membership') return {text: t('live.feed.membershipLabel'), kind: 'guard'};
      return null;
    }

    function feedItem(event) {
      const name = event.displayName || t('live.feed.anonymous');
      const tag = feedTagFor(event.type);
      const line = el('div', {className: 'feed-line'}, el('span', {className: 'feed-name', text: name}));
      if (event.type === 'gift') {
        line.append(el('span', {className: 'feed-text', text: t('live.feed.giftLabel', {
          name: event.giftName ?? '',
          qty: event.giftQuantity ?? 1
        })}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else if (event.type === 'super_chat') {
        if (event.content) line.append(el('span', {className: 'feed-text feed-text--sc', text: event.content}));
        line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
      } else if (event.type === 'guard' || event.type === 'membership') {
        line.append(el('span', {className: 'feed-text', text: event.giftName ?? t('live.feed.guardLabel')}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else {
        line.append(el('span', {className: 'feed-text', text: event.content ?? ''}));
      }
      return el('div', {className: 'feed-item'},
        tag ? el('span', {className: 'feed-tag', dataset: {kind: tag.kind}, text: tag.text}) : null,
        el('div', {className: 'feed-body'},
          line,
          el('div', {className: 'feed-meta', text: formatTime(event.occurredAt, ctx.locale, {seconds: true})})));
    }

    function renderFeed() {
      const host = refs.feedHost;
      if (!host) return;
      clear(host);
      if (feedEvents.length === 0) {
        host.append(emptyState({title: t('live.feed.empty'), glyph: '·'}));
        return;
      }
      for (const event of feedEvents.slice(0, 40)) host.append(feedItem(event));
    }

    async function loadFeed(sessionId) {
      try {
        const payload = await api.get(`/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=40`);
        feedEvents = payload.events ?? [];
        renderFeed();
      } catch {
        /* the stream will fill the feed as new events arrive */
      }
    }

    /* ------------------------------------------------------------ actions */

    async function handleStart(button) {
      if (startBusy) return;
      startBusy = true;
      button.disabled = true;
      button.textContent = t('live.hero.starting');
      try {
        await api.post('/api/simulate/start', {
          title: t('live.hero.simulationTitle'),
          speed: 'normal'
        });
        const payload = await api.get('/api/sessions/current');
        summary = payload.session ?? null;
        if (summary) {
          mode = 'live';
          feedEvents = [];
          buildLive(summary);
          await loadFeed(summary.session.id);
          await ctx.refreshStatus();
        }
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.hero.start');
      } finally {
        startBusy = false;
      }
    }

    async function handleStop(button) {
      if (!button) return;
      button.disabled = true;
      button.textContent = t('live.hero.stopping');
      try {
        await api.post('/api/simulate/stop', {});
        summary = null;
        ctx.state.liveSummary = null;
        const sessions = await api.get('/api/sessions?limit=1');
        lastSessionRow = sessions.sessions?.[0] ?? null;
        mode = 'idle';
        buildIdle();
        await ctx.refreshStatus();
        ctx.toast(t('live.hero.stopDone'));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.hero.stop');
      }
    }

    /* ------------------------------------------------------- subscriptions */

    const offEvent = ctx.on('event', (event) => {
      if (destroyed || !summary) return;
      if (event.sessionId !== summary.session.id) return;
      feedEvents = [event, ...feedEvents].slice(0, 40);
      if (mode === 'live') renderFeed();
    });

    const offSummary = ctx.on('livesummary', (next) => {
      if (destroyed) return;
      summary = next;
      if (!next) {
        if (mode !== 'idle') {
          mode = 'idle';
          buildIdle();
        }
        return;
      }
      if (mode !== 'live' || !refs.messages) {
        mode = 'live';
        feedEvents = [];
        buildLive(next);
        loadFeed(next.session.id);
      } else {
        updateLive(next);
      }
    });

    /* ------------------------------------------------------------- initial */

    if (summary) {
      mode = 'live';
      buildLive(summary);
      await loadFeed(summary.session.id);
    } else {
      mode = 'idle';
      buildIdle();
    }

    return () => {
      destroyed = true;
      offEvent();
      offSummary();
      clearInterval(elapsedTimer);
      chart?.destroy();
      chart = null;
    };
  }
};
