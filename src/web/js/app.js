import {api} from './api.js';
import {establishSession} from './auth.js';
import {loadDictionary, createTranslator, localeDisplayName} from './i18n.js';
import {applyTheme} from './theme.js';
import {
  clear,
  createToaster,
  describeError,
  el,
  formatDateTime,
  emptyState
} from './ui.js';
import {livePage} from './pages/live.js';
import {historyPage} from './pages/history.js';
import {viewersPage} from './pages/viewers.js';
import {aiPage} from './pages/ai.js';
import {settingsPage} from './pages/settings.js';

/**
 * Application shell: bootstrap, routing, language/theme switching and the live
 * event stream. Pages are plain modules that render into #view and return an
 * optional cleanup function.
 */

const state = {
  bootstrap: null,
  settings: null,
  effective: null,
  systemLocale: 'en',
  dict: null,
  locale: 'en',
  status: null,
  version: '0.1.0',
  pageCleanup: null,
  localePending: false
};

const LANGUAGE_CHOICES = Object.freeze(['zh-CN', 'ja', 'en']);

let t = createTranslator({});
let authErrorShown = false;

const bus = new EventTarget();
function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, {detail}));
}
function on(name, handler) {
  const wrapped = (event) => handler(event.detail);
  bus.addEventListener(name, wrapped);
  return () => bus.removeEventListener(name, wrapped);
}

const view = document.getElementById('view');
const pageTitleEl = document.getElementById('page-title');
const connectionPill = document.getElementById('connection-pill');
const connectionText = document.getElementById('connection-text');
const toaster = createToaster(document.getElementById('toasts'));

const ctx = {
  api,
  el,
  get state() {
    return state;
  },
  t: (key, params) => t(key, params),
  get locale() {
    return state.locale;
  },
  emit,
  on,
  toast: (message, options) => toaster(message, options),
  navigate,
  refreshStatus,
  setLocale,
  setTheme,
  describeError: (error) => describeError(error, t)
};

const ROUTES = [
  {pattern: /^\/?$/, page: livePage, nav: 'live'},
  {pattern: /^\/live$/, page: livePage, nav: 'live'},
  {pattern: /^\/history$/, page: historyPage, nav: 'history'},
  {pattern: /^\/history\/([^/]+)$/, page: historyPage, nav: 'history', params: ['id']},
  {pattern: /^\/viewers$/, page: viewersPage, nav: 'viewers'},
  {pattern: /^\/viewers\/([^/]+)$/, page: viewersPage, nav: 'viewers', params: ['id']},
  // The standalone memory workspace was removed in v0.11.0. Long-term memory is
  // updated by the normal AI analysis import; old bookmarks land on AI analysis.
  {pattern: /^\/memory$/, page: aiPage, nav: 'ai'},
  {pattern: /^\/ai$/, page: aiPage, nav: 'ai'},
  {pattern: /^\/settings$/, page: settingsPage, nav: 'settings'}
];

function parseLocation() {
  const raw = window.location.hash.replace(/^#/, '') || '/live';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/live';
  const query = new URLSearchParams(queryPart ?? '');
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params = {};
    (route.params ?? []).forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    return {route, params, query, path};
  }
  return {route: null, params: {}, query, path};
}

function navigate(path) {
  const next = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === next) {
    renderRoute();
    return;
  }
  window.location.hash = next;
}

function setActiveNav(navKey) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === navKey) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderRoute() {
  if (state.pageCleanup) {
    try {
      state.pageCleanup();
    } catch {
      /* page cleanup must not block navigation */
    }
    state.pageCleanup = null;
  }
  const {route, params, query} = parseLocation();
  clear(view);
  if (!route) {
    setActiveNav(null);
    pageTitleEl.textContent = 'LiveMemory';
    view.append(emptyState({
      title: t('errors.notFound'),
      body: t('errors.generic'),
      glyph: '?',
      action: el('button', {className: 'button button--primary', type: 'button', text: t('common.back'), onClick: () => navigate('/live')})
    }));
    return;
  }
  setActiveNav(route.nav);
  pageTitleEl.textContent = t(route.page.titleKey);
  document.title = `LiveMemory · ${t(route.page.titleKey)}`;
  try {
    const result = await route.page.render(view, ctx, params, query);
    state.pageCleanup = typeof result === 'function' ? result : (result?.destroy ?? null);
  } catch (error) {
    console.error('[LiveMemory] page render failed', error);
    try {
      window.__lmLastError = String(error?.stack ?? error);
    } catch {
      /* ignore */
    }
    clear(view);
    view.append(emptyState({
      title: t('common.error'),
      body: describeError(error, t),
      glyph: '!',
      action: el('button', {
        className: 'button button--primary',
        type: 'button',
        text: t('common.retry'),
        onClick: () => renderRoute()
      })
    }));
  }
}

function updateConnectionPill() {
  const platform = state.status?.platform;
  const active = platform?.activeSession ?? null;
  const count = Number(platform?.activeCount ?? (active ? 1 : 0));
  const connected = platform?.connection === 'connected' || Boolean(active);
  connectionPill.dataset.state = connected ? 'connected' : 'idle';
  connectionText.textContent = count > 1
    ? t('status.recordingCount', {n: count})
    : (connected ? t('status.connected') : t('status.idle'));
}

async function refreshStatus() {
  const status = await api.get('/api/status');
  state.status = status;
  updateConnectionPill();
  emit('status', status);
  return status;
}

function connectEvents() {
  let source;
  try {
    source = new EventSource('/api/events/stream');
  } catch {
    return;
  }
  source.addEventListener('event', (event) => {
    try {
      const payload = JSON.parse(event.data);
      emit('event', payload);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener('status', (event) => {
    try {
      const platform = JSON.parse(event.data);
      state.status = {...(state.status ?? {}), platform};
      updateConnectionPill();
      emit('status', state.status);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener('error', () => {
    connectionPill.dataset.state = 'idle';
    connectionText.textContent = t('status.connecting');
  });
  window.addEventListener('beforeunload', () => source.close());
}

function applyStaticTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    const value = t(key);
    if (value && value !== key) node.textContent = value;
  }
  const menuButton = document.getElementById('menu-button');
  if (menuButton) menuButton.setAttribute('aria-label', t('a11y.openNavigation'));
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) themeToggle.setAttribute('aria-label', t('a11y.themeToggle'));
}

function renderShellMeta() {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${state.version}`;
  const navLinks = document.querySelectorAll('[data-nav]');
  for (const link of navLinks) {
    const key = `nav.${link.dataset.nav}`;
    const value = t(key);
    if (value && value !== key) {
      const iconNode = link.querySelector('.nav-icon');
      link.textContent = '';
      if (iconNode) link.append(iconNode);
      link.append(document.createTextNode(value));
    }
  }
  updateConnectionPill();
}

/**
 * Header language control.
 *
 * The three language names are always rendered in their own language so the
 * control stays usable when the current interface language is not readable.
 * Wide layouts expose all three choices plus a globe button for "follow the
 * system language"; narrow layouts collapse to one native <select>. Both
 * controls read and write the same persisted preference.
 */
function languageChoiceLabel(value) {
  return value === 'system' ? t('settings.language.system') : localeDisplayName(value);
}

function syncLanguageControls() {
  const preference = state.settings?.locale ?? 'system';
  const segmented = document.getElementById('language-segmented');
  if (segmented) {
    segmented.setAttribute('aria-label', t('a11y.languageSelect'));
    segmented.replaceChildren(...LANGUAGE_CHOICES.map((value) => el('button', {
      type: 'button',
      text: localeDisplayName(value),
      attrs: {
        'aria-pressed': String(preference === value),
        'data-locale': value,
        lang: value,
        title: localeDisplayName(value)
      },
      onClick: () => chooseLocale(value)
    })));
  }

  const systemButton = document.getElementById('language-system');
  if (systemButton) {
    systemButton.setAttribute('aria-pressed', String(preference === 'system'));
    systemButton.setAttribute('aria-label', t('a11y.languageSystem'));
    systemButton.title = t('a11y.languageSystem');
    systemButton.onclick = () => chooseLocale('system');
  }

  const select = document.getElementById('language-select');
  if (select) {
    const choices = ['system', ...LANGUAGE_CHOICES];
    select.replaceChildren(...choices.map((value) => el('option', {
      value,
      text: languageChoiceLabel(value),
      attrs: value === 'system' ? null : {lang: value}
    })));
    select.value = preference;
    select.setAttribute('aria-label', t('a11y.languageSelect'));
    select.onchange = () => chooseLocale(select.value);
  }

  const control = document.querySelector('.language-control');
  if (control) control.setAttribute('aria-label', t('a11y.languageSelect'));
  for (const node of document.querySelectorAll('#language-segmented button, #language-system, #language-select')) {
    node.disabled = false;
  }
}

/** Serialize header/settings language changes so a rapid double click cannot race. */
async function chooseLocale(value) {
  if (state.localePending) return;
  if ((state.settings?.locale ?? 'system') === value) return;
  state.localePending = true;
  for (const node of document.querySelectorAll('#language-segmented button, #language-system, #language-select')) {
    node.disabled = true;
  }
  try {
    await setLocale(value);
  } catch (error) {
    toaster(describeError(error, t), {tone: 'error'});
  } finally {
    state.localePending = false;
    syncLanguageControls();
  }
}

async function applyLocale(locale) {
  state.locale = locale;
  state.dict = await loadDictionary(locale);
  t = createTranslator(state.dict);
  document.documentElement.lang = locale;
  applyStaticTranslations();
  renderShellMeta();
  syncLanguageControls();
}

async function setLocale(preference) {
  const payload = await api.patch('/api/settings', {locale: preference});
  state.settings = payload.settings;
  state.effective = payload.effective;
  await applyLocale(payload.effective.locale);
  syncLanguageControls();
  toaster(t('toast.language'));
  emit('localechange', {locale: state.locale, preference});
  await renderRoute();
  syncLanguageControls();
}

async function setTheme(preference) {
  const payload = await api.patch('/api/settings', {theme: preference});
  state.settings = payload.settings;
  state.effective = payload.effective;
  applyTheme(preference);
  emit('themechange', {preference});
  toaster(t('toast.theme'));
}

function wireShell() {
  const menuButton = document.getElementById('menu-button');
  const scrim = document.getElementById('sidebar-scrim');
  const closeNav = () => {
    document.body.dataset.navOpen = 'false';
    menuButton?.setAttribute('aria-expanded', 'false');
    if (scrim) scrim.hidden = true;
  };
  menuButton?.addEventListener('click', () => {
    const open = document.body.dataset.navOpen !== 'true';
    document.body.dataset.navOpen = open ? 'true' : 'false';
    menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (scrim) scrim.hidden = !open;
  });
  scrim?.addEventListener('click', closeNav);
  document.getElementById('nav')?.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeNav();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNav();
  });
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.addEventListener('focus', () => {});
  });
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const resolved = document.documentElement.getAttribute('data-theme');
    setTheme(resolved === 'dark' ? 'light' : 'dark').catch((error) => toaster(describeError(error, t), {tone: 'error'}));
  });
  window.addEventListener('hashchange', () => {
    renderRoute();
  });
}

/** Best-effort locale for the unauthenticated error page (no server data). */
function initialLocale() {
  const language = String(navigator.language ?? navigator.languages?.[0] ?? 'en').toLowerCase();
  if (language.startsWith('zh')) return 'zh-CN';
  if (language.startsWith('ja')) return 'ja';
  return 'en';
}

/**
 * Render a localized "open from LiveMemory" page. This runs before any API
 * data is available, so it uses the browser language and only static strings.
 */
async function renderAuthError(auth) {
  if (authErrorShown) return;
  authErrorShown = true;
  const locale = initialLocale();
  state.locale = locale;
  state.dict = await loadDictionary(locale).catch(() => ({}));
  t = createTranslator(state.dict);
  document.documentElement.lang = locale;
  const message = auth?.code === 'NETWORK'
    ? t('errors.network')
    : (auth?.code === 'AUTH_INVALID' ? t('auth.invalid') : t('auth.body'));
  pageTitleEl.textContent = t('auth.title');
  connectionPill.dataset.state = 'idle';
  connectionText.textContent = t('status.idle');
  clear(view);
  view.append(el('div', {className: 'card card--padded'},
    el('h1', {className: 'page-title', text: t('auth.title')}),
    el('p', {className: 'page-subtitle', text: message}),
    el('div', {className: 'inline', style: {marginTop: '16px'}},
      el('button', {
        className: 'button button--primary',
        type: 'button',
        text: t('auth.reload'),
        onClick: () => window.location.reload()
      }))));
}

async function boot() {
  window.addEventListener('lm:auth-required', () => {
    renderAuthError({code: 'AUTH_REQUIRED'});
  });
  const auth = await establishSession();
  if (!auth.ok) {
    await renderAuthError(auth);
    return;
  }
  try {
    const bootstrap = await api.get('/api/bootstrap');
    state.bootstrap = bootstrap;
    state.settings = bootstrap.settings;
    state.status = bootstrap.status;
    state.systemLocale = bootstrap.effective.systemLocale;
    state.version = bootstrap.app.version;
    applyTheme(bootstrap.settings.theme);
    await applyLocale(bootstrap.effective.locale);
    wireShell();
    connectEvents();
    await renderRoute();
    window.setInterval(() => {
      refreshStatus().catch(() => {});
    }, 15000);
  } catch (error) {
    state.dict = await loadDictionary('en').catch(() => ({}));
    t = createTranslator(state.dict);
    document.documentElement.lang = 'en';
    clear(view);
    view.append(el('div', {className: 'card card--padded'},
      el('h1', {className: 'page-title', text: 'LiveMemory', style: {fontSize: '26px'}}),
      el('p', {className: 'page-subtitle', text: describeError(error, t)}),
      el('div', {className: 'inline', style: {marginTop: '16px'}},
        el('button', {
          className: 'button button--primary',
          type: 'button',
          text: 'Retry',
          onClick: () => window.location.reload()
        }))));
  }
}

boot();
