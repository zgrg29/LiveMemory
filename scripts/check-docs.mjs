#!/usr/bin/env node
/**
 * Documentation consistency check for LiveMemory.
 *
 * This is a maintenance script, not part of the application runtime. It checks:
 * 1. README language order and required section headings.
 * 2. Relative Markdown links in README, AGENTS.md and docs/*.md resolve to
 *    real files (anchors and external URLs are ignored).
 * 3. Version consistency: package.json = APP_VERSION = CHANGELOG = STATUS.
 * 4. The ten i18n dictionaries have identical leaf key sets and placeholders.
 *
 * Usage:
 *   node scripts/check-docs.mjs
 */

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function walk(dir, predicate, out = []) {
  for (const name of readdirSync(join(root, dir), {withFileTypes: true})) {
    const rel = join(dir, name.name);
    if (name.isDirectory()) {
      if (['node_modules', '.git', 'tests', 'dist', 'build', 'research', '.ref'].includes(name.name)) continue;
      walk(rel, predicate, out);
    } else if (predicate(rel)) {
      out.push(rel);
    }
  }
  return out;
}

// 1. README language order and required headings.
const readme = read('README.md');
const english = readme.indexOf('\n## English');
const chinese = readme.indexOf('\n## 简体中文');
const japanese = readme.indexOf('\n## 日本語');
if (!(english >= 0 && chinese > english && japanese > chinese)) {
  fail('README.md: expected language order English → 简体中文 → 日本語');
} else {
  notes.push('README language order: English → 简体中文 → 日本語');
}

const requiredHeadings = {
  English: ['What is LiveMemory?', 'Core features', 'Platform support', 'Download and install', 'Quick start', 'AI analysis', 'Data and privacy', 'FAQ', 'Development', 'Documentation', 'License'],
  简体中文: ['LiveMemory 是什么', '核心功能', '平台支持', '下载与安装', '快速开始', 'AI 分析说明', '数据与隐私', '常见问题', '开发运行', '文档', '许可证'],
  日本語: ['LiveMemory とは', '主な機能', '対応プラットフォーム', 'ダウンロードとインストール', 'クイックスタート', 'AI 分析について', 'データとプライバシー', 'よくある質問', '開発', 'ドキュメント', 'ライセンス']
};

const sections = [
  ['English', english, chinese],
  ['简体中文', chinese, japanese],
  ['日本語', japanese, readme.length]
];
for (const [name, start, end] of sections) {
  const body = readme.slice(start, end);
  for (const heading of requiredHeadings[name]) {
    if (!body.includes(heading)) fail(`README.md ${name}: missing section “${heading}”`);
  }
}

// 2. Relative Markdown links.
const markdownFiles = [
  'README.md',
  'AGENTS.md',
  ...walk('docs', (rel) => rel.endsWith('.md')),
  ...walk('log', (rel) => rel.endsWith('.md')),
  ...walk('research', (rel) => rel.endsWith('.md'))
];
const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let linkCount = 0;
for (const file of markdownFiles) {
  const text = read(file);
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('#') || /^(https?:|mailto:|tel:)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0].split('?')[0]);
    if (!target) continue;
    linkCount++;
    const absolute = resolve(root, dirname(file), target);
    if (!existsSync(absolute)) {
      fail(`${file}: broken relative link → ${raw}`);
    }
  }
}
notes.push(`Checked ${linkCount} relative Markdown links in ${markdownFiles.length} files`);

// 3. Version consistency.
const pkg = JSON.parse(read('package.json'));
const appInfo = read('src/shared/app-info.mjs');
const appVersion = appInfo.match(/export const APP_VERSION = '([^']+)'/)?.[1];
const status = read('docs/STATUS.md');
const changelog = read('docs/CHANGELOG.md');
if (!appVersion) fail('src/shared/app-info.mjs: APP_VERSION not found');
if (pkg.version !== appVersion) fail(`version mismatch: package.json ${pkg.version} != APP_VERSION ${appVersion}`);
if (!changelog.includes(`## ${pkg.version} `)) fail(`CHANGELOG missing section for ${pkg.version}`);
if (!status.includes(pkg.version)) fail(`STATUS does not mention current version ${pkg.version}`);
if (pkg.version === appVersion) notes.push(`Version consistency: ${pkg.version}`);

// 4. i18n key sets and placeholders.
const i18nDir = 'src/web/i18n';
const dictionaries = readdirSync(join(root, i18nDir)).filter((name) => name.endsWith('.json')).sort();
if (dictionaries.length === 0) fail('no i18n dictionaries found');

function flatten(value, prefix = '', out = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, String(value));
  }
  return out;
}

function placeholders(text) {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
}

const base = flatten(JSON.parse(readFileSync(join(root, i18nDir, 'en.json'), 'utf8')));
for (const name of dictionaries) {
  const current = flatten(JSON.parse(readFileSync(join(root, i18nDir, name), 'utf8')));
  if (current.size !== base.size) fail(`${name}: ${current.size} keys, expected ${base.size}`);
  for (const key of base.keys()) {
    if (!current.has(key)) fail(`${name}: missing key ${key}`);
  }
  for (const [key, value] of current) {
    if (!base.has(key)) fail(`${name}: extra key ${key}`);
    const expected = placeholders(base.get(key) ?? '');
    const actual = placeholders(value);
    if (expected !== actual) fail(`${name}: placeholder mismatch at ${key} (${actual || 'none'} != ${expected || 'none'})`);
    if (value.trim() === '') fail(`${name}: empty value at ${key}`);
  }
}
notes.push(`i18n: ${dictionaries.length} dictionaries × ${base.size} keys, keysets and placeholders aligned`);

// Report.
console.log('Documentation checks');
for (const note of notes) console.log(`  PASS  ${note}`);
if (failures.length === 0) {
  console.log('\nAll documentation checks passed.');
  process.exit(0);
}
console.error('\nFAILURES:');
for (const message of failures) console.error(`  FAIL  ${message}`);
process.exit(1);
