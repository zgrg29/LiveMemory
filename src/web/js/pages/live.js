import {api} from '../api.js';
import {TimelineChart} from '../chart.js';
import {createModal} from '../dialog.js';
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
import {
  platformLabel,
  platformStatusChip,
  statusChip,
  supportPrimaryText
} from './shared.js';

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

/** Persistent monitoring target states (a tab per room/channel, not per stream). */
const MONITOR_STATE_META = {
  waiting: {label: 'monitoring.state.waiting', tone: 'neutral', dot: false},
  checking: {label: 'monitoring.state.checking', tone: 'neutral', dot: true},
  connecting: {label: 'monitoring.state.connecting', tone: 'neutral', dot: true},
  recording: {label: 'monitoring.state.recording', tone: 'live', dot: true},
  reconnecting: {label: 'monitoring.state.reconnecting', tone: 'warn', dot: true},
  ending: {label: 'monitoring.state.ending', tone: 'warn', dot: true},
  live_stopped: {label: 'monitoring.state.liveStopped', tone: 'warn', dot: false},
  paused: {label: 'monitoring.state.paused', tone: 'neutral', dot: false},
  error: {label: 'monitoring.state.error', tone: 'danger', dot: false}
};

function monitorStateMeta(state, t) {
  const meta = MONITOR_STATE_META[state] ?? MONITOR_STATE_META.waiting;
  return {...meta, text: t(meta.label)};
}

function monitorName(target, t) {
  return target?.displayName
    || target?.targetKey
    || platformLabel(target?.platform, t)
    || t('monitoring.untitled');
}

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
    /** Persistent monitoring targets (one tab per room/channel). */
    let targets = [];
    let monitoringPolicy = null;
    /** Locally kept tabs for recordings that ended while this page is open. */
    const retired = new Map();
    let selectedId = null;
    /** When set, the selected tab is a persistent monitoring target. */
    let selectedTargetId = null;
    /** 'new' | 'loading' | 'live' | 'retired' | 'error' | 'target' */
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
    let biliAutoMonitor = false;
    let youtubeAutoMonitor = false;
    const autoInputs = {bilibili: '', youtube: ''};
    let targetSessionsToken = 0;
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
      const targetIds = new Set(targets.map((target) => target.id));
      // A broadcast produced by a persistent target is represented by that
      // target's tab; it must not create a second, stream-only tab.
      const manualRecordings = recordings.filter((recording) => (
        !recording.monitorTargetId || !targetIds.has(recording.monitorTargetId)
      ));
      const scrollHost = el('div', {className: 'recording-tabs-scroll'});
      const tabList = el('div', {
        className: 'recording-tabs-bar',
        attrs: {role: 'tablist', 'aria-label': t('live.tabs.aria')}
      });

      function appendMonitorTab(target) {
        const selected = target.id === selectedTargetId;
        const meta = monitorStateMeta(target.state, t);
        const name = monitorName(target, t);
        const group = el('div', {
          className: 'recording-tab-group recording-tab-group--monitor',
          dataset: {selected: String(selected), state: target.state}
        });
        group.append(el('button', {
          className: 'recording-tab recording-tab--monitor',
          type: 'button',
          attrs: {
            role: 'tab',
            'aria-selected': selected ? 'true' : 'false',
            'aria-label': t('monitoring.tabAria', {name, state: meta.text}),
            title: `${name} · ${platformLabel(target.platform, t)} · ${meta.text}`
          },
          onClick: () => openTarget(target)
        },
        el('span', {className: 'recording-tab-dot', dataset: {state: target.state}, attrs: {'aria-hidden': 'true'}}),
        el('span', {className: 'recording-tab-monitorMark', text: '◎', attrs: {'aria-hidden': 'true'}}),
        el('span', {className: 'recording-tab-label', text: name}),
        el('span', {className: 'recording-tab-state', text: meta.text})));
        scrollHost.append(group);
      }

      const newTab = el('button', {
        className: 'recording-tab recording-tab--new',
        type: 'button',
        dataset: {selected: String(selectedId === null && selectedTargetId === null)},
        attrs: {
          role: 'tab',
          'aria-selected': selectedId === null && selectedTargetId === null ? 'true' : 'false',
          'aria-label': t('live.tabs.newAria'),
          title: t('live.tabs.newTitle')
        },
        onClick: () => selectNew()
      },
      el('span', {className: 'recording-tab-plus', text: '+', attrs: {'aria-hidden': 'true'}}),
      el('span', {className: 'recording-tab-label', text: t('live.tabs.new')}));

      function appendTab(recording, {isRetired = false} = {}) {
        const selected = recording.sessionId === selectedId;
        const state = isRetired ? (recording.finalState ?? 'stopped') : recording.connection.state;
        const meta = stateMeta(state, t);
        const name = tabName(recording, t);
        const platformEnded = isRetired && (
          recording.finalReason === 'platform_ended'
          || recording.finalReason === 'platform_not_live'
          || recording.platformStatus === 'ended'
          || recording.platformStatus === 'carousel'
        );
        const stateText = platformEnded ? t('status.platformEnded') : meta.text;
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
            'aria-label': t('live.tabs.tabAria', {name, state: stateText}),
            title: `${name} · ${platformLabel(recording.platform, t)} · ${stateText}`
          },
          onClick: () => openSession(recording.sessionId)
        },
        el('span', {className: 'recording-tab-dot', dataset: {state}, attrs: {'aria-hidden': 'true'}}),
        el('span', {className: 'recording-tab-label', text: name}),
        el('span', {className: 'recording-tab-state', text: stateText}));
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

      for (const target of targets) appendMonitorTab(target);
      tabList.append(newTab, scrollHost);
      for (const recording of manualRecordings) appendTab(recording);
      for (const recording of retiredList) appendTab(recording, {isRetired: true});

      tabsHost.append(tabList);
      if (targets.length + manualRecordings.length > 1) {
        tabsHost.append(el('p', {className: 'recording-tabs-hint', text: t('live.tabs.hint')}));
      }
      if (targets.length > 0) {
        tabsHost.append(el('p', {className: 'recording-tabs-hint', text: t('monitoring.tabsHint')}));
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
      selectedTargetId = null;
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
      const [payload, monitoring] = await Promise.all([
        api.get('/api/live/recordings'),
        api.get('/api/monitoring').catch(() => null)
      ]);
      if (destroyed) return payload;
      if (monitoring) {
        targets = Array.isArray(monitoring.targets) ? monitoring.targets : [];
        monitoringPolicy = monitoring.policy ?? monitoringPolicy;
      }
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
      if (selectedTargetId && !targets.some((target) => target.id === selectedTargetId)) {
        selectedTargetId = null;
        if (viewKind === 'target') selectNew();
      }
      renderTabs();
      const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null;
      if (selectedTarget?.activeSessionId && viewKind === 'target') {
        // The followed channel started broadcasting while its waiting tab was
        // open: move that same tab to the live recording view.
        await openSession(selectedTarget.activeSessionId, {force: true, monitorTargetId: selectedTarget.id});
        return payload;
      }
      if (!selectedId) {
        updateNewNotice();
        return payload;
      }
      const selected = recordings.find((recording) => recording.sessionId === selectedId) ?? null;
      if (selected) {
        if (refs.session) {
          refs.session.platformStatus = selected.platformStatus ?? refs.session.platformStatus;
          refs.session.platformStatusAt = selected.platformStatusAt ?? refs.session.platformStatusAt;
          refs.session.lastLiveSeenAt = selected.lastLiveSeenAt ?? refs.session.lastLiveSeenAt;
        }
        updateHeroConnection(selected);
      }
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
      const session = refs.session ?? null;
      const transportTrouble = ['connecting', 'reconnecting', 'auth_required', 'failed'].includes(state);
      if (session && !transportTrouble) {
        // Capture state and platform state are separate. The capture chip turns
        // non-green as soon as the platform reports an end, even while the last
        // confirmation query runs.
        const captureChip = statusChip(session, t);
        if (captureChip) refs.stateHost.append(captureChip);
        const platformChip = platformStatusChip(session, t);
        if (platformChip) refs.stateHost.append(platformChip);
      } else {
        refs.stateHost.append(chip(meta.text, meta.tone, {dot: meta.dot && !meta.ended}));
      }
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
      const monitorTarget = session.monitorTargetId
        ? targets.find((target) => target.id === session.monitorTargetId) ?? null
        : null;
      const monitorAction = monitorTarget
        ? el('button', {
          className: 'button button--ghost',
          type: 'button',
          text: monitorTarget.enabled ? t('monitoring.action.pause') : t('monitoring.action.resume'),
          attrs: {title: t('monitoring.action.pauseHint')},
          onClick: (event) => changeTarget(monitorTarget, monitorTarget.enabled ? 'pause' : 'resume', event.currentTarget)
        })
        : null;

      const hero = el('section', {className: 'hero', dataset: {live: ended ? 'false' : 'true'}},
        el('div', {className: 'hero-body'},
          el('div', {className: 'hero-text'},
            el('div', {className: 'hero-eyebrow'},
              stateHost,
              session.simulated ? chip(t('live.hero.simulatedChip'), 'neutral') : null,
              session.monitorTargetId ? chip(t('monitoring.hero.autoChip'), 'accent') : null,
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
            !ended
              ? el('p', {
                className: 'hero-note',
                text: session.monitorTargetId ? t('monitoring.hero.stopHint') : t('live.hero.stopHint')
              })
              : null,
            ended
              ? el('p', {
                className: 'hero-note',
                text: state === 'failed'
                  ? t('live.hero.failedNotice')
                  : (session.endReason === 'platform_ended' || session.endReason === 'platform_not_live'
                    ? t(session.monitorTargetId ? 'monitoring.hero.platformEndedNote' : 'live.hero.platformEndedNotice')
                    : t(session.monitorTargetId ? 'monitoring.hero.endedNote' : 'live.hero.endedNotice'))
              })
              : null),
          el('div', {className: 'hero-actions'}, monitorAction, action)));

      refs.stateHost = stateHost;
      refs.connectionLine = connectionHost;
      refs.elapsedValue = elapsedValue;
      refs.heroMessages = hero.querySelector('[data-role="hero-messages"]');
      refs.session = session;
      updateHeroConnection(displayRecording);

      const messages = statRef({label: t('live.stats.messages'), sub: t('live.stats.messagesSub')});
      const viewers = statRef({label: t('live.stats.viewers'), sub: t('live.stats.viewersSub')});
      const support = statRef({label: t('live.stats.support'), sub: t('live.stats.supportSub')});
      const rate = statRef({label: t('live.stats.rate'), sub: t('live.stats.rateSub')});
      refs.messages = messages.value;
      refs.viewers = viewers.value;
      refs.support = support.value;
      refs.rate = rate.value;

      refs.identityTitle = el('div', {className: 'callout-title'});
      refs.identityBody = el('div');
      refs.identityNote = el('div', {className: 'callout callout--warn', hidden: true},
        el('div', {},
          refs.identityTitle,
          refs.identityBody,
          el('p', {className: 'callout-note', text: t('live.identity.loginHint')})));

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
        refs.identityNote,
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
      if (refs.identityNote) {
        const unidentified = Number(summary.stats?.unidentifiedMessages ?? 0);
        refs.identityNote.hidden = unidentified <= 0;
        if (unidentified > 0) {
          refs.identityTitle.textContent = t('live.identity.warningTitle');
          refs.identityBody.textContent = t('live.identity.warningBody', {
            total: formatInteger(summary.stats.messages, ctx.locale),
            unidentified: formatInteger(unidentified, ctx.locale)
          });
        }
      }
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

    async function openSession(sessionId, {force = false, monitorTargetId = null} = {}) {
      const id = String(sessionId);
      if (!force && selectedId === id && (viewKind === 'live' || viewKind === 'retired')) return;
      const recording = recordings.find((item) => item.sessionId === id) ?? null;
      const retiredRecording = retired.get(id) ?? null;
      const targetId = monitorTargetId
        ?? recording?.monitorTargetId
        ?? retiredRecording?.monitorTargetId
        ?? targets.find((target) => target.activeSessionId === id || target.lastSessionId === id)?.id
        ?? null;
      selectedId = id;
      selectedTargetId = targetId;
      const token = ++viewToken;
      renderTabs();
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
        if (!selectedTargetId && summary.session.monitorTargetId) {
          selectedTargetId = summary.session.monitorTargetId;
        }
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

    /* ------------------------------------------------- persistent target */

    async function openTarget(target) {
      if (!target) return;
      const active = target.activeSessionId
        ? recordings.find((recording) => recording.sessionId === target.activeSessionId)
        : null;
      if (active) {
        await openSession(target.activeSessionId, {force: true, monitorTargetId: target.id});
        return;
      }
      selectedTargetId = target.id;
      selectedId = null;
      viewKind = 'target';
      const token = ++viewToken;
      destroyChart();
      renderTabs();
      renderTargetView(target);
      await loadTargetSessions(target, token);
    }

    function monitorInfoRow(label, value) {
      return el('div', {className: 'monitor-info-row'},
        el('span', {className: 'monitor-info-label', text: label}),
        el('span', {className: 'monitor-info-value', text: value}));
    }

    function targetCheckIntervalText(target) {
      const ms = monitoringPolicy?.[target.platform]?.checkIntervalMs;
      if (!Number.isFinite(Number(ms))) return null;
      return t('monitoring.interval.seconds', {n: Math.round(Number(ms) / 1000)});
    }

    function renderTargetView(target) {
      refs = {};
      destroyChart();
      clear(bodyHost);
      const meta = monitorStateMeta(target.state, t);
      const name = monitorName(target, t);
      const interval = targetCheckIntervalText(target);

      const actions = el('div', {className: 'hero-actions monitor-actions'});
      if (target.activeSessionId) {
        actions.append(el('button', {
          className: 'button button--primary',
          type: 'button',
          text: t('monitoring.action.viewRecording'),
          onClick: () => openSession(target.activeSessionId, {force: true, monitorTargetId: target.id})
        }));
      }
      if (target.enabled) {
        if (target.state === 'live_stopped') {
          actions.append(el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('monitoring.action.resumeCapture'),
            attrs: {title: t('monitoring.action.resumeCaptureHint')},
            onClick: (event) => changeTarget(target, 'resume_capture', event.currentTarget)
          }));
        }
        actions.append(el('button', {
          className: 'button button--secondary',
          type: 'button',
          text: t('monitoring.action.pause'),
          attrs: {title: t('monitoring.action.pauseHint')},
          onClick: (event) => changeTarget(target, 'pause', event.currentTarget)
        }));
        actions.append(el('button', {
          className: 'button button--ghost',
          type: 'button',
          text: t('monitoring.action.checkNow'),
          attrs: target.activeSessionId ? {disabled: ''} : {},
          onClick: (event) => checkTargetNow(target, event.currentTarget)
        }));
      } else {
        actions.append(el('button', {
          className: 'button button--primary',
          type: 'button',
          text: t('monitoring.action.resume'),
          onClick: (event) => changeTarget(target, 'resume', event.currentTarget)
        }));
      }
      actions.append(el('button', {
        className: 'button button--ghost button--danger-text',
        type: 'button',
        text: t('monitoring.action.delete'),
        onClick: () => openDeleteTargetDialog(target)
      }));

      const hero = el('section', {className: 'hero', dataset: {live: target.state === 'recording' ? 'true' : 'false'}},
        el('div', {className: 'hero-body'},
          el('div', {className: 'hero-text'},
            el('div', {className: 'hero-eyebrow'},
              chip(t('monitoring.chip'), 'accent'),
              chip(platformLabel(target.platform, t), 'neutral'),
              chip(meta.text, meta.tone, {dot: meta.dot})),
            el('h1', {className: 'hero-title', text: name}),
            el('p', {className: 'hero-sub', text: t('monitoring.target.subtitle', {
              platform: platformLabel(target.platform, t),
              key: target.targetKey
            })}),
            target.enabled
              ? el('p', {className: 'hero-note', text: t('monitoring.target.waitingHint')})
              : el('p', {className: 'hero-note', text: t('monitoring.target.pausedHint')}),
            target.activeSessionId
              ? el('p', {className: 'hero-note', text: t('monitoring.target.recordingHint')})
              : null),
          actions));

      bodyHost.append(hero);

      if (target.error) {
        bodyHost.append(el('div', {className: 'callout callout--danger', style: {marginTop: '16px'}},
          el('div', {className: 'callout-title', text: t('monitoring.error.title')}),
          el('p', {text: ctx.describeError(target.error)}),
          target.nextCheckAt
            ? el('p', {className: 'callout-note', text: t('monitoring.error.nextRetry', {
              time: formatDateTime(target.nextCheckAt, ctx.locale)
            })})
            : null,
          el('div', {className: 'hero-actions', style: {marginTop: '12px'}},
            el('button', {
              className: 'button button--secondary button--small',
              type: 'button',
              text: t('monitoring.action.retry'),
              onClick: (event) => changeTarget(target, 'retry', event.currentTarget)
            }))));
      } else if (target.state === 'paused') {
        bodyHost.append(el('div', {className: 'callout callout--neutral', style: {marginTop: '16px'}},
          el('div', {className: 'callout-title', text: t('monitoring.paused.title')}),
          el('p', {text: t('monitoring.paused.body')})));
      } else if (target.state === 'live_stopped') {
        bodyHost.append(el('div', {className: 'callout callout--warn', style: {marginTop: '16px'}},
          el('div', {className: 'callout-title', text: t('monitoring.liveStopped.title')}),
          el('p', {text: t('monitoring.liveStopped.body')}),
          el('p', {className: 'callout-note', text: t('monitoring.liveStopped.hint')})));
      }

      const info = el('section', {className: 'card', style: {marginTop: '16px'}},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('monitoring.info.title')}),
          el('div', {className: 'card-hint', text: t('monitoring.info.hint')})),
        el('div', {className: 'card-body monitor-info'},
          monitorInfoRow(t('monitoring.info.state'), meta.text),
          interval ? monitorInfoRow(t('monitoring.info.interval'), interval) : null,
          target.lastCheckAt
            ? monitorInfoRow(t('monitoring.info.lastCheck'), formatDateTime(target.lastCheckAt, ctx.locale))
            : null,
          target.enabled && target.nextCheckAt
            ? monitorInfoRow(t('monitoring.info.nextCheck'), formatDateTime(target.nextCheckAt, ctx.locale))
            : null,
          target.lastLiveAt
            ? monitorInfoRow(t('monitoring.info.lastLive'), formatDateTime(target.lastLiveAt, ctx.locale))
            : null,
          monitorInfoRow(t('monitoring.info.target'), target.targetKey)));

      refs.targetSessionsHost = el('div', {className: 'monitor-sessions'});
      const sessionsCard = el('section', {className: 'card', style: {marginTop: '16px'}},
        el('div', {className: 'card-head'},
          el('div', {className: 'card-title', text: t('monitoring.sessions.title')}),
          el('div', {className: 'card-hint', text: t('monitoring.sessions.hint')})),
        refs.targetSessionsHost);

      bodyHost.append(info, sessionsCard);
      refs.targetSessionsHost.append(el('div', {className: 'card-body'}, loadingBlock()));
    }

    async function loadTargetSessions(target, token) {
      let payload = null;
      try {
        payload = await api.get(`/api/monitoring/${encodeURIComponent(target.id)}/sessions?limit=10`);
      } catch {
        payload = null;
      }
      if (destroyed || token !== viewToken || selectedTargetId !== target.id) return;
      const host = refs.targetSessionsHost;
      if (!host) return;
      clear(host);
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      if (sessions.length === 0) {
        host.append(el('div', {className: 'card-body'},
          emptyState({title: t('monitoring.sessions.empty'), body: t('monitoring.sessions.emptyBody'), glyph: '◎'})));
        return;
      }
      for (const session of sessions) {
        const duration = session.endedAt ? session.endedAt - session.startedAt : Date.now() - session.startedAt;
        host.append(el('button', {
          className: 'monitor-session',
          type: 'button',
          attrs: {
            'aria-label': t('monitoring.sessions.open', {title: session.roomTitle || t('monitoring.sessions.untitled')})
          },
          onClick: () => ctx.navigate(`/history/${encodeURIComponent(session.id)}`)
        },
        el('div', {className: 'monitor-session-main'},
          el('div', {className: 'row-title'},
            el('span', {className: 'row-title-text', text: session.roomTitle || t('monitoring.sessions.untitled')})),
          el('div', {className: 'monitor-session-meta', text: `${formatDateTime(session.startedAt, ctx.locale)} · ${formatDuration(duration, t)}`})),
        el('div', {className: 'monitor-session-stats'},
          el('span', {text: `${t('live.stats.messages')} ${formatInteger(session.messageCount, ctx.locale)}`}),
          el('span', {
            text: `${t('live.stats.viewers')} ${formatInteger(session.uniqueViewerCount, ctx.locale)}${
              Number(session.unidentifiedMessageCount ?? 0) > 0
                ? ` · ${t('live.identity.short', {n: formatInteger(session.unidentifiedMessageCount, ctx.locale)})}`
                : ''
            }`
          }),
          statusChip(session, t))));
      }
    }

    async function changeTarget(target, action, button) {
      if (button) button.disabled = true;
      try {
        await api.patch(`/api/monitoring/${encodeURIComponent(target.id)}`, {action});
        await refreshRecordings();
        const next = targets.find((item) => item.id === target.id) ?? null;
        if (next) await openTarget(next);
        else selectNew();
        ctx.toast(t(action === 'pause'
          ? 'monitoring.toast.paused'
          : action === 'resume'
            ? 'monitoring.toast.resumed'
            : action === 'resume_capture'
              ? 'monitoring.toast.resumeCaptureStarted'
              : 'monitoring.toast.retried'));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        if (button) button.disabled = false;
      }
    }

    async function checkTargetNow(target, button) {
      if (button) button.disabled = true;
      try {
        await api.post(`/api/monitoring/${encodeURIComponent(target.id)}/check`, {});
        await refreshRecordings();
        const next = targets.find((item) => item.id === target.id) ?? null;
        if (next) await openTarget(next);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        if (button) button.disabled = false;
      }
    }

    function openDeleteTargetDialog(target) {
      const name = monitorName(target, t);
      const modal = createModal({
        title: t('monitoring.delete.title'),
        subtitle: t('monitoring.delete.subtitle', {name}),
        t,
        tone: 'danger'
      });
      const errorHost = el('div', {className: 'callout callout--danger'});
      errorHost.hidden = true;
      modal.body.append(
        el('p', {text: t('monitoring.delete.body')}),
        el('p', {className: 'monitor-delete-note', text: t('monitoring.delete.keepHistory')}),
        errorHost
      );
      const cancel = el('button', {
        className: 'button button--secondary',
        type: 'button',
        text: t('common.cancel'),
        onClick: () => modal.close()
      });
      const remove = el('button', {
        className: 'button button--danger',
        type: 'button',
        text: t('monitoring.delete.confirm')
      });
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await api.delete(`/api/monitoring/${encodeURIComponent(target.id)}`, {confirm: true});
          modal.close();
          targets = targets.filter((item) => item.id !== target.id);
          if (selectedTargetId === target.id) {
            selectedTargetId = null;
            selectNew();
          } else {
            renderTabs();
          }
          ctx.toast(t('monitoring.toast.deleted'));
          await ctx.refreshStatus();
        } catch (error) {
          remove.disabled = false;
          errorHost.hidden = false;
          errorHost.textContent = ctx.describeError(error);
        }
      });
      modal.actions.append(cancel, remove);
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

    function autoMonitorToggle(platform, checked, onChange) {
      const input = el('input', {attrs: {type: 'checkbox'}});
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      return el('label', {className: 'monitor-toggle'},
        input,
        el('span', {className: 'monitor-toggle-text'},
          el('span', {className: 'monitor-toggle-title', text: t('monitoring.add.toggle')}),
          el('span', {className: 'monitor-toggle-hint', text: t('monitoring.add.toggleHint', {platform: platformLabel(platform, t)})})));
    }

    function buildAutoMonitorSection(platform) {
      const input = el('input', {
        className: 'input',
        attrs: {
          type: 'text',
          spellcheck: 'false',
          placeholder: t(`monitoring.add.${platform}Placeholder`),
          'aria-label': t(`monitoring.add.${platform}Label`)
        }
      });
      input.value = autoInputs[platform] ?? '';
      input.addEventListener('input', () => {
        autoInputs[platform] = input.value;
      });
      refs.autoInput = input;
      return el('div', {className: 'monitor-add'},
        el('div', {className: 'source-row'},
          el('label', {className: 'field', style: {flex: '1 1 320px'}},
            el('span', {className: 'label', text: t(`monitoring.add.${platform}Label`)}),
            input),
          el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('monitoring.add.action'),
            onClick: (event) => addMonitoredTarget(platform, event.currentTarget)
          })),
        el('p', {className: 'source-note', text: t('monitoring.add.note')}),
        el('p', {className: 'source-note', text: t('monitoring.add.rateNote')}));
    }

    async function addMonitoredTarget(platform, button) {
      const value = String(refs.autoInput?.value ?? '').trim();
      if (!value) {
        ctx.toast(t('monitoring.error.invalidInput'), {tone: 'error'});
        return;
      }
      button.disabled = true;
      const original = button.textContent;
      button.textContent = t('monitoring.add.adding');
      try {
        const payload = await api.post('/api/monitoring', {platform, input: value});
        autoInputs[platform] = '';
        await refreshRecordings();
        const target = targets.find((item) => item.id === payload.target?.id) ?? payload.target;
        await openTarget(target);
        ctx.toast(t('monitoring.toast.added', {name: monitorName(target, t)}));
        await ctx.refreshStatus();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
        button.textContent = original;
      }
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

      panel.append(autoMonitorToggle('bilibili', biliAutoMonitor, (checked) => {
        biliAutoMonitor = checked;
        checkedRoom = null;
        renderSource();
      }));
      if (biliAutoMonitor) {
        panel.append(buildAutoMonitorSection('bilibili'));
        panel.append(el('p', {className: 'source-note', text: t('live.source.anonymousNote')}));
        panel.append(el('p', {className: 'source-note', text: t('live.source.identityNote')}));
        return panel;
      }

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
        const canStart = checkedRoom.liveStatus === 1;
        meta.append(el('div', {className: 'hero-actions', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--primary',
            type: 'button',
            text: canStart ? t('live.source.start') : t('live.source.waitForLive'),
            attrs: canStart ? {} : {disabled: ''},
            onClick: (event) => {
              if (!canStart) return;
              connectRoom(event.currentTarget);
            }
          })));
        if (!canStart) {
          meta.append(el('p', {className: 'source-note', text: t('live.source.onlyLiveCanStart')}));
        }
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

      panel.append(autoMonitorToggle('youtube', youtubeAutoMonitor, (checked) => {
        youtubeAutoMonitor = checked;
        checkedVideo = null;
        renderSource();
      }));
      if (youtubeAutoMonitor) {
        panel.append(buildAutoMonitorSection('youtube'));
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeIdentityNote')}));
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeMoneyNote')}));
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
          statCard({
            label: t('live.stats.viewers'),
            value: formatInteger(row.uniqueViewerCount, ctx.locale),
            sub: Number(row.unidentifiedMessageCount ?? 0) > 0
              ? t('live.identity.short', {n: formatInteger(row.unidentifiedMessageCount, ctx.locale)})
              : null
          }),
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

    const offMonitoring = ctx.on('monitoring', () => {
      if (!destroyed) scheduleRecordingsRefresh();
    });

    /* ------------------------------------------------------------- initial */

    const [recordingsPayload, sessionsPayload, monitoringPayload] = await Promise.all([
      api.get('/api/live/recordings').catch(() => ({recordings: []})),
      api.get('/api/sessions?limit=10').catch(() => ({sessions: []})),
      api.get('/api/monitoring').catch(() => null)
    ]);
    recordings = Array.isArray(recordingsPayload?.recordings) ? recordingsPayload.recordings : [];
    targets = Array.isArray(monitoringPayload?.targets) ? monitoringPayload.targets : [];
    monitoringPolicy = monitoringPayload?.policy ?? null;
    lastSessionRow = (sessionsPayload?.sessions ?? []).find((row) => row.status !== 'live') ?? null;
    await loadSourceStatuses();

    renderTabs();
    const liveTarget = targets.find((target) => target.activeSessionId) ?? null;
    if (liveTarget) {
      await openTarget(liveTarget);
    } else if (targets.length > 0) {
      await openTarget(targets[0]);
    } else if (recordings.length > 0) {
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
      offMonitoring();
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
