import {el, pageHead} from '../ui.js';

/**
 * Usage guide.
 *
 * A read-only reference page: it never calls the API, never changes settings and
 * never asks for confirmation. All copy lives in the i18n dictionaries, so the
 * guide follows the interface language and the existing visual language.
 *
 * Layout: an intro card, then a two-column grid with a sticky table of contents
 * on the left and the numbered sections on the right. Under 1000 px the table of
 * contents becomes a wrapped row of chips above the sections.
 */

const SECTIONS = [
  {id: 'start', steps: 6, notes: ['note']},
  {id: 'connect', steps: 6, notes: ['noteBilibili', 'noteYoutube']},
  {id: 'records', steps: 6, notes: ['note']},
  {id: 'providers', steps: 6, notes: ['note']},
  {id: 'analysis', steps: 6, notes: ['note']},
  {id: 'memory', steps: 4, terms: ['fact', 'stated', 'inferred', 'uncertain', 'status', 'evidence'], notes: ['note']},
  {id: 'progress', steps: 6, notes: ['note']},
  {id: 'backup', steps: 6, notes: ['note']},
  {id: 'faq', faq: 8, notes: ['note']}
];

function stepList(t, section) {
  const items = [];
  for (let index = 1; index <= section.steps; index += 1) {
    items.push(el('li', {className: 'help-step'},
      el('span', {className: 'help-step-index', text: String(index), attrs: {'aria-hidden': 'true'}}),
      el('span', {className: 'help-step-text', text: t(`help.sections.${section.id}.step${index}`)})));
  }
  return el('ol', {className: 'help-steps'}, items);
}

function termList(t, section) {
  const rows = [];
  for (const name of section.terms) {
    rows.push(el('dt', {className: 'help-term-label', text: t(`help.sections.${section.id}.term.${name}.label`)}));
    rows.push(el('dd', {className: 'help-term-desc', text: t(`help.sections.${section.id}.term.${name}.desc`)}));
  }
  return el('dl', {className: 'help-terms'}, rows);
}

function questionList(t, section) {
  const items = [];
  for (let index = 1; index <= section.faq; index += 1) {
    items.push(el('details', {className: 'help-faq-item'},
      el('summary', {className: 'help-faq-question', text: t(`help.sections.${section.id}.q${index}`)}),
      el('p', {className: 'help-faq-answer', text: t(`help.sections.${section.id}.a${index}`)})));
  }
  return el('div', {className: 'help-faq'}, items);
}

function noteBlock(t, section) {
  return (section.notes ?? []).map((note) => el('div', {
    className: 'callout callout--neutral help-note',
    text: t(`help.sections.${section.id}.${note}`)
  }));
}

function jumpToCard(card) {
  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'start'});
  card.focus({preventScroll: true});
}

function actionButton(t, key, navigate, path) {
  return el('button', {
    className: 'button button--secondary',
    type: 'button',
    text: t(`help.action.${key}`),
    onClick: () => navigate(path)
  });
}

export const helpPage = {
  titleKey: 'help.pageTitle',

  render(container, ctx) {
    const t = ctx.t;
    container.append(pageHead({title: t('help.pageTitle'), subtitle: t('help.pageSubtitle')}));

    container.append(el('section', {className: 'card card--padded help-intro'},
      el('h2', {className: 'help-intro-title', text: t('help.introTitle')}),
      el('p', {className: 'help-lede', text: t('help.introBody')}),
      el('div', {className: 'callout callout--neutral help-note', text: t('help.introLocal')}),
      el('div', {className: 'help-actions'},
        actionButton(t, 'live', ctx.navigate, '/live'),
        actionButton(t, 'settings', ctx.navigate, '/settings'),
        actionButton(t, 'ai', ctx.navigate, '/ai'))));

    const tocList = el('div', {className: 'help-toc-list'});
    const sections = el('div', {className: 'help-sections'});
    container.append(el('div', {className: 'help-layout'},
      el('nav', {className: 'help-toc', attrs: {'aria-label': t('help.tocTitle')}},
        el('div', {className: 'help-toc-title', text: t('help.tocTitle')}),
        tocList),
      sections));

    SECTIONS.forEach((section, offset) => {
      const titleId = `help-${section.id}-title`;
      const title = t(`help.sections.${section.id}.title`);
      const card = el('section', {
        className: 'card help-section',
        id: `help-${section.id}`,
        attrs: {tabindex: '-1', 'aria-labelledby': titleId}
      },
        el('div', {className: 'card-head help-section-head'},
          el('span', {className: 'help-section-index', text: String(offset + 1), attrs: {'aria-hidden': 'true'}}),
          el('h2', {className: 'card-title', id: titleId, text: title})),
        el('div', {className: 'card-body help-section-body'},
          el('p', {className: 'help-lede', text: t(`help.sections.${section.id}.lead`)}),
          section.steps ? stepList(t, section) : null,
          section.terms ? termList(t, section) : null,
          section.faq ? questionList(t, section) : null,
          ...noteBlock(t, section)));

      sections.append(card);
      tocList.append(el('button', {
        className: 'help-toc-item',
        type: 'button',
        onClick: () => jumpToCard(card)
      },
        el('span', {className: 'help-toc-index', text: String(offset + 1), attrs: {'aria-hidden': 'true'}}),
        el('span', {className: 'help-toc-label', text: title})));
    });

    return () => {};
  }
};
