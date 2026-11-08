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
    let biliStatus = null;
    let sourceMode = 'mock';
    let checkedRoom = null;
    let loginTimer = null;
    let loginExpiresAt = 0;
    let loginHintText = '';
    let qrState = null;
    let qrCanvasRef = null;
    let qrWrapRef = null;
    let sourceHost = null;
    let loginHintHost = null;
    let youtubeStatus = null;
    let checkedVideo = null;
    let ytHintText = '';
    let ytHintHost = null;
    let ytPollTimer = null;
    let ytStatusTimer = null;
    let ytLinks = [];

    const [currentPayload, sessionsPayload] = await Promise.all([
      api.get('/api/sessions/current'),
      api.get('/api/sessions?limit=1')
    ]);
    summary = currentPayload.session ?? null;
    lastSessionRow = sessionsPayload.sessions?.[0] ?? null;
    try {
      biliStatus = await api.get('/api/bilibili/status');
    } catch {
      biliStatus = null;
    }
    try {
      youtubeStatus = await api.get('/api/youtube/status');
    } catch {
      youtubeStatus = null;
    }

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
      clearInterval(ytStatusTimer);
      ytStatusTimer = null;
      refs = {};
      loginHintHost = null;
      clear(container);
      sourceHost = el('div');
      container.append(
        el('section', {className: 'hero', dataset: {live: 'false'}},
          el('div', {className: 'hero-body'},
            el('div', {className: 'hero-text'},
              el('div', {className: 'hero-eyebrow'}, chip(t('live.hero.idleEyebrow'), 'neutral')),
              el('h1', {className: 'hero-title', text: t('live.hero.idleTitle')}),
              el('p', {className: 'hero-sub', text: t('live.hero.idleSubtitle')})),
            el('div', {className: 'hero-actions'}, startButton()))),
        sourceHost,
        buildLastSessionCard()
      );
      renderSource();
    }

    /* -------------------------------------------------------- live source */

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
          ytHintText = '';
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
      ytHintHost = null;
      ytLinks = [];
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
          'aria-label': t('live.source.roomLabel'),
          value: checkedRoom ? String(checkedRoom.inputRoomId ?? checkedRoom.roomId) : ''
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
        const startButtonNode = el('button', {
          className: 'button button--primary',
          type: 'button',
          text: t('live.source.start'),
          onClick: (event) => connectRoom(event.currentTarget)
        });
        meta.append(el('div', {className: 'hero-actions', style: {marginTop: '12px'}}, startButtonNode));
        panel.append(meta);
      }

      panel.append(el('p', {className: 'source-note', text: t('live.source.anonymousNote')}));
      panel.append(el('p', {className: 'source-note', text: t('live.source.identityNote')}));
      panel.append(el('p', {className: 'source-note', text: t('live.source.moneyNote')}));
      return panel;
    }

    /**
     * YouTube panel.
     *
     * The simple path is: paste a live link → check → record. The official Data
     * API is recommended and is the default. The anonymous web client is shown
     * only after an explicit, clearly labelled opt-in because it is
     * undocumented and may conflict with YouTube's terms. No API key or Google
     * account is requested for the anonymous path.
     */
    function buildYouTubePanel() {
      const panel = el('div', {className: 'source-panel'});
      panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeIntro')}));

      const status = youtubeStatus;
      if (!status) {
        panel.append(el('div', {className: 'source-status'}, chip(t('live.source.youtubeModeNone'), 'neutral')));
        panel.append(el('p', {className: 'source-note', text: t('errors.youtubeWebProtocol')}));
        return panel;
      }

      const mode = status.captureMode === 'anonymous' ? 'anonymous' : 'official';
      const officialConfigured = status.officialConfigured === true || status.configured === true;
      const signedIn = status.login?.signedIn === true;
      const expired = status.login?.state === 'expired';

      if (mode === 'anonymous') {
        panel.append(el('div', {className: 'source-status'},
          chip(t('live.source.youtubeExperimentalBadge'), 'neutral'),
          chip(t('live.source.youtubeAnonymousChecked'), 'accent')));
        panel.append(el('div', {className: 'callout callout--warn', style: {marginTop: '12px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('live.source.youtubeModeWarningTitle')}),
            el('div', {text: t('live.source.youtubeModeWarningBody')}))));
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeAnonymousStats')}));
        const switchButton = el('button', {
          className: 'button button--ghost button--small',
          type: 'button',
          text: t('live.source.youtubeBackToOfficial'),
          onClick: (event) => setYoutubeMode('official', event.currentTarget)
        });
        panel.append(el('div', {className: 'hero-actions', style: {marginTop: '8px'}}, switchButton));
      } else if (!officialConfigured) {
        panel.append(el('div', {className: 'source-status'}, chip(t('live.source.youtubeModeNone'), 'neutral')));
        panel.append(el('div', {className: 'source-status', text: t('live.source.youtubeOfficialUnconfiguredTitle')}));
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeOfficialUnconfiguredBody')}));
        panel.append(el('div', {className: 'hero-actions', style: {marginTop: '12px'}},
          el('button', {
            className: 'button button--secondary',
            type: 'button',
            text: t('live.source.youtubeUseAnonymous'),
            onClick: (event) => setYoutubeMode('anonymous', event.currentTarget)
          })));
      } else {
        const statusText = signedIn
          ? t('live.source.youtubeLoginSignedIn', {name: status.login?.channel?.title || 'Google'})
          : (status.authMode === 'api-key'
            ? t('live.source.youtubeModeAnonymous')
            : (status.oauthConfigured
              ? t('live.source.youtubeLoginSignedOut')
              : t('live.source.youtubeModeNone')));

        const actions = [];
        if (signedIn) {
          actions.push(el('button', {
            className: 'button button--ghost button--small',
            type: 'button',
            text: t('live.source.youtubeLogout'),
            onClick: (event) => logoutYouTube(event.currentTarget)
          }));
        } else if (status.oauthConfigured) {
          actions.push(el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: expired ? t('live.source.youtubeReLogin') : t('live.source.youtubeLoginButton'),
            onClick: (event) => startYouTubeLogin(event.currentTarget)
          }));
        }

        panel.append(el('div', {className: 'source-row'},
          el('div', {className: 'field', style: {flex: '1 1 240px'}},
            el('span', {className: 'label', text: t('live.source.youtubeLoginTitle')}),
            el('div', {className: 'source-status'},
              expired ? chip(t('live.source.youtubeLoginExpired'), 'neutral') : null,
              el('span', {text: statusText}))),
          actions.length ? el('div', {className: 'source-row-actions'}, ...actions) : null));

        if (status.oauthConfigured && status.authMode !== 'api-key') {
          panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeLoginHint')}));
        }
      }

      ytHintHost = el('div', {className: 'source-status', text: ytHintText});
      panel.append(ytHintHost);

      if (mode === 'anonymous' || officialConfigured) {
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
      }

      if (mode === 'anonymous') {
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeAnonymousIdentityNote')}));
        panel.append(el('p', {className: 'source-note', text: t('live.source.youtubeMoneyNote')}));
      } else if (status.quota) {
        const quota = status.quota;
        panel.append(el('p', {
          className: 'source-note',
          text: `${t('live.source.youtubeQuota')}: ${t('live.source.youtubeQuotaValue', {
            used: formatInteger(quota.used, ctx.locale),
            limit: formatInteger(quota.limit, ctx.locale)
          })}`
        }));
      }

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

      panel.append(buildYoutubeAdvanced(mode));
      return panel;
    }

    function buildYoutubeAdvanced(mode) {
      const select = el('select', {className: 'input', attrs: {'aria-label': t('live.source.youtubeCaptureModeTitle')}},
        el('option', {value: 'official', text: t('live.source.youtubeModeOfficial')}),
        el('option', {value: 'anonymous', text: t('live.source.youtubeModeAnonymous')}));
      select.value = mode;
      select.addEventListener('change', async () => {
        if (select.value === mode) return;
        await setYoutubeMode(select.value, select, {silent: false});
      });
      return el('details', {className: 'advanced-settings', style: {marginTop: '16px'}},
        el('summary', {text: t('live.source.youtubeAdvanced')}),
        el('div', {style: {marginTop: '10px'}},
          el('span', {className: 'label', text: t('live.source.youtubeCaptureModeTitle')}),
          select,
          el('p', {className: 'source-note', text: mode === 'anonymous'
            ? t('live.source.youtubeModeWarningBody')
            : t('live.source.youtubeModeOfficialHint')})));
    }

    async function setYoutubeMode(mode, button, {silent = false} = {}) {
      if (!['official', 'anonymous'].includes(mode)) return;
      if (button) button.disabled = true;
      try {
        await api.patch('/api/settings', {youtubeCaptureMode: mode});
        await refreshYoutubeStatus();
        checkedVideo = null;
        ytHintText = '';
        renderSource();
        if (!silent) ctx.toast(t('live.source.youtubeModeSwitched'));
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        if (button) button.disabled = false;
      }
    }

    function videoReasonText(reason) {
      const key = {
        YOUTUBE_NOT_LIVE_UPCOMING: 'errors.youtubeUpcoming',
        YOUTUBE_NOT_LIVE_ENDED: 'errors.youtubeEnded',
        YOUTUBE_NOT_LIVE_VIDEO: 'errors.youtubeNotLive',
        YOUTUBE_NOT_LIVE: 'errors.youtubeNotLive',
        YOUTUBE_CHAT_DISABLED: 'errors.youtubeChatDisabled',
        YOUTUBE_CHAT_NOT_FOUND: 'errors.youtubeChatUnavailable',
        YOUTUBE_AUTH_REQUIRED: 'errors.youtubeAuthRequired',
        YOUTUBE_QUOTA_EXCEEDED: 'errors.youtubeQuota',
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
      if (video.mode === 'anonymous') head.append(chip(t('live.source.youtubeExperimentalBadge'), 'neutral'));
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

    function setYtHint(text) {
      ytHintText = text;
      if (!ytHintHost) return;
      clear(ytHintHost);
      ytHintHost.textContent = text;
      // A blocked popup still lets the user continue: show the official link.
      for (const url of ytLinks) {
        ytHintHost.append(' ');
        ytHintHost.append(el('a', {
          text: url,
          attrs: {href: url, target: '_blank', rel: 'noopener noreferrer'}
        }));
      }
    }

    async function refreshYoutubeStatus() {
      try {
        youtubeStatus = await api.get('/api/youtube/status');
      } catch {
        /* keep the previous snapshot */
      }
      return youtubeStatus;
    }

    async function startYouTubeLogin(button) {
      button.disabled = true;
      // Open the tab synchronously so the browser does not treat it as a popup
      // blocked after an await.
      let popup = null;
      try {
        popup = window.open('about:blank', '_blank');
      } catch {
        popup = null;
      }
      try {
        const result = await api.post('/api/youtube/login/start', {locale: ctx.locale});
        if (popup && !popup.closed) {
          popup.location.href = result.authUrl;
          try {
            popup.opener = null;
          } catch {
            /* cross-origin, ignore */
          }
        } else {
          ytLinks = [result.authUrl];
        }
        setYtHint(t('live.source.youtubeLoginWaiting'));
        pollYouTubeLogin(result.expiresAt ?? Date.now() + 300000);
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
      }
    }

    function pollYouTubeLogin(expiresAt) {
      clearInterval(ytPollTimer);
      ytPollTimer = window.setInterval(async () => {
        if (destroyed) {
          clearInterval(ytPollTimer);
          return;
        }
        if (Date.now() > expiresAt) {
          clearInterval(ytPollTimer);
          setYtHint(t('live.source.youtubeLoginExpired'));
          return;
        }
        try {
          const login = await api.get('/api/youtube/login/status');
          if (login.signedIn) {
            clearInterval(ytPollTimer);
            await refreshYoutubeStatus();
            setYtHint(t('live.source.youtubeLoginSuccess'));
            renderSource();
            ctx.toast(t('live.source.youtubeLoginSuccess'));
          } else if (login.state === 'expired') {
            clearInterval(ytPollTimer);
            setYtHint(t('live.source.youtubeLoginExpired'));
          }
        } catch {
          /* transient: keep polling until the deadline */
        }
      }, 2000);
    }

    async function logoutYouTube(button) {
      button.disabled = true;
      try {
        await api.post('/api/youtube/login/logout', {});
        await refreshYoutubeStatus();
        checkedVideo = null;
        ytHintText = '';
        renderSource();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
        button.disabled = false;
      }
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
        const mode = youtubeStatus?.captureMode === 'anonymous' ? 'anonymous' : 'official';
        const result = await api.post('/api/youtube/video', {url, mode});
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
        const captureMode = youtubeStatus?.captureMode === 'anonymous' ? 'anonymous' : 'official';
        await api.post('/api/youtube/connect', {url: checkedVideo.input, mode: captureMode});
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

    /**
     * Draw the login QR locally, exactly like the reference project does:
     * generate the matrix in the page (vendored MIT qrcode-generator) and paint
     * it on a canvas. The login page is never opened in an external browser.
     */
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
        } catch (error) {
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
        await api.post('/api/bilibili/connect', {roomId: checkedRoom.roomId});
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
            el('p', {className: 'hero-sub', text: `${t('live.hero.startedAt')} ${formatDateTime(next.session.platformStartedAt ?? next.session.startedAt, ctx.locale)}`}),
            next.session.platform === 'youtube' ? el('div', {className: 'source-status', dataset: {role: 'yt-status'}}) : null,
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
      refs.ytStatusLine = hero.querySelector('[data-role="yt-status"]');

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
      startYoutubeStatusPolling(next.session.platform === 'youtube');
    }

    /**
     * YouTube-only live indicators: connection state, current concurrent
     * viewers and API quota. Polled slowly (10 s) so the console never becomes
     * a source of API load.
     */
    function startYoutubeStatusPolling(active) {
      clearInterval(ytStatusTimer);
      ytStatusTimer = null;
      if (!active) return;
      renderYoutubeConnection();
      ytStatusTimer = window.setInterval(async () => {
        if (destroyed) {
          clearInterval(ytStatusTimer);
          return;
        }
        await refreshYoutubeStatus();
        renderYoutubeConnection();
      }, 10000);
    }

    function renderYoutubeConnection() {
      const host = refs.ytStatusLine;
      if (!host) return;
      clear(host);
      const connection = youtubeStatus?.connection;
      if (!connection) return;
      const state = connection.state;
      const stateText = state === 'connected'
        ? t('live.source.youtubeConnectionConnected')
        : state === 'reconnecting'
          ? t('live.source.youtubeConnectionReconnecting')
          : state === 'failed' || state === 'stopped'
            ? t('live.source.youtubeConnectionError')
            : t('live.source.youtubeConnection');
      host.append(chip(stateText, state === 'connected' ? 'live' : 'neutral', {dot: state === 'connected'}));
      if (connection.mode === 'anonymous') {
        host.append(chip(t('live.source.youtubeConnectionAnonymous'), 'neutral'));
      }
      if (Number.isFinite(connection.viewers) && connection.viewers !== null) {
        host.append(chip(t('live.source.youtubeHotness', {n: formatInteger(connection.viewers, ctx.locale)}), 'neutral'));
      }
      const quota = youtubeStatus?.quota;
      if (quota && connection.mode !== 'anonymous') {
        host.append(el('span', {
          className: 'source-note',
          text: t('live.source.youtubeQuotaValue', {
            used: formatInteger(quota.used, ctx.locale),
            limit: formatInteger(quota.limit, ctx.locale)
          })
        }));
      }
      if (connection.mode === 'anonymous' && Number.isFinite(connection.detail?.messagesSeen)) {
        host.append(chip(t('live.stats.messages') + ' ' + formatInteger(connection.detail.messagesSeen, ctx.locale), 'neutral'));
      }
      if (connection.mode === 'anonymous' && Number(connection.detail?.gapSuspected) > 0) {
        host.append(chip(t('live.source.youtubePossibleGaps', {n: connection.detail.gapSuspected}), 'neutral'));
      }
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
        // A Super Sticker can have no comment at all: keep the payer, the sticker
        // name/alt text and the amount visible.
        const label = event.giftName ? `${t('live.feed.stickerLabel')} · ${event.giftName}` : t('live.feed.stickerLabel');
        line.append(el('span', {className: 'feed-text', text: label}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else if (event.type === 'guard' || event.type === 'membership') {
        line.append(el('span', {className: 'feed-text', text: event.giftName ?? t('live.feed.guardLabel')}));
        // A membership milestone can carry a comment; show it without turning
        // the membership into a chat message count.
        if (event.content) line.append(el('span', {className: 'feed-text', text: event.content}));
        if (event.isPaid && Number(event.amountMinor) > 0) {
          line.append(el('span', {className: 'feed-gift', text: formatMoney(event.amountMinor, event.currency, ctx.locale)}));
        }
      } else {
        // Raw chat text is rendered verbatim, including Unicode emoji and
        // bracketed platform-emote labels. If the platform sent an emote with
        // no text at all, fall back to its supplied name/id.
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
      const endpoint = summary?.session?.platform === 'bilibili'
        ? '/api/bilibili/disconnect'
        : summary?.session?.platform === 'youtube'
          ? '/api/youtube/disconnect'
          : '/api/simulate/stop';
      button.disabled = true;
      button.textContent = t('live.hero.stopping');
      try {
        await api.post(endpoint, {});
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
      clearInterval(loginTimer);
      clearInterval(ytPollTimer);
      clearInterval(ytStatusTimer);
      chart?.destroy();
      chart = null;
    };
  }
};
