import {api} from '../api.js';
import {localeDisplayName} from '../i18n.js';
import {el, formatBytes, formatInteger, pageHead} from '../ui.js';

/**
 * Settings: language, appearance, storage mode, data facts and about.
 * Each control writes through the local API, so the choice is persisted in
 * config/settings.json and reused by the launcher on the next start.
 */
export const settingsPage = {
  titleKey: 'settings.pageTitle',

  async render(container, ctx) {
    const t = ctx.t;
    container.append(pageHead({title: t('settings.pageTitle'), subtitle: t('settings.pageSubtitle')}));

    const storageInfo = await api.get('/api/storage');
    const grid = el('div', {className: 'settings-grid'});
    container.append(grid);

    /* ------------------------------------------------------------ language */

    const languageOptions = [
      ['system', t('settings.language.system')],
      ['zh-CN', t('settings.language.zh')],
      ['ja', t('settings.language.ja')],
      ['en', t('settings.language.en')]
    ];
    const languageButtons = languageOptions.map(([value, label]) => el('button', {
      type: 'button',
      text: label,
      attrs: {'aria-pressed': String(ctx.state.settings.locale === value), 'data-value': value},
      onClick: async () => {
        if (ctx.state.settings.locale === value) return;
        try {
          await ctx.setLocale(value);
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
      }
    }));
    const languageCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.language.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-block'},
          el('div', {className: 'setting-desc', text: t('settings.language.desc')}),
          el('div', {className: 'segmented', attrs: {role: 'group', 'aria-label': t('settings.language.title')}}, languageButtons),
          el('div', {className: 'effective-note', text: t('settings.language.systemHint', {
            locale: localeDisplayName(ctx.state.systemLocale ?? ctx.locale)
          })}),
          el('div', {className: 'effective-note', text: t('settings.language.effective', {
            locale: localeDisplayName(ctx.state.locale)
          })}),
          el('div', {className: 'small tertiary', text: t('settings.language.note')}))));

    /* --------------------------------------------------------------- theme */

    const themeOptions = [
      ['system', t('settings.theme.system'), t('settings.theme.hint')],
      ['light', t('settings.theme.light'), null],
      ['dark', t('settings.theme.dark'), null]
    ];
    const themeButtons = themeOptions.map(([value, label]) => el('button', {
      className: 'theme-option',
      type: 'button',
      attrs: {'aria-pressed': String(ctx.state.settings.theme === value)},
      onClick: async () => {
        if (ctx.state.settings.theme === value) return;
        try {
          await ctx.setTheme(value);
          for (const button of themeButtons) {
            const pressed = button.dataset.theme === value;
            button.setAttribute('aria-pressed', String(pressed));
          }
        } catch (error) {
          ctx.toast(ctx.describeError(error), {tone: 'error'});
        }
      }
    },
      el('span', {className: `theme-preview theme-preview--${value}`}),
      el('span', {className: 'theme-option-label'},
        label,
        el('span', {className: 'theme-option-check', attrs: {'aria-hidden': 'true'}}))));
    themeButtons.forEach((button, index) => {
      button.dataset.theme = themeOptions[index][0];
    });

    const themeCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.theme.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.theme.desc')}),
        el('div', {className: 'theme-options', style: {marginTop: '12px'}}, themeButtons)));

    /* ------------------------------------------------------------- storage */

    const storageChoices = [
      ['compact', t('settings.storage.compact'), t('settings.storage.compactDesc')],
      ['full', t('settings.storage.full'), t('settings.storage.fullDesc')]
    ];
    const storageCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.storage.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.storage.desc')}),
        el('div', {className: 'choice-list', style: {marginTop: '12px'}},
          storageChoices.map(([value, title, desc]) => {
            const input = el('input', {
              type: 'radio',
              name: 'storage-mode',
              value,
              attrs: {checked: ctx.state.settings.storageMode === value}
            });
            input.addEventListener('change', async () => {
              if (!input.checked) return;
              try {
                const payload = await api.patch('/api/settings', {storageMode: value});
                ctx.state.settings = payload.settings;
                ctx.toast(t('settings.saved'));
              } catch (error) {
                ctx.toast(ctx.describeError(error), {tone: 'error'});
              }
            });
            return el('label', {className: 'choice'},
              input,
              el('div', {className: 'choice-text'},
                el('div', {className: 'choice-title', text: title}),
                el('div', {className: 'choice-desc', text: desc})));
          })),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '14px'}}, t('settings.storage.note'))));

    /* ------------------------------------------------------------- YouTube */

    const youtubeChoices = [
      ['official', t('settings.youtube.official'), t('settings.youtube.officialDesc')],
      ['anonymous', t('settings.youtube.anonymous'), t('settings.youtube.anonymousDesc')]
    ];
    const youtubeCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.youtube.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.youtube.desc')}),
        el('div', {className: 'choice-list', style: {marginTop: '12px'}},
          youtubeChoices.map(([value, title, desc]) => {
            const input = el('input', {
              type: 'radio',
              name: 'youtube-capture-mode',
              value,
              attrs: {checked: ctx.state.settings.youtubeCaptureMode === value}
            });
            input.addEventListener('change', async () => {
              if (!input.checked) return;
              try {
                const payload = await api.patch('/api/settings', {youtubeCaptureMode: value});
                ctx.state.settings = payload.settings;
                ctx.toast(t('settings.saved'));
              } catch (error) {
                ctx.toast(ctx.describeError(error), {tone: 'error'});
              }
            });
            return el('label', {className: 'choice'},
              input,
              el('div', {className: 'choice-text'},
                el('div', {className: 'choice-title', text: title}),
                el('div', {className: 'choice-desc', text: desc})));
          })),
        el('div', {className: 'callout callout--warn', style: {marginTop: '14px'}}, t('settings.youtube.warning')),
        el('div', {className: 'small tertiary', style: {marginTop: '8px'}}, t('settings.youtube.note'))));

    /* ---------------------------------------------------------------- data */

    const dataCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.data.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'setting-desc', text: t('settings.data.desc')}),
        el('div', {className: 'def-list', style: {marginTop: '12px'}},
          defRow(t('settings.data.dataDir'), el('span', {className: 'mono', text: storageInfo.dataDir})),
          defRow(t('settings.data.dbSize'), formatBytes(storageInfo.databaseBytes, ctx.locale)),
          defRow(t('settings.data.sessions'), formatInteger(storageInfo.counts.sessions, ctx.locale)),
          defRow(t('settings.data.viewers'), formatInteger(storageInfo.counts.viewers, ctx.locale)),
          defRow(t('settings.data.events'), formatInteger(storageInfo.counts.events, ctx.locale))),
        el('div', {className: 'callout callout--neutral', style: {marginTop: '14px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('settings.data.backupTitle')}),
            el('div', {text: t('settings.data.backupBody')})))));

    /* --------------------------------------------------------------- about */

    const about = ctx.state.bootstrap?.app ?? {};
    const aboutCard = el('section', {className: 'card card--wide'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('settings.about.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'def-list'},
          defRow(t('settings.about.version'), `v${about.version ?? ctx.state.version}`),
          defRow(t('settings.about.license'), 'MIT'),
          defRow(t('settings.about.repo'), el('a', {
            href: about.homepage ?? 'https://github.com/zgrg29/LiveMemory',
            attrs: {target: '_blank', rel: 'noopener noreferrer'},
            text: 'github.com/zgrg29/LiveMemory'
          })),
          defRow(t('settings.about.runtime'), `http://127.0.0.1:${ctx.state.status?.server?.port ?? '—'}`),
          defRow(t('settings.about.schema'), String(ctx.state.status?.database?.schemaVersion ?? '—')),
          defRow(t('settings.about.language'), localeDisplayName(ctx.state.locale)),
          defRow(t('settings.about.theme'), `${t(`settings.theme.${ctx.state.settings.theme}`)} · ${document.documentElement.getAttribute('data-theme')}`))));

    grid.append(languageCard, themeCard, storageCard, youtubeCard, dataCard, aboutCard);
    return undefined;
  }
};

function defRow(key, value) {
  return el('div', {className: 'def-row'},
    el('span', {className: 'def-key', text: key}),
    el('span', {className: 'def-value'}, value instanceof Node ? value : document.createTextNode(String(value))));
}
