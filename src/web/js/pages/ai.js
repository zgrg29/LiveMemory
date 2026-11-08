import {api} from '../api.js';
import {
  chip,
  clear,
  el,
  emptyState,
  formatBytes,
  formatDateTime,
  formatInteger,
  pageHead
} from '../ui.js';
import {platformLabel} from './shared.js';

/**
 * AI analysis centre: a three step manual round trip.
 *
 * Step 1 (export) is implemented. Step 3 (import + schema validation) is
 * milestone M6 and is shown as planned instead of pretending to work.
 */
export const aiPage = {
  titleKey: 'ai.pageTitle',

  async render(container, ctx, params, query) {
    const t = ctx.t;
    const sessionsPayload = await api.get('/api/sessions?limit=100');
    const sessions = sessionsPayload.sessions ?? [];
    const requested = query?.get('session');
    let selectedId = requested && sessions.some((session) => session.id === requested)
      ? requested
      : (sessions[0]?.id ?? null);
    let locale = ctx.locale;
    let lastPackage = null;
    let packages = [];

    container.append(pageHead({title: t('ai.pageTitle'), subtitle: t('ai.pageSubtitle')}));

    const steps = el('div', {className: 'steps'},
      stepCard('1', t('ai.steps.exportTitle'), t('ai.steps.exportDesc'), 'active'),
      stepCard('2', t('ai.steps.promptTitle'), t('ai.steps.promptDesc'), 'next'),
      stepCard('3', t('ai.steps.importTitle'), t('ai.steps.importDesc'), 'next'));
    container.append(steps);

    if (sessions.length === 0) {
      container.append(el('div', {className: 'card card--padded'},
        emptyState({
          title: t('ai.export.empty'),
          glyph: '◇',
          action: el('button', {
            className: 'button button--primary',
            type: 'button',
            text: t('nav.live'),
            onClick: () => ctx.navigate('/live')
          })
        })));
      return undefined;
    }

    /* ------------------------------------------------------------ step one */

    const sessionSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.export.sessionLabel')}},
      sessions.map((session) => el('option', {
        value: session.id,
        text: `${session.roomTitle || platformLabel(session.platform, t)} · ${formatDateTime(session.startedAt, ctx.locale)}`
      })));
    sessionSelect.value = selectedId;

    const languageSelect = el('select', {className: 'select', attrs: {'aria-label': t('ai.export.languageLabel')}},
      el('option', {value: 'zh-CN', text: t('settings.language.zh')}),
      el('option', {value: 'ja', text: t('settings.language.ja')}),
      el('option', {value: 'en', text: t('settings.language.en')}));
    languageSelect.value = locale;

    const exportButton = el('button', {className: 'button button--primary', type: 'button', text: t('ai.export.button')});
    const exportResult = el('div', {className: 'stack stack--tight'});

    const exportCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'}, el('div', {className: 'card-title', text: t('ai.export.title')})),
      el('div', {className: 'card-body'},
        el('div', {className: 'field'}, el('label', {className: 'label', text: t('ai.export.sessionLabel')}), sessionSelect),
        el('div', {className: 'field', style: {marginTop: '14px'}}, el('label', {className: 'label', text: t('ai.export.languageLabel')}), languageSelect),
        el('div', {style: {marginTop: '16px'}}, exportButton),
        el('div', {className: 'small tertiary', style: {marginTop: '10px'}}, t('ai.export.hint')),
        exportResult));

    /* ------------------------------------------------------------ step two */

    const promptBox = el('div', {className: 'prompt-box', attrs: {tabindex: '0'}}, t('ai.prompt.loading'));
    const copyButton = el('button', {
      className: 'button button--secondary button--small',
      type: 'button',
      text: t('ai.prompt.copy'),
      disabled: true
    });
    const promptCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.prompt.title')}),
        copyButton),
      el('div', {className: 'card-body'},
        promptBox,
        el('div', {className: 'small tertiary', style: {marginTop: '8px'}}, t('ai.prompt.hint'))));

    /* ---------------------------------------------------------- step three */

    const importCard = el('section', {className: 'card', style: {marginTop: '16px'}},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.import.title')}),
        chip(t('ai.import.badge'), 'neutral')),
      el('div', {className: 'card-body'},
        el('div', {className: 'callout callout--neutral'}, t('ai.import.body'))));

    /* ------------------------------------------------------------ packages */

    const packagesHost = el('div', {className: 'card-body'});
    const packagesCard = el('section', {className: 'card'},
      el('div', {className: 'card-head'},
        el('div', {className: 'card-title', text: t('ai.packages.title')}),
        el('div', {className: 'card-hint', text: 'livememory-analysis-v1'})),
      packagesHost);

    container.append(
      el('div', {className: 'grid-2-equal'}, exportCard, promptCard),
      importCard,
      el('div', {style: {marginTop: '16px'}}, packagesCard)
    );

    /* -------------------------------------------------------------- logic */

    async function loadInstructions() {
      try {
        const payload = await api.get(`/api/ai/instructions?locale=${encodeURIComponent(locale)}`);
        promptBox.textContent = payload.text;
        copyButton.disabled = false;
      } catch (error) {
        promptBox.textContent = ctx.describeError(error);
      }
    }

    async function loadPackages() {
      try {
        const payload = await api.get(`/api/ai/packages?sessionId=${encodeURIComponent(selectedId ?? '')}`);
        packages = payload.packages ?? [];
      } catch {
        packages = [];
      }
      renderPackages();
    }

    function renderPackages() {
      clear(packagesHost);
      if (packages.length === 0) {
        packagesHost.append(emptyState({title: t('ai.packages.empty'), glyph: '·'}));
        return;
      }
      for (const item of packages) {
        packagesHost.append(el('div', {className: 'package-row'},
          el('span', {className: 'package-name', text: item.fileName}),
          el('span', {className: 'small tertiary', text: t('ai.packages.meta', {
            messages: formatInteger(item.messageCount, ctx.locale),
            date: formatDateTime(item.createdAt, ctx.locale)
          })}),
          el('button', {
            className: 'button button--secondary button--small',
            type: 'button',
            text: t('ai.packages.download'),
            onClick: () => {
              api.download(`/api/ai/packages/${encodeURIComponent(item.id)}/download`);
              ctx.toast(t('toast.downloadStarted'));
            }
          })));
      }
    }

    function renderExportResult() {
      clear(exportResult);
      if (!lastPackage) return;
      exportResult.append(
        el('div', {className: 'callout', style: {marginTop: '14px'}},
          el('div', {},
            el('div', {className: 'callout-title', text: t('ai.export.successTitle')}),
            el('div', {text: t('ai.export.successBody', {
              messages: formatInteger(lastPackage.messageCount, ctx.locale),
              viewers: formatInteger(lastPackage.viewerCount, ctx.locale),
              size: formatBytes(lastPackage.bytes, ctx.locale)
            })}))),
        el('div', {className: 'inline', style: {marginTop: '10px'}},
          el('button', {
            className: 'button button--primary button--small',
            type: 'button',
            text: t('ai.export.download'),
            onClick: () => {
              api.download(`/api/ai/packages/${encodeURIComponent(lastPackage.id)}/download`);
              ctx.toast(t('toast.downloadStarted'));
            }
          })));
    }

    exportButton.addEventListener('click', async () => {
      if (!selectedId) {
        ctx.toast(t('ai.export.needSession'), {tone: 'info'});
        return;
      }
      exportButton.disabled = true;
      const original = exportButton.textContent;
      exportButton.textContent = t('ai.export.exporting');
      try {
        const payload = await api.post('/api/ai/packages', {sessionId: selectedId, locale});
        lastPackage = payload.package;
        renderExportResult();
        ctx.toast(t('toast.exported'));
        await loadPackages();
      } catch (error) {
        ctx.toast(ctx.describeError(error), {tone: 'error'});
      } finally {
        exportButton.disabled = false;
        exportButton.textContent = original;
      }
    });

    sessionSelect.addEventListener('change', () => {
      selectedId = sessionSelect.value;
      lastPackage = null;
      renderExportResult();
      loadPackages();
    });

    languageSelect.addEventListener('change', () => {
      locale = languageSelect.value;
      loadInstructions();
    });

    copyButton.addEventListener('click', async () => {
      const text = promptBox.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        ctx.toast(t('toast.copied'));
      } catch {
        const helper = el('textarea', {style: {position: 'fixed', opacity: '0'}});
        helper.value = text;
        document.body.append(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
        ctx.toast(t('toast.copied'));
      }
    });

    function stepCard(index, title, desc, state) {
      return el('div', {className: 'step-card', dataset: {state}},
        el('span', {className: 'step-index', text: index}),
        el('div', {className: 'step-title', text: title}),
        el('div', {className: 'step-desc', text: desc}));
    }

    await Promise.all([loadInstructions(), loadPackages()]);
    return undefined;
  }
};
