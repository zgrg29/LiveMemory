import {api} from '../api.js';
import {TimelineChart} from '../chart.js';
import {
  chip,
  clear,
  debounce,
  el,
  emptyState,
  formatClock,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatMoney,
  formatTime,
  loadingBlock,
  statCard
} from '../ui.js';
import {platformLabel, supportPrimaryText} from './shared.js';

/**
 * Live page: several broadcasts can be recorded at the same time.
 *
 * The page is a thin, per-tab view over the server. Every tab is one database
 * session; switching tabs only changes what is rendered. The server keeps all
 * adapters running independently, so navigating away, closing this page or
 * switching to another broadcast never stops another recording.
 *
 * Each async load carries the current `viewToken`. Responses for a previous tab
 * are dropped, so an older request can never overwrite the stream being viewed.
 */

const STATE_META = {
  connecting: {label: 'live.tabs.stateConnecting', tone: 'neutral', dot: true, ended: false},
  connected: {label: 'live.tabs.stateRecording', tone: 'live', dot: true, ended: false},
  reconnecting: {label: 'live.tabs.stateReconnecting', tone: 'warn', dot: true, ended: false},
  auth_required: {label: 'live.tabs.stateFailed', tone: 'danger', dot: false, ended: true},
  failed: {label: 'live.tabs.stateFailed', tone: 'danger', dot: false, ended: true},
  stopped: {label: 'live.tabs.stateStopped', tone: 'neutral', dot: false, ended: true},
  idle: {label: 'live.tabs.stateStopped', tone: 'neutral', dot: false, ended: true}
};

function stateMeta(state, t) {
  const meta = STATE_META[state] ?? STATE_META.idle;
  return {...meta, text: t(meta.label)};
}

function tabName(recording, t) {
  return recording?.broadcasterName
    || recording?.roomTitle
    || platformLabel(recording?.platform, t)
    || t('live.tabs.untitled');
}

function inferFinalState(recording) {
  const state = recording?.connection?.state;
  if (state === 'failed' || state === 'auth_required' || state === 'reconnecting' || state === 'connecting') {
    return 'failed';
  }
  return 'stopped';
}

export const livePage = {
  titleKey: 'live.pageTitle',

  async render(container, ctx) {
    const t = ctx.t;
    let destroyed = false;
    let viewToken = 0;
    /** Active recordings as reported by the server. */
    let recordings = [];
    /** Locally kept tabs for recordings that ended while this page is open. */
    const retired = new Map();
    let selectedId = null;
    /** 'new' | 'loading' | 'live' | 'retired' | 'error' */
    let viewKind = 'new';
    let refs = {};
    let chart = null;
    let elapsedTimer = null;
    let pollTimer = null;
    let tickBusy = false;
    let summaryRefreshTimer = null;
    let leaderboardRefreshTimer = null;
    let recordingsRefreshTimer = null;
    let lastLeaderboardSignature = null;
    let lastSessionRow = null;
    let sourceMode = 'mock';
    let checkedRoom = null;
    let checkedVideo = null;
    let biliStatus = null;
    let youtubeStatus = null;
    let loginTimer = null;
    let loginExpiresAt = 0;
    let loginHintText = '';
    let qrState = null;
    let qrCanvasRef = null;
    let qrWrapRef = null;
    let sourceHost = null;
    let loginHintHost = null;

    const summaryCache = new Map();
    const feedCache = new Map();
    const leaderboardCache = new Map();
    const queryCache = new Map();

    const tabsHost = el('div', {className: 'live-tabs'});
    const bodyHost = el('div', {className: 'live-body'});
    container.append(tabsHost, bodyHost);

    function destroyChart() {
      chart?.destroy();
      chart = null;
    }

    /* --------------------------------------------------------------- tabs */

    function selectedTabNode(scrollHost) {
      return scrollHost.querySelector('[data-selected="true"]') ?? null;
    }

    function renderTabs() {
      clear(tabsHost);
      const activeIds = new Set(recordings.map((recording) => recording.sessionId));
      const retiredList = [...retired.values()].filter((recording) => !activeIds.has(recording.sessionId));
      const scrollHost = el('div', {className: 'recording-tabs-scroll'});
      const tabList = el('div', {
        className: 'recording-tabs-bar',
        attrs: {role: 'tablist', 'aria-label': t('live.tabs.aria')}
      });

      const newTab = el('button', {
        className: 'recording-tab recording-tab--new',
        type: 'button',
        dataset: {selected: String(selectedId === null)},
        attrs: {
          role: 'tab',
          'aria-selected': selectedId === null ? 'true' : 'false',
          'aria-label': t('live.tabs.newAria'),
          title: t('live.tabs.newTitle')
        },
        onClick: () => selectNew()
      },
      el('span', {className: 'recording-tab-plus', text: '+', attrs: {'aria-hidden': 'true'}}),
      el('span', {className: 'recording-tab-label', text: t('live.tabs.new')}));
      tabList.append(newTab, scrollHost);

      function appendTab(recording, {isRetired = false} = {}) {
        const selected = recording.sessionId === selectedId;
        const state = isRetired ? (recording.finalState ?? 'stopped') : recording.connection.state;
        const meta = stateMeta(state, t);
        const name = tabName(recording, t);
        const group = el('div', {
          className: 'recording-tab-group',
          dataset: {selected: String(selected), state}
        });
        const tab = el('button', {
          className: 'recording-tab',
          type: 'button',
          attrs: {
            role: 'tab',
            'aria-selected': selected ? 'true' : 'false',
            'aria-label': t('live.tabs.tabAria', {name, state: meta.text}),
            title: `${name} · ${platformLabel(recording.platform, t)} · ${meta.text}`
          },
          onClick: () => openSession(recording.sessionId)
        },
        el('span', {className: 'recording-tab-dot', dataset: {state}, attrs: {'aria-hidden': 'true'}}),
        el('span', {className: 'recording-tab-label', text: name}),
        el('span', {className: 'recording-tab-state', text: meta.text}));
        group.append(tab);
        if (isRetired) {
          group.append(el('button', {
            className: 'recording-tab-close',
            type: 'button',
            text: '×',
            attrs: {
              'aria-label': t('live.tabs.close', {name}),
              title: t('live.tabs.closeHint')
            },
            onClick: (event) => {
              event.stopPropagation();
              closeRetired(recording.sessionId);
            }
          }));
        }
        scrollHost.append(group);
      }

      for (const recording of recordings) appendTab(recording);
      for (const recording of retiredList) appendTab(recording, {isRetired: true});

      tabsHost.append(tabList);
      if (recordings.length > 1) {
        tabsHost.append(el('p', {className: 'recording-tabs-hint', text: t('live.tabs.hint')}));
      }
      window.requestAnimationFrame(() => {
        const node = selectedTabNode(scrollHost);
        node?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
      });
    }

    /* ------------------------------------------------------------ state */

    function retireRecording(recording, {state = null, reason = null} = {}) {
      if (!recording || retired.has(recording.sessionId)) return;
      const finalState = state ?? inferFinalState(recording);
      retired.set(recording.sessionId, {
        ...recording,
        finalState,
        finalReason: reason ?? recording.connection?.detail?.reason ?? null,
        retiredAt: Date.now()
      });
    }

    function closeRetired(sessionId) {
      const id = String(sessionId);
      if (!retired.has(id)) return;
      retired.delete(id);
      summaryCache.delete(id);
      feedCache.delete(id);
      leaderboardCache.delete(id);
      queryCache.delete(id);
      if (selectedId === id) {
        const next = recordings.at(-1) ?? null;
        if (next) openSession(next.sessionId, {force: true});
        else selectNew();
        return;
      }
      renderTabs();
    }

    function fallbackSelection() {
      const next = recordings.at(-1) ?? null;
      if (next) return openSession(next.sessionId, {force: true});
      return selectNew();
    }

    function selectNew() {
      selectedId = null;
      viewKind = 'new';
      viewToken += 1;
      destroyChart();
      renderTabs();
      renderNewView();
    }

    /* ---------------------------------------------------------- data sync */

    async function loadSourceStatuses() {
      const [bili, youtube] = await Promise.all([
        api.get('/api/bilibili/status').catch(() => null),
        api.get('/api/youtube/status').catch(() => null)
      ]);
      biliStatus = bili;
      youtubeStatus = youtube;
    }

    async function refreshYoutubeStatus() {
      try {
        youtubeStatus = await api.get('/api/youtube/status');
      } catch {
        /* keep the previous snapshot */
      }
    }

    async function refreshRecordings() {
      const payload = await api.get('/api/live/recordings');
      if (destroyed) return payload;
      const next = Array.isArray(payload?.recordings) ? payload.recordings : [];
      const nextIds = new Set(next.map((recording) => recording.sessionId));
      const previousList = recordings;
      recordings = next;
      for (const previous of previousList) {
        if (nextIds.has(previous.sessionId)) continue;
        retireRecording(previous);
        if (selectedId === previous.sessionId) {
          // The stream ended or failed while it was being viewed. Keep the tab
          // and show its final state instead of silently jumping elsewhere.
          await openSession(previous.sessionId, {force: true});
        }
      }
      renderTabs();
      if (!selectedId) {
        updateNewNotice();
        return payload;
      }
      const selected = recordings.find((recording) => recording.sessionId === selectedId) ?? null;
      if (selected) updateHeroConnection(selected);
      return payload;
    }

    function scheduleRecordingsRefresh() {
      if (recordingsRefreshTimer) return;
      recordingsRefreshTimer = window.setTimeout(() => {
        recordingsRefreshTimer = null;
        if (!destroyed) refreshRecordings().catch(() => {});
      }, 250);
    }

    /* ------------------------------------------------------------- view */

    function renderViewLoading() {
      destroyChart();
      clear(bodyHost);
      bodyHost.append(el('section', {className: 'card card--padded'}, loadingBlock()));
    }

    function renderError(error) {
      destroyChart();
      clear(bodyHost);
      bodyHost.append(el('section', {className: 'card'},
        emptyState({
          title: t('common.error'),
          body: ctx.describeError(error),
          glyph: '!',
          action: el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('common.retry'),
            onClick: () => {
              if (selectedId) openSession(selectedId, {force: true});
              else selectNew();
            }
          })
        })));
    }

    function startElapsedTimer(summary, ended) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
      const startedAt = summary.session.startedAt;
      const fixedEnd = ended ? (summary.session.endedAt ?? Date.now()) : null;
      const update = () => {
        if (!refs.elapsedValue) return;
        refs.elapsedValue.textContent = formatClock((fixedEnd ?? Date.now()) - startedAt);
      };
      update();
      if (!ended) elapsedTimer = window.setInterval(update, 1000);
    }

    function connectionLine(recording, t) {
      const host = el('div', {className: 'source-status live-connection-line'});
      connectDetailChips(host, recording);
      return host;
    }

    function connectDetailChips(host, recording) {
      clear(host);
      if (!recording) return;
      const state = recording.connection?.state;
      const detail = recording.connection?.detail ?? {};
      if (state === 'reconnecting') host.append(chip(t('live.tabs.stateReconnecting'), 'warn'));
      if (Number.isFinite(detail.viewers) && detail.viewers !== null) {
        host.append(chip(t('live.source.youtubeHotness', {n: formatInteger(detail.viewers, ctx.locale)}), 'neutral'));
      }
      if (Number.isFinite(detail.popularity) && detail.popularity !== null) {
        host.append(chip(`${t('live.source.online')} ${formatInteger(detail.popularity, ctx.locale)}`, 'neutral'));
      }
      if (Number.isFinite(detail.messagesSeen)) {
        host.append(chip(`${t('live.stats.messages')} ${formatInteger(detail.messagesSeen, ctx.locale)}`, 'neutral'));
      }
      if (Number(detail.gapSuspected) > 0) {
        host.append(chip(t('live.source.youtubePossibleGaps', {n: detail.gapSuspected}), 'neutral'));
      }
      if (Number(detail.attempt) > 1 && state === 'reconnecting') {
        host.append(chip(t('live.tabs.retryAttempt', {n: detail.attempt}), 'neutral'));
      }
    }

    function updateHeroConnection(recording) {
      if (!refs.stateHost) return;
      clear(refs.stateHost);
      const state = recording?.connection?.state ?? 'connected';
      const meta = stateMeta(state, t);
      refs.stateHost.append(chip(meta.text, meta.tone, {dot: meta.dot && !meta.ended}));
      if (refs.connectionLine) connectDetailChips(refs.connectionLine, recording);
    }

    function renderSession(summary, recording, {readOnly = false} = {}) {
      destroyChart();
      refs = {};
      lastLeaderboardSignature = null;
      clear(bodyHost);
      const ended = readOnly || summary.session.status !== 'live';
      const state = recording?.connection?.state ?? (ended ? 'stopped' : 'connected');
      const session = summary.session;
      const title = session.roomTitle || tabName(recording, t);
      const displayRecording = recording ?? {
        sessionId: session.id,
        platform: session.platform,
        broadcasterName: session.broadcasterName ?? null,
        roomTitle: session.roomTitle ?? null,
        connection: {state, detail: {reason: null}}
      };

      const stateHost = el('span', {className: 'inline'});
      const elapsedValue = el('span', {
        className: 'hero-clock-value',
        text: formatClock((session.endedAt ?? Date.now()) - session.startedAt)
      });
      const connectionHost = connectionLine(displayRecording, t);
      const action = ended
        ? el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('live.hero.viewHistory'),
          onClick: () => ctx.navigate(`/history/${encodeURIComponent(session.id)}`)
        })
        : el('button', {
          className: 'button button--danger',
          type: 'button',
          text: t('live.hero.stop'),
          attrs: {title: t('live.hero.stopHint')},
          onClick: (event) => stopSelected(event.currentTarget)
        });

      const hero = el('section', {className: 'hero', dataset: {live: ended ? 'false' : 'true'}},
        el('div', {className: 'hero-body'},
          el('div', {className: 'hero-text'},
            el('div', {className: 'hero-eyebrow'},
              stateHost,
              session.simulated ? chip(t('live.hero.simulatedChip'), 'neutral') : null,
              session.platform === 'mock' ? null : chip(platformLabel(session.platform, t), 'neutral')),
            el('h1', {className: 'hero-title', text: title}),
            el('p', {
              className: 'hero-sub',
              text: ended
                ? `${t('live.hero.startedAt')} ${formatDateTime(session.platformStartedAt ?? session.startedAt, ctx.locale)} · ${t('live.hero.endedAt')} ${formatDateTime(session.endedAt, ctx.locale)}`
                : `${t('live.hero.startedAt')} ${formatDateTime(session.platformStartedAt ?? session.startedAt, ctx.locale)}`
            }),
            connectionHost,
            el('div', {className: 'hero-clock'},
              elapsedValue,
              el('span', {className: 'hero-clock-label', text: ended ? t('live.hero.duration') : t('live.hero.elapsed')}),
              el('span', {className: 'hero-divider'}),
              el('span', {className: 'hero-clock-label', text: t('live.stats.messages')}),
              el('span', {className: 'hero-clock-value', text: '0', dataset: {role: 'hero-messages'}})),
            !ended ? el('p', {className: 'hero-note', text: t('live.hero.stopHint')}) : null,
            ended
              ? el('p', {className: 'hero-note', text: state === 'failed' ? t('live.hero.failedNotice') : t('live.hero.endedNotice')})
              : null),
          el('div', {className: 'hero-actions'}, action)));

      refs.stateHost = stateHost;
      refs.connectionLine = connectionHost;
      refs.elapsedValue = elapsedValue;
      refs.heroMessages = hero.querySelector('[data-role="hero-messages"]');
      updateHeroConnection(displayRecording);

      const messages = statRef({label: t('live.stats.messages'), sub: t('live.stats.messagesSub')});
      const viewers = statRef({label: t('live.stats.viewers'), sub: t('live.stats.viewersSub')});
      const support = statRef({label: t('live.stats.support'), sub: t('live.stats.supportSub')});
      const rate = statRef({label: t('live.stats.rate'), sub: t('live.stats.rateSub')});
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

      refs.feedHost = el('div', {className: 'feed'});
      const feedCard = el('section', {className: 'card'},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.feed.title')}),
          el('div', {className: 'card-hint', text: t('live.feed.hint')})),
        refs.feedHost);

      refs.leaderboardHost = el('div', {className: 'leaderboard-scroll'});
      refs.topCount = el('span', {className: 'leaderboard-count', text: ''});
      const search = el('input', {
        className: 'input leaderboard-search',
        attrs: {
          type: 'search',
          placeholder: t('live.top.search'),
          'aria-label': t('live.top.search'),
          autocomplete: 'off'
        }
      });
      search.value = queryCache.get(session.id) ?? '';
      search.addEventListener('input', debounce(() => {
        queryCache.set(session.id, search.value);
        renderLeaderboard();
      }, 120));
      const topCard = el('section', {className: 'card'},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.top.title')}),
          el('div', {className: 'card-hint', text: t('live.top.hint')})),
        el('div', {className: 'leaderboard-toolbar'}, search, refs.topCount),
        refs.leaderboardHost);

      bodyHost.append(
        hero,
        el('div', {className: 'stat-grid', style: {marginTop: '16px'}}, messages.node, viewers.node, support.node, rate.node),
        chartCard,
        el('div', {className: 'grid-2', style: {marginTop: '16px'}}, feedCard, topCard)
      );

      chart = new TimelineChart(canvas);
      chart.setLabelFormatter((timestamp) => formatTime(timestamp, ctx.locale));
      renderFeed();
      renderLeaderboard();
      updateLive(summary);
      startElapsedTimer(summary, ended);
      refs.sessionId = session.id;
      viewKind = ended ? 'retired' : 'live';
    }

    function statRef({label, sub}) {
      const value = el('span', {text: '0'});
      const node = el('div', {className: 'stat'},
        el('div', {className: 'stat-label', text: label}),
        el('div', {className: 'stat-value'}, value),
        el('div', {className: 'stat-sub', text: sub}));
      return {node, value};
    }

    function updateLive(summary) {
      if (!summary) return;
      if (refs.heroMessages) refs.heroMessages.textContent = formatInteger(summary.stats.messages, ctx.locale);
      if (refs.messages) refs.messages.textContent = formatInteger(summary.stats.messages, ctx.locale);
      if (refs.viewers) refs.viewers.textContent = formatInteger(summary.stats.activeViewers, ctx.locale);
      if (refs.support) {
        const primary = supportPrimaryText(summary.support, ctx.locale);
        refs.support.textContent = primary ?? t('live.stats.noSupport');
      }
      if (refs.rate) refs.rate.textContent = formatInteger(summary.stats.peakMessagesPerMinute, ctx.locale);
      if (chart) {
        chart.setData(summary.timeline, {
          tooltipBuilder: (bucket) => [
            formatTime(bucket.startAt, ctx.locale),
            `${t('live.chart.messages')}: ${bucket.messages}`,
            `${t('live.chart.viewers')}: ${bucket.uniqueViewers}`
          ],
          ariaLabel: `${t('live.chart.title')}. ${t('live.chart.peak', {n: summary.stats.peakMessagesPerBucket})}`
        });
        chart.draw();
      }
    }

    /* ------------------------------------------------------------- feed */

    function feedTagFor(type) {
      if (type === 'gift') return {text: t('live.feed.giftTag'), kind: 'gift'};
      if (type === 'super_chat') return {text: t('live.feed.scLabel'), kind: 'super_chat'};
      if (type === 'super_sticker') return {text: t('live.feed.stickerLabel'), kind: 'super_chat'};
      if (type === 'guard') return {text: t('live.feed.guardLabel'), kind: 'guard'};
      if (type === 'membership') return {text: t('live.feed.membershipLabel'), kind: 'guard'};
      return null;
    }

    function feedItem(event) {
      const name = event.displayName || t('live.feed.anonymous');
      const tag = feedTagFor(event.type);
      const badge = Array.isArray(event.badges) && event.badges.length > 0 ? event.badges[0] : null;
      const badgeLabel = badge
        ? (badge.label || t(`live.feed.badge${badge.type.charAt(0).toUpperCase()}${badge.type.slice(1)}`))
        : null;
      const line = el('div', {className: 'feed-line'},
        el('span', {className: 'feed-name', text: name}),
        badgeLabel ? el('span', {className: 'feed-badge', text: badgeLabel}) : null);
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
      } else if (event.type === 'super_sticker') {
        const label = event.giftName ? `${t('live.feed.stickerLabel')} · ${event.giftName}` : t('live.feed.stickerLabel');
        line.append(el('span', {className: 'feed-text', text: label}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else if (event.type === 'guard' || event.type === 'membership') {
        line.append(el('span', {className: 'feed-text', text: event.giftName ?? t('live.feed.guardLabel')}));
        if (event.content) line.append(el('span', {className: 'feed-text', text: event.content}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else {
        const emote = Array.isArray(event.emotes) ? event.emotes[0] : null;
        const emoteName = emote?.name || emote?.code || emote?.id || null;
        const text = event.content ?? (emoteName ? t('live.feed.emoteFallback', {name: emoteName}) : '');
        line.append(el('span', {className: 'feed-text', text}));
      }
      return el('div', {className: 'feed-item'},
        tag ? el('span', {className: 'feed-tag', dataset: {kind: tag.kind}, text: tag.text}) : null,
        el('div', {className: 'feed-body'},
          line,
          el('div', {className: 'feed-meta', text: formatTime(event.occurredAt, ctx.locale, {seconds: true})})));
    }

    function renderFeed() {
      const host = refs.feedHost;
      if (!host || !selectedId) return;
      clear(host);
      const events = feedCache.get(selectedId) ?? [];
      if (events.length === 0) {
        host.append(emptyState({title: t('live.feed.empty'), glyph: '·'}));
        return;
      }
      for (const event of events.slice(0, 40)) host.append(feedItem(event));
    }

    async function loadFeed(sessionId, token) {
      try {
        const payload = await api.get(`/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=40`);
        if (destroyed || token !== viewToken) return;
        feedCache.set(sessionId, payload.events ?? []);
        if (selectedId === sessionId) renderFeed();
      } catch {
        /* the SSE stream will fill the feed as new events arrive */
      }
    }

    /* ------------------------------------------------------- leaderboard */

    function leaderboardRows(data, query) {
      if (!data) return [];
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return data.viewers ?? [];
      return (data.viewers ?? []).filter((row) => {
        const nickname = String(row.nickname ?? '').toLowerCase();
        const uid = String(row.platformUid ?? row.viewerId ?? '').toLowerCase();
        return nickname.includes(needle) || uid.includes(needle);
      });
    }

    function renderLeaderboard() {
      const host = refs.leaderboardHost;
      if (!host || !selectedId) return;
      const data = leaderboardCache.get(selectedId);
      const query = queryCache.get(selectedId) ?? '';
      const rows = leaderboardRows(data, query);
      const signature = [
        selectedId,
        query,
        data?.loaded ? '1' : '0',
        data?.total ?? 0,
        rows.map((row) => `${row.viewerId}:${row.messageCount}`).join(',')
      ].join('#');
      if (signature === lastLeaderboardSignature) return;
      lastLeaderboardSignature = signature;
      const scrollTop = host.scrollTop;
      const resetScroll = refs.leaderboardQuery !== query;
      clear(host);
      if (!data?.loaded) {
        host.append(el('div', {className: 'leaderboard-loading'}, loadingBlock()));
        if (refs.topCount) refs.topCount.textContent = '';
        return;
      }
      refs.leaderboardQuery = query;
      if (refs.topCount) {
        refs.topCount.textContent = t('live.top.summary', {
          shown: formatInteger(rows.length, ctx.locale),
          total: formatInteger(data.total ?? 0, ctx.locale)
        });
      }
      if ((data.viewers ?? []).length === 0) {
        host.append(emptyState({title: t('live.top.empty'), glyph: '·'}));
        return;
      }
      if (rows.length === 0) {
        host.append(emptyState({title: t('live.top.noMatch'), glyph: '·'}));
        return;
      }
      for (const row of rows) {
        const name = row.nickname || row.platformUid || row.viewerId;
        host.append(el('button', {
          className: 'top-item top-item--interactive',
          type: 'button',
          dataset: {rank: String(row.rank)},
          attrs: {
            'aria-label': t('live.top.openProfile', {name}),
            title: t('live.top.openProfile', {name})
          },
          onClick: () => openViewer(row)
        },
        el('span', {className: 'top-rank', text: `#${row.rank}`}),
        el('span', {className: 'top-name', text: name}),
        el('span', {className: 'top-value', text: t('live.top.messages', {n: formatInteger(row.messageCount, ctx.locale)})})));
      }
      host.scrollTop = resetScroll ? 0 : scrollTop;
    }

    async function loadLeaderboard(sessionId, token, {force = false} = {}) {
      const cached = leaderboardCache.get(sessionId);
      if (!force && cached?.loaded && Date.now() - cached.fetchedAt < 3500) return;
      try {
        const payload = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/top-viewers?limit=100`);
        if (destroyed || token !== viewToken) return;
        leaderboardCache.set(sessionId, {...payload, loaded: true, fetchedAt: Date.now()});
        if (selectedId === sessionId) renderLeaderboard();
      } catch {
        if (selectedId === sessionId && !cached?.loaded) {
          leaderboardCache.set(sessionId, {loaded: true, viewers: [], total: 0, fetchedAt: Date.now(), failed: true});
          renderLeaderboard();
        }
      }
    }

    function openViewer(row) {
      const broadcasterId = summaryCache.get(selectedId)?.session?.broadcasterId ?? null;
      const path = `/viewers/${encodeURIComponent(row.viewerId)}`;
      ctx.navigate(broadcasterId ? `${path}?broadcaster=${encodeURIComponent(broadcasterId)}` : path);
    }

    /* ------------------------------------------------------- open a tab */

    async function openSession(sessionId, {force = false} = {}) {
      const id = String(sessionId);
      if (!force && selectedId === id && (viewKind === 'live' || viewKind === 'retired')) return;
      selectedId = id;
      const token = ++viewToken;
      renderTabs();
      const recording = recordings.find((item) => item.sessionId === id) ?? null;
      const retiredRecording = retired.get(id) ?? null;
      const cached = summaryCache.get(id) ?? null;
      viewKind = 'loading';
      if (cached) {
        if (retiredRecording || cached.session.status !== 'live') {
          renderSession(cached, retiredRecording ?? recording, {readOnly: true});
        } else {
          renderSession(cached, recording);
        }
      } else {
        renderViewLoading();
      }
      try {
        const summary = await api.get(`/api/sessions/${encodeURIComponent(id)}`);
        if (destroyed || token !== viewToken) return;
        summaryCache.set(id, summary);
        if (summary.session.status !== 'live') {
          if (!retiredRecording && recording) retireRecording(recording);
          renderSession(summary, retired.get(id) ?? recording, {readOnly: true});
        } else {
          renderSession(summary, recording);
        }
        await Promise.all([
          loadFeed(id, token),
          loadLeaderboard(id, token, {force: true})
        ]);
      } catch (error) {
        if (destroyed || token !== viewToken) return;
        renderError(error);
      }
    }

    /* -------------------------------------------------------- live polls */

    async function refreshSelectedSummary() {
      const id = selectedId;
      if (!id || destroyed || retired.has(id)) return;
      const token = viewToken;
      try {
        const summary = await api.get(`/api/sessions/${encodeURIComponent(id)}`);
        if (destroyed || token !== viewToken || selectedId !== id) return;
        const previous = summaryCache.get(id) ?? null;
        summaryCache.set(id, summary);
        if (previous && previous.session.status !== summary.session.status) {
          if (summary.session.status !== 'live') {
            const recording = recordings.find((item) => item.sessionId === id) ?? null;
            if (recording) retireRecording(recording);
            recordings = recordings.filter((item) => item.sessionId !== id);
            renderTabs();
          }
          renderSession(summary, retired.get(id) ?? recordings.find((item) => item.sessionId === id) ?? null, {
            readOnly: summary.session.status !== 'live'
          });
          return;
        }
        if (viewKind === 'live' && refs.sessionId === id) updateLive(summary);
      } catch {
        /* keep the last good snapshot; the next poll will retry */
      }
    }

    function scheduleSummaryRefresh() {
      if (summaryRefreshTimer) return;
      summaryRefreshTimer = window.setTimeout(() => {
        summaryRefreshTimer = null;
        if (destroyed || document.hidden) return;
        refreshSelectedSummary().catch(() => {});
      }, 700);
    }

    function scheduleLeaderboardRefresh() {
      if (leaderboardRefreshTimer) return;
      leaderboardRefreshTimer = window.setTimeout(() => {
        leaderboardRefreshTimer = null;
        if (destroyed || !selectedId) return;
        const token = viewToken;
        loadLeaderboard(selectedId, token, {force: true}).catch(() => {});
      }, 2500);
    }

    async function tick() {
      if (destroyed || document.hidden || tickBusy) return;
      tickBusy = true;
      try {
        await refreshRecordings();
        if (selectedId && !retired.has(selectedId)) {
          await refreshSelectedSummary();
          await loadLeaderboard(selectedId, viewToken, {force: false});
        }
      } catch {
        /* transient: the next tick retries */
      } finally {
        tickBusy = false;
      }
    }

    /* -------------------------------------------------------- new view */

    function updateNewNotice() {
      if (!refs.newNotice) return;
      const count = recordings.length;
      refs.newNotice.hidden = count === 0;
      refs.newNotice.textContent = count > 0 ? t('live.new.background', {n: count}) : '';
      if (refs.newSubtitle) {
        refs.newSubtitle.textContent = count > 0
          ? t('live.new.subtitleRunning', {n: count})
          : t('live.new.subtitleIdle');
      }
    }

    function renderNewView() {
      destroyChart();
      refs = {};
      clear(bodyHost);
      const notice = el('div', {className: 'callout callout--neutral live-background-notice'});
      notice.hidden = true;
      refs.newNotice = notice;
      refs.newSubtitle = el('p', {
        className: 'hero-sub',
        text: recordings.length > 0
          ? t('live.new.subtitleRunning', {n: recordings.length})
          : t('live.new.subtitleIdle')
      });
      sourceHost = el('div');
      bodyHost.append(
        el('section', {className: 'hero', dataset: {live: 'false'}},
          el('div', {className: 'hero-body'},
            el('div', {className: 'hero-text'},
              el('div', {className: 'hero-eyebrow'}, chip(t('live.new.eyebrow'), 'neutral')),
              el('h1', {className: 'hero-title', text: t('live.new.title')}),
              refs.newSubtitle,
              notice),
            el('div', {className: 'hero-actions'}, startButton()))),
        sourceHost,
        buildLastSessionCard()
      );
      updateNewNotice();
      renderSource();
    }

    /* -------------------------------------------------------- live source */

    function startButton() {
      return el('button', {
        className: 'button button--primary',
        type: 'button',
        text: t('live.hero.start'),
        onClick: (event) => handleStart(event.currentTarget)
      });
    }

    function tabButton(label, mode, onSelect) {
      const active = sourceMode === mode;
      return el('button', {
        className: active ? 'button button--secondary button--small' : 'button button--ghost button--small',
        type: 'button',
        text: label,
        attrs: {'aria-pressed': active ? 'true' : 'false'},
        onClick: () => {
          if (sourceMode === mode) return;
          sourceMode = mode;
          checkedRoom = null;
          checkedVideo = null;
          onSelect?.();
          renderSource();
          if (mode === 'youtube') {
            refreshYoutubeStatus().then(() => {
              if (!destroyed && sourceMode === 'youtube') renderSource();
            }).catch(() => {});
          }
        }
      });
    }

    function renderSource() {
      if (!sourceHost) return;
      clear(sourceHost);
      loginHintHost = null;
      qrCanvasRef = null;
      qrWrapRef = null;
      const card = el('section', {className: 'card', style: {marginTop: '16px'}},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('live.source.title')}),
          el('div', {className: 'card-hint', text: t('live.source.hint')})));

      const tabs = el('div', {className: 'source-tabs'},
        tabButton(t('live.source.mockTab'), 'mock'),
        tabButton(t('live.source.biliTab'), 'bilibili'),
        tabButton(t('live.source.youtubeTab'), 'youtube'));

      const body = el('div', {className: 'card-body'}, tabs);
      if (sourceMode === 'mock') body.append(buildMockPanel());
      else if (sourceMode === 'bilibili') body.append(buildBiliPanel());
      else body.append(buildYouTubePanel());
      card.append(body);
      sourceHost.append(card);
    }

    function buildMockPanel() {
      const panel = el('div', {className: 'source-panel'});
      panel.append(
        el('p', {className: 'source-note', text: t('live.source.mockNote')}),
        el('div', {className: 'hero-actions', style: {marginTop: '12px'}}, startButton()));
      return panel;
    }

    function loginStateText() {
      const login = biliStatus?.login;
      if (!login?.loggedIn) return t('live.source.loginAnonymous');
      const name = login.user?.name || login.user?.uid || '—';
      return t('live.source.loginSignedIn', {name});
    }

    function buildBiliPanel() {
      const panel = el('div', {className: 'source-panel'});
      const login = biliStatus?.login;

      const loginStatus = el('div', {className: 'source-status', text: loginStateText()});
      const loginButton = el('button', {
        className: 'button button--secondary button--small',
        type: 'button',
        text: t('live.source.loginButton'),
        onClick: (event) => startQrLogin(event.currentTarget)
      });
      const logoutButton = login?.loggedIn
        ? el('button', {
          className: 'button button--ghost button--small',
          type: 'button',
          text: t('live.source.logout'),
          onClick: (event) => logout(event.currentTarget)
        })
        : null;

      loginHintHost = el('div', {className: 'source-status', text: loginHintText});
      panel.append(el('div', {className: 'source-row'},
        el('div', {className: 'field', style: {flex: '1 1 240px'}},
          el('span', {className: 'label', text: t('live.source.loginTitle')}),
          loginStatus),
        el('div', {className: 'source-row-actions'}, loginButton, logoutButton)));
      panel.append(loginHintHost);

      const qrWrap = el('div', {className: 'login-qr'});
      const qrCanvas = el('canvas', {
        className: 'login-qr-canvas',
        attrs: {role: 'img', 'aria-label': t('live.source.loginTitle')}
      });
      qrWrap.append(qrCanvas);
      qrWrap.hidden = true;
      qrCanvasRef = qrCanvas;
      qrWrapRef = qrWrap;
      panel.append(qrWrap);
      panel.append(el('p', {className: 'source-note', text: t('live.source.loginScanHint')}));
      if (qrState?.url && Date.now() < qrState.expiresAt) drawQr(qrState.url);

      const input = el('input', {
        className: 'input',
        attrs: {
          type: 'text',
          inputmode: 'numeric',
          placeholder: t('live.source.roomPlaceholder'),
          'aria-label': t('live.source.roomLabel')
        }
      });
      input.value = checkedRoom ? String(checkedRoom.inputRoomId ?? checkedRoom.roomId) : '';
      refs.roomInput = input;
      const checkButton = el('button', {
        className: 'button button--secondary',
        type: 'button',
        text: t('live.source.check'),
        onClick: (event) => checkRoom(event.currentTarget)
      });
      panel.append(el('div', {className: 'source-row', style: {marginTop: '16px'}},
        el('label', {className: 'field', style: {flex: '1 1 240px'}},
          el('span', {className: 'label', text: t('live.source.roomLabel')}),
          input),
        checkButton));

      if (checkedRoom) {
        const meta = el('div', {className: 'source-meta'});
        meta.append(el('div', {className: 'source-status'},
          chip(t('live.source.roomReady'), 'accent'),
          checkedRoom.liveStatus === 1
            ? chip(t('live.source.liveNow'), 'live', {dot: true})
            : chip(t('live.source.offline'), 'neutral'),
          checkedRoom.title ? el('span', {className: 'row-title-text', text: checkedRoom.title}) : null));
        const details = [];
        if (checkedRoom.anchorName) details.push(`${t('live.source.anchor')}: ${checkedRoom.anchorName}`);
        if (checkedRoom.online) details.push(`${t('live.source.online')}: ${formatInteger(checkedRoom.online, ctx.locale)}`);
        if (details.length) meta.append(el('div', {text: details.join(' · ')}));
        meta.append(el('div', {className: 'hero-actions', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('live.source.start'),
            onClick: (event) => connectRoom(event.currentTarget)
          })));
        panel.append(meta);
      }

      panel.append(el('p', {className: 'source-note', text: t('live.source.anonymousNote')}));
      panel.append(el('p', {className: 'source-note', text: t('live.source.identityNote')}));
      panel.append(el('p', {className: 'source-note', text: t('live.source.moneyNote')}));
      return panel;
    }

    function buildYouTubePanel() {
      const panel = el('div', {className: 'source-panel'});
      panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeIntro')}));

      const status = youtubeStatus;
      if (!status) {
        panel.append(el('div', {className: 'callout callout--warn', style: {marginTop: '12px'}},
          t('live.source.youtubeUnavailable')));
        return panel;
      }

      const input = el('input', {
        className: 'input',
        attrs: {
          type: 'text',
          placeholder: t('live.source.youtubeLinkPlaceholder'),
          'aria-label': t('live.source.youtubeLinkLabel'),
          spellcheck: 'false'
        }
      });
      input.value = checkedVideo?.input ?? '';
      refs.ytInput = input;
      panel.append(el('div', {className: 'source-row', style: {marginTop: '16px'}},
        el('label', {className: 'field', style: {flex: '1 1 320px'}},
          el('span', {className: 'label', text: t('live.source.youtubeLinkLabel')}),
          input),
        el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('live.source.youtubeCheck'),
          onClick: (event) => checkYouTube(event.currentTarget)
        })));

      if (checkedVideo) panel.append(buildVideoMeta(checkedVideo));

      panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeIdentityNote')}));
      panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeMoneyNote')}));

      if (status.policy) {
        panel.append(el('div', {className: 'source-row', style: {marginTop: '8px'}},
          el('div', {className: 'field', style: {flex: '1 1 320px'}},
            el('span', {className: 'label', text: t('live.source.youtubePolicyTitle')}),
            el('div', {className: 'source-status', text: t('live.source.youtubePolicyBody', {days: status.policy.days})})),
          el('button', {
            className: 'button button--ghost button--small',
            type: 'button',
            text: t('live.source.youtubeApplyRetention'),
            onClick: (event) => applyYouTubeRetention(event.currentTarget)
          })));
      }

      return panel;
    }

    function videoReasonText(reason) {
      const key = {
        YOUTUBE_NOT_LIVE_UPCOMING: 'errors.youtubeUpcoming',
        YOUTUBE_NOT_LIVE_ENDED: 'errors.youtubeEnded',
        YOUTUBE_NOT_LIVE_VIDEO: 'errors.youtubeNotLive',
        YOUTUBE_NOT_LIVE: 'errors.youtubeNotLive',
        YOUTUBE_CHAT_DISABLED: 'errors.youtubeChatDisabled',
        YOUTUBE_CHAT_NOT_FOUND: 'errors.youtubeChatUnavailable',
        YOUTUBE_WEB_NETWORK: 'errors.youtubeWebNetwork',
        YOUTUBE_WEB_BLOCKED: 'errors.youtubeWebBlocked',
        YOUTUBE_WEB_PROTOCOL: 'errors.youtubeWebProtocol',
        YOUTUBE_WEB_STALE: 'errors.youtubeWebStale',
        YOUTUBE_WEB_RESTRICTED: 'errors.youtubeWebRestricted',
        YOUTUBE_WEB_NOT_CONFIGURED: 'errors.youtubeWebNotConfigured'
      }[reason];
      return key ? t(key) : null;
    }

    function buildVideoMeta(video) {
      const meta = el('div', {className: 'source-meta'});
      const head = el('div', {className: 'source-status'});
      if (video.recordable) head.append(chip(t('live.source.youtubeLiveNow'), 'live', {dot: true}));
      else if (video.state === 'upcoming') head.append(chip(t('live.source.youtubeUpcoming'), 'neutral'));
      else if (video.state === 'ended') head.append(chip(t('live.source.youtubeEnded'), 'neutral'));
      else head.append(chip(t('live.source.youtubeNotLive'), 'neutral'));
      if (video.title) head.append(el('span', {className: 'row-title-text', text: video.title}));
      meta.append(head);

      const details = [];
      if (video.channelTitle) details.push(`${t('live.source.youtubeChannel')}: ${video.channelTitle}`);
      if (Number.isFinite(video.concurrentViewers)) {
        details.push(`${t('live.source.youtubeViewers')}: ${formatInteger(video.concurrentViewers, ctx.locale)}`);
      }
      if (video.actualStartTime) details.push(`${t('live.hero.startedAt')} ${formatDateTime(Date.parse(video.actualStartTime), ctx.locale)}`);
      if (details.length) meta.append(el('div', {text: details.join(' · ')}));

      if (video.recordable) {
        meta.append(el('div', {className: 'hero-actions', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('live.source.youtubeStart'),
            onClick: (event) => connectYouTube(event.currentTarget)
          })));
      } else {
        const reason = videoReasonText(video.reason);
        if (reason) meta.append(el('p', {className: 'source-note', text: reason}));
      }
      return meta;
    }

    async function checkYouTube(button) {
      const input = refs.ytInput;
      const url = String(input?.value ?? '').trim();
      if (!url) {
        ctx.toast(t('errors.youtubeLinkInvalid'), {tone: 'error'});
        return;
      }
      button.disabled = true;
      button.textContent = t('live.source.youtubeChecking');
      try {
        const result = await api.post('/api/youtube/video', {url});
        checkedVideo = result.video;
        renderSource();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.source.youtubeCheck');
      }
    }

    async function connectYouTube(button) {
      if (!checkedVideo) return;
      button.disabled = true;
      button.textContent = t('live.source.youtubeStarting');
      try {
        const payload = await api.post('/api/youtube/connect', {url: checkedVideo.input});
        checkedVideo = null;
        await afterStart(payload.session?.id ?? null);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.source.youtubeStart');
      }
    }

    async function applyYouTubeRetention(button) {
      button.disabled = true;
      try {
        const result = await api.post('/api/youtube/retention/apply', {});
        await refreshYoutubeStatus();
        renderSource();
        ctx.toast(t('live.source.youtubeRetentionApplied', {count: result?.summary?.purged ?? 0}));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
      }
    }

    function setLoginHint(text) {
      loginHintText = text;
      if (loginHintHost) loginHintHost.textContent = text;
    }

    function drawQr(url) {
      const canvas = qrCanvasRef;
      if (!canvas || !url) return false;
      const factory = globalThis.qrcode;
      if (typeof factory !== 'function') {
        setLoginHint(t('live.source.loginQrUnavailable'));
        return false;
      }
      try {
        const qr = factory(0, 'M');
        qr.addData(url);
        qr.make();
        const count = qr.getModuleCount();
        const margin = 4;
        const scale = Math.max(3, Math.floor(220 / (count + margin * 2)));
        const cssSize = (count + margin * 2) * scale;
        const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
        canvas.width = Math.round(cssSize * ratio);
        canvas.height = Math.round(cssSize * ratio);
        canvas.style.width = `${cssSize}px`;
        canvas.style.height = `${cssSize}px`;
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, cssSize, cssSize);
        context.fillStyle = '#000000';
        for (let row = 0; row < count; row += 1) {
          for (let col = 0; col < count; col += 1) {
            if (qr.isDark(row, col)) {
              context.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
            }
          }
        }
        if (qrWrapRef) qrWrapRef.hidden = false;
        return true;
      } catch {
        setLoginHint(t('live.source.loginQrUnavailable'));
        return false;
      }
    }

    function hideQr() {
      qrState = null;
      if (qrWrapRef) qrWrapRef.hidden = true;
    }

    async function startQrLogin(button) {
      button.disabled = true;
      try {
        const result = await api.post('/api/bilibili/login/qrcode', {});
        qrState = {
          url: result.url,
          expiresAt: result.expiresAt ?? Date.now() + 180000
        };
        loginExpiresAt = qrState.expiresAt;
        drawQr(qrState.url);
        setLoginHint(t('live.source.loginWaiting'));
        startLoginPolling();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        button.disabled = false;
      }
    }

    function startLoginPolling() {
      clearInterval(loginTimer);
      loginTimer = window.setInterval(async () => {
        if (destroyed) {
          clearInterval(loginTimer);
          return;
        }
        if (Date.now() > loginExpiresAt) {
          clearInterval(loginTimer);
          hideQr();
          setLoginHint(t('live.source.loginExpired'));
          return;
        }
        try {
          const result = await api.post('/api/bilibili/login/poll', {});
          if (result.state === 'success') {
            clearInterval(loginTimer);
            hideQr();
            setLoginHint(t('live.source.loginSuccess'));
            biliStatus = await api.get('/api/bilibili/status');
            renderSource();
            ctx.toast(t('live.source.loginSuccess'));
          } else if (result.state === 'scanned') {
            setLoginHint(t('live.source.loginScanned'));
          } else if (result.state === 'expired') {
            clearInterval(loginTimer);
            hideQr();
            setLoginHint(t('live.source.loginExpired'));
          } else {
            setLoginHint(t('live.source.loginWaiting'));
          }
        } catch {
          clearInterval(loginTimer);
          hideQr();
          setLoginHint(t('live.source.loginFailed'));
        }
      }, 2000);
    }

    async function logout(button) {
      button.disabled = true;
      try {
        await api.post('/api/bilibili/login/logout', {});
        biliStatus = await api.get('/api/bilibili/status');
        loginHintText = '';
        hideQr();
        renderSource();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
      }
    }

    async function checkRoom(button) {
      const input = refs.roomInput;
      const roomId = String(input?.value ?? '').trim();
      if (!/^\d{1,12}$/.test(roomId)) {
        ctx.toast(t('errors.roomIdInvalid'), {tone: 'error'});
        return;
      }
      button.disabled = true;
      button.textContent = t('live.source.checking');
      try {
        const result = await api.post('/api/bilibili/room', {roomId});
        checkedRoom = result.room;
        renderSource();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.source.check');
      }
    }

    async function connectRoom(button) {
      if (!checkedRoom) return;
      button.disabled = true;
      button.textContent = t('live.source.starting');
      try {
        const payload = await api.post('/api/bilibili/connect', {roomId: checkedRoom.roomId});
        checkedRoom = null;
        await afterStart(payload.session?.id ?? null);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.source.start');
      }
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

    /* ------------------------------------------------------------ actions */

    async function afterStart(sessionId) {
      await refreshRecordings();
      if (sessionId && recordings.some((recording) => recording.sessionId === String(sessionId))) {
        await openSession(sessionId, {force: true});
      } else if (sessionId) {
        await refreshRecordings();
        await openSession(sessionId, {force: true});
      }
      await ctx.refreshStatus();
    }

    async function handleStart(button) {
      button.disabled = true;
      button.textContent = t('live.hero.starting');
      try {
        const payload = await api.post('/api/simulate/start', {
          title: t('live.hero.simulationTitle'),
          speed: 'normal'
        });
        await afterStart(payload.session?.id ?? null);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = t('live.hero.start');
      }
    }

    async function stopSelected(button) {
      const id = selectedId;
      if (!id) return;
      const recording = recordings.find((item) => item.sessionId === id) ?? null;
      if (!recording) return;
      button.disabled = true;
      button.textContent = t('live.hero.stopping');
      try {
        await api.post(`/api/live/recordings/${encodeURIComponent(id)}/stop`, {});
        const token = ++viewToken;
        const summary = await api.get(`/api/sessions/${encodeURIComponent(id)}`).catch(() => null);
        if (summary) summaryCache.set(id, summary);
        retireRecording(recording, {state: 'stopped', reason: 'user'});
        recordings = recordings.filter((item) => item.sessionId !== id);
        renderTabs();
        if (summary) renderSession(summary, retired.get(id), {readOnly: true});
        await Promise.all([
          loadFeed(id, token),
          loadLeaderboard(id, token, {force: true})
        ]);
        const sessions = await api.get('/api/sessions?limit=10').catch(() => null);
        lastSessionRow = sessions?.sessions?.find((row) => row.status !== 'live') ?? lastSessionRow;
        await refreshRecordings();
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
      if (destroyed) return;
      const sessionId = String(event.sessionId ?? '');
      if (!sessionId) return;
      const list = feedCache.get(sessionId) ?? [];
      feedCache.set(sessionId, [event, ...list].slice(0, 40));
      if (selectedId === sessionId) {
        renderFeed();
        scheduleSummaryRefresh();
        scheduleLeaderboardRefresh();
      }
    });

    const offStatus = ctx.on('status', () => {
      if (!destroyed) scheduleRecordingsRefresh();
    });

    /* ------------------------------------------------------------- initial */

    const [recordingsPayload, sessionsPayload] = await Promise.all([
      api.get('/api/live/recordings').catch(() => ({recordings: []})),
      api.get('/api/sessions?limit=10').catch(() => ({sessions: []}))
    ]);
    recordings = Array.isArray(recordingsPayload?.recordings) ? recordingsPayload.recordings : [];
    lastSessionRow = (sessionsPayload?.sessions ?? []).find((row) => row.status !== 'live') ?? null;
    await loadSourceStatuses();

    renderTabs();
    if (recordings.length > 0) {
      await openSession(recordings.at(-1).sessionId, {force: true});
    } else {
      selectNew();
    }

    pollTimer = window.setInterval(() => {
      tick().catch(() => {});
    }, 4000);

    return () => {
      destroyed = true;
      viewToken += 1;
      offEvent();
      offStatus();
      clearInterval(elapsedTimer);
      clearInterval(loginTimer);
      clearInterval(pollTimer);
      clearTimeout(summaryRefreshTimer);
      clearTimeout(leaderboardRefreshTimer);
      clearTimeout(recordingsRefreshTimer);
      destroyChart();
    };
  }
};
