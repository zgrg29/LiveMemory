import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {helpPage} from '../../src/web/js/pages/help.js';

/**
 * The usage guide is a static page, so these tests render it against a tiny
 * read-only DOM shim. That proves the real dictionaries resolve for all three
 * languages and that the entry point is wired, without adding a browser engine
 * or a new runtime dependency.
 */

const ROOT = process.cwd();
const LOCALES = ['zh-CN', 'ja', 'en'];
const SECTION_IDS = [
  'start', 'connect', 'records', 'providers', 'analysis', 'memory', 'progress', 'backup', 'faq'
];

/* ------------------------------------------------------------- DOM shim */

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.className = '';
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this._text = null;
  }

  append(...children) {
    for (const child of children) this.childNodes.push(child);
  }

  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.childNodes = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  focus(options) {
    this.focusedWith = options ?? null;
  }

  scrollIntoView(options) {
    this.scrolledWith = options ?? null;
  }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map((child) => child?.textContent ?? '').join('');
  }

  set textContent(value) {
    this._text = String(value);
  }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text');
    node._text = String(text);
    return node;
  }
};

/* ---------------------------------------------------------------- helpers */

function dictionary(locale) {
  return JSON.parse(readFileSync(join(ROOT, `src/web/i18n/${locale}.json`), 'utf8'));
}

function readKey(dictionaryObject, key) {
  return key.split('.').reduce((value, part) => value?.[part], dictionaryObject);
}

function createTranslator(dictionaryObject) {
  return (key, params = {}) => {
    const template = readKey(dictionaryObject, key);
    if (typeof template !== 'string') return key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.hasOwn(params, name) ? String(params[name]) : match
    ));
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes) walk(child, visit);
}

function nodesWhere(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function byClass(root, className) {
  return nodesWhere(root, (node) => String(node.className).split(/\s+/).includes(className));
}

function render(locale) {
  const dictionaryObject = dictionary(locale);
  const navigations = [];
  const container = new FakeNode('main');
  const ctx = {
    t: createTranslator(dictionaryObject),
    navigate: (path) => navigations.push(path),
    state: {locale, settings: {locale: 'system', theme: 'system'}},
    locale
  };
  const cleanup = helpPage.render(container, ctx);
  return {container, dictionary: dictionaryObject, navigations, cleanup};
}

/* ------------------------------------------------------------------ tests */

test('the guide entry is wired into the console navigation and router', () => {
  const html = readFileSync(join(ROOT, 'src/web/index.html'), 'utf8');
  const app = readFileSync(join(ROOT, 'src/web/js/app.js'), 'utf8');
  const baseCss = readFileSync(join(ROOT, 'src/web/styles/base.css'), 'utf8');
  assert.match(html, /href="#\/help" data-nav="help"/);
  assert.match(app, /import \{helpPage\} from '\.\/pages\/help\.js'/);
  assert.match(app, /\{pattern: \/\^\\\/help\$\//);
  assert.match(app, /page: helpPage, nav: 'help'/);
  assert.match(baseCss, /\.nav-item\[data-nav="help"\] \.nav-icon/);
  for (const locale of LOCALES) {
    const value = readKey(dictionary(locale), 'nav.help');
    assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale} nav.help`);
  }
});

test('all nine required topics render in order with headings and anchors', () => {
  const {container} = render('en');
  assert.equal(helpPage.titleKey, 'help.pageTitle');
  const sections = byClass(container, 'help-section');
  assert.deepEqual(sections.map((section) => section.getAttribute('id')), SECTION_IDS.map((id) => `help-${id}`));
  for (const section of sections) {
    const titleId = section.getAttribute('aria-labelledby');
    assert.ok(titleId, 'section must reference its heading');
    const headings = nodesWhere(section, (node) => node.getAttribute('id') === titleId);
    assert.equal(headings.length, 1);
    assert.equal(headings[0].tagName, 'h2');
    assert.ok(headings[0].textContent.trim().length > 0);
    assert.equal(section.getAttribute('tabindex'), '-1');
  }
  const nav = byClass(container, 'help-toc')[0];
  assert.ok(nav, 'table of contents must exist');
  assert.equal(byClass(nav, 'help-toc-item').length, SECTION_IDS.length);
});

test('every section resolves copy in all three languages and never leaks a key', () => {
  for (const locale of LOCALES) {
    const {container} = render(locale);
    const text = container.textContent;
    assert.doesNotMatch(text, /help\.sections\./, `${locale} has an unresolved key`);
    assert.doesNotMatch(text, /\{step|\{note|\{title/, `${locale} has an unreplaced placeholder`);
    const d = dictionary(locale);
    for (const id of SECTION_IDS) {
      assert.ok(text.includes(d.help.sections[id].title), `${locale} is missing ${id} title`);
      assert.ok(text.includes(d.help.sections[id].lead), `${locale} is missing ${id} lead`);
      for (let index = 1; index <= 6; index += 1) {
        const step = readKey(d, `help.sections.${id}.step${index}`);
        if (typeof step === 'string') assert.ok(text.includes(step), `${locale} is missing ${id} step${index}`);
      }
    }
    assert.ok(text.includes(d.help.introBody), `${locale} is missing the intro`);
    assert.ok(text.includes(d.help.introLocal), `${locale} is missing the local-only note`);
  }
});

test('the copy covers connection, records, providers, analysis, memory and recovery', () => {
  const zh = dictionary('zh-CN').help.sections;
  assert.match(zh.connect.step2, /live\.bilibili\.com/);
  assert.match(zh.connect.step3, /youtube\.com/);
  assert.match(zh.records.step2, /直播历史/);
  assert.match(zh.providers.step3, /API Key/);
  assert.match(zh.analysis.step5, /开始 AI 分析/);
  assert.match(zh.memory.term.stated.label, /明确/);
  assert.match(zh.progress.step3, /继续/);
  assert.match(zh.backup.step3, /RESTORE/);
  assert.equal(zh.faq.q8.trim().length > 0, true);

  const en = dictionary('en').help.sections;
  assert.match(en.connect.step3, /No Google login/);
  assert.match(en.memory.note, /not that the meaning is correct/);
  assert.match(en.progress.step4, /Clicking Continue again is safe/);
  assert.match(en.backup.step2, /does not contain API keys/);
});

test('the guide states that no usage limits and no forced review are added', () => {
  const zh = dictionary('zh-CN').help;
  assert.match(zh.sections.analysis.note, /不限制观众数量、消息数量、直播时长、分析次数、Token、费用或批次数量/);
  assert.match(zh.sections.analysis.note, /不会要求你审核 AI 画像/);
  assert.match(zh.sections.faq.note, /不会新增使用限制/);
  const en = dictionary('en').help;
  assert.match(en.sections.analysis.note, /no limits on viewer count, message count, stream length/);
  assert.match(en.sections.analysis.note, /never asks you to approve AI profiles/);
});

test('the table of contents scrolls to its section and action buttons navigate', () => {
  const {container, navigations} = render('en');
  const items = byClass(container, 'help-toc-item');
  const sections = byClass(container, 'help-section');
  items[3].listeners.get('click')[0]();
  assert.equal(sections[3].scrolledWith?.block, 'start');
  assert.deepEqual(sections[3].focusedWith, {preventScroll: true});

  const actions = byClass(container, 'help-actions')[0];
  for (const button of nodesWhere(actions, (node) => node.tagName === 'button')) {
    button.listeners.get('click')[0]();
  }
  assert.deepEqual(navigations, ['/live', '/settings', '/ai']);
});

test('the FAQ renders eight collapsible question and answer pairs', () => {
  const {container, dictionary: d} = render('ja');
  const faq = byClass(container, 'help-faq')[0];
  const items = nodesWhere(faq, (node) => node.tagName === 'details');
  assert.equal(items.length, 8);
  items.forEach((item, index) => {
    const summary = nodesWhere(item, (node) => node.tagName === 'summary')[0];
    assert.equal(summary.textContent, d.help.sections.faq[`q${index + 1}`]);
    const answer = nodesWhere(item, (node) => node.className === 'help-faq-answer')[0];
    assert.equal(answer.textContent, d.help.sections.faq[`a${index + 1}`]);
  });
});

test('the guide is read-only: no API calls, no innerHTML, no confirmation dialogs', () => {
  const source = readFileSync(join(ROOT, 'src/web/js/pages/help.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(source, /\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
  assert.doesNotMatch(source, /ctx\.api|\/api\//);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  const {container} = render('zh-CN');
  assert.doesNotMatch(container.textContent, /<script|onclick=/i);
});

test('the guide layout adapts to narrow screens without horizontal overflow', () => {
  const css = readFileSync(join(ROOT, 'src/web/styles/pages.css'), 'utf8');
  assert.match(css, /\.help-layout \{[^}]*grid-template-columns: 236px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 1000px\) \{\s*\.help-layout \{\s*grid-template-columns: 1fr;/);
  assert.match(css, /\.help-toc \{[\s\S]*?position: sticky/);
  assert.match(css, /@media \(max-width: 700px\) \{\s*\.help-terms \{\s*grid-template-columns: 1fr;/);
  assert.match(css, /\.help-step-text \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.help-note \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.help-section \{\s*scroll-margin-top: calc\(var\(--topbar-height\)/);
});
