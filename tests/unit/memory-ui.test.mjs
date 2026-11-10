import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  MEMORY_PROTOCOL,
  MEMORY_SCHEMA_VERSION,
  MEMORY_PROMPT_VERSION,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_CERTAINTIES
} from '../../src/memory/constants.mjs';
import {buildMemoryInstructions} from '../../src/memory/prompt.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(join(root, 'src/web/i18n', `${locale}.json`), 'utf8'));
}

function valueAt(object, key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

const LOCALES = ['zh-CN', 'ja', 'en'];
const PAGE_FILES = [
  'src/web/js/pages/memory.js',
  'src/web/js/pages/viewer-memory.js',
  'src/web/js/pages/viewers.js'
];

function literalKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) keys.add(match[1]);
  for (const match of source.matchAll(/titleKey:\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
  return [...keys];
}

test('every literal memory translation key exists in all three dictionaries', () => {
  for (const locale of LOCALES) {
    const dictionary_ = dictionary(locale);
    for (const file of PAGE_FILES) {
      const source = read(file);
      for (const key of literalKeys(source)) {
        // Only assert keys that the memory feature introduced or reads.
        if (!key.startsWith('memory.') && !key.startsWith('viewers.detail.tab')) continue;
        const value = valueAt(dictionary_, key);
        assert.equal(typeof value, 'string', `${locale} is missing ${key} (used in ${file})`);
        assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      }
    }
  }
});

test('memory status, certainty and kind labels exist in every language', () => {
  for (const locale of LOCALES) {
    const dictionary_ = dictionary(locale);
    for (const key of [
      ...MEMORY_KINDS.map((kind) => `memory.kind.${kind}`),
      ...MEMORY_CERTAINTIES.map((certainty) => `memory.certainty${certainty.charAt(0).toUpperCase()}${certainty.slice(1)}`),
      ...MEMORY_STATUSES.map((status) => `memory.status${status.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`)
    ]) {
      assert.equal(typeof valueAt(dictionary_, key), 'string', `${locale} is missing ${key}`);
    }
  }
});

test('the memory page and panels never inject HTML', () => {
  for (const file of PAGE_FILES) {
    const source = read(file);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(source), false, `${file} must not use innerHTML`);
  }
});

test('the memory page is registered in the shell with a navigation entry', () => {
  const app = read('src/web/js/app.js');
  assert.match(app, /memoryPage/);
  assert.match(app, /path: '\/memory'|pattern: \/\^\\\/memory\$\//);
  const html = read('src/web/index.html');
  assert.match(html, /data-nav="memory"/);
  assert.match(html, /href="#\/memory"/);
});

test('the memory page has an icon style in the navigation', () => {
  const css = read('src/web/styles/base.css');
  assert.match(css, /\.nav-item\[data-nav="memory"\] \.nav-icon/);
});

test('memory protocol constants and the exported schema agree', () => {
  assert.equal(MEMORY_PROTOCOL, 'livememory-memory-update-v1');
  assert.equal(MEMORY_SCHEMA_VERSION, '1.0.0');
  assert.equal(MEMORY_PROMPT_VERSION, 'lm-prompt-m7.1');
  const schema = JSON.parse(read('src/memory/schemas/memory-update-result-v1.schema.json'));
  assert.equal(schema.properties.protocol.const, MEMORY_PROTOCOL);
  assert.deepEqual(schema.properties.schema_version.enum, [MEMORY_SCHEMA_VERSION]);
  assert.deepEqual(
    schema.properties.viewer_operations.items.properties.operations.items.properties.op.enum,
    ['add', 'confirm', 'update', 'supersede', 'conflict', 'outdated', 'uncertain']
  );
});

test('the memory instructions are fully localized and explain the strict rules', () => {
  const options = {
    session: {id: 'ses_1', startedAt: Date.parse('2026-11-10T10:00:00.000Z'), endedAt: null},
    broadcaster: {id: 'bilibili:room:1'},
    batch: {index: 1, total: 2, batchId: 'mjob_1-b01', taskId: 'ses_1-memory-b01', viewerCount: 3},
    jobId: 'mjob_1'
  };
  const texts = Object.fromEntries(LOCALES.map((locale) => [locale, buildMemoryInstructions(locale, options)]));
  for (const locale of LOCALES) {
    const text = texts[locale];
    assert.ok(text.includes(MEMORY_PROTOCOL), `${locale} must state the protocol`);
    assert.ok(text.includes('memory_context.json'));
    assert.ok(text.includes('viewer_excerpts.jsonl'));
    assert.ok(text.includes('result.schema.json'));
    assert.ok(text.includes('mjob_1'));
    assert.ok(text.includes('target_fact_id'), `${locale} must explain target_fact_id`);
    assert.ok(text.includes('stated') && text.includes('inferred'), `${locale} must explain certainty`);
    assert.ok(text.length > 2000);
  }
  // Each language is genuinely different, not an English fallback.
  assert.notEqual(texts['zh-CN'], texts.en);
  assert.notEqual(texts.ja, texts.en);
  assert.match(texts['zh-CN'], /不要推断敏感属性/);
  assert.match(texts.ja, /センシティブ/);
  assert.match(texts.en, /Do not infer sensitive attributes/);
});

test('memory CSS provides tabs and fact layout, and stays inside design tokens', () => {
  const css = read('src/web/styles/components.css');
  for (const selector of ['.tabs', '.tab[aria-selected="true"]', '.memory-fact', '.memory-evidence', '.memory-version', '.memory-diff']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  const block = css.slice(css.indexOf('/* ------------------------------------------------------- tabs & memory (M7) */'));
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(block), false, 'memory CSS must use tokens, not hard-coded colours');
});
