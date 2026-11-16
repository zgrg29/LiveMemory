import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localeDisplayName} from '../../src/web/js/i18n.js';
import {AVAILABLE_LOCALES, localeDescriptors} from '../../src/shared/locales.mjs';
import {
  languageControlMode,
  languageOptions,
  renderLanguageControl
} from '../../src/web/js/language-control.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const LOCALES = AVAILABLE_LOCALES;

async function dictionary(locale) {
  return JSON.parse(await readFile(join(root, 'src/web/i18n', `${locale}.json`), 'utf8'));
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.value = '';
    this._text = '';
    this.onclick = null;
    this.onchange = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, handler) {
    if (type === 'click') this.onclick = handler;
    if (type === 'change') this.onchange = handler;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text || this.children.map((node) => node.textContent).join('');
  }
}

function fakeDocument() {
  const doc = {createElement: (tag) => new FakeElement(tag, doc)};
  return doc;
}

function render(locales, preference = 'system') {
  const doc = fakeDocument();
  const rootNode = doc.createElement('div');
  const segmented = doc.createElement('div');
  const systemButton = doc.createElement('button');
  const select = doc.createElement('select');
  const changes = [];
  const mode = renderLanguageControl({
    root: rootNode,
    segmented,
    systemButton,
    select,
    locales,
    preference,
    systemLabel: '系统语言',
    systemAriaLabel: '跟随系统语言',
    ariaLabel: '界面语言',
    onChange: (value) => changes.push(value)
  });
  return {doc, rootNode, segmented, systemButton, select, mode, changes};
}

test('language names are always rendered in their own language', () => {
  assert.equal(localeDisplayName('zh-CN'), '简体中文');
  assert.equal(localeDisplayName('ja'), '日本語');
  assert.equal(localeDisplayName('en'), 'English');
  // P40: the seven new languages are real, so their native names come from the
  // same registry and are never translated by the current interface language.
  assert.equal(localeDisplayName('ko'), '한국어');
  assert.equal(localeDisplayName('es'), 'Español');
  assert.equal(localeDisplayName('pt-BR'), 'Português (Brasil)');
  assert.equal(localeDisplayName('zh-TW'), '繁體中文');
  assert.equal(localeDisplayName('fr'), 'Français');
  assert.equal(localeDisplayName('de'), 'Deutsch');
  assert.equal(localeDisplayName('id'), 'Bahasa Indonesia');
  // Unknown values fall back to the English native name rather than to a
  // translated string from the current interface language.
  assert.equal(localeDisplayName('th-TH'), 'English');
});

test('the header contains both language controls next to the theme control', async () => {
  const html = await readFile(join(root, 'src/web/index.html'), 'utf8');
  assert.match(html, /id="language-segmented"/);
  assert.match(html, /id="language-select"/);
  assert.match(html, /id="language-system"/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /data-i18n="a11y\.languageSelect"/);
  // The header must not hardcode one translated option list; labels are built
  // from the bootstrap locale registry in language-control.js.
  assert.doesNotMatch(html, /<option[^>]*>简体中文/);
  const app = await readFile(join(root, 'src/web/js/app.js'), 'utf8');
  assert.match(app, /renderLanguageControl\(/);
  assert.doesNotMatch(app, /LANGUAGE_CHOICES/);
  assert.doesNotMatch(app, /localeDisplayName/);
});

test('language and data-management interface keys exist in all ten languages', async () => {
  for (const locale of LOCALES) {
    const dict = await dictionary(locale);
    assert.ok(dict.a11y.languageSelect);
    assert.ok(dict.a11y.languageSystem);
    assert.ok(dict.settings.language.headerHint);
    assert.ok(dict.settings.locationDialog?.title);
    assert.ok(dict.settings.danger?.clearTitle);
    assert.ok(dict.errors.relocationVerifyFailed);
    assert.ok(dict.errors.confirmTextMismatch);
    // The three legacy native-name keys keep their exact text in every
    // dictionary. The seven new languages are named by the registry only, so the
    // language-name key set is unchanged by P41 as well.
    assert.equal(dict.settings.language.zh, '简体中文');
    assert.equal(dict.settings.language.ja, '日本語');
    assert.equal(dict.settings.language.en, 'English');
    assert.equal(dict.settings.language.ko, undefined);
    assert.equal(dict.settings.language.de, undefined);
  }
});

test('a three-item registry still uses the segmented interaction', () => {
  const three = [
    {code: 'zh-CN', nativeName: '简体中文'},
    {code: 'ja', nativeName: '日本語'},
    {code: 'en', nativeName: 'English'}
  ];
  assert.equal(languageControlMode(three), 'segmented');
  const rendered = render(three, 'ja');
  assert.equal(rendered.mode, 'segmented');
  assert.equal(rendered.rootNode.dataset.mode, 'segmented');
  assert.equal(rendered.segmented.children.length, 3);
  assert.equal(rendered.select.children.length, 4);
  assert.deepEqual(
    rendered.segmented.children.map((node) => node.textContent),
    ['简体中文', '日本語', 'English']
  );
  assert.equal(rendered.segmented.children[1].getAttribute('aria-pressed'), 'true');
  assert.equal(rendered.select.value, 'ja');
  assert.deepEqual(
    rendered.select.children.map((node) => node.value),
    ['system', 'zh-CN', 'ja', 'en']
  );
  // The system button keeps its accessible label and pressed state.
  assert.equal(rendered.systemButton.getAttribute('aria-label'), '跟随系统语言');
  assert.equal(rendered.systemButton.getAttribute('aria-pressed'), 'false');
});

test('the shipped ten languages use the compact menu at every width', () => {
  const locales = localeDescriptors(AVAILABLE_LOCALES);
  assert.equal(locales.length, 10);
  assert.equal(languageControlMode(locales), 'menu');
  const rendered = render(locales, 'pt-BR');
  assert.equal(rendered.mode, 'menu');
  assert.equal(rendered.rootNode.dataset.mode, 'menu');
  assert.equal(rendered.select.children.length, 11);
  assert.equal(rendered.select.value, 'pt-BR');
  assert.deepEqual(
    rendered.select.children.map((node) => node.textContent),
    ['系统语言', ...locales.map((entry) => entry.nativeName)]
  );
  assert.deepEqual(
    rendered.select.children.slice(1).map((node) => node.value),
    ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id']
  );
  // Every option carries its own lang so a screen reader uses native names.
  for (const node of rendered.select.children.slice(1)) assert.ok(node.lang);
});

test('three long native names also use the compact menu', () => {
  const long = [
    {code: 'pt-BR', nativeName: 'Português (Brasil)'},
    {code: 'id', nativeName: 'Bahasa Indonesia'},
    {code: 'zh-TW', nativeName: '繁體中文'}
  ];
  assert.equal(languageControlMode(long), 'menu');
});

test('the control does not invent an option for an unavailable preference', () => {
  const locales = localeDescriptors(AVAILABLE_LOCALES);
  const rendered = render(locales, 'th-TH');
  // The stored preference is preserved server-side; the visible control shows
  // the system option rather than silently claiming another language.
  assert.equal(rendered.select.value, 'system');
  assert.equal(rendered.select.dataset.preference, 'unavailable');
  assert.ok(!languageOptions(locales, {systemLabel: 'System'}).some((entry) => entry.value === 'th-TH'));
});

test('choosing a language calls the single change callback', () => {
  const locales = localeDescriptors(AVAILABLE_LOCALES);
  const rendered = render(locales);
  rendered.select.value = 'en';
  rendered.select.onchange();
  rendered.systemButton.onclick();
  assert.deepEqual(rendered.changes, ['en', 'system']);
});

test('the header language control no longer has fixed three-language widths', async () => {
  const css = await readFile(join(root, 'src/web/styles/components.css'), 'utf8');
  assert.doesNotMatch(css, /\.language-select[^}]*max-width:\s*132px/s);
  assert.doesNotMatch(css, /\.language-select[^}]*max-width:\s*112px/s);
  assert.match(css, /\.language-control\[data-mode="menu"\] \.language-segmented/);
  assert.match(css, /\.language-control\[data-mode="menu"\] \.language-compact/);
});
